// Curated catalog of sample input videos for the Live page demo.
//
// Each entry is a Roboflow-hosted public MP4 (the same assets the
// `supervision` python library exposes via VideoAssets). Because that CDN
// doesn't emit CORS headers, the videos are streamed through the AppKit
// server proxy (/api/sample-videos/:id) so the on-page <canvas> can capture
// frames without tainting them.
//
// `models` lists the LensIQ model ids (see ./models.ts) that the sample is a
// good demo for - the UI uses this to suggest a relevant detector when the
// user picks a source.

import type { ModelDefinition } from "./models";

export interface SampleVideo {
  id: string;
  name: string;
  description: string;
  /** Upstream URL on Roboflow's CDN. Server proxies this. */
  upstream: string;
  /** Model ids this sample is a good demo for. First entry is the default. */
  models: string[];
}

export const SAMPLE_VIDEOS: SampleVideo[] = [
  {
    id: "vehicles",
    name: "Highway traffic",
    description: "Vehicles moving on a multi-lane highway. Great for license plate + general YOLO detection.",
    upstream: "https://media.roboflow.com/supervision/video-examples/vehicles.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "vehicles-2",
    name: "Highway traffic (alt angle)",
    description: "Second highway clip, different angle. Same use cases as the primary vehicles clip.",
    upstream: "https://media.roboflow.com/supervision/video-examples/vehicles-2.mp4",
    models: ["license_plate", "yolo"],
  },
  {
    id: "people-walking",
    name: "Pedestrians",
    description: "Outdoor sidewalk with multiple pedestrians walking. Ideal for people count.",
    upstream: "https://media.roboflow.com/supervision/video-examples/people-walking.mp4",
    models: ["people_count", "yolo"],
  },
  {
    id: "subway",
    name: "Subway crowd",
    description: "Dense subway crowd. Stress-tests people count and YOLO person detection.",
    upstream: "https://media.roboflow.com/supervision/video-examples/subway.mp4",
    models: ["people_count", "yolo"],
  },
  {
    id: "market-square",
    name: "Market square",
    description: "Outdoor market scene with foot traffic. Good for people count + general YOLO.",
    upstream: "https://media.roboflow.com/supervision/video-examples/market-square.mp4",
    models: ["people_count", "yolo"],
  },
  {
    id: "grocery-store",
    name: "Grocery store aisle",
    description: "Indoor retail aisle. Closest analog to a QSR/c-store interior - shoppers and products.",
    upstream: "https://media.roboflow.com/supervision/video-examples/grocery-store.mp4",
    models: ["yolo", "people_count"],
  },
  {
    id: "milk-bottling-plant",
    name: "Industrial workers",
    description: "Workers on an industrial line, often with PPE. Good for the hard hat / PPE model.",
    upstream: "https://media.roboflow.com/supervision/video-examples/milk-bottling-plant.mp4",
    models: ["hard_hat", "yolo"],
  },
];

const _BY_ID = new Map<string, SampleVideo>(SAMPLE_VIDEOS.map((s) => [s.id, s]));

export function getSampleVideo(id: string): SampleVideo | undefined {
  return _BY_ID.get(id);
}

// Suggest the first sample that lists this model as a good fit. Returns
// undefined if none of the curated samples match - the UI then leaves the
// source dropdown alone instead of jumping to an unrelated clip.
export function defaultSampleForModel(model: ModelDefinition): SampleVideo | undefined {
  return SAMPLE_VIDEOS.find((s) => s.models.includes(model.id));
}
