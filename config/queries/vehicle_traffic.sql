-- Hourly vehicle + truck counts over the 24h window ending at the latest
-- detection. Anchored to MAX(ts) for stable display against stale seeds.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM retail_consumer_goods.lens_iq.detections
)
SELECT
    DATE_FORMAT(date_trunc("HOUR", d.ts), "h a") AS hour,
    COUNT(*) AS vehicles
FROM retail_consumer_goods.lens_iq.detections d, anchor a
WHERE d.ts >= a.now_ts - INTERVAL 1 DAYS
  AND d.ts <= a.now_ts
  AND d.label IN ("vehicle", "truck")
GROUP BY date_trunc("HOUR", d.ts)
ORDER BY date_trunc("HOUR", d.ts)
