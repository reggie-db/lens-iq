#!/usr/bin/env bash
# Synthesize a "foggy lens" partial-fog variant of a clear CCTV clip.
#
# Pipeline (per frame):
#   1. Heavy box blur on the source (boxblur=110:5).
#   2. Mild brightness lift + contrast/saturation drop on the blurred copy
#      to mimic light scattering through condensation.
#   3. Build a radial Gaussian luminance mask centered on the frame
#      (sigma = min(W,H) / 3). The mask is rendered ONCE as a PNG and
#      looped across the video - geq is per-pixel per-frame, so caching
#      drops a 5-minute encode to seconds.
#   4. maskedmerge the original and the blurred copy through the mask so
#      the center is smudged while the edges stay crisp.
#
# The recipe is calibrated against the FogDetector PyFunc thresholds in
# notebooks/deploy_fog_detector.ipynb (PATCH_FOG_PIVOT=1.4,
# PATCH_BRIGHTNESS_FLOOR=80). It pushes the central patches to log10
# Laplacian variance ~1.2-1.4 which reliably trips the detector while
# leaving the periphery untouched.
#
# Usage:
#   scripts/synth_foggy_lens.sh <input.mp4> <output.mp4>
#
# Re-run for the grocery / freezer / cstore / forecourt pairs whenever
# the clear baseline clip changes.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <input.mp4> <output.mp4>" >&2
  exit 2
fi

input="$1"
output="$2"

if [[ ! -f "$input" ]]; then
  echo "input not found: $input" >&2
  exit 1
fi

width=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$input")
height=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$input")
fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$input")
if [[ -z "${width:-}" || -z "${height:-}" ]]; then
  echo "could not read dimensions from $input" >&2
  exit 1
fi
if [[ -z "${fps:-}" ]]; then
  fps="24/1"
fi

# sigma_mask controls the radius of the foggy blob. min(W,H)/3 covers
# roughly the central 4 patches of the 8x6 detector grid without
# bleeding into the corners.
sigma_mask=$(( ( width < height ? width : height ) / 3 ))

mask_dir=$(mktemp -d)
mask_png="$mask_dir/fog_mask.png"
trap 'rm -rf "$mask_dir"' EXIT

echo "synthesizing foggy variant: $input -> $output"
echo "  source ${width}x${height} @ ${fps}, mask sigma ${sigma_mask}px"
echo "  rendering Gaussian mask -> $mask_png"

# Render the static Gaussian mask once. Single-frame geq is fast.
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=black:size=${width}x${height}:d=1,format=yuv420p,geq=lum='255*exp(-(pow(X-W/2,2)+pow(Y-H/2,2))/(2*pow(${sigma_mask},2)))':cb=128:cr=128" \
  -frames:v 1 "$mask_png"

echo "  encoding fogged variant..."

# Use the cached PNG as a looped second input. The -framerate must match
# the source - a default 25fps loop on a 24fps source would otherwise
# produce timestamp jitter that bloats the encoded file by ~10x.
# -shortest cuts off when the source video stream ends.
ffmpeg -y -hide_banner -loglevel error \
  -i "$input" \
  -loop 1 -framerate "$fps" -i "$mask_png" \
  -filter_complex "\
[0:v]format=yuv420p[orig];\
[orig]boxblur=110:5,eq=brightness=0.10:contrast=0.8:saturation=0.8[blur];\
[1:v]format=yuv420p,scale=${width}:${height}[mask];\
[orig][blur][mask]maskedmerge,format=yuv420p[out]" \
  -map "[out]" -map "0:a?" \
  -c:v libx264 -preset medium -crf 26 -tune film \
  -c:a copy \
  -shortest -movflags +faststart \
  "$output"

echo "done: $output"
