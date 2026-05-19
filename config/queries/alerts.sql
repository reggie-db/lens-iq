-- @param max_rows INT
SELECT
    a.id,
    a.rule_id AS ruleId,
    a.message,
    a.severity,
    a.store_id AS storeId,
    a.store_name AS storeName,
    DATE_FORMAT(a.ts, "yyyy-MM-dd'T'HH:mm:ss") AS ts,
    a.acknowledged
FROM reggie_pierce_7405614800873570.pizza_vision.alerts a
ORDER BY a.ts DESC
LIMIT :max_rows
