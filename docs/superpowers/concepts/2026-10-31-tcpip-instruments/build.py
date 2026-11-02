"""Build the TCP/IP Instruments concept PDF: inline Inter, print with headless Chrome, render page PNGs to check."""
import base64
import pathlib
import subprocess
import sys

import fitz  # PyMuPDF

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
FONT = ROOT / "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
OUT_PDF = HERE / "TCP-IP Instruments - flow and screens.pdf"

font_b64 = base64.b64encode(FONT.read_bytes()).decode("ascii")
face = ("@font-face { font-family: 'Inter Variable'; font-style: normal; font-display: block; "
        "font-weight: 100 900; src: url(data:font/woff2;base64," + font_b64 + ") format('woff2'); }")
html = (HERE / "source.html").read_text(encoding="utf-8").replace("/*FONT*/", face, 1)
built = HERE / "_build.html"
built.write_text(html, encoding="utf-8")

subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=4000",
                f"--print-to-pdf={OUT_PDF}", built.as_uri()], check=True, capture_output=True, timeout=120)
built.unlink()

doc = fitz.open(OUT_PDF)
shots = HERE / "_pages"
shots.mkdir(exist_ok=True)
for i, page in enumerate(doc, 1):
    page.get_pixmap(dpi=110).save(shots / f"page-{i:02d}.png")
fonts = sorted({f[3] for p in doc for f in p.get_fonts()})
print(f"pages={doc.page_count} size={doc[0].rect.width:.0f}x{doc[0].rect.height:.0f}pt fonts={fonts}")
print(OUT_PDF)
