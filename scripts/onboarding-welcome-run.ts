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
import { brevoPost, brevoGet } from "./lib/brevo-client.ts";

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

/** Drena TODAS as páginas de subscriptions criadas desde `gteSec` (guard anti-truncamento #2457). */
async function fetchSubscriptionsSince(
  publicationId: string,
  apiKey: string,
  gteSec: number,
): Promise<DetectedSubscription[]> {
  const all: DetectedSubscription[] = [];
  let page = 1;
  let more = true;
  let totalResults: number | null = null;
  while (more) {
    const path =
      `/publications/${publicationId}/subscriptions` +
      `?expand[]=stats&limit=100&page=${page}&created_at__gte=${gteSec}`;
    const res = await beehiivFetch<BeehiivPage<RawSubscription>>(path, apiKey);
    if (!res.ok || !res.body) {
      throw new Error(`[onboarding] Beehiiv API ${res.status} em subscriptions página ${page}`);
    }
    const chunk = res.body.data ?? [];
    for (const s of chunk) {
      if (!s.id || !s.email) continue;
      all.push({ id: s.id, email: s.email, status: s.status ?? "unknown", created: s.created ?? null });
    }
    if (res.body.total_results != null) totalResults = res.body.total_results;
    if (chunk.length === 0) more = false;
    else if (totalResults != null) more = all.length < totalResults;
    else {
      const apiLimit = typeof res.body.limit === "number" && res.body.limit > 0 ? res.body.limit : 100;
      more = chunk.length >= apiLimit;
    }
    page++;
  }
  if (totalResults != null && all.length < totalResults) {
    throw new Error(`[onboarding] truncado: ${all.length}/${totalResults} subscriptions — abortando.`);
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

/** Envio transacional real (POST /v3/smtp/email). Retorna message-id quando a Brevo devolve. */
async function sendTransactionalEmail(opts: {
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
  })) as { messageId?: string };
  return res?.messageId ?? null;
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
  const args: CliArgs = { send: false, skip: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--send") args.send = true;
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
  // do guard `data/clarice-novos-enabled.json` em `clarice-novos-run.ts`. ---
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
      email2_sent_at: null,
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
        const messageId = await sendTransactionalEmail({
          apiKey: brevoKey,
          sender,
          to: action.entry.email,
          subject: snip.assunto ?? "",
          htmlContent: snip.body,
        });
        if (action.kind === "email1") action.entry.email1_sent_at = isoNow;
        else action.entry.email2_sent_at = isoNow;
        process.stderr.write(`[onboarding] ${action.kind} → ${action.entry.email}${messageId ? ` (${messageId})` : ""}\n`);
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

main().catch((e) => {
  process.stderr.write(`[onboarding] fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
