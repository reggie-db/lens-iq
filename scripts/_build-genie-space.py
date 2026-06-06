"""Generate resources/genie_space_lensiq_detections.json from a structured spec.

Genie space JSON has strict validation rules:

  - IDs are 32-char lowercase hex (UUID without hyphens).
  - `data_sources.tables` must be sorted alphabetically by `identifier`.
  - `column_configs` within each table must be sorted alphabetically by `column_name`.
  - `config.sample_questions`, `instructions.text_instructions`,
    `instructions.example_question_sqls` must each be sorted by `id`.
  - `description` / `content` / `sql` are arrays of strings.
  - At most 1 text_instruction per space.

See https://learn.microsoft.com/en-us/azure/databricks/genie/conversation-api
for the full schema.

Run me with:
    python3 scripts/_build-genie-space.py
to regenerate the JSON. The deploy script (scripts/deploy.sh, step 6) reads the
generated JSON and pushes it via `databricks genie update-space` /
`create-space`.
"""

import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_OUT_PATH = _REPO_ROOT / "resources" / "genie_space_lensiq_detections.json"
_CATALOG = "retail_consumer_goods"
_SCHEMA = "lens_iq"


def _hex_id(prefix: str, n: int) -> str:
    """Build a deterministic 32-char lowercase hex ID. `prefix` is one char
    (1 = sample question, 2 = text instruction, 3 = example sql). `n` is a
    sequence number; IDs sort alphabetically by (prefix, n) so the order of
    insertion here is the order the Genie API sees them."""
    return f"{prefix}{n:031x}"


_GENERAL_INSTRUCTIONS = [
    "You are the LensIQ Operations analyst for an 8-store fleet of QSR / convenience-store / gas-station locations. ",
    "Every table in this space is produced by computer-vision pipelines (per-frame YOLO + Claude vision detectors) ",
    f"or by the LensIQ app's live write-backs. Tables live in `{_CATALOG}.{_SCHEMA}`. ",
    "Domain primer: ",
    "(1) The fleet is fixed at 8 stores. `stores.id` follows the pattern S-<city3>-<NNN> (e.g. S-ATL-001). ",
    "Always join on `store_id` and surface `stores.name` to the user instead of raw ids. ",
    "(2) Detections carry one of five labels: `vehicle` (drive-thru / forecourt cars), `truck` (forecourt or delivery), ",
    "`person` (guests + staff), `pizza` (in-store hot-hold), `package` (curbside / delivery pickups). ",
    "When a user asks about traffic, default to label='vehicle'. When they ask about guests, default to label='person'. ",
    "(3) All timestamps are UTC. 'This week' = last 7 days. 'Today' = last 24 hours. 'Right now' = last 15 minutes. ",
    "(4) `confidence` is 0.0 to 1.0 (display as percent rounded to 0 decimals). ",
    "Filter out detections with confidence < 0.5 for executive answers unless the user asks otherwise. ",
    "(5) `severity` on alerts is one of `critical`, `warning`, `info`. Treat `critical` as P1. ",
    "(6) `inventory.item` is either `pizza` (% of hot-hold capacity stocked; lower = problem) or `truck_parking` (% of lot occupied). ",
    "(7) `device_readings.temperature` is degrees Fahrenheit. Refrigeration goes critical above 90F. ",
    "(8) Live write-back tables (`guest_counts`, `plate_reads`, `fog_observations`, `spill_cycles`, `face_matches`) ",
    "are produced by the LensIQ AppKit app every time someone runs the booth demo. They land in this catalog ",
    "within ~2 seconds of the click in the UI, so 'recent' rows reflect live demo activity. Seeded baseline data ",
    "is pre-loaded so questions return useful results even before the booth opens. ",
    "Answer rules: ",
    "(a) Always join detection / alert / plate / camera tables to `stores` so the response carries human-readable store names. ",
    "(b) Prefer GROUP BY rollups + ORDER BY ... LIMIT for executive answers; only return raw rows when the user asks for a list. ",
    "(c) For 'over time' questions, bucket by hour (`DATE_TRUNC('hour', ts)`) for windows <= 3 days and by day otherwise. ",
    "(d) When the answer is a single number, also report the comparison vs the prior equal-length window. ",
    "(e) If the user mentions 'my fleet' or 'the chain' without a store filter, aggregate across all 8 stores. ",
    "(f) Use `pipeline_frames` for end-to-end CV throughput when it has rows; use `detections` for analytics on what was seen.",
]

