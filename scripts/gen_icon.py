"""生成 Spurh 品牌图标源图（1024x1024 PNG）：深色圆角方块 + 绿蓝渐变闪电。
与前端 BRAND_MARK（viewBox 24）同款设计，4x 超采样抗锯齿。
用法：python scripts/gen_icon.py [输出路径]
"""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else "app-icon.png"

SIZE = 1024
SS = 4  # 超采样倍数
C = SS * SIZE  # 画布尺寸（4096）

# BRAND_MARK 配色（viewBox 24：rect x=1.4 y=1.4 w=21.2 h=21.2 rx=5.8）
BG_TOP = (16, 23, 40)    # #101728
BG_BOTTOM = (11, 14, 20)  # #0b0e14
BOLT_TOP = (62, 207, 142)   # #3ecf8e
BOLT_BOTTOM = (47, 157, 228)  # #2f9de4
BORDER = (94, 190, 255, 140)  # rgba(94,190,255,.55)
FLASH = [(13.4, 5.4), (7.4, 13.1), (11.5, 13.1), (10.5, 18.6), (16.5, 10.9), (12.4, 10.9)]

MARGIN = SIZE * 0.0625
BOX = SIZE * 0.875
RX = BOX * 0.273


def vgrad(top: tuple, bottom: tuple) -> Image.Image:
    """竖向渐变：2 行角图双线性放大。"""
    grad = Image.new("RGB", (1, 2))
    grad.putdata([top, bottom])
    return grad.resize((C, C), Image.BILINEAR).convert("RGBA")


def bolt_pts() -> list:
    def pt(x: float, y: float):
        # 映射到方块内并放大 1.32 倍（图标中心）
        cx, cy = (1.4 + 21.2 / 2), (1.4 + 21.2 / 2)
        px = (x - cx) * 1.32 + 12.0
        py = (y - cy) * 1.32 + 12.0
        return (MARGIN + (px - 1.4) / 21.2 * BOX) * SS, (MARGIN + (py - 1.4) / 21.2 * BOX) * SS
    return [pt(x, y) for x, y in FLASH]


# 1) 深色竖向渐变底
canvas = Image.new("RGBA", (C, C), (0, 0, 0, 0))
canvas.alpha_composite(vgrad(BG_TOP, BG_BOTTOM))

# 2) 圆角方块蒙版（圆角边缘留出背景透明）
mask = Image.new("L", (C, C), 0)
d = ImageDraw.Draw(mask)
m0 = int(MARGIN * SS)
m1 = int((MARGIN + BOX) * SS)
d.rounded_rectangle([m0, m0, m1, m1], radius=int(RX * SS), fill=255)
canvas.putalpha(mask)

# 3) 绿蓝渐变闪电（竖向渐变 + 白色描边）
bolt = Image.new("RGBA", (C, C), (0, 0, 0, 0))
bolt.alpha_composite(vgrad(BOLT_TOP, BOLT_BOTTOM))
bmask = Image.new("L", (C, C), 0)
d2 = ImageDraw.Draw(bmask)
d2.polygon(bolt_pts(), fill=255)
bolt.putalpha(bmask)
canvas.alpha_composite(bolt)

# 4) 描边：闪电白色细边 + 方块边框
draw = ImageDraw.Draw(canvas)
draw.polygon(bolt_pts(), outline=(255, 255, 255, 191), width=max(3, int(0.004 * SIZE * SS)))
d3 = ImageDraw.Draw(canvas)
d3.rounded_rectangle([m0, m0, m1, m1], radius=int(RX * SS), outline=BORDER, width=int(0.01 * SIZE * SS))

canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
canvas.save(OUT, "PNG")
print(f"written {OUT} {SIZE}x{SIZE}")
