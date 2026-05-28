# Detector calibration notes

Confidence + post-filter knobs for each Roboflow-Universe-backed detector
served via `notebooks/deploy_roboflow_detector.ipynb`. The bundle's
`lensiq_deploy_roboflow_detectors` job (`databricks.yml`) wires these
values into the notebook's task parameters; this file is the engineering
record of *why* each threshold is what it is so we can re-tune without
re-discovering everything from scratch.

The notebook exposes five post-filter widgets:

| Widget                | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `min_confidence`      | Lower bound on Roboflow's per-detection confidence (0..1).     |
| `min_area_pct`        | Drop boxes smaller than this fraction of the frame.            |
| `max_area_pct`        | Drop boxes larger than this fraction of the frame.             |
| `min_y_center_pct`    | Drop boxes whose center sits above this row (0=top, 100=bot).  |
| `max_y_center_pct`    | Drop boxes whose center sits below this row.                   |
| `class_label_override`| Rewrite Roboflow's class string to our endpoint-aligned slug.  |

All thresholds were probed against the actual demo footage via the
Roboflow detect API at `conf=0.01` so we could see the full long tail,
then chosen so the real positives pass and the recurring false positives
fall out.

---

## `lensiq-license-plate` (samrat-sahoo/license-plates-f8vsn/5)

No post-filter knobs applied. The model is tight enough on the candidate
plate clips that the in-app `OCR_VEHICLE_LABELS` gate and Claude's vision
follow-up handle the rest.

---

## `lensiq-spill` (universe/spills-ax5xv/2)

Backed by `spills-ax5xv/2`, which actually fires on the canonical
aisle-spill-then-cone CCTV clip. The previous model
(`zan-compute/dial-wet-floor-segmentation/1`) returned 0 detections on
every demo frame at any confidence.

Calibration probed at `conf=0.01` against frames at 2s, 5s, 12s, 20s
plus negative grocery and forecourt frames:

| Signal                       | conf       | area  | y_center |
| ---------------------------- | ---------- | ----- | -------- |
| REAL spill (aisle floor)     | 0.05-0.09  | 0.1%  | 77%      |
| FP right-shelf shadow        | 0.02-0.07  | 29%   | 54%      |
| FP bottom-edge slivers       | 0.01-0.03  | 0.2%  | 99%      |
| FP forecourt asphalt         | 0.32       | 1.5%  | 58%      |
| FP produce-aisle shelf       | 0.07       | 4.8%  | 59%      |

Filter chain that keeps the real spill and rejects every probed FP:

- `min_confidence=0.04` keeps real (>=0.05), rejects edge slivers
- `min_area_pct=0.05` rejects micro-detections
- `max_area_pct=2.0` rejects shelf shadows + produce-aisle FP
- `min_y_center_pct=65.0` / `max_y_center_pct=95.0` rejects shelf,
  ceiling, and asphalt FPs as well as the bottom slivers

Upstream class label `Spill` is renamed to lowercase `spill` so the
AppKit chart tinting matches the endpoint slug.

---

## `lensiq-wet-floor-sign` (frc-5881/wet-floor-nhjwl/1)

Whose only class is the generic label `sign`. Tested clean across the
candidate aisle clip (cone correctly fires at conf 0.83-0.87 only after
deployment, no pre-deployment FPs) and unrelated c-store / forecourt
CCTV (0 detections).

Filter knobs:

- `min_confidence=0.50` cuts the long tail
- `min_area_pct=0.3` floor
- `max_area_pct=8.0` kills hallucinated frame-spanning boxes
- `min_y_center_pct=40.0` rejects ceiling / shelf signage
- `class_label_override=wet_floor_sign` rewrites `sign` so the slug
  matches the endpoint name

---

## `lensiq-cigarette-vape` (train-qjr0z/cigarette-vape-detection-lagrc-4ypjd/3)

No post-filter knobs; the upstream model is already conservative on the
candidate clips.

---

## `lensiq-slip-fall` (sensormatic/slip-and-fall/1)

No post-filter knobs. Re-probe before adding any: the candidate clips
were short and the model's behavior on c-store / forecourt footage has
not been characterized as thoroughly as spill/cone.
