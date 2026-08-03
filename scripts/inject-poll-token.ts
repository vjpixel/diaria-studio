#!/usr/bin/env npx tsx
/**
 * inject-poll-token.ts (#4487)
 *
 * Pré-envio: gera o token opaco por assinante (`computePollTokenEmail`,
 * `scripts/lib/shared/poll-token.ts`), grava 1 custom field permanente
 * `poll_token` via Beehiiv API (o local-part vira `{{poll_token}}` na URL de
 * voto do e-mail diário, `newsletter-render-html.ts::renderEIA`), e grava a
 * entrada reversa `polltoken:{token} -> email` no KV do Worker `poll` (via
 * Cloudflare API, `putTextToWorkerKV`) — é essa entrada que `handleVote`
 * (workers/poll/src/vote.ts) consulta pra resolver o token de volta pro
 * e-mail real antes de qualquer lógica de score/dedup/nickname.
 *
 * Sucessor do extinto `inject-poll-sig.ts` (#1083, removido em #1186) — MESMO
 * mecanismo operacional (custom field populado antes do envio, patch
 * incremental de subscribers novos), propósito DIFERENTE: o #1186 removeu o
 * `poll_sig` porque autenticação HMAC anti-forjamento não valia o custo
 * operacional pra um leaderboard sem aposta real. Este token não autentica
 * nada — ele existe pra parar de vazar o e-mail do assinante e a identidade
 * dele quando a edição é encaminhada (#4487/#4456: "vota no lugar dele").
 *
 * Idempotente: token é DETERMINÍSTICO (HMAC do e-mail) — lê o custom field
 * atual e skipa quando já bate com o valor calculado (sem precisar reler o
 * KV pra decidir). Roda 1x por subscriber (na primeira sincronização); patcha
 * apenas subscribers novos em runs subsequentes via `--since-hours`.
 *
 * Uso:
 *   npx tsx scripts/inject-poll-token.ts
 *   npx tsx scripts/inject-poll-token.ts --dry-run
 *   npx tsx scripts/inject-poll-token.ts --force          # repatch all (rotação de POLL_SECRET)
 *   npx tsx scripts/inject-poll-token.ts --since-hours 96 # só subscribers das últimas 96h
 *
 * `--since-hours N` filtra **client-side** por `created` (Unix segundos) ou
 * `subscribed_on` (ISO 8601) — a REST API Beehiiv ignora `subscribed_after`,
 * então o script lista TODOS os subscribers (mesma paginação que sem flag) e
 * descarta os fora da janela antes do compare/PATCH/KV-write.
 *
 * **Não executado ao vivo neste PR** (worktree isolado, sem
 * BEEHIIV_API_KEY/CLOUDFLARE_WORKERS_TOKEN reais nem Task Scheduler) — igual
 * ao padrão já documentado pro #4320/#4382 em CLAUDE.md. Wiring no Stage 0
 * preflight (`orchestrator-stage-0-preflight.md`) + 1ª execução ao vivo ficam
 * pendentes do editor.
 *
 * Env:
 *   BEEHIIV_API_KEY          - acesso à API Beehiiv (required)
 *   BEEHIIV_PUBLICATION_ID   - ID da publicação (required)
 *   POLL_SECRET              - HMAC key, mesma usada pelo Worker (required)
 *   CLOUDFLARE_ACCOUNT_ID    - conta Cloudflare (required, default hardcoded em poll-kv config)
 *   CLOUDFLARE_WORKERS_TOKEN - token com permissão Workers KV (required)
 */

import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { computePollToken, pollTokenKvKey, VOTE_TOKEN_DOMAIN } from "./lib/shared/poll-token.ts";
import { putTextToWorkerKV, type CloudflareKVConfig } from "./lib/cloudflare-kv-upload.ts";

loadProjectEnv(); // #1219 — carrega .env/.env.local antes de ler process.env.

const FIELD_TOKEN = "poll_token";
const CONCURRENCY = 3;
// #1233/#1237: mesmo namespace que scripts/lib/poll-kv.ts usa por default —
// duplicado aqui (não importado) porque poll-kv.ts é wrangler-CLI-based
// (spawnSync) e este script usa a API HTTP direta (putTextToWorkerKV),
// caminho mais rápido pra escrever N milhares de keys sem spawnar 1 processo
// wrangler por subscriber.
const DEFAULT_POLL_KV_NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6";

interface BeehiivCustomField {
  id: string;
  kind: string;
  display: string;
}

interface BeehiivSubscription {
  id: string;
  email: string;
  status: string;
  /** Unix timestamp (segundos) — REST API retorna esse campo */
  created?: number;
  /** ISO 8601 — alguns endpoints/wrappers usam esse */
  subscribed_on?: string;
  custom_fields?: Array<{ name: string; value: string }>;
}