# Each entry: (question, optional list of follow-up reasonings).
_SAMPLE_QUESTIONS: list[str] = [
    "How many cars came through the drive-thru today, per store, vs yesterday?",
    "What's the pump-to-store conversion rate this week (cars on forecourt vs guests entering the store)?",
    "What's the busiest hour of the day across the fleet, measured by vehicle detections in the last 7 days?",
    "What was our average spill -> cone response time in the last 24 hours, and which store was slowest?",
    "Which states do our drive-thru customers come from, this week vs last week?",
    "Show me license plates that appeared at more than one store in the last 7 days.",
    "Which store generated the most critical alerts this week, and what were the top 3 rules that fired?",
    "What is each store's camera uptime in the last 24 hours, ranked worst to best?",
    "Which cameras spent the most time fogged or obscured in the last 24 hours?",
    "Which stores had banned-person face matches in the last week, and at what times?",
    "Which refrigeration units are running hot? Show any device that's been above 80F for more than 2 hours in the last day.",
    "How often did pizza stock drop below 25% in the last 24 hours, by store?",
    "What's the average truck-parking fill percentage by hour of day across all stores in the last 12 hours?",
    "What's the detection mix (label share) across the fleet today?",
    "Which detection label has the lowest average confidence in the last 24 hours? This tells us where the model is struggling.",
    "Give me a single-table ranking of every store this week with: vehicle detections, person detections, alerts, plates captured, and average camera uptime.",
]

