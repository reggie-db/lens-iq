#!/usr/bin/env bash
# Turn a clean stock clip into security-camera-style footage.
#
# Stock food b-roll is bright, saturated, and shallow-DOF - nothing like
# a fixed surveillance cam. This pipeline degrades it to read as CCTV so
# the YOLO model-serving demo (notebooks/deploy_yolo.ipynb) runs on
# plausible "pizza on a counter" surveillance frames while the COCO
# `pizza` class still fires cleanly.
#
# Pipeline (per frame):
#   1. fps=12               choppy fixed-cam cadence (not 24/30 cinema)
#   2. scale+pad -> 1280x720  normalize to the other sample-videos
#   3. eq                   drop saturation, lift contrast, pull gamma
#                           toward the washed look of a cheap sensor
#   4. gblur sigma=0.5      soft cheap-lens focus
#   5. noise                per-frame sensor grain
#   6. vignette             lens falloff at the corners
#   7. overlay              burnt-in clock + "CAM NN" label + blinking
#                           REC dot, composited from a per-second PNG
#                           track (the giveaways that read as CCTV)
#
# This ffmpeg build has no freetype, so drawtext is unavailable; the HUD
# is rendered with Pillow instead. A surveillance clock only ticks once
# per second, so we render one transparent 1280x720 PNG per whole second
# and hold each for 1s (-framerate 1) before overlaying. The clock runs
# off a base epoch so it advances one wall-second per video-second.
#
# --light drops the grain and lens blur (steps 4-5) and encodes at a
# higher quality. Use it for overhead / wide sources where the subjects
# are small in frame: on a top-down drive-through lane the full-strength
# grain wipes out cars entirely (measured: 5 cars detected on the clean
# frame, 0 after the default degrade). The HUD, desaturation, and
# vignette are what read as "surveillance", so light mode keeps those.
#
# Usage:
#   scripts/synth_cctv_look.sh [--light] <input.mp4> <output.mp4> [cam_label] [base_epoch]
#
# Defaults: cam_label="CAM 03  FRONT COUNTER", base_epoch=1717243200
# (2024-06-01 12:00:00 UTC). Pass a per-clip epoch to stagger timestamps.

set -euo pipefail

light=0
if [[ "${1:-}" == "--light" ]]; then
  light=1
  shift
fi

if [[ $# -lt 2 ]]; then
  echo "usage: $0 [--light] <input.mp4> <output.mp4> [cam_label] [base_epoch]" >&2
  exit 2
fi

input="$1"
output="$2"
cam_label="${3:-CAM 03  FRONT COUNTER}"
base_epoch="${4:-1717243200}"

if [[ ! -f "$input" ]]; then
  echo "input not found: $input" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")/.." && pwd)"

# The HUD track needs Pillow. Prefer the project venv, but only if it can
# actually import PIL - a venv copied between checkouts keeps an executable
# `bin/python` shim whose interpreter path no longer resolves, which would
# fail the whole render several ffmpeg-minutes in.
python_bin=""
for candidate in "$here/.venv/bin/python" python3; do
  if "$candidate" -c "import PIL" >/dev/null 2>&1; then
    python_bin="$candidate"
    break
  fi
done
if [[ -z "$python_bin" ]]; then
  echo "no python with Pillow found (tried $here/.venv/bin/python, python3)" >&2
  echo "install it with: python3 -m pip install pillow" >&2
  exit 1
fi

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$input")
# One overlay frame per whole second, inclusive of the final partial one.
seconds=$(python3 -c "import math,sys; print(int(math.ceil(float(sys.argv[1])))+1)" "$dur")

hud_dir=$(mktemp -d)
trap 'rm -rf "$hud_dir"' EXIT

echo "cctv-ify: $input -> $output"
echo "  label='${cam_label}' base_epoch=${base_epoch} dur=${dur}s frames=${seconds} light=${light}"

# Render the per-second HUD PNGs (transparent, 1280x720).
"$python_bin" - "$hud_dir" "$cam_label" "$base_epoch" "$seconds" <<'PY'
import sys, time
from PIL import Image, ImageDraw, ImageFont

hud_dir, cam_label, base_epoch, seconds = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
W, H = 1280, 720
font_path = "/System/Library/Fonts/Supplemental/Courier New.ttf"
font = ImageFont.truetype(font_path, 26)

def boxed(draw, xy, text, fill="white"):
    x, y = xy
    l, t, r, b = draw.textbbox((x, y), text, font=font)
    draw.rectangle((l - 6, t - 4, r + 6, b + 4), fill=(0, 0, 0, 110))
    draw.text((x, y), text, font=font, fill=fill)

for s in range(seconds):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(base_epoch + s))
    boxed(d, (18, 16), cam_label)                 # top-left camera label
    boxed(d, (18, H - 44), stamp)                 # bottom-left running clock
    if s % 2 == 0:                                # blinking REC dot
        boxed(d, (W - 92, 16), "● REC", fill=(255, 60, 60))
    img.save(f"{hud_dir}/hud-{s:04d}.png")
PY

if (( light )); then
  # Small subjects: keep the cadence/colour cues, skip blur + grain.
  fps=15
  degrade="eq=saturation=0.68:contrast=1.06:brightness=-0.01:gamma=0.97,vignette=PI/7"
  crf=26
else
  fps=12
  degrade="eq=saturation=0.55:contrast=1.12:brightness=-0.03:gamma=0.94,gblur=sigma=0.5,noise=alls=14:allf=t+u,vignette=PI/5"
  crf=23
fi

# Degrade the source, then overlay the 1-fps HUD track on top.
ffmpeg -y -hide_banner -loglevel error \
  -i "$input" \
  -framerate 1 -i "$hud_dir/hud-%04d.png" \
  -filter_complex "\
[0:v]fps=${fps},\
scale=1280:720:force_original_aspect_ratio=decrease,\
pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,\
${degrade}[bg];\
[bg][1:v]overlay=0:0:shortest=1[out]" \
  -map "[out]" -an \
  -c:v libx264 -pix_fmt yuv420p -crf "${crf}" -preset medium \
  -movflags +faststart \
  "$output"

echo "  done: $(ls -la "$output" | awk '{print $5}') bytes"
