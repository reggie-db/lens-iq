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

## `lensiq-spill` (iiy/spills/1)

Switched here from `universe/spills-ax5xv/2`. The previous model's
"REAL spill" signal documented below ended up unreliable in practice
the long-tail predictions were mostly back-wall shadows and the actual
wet patch on the floor was rarely the highest-confidence detection,
so any sensible filter chain either let FPs through or rejected the
real spill. Re-probed six candidates side-by-side against frames at
5/10/15/20/25/30s of the canonical clip:

| Candidate                       | Behavior                                                |
| ------------------------------- | ------------------------------------------------------- |
| `universe/spills-ax5xv/2` (old) | Top conf=0.18 on back-of-aisle wall, real spill missed  |
| `slipp/spillsyolov5/1`          | Wrong classes (`floor`, `person`, `shopping-cart`)      |
| `iiy/spills/1`                  | Reliable floor-region hits at y=77-96%, conf saturated  |
| `santosh-x1puv/liq/1`           | 14-19 noisy preds/frame, top hits on mid-frame walls    |
| `app-ks258/protect-ysvvb/1`     | Wrong classes (PPE / fall / fire)                       |
| `latifa-rdsiv/chemical-spills_/1` | Mostly bottom-edge slivers                            |

`iiy/spills/1` is the winner: it's a single-class spill model whose
predictions saturate at conf=1.0 (so confidence is uninformative), but
its bbox geometry reliably tracks the floor area. We delegate gating
entirely to the geometric post-filters:

- `min_confidence=0.50` floor on the SDK call - cheap NMS gate, since
  every survivor comes back at 1.0 anyway.
- `min_area_pct=0.05` drops micro-specks.
- `max_area_pct=3.0` rejects the model's "back wall / aisle" hallucinations
  (those span 20-30% of the frame).
- `min_y_center_pct=70.0` strips ceiling and mid-shelf FPs.
- `max_y_center_pct=95.0` cuts the bottom-edge sliver FPs that several
  candidates also emit (they cluster at y=96-99%).

Upstream class `spill` is preserved via `class_label_override=spill`
so the AppKit chart tinting matches the endpoint slug.

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
