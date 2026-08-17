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
 * ao dashboard falhar por erro ESTRUTURAL (rede, config, status não-429/503)
 * — nunca decide freio sobre dado que não conseguiu buscar; 3 se a falha for
 * TRANSITÓRIA (429/503 — rate limit da Brevo repassado pelo dashboard, ver
 * `TransientDashboardError` em `lib/transient-dashboard-error.ts`, #5220) —
 * mesmo contrato de `clarice-plan-wave.ts` (#5058): stdout traz
 * `{transient, retryAfterSecs, status, reason}`, e o chamador (`clarice-envio-
 * guard.ts`) decide se retenta com backoff em vez de abortar.
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
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  TransientDashboardError,
  TRANSIENT_DASHBOARD_STATUSES,
  parseRetryAfterSecs,
} from "./lib/transient-dashboard-error.ts";
import { readClariceEnvioOverrideState, applyEnvioOverride } from "./lib/clarice-envio-override.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadProjectEnv();
// `new URL("..", import.meta.url).pathname` quebra no Windows (mesma nota de
// `clarice-envio-guard.ts`/`brevo-diaria-run.ts`) — usar `fileURLToPath` +
// `dirname`/`resolve`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  /** #5515 — `true` quando um override ativo (`data/clarice-envio-override.json`)
   * rebaixou um `stop` calculado pra `hold`. `brake.reasons` já carrega o
   * texto explicando isso — este campo é só pra callers que queiram checar
   * sem parsear string. */
  readonly overrideApplied: boolean;
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
  /** #5515 — raiz do projeto pra localizar `data/clarice-envio-override.json`.
   * Default `ROOT` (raiz real do repo) — testes injetam um dir descartável. */
  readonly rootDir?: string;
  /** #5515 — seam de aviso pro override ilegível (JSON quebrado, `brake`
   * inválido, `until` ausente) — nunca chamado por expiração normal (isso é
   * silencioso por design). Default `console.warn`. */
  readonly onInvalidOverride?: (message: string) => void;
}

export async function fetchRiskSnapshot(opts: FetchRiskSnapshotOptions): Promise<RiskSnapshot> {
  const fetchFn = opts.fetchFn ?? fetch;

  // Só campanhas ENVIADAS — includeScheduled=0 (default) evita ruído de
  // campanha agendada sem stats reais poluindo a agregação (diferente de
  // clarice-plan-wave.ts, que PRECISA de includeScheduled=1 pra enxergar o
  // próprio agendamento; aqui o interesse é só saúde histórica de envio).
  const res = await fetchFn(`${opts.dashboardUrl}/api/campaigns?limit=${DEFAULT_DASHBOARD_LIMIT}`);
  if (!res.ok) {
    // #5220 — mesma distinção de `clarice-plan-wave.ts` (#5058): 429/503 é
    // rate limit TRANSITÓRIO da Brevo repassado pelo dashboard — "espere e
    // repita", não erro estrutural. `TransientDashboardError` é o sinal que
    // `main()` (abaixo) converte em exit code 3 + JSON, pro guard das 05:00
    // (`clarice-envio-guard.ts`) retentar com backoff em vez de abortar sem
    // reavaliar o freio.
    if (TRANSIENT_DASHBOARD_STATUSES.has(res.status)) {
      throw new TransientDashboardError(
        `GET ${opts.dashboardUrl}/api/campaigns falhou (${res.status}) — rate limit da Brevo, transitório.`,
        parseRetryAfterSecs(res.headers),
        res.status,
      );
    }
    throw new Error(
      `GET ${opts.dashboardUrl}/api/campaigns falhou (${res.status}). ` +
        `429/503 = rate limit da Brevo; aguarde e repita — nunca decida freio sem o estado real.`,
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

  const rawBrake = decideBrake(freshRisk, spamSignal);
  const step = adaptiveStep(accelRisk, spamSignal);
  const openTrend = openRateTrend(toOpenTrendPoints(trendCampaigns));

  // #5515 — ponto único de aplicação do override persistente. As DUAS
  // metades do par (`clarice-envio-run.ts` 19:00 / `clarice-envio-guard.ts`
  // 05:00) leem o freio DESTE script (import direto ou subprocess) — herdam
  // o rebaixamento automaticamente sem precisar reimplementar a leitura do
  // override cada uma. `clarice-envio-guard.ts` também consulta o override
  // diretamente antes de cancelar (defesa em profundidade — ver docstring
  // de `applyEnvioOverride`).
  const override = readClariceEnvioOverrideState(opts.rootDir ?? ROOT, opts.now, {
    onInvalid: opts.onInvalidOverride,
  });
  const { brake, overrideApplied } = applyEnvioOverride(rawBrake, override);

  return {
    brake,
    step,
    openTrend,
    freshWindow: { sampleDays: groupByBrtDay(freshCampaigns).size, sent: freshRisk.sent, delivered: freshRisk.delivered },
    accelWindow: { sampleDays: groupByBrtDay(accelCampaigns).size, sent: accelRisk.sent, delivered: accelRisk.delivered },
    spamSignal,
    staleNote,
    overrideApplied,
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
      // #5220 — mesmo contrato de clarice-plan-wave.ts (#5058): exit code 3 +
      // JSON de 1 linha no stdout pro chamador (clarice-envio-guard.ts)
      // reconhecer SEM parsear texto; console.error segue com a mensagem
      // legível pro humano que rodar este script manualmente.
      if (e instanceof TransientDashboardError) {
        console.log(JSON.stringify({ transient: true, retryAfterSecs: e.retryAfterSecs, status: e.status, reason: e.message }));
        console.error(e.message);
        process.exit(3);
      }
      console.error(String((e as Error)?.stack || e));
      process.exitCode = 1;
    });
}
