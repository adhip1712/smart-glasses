# =========================================================
# VISIONARY NEXUS - ML ENVIRONMENT DOCTOR
# =========================================================
#
# Reports what is ACTUALLY installed, because "opencv-python is in my
# requirements" does not mean it is the cv2 that Python imports. Both
# opencv-python and opencv-python-headless install into the same `cv2`
# directory, and whichever was installed last silently wins.
#
#   Windows   .venv\Scripts\python -m ml.doctor
#   Linux     .venv/bin/python -m ml.doctor
#
# Exits 0 when the pipeline can run, 1 when something must be fixed. A missing
# GUI is a warning (the headless path still works), a missing OpenCV or
# Ultralytics is an error.
# =========================================================

from __future__ import annotations

import sys
from typing import List, Optional, Tuple


def _distribution_for_module(module_name: str) -> Tuple[str, str]:
    """Which installed distribution provides a module, and its version."""

    from importlib.metadata import distributions

    try:
        import importlib

        module = importlib.import_module(module_name)
    except Exception:
        return "", ""

    top_level = module_name.split(".")[0]

    for dist in distributions():
        try:
            files = dist.files or []
        except Exception:
            continue

        for entry in files:
            text = str(entry)

            if text.startswith(f"{top_level}/") or text.startswith(f"{top_level}."):
                return dist.metadata["Name"] or "", dist.version or ""

    return "", getattr(module, "__version__", "")


def check_opencv() -> Tuple[bool, List[str], List[str]]:
    lines: List[str] = []
    errors: List[str] = []

    try:
        import cv2
    except Exception as error:
        return False, [f"cv2 is NOT importable: {type(error).__name__}: {error}"], [
            "install the ML extras: pip install -r requirements-ml.txt"
        ]

    dist, dist_version = _distribution_for_module("cv2")

    lines.append(f"  cv2 file      : {cv2.__file__}")
    lines.append(f"  cv2 version   : {cv2.__version__}")
    lines.append(f"  distribution  : {dist or 'unknown'} {dist_version}".rstrip())

    if dist and "headless" in dist.lower():
        lines.append("  GUI support   : NO (this is the headless build)")
        lines.append("")
        lines.append("  -> A window cannot be opened with this build. Fix with:")
        lines.append("       .venv\\Scripts\\pip uninstall -y opencv-python-headless")
        lines.append("       .venv\\Scripts\\pip install opencv-python")
    else:
        from .display import gui_available

        available, reason = gui_available()

        if available:
            lines.append("  GUI support   : YES (a window can be opened)")
        else:
            lines.append(f"  GUI support   : NO ({reason})")

    # Report a conflicting pair, which is the usual cause of confusion.
    installed = _installed_opencv_packages()

    if len(installed) > 1:
        errors.append(
            "conflicting OpenCV packages installed together: "
            + ", ".join(f"{name} {version}" for name, version in installed)
            + " - keep exactly one (opencv-python for a desktop window)"
        )
        lines.append("")
        lines.append("  !! more than one OpenCV package is installed")

    return True, lines, errors


def _installed_opencv_packages() -> List[Tuple[str, str]]:
    from importlib.metadata import distributions

    found: List[Tuple[str, str]] = []

    for dist in distributions():
        name = (dist.metadata["Name"] or "")

        if name.lower().startswith("opencv"):
            found.append((name, dist.version or ""))

    return sorted(found)


def check_ultralytics() -> Tuple[List[str], List[str]]:
    lines: List[str] = []
    errors: List[str] = []

    try:
        from importlib.metadata import version as _version

        lines.append(f"  ultralytics   : {_version('ultralytics')}")
    except Exception:
        lines.append("  ultralytics   : NOT INSTALLED")
        errors.append("install the ML extras: pip install -r requirements-ml.txt")
        return lines, errors

    try:
        import torch

        lines.append(f"  torch         : {torch.__version__}")
        lines.append(f"  cuda available: {torch.cuda.is_available()}")
    except Exception as error:
        lines.append(f"  torch         : NOT IMPORTABLE ({type(error).__name__})")
        errors.append("torch is missing: pip install -r requirements-ml.txt")

    try:
        import numpy

        lines.append(f"  numpy         : {numpy.__version__}")
    except Exception:
        lines.append("  numpy         : NOT INSTALLED")
        errors.append("numpy is missing")

    # OpenCV/Ultralytics compatibility: Ultralytics needs opencv-python >= 4.7.
    try:
        import cv2

        major = int(cv2.__version__.split(".")[0])

        if major < 4:
            errors.append(
                f"OpenCV {cv2.__version__} is older than the 4.7 Ultralytics needs"
            )
    except Exception:
        pass

    return lines, errors


def check_model() -> Tuple[List[str], List[str]]:
    lines: List[str] = []
    errors: List[str] = []

    try:
        from .config import load_settings
        from .detector import YoloDetector

        settings = load_settings()
        detector = YoloDetector(settings.model)
        path = detector.weights_path()

        lines.append(f"  configured    : {settings.model.path}")

        if path is not None:
            size = path.stat().st_size
            lines.append(f"  weights found : {path} ({size / 1e6:.1f} MB)")
        else:
            lines.append("  weights found : NO")
            lines.append(
                "  -> they download on first run; set VISION_MODEL_PATH to a local "
                "file to avoid that"
            )
    except Exception as error:
        lines.append(f"  model check   : FAILED ({type(error).__name__}: {error})")
        errors.append("the model configuration could not be read")

    return lines, errors


def check_cameras(max_index: int = 3) -> Tuple[List[str], List[str]]:
    lines: List[str] = []
    errors: List[str] = []

    try:
        from .config import load_settings
        from .webcam_source import list_available_cameras

        settings = load_settings()
        lines.append(
            f"  configured    : index {settings.camera.index}, "
            f"{settings.camera.width}x{settings.camera.height}, backend {settings.camera.backend}"
        )

        found = list_available_cameras(max_index=max_index)

        if not found:
            lines.append("  cameras found : NONE")
            errors.append(
                "no camera could be opened - is one connected and not in use by "
                "another application?"
            )
        else:
            for entry in found:
                lines.append(
                    f"  camera {entry['index']}      : backend {entry['backend']}, "
                    f"{entry['resolution']}"
                )
    except Exception as error:
        lines.append(f"  camera check  : FAILED ({type(error).__name__}: {error})")
        errors.append("the camera check raised an exception")

    return lines, errors


def main(argv: Optional[List[str]] = None) -> int:
    import platform

    probe_cameras = "--no-cameras" not in (argv or [])

    print("=" * 68)
    print("  VISIONARY NEXUS - ML environment doctor")
    print("=" * 68)
    print(f"  python        : {sys.executable}")
    print(f"  version       : {platform.python_version()} on {platform.system()}")
    print("")

    all_errors: List[str] = []

    print("OpenCV")
    ok, lines, errors = check_opencv()
    print("\n".join(lines))
    all_errors.extend(errors)
    print("")

    print("ML stack")
    lines, errors = check_ultralytics()
    print("\n".join(lines))
    all_errors.extend(errors)
    print("")

    print("Model")
    lines, errors = check_model()
    print("\n".join(lines))
    all_errors.extend(errors)
    print("")

    if probe_cameras:
        print("Cameras (this can take a few seconds)")
        lines, errors = check_cameras()
        print("\n".join(lines))
        all_errors.extend(errors)
        print("")

    print("=" * 68)

    if all_errors:
        print("  NOT READY - fix these:")

        for error in all_errors:
            print(f"    * {error}")

        print("")
        return 1

    print("  READY - run:  python -m ml.webcam_detection")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
