#!/usr/bin/env node
/**
 * aquisicao-reconcile.ts (#5734)
 *
 * Preparatório da reconciliação "conversão reportada por painel × cadastros
 * reais" do teste de 3 canais (#5524). Método decidido pelo editor em
 * 21/08/2026 (comentário na issue): **expand[]=stats na API oficial da
 * Beehiiv — coorte real por assinante, sem segmentos novos**.
 *
 * Dois subcomandos:
 *
 *   baseline --from AAAA-MM-DD --to AAAA-MM-DD [--out <path>]
 *     Drena TODAS as subscriptions da publicação via `fetchAllSubscribers`
 *     (cohort-engagement.ts — já usa `expand[]=stats&expand[]=utm_params`,
 *     paginação + guard anti-truncamento #2457) e agrega a coorte real de
 *     cadastros cujo `created` cai na janela [from, to] (to EXCLUSIVO),
 *     agrupados pelo mesmo group key do projeto (`resolveGroupKey`:
 *     utm_source normalizado, fallback referring_site). Grava JSON e imprime
 *     resumo. NUNCA imprime a API key; NUNCA grava PII além do que o próprio
 *     store da Beehiiv já contém (aqui: só contagens agregadas).
 *
 *   factor --baseline <path> --panel <path> [--out <path>]
 *     Puro (sem rede): cruza a coorte real com o input dos painéis
 *     (template: docs/aquisicao-reconcile-panel-template.json) e calcula o
 *     FATOR DE SUPERESTIMAÇÃO por canal = reported_conversions / coorte_real.
 *     Canal sem coorte na janela → fator null + status "sem-coorte"
 *     (nunca divisão por zero, nunca 0 silencioso).
 *
 * A janela só tem dado depois do D0 da campanha (≤24/08, marcador
 * aguardando-ate 2026-08-28 na issue). Este script existe para o dia 28/08
 * ser um comando, não um projeto.
 *
 * @pure aggregateBaseline/computeFactor — I/O só nos subcomandos CLI.
 */
import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  fetchAllSubscribers,
  resolveGroupKey,
  type EngagementSubscriber,
} from "./cohort-engagement.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "AAAA-MM-DD" → epoch segundos UTC 00:00. Idempotente ao parser do
 * cohort-engagement (#4556: valida ida-e-volta contra rolagem de mês/dia). */
export function dayToEpochSeconds(day: string, flag: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? "").trim());
  if (!m) throw new Error(`${flag} inválido: "${day}" (esperado AAAA-MM-DD)`);
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    throw new Error(`${flag} inválido: "${day}" (data não existe)`);
  }
  return Math.floor(ms / 1000);
}

export interface BaselineFile {
  generated_at: string;
  window: { from: string; to: string };
  /** Janela efetiva em epoch (to EXCLUSIVO). */
  window_epoch: { from: number; to_exclusive: number };
  total: number;
  /** Coorte real por canal (group key = utm_source/referring_site normalizado). */
  per_channel: Record<string, number>;
  /** Cadastros por dia UTC (YYYY-MM-DD). */
  per_day: Record<string, number>;
  method: string;
}

/** Agrega a coorte real de cadastros na janela [from, to) agrupada por canal.
 *
 * @pure
 */
export function aggregateBaseline(subs: EngagementSubscriber[], fromIso: string, toIso: string): BaselineFile {
  const from = dayToEpochSeconds(fromIso, "--from");
  // `--to` é o ÚLTIMO dia da janela (inclusivo no discurso do editor), então o
  // corte exclusivo é o início do dia SEGUINTE.
  const toDate = new Date(dayToEpochSeconds(toIso, "--to") * 1000);
  const toExclusive = Math.floor(toDate.getTime() / 1000) + 86_400;

  const per_channel: Record<string, number> = {};
  const per_day: Record<string, number> = {};
  let total = 0;
  for (const sub of subs) {
    // #5734: Number.isFinite e não só typeof — NaN/Infinity passam pelo typeof
    // "number" e explodiriam no toISOString() abaixo (achado do próprio teste).
    if (typeof sub.created !== "number" || !Number.isFinite(sub.created)) continue;
    if (sub.created < from || sub.created >= toExclusive) continue;
    const key = resolveGroupKey(sub) || "__none__";
    per_channel[key] = (per_channel[key] ?? 0) + 1;
    const day = new Date(sub.created * 1000).toISOString().slice(0, 10);
    per_day[day] = (per_day[day] ?? 0) + 1;
    total++;
  }
  return {
    generated_at: new Date().toISOString(),
    window: { from: fromIso, to: toIso },
    window_epoch: { from, to_exclusive: toExclusive },
    total,
    per_channel,
    per_day,
    method: "beehiv-api expand[]=stats+utm_params, coorte real por assinante (decisão editor 21/08/2026, #5734)",
  };
}

export interface PanelInput {
  window?: { from?: string; to?: string };
  channels: Record<string, { reported_conversions: number; cohort_key?: string }>;
}

