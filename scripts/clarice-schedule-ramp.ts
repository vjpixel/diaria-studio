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
 *                  enviado, mv_bucket verificado), exclui quem já está
 *                  comprometido com uma campanha AGENDADA (queued, #2994) e
 *                  fatia nos 3 volumes (ordem preservada, cohortSendRank
 *                  morno→frio). `--extra-email` anexa email(s) fixo(s) nas 3
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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoPut, brevoGetCampaign, brevoGetList, brevoGet, brevoListAllLists, fetchQueuedCampaignListIds } from "./lib/brevo-client.ts";
import { clariceRampDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { segmentRampWarm, excludeCommittedToQueuedCampaigns, type StoreRow } from "./lib/clarice-segment.ts";
import { monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import { checkEiaGuard, applyVerifyResults } from "./clarice-schedule-sends.ts";
import { findExistingConflicts, normalizeImportCsv, countRows, type WaveDef } from "./clarice-import-waves.ts";
import { ensureEditorCopyRow } from "./lib/editor-copy.ts"; // #3455 / #3643 bug 3
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { extractPlanCredits } from "../workers/brevo-dashboard/src/brevo-api.ts";
import {
  selectMatureDayCampaigns,
  aggregateHealth,
  decideSemaphore,
  baseVolumeFromLastSendDay,
  computeWeekPlan,
  type Semaphore,
} from "../workers/brevo-dashboard/src/weekly-plan.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

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

// ---------------------------------------------------------------------------
// Volumes — explícito (--volumes) OU calculado a partir do worker (#3593 item 1)
// ---------------------------------------------------------------------------

export interface RampVolumePlan {
  volumes: [number, number, number];
  semaphore: Semaphore;
  flagged: boolean;
  baseVolume: number;
}

export type RampVolumeResult = { ok: true; plan: RampVolumePlan } | { ok: false; reason: string };

/**
 * Recomputa a recomendação de volume a partir das campanhas Brevo — MESMA
 * lógica pura do worker (`workers/brevo-dashboard/src/weekly-plan.ts`,
 * aba "Rampa"), não duplicada aqui. Espelha `computeWeeklySendState` do
 * worker (não exportada de lá) numa forma que devolve um resultado
 * discriminado (ok/erro) em vez de renderizar HTML.
 */
export function deriveRampVolumes(campaigns: BrevoCampaign[], now: Date = new Date()): RampVolumeResult {
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
  const semaphore = decideSemaphore(health);
  const plan = computeWeekPlan(baseVolume, semaphore);
  return { ok: true, plan: { volumes: plan.volumes, semaphore: plan.semaphore, flagged: plan.flagged, baseVolume } };
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
 * silenciosamente). `raw` ausente ou não-numérico → `fallback`. Pura, testável.
 */
export function resolveDashboardLimit(raw: string | undefined, fallback: number = DEFAULT_DASHBOARD_LIMIT): number {
  if (raw === undefined) return fallback;
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

/** 1º nome p/ personalização — mesma convenção de clarice-build-waves-store.ts. */
function firstName(name: string | null): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
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
}

/**
 * #3643 bug 1: decide se uma wave já foi IMPORTADA COM SUCESSO e deve ser
 * pulada num re-run de `--import`. Antes, o skip-check gatava em
 * `entry.listId !== undefined` — mas `listId` é gravado ANTES da chamada
 * `/contacts/import` ser sequer tentada, então um import que falhasse
 * (rede, 5xx, CSV malformado) deixava a wave PERMANENTEMENTE pulada em
 * re-runs futuros, com uma lista Brevo vazia. Gatear em `status === "imported"`
 * (só setado após confirmação, ver `resolveImportStatus`) corrige isso — um
 * retry após falha vê `status` intermediário e tenta de novo. Pura, testável.
 */
export function shouldSkipImport(entry: Pick<RampWaveEntry, "status">): boolean {
  return entry.status === "imported";
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
 */
export function assertImportUsable(
  entry: Pick<RampWaveEntry, "key" | "status" | "count" | "importedCount">,
  force: boolean,
): void {
  if (entry.status === "imported") return;
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
 * agendadas são imutáveis na Brevo — um retry tentaria re-agendar via PUT
 * algo que já foi aceito). Um `--create` incompleto agora bloqueia
 * `--schedule` pra TODAS as waves com um erro claro upfront, em vez de
 * agendar parcialmente e perder o rastro do estado. Pura, testável.
 */
export function checkAllCampaignsCreated(entries: Array<{ key: string; campaignId?: number }>): CampaignsReadyCheck {
  const missingKeys = entries.filter((e) => e.campaignId === undefined).map((e) => e.key);
  return { ready: missingKeys.length === 0, missingKeys };
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

  const rampDir = clariceRampDir(cycle);
  const manifestPath = resolve(rampDir, "ramp-manifest.json");

  // --- 1. Volumes ---
  const volumesArg = parseVolumesArg(getArg(argv, "volumes"));
  let volumes: [number, number, number];
  if (volumesArg) {
    volumes = volumesArg;
    console.error(`📋 Volumes (explícito --volumes): ${volumes.join(", ")}`);
  } else {
    const dashboardUrl = getArg(argv, "dashboard-url") || DEFAULT_DASHBOARD_URL;
    const limit = resolveDashboardLimit(getArg(argv, "dashboard-limit"), DEFAULT_DASHBOARD_LIMIT);
    const limitWarning = warnIfLimitExceedsWorkerClamp(limit);
    if (limitWarning) console.error(limitWarning);
    console.error(`📋 Volumes: nenhum --volumes explícito — recomputando via ${dashboardUrl}/api/campaigns?limit=${limit}…`);
    const res = await fetch(`${dashboardUrl}/api/campaigns?limit=${limit}`);
    if (!res.ok) {
      console.error(`❌ GET ${dashboardUrl}/api/campaigns falhou (${res.status}). Use --volumes A,B,C explícito.`);
      process.exit(1);
    }
    const campaigns = (await res.json()) as BrevoCampaign[];
    const result = deriveRampVolumes(campaigns);
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
    console.log(JSON.stringify({ mode: "dry-run", cycle, volumes, total: totalRequested }, null, 2));
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

    // #2994: exclui quem já está comprometido com uma campanha AGENDADA (queued) — mesmo guard de weekly-send-plan-audience.ts.
    const queuedListIds = await fetchQueuedCampaignListIds(apiKey);
    if (queuedListIds.size > 0) {
      console.error(`Campanhas agendadas (queued) detectadas — ${queuedListIds.size} lista(s) comprometida(s) serão excluídas.`);
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

    const rampWarm = segmentRampWarm(rows) as (StoreRow & { name: string | null })[];
    const ordered = excludeCommittedToQueuedCampaigns(rampWarm, queuedListIds) as (StoreRow & { name: string | null })[];
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
      type CampaignEntryLike = { key: string; campaignId: number; listId: number; subject: string; scheduledAt: string; status: "draft" | "scheduled" };
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
      // agendadas são imutáveis na Brevo — um retry tentaria re-PUTar algo
      // já aceito). Um --create incompleto agora bloqueia --schedule pra
      // TODAS as waves com um erro claro upfront, antes de qualquer chamada real.
      const readyCheck = checkAllCampaignsCreated(campaignsView);
      if (!readyCheck.ready) {
        throw new Error(
          `--schedule: ${readyCheck.missingKeys.join(", ")} sem campanha criada (campaignId ausente) — ` +
          `rode --create para TODAS as waves antes de agendar (agendamento parcial deixaria waves já ` +
          `agendadas no Brevo com o estado local (ramp-summary.json) desatualizado).`,
        );
      }

      const toVerify: CampaignEntryLike[] = [];
      for (const view of campaignsView) {
        if (view.status === "scheduled") {
          console.error(`↷ ${view.key} já agendada — pulando`);
          continue;
        }
        if (!view.scheduledAt) throw new Error(`${view.key}: scheduledAt ausente — recrie via --create.`);
        if (new Date(view.scheduledAt) <= new Date()) {
          throw new Error(`--schedule: ${view.key} (campanha #${view.campaignId}) tem scheduledAt no passado/presente (${view.scheduledAt}).`);
        }
        await brevoPut(apiKey, `/emailCampaigns/${view.campaignId}`, { scheduledAt: view.scheduledAt });
        toVerify.push(view);
      }

      const verifySettled = await Promise.allSettled(toVerify.map((c) => brevoGetCampaign(apiKey, c.campaignId)));
      applyVerifyResults(
        verifySettled,
        toVerify,
        campaignsView,
        rampSummaryPath(rampDir),
        (_p, content) => writeFileAtomic(_p, content),
        (msg) => console.error(msg),
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        cycle,
        volumes,
        entries: loadRampSummary(rampDir).map((e) => ({ key: e.key, status: e.status, listId: e.listId, campaignId: e.campaignId })),
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
