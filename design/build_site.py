#!/usr/bin/env python3
"""Sync shared design assets into the static site. The site itself has no build step;
run this after editing anything in design/ and commit the result.

  python3 design/build_site.py

- copies design/tokens.css and design/pulse.js to site/assets/
- inlines design/seal.svg into site/index.html between <!-- seal --> and <!-- /seal -->
- pre-renders the pulse strip (via design/pulse.js, using node) between <!-- strip --> and <!-- /strip -->
- copies docs/video/dead-mans-wallet-demo-720p.mp4 to site/assets/demo-720p.mp4 if it exists (gitignored)
"""
import pathlib
import re
import shutil
import subprocess

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
    strip = subprocess.run(
        ["node", "-e", "process.stdout.write(require(process.argv[1]).stripMarkup())", str(DESIGN / "pulse.js")],
        check=True, capture_output=True, text=True,
    ).stdout

    index = SITE / "index.html"
    html = index.read_text()
    html = splice(html, "seal", seal)
    html = splice(html, "strip", strip)
    index.write_text(html)

    video = ROOT / "docs" / "video" / "dead-mans-wallet-demo-720p.mp4"
    if video.exists():
        shutil.copyfile(video, SITE / "assets" / "demo-720p.mp4")
        print("copied demo video to site/assets/demo-720p.mp4 (gitignored)")
    else:
        print("note: docs/video/dead-mans-wallet-demo-720p.mp4 not found; the player will show the poster only")
    print("site synced")


if __name__ == "__main__":
    main()
