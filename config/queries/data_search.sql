-- @param search STRING
-- @param max_rows INT
SELECT
    "detection" AS kind,
    d.id,
    INITCAP(d.label) AS label,
    s.name AS store,
    DATE_FORMAT(d.ts, "yyyy-MM-dd'T'HH:mm:ss") AS ts,
    CAST(ROUND(d.confidence * 100, 0) AS INT) AS confidence
FROM reggie_pierce_7405614800873570.pizza_vision.detections d
LEFT JOIN reggie_pierce_7405614800873570.pizza_vision.stores s ON s.id = d.store_id
WHERE :search = "" OR d.label LIKE LOWER(CONCAT("%", :search, "%"))
ORDER BY d.ts DESC
LIMIT :max_rows
