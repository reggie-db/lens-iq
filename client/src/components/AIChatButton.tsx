import { useState } from "react";
import {
  Button,
  Sheet, SheetContent, SheetTrigger,
} from "@databricks/appkit-ui/react";
import { MastraChat } from "@dbx-tools/appkit-mastra-ui/react";
import { MessageCircle, Sparkles } from "lucide-react";
import { ApertureIcon } from "./LensIQLogo";

// Floating chat button that opens a sheet hosting the <MastraChat> drop-in
// from @dbx-tools/appkit-mastra-ui. It wires itself from the mastra() plugin
// mounted in server/server.ts (the `lensiq` agent), streaming over
// @mastra/client-js and driving the LensIQ Detections Genie space through
// the agent's Genie tools - so questions are still answered against the live
// UC tables, now with tool-session progress, inline charts/tables, and
// starter questions auto-sourced from the space's sample_questions.

export function AIChatButton() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          className="fixed bottom-6 right-6 rounded-full w-14 h-14 shadow-lg"
          aria-label="Open AI chat"
          data-kiosk="genie"
        >
          <MessageCircle className="w-6 h-6" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[400px] sm:w-[480px] flex flex-col gap-3">
        <div className="flex items-center gap-2 font-semibold">
          <ApertureIcon size={20} title="LensIQ" />
          <span>
            Ask <span style={{ fontFamily: '"DM Sans", system-ui, sans-serif', letterSpacing: "-0.025em" }}>LensIQ</span>
          </span>
          <Sparkles className="w-4 h-4 text-lava-600" />
        </div>
        <div className="flex-1 min-h-0">
          <MastraChat showModelPicker />
        </div>
      </SheetContent>
    </Sheet>
  );
}
