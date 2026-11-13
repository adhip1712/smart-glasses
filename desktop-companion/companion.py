import datetime as dt
import json, os, re, subprocess, threading, uuid, winreg
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
HOST, PORT = "127.0.0.1", 8765
APPDATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "VisionaryNexus"
ALARM_DIR = APPDATA / "alarms"
ALARM_DIR.mkdir(parents=True, exist_ok=True)
ORIGINS = {"https://visionary-vexus.vercel.app", "http://localhost:8443", "http://127.0.0.1:8443"}
ORIGINS.update(x.strip() for x in os.environ.get("VN_ALLOWED_ORIGINS", "").split(",") if x.strip())
TIMERS = {}
def norm(s): return re.sub(r"[^a-z0-9]+", " ", s.casefold()).strip()
def discover_apps():
    roots = [Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs", Path(os.environ.get("ProgramData", "C:/ProgramData")) / "Microsoft/Windows/Start Menu/Programs", Path.home() / "Desktop"]
    found = {}
    for root in roots:
        if root.exists():
            try:
                for p in root.rglob("*.lnk"): found.setdefault(norm(p.stem), {"name": p.stem, "kind": "shortcut", "target": str(p)})
            except OSError: pass
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths") as root:
                for i in range(winreg.QueryInfoKey(root)[0]):
                    try:
                        key = winreg.EnumKey(root, i)
                        with winreg.OpenKey(root, key) as sub: target, _ = winreg.QueryValueEx(sub, None)
                        name = Path(key).stem
                        found.setdefault(norm(name), {"name": name, "kind": "executable", "target": target.strip('"')})
                    except OSError: pass
        except OSError: pass
    return sorted(found.values(), key=lambda x: x["name"].casefold())
def launch_app(name):
    key, apps = norm(name), discover_apps()
    app = next((x for x in apps if norm(x["name"]) == key), None) or next((x for x in apps if key and (key in norm(x["name"]) or norm(x["name"]) in key)), None)
    if app:
        os.startfile(app["target"]) if app["kind"] == "shortcut" else subprocess.Popen([app["target"]], close_fds=True)
        return {"success": True, "app": app["name"], "kind": app["kind"]}
    uri = {"clock": "ms-clock:", "windows clock": "ms-clock:", "calculator": "calculator:", "settings": "ms-settings:"}.get(key)
    if uri: os.startfile(uri); return {"success": True, "app": name, "kind": "windows_uri"}
    return {"success": False, "needs_connection": True, "error": f"{name} was not found in Start Menu shortcuts or registered App Paths."}
def parse_time(text):
    m = re.search(r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b", text, re.I)
    if m:
        h, minute, second, mer = int(m[1]), int(m[2] or 0), int(m[3] or 0), m[4].lower().replace(".", "")
        if not 1 <= h <= 12 or minute > 59 or second > 59: raise ValueError("That alarm time is invalid.")
        h = h % 12 + (12 if mer == "pm" else 0)
    else:
        m = re.search(r"\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b", text)
        if not m: raise ValueError("Tell me a time such as 4 PM or 4:44:02 PM.")
        h, minute, second = int(m[1]), int(m[2]), int(m[3] or 0)
    now = dt.datetime.now()
    when = now.replace(hour=h, minute=minute, second=second, microsecond=0)
    if when <= now: when += dt.timedelta(days=1)
    return when
def set_alarm(request):
    when, alarm_id = parse_time(request), uuid.uuid4().hex[:10]
    script = ALARM_DIR / (alarm_id + ".ps1")
    script.write_text("Add-Type -AssemblyName System.Windows.Forms\nwhile ($true) { [System.Media.SystemSounds]::Alarm.Play(); $null = [System.Windows.Forms.MessageBox]::Show('Your Visionary Nexus alarm is ringing.', 'Visionary Nexus alarm'); break }\n", encoding="utf-8")
    def ring():
        subprocess.Popen(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    fallback = False
    # Task Scheduler is minute-granular. Use it only when the requested time
    # has no seconds; otherwise use the resident timer to avoid duplicate alerts.
    if when.second == 0:
        try:
            subprocess.run(["schtasks", "/Create", "/SC", "ONCE", "/ST", when.strftime("%H:%M"), "/SD", when.strftime("%m/%d/%Y"), "/TN", "VisionaryNexus_Alarm_" + alarm_id, "/TR", f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{script}"', "/F", "/IT"], check=True, capture_output=True, timeout=15)
            fallback = True
        except (OSError, subprocess.SubprocessError): pass
    if not fallback:
        timer = threading.Timer(max(0.1, (when - dt.datetime.now()).total_seconds()), ring)
        timer.daemon = True; timer.start(); TIMERS[alarm_id] = timer
    precision = "Windows Task Scheduler (minute precision)" if fallback else "seconds while the companion remains running"
    return {"success": True, "alarm_id": alarm_id, "scheduled_for": when.isoformat(timespec="seconds"), "task_scheduler_fallback": fallback, "precision": precision, "note": "The laptop must be awake and the user signed in for the interactive alert. Keep the companion running for second-level precision."}
class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data):
        origin = self.headers.get("Origin", "")
        self.send_response(status)
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin); self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store"); self.end_headers()
        if status != 204: self.wfile.write(json.dumps(data).encode())
    def do_OPTIONS(self):
        self.reply(204, {}) if self.headers.get("Origin") in ORIGINS else self.reply(403, {"success": False, "error": "Origin not allowed"})
    def do_GET(self):
        if self.headers.get("Origin") not in ORIGINS: return self.reply(403, {"success": False, "error": "Origin not allowed"})
        path = urlparse(self.path).path
        if path == "/health": return self.reply(200, {"success": True, "name": "Visionary Nexus Companion", "version": "1.0"})
        if path == "/apps": return self.reply(200, {"success": True, "apps": [{"name": a["name"], "kind": a["kind"]} for a in discover_apps()]})
        self.reply(404, {"success": False, "error": "Not found"})
    def do_POST(self):
        if self.headers.get("Origin") not in ORIGINS: return self.reply(403, {"success": False, "error": "Origin not allowed"})
        try:
            data = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 16000)) or b"{}")
            path = urlparse(self.path).path
            if path == "/launch":
                result = launch_app(str(data.get("app") or "")); return self.reply(200 if result["success"] else 404, result)
            if path == "/alarm": return self.reply(200, set_alarm(str(data.get("request") or "")))
            self.reply(404, {"success": False, "error": "Not found"})
        except ValueError as e: self.reply(400, {"success": False, "error": str(e)})
        except Exception as e: self.reply(500, {"success": False, "error": type(e).__name__})
    def log_message(self, *args): pass
if __name__ == "__main__":
    print(f"Visionary Nexus Companion listening at http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