# Each entry: (question_text, sql_text). Multi-line SQL is split on newlines so
# Genie's renderer can format it.
_EXAMPLE_SQLS: list[tuple[str, str]] = [
    (
        "Vehicle detections per store: today vs yesterday",
        """WITH today AS (
  SELECT d.store_id, COUNT(*) AS detections
  FROM retail_consumer_goods.lens_iq.detections d
  WHERE d.label = 'vehicle' AND d.ts >= NOW() - INTERVAL 24 HOURS
  GROUP BY d.store_id
),
yesterday AS (
  SELECT d.store_id, COUNT(*) AS detections
  FROM retail_consumer_goods.lens_iq.detections d
  WHERE d.label = 'vehicle'
    AND d.ts >= NOW() - INTERVAL 48 HOURS
    AND d.ts <  NOW() - INTERVAL 24 HOURS
  GROUP BY d.store_id
)
SELECT
  s.name AS store,
  COALESCE(t.detections, 0) AS detections_today,
  COALESCE(y.detections, 0) AS detections_yesterday,
  COALESCE(t.detections, 0) - COALESCE(y.detections, 0) AS delta
FROM retail_consumer_goods.lens_iq.stores s
LEFT JOIN today t     ON t.store_id = s.id
LEFT JOIN yesterday y ON y.store_id = s.id
ORDER BY detections_today DESC""",
    ),
    (
        "Busiest hour of day across the fleet (vehicle detections, last 7 days)",
        """SELECT
  HOUR(d.ts) AS hour_of_day,
  COUNT(*)   AS vehicle_detections
FROM retail_consumer_goods.lens_iq.detections d
WHERE d.label = 'vehicle'
  AND d.ts >= NOW() - INTERVAL 7 DAYS
GROUP BY HOUR(d.ts)
ORDER BY hour_of_day""",
    ),
    (
        "Pump-to-store conversion rate this week",
        """WITH metrics AS (
  SELECT
    d.store_id,
    COUNT_IF(d.label = 'vehicle') AS vehicles,
    COUNT_IF(d.label = 'person')  AS persons
  FROM retail_consumer_goods.lens_iq.detections d
  WHERE d.ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY d.store_id
)
SELECT
  s.name      AS store,
  m.vehicles,
  m.persons,
  ROUND(m.persons / NULLIF(m.vehicles, 0) * 100, 1) AS pump_to_store_pct
FROM metrics m
JOIN retail_consumer_goods.lens_iq.stores s ON s.id = m.store_id
ORDER BY pump_to_store_pct DESC""",
    ),
    (
        "Average spill -> cone response time and slowest store, last 24 hours",
        """SELECT
  s.name AS store,
  COUNT(*) AS spill_cycles,
  ROUND(AVG(c.response_ms) / 1000.0, 1) AS avg_response_seconds,
  ROUND(MAX(c.response_ms) / 1000.0, 1) AS slowest_seconds
FROM retail_consumer_goods.lens_iq.spill_cycles c
LEFT JOIN retail_consumer_goods.lens_iq.stores s ON s.id = c.store_id
WHERE c.ts >= NOW() - INTERVAL 24 HOURS
GROUP BY s.name
ORDER BY avg_response_seconds DESC""",
    ),
    (
        "Plate captures by state, this week vs last week",
        """WITH this_week AS (
  SELECT state, COUNT(*) AS plates
  FROM retail_consumer_goods.lens_iq.license_plates
  WHERE ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY state
),
last_week AS (
  SELECT state, COUNT(*) AS plates
  FROM retail_consumer_goods.lens_iq.license_plates
  WHERE ts >= NOW() - INTERVAL 14 DAYS AND ts < NOW() - INTERVAL 7 DAYS
  GROUP BY state
)
SELECT
  COALESCE(t.state, l.state) AS state,
  COALESCE(t.plates, 0)      AS this_week,
  COALESCE(l.plates, 0)      AS last_week,
  COALESCE(t.plates, 0) - COALESCE(l.plates, 0) AS delta
FROM this_week t
FULL OUTER JOIN last_week l ON t.state = l.state
ORDER BY this_week DESC""",
    ),
    (
        "Plates seen at multiple stores in the last 7 days",
        """SELECT
  plate_masked,
  COUNT(DISTINCT store_id) AS stores_visited,
  COUNT(*)                 AS total_captures,
  COLLECT_SET(store_id)    AS store_ids
FROM retail_consumer_goods.lens_iq.license_plates
WHERE ts >= NOW() - INTERVAL 7 DAYS
GROUP BY plate_masked
HAVING stores_visited > 1
ORDER BY stores_visited DESC, total_captures DESC""",
    ),
    (
        "Top firing rules at the store with the most critical alerts this week",
        """WITH worst AS (
  SELECT store_id, COUNT(*) AS critical_count
  FROM retail_consumer_goods.lens_iq.alerts
  WHERE severity = 'critical' AND ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY store_id
  ORDER BY critical_count DESC
  LIMIT 1
)
SELECT
  s.name AS store,
  a.rule_id,
  COUNT(*) AS fires
FROM retail_consumer_goods.lens_iq.alerts a
JOIN retail_consumer_goods.lens_iq.stores s ON s.id = a.store_id
JOIN worst w ON w.store_id = a.store_id
WHERE a.severity = 'critical' AND a.ts >= NOW() - INTERVAL 7 DAYS
GROUP BY s.name, a.rule_id
ORDER BY fires DESC
LIMIT 3""",
    ),
    (
        "Camera uptime per store, last 24 hours, ranked worst to best",
        """SELECT
  s.name                                AS store,
  ROUND(AVG(CASE WHEN c.online THEN 100.0 ELSE 0.0 END), 1) AS uptime_pct,
  COUNT(*)                              AS samples
FROM retail_consumer_goods.lens_iq.camera_status c
JOIN retail_consumer_goods.lens_iq.stores s ON s.id = c.store_id
WHERE c.ts >= NOW() - INTERVAL 24 HOURS
GROUP BY s.name
ORDER BY uptime_pct ASC""",
    ),
    (
        "Cameras spending the most time fogged in the last 24 hours",
        """SELECT
  s.name                          AS store,
  f.camera_label,
  ROUND(AVG(f.area_pct), 1)       AS avg_fogged_area_pct,
  COUNT_IF(f.fogged)              AS fogged_ticks,
  COUNT(*)                        AS total_ticks,
  ROUND(100.0 * COUNT_IF(f.fogged) / COUNT(*), 1) AS pct_of_time_fogged
FROM retail_consumer_goods.lens_iq.fog_observations f
LEFT JOIN retail_consumer_goods.lens_iq.stores s ON s.id = f.store_id
WHERE f.ts >= NOW() - INTERVAL 24 HOURS
GROUP BY s.name, f.camera_label
ORDER BY pct_of_time_fogged DESC""",
    ),
    (
        "Banned-person matches in the last 7 days",
        """SELECT
  s.name AS store,
  fm.ts,
  fm.name AS person,
  fm.role,
  ROUND(fm.similarity, 3) AS similarity
FROM retail_consumer_goods.lens_iq.face_matches fm
LEFT JOIN retail_consumer_goods.lens_iq.stores s ON s.id = fm.store_id
WHERE fm.role = 'banned' AND fm.ts >= NOW() - INTERVAL 7 DAYS
ORDER BY fm.ts DESC""",
    ),
    (
        "Refrigeration units that ran hot in the last 24 hours",
        """SELECT
  d.id        AS device,
  d.name      AS device_name,
  d.location,
  ROUND(AVG(r.temperature), 1) AS avg_temp_f,
  ROUND(MAX(r.temperature), 1) AS peak_temp_f,
  COUNT_IF(r.temperature > 80) AS hot_hours
FROM retail_consumer_goods.lens_iq.devices d
JOIN retail_consumer_goods.lens_iq.device_readings r ON r.device_id = d.id
WHERE r.ts >= NOW() - INTERVAL 24 HOURS
GROUP BY d.id, d.name, d.location
HAVING hot_hours >= 2
ORDER BY peak_temp_f DESC""",
    ),
    (
        "Single-table fleet ranking this week",
        """WITH dets AS (
  SELECT store_id,
         COUNT_IF(label = 'vehicle') AS vehicles,
         COUNT_IF(label = 'person')  AS persons
  FROM retail_consumer_goods.lens_iq.detections
  WHERE ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY store_id
),
plates AS (
  SELECT store_id, COUNT(*) AS plates
  FROM retail_consumer_goods.lens_iq.license_plates
  WHERE ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY store_id
),
alerts_w AS (
  SELECT store_id, COUNT(*) AS alerts
  FROM retail_consumer_goods.lens_iq.alerts
  WHERE ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY store_id
),
uptime AS (
  SELECT store_id, ROUND(AVG(CASE WHEN online THEN 100.0 ELSE 0.0 END), 1) AS camera_uptime_pct
  FROM retail_consumer_goods.lens_iq.camera_status
  WHERE ts >= NOW() - INTERVAL 7 DAYS
  GROUP BY store_id
)
SELECT
  s.name AS store,
  COALESCE(dets.vehicles, 0)   AS vehicle_detections,
  COALESCE(dets.persons,  0)   AS person_detections,
  COALESCE(plates.plates, 0)   AS plates_captured,
  COALESCE(alerts_w.alerts, 0) AS alerts,
  COALESCE(uptime.camera_uptime_pct, 0) AS camera_uptime_pct
FROM retail_consumer_goods.lens_iq.stores s
LEFT JOIN dets      ON dets.store_id     = s.id
LEFT JOIN plates    ON plates.store_id   = s.id
LEFT JOIN alerts_w  ON alerts_w.store_id = s.id
LEFT JOIN uptime    ON uptime.store_id   = s.id
ORDER BY vehicle_detections DESC""",
    ),
]

