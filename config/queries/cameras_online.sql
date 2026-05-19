-- Online-camera count per hour over the 24h window ending at the latest
-- camera_status sample (anchor, not wall clock).
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.camera_status
)
SELECT
    DATE_FORMAT(date_trunc("HOUR", c.ts), "h a") AS hour,
    SUM(c.online::int) AS cameras
FROM reggie_pierce_7405614800873570.pizza_vision.camera_status c, anchor a
WHERE c.ts >= a.now_ts - INTERVAL 1 DAYS
  AND c.ts <= a.now_ts
GROUP BY date_trunc("HOUR", c.ts)
ORDER BY date_trunc("HOUR", c.ts)