interface BeehiivPage<T> {
  data: T[];
  has_more?: boolean;
  next_cursor?: string;
}

interface ApiOpts {
  publicationId: string;
  apiKey: string;
  baseUrl?: string;
}

async function fetchJson<T>(
  url: string,
  apiKey: string,
  init?: RequestInit,
): Promise<T> {
  // Retry com backoff exponencial pra 429 (rate limit Beehiiv).
  const MAX_RETRIES = 5;
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.ok) return (await res.json()) as T;

    const body = (await res.text()).slice(0, 500);

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseFloat(res.headers.get("retry-after") ?? "");
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
      continue;
    }
    throw new Error(`Beehiiv API ${res.status}: ${body}`);
  }
}

/** Cria custom field `poll_token` se não existir. Idempotente. */
async function ensureCustomField(opts: ApiOpts): Promise<void> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const baseUrl = `${base}/publications/${opts.publicationId}/custom_fields`;
  const existing = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const page = await fetchJson<BeehiivPage<BeehiivCustomField>>(
      `${baseUrl}?${params.toString()}`,
      opts.apiKey,
    );
    for (const f of page.data ?? []) existing.add(f.display);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  if (existing.has(FIELD_TOKEN)) return;
  await fetchJson(baseUrl, opts.apiKey, {
    method: "POST",
    body: JSON.stringify({ kind: "string", display: FIELD_TOKEN }),
  });
  console.error(`[inject-poll-token] criado custom field "${FIELD_TOKEN}"`);
}

/** Subscribers active paginados. */
async function* iterateActiveSubscriptions(
  opts: ApiOpts,
): AsyncGenerator<BeehiivSubscription[]> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({
      status: "active",
      limit: "100",
      "expand[]": "custom_fields",
    });
    if (cursor) params.set("cursor", cursor);
    const url = `${base}/publications/${opts.publicationId}/subscriptions?${params.toString()}`;
    const page = await fetchJson<BeehiivPage<BeehiivSubscription>>(
      url,
      opts.apiKey,
    );
    yield page.data ?? [];
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
}

/** Resolve subscriber created timestamp (Unix segundos) — REST API usa `created`,
 *  MCP wrapper / outros usam `subscribed_on` (ISO). */
