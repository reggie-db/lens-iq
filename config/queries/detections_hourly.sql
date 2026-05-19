-- Hourly detection counts over the 24h window ending at the latest seeded
-- row. Anchoring to MAX(ts) keeps the chart populated even when the seed is
-- stale.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.detections
)
SELECT
    DATE_FORMAT(date_trunc("HOUR", d.ts), "HH:00") AS hour,
    COUNT(*) AS count
FROM reggie_pierce_7405614800873570.pizza_vision.detections d, anchor a
WHERE d.ts >= a.now_ts - INTERVAL 1 DAYS
  AND d.ts <= a.now_ts
GROUP BY date_trunc("HOUR", d.ts)
ORDER BY date_trunc("HOUR", d.ts)
