import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware"


def test_each_arduino_sketch_folder_has_a_matching_primary_file():
    sketches = list(FIRMWARE.rglob("*.ino"))
    assert sketches

    for sketch in sketches:
        primary = sketch.parent / f"{sketch.parent.name}.ino"
        assert primary.is_file(), f"Missing Arduino primary sketch: {primary}"

    assert (FIRMWARE / "camera" / "camera.ino").is_file()
    assert (FIRMWARE / "camera" / "camera_pins.h").is_file()


def test_all_quoted_firmware_includes_resolve_beside_the_source():
    sources = [
        path
        for path in FIRMWARE.rglob("*")
        if path.is_file() and path.suffix in {".ino", ".h", ".c", ".cpp"}
    ]
    include_pattern = re.compile(r'^\s*#include\s+"([^"]+)"', re.MULTILINE)

    for source in sources:
        content = source.read_text(encoding="utf-8")
        for include in include_pattern.findall(content):
            assert (source.parent / include).is_file(), f"{source} cannot resolve {include}"
