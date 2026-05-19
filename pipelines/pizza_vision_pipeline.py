"""Pizza Vision continuous detection pipeline.

Reads raw frames from the `frames_inbox` Unity Catalog volume via Auto Loader,
dedupes to one frame per 10 second window per source (camera), then invokes
the YOLO detector serving endpoint and persists structured detections.

The downstream AppKit app reads `pipeline_frames` via the analytics plugin
and renders the bounding boxes on top of the original image (which is still
available in the inbox volume) using a client-side canvas overlay.

Layers:
    bronze_frames_raw    - one row per landed file in frames_inbox (binary).
    silver_frames_deduped - dropDuplicatesWithinWatermark per (source, 10s bucket).
    pipeline_frames      - silver + YOLO predictions per frame.
"""

from __future__ import annotations

import logging

from pyspark import pipelines as dp
from pyspark.sql import functions as F
from pyspark.sql.types import LongType, StringType

LOG = logging.getLogger("pizza_vision_pipeline")

# Pipeline parameters (set via the bundle resources/pipeline.yml configuration).
_CATALOG = spark.conf.get("pizza_vision.catalog", "reggie_pierce_7405614800873570")
_SCHEMA = spark.conf.get("pizza_vision.schema", "pizza_vision")
_INBOX_PATH = spark.conf.get(
    "pizza_vision.inbox_path",
    f"/Volumes/{_CATALOG}/{_SCHEMA}/frames_inbox",
)
_DETECTOR_ENDPOINT = spark.conf.get(
    "pizza_vision.detector_endpoint",
    "pizza-vision-detector",
)
_DEDUPE_WINDOW_SECONDS = int(spark.conf.get("pizza_vision.dedupe_window_seconds", "10"))
_WATERMARK = spark.conf.get("pizza_vision.watermark", "30 seconds")

# DDL string for the YOLO detections column. ai_query parses the serving
# endpoint response into this schema and returns NULL on error (because of
# failOnError => false).
_DETECTION_DDL = (
    "array<struct<label: string, class_id: bigint, confidence: double, bbox: array<bigint>>>"
)


def _camera_from_path(path: str) -> str:
    """Derive the source/camera id from the file path.

    The simulator writes to `frames_inbox/<camera>/frame_<ts>.jpg`; if no
    subfolder is present we bucket everything under `default`.
    """
    if not path:
        return "default"
    # Strip the volume prefix and take the first remaining path segment.
    parts = path.replace("dbfs:", "").lstrip("/").split("/")
    for i, p in enumerate(parts):
        if p == "frames_inbox" and i + 1 < len(parts) - 1:
            return parts[i + 1]
    return "default"


_camera_from_path_udf = F.udf(_camera_from_path, StringType())


@dp.table(
    name=f"{_CATALOG}.{_SCHEMA}.bronze_frames_raw",
    comment="Raw image frames landed in the frames_inbox volume (one row per file).",
    cluster_by=["camera"],
    table_properties={"quality": "bronze"},
)
def bronze_frames_raw():
    return (
        spark.readStream.format("cloudFiles")
        .option("cloudFiles.format", "binaryFile")
        .option("cloudFiles.includeExistingFiles", "true")
        .option("pathGlobFilter", "*.jpg")
        .load(_INBOX_PATH)
        .select(
            F.col("path").alias("source_path"),
            F.col("content").alias("image_bytes"),
            F.col("modificationTime").alias("ts"),
            F.col("length").cast(LongType()).alias("size_bytes"),
            _camera_from_path_udf(F.col("path")).alias("camera"),
            F.current_timestamp().alias("ingested_at"),
        )
    )


@dp.table(
    name=f"{_CATALOG}.{_SCHEMA}.silver_frames_deduped",
    comment=f"At most one frame per camera per {_DEDUPE_WINDOW_SECONDS}s window.",
    cluster_by=["camera"],
    table_properties={"quality": "silver"},
)
def silver_frames_deduped():
    # Bucket modificationTime into N-second windows and drop dupes within a
    # watermark so out-of-order arrivals still collapse to one frame.
    return (
        spark.readStream.table(f"{_CATALOG}.{_SCHEMA}.bronze_frames_raw")
        .withColumn(
            "bucket_ts",
            F.from_unixtime(
                (F.unix_timestamp("ts") / _DEDUPE_WINDOW_SECONDS).cast("long")
                * _DEDUPE_WINDOW_SECONDS
            ).cast("timestamp"),
        )
        .withWatermark("ts", _WATERMARK)
        .dropDuplicatesWithinWatermark(["camera", "bucket_ts"])
    )


@dp.table(
    name=f"{_CATALOG}.{_SCHEMA}.pipeline_frames",
    comment="Deduped frames with YOLO detections from the continuous pipeline.",
    cluster_by=["camera"],
    table_properties={"quality": "gold"},
)
def pipeline_frames():
    # Use ai_query (native SQL function) instead of a Python UDF so the
    # serving call is authenticated by the warehouse runtime - no SDK
    # bootstrapping, no auth plumbing, and it batches across rows for free.
    # With failOnError => false ai_query wraps the response in
    # {result, errorMessage}; we pull `.result` out and surface the error
    # message as its own column for observability.
    detection_call = F.expr(
        f"""
        ai_query(
            '{_DETECTOR_ENDPOINT}',
            named_struct(
                'image', base64(image_bytes),
                'conf',  CAST(0.35 AS DOUBLE),
                'iou',   CAST(0.5  AS DOUBLE)
            ),
            returnType  => '{_DETECTION_DDL}',
            failOnError => false
        )
        """
    )
    return (
        spark.readStream.table(f"{_CATALOG}.{_SCHEMA}.silver_frames_deduped")
        .withColumn("_yolo", detection_call)
        .withColumn("detections", F.col("_yolo.result"))
        .withColumn("detector_error", F.col("_yolo.errorMessage"))
        .withColumn(
            "num_detections",
            F.when(F.col("detections").isNull(), F.lit(0)).otherwise(F.size("detections")),
        )
        .withColumn("pipeline_ts", F.current_timestamp())
        .select(
            F.regexp_extract(F.col("source_path"), "([^/]+)$", 1).alias("file_name"),
            F.col("source_path"),
            F.col("camera"),
            F.col("ts").alias("frame_ts"),
            F.col("bucket_ts"),
            F.col("size_bytes"),
            F.col("detections"),
            F.col("detector_error"),
            F.col("num_detections"),
            F.col("pipeline_ts"),
        )
    )
