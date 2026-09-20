#!/usr/bin/env tsx
/**
 * jev-ab-report.ts (#8421) — relatório A/B /diaria-edicao vs /diaria-edicao-jev.
 * Uso: npx tsx scripts/jev-ab-report.ts --editions 260901,260902,... [--json]
 * Sai com código 1 quando não há nenhuma métrica utilizável.
 * Lógica pura em scripts/lib/jev-ab-report.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { buildAbReport, renderAbReport, type EditionRaw, type Tri } from "./lib/jev-ab-report.ts";

export function readJsonTri(p: string): Tri<unknown> {
  if (!existsSync(p)) return { state: "absent" };
  try {
    return { state: "ok", value: JSON.parse(readFileSync(p, "utf8")) as unknown };
  } catch {
    return { state: "corrupt" };
  }
}

export function readJsonlTri(p: string): Tri<{ rows: unknown[]; invalidLines: number }> {
  if (!existsSync(p)) return { state: "absent" };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { state: "corrupt" };
  }
  const rows: unknown[] = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      invalidLines++;
    }
  }
  return { state: "ok", value: { rows, invalidLines } };
}

export function loadEdition(id: string, dir = editionDir(id)): EditionRaw {
  const internal = join(dir, "_internal");
  const status = readJsonTri(join(internal, "stage-status.json"));
  const stageRows: Tri<unknown> =
    status.state === "ok"
      ? typeof status.value === "object" && status.value !== null && "rows" in status.value
        ? { state: "ok", value: (status.value as { rows: unknown }).rows }
        : { state: "corrupt" }
      : status;
  return {
    edition: id,
    exists: existsSync(dir),
    profile: readJsonTri(join(internal, ".jev-profile.json")),
    editorRequests: readJsonlTri(join(internal, "editor-requests.jsonl")),
    stageRows,
    dedupArtifact: readJsonTri(join(internal, "dedup-grayzone-jev.json")),
  };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const ids = (values["editions"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    console.error("Uso: npx tsx scripts/jev-ab-report.ts --editions AAMMDD,AAMMDD,... [--json]");
    process.exit(2);
  }
  const report = buildAbReport(ids.map((id) => loadEdition(id)));
  console.log(flags.has("json") ? JSON.stringify(report, null, 2) : renderAbReport(report));
  if (report.usable === 0) {
    console.error("nenhuma edição com métrica utilizável");
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
