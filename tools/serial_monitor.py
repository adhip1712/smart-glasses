"""Read the Visionary Nexus ESP32-CAM serial log.

Usage:
    python tools/serial_monitor.py            # list ports
    python tools/serial_monitor.py COM8       # read 15 s of log at 115200
    python tools/serial_monitor.py COM8 --seconds 30

The camera firmware prints its device ID, detected sensor, provisioning AP
(SSID VISIONARY NEXUS / 192.168.4.1) and check-in results here.
"""

from __future__ import annotations

import argparse
import sys
import time


def list_ports() -> list:
    from serial.tools import list_ports as port_list

    return list(port_list.comports())


def main() -> int:
    parser = argparse.ArgumentParser(description="Visionary Nexus ESP32-CAM serial monitor")
    parser.add_argument("port", nargs="?", help="Serial port, e.g. COM8 (omit to list ports)")
    parser.add_argument("--seconds", type=float, default=15.0, help="How long to read (default 15)")
    parser.add_argument("--baud", type=int, default=115200, help="Baud rate (firmware uses 115200)")
    args = parser.parse_args()

    ports = list_ports()
    if not ports:
        print("No serial ports found. Is the ESP32-CAM plugged in?")
        return 1

    if not args.port:
        print("Available serial ports:")
        for port in ports:
            print(f"  {port.device:8s} {port.description}")
        print("\nRead one with:  python tools/serial_monitor.py COM8")
        return 0

    target = args.port.upper()
    if not any(port.device.upper() == target for port in ports):
        print(f"{target} was not found. Available ports:")
        for port in ports:
            print(f"  {port.device:8s} {port.description}")
        return 1

    import serial

    print(f"Reading {target} at {args.baud} baud for {args.seconds:.0f}s (Ctrl+C to stop)...")
    try:
        with serial.Serial(target, args.baud, timeout=1) as connection:
            connection.reset_input_buffer()
            deadline = time.time() + args.seconds
            while time.time() < deadline:
                raw = connection.readline()
                if not raw:
                    continue
                print(raw.decode("utf-8", errors="replace").rstrip())
    except KeyboardInterrupt:
        print("\nStopped.")
    except Exception as error:  # port busy, unplugged, permission denied
        print(f"Could not read {target}: {error}")
        print("If the port is busy, close the Arduino IDE Serial Monitor first.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
