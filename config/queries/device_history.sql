-- @param deviceId STRING
-- @param hours INT
--
-- Time-series for a single device, ending at its most recent reading (so a
-- stale device_readings table still draws a chart).
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.device_readings
    WHERE device_id = :deviceId
)
SELECT
    DATE_FORMAT(r.ts, "HH:mm") AS time,
    ROUND(r.temperature, 1) AS temperature,
    ROUND(r.humidity, 1) AS humidity
FROM reggie_pierce_7405614800873570.pizza_vision.device_readings r, anchor a
WHERE r.device_id = :deviceId
  AND r.ts >= a.now_ts - make_interval(0, 0, 0, 0, :hours, 0, 0)
  AND r.ts <= a.now_ts
ORDER BY r.ts
