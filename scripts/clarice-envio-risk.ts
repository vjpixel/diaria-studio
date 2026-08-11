#!/usr/bin/env node
/**
 * clarice-envio-risk.ts (#5026) — leitura AO VIVO de risco de ISP pra
 * automação diária do envio Clarice.
 *
 * READ-ONLY. Reusa a MESMA fonte que `clarice-plan-wave.ts` já consulta
 * (`GET {dashboardUrl}/api/campaigns`) — não inventa um 2º caminho de dado
 * pro mesmo domínio. A diferença é a JANELA: o dashboard resolve o semáforo
 * ANTIGO sobre `HEALTH_SAMPLE_DAYS=10` com maturação de 48h (por causa da
 * abertura, que governava o corte); este script monta as duas janelas do
 * motor novo (`scripts/lib/clarice-envio-policy.ts`) — freio (3 dias de
 * envio, sem maturação) e acelerador (30 dias corridos) — e a tendência de
 * abertura só-relatório (60 dias corridos).
 *
 * LIMITAÇÃO CONHECIDA, documentada em vez de escondida: `/api/campaigns` tem
 * um clamp de 50 campanhas no servidor (`workers/brevo-dashboard/src/
 * index.ts:600-606`, decisão deliberada de latência, #3080). Em regime
 * estacionário (teste A/B/C já travado, 1 campanha/dia) 30 dias cabem
 * folgadamente; só durante um teste A/B/C ATIVO e prolongado (>16 dias com 3
 * células/dia) o acelerador poderia ver menos que 30 dias de fato — e isso é
 * OBSERVÁVEL, nunca silencioso: `accelWindow.sampleDays`/`openTrend.
 * sampleDays` reportam o que foi realmente visto. O freio (3 dias × até 3
 * células = 9 campanhas) nunca é afetado por este teto.
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-risk.ts [--dashboard-url URL] [--json]
 *   stdout: RiskSnapshot (JSON)
 *
 * Exit codes: 0 sempre que a leitura terminou (mesmo com sinal indeterminado
 * — isso é reportado dentro do JSON, não um erro de processo); 1 se o fetch
 * ao dashboard falhar (rede/rate-limit) — nunca decide freio sobre dado que
 * não conseguiu buscar.
 */
import { pickStats } from "../workers/brevo-dashboard/src/sections-core.ts";
import { resolveSpamSignal } from "../workers/brevo-dashboard/src/thresholds.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";
import {
  DEFAULT_DASHBOARD_URL,
  DEFAULT_DASHBOARD_LIMIT,
  fetchPostmasterSpamEntry,
  extractDashboardStaleInfo,
  describeStaleAge,
} from "./clarice-schedule-ramp.ts";
import {
  SEND_WINDOWS,
  selectLastSendDays,
  selectWithinDays,
  groupByBrtDay,
  decideBrake,
  adaptiveStep,
  openRateTrend,
  type RiskMetrics,
  type SpamSignalLike,
  type BrakeDecision,
  type OpenRateTrendResult,
  type OpenRateTrendPoint,
} from "./lib/clarice-envio-policy.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

loadProjectEnv();

export interface RiskSnapshot {
  readonly brake: BrakeDecision;
  /** Passo adaptativo do dia (fração, ex: 0.17 = +17%). */
  readonly step: number;
  readonly openTrend: OpenRateTrendResult;
  readonly freshWindow: { readonly sampleDays: number; readonly sent: number; readonly delivered: number };
  readonly accelWindow: { readonly sampleDays: number; readonly sent: number; readonly delivered: number };
  readonly spamSignal: SpamSignalLike;
  /** Cache stale do dashboard (Cloudflare serviu last-good por falha upstream) — nunca decide sobre isso sem avisar. */
  readonly staleNote: string | null;
}

/**
 * Adapta `SpamSignal` (worker, shape FLAT — `ratePct: number | null`
 * independente de `source`) pra `SpamSignalLike` (motor, união discriminada
 * — ver docstring completa em `clarice-envio-policy.ts`). Único ponto do
 * repo que faz esta conversão — decisão tomada no review da PR #5025
 * enquanto o motor ainda tinha zero call sites: comprar garantia de
 * compilador dentro do motor custa este adaptador de 3 linhas aqui.
 */
export function toSpamSignalLike(s: { source: "postmaster" | "indeterminate"; ratePct: number | null }): SpamSignalLike {
  return s.source === "postmaster" && s.ratePct !== null
    ? { source: "postmaster", ratePct: s.ratePct }
    : { source: "indeterminate", ratePct: null };
}

