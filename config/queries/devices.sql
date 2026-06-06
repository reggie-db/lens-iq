SELECT
    id,
    name,
    location,
    current_temp AS currentTemp,
    status,
    DATE_FORMAT(last_update, "yyyy-MM-dd HH:mm:ss") AS lastUpdate
FROM retail_consumer_goods.lens_iq.devices
ORDER BY name
