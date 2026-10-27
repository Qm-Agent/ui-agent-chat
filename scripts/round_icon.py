"""修正版：内容铺满圆角矩形内容区后再裁圆角。

上一版直接对整幅画布套遮罩，但内容自身带透明留白，
圆角未切到可见内容（视觉上仍是平角）。本脚本：
1. 取 alpha bbox 裁出可见内容；
2. 拉伸铺满 824x824 内容区（macOS 规范尺寸）；
3. 套 22.37% 半径圆角矩形遮罩后居中回贴 1024 画布。
"""
from PIL import Image, ImageDraw

SRC = "desktop/build/icon.png"

img = Image.open(SRC).convert("RGBA")
w, h = img.size
bbox = img.getchannel("A").getbbox()
print("canvas:", w, h, "content bbox:", bbox)

content = img.crop(bbox)

SIZE = 1024
INNER = 824          # macOS 内容区
RADIUS = round(INNER * 0.2237)
inset = (SIZE - INNER) // 2

filled = content.resize((INNER, INNER), Image.LANCZOS)

# 4x 超采样圆角遮罩
scale = 4
mask_big = Image.new("L", (INNER * scale, INNER * scale), 0)
ImageDraw.Draw(mask_big).rounded_rectangle(
    (0, 0, INNER * scale, INNER * scale), radius=RADIUS * scale, fill=255
)
mask = mask_big.resize((INNER, INNER), Image.LANCZOS)

out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
out.paste(filled, (inset, inset), mask)
out.save(SRC)

# 验证：内容区四角透明（圆角生效）、圆角内侧与中心不透明
pts = {
    "inner-corner-tl": (inset + 8, inset + 8),               # 应透明（被圆角切掉）
    "inner-corner-past-radius": (inset + RADIUS, inset + 8), # 应不透明（圆弧顶部边缘）
    "edge-mid-left": (inset + 4, SIZE // 2),                 # 应不透明（内容铺满到边）
    "center": (SIZE // 2, SIZE // 2),
    "canvas-corner": (2, 2),                                 # 应透明
}
for name, (x, y) in pts.items():
    print(name, out.getpixel((x, y)))
print("done")
