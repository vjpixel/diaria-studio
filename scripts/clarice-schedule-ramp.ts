#!/usr/bin/env node
/**
 * clarice-schedule-ramp.ts (#3593)
 *
 * Script committed fim-a-fim pra agendar os 3 próximos envios RAMP-WARM (cold,
 * 1º envio) da Clarice via Brevo API — substitui o fluxo ad-hoc rodado na mão
 * em 260716 (ver memória `clarice-ramp-schedule-via-api`) por algo
 * reproduzível/testado, seguindo o princípio "Pipeline reproducible" do
 * CLAUDE.md.
 *
 * 5 fases (cada uma exige flag explícita; sem nenhuma, só imprime o plano —
 * dry-run é o default, mesmo padrão de clarice-schedule-sends.ts/
 * clarice-schedule-group.ts):
 *
 *   1. Volumes:    --volumes A,B,C (explícito) OU calculado automaticamente
 *                  a partir de `GET {dashboard-url}/api/campaigns` (mesma
 *                  lógica PURA do worker — `selectMatureDayCampaigns`/
 *                  `aggregateHealth`/`decideSemaphore`/`baseVolumeFromLastSendDay`/
 *                  `computeWeekPlan`, IMPORTADAS diretamente de
 *                  `workers/brevo-dashboard/src/weekly-plan.ts`, não duplicadas
 *                  — typecheck confirmado limpo via o shim ambiente de
 *                  `scripts/studio-ui/workers-ambient.d.ts`, ver PR #3593).
 *   2. --build-audience:  segmenta `ramp-warm` do store local (mesmo predicado
 *                  de `scripts/lib/clarice-segment.ts` — elegível, nunca
 *                  enviado, mv_bucket verificado OU cohort MV-isento como
 *                  assinantes-ativos, #3826), exclui quem já está
 *                  comprometido com uma campanha AGENDADA (queued, #2994) OU
 *                  JÁ DISPARADA (sent, #3682 — imune ao lag de sends_count
 *                  local) e fatia nos 3 volumes (ordem preservada, recência
 *                  real via `compareContactRecency` — morno→frio; degrada
 *                  pra cohortSendRank só sem `created` confiável, #5169/#5398).
 *                  `--extra-email` anexa email(s) fixo(s) nas 3
 *                  listas SEM remover ninguém. Valida crédito Brevo cobre a
 *                  soma ANTES de escrever qualquer CSV. Escreve
 *                  `{ciclo}/ramp/ramp-manifest.json` + `w{1,2,3}-{dia}.csv` +
 *                  `ramp-summary.json` (estado, idempotência).
 *   3. --import:   cria 1 lista Brevo por wave (idempotente por nome, reusa a
 *                  lista já criada num retry em vez de recriar) + importa os
 *                  contatos (`POST /contacts/lists` + `POST /contacts/import`,
 *                  fileBody inclui a cópia QA do editor via `ensureEditorCopyRow`,
 *                  #3455) — mesmas chamadas de `clarice-import-waves.ts`. Import
 *                  é ASYNC — faz polling em `GET /contacts/lists/{id}` até
 *                  `totalSubscribers` bater. Só marca a wave "imported" (status
 *                  terminal, retry-skip) quando o poll de fato bate; caso
 *                  contrário fica "import_incomplete" — `--create`/`--schedule`
 *                  recusam prosseguir sem `--force` explícito (#3643).
 *   4. --create:   cria as 3 campanhas como RASCUNHO (payload proven de
 *                  `clarice-schedule-sends.ts`: name/subject/previewText/
 *                  sender/recipients/htmlContent, OMITINDO header/footer/
 *                  replyTo → defaults da conta). htmlContent =
 *                  `_internal/cloudflare-preview.html` do ciclo (NÃO o
 *                  embedded). Guard: aborta ANTES de qualquer POST se o HTML
 *                  não contiver a merge tag de descadastro `{{ unsubscribe }}`
 *                  (legal). `--send-test` manda test email de cada campanha.
 *   5. --schedule: agenda as 3 campanhas (`PUT scheduledAt` + GET-verify, reusa
 *                  `isScheduledStatus`/`applyVerifyResults` de
 *                  `clarice-schedule-sends.ts`). Valida ANTES de qualquer PUT
 *                  que TODAS as waves têm `campaignId` (senão bloqueia com erro
 *                  upfront — #3643, evita agendar parcial e perder o rastro do
 *                  estado). REQUER o gabarito É IA? setado antes (`checkEiaGuard`,
 *                  mesmo guard do pipeline canônico — a rampa distribui o MESMO
 *                  conteúdo do digest mensal, só que pra uma audiência nova).
 *                  `--skip-eia-guard` pula essa verificação (não recomendado).
 *
 * `--force` (#3643): override explícito pra `--create` prosseguir com uma wave
 * cujo import não foi confirmado (`status: "import_incomplete"`) — use só após
 * verificar manualmente no Brevo que a lista de fato tem os contatos esperados.
 *
 * `--dates D1,D2,D3` (YYYY-MM-DD, OBRIGATÓRIO pra --create/--schedule) — datas
 * EXPLÍCITAS dos 3 envios, cada uma agendada para 06:00 BRT (09:00 UTC, sem
 * DST no Brasil desde 2019 — mesma convenção de `scheduledAtFor` em
 * clarice-schedule-sends.ts). Deliberadamente explícito, não inferido a partir
 * de dia-da-semana (ter/sex/dom são só o RÓTULO informacional no nome da wave)
 * — "data é sempre explícita" é princípio invariável do CLAUDE.md; inferir
 * data a partir de weekday tem risco de off-by-one silencioso numa operação
 * de produção pra dezenas de milhares de contatos.
 *
 * SEGURANÇA: nenhuma fase roda sem a flag explícita correspondente — chamar o
 * script sem flags nunca escreve nem envia nada (só imprime o plano). Mesmo
 * assim, --import/--create/--schedule fazem chamadas REAIS à Brevo API em
 * produção — nunca invocar essas fases fora de uma sessão onde o operador
 * pretende de fato agendar o envio.
 *
 * Uso típico:
 *   npx tsx scripts/clarice-schedule-ramp.ts --cycle 2606-07                       # plano (volumes auto)
 *   npx tsx scripts/clarice-schedule-ramp.ts --cycle 2606-07 --volumes 7000,7500,8000 --build-audience
 *   npx tsx scripts/clarice-schedule-ramp.ts --cycle 2606-07 --import
 *   npx tsx scripts/clarice-schedule-ramp.ts --cycle 2606-07 --dates 2026-07-18,2026-07-21,2026-07-23 \
 *     --subject "Assunto do digest" --create
 *   npx tsx scripts/clarice-schedule-ramp.ts --cycle 2606-07 --send-test
 *   # ANTES do --schedule: setar o gabarito É IA? do ciclo (#2009, mesmo guard do pipeline canônico)
 *   npx tsx scripts/close-poll.ts --brand clarice --cycle 2606-07 --edition {AAMMDD} --answer A
 *   npx tsx scripts/clarice-schedule-ramp.ts --cycle 2606-07 --schedule
 *
 * Estado em `{ciclo}/ramp/ramp-summary.json` (idempotência: --build-audience
 * recusa reescrever se o manifest já existe; --import/--create/--schedule
 * pulam waves já processadas, mesmo padrão de clarice-schedule-sends.ts).
 *
 * `--data-root DIR` (#4612): OPCIONAL, uso interno de teste — mesmo padrão de
 * `--data-root` em clarice-build-segment.ts/verify-emails-mv.ts (#4207).
 * Sobrepõe `CLARICE_BASE` (a raiz REAL, junction pro OneDrive) só nesta
 * invocação, permitindo `main()` escrever `ramp-manifest.json`/`ramp-summary.json`/
 * os CSVs de wave sob um tmpdir isolado em vez do disco de produção.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoPut, brevoGetCampaign, brevoGetList, brevoGet, brevoListAllLists, fetchCommittedCampaignListIds } from "./lib/brevo-client.ts";
import { clariceRampDir, clariceSegmentsDir, parseCycleArg, CLARICE_BASE } from "./lib/clarice-paths.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { segmentRampWarm, excludeCommittedToQueuedCampaigns, type StoreRow } from "./lib/clarice-segment.ts";
import { loadSentOrQueuedEmails, excludeSentOrQueued } from "./clarice-build-segment.ts";
import { readNovosCutoff } from "./lib/clarice-novos-cutoff.ts";
import { monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import { checkEiaGuard, applyVerifyResults } from "./clarice-schedule-sends.ts";
import { findExistingConflicts, normalizeImportCsv, countRows, type WaveDef } from "./clarice-import-waves.ts";
import { ensureEditorCopyRow } from "./lib/editor-copy.ts"; // #3455 / #3643 bug 3
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { extractPlanCredits } from "../workers/brevo-dashboard/src/brevo-api.ts";
import {
  selectMatureDayCampaigns,
  aggregateHealth,
  decideSemaphore,
  baseVolumeFromLastSendDay,
  computeWeekPlan,
  describeBreachedMetrics,
  type Semaphore,
} from "../workers/brevo-dashboard/src/weekly-plan.ts";
import { resolveSpamSignal, describeSpamSignalOrigin, type SpamSignal } from "../workers/brevo-dashboard/src/thresholds.ts"; // #4063, #5059
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";
import type { PostmasterSpamEntry } from "./lib/dashboard-kv-types.ts"; // #4131 finding 4
import { firstName } from "./lib/clarice-name.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DAY_LABELS = ["ter", "sex", "dom"];
export const DEFAULT_DASHBOARD_URL = "https://clarice-dashboard.diaria.workers.dev";
// #3643 minor 1: era 80, mas o Worker clampa `limit` em 50 sem avisar
// (workers/brevo-dashboard/src/index.ts:227, `Math.min(50, ...)`) — 80 era
// efetivamente morto/enganoso. 50 reflete o real. `warnIfLimitExceedsWorkerClamp`
// cobre o caso de alguém passar --dashboard-limit explícito acima do clamp.
export const DEFAULT_DASHBOARD_LIMIT = 50;
export const DASHBOARD_WORKER_CLAMP = 50;

export interface DashboardStaleInfo {
  kind: string;
  upstreamStatus: string;
  /**
   * #4612: timestamp ISO real de quando o cache servido foi gerado
   * (`X-Dashboard-Stale-Since`, emitido por `buildUpstreamErrorCampaignsJsonFallback`
   * quando o KV `dash:lastgood:campaigns` tem `generatedAt`). AUSENTE em
   * `kind: "inflight-coalesced"` (não é cache de KV, é coalescing de request
   * concorrente — não existe "geração" a datar) e em qualquer resposta stale
   * mais antiga que não tinha o header ainda. Quando ausente, o único teto
   * conhecido é o pessimista `LASTGOOD_TTL` (24h) — ver `describeStaleAge`.
   */
  since?: string;
}

