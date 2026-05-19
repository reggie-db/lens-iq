-- @param max_rows INT
-- Most-recent frames produced by the continuous detection pipeline. The app
-- renders the raw frame from /api/files/inbox/raw and overlays the bounding
-- boxes on a canvas using the structured `detections` column.
SELECT
    file_name,
    source_path,
    camera,
    DATE_FORMAT(frame_ts,    "yyyy-MM-dd'T'HH:mm:ss") AS frame_ts,
    DATE_FORMAT(pipeline_ts, "yyyy-MM-dd'T'HH:mm:ss") AS pipeline_ts,
    DATE_FORMAT(bucket_ts,   "yyyy-MM-dd'T'HH:mm:ss") AS bucket_ts,
    size_bytes,
    num_detections,
    to_json(detections) AS detections_json
FROM reggie_pierce_7405614800873570.pizza_vision.pipeline_frames
ORDER BY pipeline_ts DESC
LIMIT :max_rows
