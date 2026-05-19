-- KPI tiles for the Plates page. Both the "today" and the prior-day window
-- ride the latest license_plates timestamp so the trend % stays meaningful
-- against a stale seed.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.license_plates
),
today_data AS (
    SELECT COUNT(*) AS total, COUNT(DISTINCT p.state) AS unique_states
    FROM reggie_pierce_7405614800873570.pizza_vision.license_plates p, anchor a
    WHERE p.ts >= a.now_ts - INTERVAL 1 DAYS
      AND p.ts <= a.now_ts
),
yesterday_data AS (
    SELECT COUNT(*) AS total
    FROM reggie_pierce_7405614800873570.pizza_vision.license_plates p, anchor a
    WHERE p.ts >= a.now_ts - INTERVAL 2 DAYS
      AND p.ts <  a.now_ts - INTERVAL 1 DAYS
)
SELECT
    t.total AS totalDetected,
    t.unique_states AS uniqueStates,
    CAST(ROUND(t.total / 24.0, 0) AS INT) AS averagePerHour,
    CASE
        WHEN COALESCE(y.total, 0) = 0 THEN "+100%"
        ELSE CONCAT(
            IF(t.total >= y.total, "+", ""),
            CAST(ROUND(((t.total - y.total) / y.total) * 100, 0) AS INT),
            "%"
        )
    END AS trend
FROM today_data t
CROSS JOIN yesterday_data y
