-- @param period STRING
--
-- Anchors the window to MAX(ts) from the detections table rather than
-- current_timestamp() so the dashboard "snaps" to the latest seed and stays
-- populated even when synthetic data is stale. The "prior" window mirrors
-- the size of "recent" so trend % stays comparable.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM retail_consumer_goods.lens_iq.detections
),
window_filter AS (
    SELECT
        now_ts,
        CASE :period
            WHEN "today" THEN now_ts - INTERVAL 1 DAYS
            WHEN "week"  THEN now_ts - INTERVAL 7 DAYS
            WHEN "month" THEN now_ts - INTERVAL 30 DAYS
            ELSE now_ts - INTERVAL 1 DAYS
        END AS start_ts
    FROM anchor
),
recent AS (
    SELECT label, COUNT(*) AS count
    FROM retail_consumer_goods.lens_iq.detections, window_filter
    WHERE ts >= start_ts AND ts <= now_ts
    GROUP BY label
),
prior AS (
    SELECT label, COUNT(*) AS count
    FROM retail_consumer_goods.lens_iq.detections, window_filter
    WHERE ts >= start_ts - (now_ts - start_ts)
      AND ts <  start_ts
    GROUP BY label
)
SELECT
    INITCAP(r.label) AS object,
    r.count,
    CASE
        WHEN COALESCE(p.count, 0) = 0 THEN "+100%"
        ELSE CONCAT(
            IF(r.count >= p.count, "+", ""),
            CAST(ROUND(((r.count - p.count) / p.count) * 100, 0) AS INT),
            "%"
        )
    END AS trend,
    CASE r.label
        WHEN "vehicle" THEN "Car"
        WHEN "person"  THEN "Users"
        WHEN "truck"   THEN "Truck"
        WHEN "pizza"   THEN "Pizza"
        ELSE "Package"
    END AS icon,
    CASE r.label
        WHEN "vehicle" THEN "#3b82f6"
        WHEN "person"  THEN "#10b981"
        WHEN "truck"   THEN "#f59e0b"
        WHEN "pizza"   THEN "#dc2626"
        ELSE "#8b5cf6"
    END AS color
FROM recent r
LEFT JOIN prior p ON p.label = r.label
ORDER BY r.count DESC
LIMIT 6
