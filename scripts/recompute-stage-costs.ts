/**
 * recompute-stage-costs.ts (#9122)
 *
 * Re-deriva o `cost_usd` já gravado em `_internal/stage-status.json` das
 * edições de um mês (default: setembro/2026, `2609`) com a tabela ATUAL de
 * `scripts/lib/pricing.ts` (#9003 — Sonnet 2/10, Opus 5.5 4/20 com leitura de
 * cache 0,05x). Os valores gravados antes do #9003 usaram a tabela antiga e
 * superestimam o custo.
 *
 * Fonte dos tokens: os MESMOS transcripts locais que `capture-stage-usage.ts`
 * leu na captura original (`scripts/lib/session-transcript.ts`). O
 * `stage-status.json` só guarda `tokens_in`/`tokens_out` agregados (cache
 * misturado, modelos misturados), então o breakdown por chamada precisa vir
 * do transcript. O id da sessão não é persistido na linha — por isso a sessão
 * é IDENTIFICADA por casamento exato: a sessão cujo total na janela
 * `[start, end]` do stage bate `tokens_in` E `tokens_out` gravados. Sem
 * casamento único, a linha é pulada com motivo (nunca chuta).
 *
 * O que NÃO é recalculado (pulado com motivo):
 *   - `session_filter: "cli_json"` (#8560) — o custo veio do `total_cost_usd`
 *     do próprio CLI, não desta tabela; não há breakdown por chamada salvo.
 *   - linhas sem `start`/`end`/`cost_usd`/`tokens_*`.
 *   - transcripts ausentes/rotacionados (tokens não batem mais).
 *
 * Idempotente: recalcula sempre dos tokens brutos; rodar 2x produz o mesmo
 * valor. Dry-run por padrão — `--apply` grava (`stage-status.json` +
 * `stage-status.md` via `saveDoc`, que re-renderiza os totais).
 *
 * Uso:
 *   npx tsx scripts/recompute-stage-costs.ts                  # dry-run, 2609
 *   npx tsx scripts/recompute-stage-costs.ts --month 2609 --transcripts-dir ~/.claude/projects/-home-vjpixel-diaria-studio
 *   npx tsx scripts/recompute-stage-costs.ts --apply
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { loadDoc, saveDoc, applyUpdate, type StageRow } from "./update-stage-status.ts";
import { collectUsageInWindow, resolveTranscriptsDir, type UsageEntry } from "./lib/session-transcript.ts";
import { editionDateMs, estimateCallCostUsd } from "./lib/pricing.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Sessão dona de uma entrada: `{sid}.jsonl` ou `{sid}/subagents/agent-x.jsonl`. */
export function owningSessionId(sessionFile: string): string {
  const parent = dirname(sessionFile);
  if (basename(parent) === "subagents") return basename(dirname(parent));
  return basename(sessionFile, ".jsonl");
}

export type RecomputeOutcome =
  | { status: "recomputed"; oldCost: number; newCost: number; sessionId: string | null; costPartial: boolean }
  | { status: "skipped"; reason: string };

/**
 * Núcleo puro: dado o row gravado e TODAS as entradas de usage da janela
 * (todas as sessões), identifica a(s) entrada(s) que produziram o número
 * gravado e recalcula o custo com a tabela atual.
 */
