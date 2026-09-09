#!/usr/bin/env npx tsx
/**
 * onboarding-welcome-run.ts (#5908)
 *
 * Script DIÁRIO de onboarding fora da automação Beehiiv — mecanismo 1 da
 * decisão do editor (22/08/2026 ~11:08 BRT): Brevo transacional + detecção
 * de novos assinantes.
 *
 *   E-mail 1 (transacional)  → imediato na detecção (só status/state `active`)
 *   E-mail 2 (transacional)  → D+3
 *   E-mail 3 (CAMPANHA Brevo, marketing) → D+10, copy de apoio (apoia.se) —
 *     condição INVERTIDA em #7599 (08/09/2026, decisão do editor): dispara
 *     só pra quem ABRIU pelo menos 1 edição até D+10 (não mais "zero
 *     aberturas+cliques", a condição de reengajamento original da #5808/
 *     #5908 — o pedido de apoio só faz sentido pra quem já leu algo). Quem
 *     tem zero aberturas em D+10 não recebe e-mail 3 nenhum por ora
 *     (`skipped_no_open`, terminal). A campanha é criada SEMPRE como
 *     RASCUNHO mirando a lista dedicada do cohort — agendamento/envio é
 *     ação humana explícita (mesma disciplina de rascunho-por-padrão dos
 *     outros publicadores Brevo do projeto).
 *
 * DETECÇÃO (#7599, 08/09/2026): o backend segue
 * `publishing.newsletter.subscriber_backend` (`scripts/lib/shared/
 * newsletter-subscriber-source.ts`, mesma chave já usada por
 * `count-subscriptions-by-utm.ts`/Studio) — Beehiiv (`GET /publications/
 * {id}/subscriptions`, API pública v2, `created`) ou Kit (`GET /v4/
 * subscribers`, `created_at`). O cadastro migrou pra Kit em 04/09/2026
 * (#7388); detectar contra a Beehiiv depois disso mirava uma base zerada e
 * a rodada saía "verde" (exit 0, `detected_new: 0`) sem detectar ninguém,
 * em silêncio — daí o alarme de detecção zerada abaixo (item 4 da #7599) e
 * o guard de troca de backend (`shouldResetCursorForBackendSwitch`, nunca
 * reusa um cursor calculado sob a fonte antiga — mesma disciplina que
 * evitou repetir o #6043).
 *
 * SEGURANÇA:
 *   - Default é DRY-RUN: sem `--send` nada é escrito (nem store, nem Brevo,
 *     nem cursor) — só imprime o plano.
 *   - GUARD DURO DE CONTEÚDO: enquanto `data/snippets/onboarding-{N}.md`
 *     carregar o marcador ONBOARDING-CORPO-PENDENTE (corpo definitivo ainda
 *     não exportado da automação `Onboarding — Boas-vindas`, #5808), a ação
 *     vira skip e NENHUM envio acontece. Ver `onboarding-state.ts`.
 *   - Nunca e-mail para assinante com status ≠ `active` na Beehiiv.
 *
 * Uso:
 *   npx tsx scripts/onboarding-welcome-run.ts             # dry-run (plano)
 *   npx tsx scripts/onboarding-welcome-run.ts --send      # executa de verdade
 *   npx tsx scripts/onboarding-welcome-run.ts --cancel-pending  # cancela e-mails 1/2 ainda agendados (#6158)
 *
 * #6158 (24/08/2026, incidente #6042 — 585 e-mails indevidos e IMPOSSÍVEIS
 * de cancelar): o envio real (`--send`) agora sempre vai com `scheduledAt`
 * mínimo (60s à frente, `computeMinScheduledAt`) em vez de imediato — só
 * assim a Brevo devolve um `messageId`/`batchId` formato UUIDv4, o único
 * formato que `DELETE /v3/smtp/email/{id}` aceita. O id é persistido em
 * `email1_brevo_id`/`email2_brevo_id` no store; `--cancel-pending` lê o
 * store e cancela tudo que ainda tiver id gravado.
 *
 * #6176 (self-review Finding 1 do #6158): `--cancel-pending` roda ANTES do
 * kill switch `onboarding.enabled: false` e do check de `resolveBeehiivConfig()`
 * — cancelamento não detecta assinante nem chama a Beehiiv, e travar o
 * cancelamento atrás da pausa da automação seria o oposto do desejado numa
 * emergência. Único requisito: a credencial Brevo (`BREVO_DIARIA_API_KEY`).
 *
 * Flags auxiliares (testes/operações): --store <path>, --snippets-dir <path>,
 * --skip-email1 --skip-email2 --skip-email3 (desliga etapas pontualmente).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveBeehiivConfig, beehiivApiBase, type BeehiivConfig } from "./lib/beehiiv-config.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { kitFetch } from "./lib/kit-client.ts";
import { listAllKitSubscribers, getSubscriberById as getKitSubscriberById } from "./lib/kit-subscribers.ts";
import {
  planSeed,
  renderSeedPlan,
  type SeedKitSubscriber,
  type SeedExistingEntry,
} from "./lib/onboarding-seed.ts";
import { resolveNewsletterSubscriberBackend, type NewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";
import {
  emptyStore,
  readStore,
  writeStore,
  DEFAULT_STORE_PATH,
  type OnboardingEntry,
  type OnboardingStore,
} from "./lib/onboarding-store.ts";
import {
  parseOnboardingSnippet,
  buildRunPlan,
  classifyNewSubscribers,
  shouldResetCursorForBackendSwitch,
  updateZeroDetectionStreak,
  zeroDetectionAlarm,
  type DetectedSubscription,
  type OpenStats,
  type RunAction,
} from "./lib/onboarding-state.ts";
import { brevoPost, brevoGet, brevoDelete } from "./lib/brevo-client.ts";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OnboardingConfig {
  enabled?: boolean;
  /** Nome da var de ambiente com a key da conta Brevo (default BREVO_DIARIA_API_KEY — mesma conta, custo zero). */
  api_key_env?: string;
  sender_email?: string;
  sender_name?: string;
  snippets_dir?: string;
  store_path?: string;
  email2_days?: number;
  email3_days?: number;
  /** Dias extras além do D+10 pra esperar stats antes de desistir (`skipped_sem_dados`). */
  email3_grace_days?: number;
  /** Nome da lista Brevo dedicada ao cohort D+10 (criada sob demanda). */
  d10_list_name?: string;
}

