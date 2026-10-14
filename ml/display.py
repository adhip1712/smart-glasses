# =========================================================
# VISIONARY NEXUS - DISPLAY (GUI WINDOW)
# =========================================================
#
# Everything that needs a real window lives here, so the rest of the project can
# stay headless. That split matters for two reasons:
#
#   * `opencv-python-headless` exports `cv2.imshow` but calling it raises
#     "The function is not implemented". `hasattr(cv2, "imshow")` therefore
#     returns True on a headless build - probing the symbol proves nothing, so
#     this module actually tries to create a window.
#   * The backend (backend/vision_api.py) only ever uses cv2.imencode, so it
#     keeps working on a headless server while the demo can use a window.
#
# Nothing here raises for a missing GUI: callers get `available == False` and a
# reason, and keep printing results instead of crashing.
# =========================================================

from __future__ import annotations

from typing import Any, Optional, Tuple

WINDOW_TITLE = "Visionary Nexus"

# Keys that stop the demo. Escape is 27; Q/q for convenience.
QUIT_KEYS = (27, ord("q"), ord("Q"))

_probe_cache: Optional[Tuple[bool, str]] = None


def gui_available(force_probe: bool = False) -> Tuple[bool, str]:
    """Can OpenCV actually open a window here?

    Returns (available, reason). The result is cached: probing creates and
    destroys a window, which should not happen on every call.

    A headless OpenCV build reports the failure as a cv2.error, so the check is
    a real namedWindow() call rather than a hasattr() test.
    """

    global _probe_cache

    if _probe_cache is not None and not force_probe:
        return _probe_cache

    result = _probe_gui()
    _probe_cache = result
    return result


def _probe_gui() -> Tuple[bool, str]:
    try:
        import cv2
    except Exception as error:
        return False, f"OpenCV is not importable: {type(error).__name__}: {error}"

    try:
        # The only reliable test: a headless build raises here.
        cv2.namedWindow("__nexus_probe__", cv2.WINDOW_NORMAL)
        cv2.destroyWindow("__nexus_probe__")
        return True, "gui available"
    except Exception as error:
        message = str(error)

        if "not implemented" in message.lower() or "not compiled" in message.lower():
            return False, (
                "OpenCV has no GUI support (the installed build is "
                "opencv-python-headless). Install the desktop build: "
                "pip uninstall -y opencv-python-headless && pip install opencv-python"
            )

        return False, f"OpenCV could not create a window: {type(error).__name__}: {error}"


def reset_probe_cache() -> None:
    """Forget the cached probe result (used by tests)."""

    global _probe_cache
    _probe_cache = None


def gui_status_text() -> str:
    """A one-line explanation, useful in startup banners."""

    available, reason = gui_available()

    return reason if available else f"no window ({reason})"


class VisionWindow:
    """A window that shows frames and reports quit keys, without ever raising.

    Usage:

        window = VisionWindow()
        if window.available:
            ...
            window.show(frame)
            if window.quit_requested():
                break
        window.close()

    When the GUI is unavailable `available` is False, `show()` is a no-op and
    `quit_requested()` stays False, so the caller keeps running headless.
    """

    def __init__(self, title: str = WINDOW_TITLE, probe: bool = True) -> None:
        self.title = title
        self.available = False
        self.reason = ""
        self.last_error = ""
        self.frames_shown = 0
        self._closed = False

        if not probe:
            self.available = False
            self.reason = "display disabled"
            return

        available, reason = gui_available()
        self.available = available
        self.reason = reason

        if not available:
            return

        try:
            import cv2

            cv2.namedWindow(self.title, cv2.WINDOW_NORMAL)
        except Exception as error:
            # The probe passed but the real window failed: degrade, do not crash.
            self.available = False
            self.reason = f"the window could not be created: {error}"

    def show(self, frame: Any, wait_ms: int = 1) -> bool:
        """Draw one frame and pump the window's event queue.

        Returns True when a quit key was pressed. Any GUI failure is recorded in
        `last_error` and turns the window off rather than raising.
        """

        if not self.available or frame is None or self._closed:
            return False

        try:
            import cv2

            cv2.imshow(self.title, frame)
            self.frames_shown += 1

            key = cv2.waitKey(max(1, int(wait_ms))) & 0xFF

            return key in QUIT_KEYS
        except Exception as error:
            self.last_error = str(error)
            self.available = False
            self.reason = (
                "the window failed while drawing a frame "
                "(is the installed OpenCV a headless build?)"
            )
            return False

    def quit_requested(self, wait_ms: int = 1) -> bool:
        """Poll for a quit key without showing a frame."""

        if not self.available or self._closed:
            return False

        try:
            import cv2

            return (cv2.waitKey(max(1, int(wait_ms))) & 0xFF) in QUIT_KEYS
        except Exception as error:
            self.last_error = str(error)
            self.available = False
            return False

    def close(self) -> None:
        """Close the window. Safe to call more than once, and when unavailable."""

        if self._closed:
            return

        self._closed = True

        if not self.available:
            return

        try:
            import cv2

            cv2.destroyWindow(self.title)
        except Exception:
            pass

        try:
            import cv2

            cv2.destroyAllWindows()
        except Exception:
            pass

        # Let the window manager actually process the destroy.
        try:
            import cv2

            cv2.waitKey(1)
        except Exception:
            pass

    def __enter__(self) -> "VisionWindow":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def describe(self) -> dict:
        return {
            "title": self.title,
            "available": self.available,
            "reason": self.reason,
            "frames_shown": self.frames_shown,
            "last_error": self.last_error,
        }