function subscriberCreatedMs(sub: BeehiivSubscription): number | undefined {
  if (typeof sub.created === "number") return sub.created * 1000;
  if (sub.subscribed_on) {
    const ms = Date.parse(sub.subscribed_on);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

async function patchSubscriberToken(
  subId: string,
  tokenEmail: string,
  opts: ApiOpts,
): Promise<void> {
  const base = opts.baseUrl ?? "https://api.beehiiv.com/v2";
  const url = `${base}/publications/${opts.publicationId}/subscriptions/${subId}`;
  await fetchJson(url, opts.apiKey, {
    method: "PATCH",
    body: JSON.stringify({
      custom_fields: [{ name: FIELD_TOKEN, value: tokenEmail }],
    }),
  });
}

async function processBatch<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<{ ok: number; failed: Array<{ item: T; error: string }> }> {
  let ok = 0;
  const failed: Array<{ item: T; error: string }> = [];
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      try {
        await worker(items[i]);
        ok++;
      } catch (e) {
        failed.push({ item: items[i], error: (e as Error).message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return { ok, failed };
}

interface RunResult {
  total_subscribers: number;
  patched: number;
  skipped_already_correct: number;
  skipped_no_email: number;
  failed: number;
  dry_run: boolean;
  since_iso?: string;
  in_window?: number;
  skipped_outside_window?: number;
}

export async function run(args: {
  dryRun: boolean;
  force: boolean;
  apiOpts: ApiOpts;
  secret: string;
  sinceHours?: number;
  kvConfig: CloudflareKVConfig;
  /** Injetável — undici MockAgent não intercepta a chamada nativa `https`
   * usada por `wranglerKvPut`-like helpers; `putTextToWorkerKV` já é
   * fetch-based e mockável (mesmo padrão de #4165/#4173). */
  putKv?: typeof putTextToWorkerKV;
}): Promise<RunResult> {
  const { dryRun, force, apiOpts, secret, sinceHours, kvConfig } = args;
  const putKv = args.putKv ?? putTextToWorkerKV;

  if (!dryRun) {
    await ensureCustomField(apiOpts);
  }

  const cutoffMs = sinceHours && sinceHours > 0
    ? Date.now() - sinceHours * 3600 * 1000
    : undefined;
  const sinceIso = cutoffMs ? new Date(cutoffMs).toISOString() : undefined;

  let total = 0;
  let inWindow = 0;
  let patched = 0;
  let skippedAlready = 0;
  let skippedNoEmail = 0;
  let skippedOutsideWindow = 0;
  let failedTotal = 0;
  let pageNum = 0;

  for await (const page of iterateActiveSubscriptions(apiOpts)) {
    pageNum++;
    total += page.length;
    const needsPatch: Array<{ id: string; email: string; token: string; tokenEmail: string }> = [];

    for (const sub of page) {
      if (!sub.email || !sub.email.trim()) {
        skippedNoEmail++;
        continue;
      }
      // Filter client-side por created/subscribed_on (REST API ignora subscribed_after).
      if (cutoffMs !== undefined) {
        const createdMs = subscriberCreatedMs(sub);
        if (createdMs === undefined || createdMs < cutoffMs) {
          skippedOutsideWindow++;
          continue;
        }
      }
      inWindow++;
      const expectedToken = await computePollToken(secret, sub.email);
      const expectedTokenEmail = `${expectedToken}@${VOTE_TOKEN_DOMAIN}`;
      if (!force) {
        const current = sub.custom_fields?.find((f) => f.name === FIELD_TOKEN)?.value;
        if (current === expectedTokenEmail) {
          skippedAlready++;
          continue;
        }
      }
      needsPatch.push({ id: sub.id, email: sub.email, token: expectedToken, tokenEmail: expectedTokenEmail });
    }

    if (dryRun) {
      console.error(
        `[inject-poll-token] page ${pageNum}: ${needsPatch.length} need patch, ${skippedAlready} already correct (running)`,
      );
      continue;
    }

    const result = await processBatch(needsPatch, CONCURRENCY, async (item) => {
      // Grava a entrada reversa PRIMEIRO — se o PATCH da Beehiiv falhar depois,
      // o pior caso é uma entrada KV órfã (sem custo real: token nunca sai na
      // URL sem o custom field populado), nunca um custom field publicado
      // sem a entrada reversa correspondente (que faria o link 400 pro leitor).
      await putKv(pollTokenKvKey(item.token), item.email, kvConfig);
      await patchSubscriberToken(item.id, item.tokenEmail, apiOpts);
    });
    patched += result.ok;
    failedTotal += result.failed.length;
    for (const f of result.failed) {
      console.error(
        `[inject-poll-token] FAIL ${f.item.email}: ${f.error.slice(0, 200)}`,
      );
    }
    console.error(
      `[inject-poll-token] page ${pageNum}: patched ${result.ok}/${needsPatch.length}, running total patched ${patched}`,
    );
  }

  return {
    total_subscribers: total,
    patched,
    skipped_already_correct: skippedAlready,
    skipped_no_email: skippedNoEmail,
    failed: failedTotal,
    dry_run: dryRun,
    since_iso: sinceIso,
    in_window: cutoffMs !== undefined ? inWindow : undefined,
    skipped_outside_window: cutoffMs !== undefined ? skippedOutsideWindow : undefined,
  };
}

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const force = flags.has("force");
  const sinceHoursRaw = values["since-hours"];
  const sinceHours = sinceHoursRaw ? Number(sinceHoursRaw) : undefined;
  if (sinceHoursRaw !== undefined && (!Number.isFinite(sinceHours) || sinceHours! <= 0)) {
    console.error(
      `[inject-poll-token] --since-hours inválido: ${sinceHoursRaw} (precisa ser número > 0)`,
    );
    process.exit(1);
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
  const secret = process.env.POLL_SECRET;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const workersToken = process.env.CLOUDFLARE_WORKERS_TOKEN;
  const missing: string[] = [];
  if (!apiKey) missing.push("BEEHIIV_API_KEY");
  if (!publicationId) missing.push("BEEHIIV_PUBLICATION_ID");
  if (!secret) missing.push("POLL_SECRET");
  if (!dryRun && !accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!dryRun && !workersToken) missing.push("CLOUDFLARE_WORKERS_TOKEN");
  if (missing.length > 0) {
    console.error(
      `[inject-poll-token] envs ausentes: ${missing.join(", ")} — abortando`,
    );
    process.exit(1);
  }

  const result = await run({
    dryRun,
    force,
    apiOpts: { apiKey: apiKey!, publicationId: publicationId! },
    secret: secret!,
    sinceHours,
    kvConfig: {
      accountId,
      token: workersToken,
      kvNamespaceId: process.env.POLL_KV_NAMESPACE_ID ?? DEFAULT_POLL_KV_NAMESPACE_ID,
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[inject-poll-token] ${(e as Error).message}`);
    process.exit(1);
  });
}
