SELECT
    id,
    name,
    location,
    current_temp AS currentTemp,
    status,
    DATE_FORMAT(last_update, "yyyy-MM-dd HH:mm:ss") AS lastUpdate
FROM reggie_pierce_7405614800873570.pizza_vision.devices
ORDER BY name
