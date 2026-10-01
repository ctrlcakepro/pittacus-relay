"""Builds every app icon from the 1024px source artwork.

Usage: python scripts/make-icon.py <path/to/icon_1024.png>   (needs Pillow)

The source is a violet rounded square drawn on an opaque white canvas with a
baked-in drop shadow. We cut the square out with an anti-aliased rounded-rect
mask (dropping the white and the shadow), then write:

  build/icon.png        1024px, macOS grid (~80% square + margin) -> .icns
  build/icon.ico        16-256px, tight crop so it fills the Windows taskbar
  resources/icon.png    256px window icon (tight crop)
  resources/tray.png    16px + tray@2x.png 32px (Electron picks @2x on HiDPI)
  src/renderer/src/assets/logo.png   64px, the small sidebar logo
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# Geometry of the square in the 1024px source, measured from the artwork.
LEFT, TOP, RIGHT, BOTTOM = 103, 102, 921, 921
RADIUS = 165
INSET = 1.5  # shave the light rim that blends into the white background
SS = 4  # mask supersampling

ROOT = Path(__file__).resolve().parent.parent


def cut_out(src: Image.Image) -> Image.Image:
    size = src.width * SS
    mask = Image.new("L", (size, size), 0)
    box = [(LEFT + INSET) * SS, (TOP + INSET) * SS, (RIGHT - INSET) * SS, (BOTTOM - INSET) * SS]
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=(RADIUS - INSET) * SS, fill=255)
    mask = mask.resize(src.size, Image.LANCZOS)
    out = src.convert("RGB").convert("RGBA")
    out.putalpha(mask)
    return out


def tight(icon: Image.Image, margin: float) -> Image.Image:
    """Crops to the square plus `margin` (fraction of its side) on every edge."""
    side = RIGHT - LEFT
    pad = side * margin
    cx, cy = (LEFT + RIGHT) / 2, (TOP + BOTTOM) / 2
    half = side / 2 + pad
    return icon.crop((round(cx - half), round(cy - half), round(cx + half), round(cy + half)))


def scaled(img: Image.Image, size: int) -> Image.Image:
    out = img.resize((size, size), Image.LANCZOS)
    # Small sizes lose the thin line art; a light unsharp keeps it readable.
    if size <= 64:
        out = out.filter(ImageFilter.UnsharpMask(radius=0.6, percent=60, threshold=0))
    return out


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    master = cut_out(Image.open(sys.argv[1]))
    if master.size != (1024, 1024):
        sys.exit("expected a 1024x1024 source")
    win = tight(master, 0.02)

    (ROOT / "build").mkdir(exist_ok=True)
    (ROOT / "resources").mkdir(exist_ok=True)
    assets = ROOT / "src/renderer/src/assets"
    assets.mkdir(parents=True, exist_ok=True)

    master.save(ROOT / "build/icon.png", optimize=True)
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [scaled(win, s) for s in ico_sizes]
    frames[-1].save(ROOT / "build/icon.ico", sizes=[(s, s) for s in ico_sizes], append_images=frames[:-1])
    scaled(win, 256).save(ROOT / "resources/icon.png", optimize=True)
    scaled(win, 16).save(ROOT / "resources/tray.png", optimize=True)
    scaled(win, 32).save(ROOT / "resources/tray@2x.png", optimize=True)
    scaled(tight(master, 0), 64).save(assets / "logo.png", optimize=True)
    print("wrote build/icon.png, build/icon.ico, resources/{icon,tray,tray@2x}.png, renderer assets/logo.png")


if __name__ == "__main__":
    main()
