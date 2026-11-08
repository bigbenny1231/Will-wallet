#!/usr/bin/env python3
"""Sync shared design assets into the static site. The site itself has no build step;
run this after editing anything in design/ and commit the result.

  python3 design/build_site.py

- copies design/tokens.css and design/pulse.js to site/assets/
- inlines design/seal.svg into site/index.html between <!-- seal --> and <!-- /seal -->
- inlines a second copy of the seal (ids suffixed, so its gradient and clip paths stay its own) between
  <!-- seal2 --> and <!-- /seal2 --> for the pinned clock seal of the vault 17 story (aria-hidden)
- renders a QR code for the phone pulse page (design/qr.js) between <!-- qr --> and <!-- /qr -->

The demo video is committed as site/assets/demo-720p.mp4 (the v3 cut, re-encoded to about 2.8 MB):
  ffmpeg -i docs/video/dmw-demo-v3-720p.mp4 -an -c:v libx264 -preset slow -crf 30 -tune stillimage \
         -pix_fmt yuv420p -movflags +faststart -r 24 site/assets/demo-720p.mp4
"""
import pathlib
import re
import shutil
import subprocess

PULSE_URL = "https://will-wallet.vercel.app/pulse"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DESIGN = ROOT / "design"
SITE = ROOT / "site"


def splice(html: str, name: str, content: str) -> str:
    pat = re.compile(r"(<!-- %s -->)(.*?)(<!-- /%s -->)" % (name, name), re.S)
    if not pat.search(html):
        raise SystemExit(f"marker <!-- {name} --> not found in site/index.html")
    return pat.sub(lambda m: m.group(1) + "\n" + content.strip() + "\n" + m.group(3), html)


def main() -> None:
    (SITE / "assets").mkdir(exist_ok=True)
    shutil.copyfile(DESIGN / "tokens.css", SITE / "assets" / "tokens.css")
    shutil.copyfile(DESIGN / "pulse.js", SITE / "assets" / "pulse.js")

    seal = (DESIGN / "seal.svg").read_text()
    # Second seal for the story: suffix every id and every reference to it.
    ids = re.findall(r'id="([^"]+)"', seal)
    seal2 = seal
    for i in ids:
        seal2 = re.sub(r'(id="|#|url\(#)%s\b' % re.escape(i), lambda m: m.group(1) + i + "-s", seal2)
    seal2 = re.sub(r'role="img" aria-labelledby="[^"]*"', 'aria-hidden="true" focusable="false"', seal2)

    qr = subprocess.run(
        ["node", "-e", "process.stdout.write(require(process.argv[1]).svg(process.argv[2], {label: process.argv[3]}))",
         str(DESIGN / "qr.js"), PULSE_URL, "QR code for " + PULSE_URL],
        check=True, capture_output=True, text=True,
    ).stdout

    index = SITE / "index.html"
    html = index.read_text()
    html = splice(html, "seal", seal)
    html = splice(html, "seal2", seal2)
    html = splice(html, "qr", qr)
    index.write_text(html)

    print("site synced")


if __name__ == "__main__":
    main()
