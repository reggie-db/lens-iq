import type { ReactNode } from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@databricks/appkit-ui/react";
import { X } from "lucide-react";

// Reusable, image-shaped modal. Shows a single image scaled to the
// viewport: the picture caps at 70vw wide and 80vh tall (whichever
// constrains first wins, so aspect ratio is preserved) and the
// surrounding chrome hugs the image instead of forcing a fixed
// dialog width.
//
// Designed for "click a thumbnail, see the full shot" interactions
// across the app (enrolled reference faces, captured match frames,
// plate snapshots, etc.). Drive `open` + `onOpenChange` from the
// parent so a single instance can preview any image. The component
// renders nothing when `src` is falsy, even if `open` is true, so it
// is safe to keep `<ImageModal src={preview?.src ?? null} ... />`
// mounted at the page root.

export interface ImageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Image source. The modal renders nothing when this is falsy. */
  src: string | null | undefined;
  /** Alt text + visually hidden dialog title (a11y requirement). */
  alt: string;
  /** When true, the image is horizontally mirrored. Use for selfie
   * thumbnails so the modal matches the mirrored on-screen preview. */
  mirror?: boolean;
  /** Optional caption rendered under the image (name, timestamp, etc.). */
  caption?: ReactNode;
}

export function ImageModal({
  open, onOpenChange, src, alt, mirror = false, caption,
}: ImageModalProps) {
  return (
    <Dialog open={open && Boolean(src)} onOpenChange={onOpenChange}>
      <DialogContent
        // Override appkit-ui's default `sm:max-w-lg` + `p-6` so the dialog
        // hugs the image instead of forcing a fixed-width card. The
        // 70vw / 80vh caps live on the <img> below, not on the wrapping
        // content, so portrait photos shrink the dialog naturally and
        // landscape photos stretch out to the cap. tailwind-merge
        // collapses the conflicting width/max-width utilities for us.
        //
        // Disable the built-in close button: it ships as a dark icon at
        // 70% opacity and disappears against dark images. We render our
        // own below with a solid background pill.
        showCloseButton={false}
        className="w-auto max-w-none sm:max-w-none p-2 gap-2 bg-background"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        {src ? (
          <img
            src={src}
            alt={alt}
            className="block w-auto h-auto max-w-[70vw] max-h-[80vh] object-contain rounded"
            style={mirror ? { transform: "scaleX(-1)" } : undefined}
          />
        ) : null}
        {caption ? (
          <div className="px-1 text-xs text-slate-500">{caption}</div>
        ) : null}
        <DialogClose
          aria-label="Close"
          // Solid white pill so the X stays visible no matter what the
          // image behind it looks like (dark room, bright outdoor,
          // patterned background, etc.).
          className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-800 shadow-md ring-1 ring-slate-200 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400 transition-colors"
        >
          <X className="h-4 w-4" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
