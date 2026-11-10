from pathlib import Path
p = Path(r"C:\Users\adhip\OneDrive\All Projects\Smartglasses\smart-glasses\Frontend\src\components\YouTubeMusic.tsx")
s = p.read_text(encoding="utf-8")
old = r"/quotaExceeded|quota exceeded|daily.*quota|per.day.*limit/i"
new = r"/quota|daily.*limit|per.day.*limit/i"
count = s.count(old)
s = s.replace(old, new)
p.write_text(s, encoding="utf-8")
print(f"Broadened quota detection in {count} places.")
