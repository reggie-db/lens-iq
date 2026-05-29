import type { ErrorRequestHandler, RequestHandler } from "express";
import { z } from "zod";
import { sendEndpointError } from "./serving-invoke.ts";

// Shared server helpers. Adding logic here is preferred over copy-pasting
// it across routes; see .cursor/rules/dry-this-repo.mdc for the playbook.
//
// Nothing in this file opens a database connection - every Postgres
// statement still goes through `appkit.lakebase.query(...)` so the
// AppKit pool + OAuth refresh stays the only connection path.

// ─── HTTP errors ──────────────────────────────────────────────────────

// Thrown by routes to send a non-200 response with a typed status. The
// global error middleware turns it into `{error: message}` at the right
// status. Use this instead of `res.status(...).json({error: ...}); return;`
// so async control flow stays linear and the middleware owns the envelope
// shape.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

// Express 5 forwards async throws to the next error middleware
// automatically. Mount this once at the end of the route table and
// every route can simply `throw` instead of catching+rendering its
// own 500.
//
//   - HttpError -> its own status + message
//   - EndpointNotDeployedError (via sendEndpointError) -> 503 envelope
//   - ZodError -> 400 with the offending field path
//   - anything else -> 500 with the message
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (sendEndpointError(res, err)) return;
  if (err instanceof z.ZodError) {
    const msg = err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    res.status(400).json({ error: msg });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
};

// ─── asyncRoute ───────────────────────────────────────────────────────

// Per-route schema bundle. Any subset of body / query / params can be
// validated; missing entries fall through untyped (the handler still
// sees `unknown` for those).
export interface RouteSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

// Inferred-type helper for the handler's first arg. Each key is the
// parsed value when its schema is supplied, otherwise `unknown`.
type ParsedInput<S extends RouteSchemas> = {
  body: S["body"] extends z.ZodType ? z.infer<S["body"]> : unknown;
  query: S["query"] extends z.ZodType ? z.infer<S["query"]> : unknown;
  params: S["params"] extends z.ZodType ? z.infer<S["params"]> : unknown;
};

// Wraps an async handler with input validation and a single try/catch
// that forwards anything thrown to the global error middleware. If
// the handler returns a non-undefined value it's JSON-encoded; if the
// handler writes to `res` directly (streaming, redirect, etc.) return
// undefined and it stays untouched.
export function asyncRoute<S extends RouteSchemas, R>(
  schemas: S,
  handler: (input: ParsedInput<S>, req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<R>,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const parsed = {
        body: schemas.body ? schemas.body.parse(req.body) : req.body,
        query: schemas.query ? schemas.query.parse(req.query) : req.query,
        params: schemas.params ? schemas.params.parse(req.params) : req.params,
      } as ParsedInput<S>;
      const result = await handler(parsed, req, res);
      if (!res.headersSent && result !== undefined) {
        res.json(result);
      }
    } catch (err) {
      next(err);
    }
  };
}

// ─── Postgres helpers ─────────────────────────────────────────────────

// Builds a multi-row INSERT statement with pg-style `$N` placeholders
// suitable for `appkit.lakebase.query(sql, params)`. Pulled out so the
// four (and counting) batch-insert routes don't each re-build the
// placeholder bookkeeping by hand.
//
//   const { sql, params } = buildBatchInsert(
//     `${APP_SCHEMA}.guest_counts`,
//     ["source_id", "zone", "person_count", "store_id"],
//     batch,
//   );
//   await appkit.lakebase.query(sql, params);
//
// Missing keys on a row become NULL. The caller is responsible for
// having already validated the rows (use zod) - this helper does not
// do type coercion.
export function buildBatchInsert<T extends Record<string, unknown>>(
  table: string,
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): { sql: string; params: unknown[] } {
  if (rows.length === 0) {
    throw new HttpError(400, "buildBatchInsert: rows must be non-empty");
  }
  const params: unknown[] = [];
  const valueRows: string[] = [];
  for (const row of rows) {
    const slots: string[] = [];
    for (const col of columns) {
      params.push(row[col] ?? null);
      slots.push(`$${params.length}`);
    }
    valueRows.push(`(${slots.join(", ")})`);
  }
  return {
    sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valueRows.join(", ")}`,
    params,
  };
}

// ─── Misc ─────────────────────────────────────────────────────────────

// Cap on inline data-URL blobs persisted into Postgres. ~750KB matches
// the TOAST threshold so the column stays in the main heap; legit
// thumbnails (plate crops, face frames, enrolled photos) are well
// under this. Anything larger comes through as null so a misbehaving
// client can't blow up the row.
export const PG_INLINE_BLOB_MAX = 750_000;

export function inlineBlob(
  value: string | null | undefined,
  max: number = PG_INLINE_BLOB_MAX,
): string | null {
  if (typeof value !== "string") return null;
  return value.length <= max ? value : null;
}

// Race-safe one-shot async memoizer. Concurrent first-callers all await
// the same in-flight promise; on rejection the cache clears so the next
// caller retries from scratch. Used as the bootstrap idiom for every
// `_ensureXTable()` helper:
//
//   const _ensureFoo = onceAsync(async () => {
//     await _ensureAppSchema();
//     await _runIdempotentDdl(`CREATE TABLE IF NOT EXISTS foo (...)`);
//   });
//
// Functionally equivalent to sindresorhus/p-once but kept local because
// p-once isn't on the Databricks npm proxy.
export function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const p = fn();
    pending = p.catch((err) => {
      pending = null;
      throw err;
    }) as Promise<T>;
    return pending;
  };
}
