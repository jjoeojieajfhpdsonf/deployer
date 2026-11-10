"""PNG-Bilder zu einem GIF zusammensetzen (für menu-motion.ts).

    python3 frames-to-gif.py <ziel.gif> '<json: Bildpfade>' '<json: Dauer je Bild in ms>'

Gleiche Palette für alle Bilder (aus dem ersten offenen Bild), damit Flächen
zwischen den Bildern nicht flimmern; doppelte Bilder werden zusammengelegt.
"""
import json
import sys

from PIL import Image, ImageChops

out, files, durations = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
frames = [Image.open(f).convert("RGB") for f in files]
# Palette aus dem Bild mit den meisten Farben (offenes Menü)
ref = max(frames, key=lambda im: len(im.getcolors(1 << 20) or []))
pal = ref.quantize(colors=255, method=Image.Quantize.MEDIANCUT)

merged, times = [], []
for im, ms in zip(frames, durations):
    if merged and ImageChops.difference(im, merged[-1]).getbbox() is None:
        times[-1] += ms
        continue
    merged.append(im)
    times.append(ms)

q = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in merged]
q[0].save(out, save_all=True, append_images=q[1:], duration=times, loop=0, optimize=False, disposal=1)