export function recomputeRowCost(row: StageRow, windowEntries: UsageEntry[], fallbackDateMs: number | null): RecomputeOutcome {
  if (row.cost_usd == null) return { status: "skipped", reason: "no_cost" };
  if (row.session_filter === "cli_json") return { status: "skipped", reason: "cli_json_priced_by_cli" };
  if (row.tokens_in == null || row.tokens_out == null) return { status: "skipped", reason: "no_tokens" };

  const sum = (es: UsageEntry[]) => {
    let tin = 0;
    let tout = 0;
    for (const e of es) {
      tin += e.inputTokens + e.cacheCreationInputTokens + e.cacheReadInputTokens;
      tout += e.outputTokens;
    }
    return { tin, tout };
  };
  const matches = (es: UsageEntry[]) => {
    const s = sum(es);
    return es.length > 0 && s.tin === row.tokens_in && s.tout === row.tokens_out;
  };

  let chosen: UsageEntry[] | null = null;
  let sessionId: string | null = null;
  if (row.session_filter === "all_sessions") {
    if (matches(windowEntries)) chosen = windowEntries;
  } else {
    const bySession = new Map<string, UsageEntry[]>();
    for (const e of windowEntries) {
      const sid = owningSessionId(e.sessionFile);
      const list = bySession.get(sid) ?? [];
      list.push(e);
      bySession.set(sid, list);
    }
    const hits = [...bySession.entries()].filter(([, es]) => matches(es));
    if (hits.length > 1) return { status: "skipped", reason: "ambiguous_session_match" };
    if (hits.length === 1) [sessionId, chosen] = [hits[0][0], hits[0][1]];
  }
  if (!chosen) return { status: "skipped", reason: "tokens_not_matched_in_transcripts" };

  let cost = 0;
  let costPartial = false;
  for (const e of chosen) {
    const ts = new Date(e.timestamp).getTime();
    const c = estimateCallCostUsd(
      {
        input_tokens: e.inputTokens,
        output_tokens: e.outputTokens,
        cache_creation_input_tokens: e.cacheCreationInputTokens,
        cache_read_input_tokens: e.cacheReadInputTokens,
      },
      e.model,
      Number.isFinite(ts) ? ts : fallbackDateMs,
    );
    if (c === null) {
      costPartial = true;
      continue;
    }
    cost += c;
  }
  return {
    status: "recomputed",
    oldCost: row.cost_usd,
    newCost: Math.round(cost * 1_000_000) / 1_000_000,
    sessionId,
    costPartial,
  };
}

/** Lista diretórios de edição do mês (`data/editions/{YYMM}/{AAMMDD}`). */
export function listMonthEditionDirs(editionsRoot: string, month: string): string[] {
  const monthDir = resolve(editionsRoot, month);
  if (!existsSync(monthDir)) return [];
  return readdirSync(monthDir)
    .filter((n) => /^\d{6}$/.test(n) && n.startsWith(month))
    .sort()
    .map((n) => resolve(monthDir, n));
}

function main(): void {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const month = values["month"] ?? "2609";
  const apply = flags.has("apply");
  const transcriptsDir = values["transcripts-dir"] ?? resolveTranscriptsDir(process.cwd());
  const editionsRoot = resolve(ROOT, values["editions-root"] ?? "data/editions");

  let totalOld = 0;
  let totalNew = 0;
  const report: unknown[] = [];
  let allEntries: UsageEntry[] | undefined;
  for (const dir of listMonthEditionDirs(editionsRoot, month)) {
    const editionId = basename(dir);
    if (!existsSync(resolve(dir, "_internal", "stage-status.json"))) continue;
    let doc = loadDoc(dir, editionId);
    let changed = false;
    for (const row of doc.rows) {
      if (row.cost_usd == null) continue;
      let outcome: RecomputeOutcome;
      if (!row.start || !row.end) outcome = { status: "skipped", reason: "no_window" };
      else if (row.session_filter === "cli_json") outcome = recomputeRowCost(row, [], null);
      else {
        // Parse dos transcripts UMA vez pro mês inteiro (re-parsear por row
        // é O(rows × transcripts) e leva minutos); filtra a janela em memória.
        allEntries ??= collectUsageInWindow(transcriptsDir, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", {}).entries;
        const s = new Date(row.start).getTime();
        const e = new Date(row.end).getTime();
        const inWindow = allEntries.filter((x) => {
          const t = new Date(x.timestamp).getTime();
          return t >= s && t <= e;
        });
        outcome = recomputeRowCost(row, inWindow, editionDateMs(editionId));
      }
      report.push({ edition: editionId, stage: row.stage, ...outcome });
      if (outcome.status === "recomputed") {
        totalOld += outcome.oldCost;
        totalNew += outcome.newCost;
        if (outcome.newCost !== row.cost_usd) {
          doc = applyUpdate(doc, { stage: row.stage, status: row.status, cost_usd: outcome.newCost });
          changed = true;
        }
      }
    }
    if (apply && changed) saveDoc(dir, doc);
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        month,
        transcripts_dir: transcriptsDir,
        rows: report,
        recomputed_total_old_usd: Math.round(totalOld * 100) / 100,
        recomputed_total_new_usd: Math.round(totalNew * 100) / 100,
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) main();
