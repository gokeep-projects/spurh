"""生成 Spurh 品牌图标源图（1024x1024 PNG）：渐变圆角方块 + 白色闪电。
与前端 BRAND_MARK（viewBox 24）同款设计，4x 超采样抗锯齿。
用法：python scripts/gen_icon.py [输出路径]
"""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/icons/icon-source.png"

SIZE = 1024
SS = 4  # 超采样倍数
C = SS * SIZE  # 画布尺寸（4096）

# BRAND_MARK 渐变与闪电（viewBox 24，方块 rect x=1.6 y=1.6 w=20.8 h=20.8 rx=6.2）
G1 = (62, 207, 142)   # #3ecf8e 左上
G2 = (47, 157, 228)   # #2f9de4 右下
FLASH = [(13.4, 5.4), (7.4, 13.1), (11.5, 13.1), (10.5, 18.6), (16.5, 10.9), (12.4, 10.9)]

MARGIN = SIZE * 0.06
BOX = SIZE * 0.88
RX = BOX * 0.298

# 1) 对角渐变底：2x2 角图双线性放大
grad = Image.new("RGB", (2, 2))
grad.putdata([G1, (G1[0]+G2[0])//2, (G1[1]+G2[1])//2, G2])
grad = grad.resize((C, C), Image.BILINEAR).convert("RGBA")

canvas = Image.new("RGBA", (C, C), (0, 0, 0, 0))
canvas.alpha_composite(grad)

# 2) 圆角方块蒙版
mask = Image.new("L", (C, C), 0)
d = ImageDraw.Draw(mask)
m0 = int(MARGIN * SS)
m1 = int((MARGIN + BOX) * SS)
d.rounded_rectangle([m0, m0, m1, m1], radius=int(RX * SS), fill=255)
canvas.putalpha(mask)

# 3) 白色闪电（viewBox 坐标映射到方块内）
draw = ImageDraw.Draw(canvas)
def pt(x: float, y: float):
    return (MARGIN + (x - 1.6) / 20.8 * BOX) * SS, (MARGIN + (y - 1.6) / 20.8 * BOX) * SS
draw.polygon([pt(x, y) for x, y in FLASH], fill=(255, 255, 255, 255))

canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
canvas.save(OUT, "PNG")
print(f"written {OUT} {SIZE}x{SIZE}")
