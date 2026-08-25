#!/usr/bin/env npx tsx
/**
 * onboarding-welcome-run.ts (#5908)
 *
 * Script DIÁRIO de onboarding fora da automação Beehiiv — mecanismo 1 da
 * decisão do editor (22/08/2026 ~11:08 BRT): Brevo transacional + detecção
 * de novos assinantes pela API pública v2 (`created_at__gte`, custo zero).
 *
 *   E-mail 1 (transacional)  → imediato na detecção (só status `active`)
 *   E-mail 2 (transacional)  → D+3
 *   E-mail 3 (CAMPANHA Brevo, marketing) → D+10 condicional a ZERO aberturas
 *     e cliques (mesma condição da automação descartada na #5808). A campanha
 *     é criada SEMPRE como RASCUNHO mirando a lista dedicada do cohort —
 *     agendamento/envio é ação humana explícita (mesma disciplina de
 *     rascunho-por-padrão dos outros publicadores Brevo do projeto).
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
 * Flags auxiliares (testes/operações): --store <path>, --snippets-dir <path>,
 * --skip-email1 --skip-email2 --skip-email3 (desliga etapas pontualmente).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
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

  // --- Kill switch (#5957) — ANTES de qualquer chamada externa, mesmo padrão
  // do guard `data/clarice-novos-enabled.json` em `clarice-novos-run.ts`. Ordem
  // preservada tal qual antes do #6158 — inclusive para --cancel-pending, que
  // segue sujeito ao mesmo guard (checagem determinística, nenhum caso testado
  // exige que cancelamento ignore a pausa). ---
  if (cfg.enabled === false) {
    process.stdout.write(
      "[onboarding] ⏸️  automação PAUSADA (platform.config.json → onboarding.enabled: false) — " +
        "nenhuma chamada Beehiiv/Brevo feita.\n",
    );
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const beeCfg = resolveBeehiivConfig();
  if (!beeCfg.ok) {
    process.stderr.write(`[onboarding] ${beeCfg.reason}\n`);
    process.exit(2);
  }
  const apiKeyEnv = cfg.api_key_env ?? "BREVO_DIARIA_API_KEY";
  const brevoKey = process.env[apiKeyEnv];
  if (!brevoKey) {
    process.stderr.write(`[onboarding] ${apiKeyEnv} ausente no env.\n`);
    process.exit(2);
  }

  const storePath = args.storePath ?? resolve(ROOT, cfg.store_path ?? DEFAULT_STORE_PATH);

  // --- #6158: modo dedicado --cancel-pending — cancela e sai, sem detecção/envio. ---
  if (args.cancelPending) {
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

  // --- BOOTSTRAP: primeira execução marca cursor e NÃO onboarda a base existente ---
  if (store.last_detection_cursor == null) {
    store.last_detection_cursor = nowSec;
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

  // --- 1. Detecção ---
  const fetched = await fetchSubscriptionsSince(beeCfg.config.publicationId, beeCfg.config.apiKey, store.last_detection_cursor);
  const knownIds = new Set(Object.keys(store.entries));
  const { novos } = classifyNewSubscribers(fetched, knownIds);
  summary.detected_new = novos.length;

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
    const fresh = await fetchSubscriptionById(beeCfg.config.publicationId, beeCfg.config.apiKey, e.subscription_id);
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
