-- @param storeId STRING
--
-- Truck parking utilization history for a store, anchored to the latest
-- inventory sample so the 12h window matches the most recent seed.
WITH anchor AS (
    SELECT MAX(ts) AS now_ts
    FROM retail_consumer_goods.lens_iq.inventory
    WHERE store_id = :storeId AND item = "truck_parking"
)
SELECT
    DATE_FORMAT(i.ts, "HH:mm") AS time,
    ROUND(i.percentage, 1) AS value
FROM retail_consumer_goods.lens_iq.inventory i, anchor a
WHERE i.store_id = :storeId
  AND i.item = "truck_parking"
  AND i.ts >= a.now_ts - INTERVAL 12 HOURS
  AND i.ts <= a.now_ts
ORDER BY i.ts
