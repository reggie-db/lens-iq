import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@databricks/appkit-ui/react";
import { Upload as UploadIcon } from "lucide-react";
import { SNAPSHOT_MAX_DIMENSION, resizeDataUrlForDetection } from "../lib/camera";
import { callDetector, type Detection } from "../lib/detector";

// Static image upload. Reads the file as a base64 data URL, posts it to the
// detector endpoint with persist=true so the frame is stored in the UC
// `frames` volume and a row per detection is inserted into the warehouse
// detections table. Shows the boxes inline and surfaces a link to the
// persisted frame.

interface UploadResult {
  detections: Detection[];
  saved: { frame_id: string; url: string } | null;
}

export function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("Please select an image file.");
      return;
    }
    setFile(f);
    setResult(null);
    const reader = new FileReader();
    reader.onloadend = () => setPreview(reader.result as string);
    reader.readAsDataURL(f);
  };

  const handleClear = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleSubmit = async () => {
    if (!preview || !file) return;
    setSubmitting(true);
    try {
      const frame = await resizeDataUrlForDetection(preview, 0, 0, {
        maxDimension: SNAPSHOT_MAX_DIMENSION,
        quality: 0.78,
      });
      if (!frame) {
        toast.error("Could not prepare image for detection.");
        return;
      }
      const r = await callDetector(frame.image, { persist: true });
      setResult(r);
      const noun = `${r.detections.length} object${r.detections.length === 1 ? "" : "s"}`;
      if (r.saved) {
        toast.success(`Detected ${noun} and saved as ${r.saved.frame_id}`);
      } else {
        toast.success(`Detected ${noun} (frame not persisted)`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Detector failed");
    } finally {
      setSubmitting(false);
    }
  };

  const detections = result?.detections ?? [];

  return (
    <div className="max-w-3xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadIcon className="w-5 h-5" /> Image Upload
          </CardTitle>
          <CardDescription>
            Runs a single image through the YOLO detector. The frame is uploaded
            to the `frames` UC volume and each detection becomes a row in the
            detections table, so it shows up in the Detections page and warehouse charts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file-input">Image file</Label>
            <Input id="file-input" ref={inputRef} type="file" accept="image/*" onChange={handleFileSelect} disabled={submitting} />
          </div>

          {preview && (
            <div className="space-y-2">
              <Label>Preview</Label>
              <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                <img src={preview} alt="Preview" className="max-w-full max-h-96 mx-auto rounded" />
                {file && <p className="text-sm text-slate-600 mt-2 text-center">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>}
              </div>
            </div>
          )}

          {result?.saved && (
            <div className="space-y-2">
              <Label>Saved frame</Label>
              <div className="border border-slate-200 rounded-lg p-3 bg-white text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-slate-600">{result.saved.frame_id}</span>
                  <a
                    href={result.saved.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 underline text-xs"
                  >
                    open from volume
                  </a>
                </div>
              </div>
            </div>
          )}

          {detections.length > 0 && (
            <div className="space-y-2">
              <Label>Detections</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {detections.map((d, i) => (
                  <div key={i} className="flex items-center justify-between p-2 rounded border border-slate-200 bg-white">
                    <span className="capitalize">{d.label}</span>
                    <Badge variant="outline">{(d.confidence * 100).toFixed(0)}%</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={handleSubmit} disabled={!file || submitting} className="flex-1">
              {submitting ? "Detecting..." : "Run detector and save"}
            </Button>
            {file && <Button onClick={handleClear} variant="outline" disabled={submitting}>Clear</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
