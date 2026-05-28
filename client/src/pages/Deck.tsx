// The /deck page is the booth deck (docs/booth-deck.html) rendered as a
// full-bleed iframe, sourced from /api/presenter-content/booth-deck which
// streams the file from the presenter_content UC volume in prod and from
// docs/ on disk in dev. This is intentionally a separate route from
// /info (talk track) so the presenter can context-switch with one click
// in the sidebar instead of clicking a tab inside Info.
//
// The server responds with Cache-Control: no-store, so a browser
// refresh (Cmd+R) is enough to pick up an updated deck - no in-app
// refresh button needed.
//
// Layout note: the AppShell wraps every route in an `px-4 md:px-8 py-4`
// container so the dense data pages have breathing room. The booth deck
// is the opposite, it should fill the entire content column so slides
// are legible from across the booth. We break out of the parent padding
// with negative margins and then size the iframe to the dynamic
// viewport height minus the sticky app header (~65px).
const HEADER_HEIGHT_PX = 65;

export function DeckPage() {
  return (
    <div className="-mx-4 md:-mx-8 -my-4">
      <iframe
        src="/api/presenter-content/booth-deck"
        title="LensIQ booth deck"
        className="block w-full border-0 bg-white"
        style={{ height: `calc(100dvh - ${HEADER_HEIGHT_PX}px)` }}
      />
    </div>
  );
}
