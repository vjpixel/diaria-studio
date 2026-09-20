#!/usr/bin/env tsx
/**
 * jev-ab-report.ts (#8421) — relatório A/B /diaria-edicao vs /diaria-edicao-jev.
 * Uso: npx tsx scripts/jev-ab-report.ts --editions 260901,260902,... [--json]
 * Lógica pura em scripts/lib/jev-ab-report.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { buildAbReport, renderAbReport, type EditionRaw } from "./lib/jev-ab-report.ts";

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

function readJsonl(p: string): Array<{ stage?: number }> | null {
  if (!existsSync(p)) return null;
  const out: Array<{ stage?: number }> = [];
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* linha truncada: ignora */
    }
  }
  return out;
}

export function loadEdition(id: string, dir = editionDir(id)): EditionRaw {
  const internal = join(dir, "_internal");
  const status = readJson<{ rows?: EditionRaw["stageRows"] }>(join(internal, "stage-status.json"));
  return {
    edition: id,
    profile: readJson(join(internal, ".jev-profile.json")),
    editorRequests: readJsonl(join(internal, "editor-requests.jsonl")),
    stageRows: status?.rows ?? null,
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
}

if (isMainModule(import.meta.url)) main();