/** Soma sent/delivered/hardBounces/bounceTotal/unsub das campanhas dadas — mesma convenção (denominador = sent) de `aggregateHealth` (weekly-plan.ts). */
export function aggregateRisk(campaigns: BrevoCampaign[]): RiskMetrics {
  let sent = 0;
  let delivered = 0;
  let hardBounces = 0;
  let bounces = 0;
  let unsub = 0;
  for (const c of campaigns) {
    const picked = pickStats(c);
    if (!picked) continue;
    const s = picked.stats;
    sent += s.sent ?? 0;
    delivered += s.delivered ?? 0;
    hardBounces += s.hardBounces ?? 0;
    bounces += (s.hardBounces ?? 0) + (s.softBounces ?? 0);
    unsub += s.unsubscriptions ?? 0;
  }
  return {
    hardBounceRatePct: sent > 0 ? (hardBounces / sent) * 100 : 0,
    bounceRatePct: sent > 0 ? (bounces / sent) * 100 : 0,
    unsubRatePct: sent > 0 ? (unsub / sent) * 100 : 0,
    sent,
    delivered,
  };
}

/** 1 ponto por dia-calendário BRT — delivered/uniqueViews somados das campanhas daquele dia. Insumo de `openRateTrend`. */
export function toOpenTrendPoints(campaigns: BrevoCampaign[]): OpenRateTrendPoint[] {
  const byDay = groupByBrtDay(campaigns);
  const points: OpenRateTrendPoint[] = [];
  for (const [dayKey, cs] of byDay) {
    let delivered = 0;
    let uniqueViews = 0;
    for (const c of cs) {
      const picked = pickStats(c);
      if (!picked) continue;
      delivered += picked.stats.delivered ?? 0;
      uniqueViews += picked.stats.uniqueViews ?? 0;
    }
    points.push({ dayKey, delivered, uniqueViews });
  }
  return points;
}

export interface FetchRiskSnapshotOptions {
  readonly dashboardUrl: string;
  readonly now: Date;
  readonly fetchFn?: typeof fetch;
}

export async function fetchRiskSnapshot(opts: FetchRiskSnapshotOptions): Promise<RiskSnapshot> {
  const fetchFn = opts.fetchFn ?? fetch;

  // Só campanhas ENVIADAS — includeScheduled=0 (default) evita ruído de
  // campanha agendada sem stats reais poluindo a agregação (diferente de
  // clarice-plan-wave.ts, que PRECISA de includeScheduled=1 pra enxergar o
  // próprio agendamento; aqui o interesse é só saúde histórica de envio).
  const res = await fetchFn(`${opts.dashboardUrl}/api/campaigns?limit=${DEFAULT_DASHBOARD_LIMIT}`);
  if (!res.ok) {
    throw new Error(
      `GET ${opts.dashboardUrl}/api/campaigns falhou (${res.status}). ` +
        `429 = rate limit da Brevo; aguarde e repita — nunca decida freio sem o estado real.`,
    );
  }
  const stale = extractDashboardStaleInfo(res);
  const staleNote = stale ? `${stale.kind} (upstream=${stale.upstreamStatus}) — ${describeStaleAge(stale.since)}` : null;

  const rawCampaigns = (await res.json()) as BrevoCampaign[];
  const sentCampaigns = rawCampaigns.filter((c) => c.status === "sent" && !!c.sentDate);

  const freshCampaigns = selectLastSendDays(sentCampaigns, opts.now, { days: SEND_WINDOWS.brakeSendDays });
  const accelCampaigns = selectWithinDays(sentCampaigns, opts.now, { days: SEND_WINDOWS.accelDays });
  const trendCampaigns = selectWithinDays(sentCampaigns, opts.now, { days: SEND_WINDOWS.trendDays });

  const postmasterEntry = await fetchPostmasterSpamEntry(opts.dashboardUrl, fetchFn);
  const workerSpamSignal = resolveSpamSignal(postmasterEntry, opts.now);
  const spamSignal = toSpamSignalLike(workerSpamSignal);

  const freshRisk = aggregateRisk(freshCampaigns);
  const accelRisk = aggregateRisk(accelCampaigns);

  const brake = decideBrake(freshRisk, spamSignal);
  const step = adaptiveStep(accelRisk, spamSignal);
  const openTrend = openRateTrend(toOpenTrendPoints(trendCampaigns));

  return {
    brake,
    step,
    openTrend,
    freshWindow: { sampleDays: groupByBrtDay(freshCampaigns).size, sent: freshRisk.sent, delivered: freshRisk.delivered },
    accelWindow: { sampleDays: groupByBrtDay(accelCampaigns).size, sent: accelRisk.sent, delivered: accelRisk.delivered },
    spamSignal,
    staleNote,
  };
}

if (isMainModule(import.meta.url)) {
  const dashboardUrl = getArg(process.argv.slice(2), "dashboard-url") || DEFAULT_DASHBOARD_URL;
  fetchRiskSnapshot({ dashboardUrl, now: new Date() })
    .then((snapshot) => {
      console.log(JSON.stringify(snapshot, null, 2));
      process.exitCode = 0;
    })
    .catch((e) => {
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
