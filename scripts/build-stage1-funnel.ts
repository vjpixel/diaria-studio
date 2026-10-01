#!/usr/bin/env tsx
/**
 * scripts/build-stage1-funnel.ts (#9372)
 *
 * Inspeção/backfill do manifesto do funil do Stage 1
 * (`_internal/stage1-funnel.json`, ver `scripts/lib/stage1-funnel.ts`).
 *
 * O caminho normal NÃO é este script: o manifesto e o snapshot
 * `01-approved.gate1.json` são gravados mecanicamente no write do sentinel do
 * Stage 1 (`pipeline-sentinel.ts write --step 1`). Este CLI serve pra:
 *
 * - ler o funil de uma edição (padrão: imprime, não escreve nada);
 * - `--write`: backfill de edição antiga sem manifesto (write-once — nunca
 *   sobrescreve um manifesto existente). Marca `trigger: "backfill"`: os
 *   `tmp-*` podem já ter sido sobrescritos e o gate 1 vem do `01-approved.json`
 *   vivo (reescrito no Stage 4), então é reconstrução, não registro. NUNCA
 *   cria o `01-approved.gate1.json` — congelar o arquivo vivo depois do
 *   Stage 4 gravaria como "gate 1" um estado que não é.
 *
 * Uso:
 *   npx tsx scripts/build-stage1-funnel.ts --edition 260930 [--json] [--write] [--editions-dir data/editions]
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { FUNNEL_MANIFEST_FILE, buildStage1FunnelFromDisk, type Stage1FunnelManifest } from "./lib/stage1-funnel.ts";

const ROOT = resolve(import.meta.dirname, "..");

export function formatFunnel(m: Stage1FunnelManifest): string {
  const lines: string[] = [];
  lines.push(`[stage1-funnel] edição ${m.edition} — ${m.totals.urls} URLs, ${m.totals.approved} aprovadas no gate 1, ${m.totals.dropped} saíram (${m.totals.ambiguous} com ponto de saída ambíguo)`);
  lines.push(`  trigger=${m.trigger}  gate1_frozen=${m.gate1_frozen}`);
  lines.push("  etapas:");
  for (const s of m.stages) {
    const flags = [!s.present ? "AUSENTE" : "", s.stale_order ? "STALE (reescrito depois)" : "", s.entered_mid_funnel > 0 ? `+${s.entered_mid_funnel} entraram no meio` : ""].filter(Boolean).join(", ");
    lines.push(`    ${s.id.padEnd(18)} ${String(s.count ?? "-").padStart(5)}  saíram aqui: ${String(m.totals.by_exit_stage[s.id] ?? 0).padStart(4)}${flags ? `  [${flags}]` : ""}`);
  }
  if (m.warnings.length > 0) {
    lines.push("  avisos:");
    for (const w of m.warnings) lines.push(`    - ${w}`);
  }
  return lines.join("\n");
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const edition = values["edition"];
  if (!edition) {
    console.error("Uso: build-stage1-funnel.ts --edition AAMMDD [--json] [--write] [--editions-dir DIR]");
    process.exit(2);
  }
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const editionDir = enumerateEditionDirs(editionsRoot).get(edition);
  if (!editionDir) {
    console.error(`edição ${edition} não encontrada em ${editionsRoot}`);
    process.exit(1);
  }
  const manifest = buildStage1FunnelFromDisk(editionDir, edition, { trigger: "backfill" });
  console.log(flags.has("json") ? JSON.stringify(manifest, null, 2) : formatFunnel(manifest));
  if (flags.has("write")) {
    const out = resolve(editionDir, FUNNEL_MANIFEST_FILE);
    if (existsSync(out)) {
      console.error(`${FUNNEL_MANIFEST_FILE} já existe — imutável, nada escrito.`);
      return;
    }
    writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.error(`backfill gravado em ${out}`);
  }
}

if (isMainModule(import.meta.url)) main();
