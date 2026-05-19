// Type-safe shapes for each named SQL query under config/queries/*.sql.
// These are referenced by `useAnalyticsQuery("<key>")` calls. The QueryRegistry
// declaration tells AppKit what params/result types each key uses.
//
// IMPORTANT: parameter values must be wrapped with `sql.*` helpers
// (`sql.string`, `sql.number`, ...) imported from `@databricks/appkit-ui/js`.
// AppKit's analytics plugin rejects raw JS values at runtime with
// "Invalid value for <param>: expected SQL type", so we type the registry
// with the matching marker interfaces to catch the mismatch at compile time.

import type {
  SQLNumberMarker,
  SQLStringMarker,
} from "@databricks/appkit-ui/js";

export interface Device {
  id: string;
  name: string;
  location: string;
  currentTemp: number;
  status: "normal" | "warning" | "critical";
  lastUpdate: string;
}

export interface TemperatureDataPoint {
  time: string;
  temperature: number;
  humidity: number;
}

export interface DeviceStats {
  normalCount: number;
  warningCount: number;
  criticalCount: number;
  avgTemp: string;
  totalDevices: number;
}

export interface ObjectDetectionSummary {
  object: string;
  count: number;
  trend: string;
  icon: string;
  color: string;
}

export interface HourlyDetection {
  hour: string;
  count: number;
}

export interface RecentDetection {
  id: number;
  type: string;
  location: string;
  time: string;
  confidence: number;
}

export interface StateDistribution {
  state: string;
  name: string;
  count: number;
  percentage: number;
  color: string;
}

export interface RecentPlate {
  id: number;
  state: string;
  plateNumber: string;
  location: string;
  time: string;
  confidence: number;
}

export interface StateStats {
  totalDetected: number;
  uniqueStates: number;
  averagePerHour: number;
  trend: string;
}

export interface CameraOnlinePoint {
  hour: string;
  cameras: number;
}

export interface VehicleTrafficPoint {
  hour: string;
  vehicles: number;
}

export interface InventoryPoint {
  time: string;
  percentage: number;
}

export interface TruckParkingPoint {
  time: string;
  value: number;
}

export interface AlertRow {
  id: number;
  ruleId: string;
  message: string;
  severity: "critical" | "warning" | "info";
  storeId: string;
  storeName: string;
  ts: string;
  acknowledged: boolean;
}

export interface SearchRow {
  kind: string;
  id: number;
  label: string;
  store: string;
  ts: string;
  confidence: number;
}

export interface PipelineDetection {
  label: string;
  class_id: number;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface PipelineFrame {
  file_name: string;
  source_path: string;
  camera: string;
  frame_ts: string;
  pipeline_ts: string;
  bucket_ts: string;
  size_bytes: number;
  num_detections: number;
  /** Raw JSON string for `array<struct<...>>` detections, decoded client-side. */
  detections_json: string;
}

export interface PipelineStats {
  raw_frames: number;
  deduped_frames: number;
  processed_frames: number;
  total_detections: number;
  cameras_active: number;
  last_processed_at: string | null;
}

declare module "@databricks/appkit-ui/react" {
  interface QueryRegistry {
    devices: {
      name: "devices";
      parameters: Record<string, never>;
      result: Device[];
    };
    device_history: {
      name: "device_history";
      parameters: { deviceId: SQLStringMarker; hours: SQLNumberMarker };
      result: TemperatureDataPoint[];
    };
    device_stats: {
      name: "device_stats";
      parameters: Record<string, never>;
      result: DeviceStats[];
    };
    detections_summary: {
      name: "detections_summary";
      parameters: { period: SQLStringMarker };
      result: ObjectDetectionSummary[];
    };
    detections_hourly: {
      name: "detections_hourly";
      parameters: Record<string, never>;
      result: HourlyDetection[];
    };
    detections_recent: {
      name: "detections_recent";
      parameters: { max_rows: SQLNumberMarker };
      result: RecentDetection[];
    };
    plate_distribution: {
      name: "plate_distribution";
      parameters: { period: SQLStringMarker };
      result: StateDistribution[];
    };
    plate_recent: {
      name: "plate_recent";
      parameters: { max_rows: SQLNumberMarker };
      result: RecentPlate[];
    };
    plate_stats: {
      name: "plate_stats";
      parameters: Record<string, never>;
      result: StateStats[];
    };
    cameras_online: {
      name: "cameras_online";
      parameters: Record<string, never>;
      result: CameraOnlinePoint[];
    };
    vehicle_traffic: {
      name: "vehicle_traffic";
      parameters: Record<string, never>;
      result: VehicleTrafficPoint[];
    };
    inventory_pizza: {
      name: "inventory_pizza";
      parameters: { storeId: SQLStringMarker };
      result: InventoryPoint[];
    };
    inventory_truck: {
      name: "inventory_truck";
      parameters: { storeId: SQLStringMarker };
      result: TruckParkingPoint[];
    };
    alerts: {
      name: "alerts";
      parameters: { max_rows: SQLNumberMarker };
      result: AlertRow[];
    };
    data_search: {
      name: "data_search";
      parameters: { search: SQLStringMarker; max_rows: SQLNumberMarker };
      result: SearchRow[];
    };
    pipeline_frames: {
      name: "pipeline_frames";
      parameters: { max_rows: SQLNumberMarker };
      result: PipelineFrame[];
    };
    pipeline_stats: {
      name: "pipeline_stats";
      parameters: Record<string, never>;
      result: PipelineStats[];
    };
  }
}
