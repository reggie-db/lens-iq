import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

// Unity Catalog target resolution + file-based query rendering.
//
// Everything UC-related (the demo tables, the frame volumes, the Lakebase
// schema name) hangs off a single catalog/schema pair. Both the server's
// direct SQL (UC_TABLE below) and the analytics plugin's file-based queries
// in config/queries must agree on that pair. Resolving from env at module
// load means swapping workspaces is "set DATABRICKS_CATALOG /
// DATABRICKS_SCHEMA + restart" - no rebuild, no source edit.
//
// The analytics plugin reads config/queries/*.sql verbatim and cannot bind
// an identifier (catalog.schema.table) as a `:param`. So the queries are
// authored as *.sql.tmpl templates with `${catalog}` / `${schema}`
// placeholders and rendered to sibling *.sql files at boot via
// renderQueryFiles(). The rendered *.sql are git-ignored; the templates are
// the source of truth. This keeps the runtime catalog/schema fully
// parameterized everywhere instead of baked into the build.

const LOG_PREFIX = "[uc]";

// Defaults mirror databricks.yml::variables.{catalog,schema}. app.yaml / .env
// override them at runtime; these only apply when neither env var is set.
const DEFAULT_CATALOG = "reggie_pierce_aws_catalog";
const DEFAULT_SCHEMA = "lens_iq";

const QUERIES_DIR = resolvePath(process.cwd(), "config/queries");
const TEMPLATE_SUFFIX = ".sql.tmpl";

export const UC_CATALOG = process.env.DATABRICKS_CATALOG ?? DEFAULT_CATALOG;
export const UC_SCHEMA = process.env.DATABRICKS_SCHEMA ?? DEFAULT_SCHEMA;

// Fully-qualify a table name against the resolved catalog/schema. Used by
// every server-side direct SQL statement so no literal catalog identifier is
// baked into the build.
export const UC_TABLE = (name: string): string =>
  `${UC_CATALOG}.${UC_SCHEMA}.${name}`;

// Render `${catalog}` / `${schema}` placeholders in one template body.
function _renderTemplate(body: string): string {
  return body
    .replaceAll("${catalog}", UC_CATALOG)
    .replaceAll("${schema}", UC_SCHEMA);
}

// Render every config/queries/*.sql.tmpl into a sibling *.sql with the
// runtime catalog/schema substituted in. Runs once at boot, before the
// analytics plugin serves its first request (which reads the *.sql from
// disk). Idempotent: re-running overwrites the rendered files with the same
// content unless the env target changed.
export async function renderQueryFiles(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(QUERIES_DIR);
  } catch (err) {
    console.error(`${LOG_PREFIX} cannot read queries dir ${QUERIES_DIR}: ${(err as Error).message}`);
    return;
  }

  const templates = entries.filter((f) => f.endsWith(TEMPLATE_SUFFIX));
  if (templates.length === 0) {
    console.warn(`${LOG_PREFIX} no ${TEMPLATE_SUFFIX} templates found in ${QUERIES_DIR}`);
    return;
  }

  await Promise.all(
    templates.map(async (tmpl) => {
      const src = resolvePath(QUERIES_DIR, tmpl);
      const dst = resolvePath(QUERIES_DIR, tmpl.slice(0, -TEMPLATE_SUFFIX.length) + ".sql");
      const body = await readFile(src, "utf8");
      await writeFile(dst, _renderTemplate(body), "utf8");
    }),
  );

  console.log(
    `${LOG_PREFIX} rendered ${templates.length} query template(s) for ${UC_CATALOG}.${UC_SCHEMA}`,
  );
}
