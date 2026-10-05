#!/usr/bin/env npx tsx
/**
 * demote-generic-study-highlights.ts (#9462, decisão do editor de 05/10/2026)
 *
 * Stage 1 §1u-quinquies — roda sobre `_internal/01-categorized.json` logo
 * depois do rebaixamento por MESMO FATO (§1u-quater, #9100) e ANTES do render
 * do MD (§1v). Penalidade de SELEÇÃO de destaque para estudo/estatística ou
 * case corporativo genérico sem fato novo concreto (classificador em
 * `scripts/lib/generic-study-penalty.ts`): o candidato sai do top-3, o
 * próximo sobe, e o item continua em `highlights` (rank 4+) e no bucket dele
 * — nunca é descartado; o editor pode promovê-lo de volta.
 *
 * Flag: `platform.config.json` → `selection.generic_study_penalty.enabled`.
 *   - `true`  → aplica (reordena o JSON) e grava o log com `applied: true`.
 *   - `false` / ausente → modo sombra: NÃO reordena, só grava o log com
 *     `applied: false` (o gate 4 mostra "seria rebaixado"), para o editor
 *     acompanhar o que a regra faria antes de ligá-la.
 *   - config ausente → desligado + warn em `data/run-log.jsonl`. Default
 *     resolvido pela raiz do repo (não pelo cwd).
 *   - erro lendo config/JSON/classificando → comportamento atual (nada muda),
 *     warn em `data/run-log.jsonl`, exit 0 (fail-soft).
 *
 * Uso:
 *   npx tsx scripts/demote-generic-study-highlights.ts \
 *     --categorized data/editions/2610/261005/_internal/01-categorized.json \
 *     [--edition 261005] [--config platform.config.json] \
 *     [--out-log .../_internal/01-generic-study-demoted.json] [--dry-run]
 *
 * Stdout: JSON `{ applied, demoted, kept, notes[] }`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "./lib/exit-handler.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  demoteGenericStudyHighlights,
  formatGenericStudyNote,
  type GenericStudyHighlight,
} from "./lib/generic-study-penalty.ts";

type Rec = Record<string, unknown>;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Default resolvido pela raiz do repo, não pelo cwd (review da PR #9667). */
export const DEFAULT_CONFIG_PATH = resolve(ROOT, "platform.config.json");

export interface GenericStudyPenaltyConfig {
  enabled: boolean;
  /** true quando o arquivo de config não existe (o caller avisa no run-log). */
  missing?: boolean;
}

/**
 * Lê `selection.generic_study_penalty` de `platform.config.json`. Lança em
 * JSON malformado (o caller trata como fail-soft: comportamento atual + warn);
 * arquivo ou chave ausente → desligado.
 */
export function readGenericStudyPenaltyConfig(configPath: string): GenericStudyPenaltyConfig {
  if (!existsSync(configPath)) return { enabled: false, missing: true };
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
    selection?: { generic_study_penalty?: { enabled?: unknown } };
  };
  return { enabled: cfg.selection?.generic_study_penalty?.enabled === true };
}

export interface RunResult {
  applied: boolean;
  demoted: number;
  kept: number;
  notes: string[];
  error?: string;
}

/**
 * Decide se o log é regravado.
 *  - Flag DESLIGADA: sempre — o JSON não foi reordenado, então o rerun
 *    reproduz fielmente o que a regra faria; manter um log antigo mostraria no
 *    gate 4 um "seria rebaixado" de candidatos que já não estão lá.
 *  - Flag LIGADA com rebaixamento/aviso: sempre.
 *  - Flag LIGADA sem nada (resume): o JSON já reordenado não reproduz o
 *    rebaixamento, então o log anterior é preservado SÓ se for de modo
 *    aplicado e todas as URLs dele ainda estiverem nos highlights desta
 *    edição; senão (log de sombra, de outra seleção, ilegível) é regravado.
 */
