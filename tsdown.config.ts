import { defineConfig } from "tsdown";

// Server bundle configuration.
//
// The @dbx-tools/* packages (appkit, appkit-mastra, email, and their
// @dbx-tools/* transitive deps) publish RAW TypeScript - their package
// "main"/"types" point at index.ts, not a compiled .js. tsdown externalizes
// node_modules by default, so a plain build leaves `import "@dbx-tools/..."`
// in the output and Node then tries to load index.ts at runtime and throws
// ERR_UNKNOWN_FILE_EXTENSION for ".ts". We therefore inline (and transpile)
// the whole @dbx-tools scope into the bundle.
//
// Everything else stays external and is loaded from node_modules at runtime:
// those packages ship compiled JS and some carry native addons (e.g.
// @mastra/fastembed -> @anush008/tokenizers *.node), which the bundler cannot
// and must not inline. The predicate below bundles only relative/absolute
// paths (the app's own source) and @dbx-tools specifiers; every other bare
// package specifier is treated as external. Entry + out-dir come from the
// build:server CLI flags.
export default defineConfig({
  // Force @dbx-tools/* to be bundled even though they're in package.json
  // dependencies (which tsdown would otherwise auto-externalize).
  noExternal: [/^@dbx-tools\//],
  // Keep every other bare specifier external. Without this, the transitive
  // deps @dbx-tools pulls in (@mastra/*, @anush008/* native addons, pg,
  // express, ...) are NOT in this package's dependencies, so tsdown's default
  // rule would try to bundle them - and the native *.node files are
  // unloadable. Only relative/absolute paths (the app's own source) and the
  // @dbx-tools scope above are inlined.
  external(id) {
    if (id === "@dbx-tools" || id.startsWith("@dbx-tools/")) return false;
    return !(id.startsWith(".") || id.startsWith("/"));
  },
});
