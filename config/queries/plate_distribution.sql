-- @param period STRING
--
-- Plate state breakdown for the requested period, anchored to MAX(ts) so the
-- bar chart shows captures relative to the latest seed instead of an empty
-- "current_timestamp() - 1 day" window.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.license_plates
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
counts AS (
    SELECT state, COUNT(*) AS count
    FROM reggie_pierce_7405614800873570.pizza_vision.license_plates, window_filter
    WHERE ts >= start_ts AND ts <= now_ts
    GROUP BY state
),
total AS (
    SELECT SUM(count) AS total_count FROM counts
)
SELECT
    c.state,
    CASE c.state
        WHEN "GA" THEN "Georgia"
        WHEN "FL" THEN "Florida"
        WHEN "TX" THEN "Texas"
        WHEN "AL" THEN "Alabama"
        WHEN "SC" THEN "South Carolina"
        WHEN "NC" THEN "North Carolina"
        WHEN "TN" THEN "Tennessee"
        WHEN "MS" THEN "Mississippi"
        ELSE c.state
    END AS name,
    c.count,
    ROUND(c.count / t.total_count * 100, 1) AS percentage,
    CASE c.state
        WHEN "GA" THEN "#dc2626"
        WHEN "FL" THEN "#ea580c"
        WHEN "TX" THEN "#d97706"
        WHEN "AL" THEN "#ca8a04"
        WHEN "SC" THEN "#65a30d"
        WHEN "NC" THEN "#16a34a"
        WHEN "TN" THEN "#0ea5e9"
        WHEN "MS" THEN "#8b5cf6"
        ELSE "#64748b"
    END AS color
FROM counts c
CROSS JOIN total t
ORDER BY c.count DESC
