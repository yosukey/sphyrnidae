#!/usr/bin/env python3
"""Regenerate the deployed icons from the high-resolution master image.

Source : assets/icon-source/sphyrnidae-icon-master.png
Outputs:
  - icons/icon-512x512.png  (512x512, RGBA)
  - icons/icon-192x192.png  (192x192, RGBA)
  - favicon.ico             (16/24/32/48/64/128/256, RGBA)

The master is simply high-quality downscaled (LANCZOS); no padding or
cropping is applied, so the generated icons keep a full-bleed look.

Usage:
    python3 assets/icon-source/generate-icons.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MASTER = ROOT / "assets" / "icon-source" / "sphyrnidae-icon-master.png"

PNG_TARGETS = [
    (ROOT / "icons" / "icon-512x512.png", 512),
    (ROOT / "icons" / "icon-192x192.png", 192),
]
FAVICON = ROOT / "favicon.ico"
FAVICON_SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    master = Image.open(MASTER).convert("RGBA")
    print(f"master: {MASTER.relative_to(ROOT)} {master.size}")

    for path, size in PNG_TARGETS:
        img = master.resize((size, size), Image.LANCZOS)
        img.save(path, format="PNG")
        print(f"wrote : {path.relative_to(ROOT)} {img.size}")

    # Pillow writes a single ICO container holding every requested size.
    master.save(
        FAVICON,
        format="ICO",
        sizes=[(s, s) for s in FAVICON_SIZES],
    )
    print(f"wrote : {FAVICON.relative_to(ROOT)} {FAVICON_SIZES}")


if __name__ == "__main__":
    main()
