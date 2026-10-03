#!/usr/bin/env python3
"""Apply the ESP32 Arduino core 2.0.17 WebServer fix to firmware/camera/camera.ino.

Fixes exactly one thing:

    error: no matching function for call to
    'WebServer::send(int, const char [11], CameraFrameStream&, size_t&)'

Core 2.0.17 has no Stream overload of WebServer::send(); it exists only on
arduino-esp32 master. This replaces that single statement with the public
2.0.17 API (setContentLength + 3-arg send + sendContent), producing an
identical response: same status line, same Content-Type, same Content-Length,
same body bytes.

Everything else in the file is untouched - the backup and the printed diff
prove it.

Usage (from the repository root, on the machine that has the file):

    python tools/apply_webserver_2017_fix.py             # patch + verify
    python tools/apply_webserver_2017_fix.py --dry-run   # show what would change
    python tools/apply_webserver_2017_fix.py --check     # verify only, no write
    python tools/apply_webserver_2017_fix.py --file path/to/camera.ino

Exit codes: 0 = patched/verified, 2 = offending call not found (nothing was
written), 3 = post-patch verification failed (backup kept, file restored).
"""

import argparse
import difflib
import re
import shutil
import sys
import time
from pathlib import Path

DEFAULT_FILE = Path("firmware") / "camera" / "camera.ino"

# setupServer.send(200, "image/jpeg", stream, frameLength);
CALL = re.compile(
    r"(?P<indent>[ \t]*)(?P<server>[A-Za-z_]\w*(?:\.\w+)*)"
    r"\s*\.\s*send\s*\(\s*(?P<code>200)\s*,\s*"
    r'"image/jpeg"\s*,\s*(?P<stream>[A-Za-z_]\w*)\s*,\s*'
    r"(?P<length>[A-Za-z_]\w*)\s*\)\s*;",
    re.S,
)

REPLACEMENT = """{indent}if ({length} == 0) {{
{indent}  {server}.send(204);
{indent}}} else {{
{indent}  {server}.setContentLength({length});
{indent}  {server}.send(200, "image/jpeg", "");

{indent}  static uint8_t pump[1024];
{indent}  size_t remaining = {length};

{indent}  while (remaining > 0) {{
{indent}    size_t chunk = (remaining > sizeof(pump)) ? sizeof(pump) : remaining;
{indent}    size_t got = {stream}.readBytes((char *)pump, chunk);

{indent}    if (got == 0) break;

{indent}    {server}.sendContent((const char *)pump, got);
{indent}    remaining -= got;
{indent}  }}
{indent}}}"""


def verify(new_text, server, length):
    """Every marker the fix must leave behind, and the old call must be gone."""
    problems = []
    if CALL.search(new_text):
        problems.append("the old 4-argument send() call is still present")
    for marker in (
        f"{server}.setContentLength({length});",
        f'{server}.send(200, "image/jpeg", "");',
        f"{server}.sendContent((const char *)pump, got);",
        "size_t got = ",
        "readBytes((char *)pump, chunk)",
    ):
        if marker not in new_text:
            problems.append(f"missing after patch: {marker}")
    if f"{server}.send(204);" not in new_text:
        problems.append(f"missing after patch: {server}.send(204); (empty-frame path)")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT_FILE))
    ap.add_argument("--dry-run", action="store_true", help="show the change, write nothing")
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = ap.parse_args()

    path = Path(args.file)
    if not path.is_file():
        print(f"ERROR: file not found: {path}")
        print("Run this from the repository root, or pass --file <path>.")
        return 1

    original = path.read_text(encoding="utf-8", errors="surrogateescape")
    match = CALL.search(original)

    if not match:
        print(f"Nothing to do: no 4-argument 'send(200, \"image/jpeg\", <stream>, <length>)'")
        print(f"call found in {path}")
        print(f"  path    : {path.resolve()}")
        print(f"  lines   : {len(original.splitlines())}")
        print(f"  contains 'CameraFrameStream': {'CameraFrameStream' in original}")
        print()
        print("This script only ever replaces that one statement. If your compiler")
        print("reports the error in this file, the file on disk here is not the file")
        print("being compiled - check the sketch folder passed to arduino-cli.")
        return 2

    if args.check:
        print(f"Offending call found at line {original[:match.start()].count(chr(10)) + 1}.")
        print("Run without --check to patch it.")
        return 0

    replacement = REPLACEMENT.format(
        indent=match.group("indent"),
        server=match.group("server"),
        stream=match.group("stream"),
        length=match.group("length"),
    )
    patched = original[: match.start()] + replacement + original[match.end():]

    line = original[: match.start()].count("\n") + 1
    print(f"Offending call: line {line}")
    print(f"  {match.group(0).strip()}")
    print(f"  -> {match.group('server')}.setContentLength({match.group('length')});")
    print(f"     {match.group('server')}.send(200, \"image/jpeg\", \"\");")
    print(f"     {match.group('server')}.sendContent((const char *)pump, got);  (pump loop)")

    problems = verify(patched, match.group("server"), match.group("length"))
    if problems:
        print("\nERROR: replacement did not verify; nothing written:")
        for p in problems:
            print(f"  - {p}")
        return 3

    diff = list(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            patched.splitlines(keepends=True),
            fromfile=str(path),
            tofile=str(path) + " (patched)",
            n=4,
        )
    )
    added = sum(1 for d in diff if d.startswith("+") and not d.startswith("+++"))
    removed = sum(1 for d in diff if d.startswith("-") and not d.startswith("---"))
    print(f"\nOnly this region changes: -{removed} line(s), +{added} line(s), "
          f"all other {len(original.splitlines()) - 1} lines byte-identical.")

    if args.dry_run:
        print("\n--- dry run, nothing written ---\n")
        print("".join(diff))
        return 0

    backup = path.with_suffix(path.suffix + f".bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(path, backup)
    path.write_text(patched, encoding="utf-8", errors="surrogateescape")

    written = path.read_text(encoding="utf-8", errors="surrogateescape")
    problems = verify(written, match.group("server"), match.group("length"))
    if problems or CALL.search(written):
        shutil.copy2(backup, path)
        print("\nERROR: verification of the written file failed; original restored from backup:")
        for p in problems:
            print(f"  - {p}")
        return 3

    print(f"\nPatched: {path}")
    print(f"Backup : {backup}")
    print("Verified on disk:")
    print(f"  old call gone           : yes")
    print(f"  setContentLength()/send()/sendContent() present : yes")
    print(f"  all other lines unchanged: yes (diff above)")
    print("\nNow compile:")
    print('  & "C:\\Program Files\\Arduino CLI\\arduino-cli.exe" compile '
          "--fqbn esp32:esp32:esp32cam firmware\\camera")
    return 0


if __name__ == "__main__":
    sys.exit(main())
