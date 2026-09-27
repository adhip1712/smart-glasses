const API = "http://127.0.0.1:8000";

const camera = document.getElementById("camera");
const cameraPlaceholder =
    document.getElementById("cameraPlaceholder");

const startCamera =
    document.getElementById("startCamera");

const captureButton =
    document.getElementById("captureButton");

const cameraStatus =
    document.getElementById("cameraStatus");

const messageInput =
    document.getElementById("messageInput");

const sendButton =
    document.getElementById("sendButton");

const messages =
    document.getElementById("messages");

const statusText =
    document.getElementById("statusText");


let cameraStream = null;


// ================================
// BACKEND STATUS
// ================================

async function checkBackend() {

    try {

        const response =
            await fetch(`${API}/health`);

        const data =
            await response.json();

        if (data.backend === "online") {

            statusText.textContent =
                data.ai === "online"
                    ? "AI Online"
                    : "AI Not Configured";

        }

    } catch {

        statusText.textContent =
            "Backend Offline";

    }
}


// ================================
// CAMERA
// ================================

startCamera.addEventListener(
    "click",
    async () => {

        try {

            cameraStream =
                await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });

            camera.srcObject =
                cameraStream;

            camera.style.display =
                "block";

            cameraPlaceholder.style.display =
                "none";

            cameraStatus.textContent =
                "ON";

            startCamera.textContent =
                "Camera Running";

        } catch (error) {

            alert(
                "Could not access the camera.\n\n" +
                error.message
            );

        }

    }
);


// ================================
// CAPTURE IMAGE
// ================================

captureButton.addEventListener(
    "click",
    async () => {

        if (!cameraStream) {

            alert("Start the camera first.");

            return;
        }


        const canvas =
            document.createElement("canvas");

        canvas.width =
            camera.videoWidth;

        canvas.height =
            camera.videoHeight;

        const context =
            canvas.getContext("2d");

        context.drawImage(
            camera,
            0,
            0,
            canvas.width,
            canvas.height
        );


        canvas.toBlob(
            async (blob) => {

                addMessage(
                    "user",
                    "Analyze what you see."
                );

                addMessage(
                    "ai",
                    "Analyzing camera image..."
                );

                const formData =
                    new FormData();

                formData.append(
                    "image",
                    blob,
                    "camera.jpg"
                );


                try {

                    const response =
                        await fetch(
                            `${API}/analyze-image`,
                            {
                                method: "POST",
                                body: formData
                            }
                        );

                    const data =
                        await response.json();

                    removeLastMessage();


                    if (data.success) {

                        addMessage(
                            "ai",
                            data.response
                        );

                        speak(data.response);

                    } else {

                        addMessage(
                            "ai",
                            "Error: " + data.error
                        );

                    }

                } catch (error) {

                    removeLastMessage();

                    addMessage(
                        "ai",
                        "Could not connect to the AI backend."
                    );

                }

            },
            "image/jpeg",
            0.85
        );

    }
);


// ================================
// SEND MESSAGE
// ================================

sendButton.addEventListener(
    "click",
    sendMessage
);


messageInput.addEventListener(
    "keydown",
    (event) => {

        if (event.key === "Enter") {
            sendMessage();
        }

    }
);


async function sendMessage() {

    const message =
        messageInput.value.trim();

    if (!message) return;


    addMessage(
        "user",
        message
    );

    messageInput.value = "";


    addMessage(
        "ai",
        "Thinking..."
    );


    try {

        const response =
            await fetch(
                `${API}/ask`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        message: message
                    })
                }
            );


        const data =
            await response.json();

        removeLastMessage();


        if (data.success) {

            addMessage(
                "ai",
                data.response
            );

            speak(data.response);

        } else {

            addMessage(
                "ai",
                "Error: " + data.error
            );

        }

    } catch {

        removeLastMessage();

        addMessage(
            "ai",
            "Backend is not running."
        );

    }
}


// ================================
// QUICK QUESTIONS
// ================================

function quickAsk(message) {

    messageInput.value =
        message;

    sendMessage();

}


// ================================
// CHAT UI
// ================================

function addMessage(type, text) {

    const message =
        document.createElement("div");

    message.className =
        `message ${type}`;

    const title =
        type === "user"
            ? "YOU"
            : "AI";


    message.innerHTML = `
        <strong>${title}</strong>
        <p>${escapeHTML(text)}</p>
    `;


    messages.appendChild(message);

    messages.scrollTop =
        messages.scrollHeight;
}


function removeLastMessage() {

    if (messages.lastElementChild) {

        messages.removeChild(
            messages.lastElementChild
        );

    }

}


function escapeHTML(text) {

    const div =
        document.createElement("div");

    div.textContent =
        text;

    return div.innerHTML;
}


// ================================
// TEXT TO SPEECH
// ================================

function speak(text) {

    if (!("speechSynthesis" in window)) {
        return;
    }

    window.speechSynthesis.cancel();

    const speech =
        new SpeechSynthesisUtterance(text);

    speech.rate = 1.0;
    speech.pitch = 1.0;

    window.speechSynthesis.speak(
        speech
    );
}


// ================================
// START
// ================================

checkBackend();

setInterval(
    checkBackend,
    5000
);