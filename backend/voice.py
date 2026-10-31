"""Voice services for Visionary Nexus: wake phrase, speech-to-text, text-to-speech.

Provider abstraction keeps the stack replaceable:

* STT: OpenAI whisper endpoints, Groq whisper endpoints, otherwise an honest
  "unavailable" response (the browser Web Speech API still provides STT in the
  frontend).
* TTS: local Kokoro ONNX speech first, with optional cloud providers and a
  browser ``speechSynthesis`` fallback. No paid API is needed for local TTS.

No API key is ever returned to the frontend.
"""

from __future__ import annotations

import base64
import io
import os
import re

import httpx

_kokoro_engine = None

WAKE_PHRASES = (
    "hey vision",
    "hi vision",
    "ok vision",
    "vision",
    # Legacy phrases kept so older firmware / scripts keep working.
    "hey visionary",
    "hey visionary nexus",
    "visionary nexus",
)

DEFAULT_OPENAI_STT_MODEL = "whisper-1"
DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts"
DEFAULT_GROQ_STT_MODEL = "whisper-large-v3"


def _env(*names: str) -> str:
    for name in names:
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def detect_wake_phrase(phrase: str | None) -> bool:
    text = (phrase or "").strip().lower()
    if not text:
        return False
    return any(wake in text for wake in WAKE_PHRASES)


def stt_provider() -> str:
    configured = _env("VOICE_STT_PROVIDER", "STT_PROVIDER").lower()
    if configured in {"off", "disabled", "none"}:
        return "off"
    if _env("OPENAI_API_KEY"):
        return "openai"
    if _env("GROQ_API_KEY"):
        return "groq"
    return "unavailable"


def tts_provider() -> str:
    configured = _env("VOICE_TTS_PROVIDER", "TTS_PROVIDER").lower()
    if configured in {"off", "disabled", "none"}:
        return "off"
    if configured in {"kokoro", "local", "kokoro-onnx"}:
        return "kokoro"
    if configured == "elevenlabs":
        return "elevenlabs" if _env("ELEVENLABS_API_KEY") else "unavailable"
    if configured == "openai":
        return "openai" if _env("OPENAI_API_KEY") else "unavailable"
    model_path = os.path.join(os.path.dirname(__file__), "models", "kokoro-v1.0.int8.onnx")
    voices_path = os.path.join(os.path.dirname(__file__), "models", "voices-v1.0.bin")
    if os.path.isfile(model_path) and os.path.isfile(voices_path):
        return "kokoro"
    if _env("ELEVENLABS_API_KEY"):
        return "elevenlabs"
    if _env("OPENAI_API_KEY"):
        return "openai"
    return "unavailable"


def _synthesize_kokoro(text: str) -> dict:
    """Generate speech locally; model files are downloaded once and run offline."""
    global _kokoro_engine
    model_dir = os.path.join(os.path.dirname(__file__), "models")
    model_path = os.path.join(model_dir, "kokoro-v1.0.int8.onnx")
    voices_path = os.path.join(model_dir, "voices-v1.0.bin")
    if not (os.path.isfile(model_path) and os.path.isfile(voices_path)):
        return {
            "success": False,
            "engine": "kokoro",
            "message": "Local Kokoro model files are missing. Install the model files under backend/models.",
        }
    try:
        if _kokoro_engine is None:
            import onnxruntime as ort
            from kokoro_onnx import Kokoro
            session_options = ort.SessionOptions()
            session_options.intra_op_num_threads = max(1, min(8, os.cpu_count() or 4))
            session_options.inter_op_num_threads = 1
            session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            session = ort.InferenceSession(
                model_path,
                sess_options=session_options,
                providers=["CPUExecutionProvider"],
            )
            _kokoro_engine = Kokoro.from_session(session, voices_path)
        samples, sample_rate = _kokoro_engine.create(
            text,
            voice=_env("KOKORO_VOICE") or "af_heart",
            speed=1.0,
            lang="en-us",
        )
        import soundfile as sf
        audio_buffer = io.BytesIO()
        sf.write(audio_buffer, samples, sample_rate, format="WAV", subtype="PCM_16")
        return {
            "success": True,
            "engine": "kokoro",
            "content_type": "audio/wav",
            "audio_base64": base64.b64encode(audio_buffer.getvalue()).decode("ascii"),
            "message": "Speech generated locally.",
        }
    except Exception as error:
        print(f"Local Kokoro TTS error: {type(error).__name__}: {error}")
        return {
            "success": False,
            "engine": "kokoro",
            "message": "Local speech generation failed. Check the backend model files and Kokoro dependencies.",
        }


def status() -> dict:
    wake_phrase = (os.getenv("WAKE_PHRASE") or "").strip() or "Hey Vision"
    return {
        "wake_phrase": wake_phrase,
        "stt": stt_provider(),
        "tts": tts_provider(),
        "browser_stt": True,
        "browser_tts": True,
        # For now audio runs through the paired laptop: its microphone captures
        # speech and its speakers play the reply. The glasses' INMP441 MEMS
        # microphone and speaker (I2S) become the active path once the
        # firmware audio tabs are implemented.
        "input_source": "laptop",
        "output_source": "laptop",
        "input_label": "Laptop microphone (browser)",
        "output_label": "Laptop speakers (browser)",
        "planned_hardware": "INMP441 MEMS microphone + speaker on the glasses (I2S, firmware audio tabs pending)",
    }


