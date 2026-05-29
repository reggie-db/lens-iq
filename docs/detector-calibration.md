# Detector calibration notes

Confidence + post-filter knobs for each detector served by this app.

Most detectors (license-plate, cigarette/vape, slip-fall) are
Roboflow-Universe models hosted via `notebooks/deploy_roboflow_detector.ipynb`.
The bundle's `lensiq_deploy_roboflow_detectors` job (`databricks.yml`)
wires per-model thresholds into the notebook's task parameters; this
file is the engineering record of *why* each threshold is what it is
so we can re-tune without re-discovering everything from scratch.

Spill + wet-floor-sign are the exception - they run through a single
Claude vision call on the shared `llm` alias instead of a Roboflow
PyFunc (see the "Spill + wet-floor-sign" section below).

The Roboflow notebook exposes five post-filter widgets:

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

## Spill + wet-floor-sign (Claude vision, no Roboflow endpoint)

Both `spill` and `wet_floor_sign` no longer have a dedicated Roboflow
PyFunc. They run through a single Databricks-hosted Claude vision
call on the shared `llm` alias via `server/vision-detector.ts`.

Why we moved off Roboflow for these two:

| Candidate (Roboflow)              | Behavior on canonical aisle clip                       |
| --------------------------------- | ------------------------------------------------------ |
| `universe/spills-ax5xv/2`         | Top conf=0.18 on back-of-aisle wall, real spill missed |
| `slipp/spillsyolov5/1`            | Wrong classes (`floor`, `person`, `shopping-cart`)     |
| `iiy/spills/1`                    | Saw the wet patch but only at conf 0.02-0.06; required |
|                                   | aggressive geometric filters that broke on other clips |
| `santosh-x1puv/liq/1`             | 14-19 noisy preds/frame, top hits on mid-frame walls   |
| `app-ks258/protect-ysvvb/1`       | Wrong classes (PPE / fall / fire)                      |
| `latifa-rdsiv/chemical-spills_/1` | Mostly bottom-edge slivers                             |
| `frc-5881/wet-floor-nhjwl/1`      | 0.83 cone on hosted API, ZERO via on-host SDK          |
| `safety-cones-vfrj2/2`            | Fired cones reliably but also lit up on shelf labels,  |
|                                   | distant signage, and shopper PPE                       |

The custom-CV spike (darkness + contrast + texture filters in
`/tmp/spill_probe/cv_spill_detector*.py`) couldn't separate the wet
patch from shadows, shoes, or shelf edges either.

What works: ask a foundation vision model to "find any wet floor
spills or caution cones in this image" and return labelled boxes.
Claude on `databricks-claude-*` reliably surfaces both, calibrated
0-1 confidences, and one call per frame covers both classes because
`vision-detector.ts` is label-generic and the route asks for the full
`["spill", "cone"]` set.

Calibration knobs that survived the move:

- `min_confidence`: defaults `0.30` (spill) and `0.50` (cone), live
  on the SpillFeed sliders. Claude's confidences are calibrated, so
  `> 0.5` on cones reliably filters the residual shelf/sign false
  positives without losing the real CAUTION cone.
- `promptAddendum`: optional second-half-of-prompt hook on
  `detectWithClaude` for scene-specific guidance. Empty for spill/cone
  on the current footage; reach for it before tightening the labels
  list if a new clip needs help.
- Image hash LRU cache (256 entries, 10 min TTL) makes the two
  parallel `/api/detect` calls per tick share one Claude round-trip
  and lets the looping canonical clip resolve in microseconds after
  the first pass populates the cache.

No bundle deployment is required for these two detectors. If a stale
workspace still has the old `lensiq-spill` / `lensiq-wet-floor-sign`
endpoints, delete them with `databricks serving-endpoints delete <name>`.

---

## `lensiq-cigarette-vape` (train-qjr0z/cigarette-vape-detection-lagrc-4ypjd/3)

No post-filter knobs; the upstream model is already conservative on the
candidate clips.

---

## `lensiq-slip-fall` (sensormatic/slip-and-fall/1)

No post-filter knobs. Re-probe before adding any: the candidate clips
were short and the model's behavior on c-store / forecourt footage has
not been characterized as thoroughly as spill/cone.