# Table spec: identifier -> (table_description, {column_name: column_description}).
# All tables live under retail_consumer_goods.lens_iq. Column dicts are
# unordered here; the generator sorts them by name as Genie requires.
_TABLES: dict[str, tuple[str, dict[str, str]]] = {
    "stores": (
        "The 8 fixed LensIQ store locations. Join target for every other table - always surface stores.name instead of raw store_id in answers.",
        {
            "id": "Store identifier with the pattern S-<city3>-<NNN>, e.g. S-ATL-001. Foreign key for store_id in every other table.",
            "name": "Human-readable store name. Use this in answers.",
            "location": "City, state of the store.",
            "lat": "Store latitude (decimal degrees).",
            "lng": "Store longitude (decimal degrees).",
        },
    ),
    "detections": (
        "Per-frame YOLO detections from every camera in the fleet. One row per detected object. Use label='vehicle' for traffic, label='person' for guests, label='truck' for delivery / forecourt trucks, label='pizza' for hot-hold, label='package' for curbside pickup. Confidence is 0-1.",
        {
            "id": "Unique detection id.",
            "frame_id": "Source video frame the detection came from.",
            "ts": "UTC timestamp when the detection was emitted.",
            "store_id": "Store where the detection was captured. Joins to stores.id.",
            "label": "Class label: vehicle | truck | person | pizza | package.",
            "class_id": "COCO class id (2=vehicle, 0=person, 7=truck, 84=package, 53=pizza).",
            "confidence": "Model confidence 0.0 to 1.0. Filter out < 0.5 for executive answers unless the user asks for low-confidence detections.",
            "bbox": "Bounding box as [x1, y1, x2, y2] integer pixels in the source frame.",
        },
    ),
    "license_plates": (
        "Drive-thru / forecourt license plate captures from the lensiq-license-plate Roboflow endpoint. Plate text is partially masked (last chars redacted) - good for state/dwell analytics, not for individual lookups.",
        {
            "id": "Unique capture id.",
            "ts": "UTC timestamp of the plate capture.",
            "store_id": "Store where the plate was seen.",
            "state": "Two-letter US state abbreviation extracted from the plate.",
            "plate_masked": "Plate text with the final characters redacted (e.g. 'ABC***') for privacy.",
            "confidence": "OCR confidence 0.0 to 1.0.",
        },
    ),
    "alerts": (
        "Rule-engine alerts emitted by the LensIQ Jolt subsystem. Severity is critical (P1, refrigeration / safety), warning (P2), or info. acknowledged=true means an operator has triaged it.",
        {
            "id": "Unique alert id.",
            "ts": "UTC timestamp when the rule fired.",
            "store_id": "Store associated with the alert.",
            "store_name": "Denormalized store display name (matches stores.name).",
            "rule_id": "Rule identifier (e.g. temperature_critical, pizza_low_stock, camera_offline, vehicle_dwell_long).",
            "message": "Human-readable alert text.",
            "severity": "critical | warning | info. Treat critical as P1.",
            "acknowledged": "Whether an operator has acknowledged the alert.",
        },
    ),
    "camera_status": (
        "Per-hour online/offline samples for every camera in the fleet. Each store has 3 cameras; ~576 rows per day total. Use for uptime questions.",
        {
            "camera_id": "Camera identifier in the format <store_id>-CAM-<NN>.",
            "store_id": "Store the camera belongs to.",
            "ts": "UTC hour stamp.",
            "online": "true when the camera was reachable in that hour, false when offline.",
        },
    ),
    "devices": (
        "Refrigeration / IoT devices, one per store. Current temperature and status snapshot.",
        {
            "id": "Device identifier.",
            "name": "Friendly device label, usually the store name.",
            "location": "City, state of the device.",
            "current_temp": "Latest temperature reading in Fahrenheit.",
            "status": "Threshold-derived status: normal (<80F) | warning (80-90F) | critical (>90F).",
            "last_update": "When the device last reported.",
        },
    ),
    "device_readings": (
        "Hourly time series of temperature + humidity readings per device for the last 7 days.",
        {
            "device_id": "Device this reading belongs to. Joins to devices.id.",
            "ts": "UTC timestamp of the reading.",
            "temperature": "Reading in degrees Fahrenheit. >80F is warning, >90F is critical.",
            "humidity": "Relative humidity 0-100.",
            "status": "Threshold-derived status at this reading: normal | warning | critical.",
        },
    ),
    "inventory": (
        "Pizza hot-hold stock and truck-parking fill samples taken every 30 minutes for the first 4 stores. item='pizza' is percent of capacity stocked (lower is a problem); item='truck_parking' is percent of lot occupied.",
        {
            "ts": "UTC timestamp of the inventory sample.",
            "store_id": "Store the sample was taken at.",
            "item": "Either 'pizza' or 'truck_parking'.",
            "percentage": "0-100 percent. For pizza: stock remaining. For truck_parking: lot fill.",
        },
    ),
    "guest_counts": (
        "Live write-back from the LensIQ Guests page. Each row is one person-count sample for a defined zone (entrance, forecourt, drive_thru, register, aisle). Rows land within ~2 seconds of the booth click. Use for guest-traffic and pump-to-store conversion questions.",
        {
            "id": "Unique sample id.",
            "ts": "UTC timestamp of the sample.",
            "source_id": "Camera or video feed source the count came from.",
            "zone": "Zone label (entrance, forecourt, drive_thru, register, aisle).",
            "person_count": "Number of distinct persons detected in the zone at that tick.",
            "store_id": "Store the count applies to. Joins to stores.id.",
        },
    ),
    "plate_reads": (
        "Live write-back from the LensIQ License Plates page. One row per successful OCR with the full extracted plate text (not masked). Pair with license_plates for the masked / privacy-safe view.",
        {
            "id": "Unique read id.",
            "ts": "UTC timestamp of the read.",
            "source_id": "Camera / video feed the plate was captured from.",
            "store_id": "Store the read happened at. Joins to stores.id.",
            "plate_text": "Full plate text in uppercase, no spaces or punctuation.",
            "confidence": "OCR confidence 0.0 to 1.0.",
            "ocr_model": "Serving endpoint that produced the OCR (e.g. databricks-claude-opus-4-7).",
            "detection_confidence": "Vehicle-detection confidence for the source frame, when available.",
        },
    ),
    "fog_observations": (
        "Live write-back from the LensIQ Camera Health page. Per-tick observation of how fogged / obscured each camera lens is. area_pct is 0-100 (% of frame fogged); >= 25 is treated as fogged. Use for cleaning / preventive-maintenance questions.",
        {
            "id": "Unique observation id.",
            "ts": "UTC timestamp.",
            "source_id": "Camera / feed source id.",
            "store_id": "Store the camera belongs to. Joins to stores.id.",
            "camera_label": "Friendly camera label (Forecourt, Drive-thru, Entrance, etc.).",
            "fogged": "true when the lens condition crossed the fog threshold for that tick.",
            "region_count": "Number of distinct fog regions detected in the frame.",
            "area_pct": "Percent of frame fogged (0-100). >= 25 is concerning.",
        },
    ),
    "spill_cycles": (
        "Live write-back from the LensIQ Spills page. One row per completed spill -> cone response cycle. response_ms is the wall-clock time between the first spill detection and the first cone-placement detection. Lower is better; target is < 60000 (1 minute).",
        {
            "id": "Unique cycle id.",
            "ts": "UTC timestamp when the cycle completed (cone went down).",
            "source_id": "Camera / feed source the cycle came from.",
            "store_id": "Store the cycle happened at. Joins to stores.id.",
            "spill_first_ts": "UTC timestamp of the first spill detection in the cycle.",
            "cone_first_ts": "UTC timestamp of the first cone-placement detection in the cycle.",
            "response_ms": "Spill -> cone response time in milliseconds. Target is < 60000 (1 minute).",
            "was_assisted": "true when an operator was prompted by the system, false when the response was unassisted.",
        },
    ),
    "face_matches": (
        "Live write-back from the LensIQ Facial Recognition page. One row per matched face above the cosine-similarity threshold (0.45). role is banned | vip | staff. Use for security / VIP recognition / staff-time-on-floor questions.",
        {
            "id": "Unique match id.",
            "ts": "UTC timestamp of the match.",
            "source_id": "Camera / feed source id.",
            "store_id": "Store the match happened at. Joins to stores.id.",
            "face_id": "Enrolled face id this match was attached to.",
            "name": "Person's enrolled name.",
            "role": "banned | vip | staff.",
            "similarity": "Cosine similarity 0.0 to 1.0. Higher is a stronger match.",
        },
    ),
    "pipeline_frames": (
        "Gold layer of the Lakeflow Spark Declarative Pipeline. One row per deduped frame produced by the inbox volume + YOLO endpoint, with the parsed detections array. Use this for end-to-end CV throughput questions (frames/sec, detections/frame).",
        {
            "file_name": "Source frame filename.",
            "source_path": "UC volume path of the original frame.",
            "camera": "Camera id extracted from the inbox path.",
            "frame_ts": "Original frame modification timestamp.",
            "bucket_ts": "10-second bucket the frame was deduped into.",
            "size_bytes": "Source frame size in bytes.",
            "detections": "Array of {label, class_id, confidence, bbox} produced by the YOLO endpoint.",
            "detector_error": "Non-null when the YOLO call failed for this row.",
            "num_detections": "Convenience count of detections in this frame (0 when null).",
            "pipeline_ts": "When the pipeline emitted this row.",
        },
    ),
}


