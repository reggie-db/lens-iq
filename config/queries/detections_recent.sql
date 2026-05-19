-- @param max_rows INT
--
-- "X min ago" labels are computed against the latest-seeded timestamp instead
-- of wall clock, so a 6h-old seed still displays sensible relative times.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.detections
)
SELECT
    d.id,
    INITCAP(d.label) AS type,
    CONCAT(s.name, " - Pump ", CAST(MOD(d.id, 6) + 1 AS STRING)) AS location,
    CONCAT(
        CAST(GREATEST(1, FLOOR((unix_timestamp(a.now_ts) - unix_timestamp(d.ts)) / 60)) AS STRING),
        " min ago"
    ) AS time,
    CAST(ROUND(d.confidence * 100, 0) AS INT) AS confidence
FROM reggie_pierce_7405614800873570.pizza_vision.detections d, anchor a
LEFT JOIN reggie_pierce_7405614800873570.pizza_vision.stores s ON s.id = d.store_id
ORDER BY d.ts DESC
LIMIT :max_rows
