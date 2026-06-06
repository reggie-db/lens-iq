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
FROM retail_consumer_goods.lens_iq.detections
WHERE ts > :since
ORDER BY ts
LIMIT 200