def _build_tables() -> list[dict]:
    out: list[dict] = []
    for name in sorted(_TABLES.keys()):
        desc, cols = _TABLES[name]
        column_configs = [
            {"column_name": col, "description": [cols[col]]}
            for col in sorted(cols.keys())
        ]
        out.append({
            "identifier": f"{_CATALOG}.{_SCHEMA}.{name}",
            "description": [desc],
            "column_configs": column_configs,
        })
    return out


def _build_sample_questions() -> list[dict]:
    return [
        {"id": _hex_id("1", i + 1), "question": [q]}
        for i, q in enumerate(_SAMPLE_QUESTIONS)
    ]


def _build_text_instructions() -> list[dict]:
    return [{"id": _hex_id("2", 1), "content": _GENERAL_INSTRUCTIONS}]


def _build_example_sqls() -> list[dict]:
    out: list[dict] = []
    for i, (q, sql) in enumerate(_EXAMPLE_SQLS):
        sql_lines = [line + "\n" for line in sql.splitlines()]
        if sql_lines:
            # Drop trailing newline on the last line so the rendered SQL doesn't
            # carry an extra blank line.
            sql_lines[-1] = sql_lines[-1].rstrip("\n")
        out.append({
            "id": _hex_id("3", i + 1),
            "question": [q],
            "sql": sql_lines,
        })
    return out


def main() -> None:
    payload = {
        "version": 2,
        "config": {
            "sample_questions": _build_sample_questions(),
        },
        "data_sources": {
            "tables": _build_tables(),
        },
        "instructions": {
            "text_instructions": _build_text_instructions(),
            "example_question_sqls": _build_example_sqls(),
        },
    }
    _OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    tables = payload["data_sources"]["tables"]
    print(f"Wrote {_OUT_PATH.relative_to(_REPO_ROOT)}")
    print(f"  tables             : {len(tables)}")
    print(f"  sample_questions   : {len(payload['config']['sample_questions'])}")
    print(f"  example_question_sqls : {len(payload['instructions']['example_question_sqls'])}")
    print(f"  text_instructions  : {len(payload['instructions']['text_instructions'])}")


if __name__ == "__main__":
    main()
