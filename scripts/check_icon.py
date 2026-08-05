"""验证图标源图：尺寸、透明通道、角部/中心像素。
用法：python scripts/check_icon.py <png路径>
"""
import sys
from PIL import Image

img = Image.open(sys.argv[1]).convert("RGBA")
w, h = img.size
alpha = img.getchannel("A")
corners = [(4, 4), (w - 5, 4), (4, h - 5), (w - 5, h - 5)]
center = (w // 2, h // 2)
print(f"size={w}x{h} mode={img.mode}")
print(f"corner alpha: {[alpha.getpixel(c) for c in corners]}")
print(f"center pixel: {img.getpixel(center)}")
opaque = sum(1 for y in range(0, h, 8) for x in range(0, w, 8) if alpha.getpixel((x, y)) > 0)
total = len(range(0, h, 8)) * len(range(0, w, 8))
print(f"opaque sample ratio: {opaque}/{total} ({opaque / total:.0%})")
