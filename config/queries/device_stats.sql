SELECT
    SUM(CASE WHEN status = "normal"   THEN 1 ELSE 0 END) AS normalCount,
    SUM(CASE WHEN status = "warning"  THEN 1 ELSE 0 END) AS warningCount,
    SUM(CASE WHEN status = "critical" THEN 1 ELSE 0 END) AS criticalCount,
    CAST(ROUND(AVG(current_temp), 1) AS STRING) AS avgTemp,
    COUNT(*) AS totalDevices
FROM reggie_pierce_7405614800873570.pizza_vision.devices
