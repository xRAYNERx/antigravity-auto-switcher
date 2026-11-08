from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "shots")
OUT = os.path.join(ROOT, "docs")

THEMES = [
    ("dracula", "Dracula", "#282A36", "#F8F8F2", "#BD93F9"),
    ("default-dark", "Default Dark", "#101010", "#CCCCCC", "#007ACC"),
    ("catppuccin", "Catppuccin", "#24273A", "#CAD3F5", "#C6A0F6"),
    ("solarized-light", "Solarized Light", "#FAF4E5", "#435155", "#CB4B16"),
]

FONT = r"C:\Windows\Fonts\segoeui.ttf"
FONTB = r"C:\Windows\Fonts\segoeuib.ttf"


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONTB if bold else FONT, size)
    except Exception:
        return ImageFont.load_default()


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def crop_panel(img):
    # panel sits at (26,24) css, scale 2 => (52,48); card 460 wide
    return img.crop((36, 30, 1010, 830))


def crop_pill(img):
    return img.crop((36, 30, 700, 128))


cells = []
for key, label, bg, fg, primary in THEMES:
    panel = crop_panel(Image.open(os.path.join(SHOTS, f"panel_{key}.png")).convert("RGB"))
    pill = crop_pill(Image.open(os.path.join(SHOTS, f"pill_{key}.png")).convert("RGB"))

    pad = 26
    head = 64
    gap = 16
    w = panel.width + pad * 2
    h = head + panel.height + gap + pill.height + pad
    cell = Image.new("RGB", (w, h), hexrgb(bg))
    d = ImageDraw.Draw(cell)

    d.ellipse((pad, 24, pad + 14, 38), fill=hexrgb(primary))
    d.text((pad + 24, 12), label, font=font(28, True), fill=hexrgb(fg))

    cell.paste(panel, (pad, head))
    cell.paste(pill, (pad, head + panel.height + gap))
    cells.append(cell)

cols, rows = 2, 2
gap_x = 28
pad = 34
cw = max(c.width for c in cells)
ch = max(c.height for c in cells)
W = pad * 2 + cw * cols + gap_x * (cols - 1)
H = pad * 2 + ch * rows + gap_x * (rows - 1)
canvas = Image.new("RGB", (W, H), (16, 17, 22))

for i, cell in enumerate(cells):
    x = pad + (i % cols) * (cw + gap_x)
    y = pad + (i // cols) * (ch + gap_x)
    canvas.paste(cell, (x, y))

scale = 0.62
canvas = canvas.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
canvas.save(os.path.join(OUT, "panel-themes.png"), optimize=True)
print("panel-themes.png", canvas.size)
