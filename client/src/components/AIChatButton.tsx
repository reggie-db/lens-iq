import { useCallback, useState } from "react";
import { useServingInvoke } from "@databricks/appkit-ui/react";
import {
  Button, Card, CardContent, CardHeader, CardTitle,
  Sheet, SheetContent, SheetTrigger, Textarea,
} from "@databricks/appkit-ui/react";
import { Loader2, MessageCircle, Sparkles } from "lucide-react";

// Floating chat button that opens a sheet with a textbox. The textbox posts the
// message to the configured LLM via /api/serving/llm/invoke through AppKit.
// We use the foundation-model chat completion shape: { messages: [...] }.

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface InvokeShape extends Record<string, unknown> {
  messages: ChatMessage[];
}

const SYSTEM_PROMPT = `You are a helpful assistant for the LensIQ dashboard.
The dashboard monitors quick-serve restaurants using computer vision: temperature
sensors, license plate detection, object detection (vehicles, people, pizza,
trucks), and inventory tracking. Keep responses short and pragmatic.`;

export function AIChatButton() {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [open, setOpen] = useState(false);

  const body: InvokeShape = {
    messages: [
      { role: "assistant", content: SYSTEM_PROMPT },
      ...history,
    ],
  };

  const { invoke, loading, error } = useServingInvoke(body, { alias: "llm" });

  const send = useCallback(async () => {
    const userText = draft.trim();
    if (!userText || loading) return;

    const next: ChatMessage[] = [...history, { role: "user", content: userText }];
    setHistory(next);
    setDraft("");

    const result = await invoke({
      messages: [
        { role: "assistant", content: SYSTEM_PROMPT },
        ...next,
      ],
    } satisfies InvokeShape);

    if (!result) return;
    const responseText = _extractMessage(result);
    setHistory((prev) => [...prev, { role: "assistant", content: responseText }]);
  }, [draft, history, invoke, loading]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          className="fixed bottom-6 right-6 rounded-full w-14 h-14 shadow-lg"
          aria-label="Open AI chat"
        >
          <MessageCircle className="w-6 h-6" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[400px] sm:w-[480px] flex flex-col">
        <Card className="flex-1 flex flex-col border-0 shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-red-600" />
              Ask LensIQ
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-3 overflow-hidden">
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {history.length === 0 && (
                <p className="text-sm text-slate-500">
                  Ask about temperatures, alerts, license plate trends, detection counts, or
                  inventory levels. Powered by Databricks Model Serving.
                </p>
              )}
              {history.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                  <div className={
                    "inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm " +
                    (m.role === "user"
                      ? "bg-red-600 text-white"
                      : "bg-slate-100 text-slate-900")
                  }>
                    {m.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Thinking...
                </div>
              )}
              {error && <div className="text-sm text-destructive">{error}</div>}
            </div>

            <div className="flex gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask a question..."
                rows={2}
                disabled={loading}
              />
              <Button onClick={() => void send()} disabled={loading || !draft.trim()}>
                Send
              </Button>
            </div>
          </CardContent>
        </Card>
      </SheetContent>
    </Sheet>
  );
}

// Foundation-model chat completion responses come back in OpenAI shape. Fall
// back to common alternatives for robustness.
function _extractMessage(result: unknown): string {
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const choices = obj.choices as Array<Record<string, unknown>> | undefined;
    const firstMsg = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = firstMsg?.content;
    if (typeof content === "string") return content;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.response === "string") return obj.response;
    if (typeof obj.text === "string") return obj.text;
  }
  return "(empty response)";
}