export function loadOnboardingConfig(configPathAbs?: string): OnboardingConfig {
  const raw = JSON.parse(readFileSync(configPathAbs ?? resolve(ROOT, "platform.config.json"), "utf8")) as {
    onboarding?: OnboardingConfig;
  };
  return (
    raw.onboarding ?? {
      // Defaults seguros se o bloco sumir do config — o script continua
      // funcionando em dry-run; envio real exige sender explícito.
      api_key_env: "BREVO_DIARIA_API_KEY",
      sender_email: undefined,
      sender_name: "diar.ia.br",
      snippets_dir: "data/snippets",
      store_path: "data/onboarding/store.json",
      email2_days: 3,
      email3_days: 10,
      email3_grace_days: 10,
      d10_list_name: "Onboarding D10 sem abertura",
    }
  );
}

// ---------------------------------------------------------------------------
// Beehiiv HTTP (padrão cohort-engagement: retry em 429 honrando Retry-After)
// ---------------------------------------------------------------------------

interface BeehiivPage<T> {
  data?: T[];
  total_results?: number;
  limit?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function beehiivFetch<T>(path: string, apiKey: string, retries = 0): Promise<{ ok: boolean; status: number; body: T | null }> {
  // #5908 fix: respeita BEEHIIV_API_URL (override de teste documentado em
  // beehiiv-config.ts) — hardcodar o host aqui fazia dry-runs de teste
  // baterem na API REAL com rate limit de verdade.
  const base = beehiivApiBase();
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429 && retries < 3) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const wait = Math.max(retryAfter * 1000, 30_000);
    process.stderr.write(`[onboarding] rate-limited Beehiiv — esperando ${Math.round(wait / 1000)}s\n`);
    await sleep(wait);
    return beehiivFetch<T>(path, apiKey, retries + 1);
  }
  if (!res.ok) return { ok: false, status: res.status, body: null };
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

interface RawSubscription extends Record<string, unknown> {
  id?: string;
  email?: string;
  status?: string | null;
  created?: number | null;
  stats?: OpenStats | null;
}

/**
 * Drena as páginas de subscriptions criadas depois de `gteSec`.
 *
 * #6043 (260824): `created_at__gte` (e variantes testadas ao vivo —
 * `created__gte`, `created_after`, `min_created`, `since`, `created_at_gte`)
 * NÃO é honrado pela API pública v2 da Beehiiv — o parâmetro é
 * silenciosamente ignorado e o endpoint devolve a página 1 na ordem padrão
 * (created ASC, ou seja o assinante MAIS ANTIGO primeiro). A run de
 * 24/08/2026 12:05 UTC confiou nesse filtro inexistente e tratou boa parte
 * da base histórica como "novos assinantes" — 585 e-mails de boas-vindas
 * indevidos, ver #6043.
 *
 * Fix: `order_by=created&direction=desc` (confirmado funcional ao vivo)
 * devolve o MAIS RECENTE primeiro — pagina nessa ordem e para assim que
 * encontrar (ou passar de) `gteSec`, filtrando client-side. Como a ordem é
 * decrescente, o primeiro item com `created < gteSec` garante que TODO
 * item seguinte também é `< gteSec` — não há risco de faltar alguém mais
 * novo que ainda esteja numa página futura.
 *
 * Corte é `<` (estrito), não `<=` — mantém a semântica INCLUSIVA do
 * `created_at__gte` original (>= cursor conta como novo). Isso importa
 * porque `main()` avança o cursor pro maior `created` visto no run: um
 * `<=` excluiria PERMANENTEMENTE qualquer assinante futuro que caia
 * exatamente nesse mesmo segundo (import em lote, corrida de paginação) —
 * dropado aqui dentro de `fetchSubscriptionsSince`, antes até de chegar no
 * dedup por id de `classifyNewSubscribers`. Com `<`, um item empatado no
 * cursor é reincluído e o dedup por `subscription_id` cuida de não
 * duplicar entrada pra quem já é conhecido — reprocessar um id já visto é
 * inofensivo, perder um novo de vez não é (achado do review de #6054).
 */
