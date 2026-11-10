from pathlib import Path
p = Path(r"C:\Users\adhip\OneDrive\All Projects\Smartglasses\smart-glasses\backend\api.py")
s = p.read_text(encoding="utf-8")
old = '''    piped_instances = [
        "https://pipedapi.adminforge.de",
        "https://pipedapi.leptons.xyz",
    ]
    invidious_instances = [
        "https://inv.nadeko.net",
        "https://invidious.nerdvpn.de",
        "https://inv.tux.pizza",
    ]'''
new = '''    # Public instance availability changes frequently. Keep several known
    # API hosts in rotation and continue immediately when one is offline.
    piped_instances = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.nosebs.ru",
        "https://piped-api.privacy.com.de",
        "https://api.piped.yt",
        "https://pipedapi.leptons.xyz",
        "https://pipedapi.adminforge.de",
    ]
    invidious_instances = [
        "https://invidious.tiekoetter.com",
        "https://yt.chocolatemoo53.com",
        "https://invidious.nerdvpn.de",
        "https://inv.nadeko.net",
    ]'''
if old not in s:
    raise SystemExit("Instance list block not found.")
s = s.replace(old, new, 1)
s = s.replace('urlopen(request, timeout=4) as response:\n                payload = json.loads(response.read().decode("utf-8", errors="replace"))',
              'urlopen(request, timeout=3) as response:\n                payload = json.loads(response.read().decode("utf-8", errors="replace"))')
p.write_text(s, encoding="utf-8")
print("Refreshed Piped/Invidious instance rotation and reduced per-instance timeout.")