/**
 * #4543: `GET /api/campaigns` (`workers/brevo-dashboard/src/index.ts`,
 * `buildCampaignsResponse`) serve HTTP 200 mesmo quando o dado é cache, em
 * dois cenários REAIS desta rota — sinalizados via
 * `X-Dashboard-Stale`/`X-Dashboard-Upstream-Status`, por design, pra não
 * acionar alertas de disponibilidade:
 *   - `kind: "upstream-error"` — outage 403/5xx OU erro de rede/timeout cru
 *     do fetch pra Brevo (#4251/#4533); `upstreamStatus` traz o status real
 *     ou o literal `"network_error"`. `X-Dashboard-Stale-Since` (#4612), quando
 *     presente, traz o timestamp REAL de geração do cache — idade real, não
 *     o teto pessimista de 24h.
 *   - `kind: "inflight-coalesced"` — lock de refresh concorrente (#3644,
 *     coalescing entre requests simultâneas), sem relação com a Brevo;
 *     `upstreamStatus` ausente, cai no fallback `"unknown"`; `since` sempre
 *     ausente (não há "geração" de cache pra datar neste caso).
 * Rate-limit (429) NÃO é mascarado nesta rota — `rateLimitResponse(_, false)`
 * devolve 503 puro sem `X-Dashboard-Stale` (o banner "200 + stale" pra 429
 * existe só na rota HTML do painel, `buildStaleResponse`) — continua caindo
 * no `!res.ok` pré-existente em ambos os consumidores, inalterado por este PR.
 * Consumidores que checavam só `res.ok` (este script e
 * `clarice-check-semaphore.ts`) não enxergavam essa diferença pros dois casos
 * acima. Decisão do editor: fail-open com visibilidade — nunca bloquear por
 * isso, mas nunca silencioso.
 */
export function extractDashboardStaleInfo(res: Response): DashboardStaleInfo | undefined {
  const kind = res.headers.get("X-Dashboard-Stale");
  if (!kind) return undefined;
  const since = res.headers.get("X-Dashboard-Stale-Since");
  return {
    kind,
    upstreamStatus: res.headers.get("X-Dashboard-Upstream-Status") ?? "unknown",
    ...(since ? { since } : {}),
  };
}

/**
 * #4612: descreve a idade real do cache stale a partir de `stale.since`
 * (`X-Dashboard-Stale-Since`) quando disponível — em vez de só citar o teto
 * pessimista de 24h (`LASTGOOD_TTL`) em todo log, que trata "3min stale" e
 * "23h stale" como indistinguíveis para o operador decidir o risco. Pura,
 * testável. `since` ausente/inválido cai no teto pessimista explícito (nunca
 * finge saber uma idade que não tem).
 */
export function describeStaleAge(since: string | undefined, now: Date = new Date()): string {
  if (!since) return "idade real desconhecida (sem X-Dashboard-Stale-Since) — trate como até 24h, o teto pessimista de LASTGOOD_TTL (#4543)";
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return `X-Dashboard-Stale-Since inválido ("${since}") — trate como até 24h, o teto pessimista de LASTGOOD_TTL (#4543)`;
  const ageMs = Math.max(0, now.getTime() - sinceMs);
  const ageMin = ageMs / 60_000;
  if (ageMin < 60) return `~${Math.round(ageMin)}min stale (gerado ${since})`;
  return `~${(ageMs / 3_600_000).toFixed(1)}h stale (gerado ${since})`;
}

// ---------------------------------------------------------------------------
// Volumes — explícito (--volumes) OU calculado a partir do worker (#3593 item 1)
// ---------------------------------------------------------------------------

export interface RampVolumePlan {
  volumes: [number, number, number];
  semaphore: Semaphore;
  flagged: boolean;
  baseVolume: number;
  /**
   * #5592: QUAL(is) métrica(s) romperam o semáforo (vazio quando `semaphore !==
   * "red"`) — `describeBreachedMetrics` em weekly-plan.ts. Opcional pra não
   * quebrar literais existentes (testes) que constroem `RampVolumePlan` sem
   * esse campo; só o call site de produção em `deriveRampVolumes` o popula.
   */
  breachedMetrics?: string[];
}

export type RampVolumeResult = { ok: true; plan: RampVolumePlan } | { ok: false; reason: string };

/**
 * #4131 finding 4: busca a leitura do Postmaster (`postmaster:spam`, auto ou manual)
 * via o endpoint público `/api/postmaster-spam` do Worker (ver
 * `workers/brevo-dashboard/src/index.ts`) — a MESMA leitura gravada por
 * `scripts/postmaster-spam-sync.ts` (automático) ou `scripts/postmaster-spam-entry.ts`
 * (manual, fallback). Sem isso, este script nunca
 * enxergava a leitura e `decideSemaphore` ficava travado no máximo em
 * "yellow" pra sempre (nunca escalonava volume, mesmo com uma leitura fresca
 * e boa registrada) — mudança real de produção sem caminho de saída.
 *
 * Fail-soft por design: qualquer erro de rede/parse devolve `null`, que
 * `resolveSpamSignal` já trata como "indeterminate" (comportamento seguro
 * preservado — nunca lança, nunca resolve pra falso-verde por conta de uma
 * falha de fetch).
 */
export type PostmasterSpamEntryPick = Pick<
  PostmasterSpamEntry,
  | "spamRatePct"
  | "recordedAt"
  | "producedBy"
  | "date"
  | "daysWithData"
  | "daysProbed"
  | "worstCampaignSpamRatePct"
  | "worstCampaignFeedbackLoopId"
  | "worstCampaignDaysWithData"
>;

/** #5412 — resultado detalhado de `fetchPostmasterSpamEntryDetailed`: além da
 * `entry` (ou `null`), distingue POR QUE está `null` — `fetchFailed: true`
 * quando o FETCH em si falhou (rede, exceção, HTTP não-2xx) vs. `false`
 * quando o fetch respondeu OK mas não trouxe uma leitura válida (nenhuma
 * leitura registrada ainda, ou payload malformado). Os 2 casos eram
 * indistinguíveis pra quem só chamava `fetchPostmasterSpamEntry` (thin
 * wrapper abaixo, preserva o comportamento/assinatura pros ~5 call sites
 * existentes) — só `clarice-postmaster-alarm.ts` precisa da distinção, pra
 * não apontar o operador pra investigar o sync quando o problema real é o
 * dashboard/Worker estar fora do ar. */
export interface PostmasterSpamEntryFetchResult {
  entry: PostmasterSpamEntryPick | null;
  fetchFailed: boolean;
}

/**
 * #4131 finding 4: busca a leitura do Postmaster (`postmaster:spam`, auto ou manual)
 * via o endpoint público `/api/postmaster-spam` do Worker (ver
 * `workers/brevo-dashboard/src/index.ts`) — a MESMA leitura gravada por
 * `scripts/postmaster-spam-sync.ts` (automático) ou `scripts/postmaster-spam-entry.ts`
 * (manual, fallback). Sem isso, este script nunca
 * enxergava a leitura e `decideSemaphore` ficava travado no máximo em
 * "yellow" pra sempre (nunca escalonava volume, mesmo com uma leitura fresca
 * e boa registrada) — mudança real de produção sem caminho de saída.
 *
 * Fail-soft por design: qualquer erro de rede/parse devolve `entry: null`,
 * que `resolveSpamSignal` já trata como "indeterminate" (comportamento
 * seguro preservado — nunca lança, nunca resolve pra falso-verde por conta
 * de uma falha de fetch). `fetchFailed` distingue essa falha de "fetch OK,
 * sem leitura válida" — ver docstring de `PostmasterSpamEntryFetchResult`.
 */
