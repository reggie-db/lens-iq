import { Button } from "@databricks/appkit-ui/react";
import { MastraChat } from "@dbx-tools/ui-mastra/react";
import { MessageCircle, Sparkles, X } from "lucide-react";
import { ApertureIcon } from "./LensIQLogo";

// "Ask LensIQ" chat, hosted in a docked right-hand pane rather than an overlay
// sheet so the dashboard stays visible and readable while the agent answers.
// AppShell owns the open state and the resizable split; this file exports the
// launcher button and the pane body it toggles.
//
// <MastraChat> is the drop-in from @dbx-tools/ui-mastra. It wires itself from
// the mastra() plugin mounted in server/server.ts (the `fleet-analyst` agent),
// streaming over @mastra/client-js and driving the LensIQ Detections Genie
// space through the agent's Genie tools - so questions are still answered
// against the live UC tables, now with tool-session progress, inline
// charts/tables, and starter questions auto-sourced from the space's
// sample_questions.

interface AIChatLauncherProps {
  onClick: () => void;
}

export function AIChatLauncher({ onClick }: AIChatLauncherProps) {
  return (
    <Button
      onClick={onClick}
      className="fixed bottom-6 right-6 z-20 rounded-full w-14 h-14 shadow-lg"
      aria-label="Open AI chat"
      data-kiosk="genie"
    >
      <MessageCircle className="w-6 h-6" />
    </Button>
  );
}

interface AIChatPanelProps {
  onClose: () => void;
}

export function AIChatPanel({ onClose }: AIChatPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 font-semibold text-foreground">
        <ApertureIcon size={20} title="LensIQ" />
        <span>
          Ask <span style={{ fontFamily: '"DM Sans", system-ui, sans-serif', letterSpacing: "-0.025em" }}>LensIQ</span>
        </span>
        <Sparkles className="w-4 h-4 text-lava-600" />
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-8 w-8"
          onClick={onClose}
          aria-label="Close AI chat"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 px-3 pb-3 pt-2">
        {/* Same drop-in as dbx-tools demo Stream.tsx: MastraChat streams
            over @mastra/client-js (tool pills, charts, model picker).
            threadPlacement="top" keeps conversation tabs in an editor-style
            strip (fits the narrow docked chat column better than a side
            panel). */}
        <MastraChat
          showModelPicker
          enableExport
          threadPlacement="top"
        />
      </div>
    </div>
  );
}