export interface FactorRow {
  channel: string;
  cohort_key: string;
  reported_conversions: number;
  coorte_real: number;
  /** reported / coorte — null quando coorte 0 (sem dado, nunca infinito). */
  fator_superestimacao: number | null;
  status: "ok" | "sem-coorte";
}

export interface FactorResult {
  rows: FactorRow[];
  /** Canais presentes na coorte mas ausentes no painel — para auditoria. */
  canais_coorte_sem_painel: string[];
}

/** Cruza baseline × painel e calcula o fator por canal.
 *
 * @pure
 */
export function computeFactor(baseline: BaselineFile, panel: PanelInput): FactorResult {
  const channels = panel.channels ?? {};
  const rows: FactorRow[] = [];
  for (const [channel, spec] of Object.entries(channels)) {
    const cohortKey = spec.cohort_key ?? channel;
    const real = baseline.per_channel[cohortKey] ?? 0;
    const reported = Number(spec.reported_conversions);
    if (!Number.isFinite(reported)) {
      throw new Error(`panel.channels.${channel}.reported_conversions deve ser número (recebido: ${spec.reported_conversions})`);
    }
    rows.push({
      channel,
      cohort_key: cohortKey,
      reported_conversions: reported,
      coorte_real: real,
      fator_superestimacao: real > 0 ? reported / real : null,
      status: real > 0 ? "ok" : "sem-coorte",
    });
  }
  const panelKeys = new Set(rows.map((r) => r.cohort_key));
  const canais_coorte_sem_painel = Object.keys(baseline.per_channel).filter((k) => !panelKeys.has(k));
  return { rows, canais_coorte_sem_painel };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): string {
  return [
    "Uso:",
    "  npx tsx scripts/aquisicao-reconcile.ts baseline --from AAAA-MM-DD --to AAAA-MM-DD [--out <path>]",
    "  npx tsx scripts/aquisicao-reconcile.ts factor --baseline <path> --panel <path> [--out <path>]",
    "",
    "Template do painel: docs/aquisicao-reconcile-panel-template.json",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const cmd = argv[0];

  if (cmd === "baseline") {
    const args = parseArgs(argv.slice(1)).values;
    const from = String(args.from ?? "");
    const to = String(args.to ?? "");
    if (!from || !to) {
      console.error("baseline exige --from AAAA-MM-DD --to AAAA-MM-DD");
      return 1;
    }
    const cfg = loadBeehiivConfig();
    process.stderr.write("[aquisicao-reconcile] drenando subscriptions (expand[]=stats&expand[]=utm_params)...\n");
    const subs = await fetchAllSubscribers(cfg.publicationId, cfg.apiKey);
    const baseline = aggregateBaseline(subs, from, to);
    const outPath = resolve(
      typeof args.out === "string" && args.out
        ? args.out
        : `data/aquisicao/reconcile-baseline-${from}_${to}.json`,
    );
    writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");
    process.stderr.write(`[aquisicao-reconcile] coorte real ${from}..${to}: ${baseline.total} cadastros\n`);
    for (const [k, v] of Object.entries(baseline.per_channel).sort((a, b) => b[1] - a[1])) {
      process.stderr.write(`  ${k}: ${v}\n`);
    }
    console.log(JSON.stringify({ ok: true, out: outPath, total: baseline.total }, null, 2));
    return 0;
  }

  if (cmd === "factor") {
    const args = parseArgs(argv.slice(1)).values;
    const baselinePath = typeof args.baseline === "string" ? args.baseline : "";
    const panelPath = typeof args.panel === "string" ? args.panel : "";
    if (!baselinePath || !panelPath || !existsSync(baselinePath) || !existsSync(panelPath)) {
      console.error("factor exige --baseline <path> e --panel <path> (arquivos existentes)");
      return 1;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
    const panel = JSON.parse(readFileSync(panelPath, "utf8")) as PanelInput;
    const result = computeFactor(baseline, panel);
    process.stderr.write("\n=== FATOR DE SUPERESTIMAÇÃO POR CANAL (#5734) ===\n");
    for (const r of result.rows) {
      const fator = r.fator_superestimacao == null ? "SEM COORTE" : `${r.fator_superestimacao.toFixed(2)}×`;
      process.stderr.write(`  ${r.channel.padEnd(12)} painel=${r.reported_conversions} real=${r.coorte_real} fator=${fator}\n`);
    }
    if (result.canais_coorte_sem_painel.length > 0) {
      process.stderr.write(`  (coorte sem painel correspondente: ${result.canais_coorte_sem_painel.join(", ")})\n`);
    }
    const outPath = resolve(typeof args.out === "string" && args.out ? args.out : panelPath.replace(/\.json$/, ".fator.json"));
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ ok: true, out: outPath, rows: result.rows.length }, null, 2));
    return 0;
  }

  console.error(`Subcomando desconhecido: "${cmd}"\n${usage()}`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
