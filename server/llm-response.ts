// Shared helpers for picking apart Databricks chat-completions responses.
//
// Every Foundation Model endpoint (Claude, Llama, OpenAI passthrough) on
// the `llm` alias replies with the OpenAI shape:
//
//   { choices: [ { message: { content: string | ContentBlock[] } } ] }
//
// Vision-style responses use the content-block array form so the model
// can return both text and (eventually) image annotations from one
// reply. The first helper here normalises both shapes into a single
// plain string.
//
// Most of our LLM callers want the assistant to emit a JSON object on
// one line. That works ~95% of the time, but Claude occasionally wraps
// the answer in ```json fences, prepends `Output:`, or inserts a stray
// newline before the brace despite the prompt. The second helper here
// is a more forgiving "give me the substring between the first `{`
// and the last `}`" extractor; pair it with JSON.parse on the trimmed
// chat text and the round trip survives those quirks.
//
// Both helpers used to live independently in server.ts and
// vision-detector.ts. Centralising them here is the canonical spot for
// any future LLM call that needs the same normalise + extract pair.

/**
 * Extract the assistant's text from an OpenAI-shaped chat completion
 * response (Databricks Foundation Models / external models proxy).
 * Returns the empty string when the response isn't recognisable, so
 * callers can pipe straight into a JSON parser without null-checking.
 */
export function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => b.text ?? "")
      .join(" ");
  }
  return "";
}

/**
 * Pull the first `{...}` JSON object out of a free-form LLM reply.
 * Tolerates leading/trailing prose, markdown fences, and `Output:`
 * style prefixes that Claude occasionally emits. Returns the input
 * unchanged when no balanced object is found so the caller's
 * JSON.parse still fails with a useful message on truly malformed
 * responses.
 */
export function extractJsonObject(raw: string): string {
  if (!raw) return raw;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}