async function fetchSubscriptionsSince(
  publicationId: string,
  apiKey: string,
  gteSec: number,
): Promise<DetectedSubscription[]> {
  const all: DetectedSubscription[] = [];
  let page = 1;
  let more = true;
  while (more) {
    const path =
      `/publications/${publicationId}/subscriptions` +
      `?expand[]=stats&limit=100&page=${page}&order_by=created&direction=desc`;
    const res = await beehiivFetch<BeehiivPage<RawSubscription>>(path, apiKey);
    if (!res.ok || !res.body) {
      throw new Error(`[onboarding] Beehiiv API ${res.status} em subscriptions página ${page}`);
    }
    const chunk = res.body.data ?? [];
    if (chunk.length === 0) break;
    for (const s of chunk) {
      if (s.created != null && s.created < gteSec) {
        // Página ordenada desc: a partir daqui tudo é < gteSec. Para.
        // (estrito — ver docstring: empate no cursor conta como novo)
        more = false;
        break;
      }
      if (!s.id || !s.email) continue;
      all.push({ id: s.id, email: s.email, status: s.status ?? "unknown", created: s.created ?? null });
    }
    if (more) {
      const apiLimit = typeof res.body.limit === "number" && res.body.limit > 0 ? res.body.limit : 100;
      more = chunk.length >= apiLimit;
    }
    page++;
  }
  return all;
}

/** GET individual de subscription (refresh de status + stats antes da decisão). */
async function fetchSubscriptionById(
  publicationId: string,
  apiKey: string,
  subscriptionId: string,
): Promise<(Pick<RawSubscription, "status" | "stats"> & Record<string, unknown>) | null> {
  const res = await beehiivFetch<RawSubscription>(
    `/publications/${publicationId}/subscriptions/${subscriptionId}?expand[]=stats`,
    apiKey,
  );
  if (!res.ok || !res.body) return null;
  return res.body;
}

// ---------------------------------------------------------------------------
// Detecção via Kit (#7599 — cadastro migrado da Beehiiv pro Kit em 04/09/2026,
// #7388; a detecção lendo `resolveBeehiivConfig`/`beehiivFetch` acima ficou
// mirando uma base zerada e saía "verde" sem detectar ninguém, ver #7599)
// ---------------------------------------------------------------------------

/** ISO 8601 (`created_at` do Kit) → epoch SEGUNDOS, mesma unidade do campo
 *  `created` da Beehiiv usada pelo resto do módulo (cursor, D+3/D+10). */
function isoToEpochSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Drena TODOS os assinantes do Kit (`status: "all"` — precisa enxergar quem
 * ainda não confirmou double opt-in, mesmo racional do `status !== "active"`
 * já tratado pelo resto do módulo) e filtra client-side por `created_at >=
 * gteSec`. Diferente de `fetchSubscriptionsSince` (Beehiiv), o Kit não
 * documenta `order_by`/`direction` pra `/v4/subscribers` — sem um jeito
 * confirmado de pedir "mais recente primeiro" e parar cedo, este helper
 * pagina a base inteira (mesmo padrão de `fetchAndAggregateKit` em
 * `count-subscriptions-by-utm.ts`, volume esperado "algumas centenas a ~2
 * mil", aceitável pra 1 rodada/dia).
 */
async function fetchSubscriptionsSinceKit(config: KitConfig, gteSec: number): Promise<DetectedSubscription[]> {
  const subs = await listAllKitSubscribers(config, { status: "all" });
  const result: DetectedSubscription[] = [];
  for (const s of subs) {
    const created = isoToEpochSec(s.created_at);
    if (created >= gteSec) {
      result.push({ id: String(s.id), email: s.email_address, status: s.state, created });
    }
  }
  return result;
}

/**
 * #7599: leitura de engajamento (aberturas) por assinante do Kit — **NÃO
 * CONFIRMADO AO VIVO** (mesma ressalva de várias funções em
 * `kit-subscribers.ts`). `GET /v4/subscribers/{id}/stats` é a melhor
 * suposição a partir do padrão REST do resto da v4 e do nome do tool MCP
 * equivalente (`list_stats_for_a_subscriber`) — nenhuma sessão pôde
 * confirmar o shape real contra a conta, porque scripts não têm acesso à
 * MCP (só sessões interativas têm).
 *
 * Fail-safe por desenho: qualquer erro (404, shape inesperado, campo
 * ausente sob os nomes tentados) devolve `null`. O caller (`email3Eligibility`
 * em `onboarding-state.ts`) trata `null` como `stats_ausentes` — dentro da
 * janela de tolerância mantém o candidato pendente pra próxima rodada; fora
 * dela desiste terminalmente (`skipped_sem_dados`). Em NENHUM caso um erro
 * ou shape desconhecido vira "elegível" por acidente — o e-mail 3 nunca
 * sai adivinhando. Reverificar os nomes de campo reais ao vivo antes de
 * confiar neste dado pra qualquer decisão além desse fail-safe.
 */
async function fetchSubscriberStatsKit(id: number, config: KitConfig): Promise<OpenStats | null> {
  try {
    const data = await kitFetch<Record<string, unknown> | undefined>(`/subscribers/${id}/stats`, { config });
    if (!data) return null;
    const body = (data as { subscriber?: Record<string, unknown> }).subscriber ?? data;
    const opens =
      body["total_unique_opens"] ?? body["total_opens"] ?? body["unique_opens"] ?? body["opens"] ?? null;
    if (typeof opens !== "number") return null;
    return { total_unique_opened: opens, total_clicked: null };
  } catch {
    return null;
  }
}

/** Equivalente Kit de `fetchSubscriptionById` (refresh de status + stats
 *  antes da decisão) — `subscription_id` do store é o id numérico do Kit
 *  como string (ver `fetchSubscriptionsSinceKit`). */
async function fetchSubscriptionByIdKit(
  config: KitConfig,
  subscriptionId: string,
): Promise<{ status: string; stats: OpenStats | null } | null> {
  const id = Number(subscriptionId);
  if (!Number.isFinite(id)) return null;
  try {
    const subscriber = await getKitSubscriberById(id, config);
    const stats = await fetchSubscriberStatsKit(id, config);
    return { status: subscriber.state, stats };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Executor Brevo
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * #6158: janela mínima antes de "agora" pra tornar o envio CANCELÁVEL.
 * Envio SEM `scheduledAt` sai imediato e recebe um messageId formato SMTP
 * (`...@smtp-relay.mailin.fr`) que o endpoint `DELETE /v3/smtp/email/{id}`
 * não aceita — já causou dano real (#6042, 585 e-mails indevidos
 * disparados, impossíveis de interromper). Com `scheduledAt`, a Brevo
 * devolve um `messageId`/`batchId` formato UUIDv4, que É cancelável. 60s é
 * o mínimo pedido pela issue — não confirmado ao vivo contra a API real
 * (ninguém pode executar este script pra validar, ver guard de publicação);
 * se a Brevo rejeitar por ser curto demais, o erro aparece via HTTP na
 * chamada normal (branch de catch em `main()`) — não é um caminho silencioso.
 */
export const TRANSACTIONAL_SCHEDULE_LEAD_MS = 60_000;

/** ISO 8601, `TRANSACTIONAL_SCHEDULE_LEAD_MS` à frente de `nowMs` (default: agora). */
export function computeMinScheduledAt(nowMs: number = Date.now()): string {
  return new Date(nowMs + TRANSACTIONAL_SCHEDULE_LEAD_MS).toISOString();
}

/**
 * Envio transacional real (POST /v3/smtp/email) — SEMPRE com `scheduledAt`
 * mínimo (#6158), nunca imediato. Retorna o `messageId`/`batchId` UUID
 * quando a Brevo devolve (formato cancelável — ver
 * `computeMinScheduledAt`/`TRANSACTIONAL_SCHEDULE_LEAD_MS` acima).
 */
export async function sendTransactionalEmail(opts: {
  apiKey: string;
  sender: { email: string; name: string };
  to: string;
  subject: string;
  htmlContent: string;
}): Promise<string | null> {
  const res = (await brevoPost(opts.apiKey, "/smtp/email", {
    sender: opts.sender,
    to: [{ email: opts.to }],
    subject: opts.subject,
    htmlContent: opts.htmlContent,
    textContent: stripHtml(opts.htmlContent),
    scheduledAt: computeMinScheduledAt(),
  })) as { messageId?: string; batchId?: string };
  return res?.messageId ?? res?.batchId ?? null;
}

/**
 * #6158: aplica o resultado de um envio transacional (email1/email2) numa
 * entry do store — função pura, extraída pra ser testável sem precisar
 * rodar `main()` inteiro (que faz chamadas de rede reais). O ID persistido
 * aqui é o que `runCancelPending` usa depois pra cancelar via DELETE.
 */
export function applySendResult(
  entry: OnboardingEntry,
  kind: "email1" | "email2",
  brevoId: string | null,
  isoNow: string,
): void {
  if (kind === "email1") {
    entry.email1_sent_at = isoNow;
    entry.email1_brevo_id = brevoId;
  } else {
    entry.email2_sent_at = isoNow;
    entry.email2_brevo_id = brevoId;
  }
}

/**
 * #6158 (`--cancel-pending`): varre o store por entries com um id Brevo
 * ainda gravado (`email1_brevo_id`/`email2_brevo_id` != null) e tenta
 * cancelar via `DELETE /v3/smtp/email/{id}`. Sucesso limpa o id do store
 * (nada mais a cancelar); falha preserva o id (retry na próxima invocação —
 * mesma semântica "skip forever só em sucesso" já usada em
 * `verify-emails-mv.ts`, ver CLAUDE.md).
 *
 * Não distingue "ainda não saiu" de "já saiu" — a Brevo é quem sabe: um
 * DELETE tarde demais simplesmente falha (a API não deixa cancelar o que já
 * foi processado), e o resultado individual reporta isso sem abortar o lote.
 */
export interface CancelPendingResult {
  subscription_id: string;
  email: string;
  field: "email1_brevo_id" | "email2_brevo_id";
  id: string;
  ok: boolean;
  error?: string;
}

export async function runCancelPending(opts: {
  apiKey: string;
  storePath: string;
}): Promise<CancelPendingResult[]> {
  const { store } = readStore(opts.storePath);
  const results: CancelPendingResult[] = [];
  for (const entry of Object.values(store.entries)) {
    for (const field of ["email1_brevo_id", "email2_brevo_id"] as const) {
      const id = entry[field];
      if (!id) continue;
      try {
        await brevoDelete(opts.apiKey, `/smtp/email/${encodeURIComponent(id)}`);
        entry[field] = null;
        results.push({ subscription_id: entry.subscription_id, email: entry.email, field, id, ok: true });
      } catch (e) {
        results.push({
          subscription_id: entry.subscription_id,
          email: entry.email,
          field,
          id,
          ok: false,
          error: (e as Error).message,
        });
      }
    }
  }
  writeStore(store, opts.storePath);
  return results;
}

/** Garante contato Brevo no cohort (cria/atualiza já adicionando à lista D+10). */
async function upsertContactInList(opts: { apiKey: string; email: string; listId: number }): Promise<void> {
  await brevoPost(opts.apiKey, "/contacts", {
    email: opts.email,
    updateEnabled: true,
    listIds: [opts.listId],
  });
}

/** Acha (ou cria) a lista Brevo dedicada ao cohort D+10 pelo nome configurado. */
async function ensureD10List(opts: { apiKey: string; listName: string }): Promise<number> {
  const { status, body } = await brevoGet(opts.apiKey, `/contacts/lists?limit=50&offset=0`);
  if (status === 200) {
    const lists = (body as { lists?: { id: number; name: string }[] }).lists ?? [];
    const found = lists.find((l) => l.name === opts.listName);
    if (found) return found.id;
  }
  const created = (await brevoPost(opts.apiKey, "/contacts/lists", { name: opts.listName })) as { id: number };
  return created.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface CliArgs {
  send: boolean;
  storePath?: string;
  snippetsDir?: string;
  /** Override de teste — path absoluto pro platform.config.json (default: raiz do repo). */
  configPath?: string;
  /** Override de teste — path absoluto pra raiz de onde `.env` é carregado (default: raiz real do repo, ver env-loader.ts). #5966. */
  envRoot?: string;
  skip: Set<"email1" | "email2" | "email3">;
  /** #6158: modo dedicado — cancela via DELETE tudo que o store ainda tem como pendente, e sai. Não faz detecção nem envio nessa invocação. */
  cancelPending: boolean;
  /**
   * #7674 — modo DIRIGIDO: lista explícita de e-mails a semear no store,
   * de `--emails` e/ou `--emails-file`. Presente ⇒ a rodada NÃO detecta e
   * NÃO envia; só escreve entradas (ver `scripts/lib/onboarding-seed.ts`).
   */
  seedEmails?: string[];
  /** #7674 — ISO; marca `email1_sent_at` sem enviar (coorte que já recebeu o e-mail 1 por outro canal, #7675). */
  seedEmail1SentAt?: string;
  /** #7674 — rótulo de origem gravado em `seeded_by`. Obrigatório no modo dirigido. */
  seededBy?: string;
}

/** Resumo JSON impresso no fim da rodada (stdout — consumível por alarmes/logs). */
interface RunSummary {
  mode: "SEND" | "dry-run";
  now: string;
  detected_new: number;
  actions: ({ kind: "email1" | "email2"; email: string } | { kind: "email3_campaign"; cohort: string[] })[];
  skips: { etapa: string; motivo: string; detalhe?: string }[];
  notes: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { send: false, skip: new Set(), cancelPending: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") args.send = true;
    else if (a === "--cancel-pending") args.cancelPending = true;
    else if (a === "--store") args.storePath = argv[++i];
    else if (a === "--snippets-dir") args.snippetsDir = argv[++i];
    else if (a === "--config") args.configPath = argv[++i];
    else if (a === "--env-root") args.envRoot = argv[++i];
    else if (a === "--emails") (args.seedEmails ??= []).push(...argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--emails-file") {
      const p = argv[++i];
      if (!existsSync(p)) {
        process.stderr.write(`[onboarding] --emails-file não encontrado: ${p}\n`);
        process.exit(2);
      }
      // Uma linha por e-mail; `#` inicia comentário para o operador anotar a
      // origem da lista. O `#` só conta como comentário no INÍCIO da linha ou
      // depois de espaço — `#` é caractere válido em local-part (RFC 5322), e
      // um `/#.*$/` cru truncaria `user#tag@x.com` para `user`, perdendo o
      // domínio inteiro (achado do review da PR #7683).
      const linhas = readFileSync(p, "utf8")
        .split(/\r?\n/)
        .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
        .filter(Boolean);
      (args.seedEmails ??= []).push(...linhas);
    } else if (a === "--seed-email1-sent-at") args.seedEmail1SentAt = argv[++i];
    else if (a === "--seeded-by") args.seededBy = argv[++i];
    else if (a === "--skip-email1") args.skip.add("email1");
    else if (a === "--skip-email2") args.skip.add("email2");
    else if (a === "--skip-email3") args.skip.add("email3");
    else {
      process.stderr.write(`[onboarding] flag desconhecida: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function loadSnippets(dirAbs: string): { 1: ReturnType<typeof parseOnboardingSnippet>; 2: ReturnType<typeof parseOnboardingSnippet>; 3: ReturnType<typeof parseOnboardingSnippet> } {
  const load = (n: 1 | 2 | 3) => {
    const p = resolve(dirAbs, `onboarding-${n}.md`);
    if (!existsSync(p)) return null;
    return parseOnboardingSnippet(readFileSync(p, "utf8"), n);
  };
  return { 1: load(1), 2: load(2), 3: load(3) };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // #5966: `--env-root` precisa ser resolvido ANTES do loadProjectEnv() pra
  // valer — parseArgs() não lê env, então essa reordenação é segura.
  loadProjectEnv(args.envRoot);
  const cfg = loadOnboardingConfig(args.configPath);
  const apiKeyEnv = cfg.api_key_env ?? "BREVO_DIARIA_API_KEY";
  const brevoKey = process.env[apiKeyEnv];

  // --- #6176 (self-review Finding 1 do #6158): `--cancel-pending` roda ANTES
  // do kill switch (`onboarding.enabled: false`) e do check de
  // `resolveBeehiivConfig()` — cancelar não detecta assinante nem chama a
  // Beehiiv, então nenhum dos dois é estritamente necessário. Travar
  // `--cancel-pending` atrás do kill switch é o oposto do desejado numa
  // emergência: é justamente quando alguém pausa a automação por causa de um
  // incidente (#6042/#6043) que precisa poder cancelar o que já está na
  // fila. Único requisito real deste modo: a credencial Brevo (usada pelo
  // DELETE). ---
  if (args.cancelPending) {
    if (!brevoKey) {
      process.stderr.write(`[onboarding] ${apiKeyEnv} ausente no env.\n`);
      process.exit(2);
    }
    const storePath = args.storePath ?? resolve(ROOT, cfg.store_path ?? DEFAULT_STORE_PATH);
    const results = await runCancelPending({ apiKey: brevoKey, storePath });
    console.log(
      JSON.stringify(
        { mode: "cancel-pending", attempted: results.length, cancelled: results.filter((r) => r.ok).length, results },
        null,
        2,
      ),
    );
    return;
  }

  // --- Kill switch (#5957) — ANTES de qualquer chamada externa, mesmo padrão
  // do guard `data/clarice-novos-enabled.json` em `clarice-novos-run.ts`.
  // Não se aplica a `--cancel-pending` (tratado acima, antes deste ponto). ---
  if (cfg.enabled === false) {
    process.stdout.write(
      "[onboarding] ⏸️  automação PAUSADA (platform.config.json → onboarding.enabled: false) — " +
        "nenhuma chamada Beehiiv/Brevo feita.\n",
    );
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // #7599: backend de DETECÇÃO segue `publishing.newsletter.subscriber_backend`
  // (mesma chave já usada por `count-subscriptions-by-utm.ts`/Studio) — o
  // cadastro migrou pra Kit em 04/09/2026 (#7388) e a detecção lendo a
  // Beehiiv ficava mirando uma base zerada, saindo "verde" sem detectar
  // ninguém.
  const configPathAbs = args.configPath ?? resolve(ROOT, "platform.config.json");
  const backend: NewsletterSubscriberBackend = resolveNewsletterSubscriberBackend(configPathAbs);

  // #7674: o modo dirigido resolve assinante por e-mail contra a API do Kit,
  // então recusa qualquer outro backend. Fica ANTES da resolução de
  // credencial de propósito: no caminho Beehiiv o script morreria primeiro
  // com "BEEHIIV_API_KEY não definida", que manda o operador procurar uma
  // credencial quando o problema real é o backend estar errado pra este modo.
  if (args.seedEmails && args.seedEmails.length > 0 && backend !== "kit") {
    process.stderr.write(
      `[onboarding] modo dirigido exige backend de assinante "kit" (atual: "${backend}") — a resolução por e-mail é da API do Kit.\n`,
    );
    process.exit(2);
  }

  let beeCfg: { ok: true; config: BeehiivConfig } | null = null;
  let kitCfg: KitConfig | null = null;
  if (backend === "kit") {
    const kitResult = resolveKitConfig();
    if (!kitResult.ok) {
      process.stderr.write(`[onboarding] ${kitResult.reason}\n`);
      process.exit(2);
    }
    kitCfg = kitResult.config;
  } else {
    const beeResult = resolveBeehiivConfig();
    if (!beeResult.ok) {
      process.stderr.write(`[onboarding] ${beeResult.reason}\n`);
      process.exit(2);
    }
    beeCfg = beeResult;
  }
  if (!brevoKey) {
    process.stderr.write(`[onboarding] ${apiKeyEnv} ausente no env.\n`);
    process.exit(2);
  }

  const storePath = args.storePath ?? resolve(ROOT, cfg.store_path ?? DEFAULT_STORE_PATH);

  const snippetsDirAbs = resolve(ROOT, args.snippetsDir ?? cfg.snippets_dir ?? "data/snippets");
  const snippets = loadSnippets(snippetsDirAbs);

  const { store } = readStore(storePath);

  const summary: RunSummary = {
    mode: args.send ? "SEND" : "dry-run",
    now: new Date(nowSec * 1000).toISOString(),
    detected_new: 0,
    actions: [],
    skips: [],
    notes: [],
  };

  // --- #7674: MODO DIRIGIDO (semeadura) -------------------------------------
  // Vem ANTES do bootstrap e da troca de backend de propósito: as duas
  // coortes que este modo existe pra recuperar (#7665, #7675) só ficaram
  // órfãs PORQUE o cursor foi remarcado à frente delas. Se a semeadura
  // caísse depois desses early-returns, ela seria inalcançável justamente
  // no estado em que é necessária.
  //
  // Não detecta e não envia: escreve entradas e sai. O envio continua sendo
  // do caminho normal, que já tem todos os guards (#6043).
  if (args.seedEmails && args.seedEmails.length > 0) {
    // O guard de backend já rodou lá em cima, antes da resolução de
    // credencial — aqui `backend === "kit"` e `kitCfg` está preenchido.
    const kitSubs = await listAllKitSubscribers(kitCfg!, { status: "all" });
    const kitByEmail = new Map<string, SeedKitSubscriber>();
    for (const s of kitSubs) {
      kitByEmail.set(s.email_address.toLowerCase(), {
        id: s.id,
        email: s.email_address,
        state: s.state,
        created_at: s.created_at,
      });
    }
    const existingByEmail = new Map<string, SeedExistingEntry>();
    const existingById = new Map<string, SeedExistingEntry>();
    for (const [chave, e] of Object.entries(store.entries)) {
      const resumo: SeedExistingEntry = {
        subscription_id: e.subscription_id,
        email: e.email,
        email1_sent_at: e.email1_sent_at,
      };
      existingByEmail.set(e.email.toLowerCase(), resumo);
      // Indexa pela CHAVE do mapa, não por `e.subscription_id`: são iguais
      // no caminho normal, mas é a chave que o write vai sobrescrever.
      existingById.set(chave, resumo);
    }

    const plan = planSeed({
      emails: args.seedEmails,
      kitByEmail,
      existingByEmail,
      existingById,
      seedEmail1SentAt: args.seedEmail1SentAt ?? null,
      seededBy: args.seededBy ?? "",
    });
    process.stdout.write(`${renderSeedPlan(plan, { send: args.send, seededBy: args.seededBy ?? "" })}\n`);
    if (!plan.ok) process.exit(1);

    if (args.send) {
      for (const p of plan.entries) {
        store.entries[p.key] = {
          subscription_id: p.subscription_id,
          email: p.email,
          status_detectado: p.status_detectado,
          created_at: p.created_at,
          detected_at: new Date(nowSec * 1000).toISOString(),
          email1_sent_at: p.email1_sent_at,
          email1_brevo_id: null,
          email2_sent_at: null,
          email2_brevo_id: null,
          email3_state: "pending",
          email3_campaign_id: null,
          email3_decided_at: null,
          seeded_by: p.seeded_by,
        };
      }
      writeStore(store, storePath);
      summary.notes.push(`#7674 modo dirigido: ${plan.entries.length} entrada(s) semeada(s), origem ${args.seededBy}`);
    } else {
      summary.notes.push(`#7674 modo dirigido (dry-run): ${plan.entries.length} entrada(s) seriam semeada(s) — nada escrito`);
    }
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // --- BOOTSTRAP: primeira execução marca cursor e NÃO onboarda a base existente ---
  if (store.last_detection_cursor == null) {
    store.last_detection_cursor = nowSec;
    store.last_detection_backend = backend;
    if (args.send) {
      writeStore(store, storePath);
      summary.notes.push("bootstrap: cursor marcado em now; nenhuma entrada adicionada (base existente não recebe onboarding retroativo)");
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    summary.notes.push("bootstrap pendente: 1ª execução com --send marcará o cursor em now (base existente fora do escopo)");
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // --- #7599: troca de backend de detecção — cursor NUNCA é reusado sob a
  // fonte nova (Beehiiv `created` epoch vs. Kit `created_at` ISO convertido
  // não são garantidamente comparáveis). Re-bootstrapa exatamente como a
  // 1ª execução: cursor em now, zero entradas retroativas — mesma
  // disciplina que evitou repetir o #6043. ---
  if (shouldResetCursorForBackendSwitch(store.last_detection_backend, backend)) {
    const backendAnterior = store.last_detection_backend;
    store.last_detection_cursor = nowSec;
    store.last_detection_backend = backend;
    const nota =
      `bootstrap (troca de backend de detecção ${backendAnterior} → ${backend}): cursor remarcado em now; ` +
      `nenhuma entrada retroativa adicionada (#7599)`;
    if (args.send) {
      writeStore(store, storePath);
      summary.notes.push(nota);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    summary.notes.push(`${nota} — pendente, só grava com --send`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  store.last_detection_backend = backend;

  // --- 1. Detecção ---
  const fetched =
    backend === "kit"
      ? await fetchSubscriptionsSinceKit(kitCfg!, store.last_detection_cursor)
      : await fetchSubscriptionsSince(beeCfg!.config.publicationId, beeCfg!.config.apiKey, store.last_detection_cursor);
  const knownIds = new Set(Object.keys(store.entries));
  const { novos } = classifyNewSubscribers(fetched, knownIds);
  summary.detected_new = novos.length;

  // #7599 item 4: alarme de detecção zerada — atualiza o streak em memória;
  // só persiste (junto do resto do store) quando a rodada é `--send` real.
  store.consecutive_zero_detections = updateZeroDetectionStreak(
    store.consecutive_zero_detections ?? 0,
    summary.detected_new,
  );
  const alarm = zeroDetectionAlarm(store.consecutive_zero_detections);
  if (alarm) {
    summary.notes.push(alarm);
    process.stderr.write(`[onboarding] ${alarm}\n`);
  }

  const detectedAt = new Date(nowSec * 1000).toISOString();
  for (const s of novos) {
    const entry: OnboardingEntry = {
      subscription_id: s.id,
      email: s.email,
      status_detectado: s.status,
      created_at: s.created,
      detected_at: detectedAt,
      email1_sent_at: null,
      email1_brevo_id: null,
      email2_sent_at: null,
      email2_brevo_id: null,
      email3_state: "pending",
      email3_campaign_id: null,
      email3_decided_at: null,
    };
    store.entries[s.id] = entry;
  }

  // Cursor avança pro maior `created` visto (mesmo sem novos, mantém janela limpa).
  const maxCreated = fetched.reduce((m, s) => Math.max(m, s.created ?? 0), store.last_detection_cursor);
  if (maxCreated > store.last_detection_cursor) store.last_detection_cursor = maxCreated;

  // --- 2. Refresh de status/stats pros candidatos ---
  const email2Days = cfg.email2_days ?? 3;
  const email3Days = cfg.email3_days ?? 10;
  const graceDays = cfg.email3_grace_days ?? 10;

  const candidates = Object.values(store.entries).filter((e) => {
    const needsStatusRefresh =
      (e.email1_sent_at == null && e.status_detectado !== "active") ||
      (e.email2_sent_at == null && e.created_at != null && nowSec >= e.created_at + email2Days * 86_400) ||
      (e.email3_state === "pending" &&
        e.created_at != null &&
        nowSec >= e.created_at + email3Days * 86_400);
    return needsStatusRefresh;
  });
  const statsById: Record<string, OpenStats | null> = {};
  for (const e of candidates) {
    const fresh =
      backend === "kit"
        ? await fetchSubscriptionByIdKit(kitCfg!, e.subscription_id)
        : await fetchSubscriptionById(beeCfg!.config.publicationId, beeCfg!.config.apiKey, e.subscription_id);
    if (fresh) {
      e.status_detectado = fresh.status ?? e.status_detectado;
      statsById[e.subscription_id] = fresh.stats ?? null;
    } else {
      process.stderr.write(`[onboarding] refresh falhou pra ${e.subscription_id} — usando estado do store\n`);
    }
  }

  // --- 3. Plano ---
  const plan = buildRunPlan({
    entries: Object.values(store.entries),
    statsById,
    nowSec,
    email2Days,
    email3Days,
    email3GraceDays: graceDays,
    snippets: {
      1: args.skip.has("email1") ? null : snippets[1],
      2: args.skip.has("email2") ? null : snippets[2],
      3: args.skip.has("email3") ? null : snippets[3],
    },
  });

  summary.actions = plan.actions.map((a) =>
    a.kind === "email3_campaign"
      ? { kind: a.kind, cohort: a.entries.map((e) => e.email) }
      : { kind: a.kind, email: a.entry.email },
  );
  summary.skips = plan.skips.map((s) => ({ etapa: s.etapa, motivo: s.motivo, detalhe: s.detalhe }));

  if (!args.send) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // --- 4. Execução (só com --send) ---
  const sender = { email: cfg.sender_email ?? "", name: cfg.sender_name ?? "diar.ia.br" };
  if (!sender.email) {
    process.stderr.write(`[onboarding] platform.config.json sem onboarding.sender_email — abortando antes de qualquer envio.\n`);
    process.exit(2);
  }
  const isoNow = new Date(nowSec * 1000).toISOString();

  for (const action of plan.actions as RunAction[]) {
    try {
      if (action.kind === "email1" || action.kind === "email2") {
        const snip = snippets[action.kind === "email1" ? 1 : 2];
        if (!snip) continue;
        const brevoId = await sendTransactionalEmail({
          apiKey: brevoKey,
          sender,
          to: action.entry.email,
          subject: snip.assunto ?? "",
          htmlContent: snip.body,
        });
        applySendResult(action.entry, action.kind, brevoId, isoNow);
        process.stderr.write(`[onboarding] ${action.kind} → ${action.entry.email}${brevoId ? ` (${brevoId})` : ""}\n`);
      } else if (action.kind === "email3_campaign") {
        const snip = snippets[3];
        if (!snip) continue;
        const listName = cfg.d10_list_name ?? "Onboarding D10 sem abertura";
        let listId = store.d10_brevo_list_id;
        if (listId == null) {
          listId = await ensureD10List({ apiKey: brevoKey, listName });
          store.d10_brevo_list_id = listId;
        }
        for (const e of action.entries) {
          await upsertContactInList({ apiKey: brevoKey, email: e.email, listId });
        }
        const dateTag = new Date(nowSec * 1000).toISOString().slice(0, 10);
        const campaign = (await brevoPost(brevoKey, "/emailCampaigns", {
          name: `Onboarding D10 ${dateTag}`,
          subject: snip.assunto ?? "",
          sender,
          htmlContent: snip.body,
          recipients: { lists: [listId] },
        })) as { id: number };
        for (const e of action.entries) {
          e.email3_state = "campaign_created";
          e.email3_campaign_id = campaign.id;
          e.email3_decided_at = isoNow;
        }
        process.stderr.write(
          `[onboarding] email3 CAMPANHA RASCUNHO id=${campaign.id} lista=${listId} cohort=${action.entries.length}\n`,
        );
        summary.notes.push(`campanha rascunho ${campaign.id} criada (lista ${listId}) — agendar/enviar é ação humana`);
      }
    } catch (e) {
      process.stderr.write(`[onboarding] ERRO executando ${action.kind}: ${(e as Error).message}\n`);
      summary.notes.push(`erro em ${action.kind}: ${(e as Error).message}`);
    }
  }

  // --- 5. Persistência ---
  writeStore(store, storePath);
  console.log(JSON.stringify(summary, null, 2));
}

// #6158: guard de import — testes unitários novos importam `sendTransactionalEmail`/
// `applySendResult`/`runCancelPending` diretamente deste módulo (pra mockar
// `fetch` em vez de spawnar subprocesso); sem este guard, `main()` disparava
// no próprio `import` do teste (achado ao vivo escrevendo os testes desta
// issue — falhava tentando ler credenciais Beehiiv/Brevo do ambiente real).
if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[onboarding] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
