-- @param since TIMESTAMP
SELECT
    id,
    frame_id,
    DATE_FORMAT(ts, "yyyy-MM-dd'T'HH:mm:ss") AS ts,
    store_id,
    label,
    class_id,
    confidence,
    bbox
FROM reggie_pierce_7405614800873570.pizza_vision.detections
WHERE ts > :since
ORDER BY ts
LIMIT 200