export async function fetchPostmasterSpamEntryDetailed(
  dashboardUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<PostmasterSpamEntryFetchResult> {
  try {
    const res = await fetchFn(`${dashboardUrl}/api/postmaster-spam`);
    if (!res.ok) return { entry: null, fetchFailed: true };
    const body = (await res.json()) as { entry?: unknown };
    const raw = body?.entry;
    if (!raw || typeof raw !== "object") return { entry: null, fetchFailed: false };
    const e = raw as Partial<PostmasterSpamEntry>;
    if (typeof e.spamRatePct !== "number" || !Number.isFinite(e.spamRatePct)) return { entry: null, fetchFailed: false };
    if (typeof e.recordedAt !== "string" || !e.recordedAt) return { entry: null, fetchFailed: false };
    // #4154, achado do self-review do #4342 (3ª rodada): esta é uma 2ª
    // leitura da mesma info que normalizePostmasterSpamEntry já normaliza no
    // worker (via GET /api/postmaster-spam) — sem repassar producedBy aqui, o
    // CLI de agendamento da ramp nunca soube distinguir leitura auto de
    // manual, mesmo depois do fix no dashboard.
    //
    // #4541: mesma classe de risco pra `date`/`daysWithData`/`daysProbed` — sem
    // repassar `date`, `resolveSpamSignal` (que agora exige medição recente,
    // não só gravação recente) trataria TODA leitura vinda deste script como
    // indeterminate pra sempre, mesmo com uma medição fresca no KV — o mesmo
    // "travado pra sempre" que o #4131 finding 4 corrigiu pro caso geral.
    //
    // #4705: mesma classe de risco pra `worstCampaignSpamRatePct` — sem
    // repassar aqui, o CLI de agendamento da ramp nunca veria o pico por
    // campanha e `resolveSpamSignal` cairia sempre no fallback de domínio
    // pra este caminho, mesmo com o KV gravado corretamente.
    //
    // #4780: mesma classe de risco pra `worstCampaignFeedbackLoopId`/
    // `worstCampaignDaysWithData` — sem repassar aqui, o CLI nunca teria como
    // imprimir QUAL campanha decidiu o semáforo nem a cobertura do pico
    // (achado item 3 do fleet review pré-merge do #4779), mesmo com o KV
    // gravado corretamente pelo produtor.
    return {
      entry: {
        date: typeof e.date === "string" ? e.date : "",
        spamRatePct: e.spamRatePct,
        recordedAt: e.recordedAt,
        producedBy: e.producedBy === "manual" || e.producedBy === "auto" ? e.producedBy : undefined,
        daysWithData: typeof e.daysWithData === "number" && Number.isFinite(e.daysWithData) ? e.daysWithData : undefined,
        daysProbed: typeof e.daysProbed === "number" && Number.isFinite(e.daysProbed) ? e.daysProbed : undefined,
        worstCampaignSpamRatePct:
          typeof e.worstCampaignSpamRatePct === "number" && Number.isFinite(e.worstCampaignSpamRatePct)
            ? e.worstCampaignSpamRatePct
            : undefined,
        worstCampaignFeedbackLoopId:
          typeof e.worstCampaignFeedbackLoopId === "string" && e.worstCampaignFeedbackLoopId
            ? e.worstCampaignFeedbackLoopId
            : undefined,
        worstCampaignDaysWithData:
          typeof e.worstCampaignDaysWithData === "number" && Number.isFinite(e.worstCampaignDaysWithData)
            ? e.worstCampaignDaysWithData
            : undefined,
      },
      fetchFailed: false,
    };
  } catch {
    return { entry: null, fetchFailed: true };
  }
}

/** Thin wrapper de `fetchPostmasterSpamEntryDetailed` — só a `entry`, sem a
 * distinção `fetchFailed` (#5412). Mantido pra não tocar a assinatura dos
 * ~5 call sites existentes (clarice-check-semaphore.ts, clarice-envio-risk.ts,
 * clarice-plan-wave.ts, este próprio arquivo) — nenhum deles precisa
 * distinguir fetch-falho de fetch-sem-leitura; ambos já tratavam `null` como
 * "indeterminate" (mesmo resultado de `resolveSpamSignal`), fail-safe. */
export async function fetchPostmasterSpamEntry(
  dashboardUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<PostmasterSpamEntryPick | null> {
  return (await fetchPostmasterSpamEntryDetailed(dashboardUrl, fetchFn)).entry;
}

/**
 * Recomputa a recomendação de volume a partir das campanhas Brevo — MESMA
 * lógica pura do worker (`workers/brevo-dashboard/src/weekly-plan.ts`,
 * aba "Rampa"), não duplicada aqui. Espelha `computeWeeklySendState` do
 * worker (não exportada de lá) numa forma que devolve um resultado
 * discriminado (ok/erro) em vez de renderizar HTML.
 *
 * `spamEntry` (#4131 finding 4): leitura do Postmaster (auto ou manual), obtida via
 * `fetchPostmasterSpamEntry` — quando ausente/omitida, o comportamento é
 * IDÊNTICO ao anterior (#4063: `resolveSpamSignal(null, now)`, sempre
 * "indeterminate", semáforo nunca escalona a verde às cegas). Com uma
 * leitura fresca (< 48h, ver `POSTMASTER_STALE_MS`) e boa, o semáforo agora
 * PODE chegar a "green" de novo.
 */
export function deriveRampVolumes(
  campaigns: BrevoCampaign[],
  now: Date = new Date(),
  spamEntry?: Pick<
    PostmasterSpamEntry,
    | "spamRatePct"
    | "recordedAt"
    | "producedBy"
    | "date"
    | "daysWithData"
    | "daysProbed"
    | "worstCampaignSpamRatePct"
    | "worstCampaignFeedbackLoopId"
    | "worstCampaignDaysWithData"
  > | null,
): RampVolumeResult {
  const allSent = campaigns.filter((c) => c.status === "sent" && !!c.sentDate);
  if (allSent.length === 0) {
    return { ok: false, reason: "Nenhum envio registrado nas campanhas retornadas pelo dashboard." };
  }
  const { mature } = selectMatureDayCampaigns(allSent, now);
  if (mature.length === 0) {
    return { ok: false, reason: "Nenhum envio maduro (>48h) ainda — aguarde as métricas subirem antes de recomputar o volume." };
  }
  const baseVolume = baseVolumeFromLastSendDay(allSent);
  if (baseVolume <= 0) {
    return { ok: false, reason: "Volume-base (último envio) indisponível — use --volumes A,B,C explícito." };
  }
  const health = aggregateHealth(mature);
  // #4131 finding 4: `spamEntry` vem de `fetchPostmasterSpamEntry` (ou `null`/
  // ausente quando a leitura não existe/falhou o fetch) — `resolveSpamSignal`
  // já resolve pra "indeterminate" nesses casos, e pra stale (>48h) também.
  // Nunca escalona volume "às cegas" com base no `complaints` subcontado da Brevo.
  const spamSignal = resolveSpamSignal(spamEntry ?? null, now);
  const semaphore = decideSemaphore(health, spamSignal);
  const plan = computeWeekPlan(baseVolume, semaphore);
  // #5592: só computa a lista (custo desprezível) quando há algo pra reportar
  // — vermelho é a única classificação onde `describeBreachedMetrics` pode
  // devolver não-vazio (ver docstring de `decideSemaphore`).
  const breachedMetrics = semaphore === "red" ? describeBreachedMetrics(health, spamSignal) : [];
  return { ok: true, plan: { volumes: plan.volumes, semaphore: plan.semaphore, flagged: plan.flagged, baseVolume, breachedMetrics } };
}

export type AutoRampVolumeResult =
  | { ok: true; plan: RampVolumePlan; stale?: DashboardStaleInfo }
  | { ok: false; reason: string; stale?: DashboardStaleInfo };

/**
 * #4780 item 2 (achado do fleet review pré-merge do #4779): antes desta
 * função, o CLI sempre imprimia `spamEntry.spamRatePct` (a média de
 * DOMÍNIO), mesmo quando `resolveSpamSignal` usa o PICO por campanha
 * (`Math.max`, #4705) pra decidir o semáforo — um editor via
 * "leitura Postmaster: 0,08%" ao lado de "semáforo=red" sem conseguir
 * entender pela própria saída da ferramenta por que o breaker disparou.
 *
 * Pura/testável: recebe o `spamEntry` cru E o `spamSignal` já resolvido
 * (`resolveSpamSignal(spamEntry, now)`, chamado 1x pelo caller e reusado —
 * não recalcula aqui) — imprime o valor EFETIVO (`spamSignal.ratePct`, o
 * `Math.max` já resolvido) + a ORIGEM (domínio vs. campanha
 * `{feedback_loop_id}`, com a cobertura em dias quando disponível, #4780
 * item 3), espelhando o mesmo número que já governa a aba Rampa do
 * dashboard (`weekly-plan.ts` também renderiza `spamSignal.ratePct`, nunca
 * `entry.spamRatePct` cru).
 *
 * Origem "campanha" quando `worstCampaignSpamRatePct` é finito E é o valor
 * que o `Math.max` de `resolveSpamSignal` escolheu — delegado a
 * `describeSpamSignalOrigin` (`thresholds.ts`, #5059), que reusa a MESMA
 * comparação de `resolveSpamSignal` (`isCampaignPeakGoverning`) em vez de
 * recalculá-la aqui; antes do #5059 esta função tinha sua própria cópia
 * inline do predicado, divergente em forma (não em resultado) da de
 * `thresholds.ts`.
 *
 * `spamEntry` ausente OU `spamSignal.source !== "postmaster"` (stale,
 * malformada, baixa cobertura — ver `SpamSignalIndeterminateReason`) cai no
 * fallback "indeterminate": com entry presente, ainda mostra os números
 * crus (auditoria) mas deixa claro que eles NÃO estão governando o
 * semáforo agora; sem entry nenhuma, mantém a mensagem "ausente/indisponível"
 * de antes (comportamento preservado).
 */
export function describeSpamSignalLine(
  spamEntry:
    | Pick<
        PostmasterSpamEntry,
        | "spamRatePct"
        | "recordedAt"
        | "producedBy"
        | "worstCampaignSpamRatePct"
        | "worstCampaignFeedbackLoopId"
        | "worstCampaignDaysWithData"
      >
    | null
    | undefined,
  spamSignal: SpamSignal,
): string {
  if (!spamEntry) {
    return `   leitura Postmaster: ausente/indisponível — semáforo de spam fica "indeterminate" (nunca verde às cegas).`;
  }
  const spamSourceLabel = spamEntry.producedBy === "auto" ? " (auto)" : spamEntry.producedBy === "manual" ? " (manual)" : "";
  if (spamSignal.source !== "postmaster" || spamSignal.ratePct === null) {
    return (
      `   leitura Postmaster${spamSourceLabel}: ${spamEntry.spamRatePct}% (registrada ${spamEntry.recordedAt}) — ` +
      `indeterminate p/ o semáforo${spamSignal.reason ? ` (${spamSignal.reason})` : ""}, nunca verde às cegas.`
    );
  }
  // #5059: origem (domínio vs. pico por campanha) + label já formatado —
  // delegado a `describeSpamSignalOrigin` (thresholds.ts), que reusa a MESMA
  // comparação de `resolveSpamSignal` em vez de recalculá-la aqui (era essa
  // recomputação local que a #5059 fechou).
  const { label: originLabel } = describeSpamSignalOrigin(spamEntry, spamSignal);
  return (
    `   leitura Postmaster${spamSourceLabel}: ${spamSignal.ratePct.toFixed(3)}% — origem: ${originLabel} ` +
    `(registrada ${spamEntry.recordedAt})`
  );
}

/**
 * #4612: extrai o bloco "sem --volumes explícito" de dentro de `main()` pra
 * uma função testável com `fetchImpl` injetável — mesmo padrão de
 * `checkSemaphore` em `clarice-check-semaphore.ts`. Antes, este bloco vivia
 * inline em `main()` chamando o `fetch` global direto: nenhum teste
 * conseguia simular uma resposta STALE do dashboard sem bater na rede de
 * verdade, e o `console.error` de `extractDashboardStaleInfo` era a ÚNICA
 * superfície onde esse sinal aparecia — nunca chegava a `RampVolumeResult`/
 * `ramp-summary.json`/ao JSON impresso.
 *
 * Não lança nem chama `process.exit` (`main()` decide o que fazer com o
 * resultado) — GET não-2xx vira `{ok:false, reason}`, simétrico a
 * `deriveRampVolumes` já retornar `{ok:false, reason}` por falta de dado
 * maduro. `stale`, quando presente, é preservado em AMBOS os ramos
 * (`ok:true` e `ok:false`) — mesmo com `deriveRampVolumes` falhando por falta
 * de dado maduro, o dado que HÁ pode ainda ser stale, e essa informação não
 * deve se perder.
 */
export async function resolveAutoRampVolumes(
  dashboardUrl: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<AutoRampVolumeResult> {
  const res = await fetchImpl(`${dashboardUrl}/api/campaigns?limit=${limit}`);
  if (!res.ok) {
    return { ok: false, reason: `GET ${dashboardUrl}/api/campaigns falhou (${res.status}). Use --volumes A,B,C explícito.` };
  }
  const stale = extractDashboardStaleInfo(res);
  if (stale) {
    console.error(
      `⚠️  Dashboard serviu dado STALE (${stale.kind}, upstream=${stale.upstreamStatus}) — ${describeStaleAge(stale.since)} — ` +
      `próxima wave decidida sobre esse cache (#4543/#4612).`,
    );
  }
  const campaigns = (await res.json()) as BrevoCampaign[];
  // #4131 finding 4: busca a leitura do Postmaster no MESMO dashboard — sem
  // isso, o semáforo nunca escalonava a verde. `fetchImpl` propagado (não o
  // `fetch` global) pelo mesmo motivo documentado em `checkSemaphore`: testes
  // que injetam `fetchImpl` pra evitar rede real ainda disparariam uma
  // chamada de verdade aqui.
  const spamEntry = await fetchPostmasterSpamEntry(dashboardUrl, fetchImpl);
  // #4780 item 2: imprime o valor EFETIVO (Math.max já resolvido) + a
  // origem, não a média de domínio crua — ver `describeSpamSignalLine`.
  // `now` computado 1x e reusado tanto pra resolver o sinal impresso quanto
  // pra `deriveRampVolumes` (antes recebia `undefined` e criava seu próprio
  // `new Date()` — 2 timestamps distintos pra decisões que devem ser
  // consistentes entre si na mesma invocação).
  const now = new Date();
  const spamSignal = resolveSpamSignal(spamEntry ?? null, now);
  console.error(describeSpamSignalLine(spamEntry, spamSignal));
  const result = deriveRampVolumes(campaigns, now, spamEntry);
  return stale ? { ...result, stale } : result;
}

/** Parse de `--volumes N,N,N` — exatamente 3 inteiros > 0. Pura, testável. */
export function parseVolumesArg(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || !Number.isInteger(n))) return null;
  return nums as [number, number, number];
}

/** Fatia a audiência já ordenada nos 3 volumes, na ordem informada. Pura. */
export function sliceIntoVolumes<T>(ordered: T[], volumes: number[]): T[][] {
  const out: T[][] = [];
  let cursor = 0;
  for (const v of volumes) {
    out.push(ordered.slice(cursor, cursor + v));
    cursor += v;
  }
  return out;
}

/**
 * Resolve `--dashboard-limit N` (#3643 minor 2): `N` explícito é usado mesmo
 * quando `0` — evita o bug clássico de falsy-zero de `Number(raw) || fallback`
 * (que descartaria um `--dashboard-limit 0` explícito e caísse no default
 * silenciosamente).
 *
 * `raw` ausente, VAZIO/só-espaços (#4568) ou não-numérico → `fallback`. A
 * string vazia precisa de checagem PRÓPRIA porque ela não é "não-numérica" em
 * JS: `Number("") === 0`, e era exatamente por isso que um `getArg` sem a flag
 * virava `?limit=0` em vez de cair no fallback. Pura, testável.
 *
 * PREFIRA `getIntArg(argv, key, { min: 1 })` em call sites novos: esta função
 * cai em fallback silencioso pra lixo (`"abc"` → fallback) e aceita negativo e
 * não-inteiro (`"-5"` → -5), enquanto `getIntArg` rejeita os três com erro
 * legível. Mantida pelo contrato do #3643 minor 2 (o `0` explícito), não como
 * o caminho recomendado.
 */
export function resolveDashboardLimit(raw: string | undefined, fallback: number = DEFAULT_DASHBOARD_LIMIT): number {
  // #4568: string VAZIA é "flag ausente", não "limite zero". `getArg` devolve
  // `""` quando a flag não foi passada (nunca `undefined`), e o `Number("") === 0`
  // daqui virava `?limit=0` — que o Worker responde com 502. Resultado: o guard
  // D4 do semáforo abortava TODA invocação padrão, sem nunca avaliar
  // entregabilidade. O `0` EXPLÍCITO (`--dashboard-limit 0`) segue preservado,
  // que é o comportamento testado do #3643 minor 2.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * #3643 minor 1: o Worker clampa `limit` em `clamp` (default 50, ver
 * `workers/brevo-dashboard/src/index.ts:227`) sem avisar quando trunca. Avisa
 * quando o `limit` efetivo pedido excede o clamp conhecido, já que a resposta
 * real virá truncada silenciosamente. Retorna `null` quando não há truncamento
 * a avisar. Pura, testável.
 */
export function warnIfLimitExceedsWorkerClamp(limit: number, clamp: number = DASHBOARD_WORKER_CLAMP): string | null {
  if (limit > clamp) {
    return `⚠️  --dashboard-limit ${limit} excede o clamp conhecido do Worker (${clamp}) — a resposta real virá truncada em ${clamp} campanhas.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audiência (#3593 item 2) — CSV + manifest (mesmo shape que clarice-import-waves.ts espera)
// ---------------------------------------------------------------------------

/**
 * `--extra-email a@b.com,c@d.com` → array normalizado (trim, sem vazios,
 * DEDUPLICADO case-insensitive — mantém a 1ª grafia). Pura, testável.
 *
 * Dedup aqui (não só em `buildRampCsv`) é o que mantém `entry.count`
 * (derivado do CSV real via `countRows`) consistente — sem isso, um
 * `--extra-email a@b.com,a@b.com` geraria 1 linha real no CSV mas o operador
 * poderia inferir 2 a partir do argumento cru.
 */
export function parseExtraEmailArg(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || !/\S+@\S+\.\S+/.test(trimmed)) continue;
    const norm = trimmed.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out;
}

/**
 * Monta o CSV (`email,NOME`) de uma wave: as linhas reais da audiência +
 * `extraEmails` anexados no fim (dedup case-insensitive contra a audiência
 * real E entre si — nunca duplica). Pura, testável.
 */
export function buildRampCsv(
  rows: Array<{ email: string; name: string | null }>,
  extraEmails: string[] = [],
): string {
  const seen = new Set(rows.map((r) => r.email.trim().toLowerCase()));
  const csvRows = rows.map((r) => ({ email: r.email, NOME: firstName(r.name) }));
  for (const raw of extraEmails) {
    const norm = raw.trim().toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    csvRows.push({ email: raw.trim(), NOME: "" });
  }
  return Papa.unparse({ fields: ["email", "NOME"], data: csvRows });
}

/** Monta os 3 WaveDef (mesmo shape lido por `loadWaveDefs`/`buildPlan` de clarice-import-waves.ts). Pura. */
export function buildRampManifest(volumes: number[], dayLabels: string[] = DAY_LABELS): WaveDef[] {
  return volumes.map((_v, i) => ({
    key: `w${i + 1}`,
    file: `w${i + 1}-${dayLabels[i]}.csv`,
    desc: `Rampa ${dayLabels[i]} (cold, 1º envio)`,
  }));
}

/** `totalRequested` cabe no crédito restante do ciclo Brevo? Pura, testável. */
export function creditCoversPlan(totalRequested: number, credits: number): boolean {
  return totalRequested <= credits;
}

/**
 * Seleção de audiência ramp-warm disponível — MESMOS 3 guards que a fila
 * REAL (`clarice-build-segment.ts --group ramp-warm`) e `clarice-plan-wave.ts`
 * (#5402/#5395, #5410) já aplicam, na mesma ordem:
 *   1. `segmentRampWarm` com o cutoff `novos`/`rampa` (#5424/#5410) — exclui
 *      quem ainda está na janela `novos`.
 *   2. `excludeCommittedToQueuedCampaigns` — exclui quem já está comprometido
 *      com uma campanha Brevo AGENDADA (queued) OU JÁ DISPARADA (sent).
 *   3. `excludeSentOrQueued` (#5403) — exclui quem já está rastreado em
 *      `sent-or-queued.json` (guard cycle-wide, cobre órfãos de replan que o
 *      guard 2 sozinho não vê).
 * Extraída como função pura pra ser testável sem SQLite/Brevo/filesystem — os
 * 2 call sites do achado #5403/#5424 (`--build-audience` deste script E
 * `weekly-send-plan-audience.ts`, via import direto) montam os 3 conjuntos
 * de input e delegam aqui, garantindo que não voltem a divergir.
 */
export function selectAvailableRampWarm(
  rows: StoreRow[],
  opts: {
    committedListIds: ReadonlySet<string>;
    sentOrQueuedEmails: ReadonlySet<string>;
    cutoffNovosIso: string | null;
  },
): (StoreRow & { name: string | null })[] {
  const rampWarm = segmentRampWarm(rows, { cutoffNovosIso: opts.cutoffNovosIso }) as (StoreRow & { name: string | null })[];
  const committedFiltered = excludeCommittedToQueuedCampaigns(rampWarm, opts.committedListIds) as (StoreRow & { name: string | null })[];
  return excludeSentOrQueued(committedFiltered, opts.sentOrQueuedEmails) as (StoreRow & { name: string | null })[];
}

// ---------------------------------------------------------------------------
// Datas explícitas (#3593 — "data é sempre explícita", nunca inferida de weekday)
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `--dates D1,D2,D3` — exatamente `count` datas YYYY-MM-DD, estritamente crescentes. Pura, testável. */
export function parseDatesArg(raw: string | undefined, count: number): string[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== count) return null;
  if (!parts.every((p) => ISO_DATE_RE.test(p) && !Number.isNaN(Date.parse(p)))) return null;
  for (let i = 1; i < parts.length; i++) {
    if (!(parts[i] > parts[i - 1])) return null; // estritamente crescente (comparação lexicográfica = cronológica em YYYY-MM-DD)
  }
  return parts;
}

/** `YYYY-MM-DD` → ISO 8601 UTC Z de 06:00 BRT (09:00 UTC — sem DST no Brasil desde 2019). Pura. */
export function scheduledAtFromDate(dateStr: string): string {
  if (!ISO_DATE_RE.test(dateStr)) throw new Error(`data inválida (esperado YYYY-MM-DD): "${dateStr}"`);
  return `${dateStr}T09:00:00.000Z`;
}

/**
 * #2101: guard simétrico ao de clarice-schedule-sends.ts — lança se alguma
 * das `scheduledAt` (já em ISO) for <= now. `nowOverride` injetável em teste.
 */
export function assertDatesFuture(scheduledAts: string[], nowOverride?: Date): void {
  const now = nowOverride ?? new Date();
  for (const iso of scheduledAts) {
    if (new Date(iso) <= now) {
      throw new Error(
        `--dates: ${iso} é passado ou presente (now=${now.toISOString()}). ` +
        `Use datas futuras — cada uma agenda um envio real de produção.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Guard de HTML (#3593 — "unsubscribe (legal)")
// ---------------------------------------------------------------------------

const UNSUBSCRIBE_MERGE_TAG_RE = /\{\{\s*unsubscribe\s*\}\}/i;

/**
 * Guard obrigatório ANTES de qualquer `POST /emailCampaigns`: o HTML precisa
 * conter a merge tag de descadastro do Brevo (`{{ unsubscribe }}`, ver
 * `context/templates/newsletter-monthly.md` — "Caso não queira receber a
 * newsletter, pode se [descadastrar aqui]({{ unsubscribe }})", coberto por
 * `test/monthly-template-apresentacao-2913.test.ts`). Sem ela, o envio sairia
 * sem link de descadastro válido — risco legal (CAN-SPAM/LGPD). Lança em vez
 * de logar warning: nunca criar uma campanha sem esse guard passar.
 */
export function assertHtmlHasUnsubscribeLink(html: string): void {
  if (html.length < 200) {
    throw new Error(`htmlContent suspeito demais (${html.length} chars) — abortando antes de criar campanha.`);
  }
  if (!UNSUBSCRIBE_MERGE_TAG_RE.test(html)) {
    throw new Error(
      `htmlContent NÃO contém a merge tag de descadastro {{ unsubscribe }} — abortando antes de criar campanha ` +
      `(risco legal: envio sem link de descadastro válido).`,
    );
  }
}

/**
 * Guard preventivo de instrumentação de experimento A/B (#4431): valida TODOS
 * os braços de um experimento (link de descadastro + estrutura HTML) ANTES de
 * agendar qualquer campanha.
 *
 * Contexto: o experimento CTA-01 (envios 8/9, ciclo 2606-07) teve o braço B
 * com abertura muito abaixo do braço A (9B: 2,1% vs 9A: 20,3%), com unsub
 * acompanhando a mesma queda — sinal que parecia instrumentação quebrada
 * (pixel de abertura ou link de unsub perdido no HTML do braço B). A
 * investigação completa (#4045/#4061, ver `docs/experiments/cta-ab-mensal-2606-07.md`)
 * REFUTOU essa hipótese: headers brutos idênticos nos 4 envios (mesmo IP/SPF/
 * DKIM/DMARC), e o re-fetch ao vivo das 4 campanhas via API (#4431) confirma
 * `{{unsubscribe}}` presente e a MESMA contagem de `<img>` nos 4 htmlContent.
 * A causa real foi colocação de caixa (foldering pra Spam/Promoções por
 * densidade de sinal promocional na copy do braço B + reputação de domínio já
 * degradada), não perda de instrumentação. Mesmo com a causa raiz sendo
 * outra, este guard continua valendo pra qualquer round futuro: se um braço
 * REALMENTE perder o unsub ou ficar estruturalmente divergente do outro
 * (classe de bug já vista aqui: a Brevo reescreve/remove UTMs no save do HTML
 * quando o GA tracking está ligado, #3893), este guard pega ANTES do
 * agendamento — não depois de queimar reputação de envio.
 *
 * O pixel de abertura da Brevo é injetado no ENVIO, server-side, fora do
 * `htmlContent` que este script controla — não existe campo de API pra
 * verificar isso pré-envio (confirmado ao vivo no #4431: `GET
 * /emailCampaigns/{id}` não expõe nenhum campo de tracking configurável por
 * campanha, e o `htmlContent` das 4 campanhas sent não contém nenhum pixel
 * nosso). O que É verificável e serve de proxy determinístico:
 *   (a) o link de descadastro que NÓS controlamos está presente em TODOS os
 *       braços (reusa `assertHtmlHasUnsubscribeLink`);
 *   (b) o HTML fecha `</body>` corretamente em todos os braços — pré-condição
 *       estrutural mínima pra qualquer injeção server-side (pixel, footer)
 *       funcionar;
 *   (c) todos os braços têm a MESMA contagem de `<img>` — um experimento que
 *       só muda copy nunca deveria mudar a contagem de imagens; divergência é
 *       sinal de perda de conteúdo assimétrica entre braços.
 */
export function assertExperimentArmsInstrumented(htmlByArm: Record<string, string>): void {
  const armIds = Object.keys(htmlByArm);
  if (armIds.length < 2) {
    throw new Error(`assertExperimentArmsInstrumented: esperava ≥2 braços, recebeu ${armIds.length}.`);
  }
  const imgCountByArm: Record<string, number> = {};
  for (const armId of armIds) {
    const html = htmlByArm[armId];
    try {
      assertHtmlHasUnsubscribeLink(html);
    } catch (e) {
      throw new Error(`Braço "${armId}": ${(e as Error).message}`);
    }
    if (!/<\/body\s*>/i.test(html)) {
      throw new Error(
        `Braço "${armId}": HTML sem tag de fechamento </body> — estrutura incompleta pode quebrar a injeção ` +
        `do pixel de abertura da Brevo no envio. Abortando antes de agendar.`,
      );
    }
    imgCountByArm[armId] = (html.match(/<img\b/gi) ?? []).length;
  }
  const distinctCounts = new Set(Object.values(imgCountByArm));
  if (distinctCounts.size > 1) {
    throw new Error(
      `Braços com contagem de <img> divergente (${JSON.stringify(imgCountByArm)}) — um experimento de copy não ` +
      `deveria mudar imagens; possível perda de conteúdo assimétrica entre braços. Abortando antes de agendar.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Import (#3593 item 3) — poll de contagem pós-import assíncrono
// ---------------------------------------------------------------------------

export interface PollResult {
  matched: boolean;
  finalCount: number;
  attempts: number;
}

/**
 * Faz polling de `fetchCount()` até `count >= expectedMin` ou esgotar
 * `maxAttempts`. `sleepFn` injetável (testes não esperam de verdade). Pura o
 * bastante pra testar com fakes — não faz nenhuma chamada de rede diretamente.
 */
export async function pollUntilCount(
  fetchCount: () => Promise<number>,
  expectedMin: number,
  opts: { maxAttempts?: number; delayMs?: number; sleepFn?: (ms: number) => Promise<void> } = {},
): Promise<PollResult> {
  // #self-review: default 12×15s = até 3min de espera — memória #260716 registra
  // "10k leva ~1-2min" pro import assíncrono da Brevo; o default anterior
  // (6×10s = 60s) provavelmente marcaria `matched:false` (falso negativo) em
  // waves de produção normais, mesmo com o import de fato tendo sucesso.
  const maxAttempts = opts.maxAttempts ?? 12;
  const delayMs = opts.delayMs ?? 15_000;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let last = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await fetchCount();
    if (last >= expectedMin) return { matched: true, finalCount: last, attempts: attempt };
    if (attempt < maxAttempts) await sleepFn(delayMs);
  }
  return { matched: false, finalCount: last, attempts: maxAttempts };
}

// ---------------------------------------------------------------------------
// Estado (`ramp-summary.json`) — idempotência entre invocações/fases
// ---------------------------------------------------------------------------

export interface RampWaveEntry {
  key: string; // "w1" | "w2" | "w3"
  day: string; // rótulo informacional (ter/sex/dom)
  file: string;
  desc: string;
  volume: number; // budget planejado
  count: number; // linhas reais escritas no CSV (audiência + extras)
  listId?: number;
  listName?: string;
  importedCount?: number;
  campaignId?: number;
  subject?: string;
  scheduledAt?: string;
  // #3643 bug 1/2: "list_created" é o estado intermediário entre "criamos a
  // lista Brevo" e "confirmamos o import" — permite retry seguro (reusa a
  // lista existente em vez de recriar) sem marcar a wave como concluída antes
  // da hora. "import_incomplete" é terminal-mas-não-confirmado: o poll não
  // bateu a contagem esperada; --create/--schedule recusam prosseguir sem
  // --force (ver `assertImportUsable`).
  status: "planned" | "list_created" | "imported" | "import_incomplete" | "draft" | "scheduled";
  /**
   * #4612: presente quando o VOLUME desta wave (campo `volume` acima) foi
   * computado por `resolveAutoRampVolumes` sobre dado STALE do dashboard —
   * nunca setado quando `--volumes A,B,C` explícito foi usado (nesse caso não
   * há fetch ao dashboard, não há stale a reportar). Antes do #4612, esse
   * sinal só existia como `console.error` — some junto com a sessão de
   * terminal. Persistido aqui pra sobreviver às invocações SEPARADAS e
   * possivelmente dias-depois de `--import`/`--create`/`--schedule`, que
   * releem só este arquivo, nunca a saída de `--build-audience`.
   */
  stale?: DashboardStaleInfo;
}

/**
 * Ordem do ciclo de vida da wave — usada por `hasPassedImportPhase` pra
 * decidir se um status já avançou PARA ALÉM da fase de import. Ordem
 * importa: `"import_incomplete"` fica ANTES de `"imported"` de propósito —
 * é terminal-mas-NÃO-confirmado (o poll não bateu a contagem esperada),
 * então um retry de `--import` deve reprocessá-lo, não pulá-lo. `"imported"`,
 * `"draft"` (pós `--create`) e `"scheduled"` (pós `--schedule`) são todos
 * ">= imported" — a wave já passou do import com sucesso e progrediu.
 */
export const WAVE_STATUS_ORDER: readonly RampWaveEntry["status"][] = [
  "planned",
  "list_created",
  "import_incomplete",
  "imported",
  "draft",
  "scheduled",
];

/**
 * #3652 bug 1: um status "já passou da fase de import" — reusável, em vez de
 * comparações literais espalhadas pelas 3 fases. Pura, testável.
 */
export function hasPassedImportPhase(status: RampWaveEntry["status"]): boolean {
  return WAVE_STATUS_ORDER.indexOf(status) >= WAVE_STATUS_ORDER.indexOf("imported");
}

/**
 * #3643 bug 1: decide se uma wave já foi IMPORTADA COM SUCESSO e deve ser
 * pulada num re-run de `--import`. Antes, o skip-check gatava em
 * `entry.listId !== undefined` — mas `listId` é gravado ANTES da chamada
 * `/contacts/import` ser sequer tentada, então um import que falhasse
 * (rede, 5xx, CSV malformado) deixava a wave PERMANENTEMENTE pulada em
 * re-runs futuros, com uma lista Brevo vazia. Gatear em `status === "imported"`
 * (só setado após confirmação, ver `resolveImportStatus`) corrigiu isso — um
 * retry após falha vê `status` intermediário e tenta de novo.
 *
 * #3652 bug 1 (gap residual do fix acima): reconhecer só o literal
 * `"imported"` não bastava — o ciclo de vida da wave avança por mais 2
 * estados depois (`"draft"` pós `--create`, `"scheduled"` pós `--schedule`).
 * Como o script não tem flag pra targetar 1 wave específica, um retry de
 * `--import` pra recuperar 1 wave que falhou necessariamente reprocessa TODO
 * o manifest — inclusive waves já avançadas pra `"draft"`/`"scheduled"` numa
 * rodada anterior do ramp multi-dia. `entry.listId` permanece setado pra
 * sempre (nunca é limpo por fases posteriores), então o `--import` reusava a
 * lista existente, re-POSTava `/contacts/import` incondicionalmente, e
 * sobrescrevia `entry.status` de volta pra `"imported"`/`"import_incomplete"`
 * — CLOBBERING o status mais avançado. Agora usa `hasPassedImportPhase`, que
 * reconhece QUALQUER status "imported"/"draft"/"scheduled" como já concluído
 * — a wave nunca chega no código que sobrescreveria seu status. Pura, testável.
 */
export function shouldSkipImport(entry: Pick<RampWaveEntry, "status">): boolean {
  return hasPassedImportPhase(entry.status);
}

/**
 * #3643 bug 2: resolve o status pós-import — só "imported" quando o poll
 * de fato bateu a contagem esperada (ou a verificação foi explicitamente
 * pulada via `--skip-verify`, decisão consciente do operador). Antes,
 * `entry.status = "imported"` era setado incondicionalmente mesmo com
 * `poll.matched === false`, com o único rastro sendo um `console.error`
 * fácil de perder. Pura, testável.
 */
export function resolveImportStatus(matched: boolean, skipVerify: boolean): "imported" | "import_incomplete" {
  if (skipVerify) return "imported";
  return matched ? "imported" : "import_incomplete";
}

/**
 * #3643 bug 2: guard que `--create`/`--schedule` chamam antes de prosseguir
 * com uma wave — recusa avançar se o import não foi confirmado
 * (`status === "import_incomplete"`), a menos que `--force` seja passado
 * explicitamente (override consciente do operador). Também recusa se o
 * import nem foi tentado ainda (`"planned"`/`"list_created"`). Pura, testável.
 *
 * #3660 (gap residual do #3652): usa `hasPassedImportPhase` em vez do
 * literal `entry.status === "imported"` — reconhece também `"draft"`
 * (pós `--create`) e `"scheduled"` (pós `--schedule`) como já usáveis, igual
 * ao `shouldSkipImport` (mesma fonte única de verdade, `WAVE_STATUS_ORDER`).
 * Antes, uma entry com status `"draft"`/`"scheduled"` (wave já avançada numa
 * rodada anterior do ramp multi-dia) não batia nem no `"imported"` nem no
 * `"import_incomplete"`, caindo incorretamente no `throw` final de "import
 * não concluído" — mesmo a wave já tendo passado da fase de import há muito.
 */
export function assertImportUsable(
  entry: Pick<RampWaveEntry, "key" | "status" | "count" | "importedCount">,
  force: boolean,
): void {
  if (hasPassedImportPhase(entry.status)) return;
  if (entry.status === "import_incomplete") {
    if (force) return;
    throw new Error(
      `${entry.key}: import não confirmado (esperado ${entry.count}, visto ${entry.importedCount ?? "?"} contatos) — ` +
      `rode --import novamente pra tentar reconfirmar, ou use --force pra prosseguir mesmo assim.`,
    );
  }
  throw new Error(`${entry.key}: import não concluído (status "${entry.status}") — rode --import antes.`);
}

/**
 * #3643 bug 3: monta o `fileBody` do `POST /contacts/import` incluindo a
 * cópia QA do editor (#3455) — MESMO ponto de injeção que
 * `clarice-import-waves.ts:316`/`clarice-import-sends.ts:102` usam
 * (`ensureEditorCopyRow(normalizeImportCsv(...))`). Antes, este script só
 * chamava `normalizeImportCsv`, quebrando o invariante "ponto único de
 * injeção" — as 3 campanhas ramp-warm excluíam a cópia QA do editor por
 * padrão, dependendo do operador lembrar de passar `--extra-email`
 * manualmente toda vez. Pura, testável.
 */
export function buildImportFileBody(csv: string): string {
  return ensureEditorCopyRow(normalizeImportCsv(csv));
}

export interface CampaignsReadyCheck {
  ready: boolean;
  missingKeys: string[];
}

/**
 * #3643 bug 4: verifica ANTES do loop de `--schedule` que TODAS as entries
 * têm `campaignId` definido — mesmo padrão implícito de
 * `clarice-schedule-sends.ts` (lá, `campaigns[]` só contém entries JÁ
 * criadas por construção, nunca uma mistura). Antes, o loop de `--schedule`
 * iterava o manifest INTEIRO sem esse filtro: se uma wave anterior tinha
 * `campaignId` válido e uma posterior não, o loop disparava `brevoPut`
 * REAIS (agendamento de produção) pras waves válidas, DEPOIS lançava ao
 * chegar na wave sem campanha — e como `applyVerifyResults` (que persiste
 * `status: "scheduled"`) só roda UMA VEZ após o loop inteiro, as waves já
 * agendadas no Brevo nunca tinham seu estado local atualizado (campanhas
 * agendadas SÃO editáveis via `PUT /emailCampaigns/{id}` na Brevo, #4935 —
 * um retry indevido tentaria re-PUTar via API algo que já foi aceito, o que
 * não falha mas é redundante e confunde o rastro de estado local). Um
 * `--create` incompleto agora bloqueia
 * `--schedule` pra TODAS as waves com um erro claro upfront, em vez de
 * agendar parcialmente e perder o rastro do estado. Pura, testável.
 */
export function checkAllCampaignsCreated(entries: Array<{ key: string; campaignId?: number }>): CampaignsReadyCheck {
  const missingKeys = entries.filter((e) => e.campaignId === undefined).map((e) => e.key);
  return { ready: missingKeys.length === 0, missingKeys };
}

// ---------------------------------------------------------------------------
// --schedule loop (#3652 bug 2 — persistência per-iteração)
// ---------------------------------------------------------------------------

export type CampaignEntryLike = {
  key: string;
  campaignId: number;
  listId: number;
  subject: string;
  scheduledAt: string;
  status: "draft" | "scheduled";
};

export interface ScheduleLoopDeps {
  /** Executa o PUT real de agendamento (`brevoPut .../emailCampaigns/{id}`). */
  putFn: (view: CampaignEntryLike) => Promise<void>;
  /** Executa o GET-verify pós-PUT (`brevoGetCampaign`). */
  verifyFn: (view: CampaignEntryLike) => Promise<{ status: string }>;
  writeFn?: (path: string, content: string) => void;
  logFn?: (msg: string) => void;
  now?: () => Date;
}

/**
 * #3652 bug 2: roda o loop de `--schedule` persistindo o resultado de CADA
 * wave (`applyVerifyResults`, que já grava em disco por-entry — ver docstring
 * em clarice-schedule-sends.ts) IMEDIATAMENTE após seu `putFn`+`verifyFn`,
 * ANTES de tentar a próxima wave.
 *
 * Antes (gap residual do fix do #3643 bug 4): `checkAllCampaignsCreated` só
 * validava `campaignId !== undefined` ANTES do loop começar — não protegia
 * contra um `putFn` (brevoPut) falhar por QUALQUER outro motivo (timeout,
 * 5xx, rate-limit transiente) NO MEIO do loop. O loop antigo acumulava todas
 * as views cujo `putFn` teve sucesso em `toVerify` e só chamava
 * `applyVerifyResults` UMA VEZ, depois do loop inteiro terminar — se a wave N
 * lançasse, a exceção propagava ANTES da persistência rodar, perdendo o
 * rastro local das waves 1..N-1 cujo agendamento JÁ foi aceito na Brevo —
 * reverter exigiria cancelar via API/painel e recriar (#4935), não é
 * gratuito mesmo não sendo mais estado terminal. Mesma classe de bug que o
 * #3643 bug 4 eliminou, só que via um gatilho diferente (não coberto por
 * `checkAllCampaignsCreated`).
 *
 * Agora: cada wave é PUT + GET-verify + persistida antes de seguir pra
 * próxima. Se `putFn` de uma wave lançar, a exceção ainda propaga (mesmo
 * contrato de antes — `main().catch()` trata como erro fatal), mas só DEPOIS
 * de garantir que toda wave anterior bem-sucedida já está gravada em disco.
 * `verifyFn` nunca precisa de try/catch aqui — passa por `Promise.allSettled`
 * (mesmo padrão do loop antigo) e `applyVerifyResults` já trata rejection
 * sem lançar (warn + status local não atualizado, retry seguro).
 */
export async function runScheduleLoop(
  campaignsView: CampaignEntryLike[],
  rampSummaryPath: string,
  deps: ScheduleLoopDeps,
): Promise<void> {
  const writeFn = deps.writeFn ?? ((p, c) => writeFileAtomic(p, c));
  const logFn = deps.logFn ?? ((m) => console.error(m));
  const now = deps.now ?? (() => new Date());

  for (const view of campaignsView) {
    if (view.status === "scheduled") {
      logFn(`↷ ${view.key} já agendada — pulando`);
      continue;
    }
    if (!view.scheduledAt) throw new Error(`${view.key}: scheduledAt ausente — recrie via --create.`);
    if (new Date(view.scheduledAt) <= now()) {
      throw new Error(`--schedule: ${view.key} (campanha #${view.campaignId}) tem scheduledAt no passado/presente (${view.scheduledAt}).`);
    }

    await deps.putFn(view); // brevoPut REAL — agendamento aceito na Brevo a partir daqui (cancelável via API/painel + recriação, #4935, mas não é gratuito)

    // #3652 bug 2: persiste ESTA wave IMEDIATAMENTE — se a PRÓXIMA falhar, o
    // registro local desta já está gravado, não some junto com a exceção.
    const settled = await Promise.allSettled([deps.verifyFn(view)]);
    applyVerifyResults(settled, [view], campaignsView, rampSummaryPath, writeFn, logFn);
  }
}

function rampSummaryPath(rampDir: string): string {
  return resolve(rampDir, "ramp-summary.json");
}

function loadRampSummary(rampDir: string): RampWaveEntry[] {
  const p = rampSummaryPath(rampDir);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    throw new Error(`ramp-summary.json corrompido (JSON inválido): ${p}\n${String(e)}`);
  }
}

function writeRampSummary(rampDir: string, entries: RampWaveEntry[]): void {
  writeFileAtomic(rampSummaryPath(rampDir), JSON.stringify(entries, null, 2));
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2606-07).");
    process.exit(1);
  }
  const doBuildAudience = hasFlag(argv, "build-audience");
  const doImport = hasFlag(argv, "import");
  const doCreate = hasFlag(argv, "create");
  const doTest = hasFlag(argv, "send-test");
  const doSchedule = hasFlag(argv, "schedule");
  const skipEiaGuard = hasFlag(argv, "skip-eia-guard");
  const skipVerify = hasFlag(argv, "skip-verify");
  const force = hasFlag(argv, "force"); // #3643 bug 2: override consciente pra prosseguir com import não-confirmado

  // #4612: `--data-root` OPCIONAL, uso interno de teste — mesmo padrão de
  // `--data-root` em clarice-build-segment.ts/verify-emails-mv.ts (#4207,
  // generaliza o `--segments-dir` pontual do #4176). Sem isso, `main()` só
  // conseguia escrever sob o `data/` real (junction OneDrive) — impossível
  // isolar um teste de `--build-audience` num tmpdir sem tocar disco de
  // produção.
  const dataRootArg = getArg(argv, "data-root");
  const rampDir = clariceRampDir(cycle, dataRootArg || undefined);
  const manifestPath = resolve(rampDir, "ramp-manifest.json");

  // --- 1. Volumes ---
  const volumesArg = parseVolumesArg(getArg(argv, "volumes"));
  let volumes: [number, number, number];
  // #4612: `stale`, quando presente, é dado sobre o FETCH ao dashboard, não
  // sobre `--volumes` explícito (nesse ramo não há fetch nenhum) — populado
  // só no ramo auto abaixo, e depois propagado pro JSON impresso E pras
  // entries de `ramp-summary.json` (`--build-audience`), pra não se perder
  // além do `console.error` que já existia (#4543).
  let autoVolumesStale: DashboardStaleInfo | undefined;
  if (volumesArg) {
    volumes = volumesArg;
    console.error(`📋 Volumes (explícito --volumes): ${volumes.join(", ")}`);
  } else {
    const dashboardUrl = getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL;
    // #4568 (review): migrado junto com o call site irmão em
    // clarice-check-semaphore.ts. O `resolveDashboardLimit` remendado cobre o
    // caso "" que causou o bug, mas ainda aceita negativo e não-inteiro
    // (`"-5"` → -5 → `?limit=-5`) e cai em fallback mudo pra lixo — manter
    // DUAS disciplinas de erro pra MESMA flag, no mesmo arquivo, é como o
    // invariante divergiu da primeira vez.
    const limit = getIntArg(argv, "dashboard-limit", { min: 1 }) ?? DEFAULT_DASHBOARD_LIMIT;
    const limitWarning = warnIfLimitExceedsWorkerClamp(limit);
    if (limitWarning) console.error(limitWarning);
    console.error(`📋 Volumes: nenhum --volumes explícito — recomputando via ${dashboardUrl}/api/campaigns?limit=${limit}…`);
    const result = await resolveAutoRampVolumes(dashboardUrl, limit);
    autoVolumesStale = result.stale;
    if (!result.ok) {
      console.error(`❌ ${result.reason}`);
      process.exit(1);
    }
    volumes = result.plan.volumes;
    console.error(
      `   ${{ green: "🟢", yellow: "🟡", red: "🔴" }[result.plan.semaphore]} semáforo=${result.plan.semaphore} ` +
      `base=${result.plan.baseVolume.toLocaleString("pt-BR")} → volumes: ${volumes.join(", ")}` +
      (result.plan.flagged ? "  ⚠️ revisar antes de prosseguir (semáforo vermelho)" : ""),
    );
    // #5592: nomeia o(s) breaker(s) — sem isso o operador via só "semáforo=red"
    // e precisava abrir o dashboard pra descobrir qual métrica furou.
    if (result.plan.breachedMetrics?.length) {
      console.error(`   🔎 métrica(s) rompida(s): ${result.plan.breachedMetrics.join("; ")}`);
    }
  }
  const totalRequested = volumes.reduce((a, b) => a + b, 0);

  const dayLabelsArg = getArg(argv, "days");
  const dayLabels = dayLabelsArg ? dayLabelsArg.split(",").map((s) => s.trim()) : DAY_LABELS;
  if (dayLabels.length !== 3) {
    console.error(`❌ --days precisa ter exatamente 3 rótulos separados por vírgula (recebido: "${dayLabelsArg}").`);
    process.exit(1);
  }

  if (!doBuildAudience && !doImport && !doCreate && !doTest && !doSchedule) {
    console.error(`\ndry-run — use --build-audience, depois --import, depois --create, --send-test, --schedule.`);
    console.log(JSON.stringify(
      { mode: "dry-run", cycle, volumes, total: totalRequested, ...(autoVolumesStale ? { stale: autoVolumesStale } : {}) },
      null,
      2,
    ));
    return;
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }

  // --- 2. --build-audience ---
  if (doBuildAudience) {
    if (existsSync(manifestPath)) {
      console.error(
        `❌ ${manifestPath} já existe — --build-audience recusa reescrever (evita re-fatiar a audiência com outro ` +
        `resultado e perder rastreabilidade do que já foi importado/agendado). Delete o diretório manualmente se a ` +
        `intenção é genuinamente recomeçar este ciclo.`,
      );
      process.exit(1);
    }

    // Crédito Brevo cobre a soma ANTES de escrever qualquer coisa (mesmo racional de weekly-send-plan-audience.ts).
    const { body: account } = await brevoGet(apiKey, "/account");
    const credits = extractPlanCredits(account);
    if (credits === null) {
      console.error("❌ Não foi possível ler créditos do plano Brevo (/v3/account). Abortando --build-audience.");
      process.exit(1);
    }
    console.error(`Crédito restante no ciclo Brevo: ${credits.toLocaleString("pt-BR")}.`);
    if (!creditCoversPlan(totalRequested, credits)) {
      console.error(
        `❌ Total do plano (${totalRequested.toLocaleString("pt-BR")}) excede o crédito restante ` +
        `(${credits.toLocaleString("pt-BR")}). Reduza --volumes ou aguarde o próximo ciclo de cobrança.`,
      );
      process.exit(1);
    }

    // #2994/#3682: exclui quem já está comprometido com uma campanha AGENDADA
    // (queued) OU JÁ DISPARADA (sent, imune ao lag de sends_count local) —
    // mesmo guard de weekly-send-plan-audience.ts.
    const committedListIds = await fetchCommittedCampaignListIds(apiKey);
    if (committedListIds.size > 0) {
      console.error(`Campanhas agendadas/já disparadas detectadas — ${committedListIds.size} lista(s) comprometida(s) serão excluídas.`);
    }

    const db = openClariceDb(getArg(argv, "db") || DEFAULT_DB_PATH);
    let rows: StoreRow[];
    try {
      rows = db
        .prepare(
          `SELECT email, name, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count,
                  opens_count, last_sent_at, mv_bucket, brevo_list_ids
             FROM clarice_users`,
        )
        .all() as unknown as (StoreRow & { name: string | null })[];
    } finally {
      db.close();
    }

    // #5424/#5403: mesmo cutoff novos/rampa (#5410) + guard cycle-wide
    // sent-or-queued.json (#5402/#5395) que a fila REAL
    // (`clarice-build-segment.ts --group ramp-warm`) já aplica em produção —
    // ver docstring de `selectAvailableRampWarm` abaixo.
    const novosCutoff = readNovosCutoff(CLARICE_BASE);
    const sentOrQueuedEmails = loadSentOrQueuedEmails(clariceSegmentsDir(cycle));
    const ordered = selectAvailableRampWarm(rows, {
      committedListIds,
      sentOrQueuedEmails,
      cutoffNovosIso: novosCutoff?.cutoffIso ?? null,
    });
    console.error(`Audiência elegível (ramp-warm): ${ordered.length.toLocaleString("pt-BR")} contatos.`);

    const extraEmails = parseExtraEmailArg(getArg(argv, "extra-email"));
    const groups = sliceIntoVolumes(ordered, volumes);
    const shortfall = totalRequested - ordered.length;
    if (shortfall > 0) {
      console.error(
        `⚠️  Audiência disponível (${ordered.length.toLocaleString("pt-BR")}) é menor que o total pedido ` +
        `(${totalRequested.toLocaleString("pt-BR")}) — as últimas waves ficarão menores.`,
      );
    }

    ensureDir(rampDir);
    const manifest = buildRampManifest(volumes, dayLabels);
    const entries: RampWaveEntry[] = [];
    groups.forEach((g, i) => {
      const csv = buildRampCsv(g, extraEmails);
      writeFileSync(resolve(rampDir, manifest[i].file), csv, "utf8");
      // #self-review: `count` deriva do CSV REAL (countRows, mesma função de
      // clarice-import-waves.ts) em vez de recalcular via aritmética manual —
      // uma versão anterior somava `g.length + extraEmails.filter(...)`, que
      // divergia do CSV de fato escrito sempre que `--extra-email` continha
      // uma entrada já presente na audiência de OUTRA wave mas coincidia em
      // grafia distinta (edge case de dedup). Contar o CSV escrito é a fonte
      // única de verdade — não pode divergir por construção.
      entries.push({
        key: manifest[i].key,
        day: dayLabels[i],
        file: manifest[i].file,
        desc: manifest[i].desc,
        volume: volumes[i],
        count: countRows(csv),
        status: "planned",
        // #4612: persiste a proveniência stale (quando o volume veio do
        // ramo auto sobre cache do dashboard) em CADA entry — sobrevive à
        // sessão de terminal, diferente do console.error de
        // resolveAutoRampVolumes, e é relido por invocações SEPARADAS
        // (--import/--create/--schedule), possivelmente dias depois.
        ...(autoVolumesStale ? { stale: autoVolumesStale } : {}),
      });
      console.error(`  ${manifest[i].key} (${dayLabels[i]}): ${g.length.toLocaleString("pt-BR")}/${volumes[i].toLocaleString("pt-BR")} contatos → ${manifest[i].file}`);
    });
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    writeRampSummary(rampDir, entries);
    console.error(`✅ audiência escrita em ${rampDir}`);
  }

  // --- 3. --import ---
  if (doImport) {
    if (!existsSync(manifestPath)) throw new Error(`${manifestPath} ausente — rode --build-audience antes.`);
    const manifest: WaveDef[] = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entries = loadRampSummary(rampDir);
    const byKey = new Map(entries.map((e) => [e.key, e]));

    const label = getArg(argv, "label") || `Ramp ${cycle}`;
    const plannedNames = manifest
      .filter((w) => byKey.get(w.key)?.listId === undefined)
      .map((w) => `Clarice ${label} ${w.key} — ${byKey.get(w.key)?.desc ?? w.desc}`);
    if (plannedNames.length > 0) {
      const conflicts = findExistingConflicts(plannedNames, await brevoListAllLists(apiKey));
      if (conflicts.length) {
        console.error(`❌ ${conflicts.length} lista(s) com esses nomes JÁ existem no Brevo — delete-as ou mude --label:`);
        for (const c of conflicts) console.error(`   #${c.id} "${c.name}"`);
        process.exit(1);
      }
    }

    for (const w of manifest) {
      const entry = byKey.get(w.key);
      if (!entry) throw new Error(`ramp-summary.json não tem entrada para ${w.key} — rode --build-audience antes.`);
      // #3643 bug 1: gate no status TERMINAL ("imported"), não em `listId`
      // (que é gravado ANTES do import ser sequer tentado — ver docstring de
      // shouldSkipImport). Isso permite retomar com segurança waves cujo
      // import anterior falhou/não confirmou.
      if (shouldSkipImport(entry)) {
        console.error(`↷ ${w.key} já importada (lista #${entry.listId}) — pulando`);
        continue;
      }
      const csvPath = resolve(rampDir, w.file);
      if (!existsSync(csvPath)) throw new Error(`CSV faltando: ${csvPath}`);
      const csv = readFileSync(csvPath, "utf8");

      // #3643 bug 1: reusa a lista já criada num retry em vez de recriar
      // (entry.listId sobrevive a um `status` intermediário/import_incomplete).
      let listId: number;
      if (entry.listId !== undefined) {
        listId = entry.listId;
        console.error(`\n↪ ${w.key}: lista já criada (#${listId}) — retomando import…`);
      } else {
        const listName = `Clarice ${label} ${w.key} — ${entry.desc}`;
        console.error(`\n→ ${w.key}: criando lista "${listName}"…`);
        const list = (await brevoPost(apiKey, "/contacts/lists", { name: listName, folderId: 1 })) as { id?: number };
        if (typeof list?.id !== "number") throw new Error(`Brevo /contacts/lists retornou shape inesperado: ${JSON.stringify(list)}`);
        entry.listId = list.id;
        entry.listName = listName;
        entry.status = "list_created";
        writeRampSummary(rampDir, entries);
        listId = list.id;
      }

      console.error(`   list #${listId} · importando ${entry.count} contatos…`);
      // #3643 bug 3: ensureEditorCopyRow (#3455) — MESMO ponto de injeção que
      // clarice-import-waves.ts/clarice-import-sends.ts, garante a cópia QA
      // do editor em todo envio real, sem depender de --extra-email manual.
      await brevoPost(apiKey, "/contacts/import", {
        fileBody: buildImportFileBody(csv),
        listIds: [listId],
        updateExistingContacts: true,
        emptyContactsAttributes: false,
      });

      if (!skipVerify) {
        const poll = await pollUntilCount(
          async () => (await brevoGetList(apiKey, listId)).totalSubscribers,
          entry.count,
        );
        entry.importedCount = poll.finalCount;
        // #3643 bug 2: status só vira "imported" quando o poll de fato bate —
        // caso contrário "import_incomplete" (terminal-mas-não-confirmado),
        // que --create/--schedule recusam ultrapassar sem --force.
        entry.status = resolveImportStatus(poll.matched, false);
        if (poll.matched) {
          console.error(`   ✓ import confirmado (${poll.finalCount} assinantes, ${poll.attempts} tentativa(s))`);
        } else {
          console.error(
            `   ⚠️  import ainda não bateu a contagem esperada após ${poll.attempts} tentativas ` +
            `(esperado ${entry.count}, visto ${poll.finalCount}) — Brevo pode levar mais tempo pra processar lotes grandes; ` +
            `status marcado "import_incomplete" — verifique manualmente, rode --import de novo, ou use --force em --create.`,
          );
        }
      } else {
        entry.status = resolveImportStatus(true, true);
        console.error(`   ⚠️  --skip-verify ativo — import não confirmado, marcando "imported" mesmo assim (decisão explícita do operador).`);
      }
      writeRampSummary(rampDir, entries);
    }
  }

  // --- 4/5. --create / --send-test / --schedule ---
  if (doCreate || doTest || doSchedule) {
    const entries = loadRampSummary(rampDir);
    if (entries.length === 0) throw new Error(`ramp-summary.json vazio — rode --build-audience + --import antes.`);

    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const brevo = cfg.brevo_monthly;
    if (!brevo?.sender_email) throw new Error("brevo_monthly.sender_email ausente no platform.config.json");

    const htmlPath = resolve(resolveMonthlyDir(cycle), "_internal", "cloudflare-preview.html");
    if (!existsSync(htmlPath)) throw new Error(`HTML render não existe: ${htmlPath}`);
    const html = readFileSync(htmlPath, "utf8");

    if (doCreate) {
      assertHtmlHasUnsubscribeLink(html); // guard legal ANTES de qualquer POST

      const subject = getArg(argv, "subject") || undefined;
      if (!subject) throw new Error("--create requer --subject \"Assunto da campanha\".");
      const previewText = getArg(argv, "preview-text") || undefined;

      const dates = parseDatesArg(getArg(argv, "dates"), entries.length);
      if (!dates) throw new Error(`--create requer --dates D1,D2,D3 (YYYY-MM-DD, ${entries.length} datas crescentes, ex: --dates 2026-07-18,2026-07-21,2026-07-23).`);
      const scheduledAts = dates.map(scheduledAtFromDate);
      assertDatesFuture(scheduledAts);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.campaignId !== undefined) {
          console.error(`↷ ${entry.key} já criada (#${entry.campaignId}) — pulando`);
          continue;
        }
        // #3643 bug 2: recusa prosseguir com import não-confirmado (status
        // "planned"/"list_created"/"import_incomplete") sem --force explícito.
        assertImportUsable(entry, force);
        if (entry.listId === undefined) throw new Error(`${entry.key}: listId ausente — rode --import antes.`);
        const resp = (await brevoPost(apiKey, "/emailCampaigns", {
          name: `cold ${cycle} — ${entry.key} (${entry.day})`,
          subject,
          ...(previewText ? { previewText } : {}),
          sender: { name: brevo.sender_name, email: brevo.sender_email },
          recipients: { listIds: [entry.listId] },
          htmlContent: html,
        })) as { id?: number };
        if (typeof resp?.id !== "number") throw new Error(`/emailCampaigns shape inesperado: ${JSON.stringify(resp)}`);
        entry.campaignId = resp.id;
        entry.subject = subject;
        entry.scheduledAt = scheduledAts[i];
        entry.status = "draft";
        writeRampSummary(rampDir, entries);
        console.error(`✓ ${entry.key} → campanha #${resp.id} (rascunho, agendamento planejado ${scheduledAts[i]})`);
      }
    }

    if (doTest) {
      for (const entry of entries) {
        if (entry.campaignId === undefined) throw new Error(`${entry.key}: campanha não criada — rode --create antes.`);
        await brevoPost(apiKey, `/emailCampaigns/${entry.campaignId}/sendTest`, { emailTo: [brevo.test_email] });
        console.error(`✓ test email ${entry.key} (campanha #${entry.campaignId}) → ${brevo.test_email}`);
      }
    }

    if (doSchedule) {
      const eiaCheck = checkEiaGuard(cycle, skipEiaGuard, undefined);
      if (!eiaCheck.ok) {
        console.error(eiaCheck.message);
        process.exit(1);
      }
      console.error(skipEiaGuard ? `⚠  --skip-eia-guard ativo — verificação de gabarito É IA? ignorada.` : `✓ Gabarito É IA? verificado`);

      // #2018/#2101: `applyVerifyResults` muta `c.status` NOS MESMOS OBJETOS que
      // recebe em `toVerify`/`campaigns` (mesmo padrão de clarice-schedule-sends.ts/
      // clarice-schedule-group.ts) — por isso `campaignsView` é um cast estrutural
      // de `entries` (MESMA referência de array/objetos, não uma cópia): mutar via
      // a view propaga pro `entries` real, e o `writeFn` grava o `entries` completo
      // (não só o subconjunto agendado nesta invocação) em ramp-summary.json.
      const campaignsView = entries as unknown as CampaignEntryLike[];

      // #3643 bug 4: filtra/valida ANTES de qualquer PUT — igual ao padrão
      // implícito de clarice-schedule-sends.ts (lá `campaigns[]` só contém
      // entries JÁ criadas por construção). Antes, o loop abaixo iterava
      // TODO o manifest sem esse guard: se uma wave anterior tivesse
      // campaignId válido e uma posterior não, o loop disparava `brevoPut`
      // REAIS (agendamento de produção) pras waves válidas e SÓ ENTÃO lançava
      // ao chegar na wave sem campanha — e como `applyVerifyResults` só roda
      // UMA VEZ após o loop inteiro, as waves já agendadas no Brevo nunca
      // tinham seu `status: "scheduled"` persistido localmente (campanhas
      // agendadas SÃO editáveis via PUT na Brevo, #4935 — um retry indevido
      // tentaria re-PUTar algo já aceito, redundante mas não fatal). Um
      // --create incompleto agora bloqueia --schedule pra
      // TODAS as waves com um erro claro upfront, antes de qualquer chamada real.
      const readyCheck = checkAllCampaignsCreated(campaignsView);
      if (!readyCheck.ready) {
        throw new Error(
          `--schedule: ${readyCheck.missingKeys.join(", ")} sem campanha criada (campaignId ausente) — ` +
          `rode --create para TODAS as waves antes de agendar (agendamento parcial deixaria waves já ` +
          `agendadas no Brevo com o estado local (ramp-summary.json) desatualizado).`,
        );
      }

      // #3652 bug 2: cada wave é PUT + GET-verify + persistida ANTES de
      // seguir pra próxima — não mais "PUT todas, verifica/persiste no fim"
      // (ver docstring de `runScheduleLoop`).
      await runScheduleLoop(campaignsView, rampSummaryPath(rampDir), {
        putFn: async (view) => { await brevoPut(apiKey, `/emailCampaigns/${view.campaignId}`, { scheduledAt: view.scheduledAt }); },
        verifyFn: (view) => brevoGetCampaign(apiKey, view.campaignId),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        cycle,
        volumes,
        // #4612: `stale` no resumo final do modo-AÇÃO — antes, o único lugar
        // onde esse sinal aparecia era o `console.error` de
        // `resolveAutoRampVolumes` (perdido assim que a sessão de terminal
        // fecha). `entries[].stale` (por-wave, persistido em
        // ramp-summary.json) é a fonte de verdade que sobrevive entre
        // invocações; este campo top-level é só o resumo da invocação ATUAL.
        ...(autoVolumesStale ? { stale: autoVolumesStale } : {}),
        entries: loadRampSummary(rampDir).map((e) => ({
          key: e.key,
          status: e.status,
          listId: e.listId,
          campaignId: e.campaignId,
          ...(e.stale ? { stale: e.stale } : {}),
        })),
      },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String((e as Error)?.stack || e));
    process.exit(1);
  });
}
