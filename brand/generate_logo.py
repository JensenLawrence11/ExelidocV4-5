from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

root = Path(__file__).resolve().parent

# Brand colors
NAVY = (18, 52, 111)
WHITE = (255, 255, 255)
BLUE = (47, 111, 237)


def save_icon(size: int, name: str):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = max(10, int(size * 0.12))
    outer = (pad, pad, size - pad, size - pad)
    inner = (int(size * 0.22), int(size * 0.22), size - int(size * 0.22), size - int(size * 0.22))

    draw.rounded_rectangle(outer, radius=max(12, int(size * 0.18)), fill=NAVY)
    draw.rounded_rectangle(inner, radius=max(10, int(size * 0.15)), fill=WHITE)

    # E-shaped mark
    left = int(size * 0.27)
    right = int(size * 0.73)
    top = int(size * 0.27)
    bottom = int(size * 0.73)

    draw.polygon([(size // 2, int(size * 0.18)), (size - int(size * 0.18), size // 2), (size // 2, size - int(size * 0.18)), (int(size * 0.18), size // 2)], fill=NAVY)
    draw.text((size // 2, size // 2), "E", anchor="mm", fill=WHITE, font=ImageFont.truetype("arial.ttf", max(40, size // 2)))

    img.save(root / name)


save_icon(512, "exelidoc-logo.png")
for size in (16, 32, 64, 128):
    save_icon(size, f"exelidoc-logo-{size}.png")

logo = Image.open(root / "exelidoc-logo.png")
logo.save(root / "exelidoc-logo.ico", format="ICO", sizes=[(16, 16), (32, 32), (64, 64), (128, 128)])

# Also make a small browser-ready copy in the website root
website_root = root.parent / "website"
website_root.mkdir(exist_ok=True)
logo.save(website_root / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (64, 64)])
