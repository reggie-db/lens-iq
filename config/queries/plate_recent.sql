-- @param max_rows INT
--
-- Most-recent plate captures. "X min ago" labels are computed against the
-- latest-seeded timestamp instead of wall clock so a stale seed still
-- displays plausible relative times.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM retail_consumer_goods.lens_iq.license_plates
)
SELECT
    p.id,
    p.state,
    p.plate_masked AS plateNumber,
    CONCAT(s.name, " - Pump ", CAST(MOD(p.id, 6) + 1 AS STRING)) AS location,
    CONCAT(
        CAST(GREATEST(1, FLOOR((unix_timestamp(a.now_ts) - unix_timestamp(p.ts)) / 60)) AS STRING),
        " min ago"
    ) AS time,
    CAST(ROUND(p.confidence * 100, 0) AS INT) AS confidence
FROM retail_consumer_goods.lens_iq.license_plates p, anchor a
LEFT JOIN retail_consumer_goods.lens_iq.stores s ON s.id = p.store_id
ORDER BY p.ts DESC
LIMIT :max_rows
