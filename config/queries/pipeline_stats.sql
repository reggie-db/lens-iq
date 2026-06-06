-- Aggregate metrics for the continuous detection pipeline. Used by the
-- Pipeline page header to surface throughput + dedupe ratio at a glance.
SELECT
    (SELECT COUNT(*) FROM retail_consumer_goods.lens_iq.bronze_frames_raw)     AS raw_frames,
    (SELECT COUNT(*) FROM retail_consumer_goods.lens_iq.silver_frames_deduped) AS deduped_frames,
    (SELECT COUNT(*) FROM retail_consumer_goods.lens_iq.pipeline_frames)       AS processed_frames,
    (
        SELECT SUM(num_detections)
        FROM retail_consumer_goods.lens_iq.pipeline_frames
    )                                                                                        AS total_detections,
    (
        SELECT COUNT(DISTINCT camera)
        FROM retail_consumer_goods.lens_iq.pipeline_frames
    )                                                                                        AS cameras_active,
    (
        SELECT DATE_FORMAT(MAX(pipeline_ts), "yyyy-MM-dd'T'HH:mm:ss")
        FROM retail_consumer_goods.lens_iq.pipeline_frames
    )                                                                                        AS last_processed_at
