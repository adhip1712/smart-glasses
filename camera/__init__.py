# =========================================================
# VISIONARY NEXUS - CAMERA PACKAGE
# =========================================================
#
# ESP32-CAM (AI Thinker + OV2640) and PC-webcam integration:
#
#   config.py            environment-driven camera configuration
#   video_stream.py      bounded HTTP reads of MJPEG streams / snapshots
#   image_processing.py  OpenCV JPEG decode / encode (optional at runtime)
#   image_capture.py     one frame from the ESP32-CAM or the PC webcam
#   camera.py            CameraService: status / health / snapshot / stream-info
#
# The backend imports this package through backend/camera_api.py. Nothing here
# requires the ESP32-CAM to be present: every network call is bounded by a
# timeout and reports a failure value instead of raising.
# =========================================================

from .camera import CameraService, get_camera_service, set_device_lookup
from .config import CameraConfig

__all__ = [
    "CameraService",
    "CameraConfig",
    "get_camera_service",
    "set_device_lookup",
]
