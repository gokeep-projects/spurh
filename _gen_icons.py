# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from PIL import Image, ImageDraw
import os

ICON_DIR = r"D:\work\spurh\src-tauri\icons"
C1 = (62, 207, 142)
C2 = (47, 157, 228)
LIGHTNING = [(13.4, 5.4), (7.4, 13.1), (11.5, 13.1), (10.5, 18.6), (16.5, 10.9), (12.4, 10.9)]

def grad_image(size):
    """左上->右下线性渐变（生成 64 基准再放大，保持线性）"""
    base = 64
    img = Image.new("RGBA", (base, base))
    px = img.load()
    for y in range(base):
        t = y / (base - 1)
        for x in range(base):
            u = x / (base - 1)
            k = (t + u) / 2
            px[x, y] = (int(C1[0] + (C2[0] - C1[0]) * k),
                        int(C1[1] + (C2[1] - C1[1]) * k),
                        int(C1[2] + (C2[2] - C1[2]) * k), 255)
    if size != base:
        img = img.resize((size, size), Image.BILINEAR)
    return img

def draw_icon(size, ss=3):
    """超采样绘制图标"""
    S = size * ss
    grad = grad_image(S)
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    rect = [1.6 * S / 24, 1.6 * S / 24, 22.4 * S / 24, 22.4 * S / 24]
    md.rounded_rectangle(rect, radius=6.2 * S / 24, fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    pts = [(x * S / 24, y * S / 24) for (x, y) in LIGHTNING]
    d.polygon(pts, fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)

def save(name, size):
    draw_icon(size).save(os.path.join(ICON_DIR, name), "PNG")
    print("  ", name, size)

save("icon-source.png", 1024)
save("icon.png", 512)
save("128x128@2x.png", 256)
save("128x128.png", 128)
save("64x64.png", 64)
save("32x32.png", 32)

store = {
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}
for name, s in store.items():
    draw_icon(s).save(os.path.join(ICON_DIR, name), "PNG")
print("store done")

for root, dirs, files in os.walk(ICON_DIR):
    for f in files:
        if f.startswith("ic_launcher") and f.endswith(".png"):
            full = os.path.join(root, f)
            try:
                s = Image.open(full).size[0]
            except Exception:
                continue
            draw_icon(s).save(full, "PNG")
            print("  android:", os.path.relpath(full, ICON_DIR), s)

for root, dirs, files in os.walk(ICON_DIR):
    for f in files:
        if f.startswith("AppIcon") and f.endswith(".png"):
            full = os.path.join(root, f)
            try:
                s = Image.open(full).size[0]
            except Exception:
                continue
            draw_icon(s).save(full, "PNG")
            print("  mac:", f, s)

sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [draw_icon(s, ss=2) for s in sizes]
frames[0].save(os.path.join(ICON_DIR, "icon.ico"), format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])
print("icon.ico done")
print("ALL ICONS REGENERATED")