def transcribe(audio: bytes, filename: str = "audio.webm", content_type: str = "") -> dict:
    """Speech-to-text for an uploaded audio clip."""
    if not audio:
        return {"success": False, "engine": stt_provider(), "text": "", "message": "No audio was uploaded."}

    provider = stt_provider()
    if provider == "off":
        return {"success": False, "engine": "off", "text": "", "message": "Speech-to-text is disabled in the backend configuration."}
    if provider == "unavailable":
        return {
            "success": False,
            "engine": "unavailable",
            "text": "",
            "message": "Speech-to-text is not configured. Set OPENAI_API_KEY or GROQ_API_KEY in the backend .env, or use the browser microphone.",
        }

    files = {"file": (filename or "audio.webm", audio, content_type or "application/octet-stream")}
    try:
        if provider == "openai":
            model = _env("OPENAI_STT_MODEL") or DEFAULT_OPENAI_STT_MODEL
            base_url = _env("OPENAI_BASE_URL") or "https://api.openai.com/v1"
            response = httpx.post(
                f"{base_url.rstrip('/')}/audio/transcriptions",
                headers={"Authorization": f"Bearer {_env('OPENAI_API_KEY')}"},
                files=files,
                data={"model": model},
                timeout=60.0,
            )
        else:
            model = _env("GROQ_STT_MODEL") or DEFAULT_GROQ_STT_MODEL
            response = httpx.post(
                "https://api.groq.com/openai/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {_env('GROQ_API_KEY')}"},
                files=files,
                data={"model": model},
                timeout=60.0,
            )
        response.raise_for_status()
        text = (response.json().get("text") or "").strip()
        return {"success": bool(text), "engine": provider, "text": text, "message": "Transcribed." if text else "No speech was recognised."}
    except Exception as error:
        return {"success": False, "engine": provider, "text": "", "message": f"Speech-to-text failed: {error}"}


def synthesize(text: str) -> dict:
    """Text-to-speech; returns base64 audio when a provider is configured."""
    cleaned = (text or "").strip()
    if not cleaned:
        return {"success": False, "engine": tts_provider(), "message": "There is no text to speak."}
    if len(cleaned) > 2000:
        cleaned = cleaned[:2000]

    provider = tts_provider()
    if provider == "off":
        return {"success": False, "engine": "off", "message": "Text-to-speech is disabled in the backend configuration."}
    if provider == "unavailable":
        return {
            "success": False,
            "engine": "unavailable",
            "message": "Text-to-speech is not configured. Add ELEVENLABS_API_KEY to the backend environment, or use browser speech as a fallback.",
        }

    # Treat four-digit years as years for speech, not as digit-by-digit IDs.
    # This changes only the spoken copy; the visible assistant response stays untouched.
    def year_to_words(match):
        year = int(match.group(0))
        small = {
            0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
            6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven",
            12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen",
            16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen",
        }
        tens = {2: "twenty", 3: "thirty", 4: "forty", 5: "fifty", 6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety"}
        if 1900 <= year <= 1999:
            first, last = divmod(year, 100)
            remainder = year % 100
            if remainder == 0:
                return f"{small[first]} hundred"
            if remainder < 20:
                return f"{small[first]} {small[remainder]}"
            ten, unit = divmod(remainder, 10)
            return f"{small[first]} {tens[ten]}" + (f"-{small[unit]}" if unit else "")
        if 2000 <= year <= 2009:
            return "two thousand" + (f" {small[year % 100]}" if year % 100 else "")
        if 2010 <= year <= 2099:
            remainder = year % 100
            if remainder < 20:
                tail = small[remainder]
            else:
                ten, unit = divmod(remainder, 10)
                tail = tens[ten] + (f"-{small[unit]}" if unit else "")
            return f"twenty {tail}"
        return match.group(0)

    spoken = re.sub(r"(?<!\d)(?:19\d{2}|20\d{2})(?!\d)", year_to_words, cleaned)
    if provider == "kokoro":
        return _synthesize_kokoro(spoken)
    try:
        if provider == "elevenlabs":
            voice_id = _env("ELEVENLABS_VOICE_ID") or "21m00Tcm4TlvDq8ikWAM"
            model = _env("ELEVENLABS_MODEL_ID") or "eleven_turbo_v2_5"
            response = httpx.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
                headers={"xi-api-key": _env("ELEVENLABS_API_KEY"), "Accept": "audio/mpeg", "Content-Type": "application/json"},
                json={"text": spoken, "model_id": model, "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
                timeout=45.0,
            )
        else:
            model = _env("OPENAI_TTS_MODEL") or DEFAULT_OPENAI_TTS_MODEL
            base_url = _env("OPENAI_BASE_URL") or "https://api.openai.com/v1"
            response = httpx.post(
                f"{base_url.rstrip('/')}/audio/speech",
                headers={"Authorization": f"Bearer {_env('OPENAI_API_KEY')}"},
                json={"model": model, "voice": _env("OPENAI_TTS_VOICE") or "alloy", "input": spoken, "response_format": "mp3"},
                timeout=60.0,
            )
        response.raise_for_status()
        audio = response.content
        if not audio:
            return {"success": False, "engine": provider, "message": "The speech provider returned no audio."}
        return {
            "success": True,
            "engine": provider,
            "content_type": "audio/mpeg",
            "audio_base64": base64.b64encode(audio).decode("ascii"),
            "message": "Speech synthesised.",
        }
    except Exception as error:
        # Do not send provider responses or request metadata to the browser.
        print(f"Text-to-speech provider error ({provider}): {type(error).__name__}")
        return {"success": False, "engine": provider, "message": "Text-to-speech request failed."}
