#!/usr/bin/env node
import { spawnSync } from "node:child_process";

// Typecheck gate for `npm run typecheck` and `npm run build:client`.
//
// Why this exists instead of a bare `tsc --noEmit`: the @dbx-tools/* packages
// ship raw .ts source as their entrypoints ("types": "index.ts", exports ->
// "./index.ts") rather than the built lib/*.d.ts they also publish. Because
// they resolve to source, `skipLibCheck` cannot skip them and tsc typechecks
// their internals as part of our program. Under noUncheckedIndexedAccess +
// exactOptionalPropertyTypes that surfaces ~50 diagnostics inside code we do
// not own and cannot fix here.
//
// A paths redirect to their lib/ declarations is not an option: those folders
// have no top-level index.d.ts matching the root entrypoints.
//
// So we keep both flags on in tsconfig.json (the editor and every file we
// write are held to them) and drop third-party diagnostics here. Anything
// under server/ or client/ still fails the build.

const IGNORED_PATH = "node_modules/";

const result = spawnSync(
  "tsc",
  ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
  { encoding: "utf8", shell: true },
);

// A diagnostic is a `path(line,col): error TSxxxx: ...` header optionally
// followed by indented continuation lines. Filtering has to drop the whole
// group, not just the header, or the detail lines leak through unattributed.
const DIAGNOSTIC_HEADER = /^\S.*\(\d+,\d+\): (error|warning) TS\d+:/;

const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`
  .split("\n")
  .filter((line) => line.trim() !== "");

const ours = [];
let skipped = 0;
let ignoringGroup = false;

for (const line of lines) {
  if (DIAGNOSTIC_HEADER.test(line)) {
    ignoringGroup = line.startsWith(IGNORED_PATH);
    if (ignoringGroup) skipped += 1;
    else ours.push(line);
    continue;
  }
  // Continuation line: it belongs to whichever diagnostic opened the group.
  if (!ignoringGroup) ours.push(line);
}

for (const line of ours) console.log(line);
if (skipped > 0) {
  console.log(`typecheck: ignored ${skipped} diagnostic(s) in ${IGNORED_PATH} source-shipping deps`);
}

// tsc can also fail for non-diagnostic reasons (bad config, missing binary),
// which produces a non-zero exit with no parseable output. Treat that as fatal
// rather than silently passing.
const hasOurErrors = ours.some((line) => line.includes("error TS"));
process.exit(hasOurErrors || (result.status !== 0 && lines.length === 0) ? 1 : 0);
