-- @param storeId STRING
--
-- Pizza inventory history for a store, anchored to the most recent sample so
-- the 12h window slides forward with the data instead of with the wall clock.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM reggie_pierce_7405614800873570.pizza_vision.inventory
    WHERE store_id = :storeId AND item = "pizza"
)
SELECT
    DATE_FORMAT(i.ts, "HH:mm") AS time,
    ROUND(i.percentage, 1) AS percentage
FROM reggie_pierce_7405614800873570.pizza_vision.inventory i, anchor a
WHERE i.store_id = :storeId
  AND i.item = "pizza"
  AND i.ts >= a.now_ts - INTERVAL 12 HOURS
  AND i.ts <= a.now_ts
ORDER BY i.ts