function shouldWriteLog(outLog: string, enabled: boolean, changes: number, highlights: GenericStudyHighlight[]): boolean {
  if (!enabled || changes > 0 || !existsSync(outLog)) return true;
  try {
    const prev = JSON.parse(readFileSync(outLog, "utf8")) as { applied?: unknown; demoted?: unknown; kept?: unknown };
    if (prev.applied !== true) return true;
    const urls = [...(Array.isArray(prev.demoted) ? prev.demoted : []), ...(Array.isArray(prev.kept) ? prev.kept : [])].map(
      (d) => (d as { url?: unknown }).url,
    );
    if (urls.length === 0) return true;
    const current = new Set(highlights.map((h) => h.url ?? h.article?.url));
    return !urls.every((u) => typeof u === "string" && current.has(u));
  } catch {
    return true;
  }
}

/**
 * Núcleo testável: lê config + categorized, aplica (ou simula) e grava.
 * Nunca lança — qualquer erro vira `{ error }` com o JSON intocado.
 */
export function runGenericStudyPenalty(opts: {
  categorizedPath: string;
  configPath: string;
  outLog?: string;
  dryRun?: boolean;
  edition?: string | null;
  rootDir?: string;
}): RunResult {
  try {
    const { enabled, missing } = readGenericStudyPenaltyConfig(opts.configPath);
    if (missing) {
      logEvent(
        {
          edition: opts.edition ?? null,
          stage: 1,
          agent: "demote-generic-study-highlights",
          level: "warn",
          message: `config ${opts.configPath} não encontrada — penalidade de estudo/case genérico (#9462) segue desligada (modo sombra)`,
        },
        opts.rootDir,
      );
    }
    const categorized = JSON.parse(readFileSync(opts.categorizedPath, "utf8")) as Rec;
    const highlights = (Array.isArray(categorized.highlights) ? categorized.highlights : []) as GenericStudyHighlight[];
    const result = demoteGenericStudyHighlights(highlights);

    const notes = result.demoted.map((d) => formatGenericStudyNote(d, enabled));
    for (const k of enabled ? result.kept : []) {
      notes.push(`⚠️ ESTUDO/CASE GENÉRICO — "${k.title}" (D${k.rank}) mantido: ${k.reason}.`);
    }

    if (!opts.dryRun) {
      if (enabled && result.demoted.length > 0) {
        writeFileSync(opts.categorizedPath, JSON.stringify({ ...categorized, highlights: result.highlights }, null, 2) + "\n", "utf8");
      }
      if (opts.outLog && shouldWriteLog(opts.outLog, enabled, result.demoted.length + result.kept.length, highlights)) {
        writeFileSync(
          opts.outLog,
          JSON.stringify({ applied: enabled, demoted: result.demoted, kept: result.kept }, null, 2) + "\n",
          "utf8",
        );
      }
    }
    return { applied: enabled, demoted: result.demoted.length, kept: result.kept.length, notes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent(
      {
        edition: opts.edition ?? null,
        stage: 1,
        agent: "demote-generic-study-highlights",
        level: "warn",
        message: `penalidade de estudo/case genérico (#9462) falhou — seleção segue sem ela: ${msg}`,
      },
      opts.rootDir,
    );
    return { applied: false, demoted: 0, kept: 0, notes: [], error: msg };
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const dryRun = rawArgv.includes("--dry-run");
  const args = parseCliArgs(rawArgv.filter((a) => a !== "--dry-run")).values;
  const categorizedPath = args["categorized"];
  if (!categorizedPath) {
    console.error(
      "Uso: demote-generic-study-highlights.ts --categorized <01-categorized.json> [--edition AAMMDD] " +
        "[--config platform.config.json] [--out-log <path>] [--dry-run]",
    );
    process.exit(1);
  }
  const res = runGenericStudyPenalty({
    categorizedPath,
    configPath: args["config"] ? resolve(args["config"]) : DEFAULT_CONFIG_PATH,
    outLog: args["out-log"],
    dryRun,
    edition: args["edition"] ?? null,
  });
  for (const n of res.notes) console.error(`[demote-generic-study] ${n}`);
  if (res.error) console.error(`[demote-generic-study] ⚠️ fail-soft: ${res.error}`);
  else if (res.notes.length === 0) console.error("[demote-generic-study] ✓ nenhum estudo/case genérico no top-3.");
  process.stdout.write(JSON.stringify(res) + "\n");
}

if (isMainModule(import.meta.url)) {
  runMain(main);
}
