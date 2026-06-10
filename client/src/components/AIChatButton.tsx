import { useState } from "react";
import {
  Button, GenieChat,
  Sheet, SheetContent, SheetTrigger,
} from "@databricks/appkit-ui/react";
import { MessageCircle, Sparkles } from "lucide-react";
import { ApertureIcon } from "./LensIQLogo";

// Floating chat button that opens a sheet hosting the AppKit <GenieChat>
// component. GenieChat talks to the LensIQ Detections Genie space via the
// genie() plugin (server/server.ts), so questions are answered against the
// live UC tables instead of a free-text LLM. The `default` alias matches the
// space the plugin registers from DATABRICKS_GENIE_SPACE_ID.

const GENIE_ALIAS = "default";

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
          <GenieChat
            alias={GENIE_ALIAS}
            placeholder="Ask about temperatures, alerts, plates, detections, or inventory..."
            className="h-full"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
