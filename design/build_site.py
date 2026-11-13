#!/usr/bin/env python3
"""Sync shared design assets into the static site. The site itself has no build step;
run this after editing anything in design/ and commit the result.

  python3 design/build_site.py

- copies design/tokens.css and design/pulse.js to site/assets/
- inlines design/seal.svg into site/index.html between <!-- seal --> and <!-- /seal -->
- inlines a second copy of the seal (ids suffixed, so its gradient and clip paths stay its own) between
  <!-- seal2 --> and <!-- /seal2 --> for the pinned clock seal of the vault 17 story (aria-hidden)
- renders a QR code for the phone pulse page (design/qr.js) between <!-- qr --> and <!-- /qr -->
- exports the mark (design/logo.svg): inlined between <!-- mark --> markers (nav, footer), site/assets/favicon.svg,
  favicon-32.png, apple-touch-icon.png, and dashboard/public/icons (same file names and sizes as before)

The demo video is committed as site/assets/demo-v4-720p.mp4 (the v4 cut, 2:50, about 5.7 MB) and
site/assets/demo-v4-x-720p.mp4 (2:14, for X): both are copied as they are from the testnet workflow's video output
(docs/video/tools/v4, run 43290509255), with no re-encode. The older re-encode step, from the v3 file, was:
  ffmpeg -i docs/video/dmw-demo-v3-720p.mp4 -an -c:v libx264 -preset slow -crf 30 -tune stillimage \
         -pix_fmt yuv420p -movflags +faststart -r 24 site/assets/demo-v4-720p.mp4
"""
import pathlib
import re
import shutil
import subprocess

PULSE_URL = "https://lastwordvault-app.vercel.app/pulse"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DESIGN = ROOT / "design"
SITE = ROOT / "site"


def splice(html: str, name: str, content: str) -> str:
    pat = re.compile(r"(<!-- %s -->)(.*?)(<!-- /%s -->)" % (name, name), re.S)
    if not pat.search(html):
        raise SystemExit(f"marker <!-- {name} --> not found in site/index.html")
    return pat.sub(lambda m: m.group(1) + "\n" + content.strip() + "\n" + m.group(3), html)


def mark_body(weight: float = 1.0) -> str:
    """The <g> of design/logo.svg. weight scales the strokes: 1 for 16 to 48 px, lighter for large tiles."""
    g = re.search(r"<g\b.*?</g>", (DESIGN / "logo.svg").read_text(), re.S).group(0)
    return re.sub(r'stroke-width="([\d.]+)"', lambda m: 'stroke-width="%g"' % round(float(m.group(1)) * weight, 3), g)


def tile(size: int, scale: float, weight: float, radius: float = 0) -> str:
    """The mark on an ink square, `scale` of the tile wide, centred."""
    k = size * scale / 32
    off = (size - 32 * k) / 2
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" width="{s}" height="{s}">'
            '<rect width="{s}" height="{s}" rx="{r:g}" fill="#0B0C0F"/>'
            '<g transform="translate({o:g} {o:g}) scale({k:g})">{g}</g></svg>\n').format(
                s=size, r=radius, o=round(off, 3), k=round(k, 4), g=mark_body(weight))


def png(svg: str, out: pathlib.Path) -> None:
    subprocess.run(["rsvg-convert", "-o", str(out)], input=svg.encode(), check=True)


def export_mark() -> str:
    assets, icons = SITE / "assets", ROOT / "dashboard" / "public" / "icons"
    (assets / "favicon.svg").write_text(tile(32, 0.9, 1.0, 6))
    png(tile(32, 0.9, 1.0, 6), assets / "favicon-32.png")
    png(tile(180, 0.66, 0.62), assets / "apple-touch-icon.png")
    if icons.is_dir():
        for n in ("apple-touch-icon.png", "favicon.svg", "favicon-32.png"):
            shutil.copyfile(assets / n, icons / n)
        (icons / "seal.svg").write_text(tile(400, 0.7, 0.55))
        png(tile(192, 0.7, 0.6), icons / "seal-192.png")
        png(tile(512, 0.7, 0.5), icons / "seal-512.png")
        png(tile(512, 0.56, 0.5), icons / "seal-maskable-512.png")   # inside the 80% maskable safe zone
    body = re.sub(r"\s*\n\s*", "", mark_body())
    return '<svg class="mark" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' + body + "</svg>"


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
    mark = export_mark()
    html = splice(html, "mark", mark)
    html = splice(html, "mark-foot", mark)
    # cache-busting: styles.css is served with max-age=3600 + stale-while-revalidate, so a
    # phone that has visited before keeps the old stylesheet for up to a day. Version the URL
    # by content hash so every deploy is picked up immediately.
    import hashlib
    css_hash = hashlib.sha1((SITE / "styles.css").read_bytes()).hexdigest()[:8]
    js_hash = hashlib.sha1((SITE / "js" / "main.js").read_bytes()).hexdigest()[:8]
    html = re.sub(r'href="styles\.css(\?v=[0-9a-f]+)?"', f'href="styles.css?v={css_hash}"', html)
    html = re.sub(r'src="js/main\.js(\?v=[0-9a-f]+)?"', f'src="js/main.js?v={js_hash}"', html)
    index.write_text(html)

    print("site synced")


if __name__ == "__main__":
    main()
