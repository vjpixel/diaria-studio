/**
 * verify-social-worker-dispatch.ts (#5766)
 *
 * Reconcilia posts LinkedIn/Instagram/Threads da edição ANTERIOR contra o
 * Worker Cloudflare `diaria-linkedin-cron` — mesmo papel que
 * `verify-facebook-posts.ts` cumpre pro Facebook (check 0k), fechando o
 * buraco descrito em #5766: hoje esses 3 canais saem de `publish-*.ts` como
 * `status: "scheduled"` e nunca mais são reconciliados, então uma falha
 * pós-dispatch (token expirado, mídia rejeitada, rate limit da Graph API,
 * webhook Make rejeitando) fica invisível indefinidamente.
 *
 * ## Por que dá pra fazer isto SEM tocar no Worker (opção 1 x opção 2 da issue)
 *
 * O Worker já expõe os 2 endpoints que este script precisa — `GET /list`
 * (fila ativa) e `GET /dlq` (falhas permanentes, após esgotar
 * `MAX_RETRIES` ou cair num guard de configuração) — nenhum dos dois é novo.
 * O que faltava era um consumidor no repo. Isso evita o escopo/risco de tocar
 * `workers/linkedin-cron/src/*.ts` (deploy automático via CI, #5766 opção 1)
 * e evita chamar Instagram/Threads/Buffer diretamente (opção 2 tal como
 * descrita na issue) — reconciliamos contra a MESMA infra que já confiamos
 * (mesmo token, mesmo binding) e que o Worker já popula sozinho.
 *
 * ## Nível de garantia por canal — honestidade sobre o que cada um prova
 *
 * - **Instagram/Threads**: o disparo do Worker (`dispatch.ts::fireInstagram`/
 *   `fireThreads`) só retorna `{status:"fired"}` depois que o passo
 *   `media_publish`/`threads_publish` da Graph API respondeu com um `id` —
 *   isto é confirmação REAL de publicação, não só enfileiramento. Uma entry
 *   que não está na fila (`/list`) nem no DLQ (`/dlq`) foi genuinamente
 *   publicada — promovida a `status: "published"` com alta confiança.
 * - **LinkedIn**: o disparo (`fireLinkedIn`) só confirma que o webhook Make.com
 *   aceitou a requisição (HTTP 2xx) — Make é fire-and-forget a partir daí, sem
 *   callback pro Worker. Uma entry que saiu da fila sem cair em DLQ é
 *   promovida a `status: "published"` também (estritamente mais informação
 *   que "estava enfileirado", que era tudo que existia antes desta issue),
 *   mas com `verification_note` explícito marcando a confiança mais baixa —
 *   NUNCA a mesma confiança do Instagram/Threads. Falha genuína (DLQ) é
 *   detectada igual nos 3 canais.
 * - **Twitter**: fora de escopo deste script — não passa pelo Worker
 *   Cloudflare (via Buffer MCP, chamado direto pelo orchestrator top-level).
 *   `FIRE_AND_FORGET_PLATFORMS` em `lib/prev-social-status.ts` continua
 *   tratando `twitter` como terminal-by-design. Ver #5766 pra follow-up.
 *
 * ## Limitação conhecida do DLQ
 *
 * As entries em `dlq:*` no KV não persistem o motivo da falha (só
 * `retry_count`) — o motivo detalhado só existe nos logs do Cloudflare Worker
 * (`console.error`), que este script não tem como ler. `failure_reason`
 * gravado aqui é sempre um texto genérico apontando pra essa limitação; o
 * editor precisa consultar `wrangler tail`/dashboard Cloudflare pra motivo
 * fino. Ver #5766 se isso virar dor recorrente — persistir o motivo na
 * própria entry DLQ resolveria (mudança no Worker, fora de escopo aqui).
 *
 * Uso:
 *   npx tsx scripts/verify-social-worker-dispatch.ts --edition-dir data/editions/260423/
 *
 * Requer: DIARIA_LINKEDIN_CRON_URL + DIARIA_LINKEDIN_CRON_TOKEN no env (ou
 * `publishing.social.linkedin.cloudflare_worker_url` em platform.config.json
 * pro URL). Ausência de credenciais é fail-soft — loga warning e sai 0 (mesmo
 * padrão de verify-facebook-posts.ts / check 0k: nunca bloqueia a próxima
 * edição por causa de uma reconciliação best-effort).
 *
 * Output: atualiza in-place `06-social-published.json` da edição informada.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import type { PostEntry, SocialPublished } from "./lib/social-published-store.ts";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
export type { PostEntry, SocialPublished };

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Canais que passam pelo Worker Cloudflare `diaria-linkedin-cron` — os únicos
 * que este script sabe reconciliar. Twitter (via Buffer) fica de fora. */
export const WORKER_RECONCILABLE_PLATFORMS = new Set(["linkedin", "instagram", "threads"]);

/** Canais cujo `fired` do Worker É confirmação real de entrega (a chamada de
 * publish da própria plataforma respondeu com sucesso antes do Worker
 * reportar `fired`) — diferente do LinkedIn, que só confirma aceite do
 * webhook Make, fire-and-forget dali em diante. */
const REAL_DELIVERY_CONFIRMATION_PLATFORMS = new Set(["instagram", "threads"]);

/**
 * Resolve URL do Worker LinkedIn — mesma precedência de
 * verify-stage-4-dispatch.ts/publish-linkedin.ts: env > platform.config.json.
 */
export function resolveLinkedinWorkerUrl(rootDir: string = ROOT): string {
  const fromEnv = process.env.DIARIA_LINKEDIN_CRON_URL;
  if (fromEnv) return fromEnv;
  try {
    const config = JSON.parse(
      readFileSync(resolve(rootDir, "platform.config.json"), "utf8"),
    ) as {
      publishing?: { social?: { linkedin?: { cloudflare_worker_url?: string } } };
    };
    return config.publishing?.social?.linkedin?.cloudflare_worker_url ?? "";
  } catch {
    return "";
  }
}

/**
 * Pure: resolve o path canônico de `06-social-published.json` — mesmo
 * fallback `_internal/` > raiz de `verify-facebook-posts.ts`.
 */
export function resolveSocialPublishedPath(
  rootDir: string,
  editionDir: string,
): string | null {
  const internal = resolve(rootDir, editionDir, "_internal", "06-social-published.json");
  if (existsSync(internal)) return internal;
  const rootLegacy = resolve(rootDir, editionDir, "06-social-published.json");
  if (existsSync(rootLegacy)) return rootLegacy;
  return null;
}

export interface WorkerListResponse {
  count: number;
  items: Array<{ key: string; [key: string]: unknown }>;
}

export interface WorkerDlqResponse {
  count: number;
  items: Array<{ key: string; [key: string]: unknown }>;
}

export type FetchJsonFn = (url: string, token: string) => Promise<unknown>;

async function defaultFetchJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "X-Diaria-Token": token } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Worker HTTP ${res.status} em ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchWorkerList(
  workerUrl: string,
  token: string,
  fetchJson: FetchJsonFn = defaultFetchJson,
): Promise<WorkerListResponse> {
  const url = workerUrl.replace(/\/+$/, "") + "/list";
  return (await fetchJson(url, token)) as WorkerListResponse;
}

export async function fetchWorkerDlq(
  workerUrl: string,
  token: string,
  fetchJson: FetchJsonFn = defaultFetchJson,
): Promise<WorkerDlqResponse> {
  const url = workerUrl.replace(/\/+$/, "") + "/dlq";
  return (await fetchJson(url, token)) as WorkerDlqResponse;
}

export const DLQ_REASON_PLACEHOLDER =
  "worker_dlq: disparo esgotou retries (ou caiu num guard de configuração) — " +
  "motivo detalhado não é persistido na entry DLQ, só nos logs do Cloudflare " +
  "Worker (console.error). Consultar `wrangler tail`/dashboard Cloudflare pra " +
  "diagnóstico fino (ver #5766).";

/**
 * Reconciliação pura de UMA entry contra os key-sets da fila ativa e do DLQ.
 * Testável sem network.
 *
 * Só age sobre entries de canal reconciliável (`WORKER_RECONCILABLE_PLATFORMS`)
 * que ainda estão `status: "scheduled"` E têm `worker_queue_key` (entries sem
 * a key — legacy, ou `fallback_used` do LinkedIn que nunca passou pela fila —
 * não têm como ser confrontadas, ficam intocadas).
 */
export function reconcileWorkerEntry(
  entry: PostEntry,
  queueKeys: Set<string>,
  dlqKeys: Set<string>,
  now: Date = new Date(),
): { updated: PostEntry; changed: boolean } {
  if (!WORKER_RECONCILABLE_PLATFORMS.has(entry.platform)) {
    return { updated: entry, changed: false };
  }
  if (entry.status !== "scheduled") {
    return { updated: entry, changed: false };
  }
  const key = entry.worker_queue_key as string | undefined;
  if (typeof key !== "string" || key.length === 0) {
    return { updated: entry, changed: false };
  }

  if (dlqKeys.has(key)) {
    return {
      updated: {
        ...entry,
        status: "failed",
        failure_reason: DLQ_REASON_PLACEHOLDER,
        verification_note: undefined,
      },
      changed: true,
    };
  }

  if (queueKeys.has(key)) {
    // Ainda na fila ativa — nada a reconciliar ainda (ou o horário agendado
    // ainda não chegou, ou o cron/alarm ainda não processou).
    return { updated: entry, changed: false };
  }

  // Nem na fila nem no DLQ: o Worker considerou o item disparado com sucesso
  // (KV entry deletada só após `outcome.status === "fired"`, ver fire.ts e
  // durable-object.ts).
  const nowIso = now.toISOString();
  if (REAL_DELIVERY_CONFIRMATION_PLATFORMS.has(entry.platform)) {
    return {
      updated: {
        ...entry,
        status: "published",
        published_at: nowIso,
        failure_reason: undefined,
        verification_note:
          "confirmed_by_worker_high_confidence: Graph API media_publish/threads_publish " +
          "retornou sucesso antes do Worker reportar fired (entrega real confirmada, " +
          "não apenas enfileiramento) — ausente da fila e do DLQ.",
      },
      changed: true,
    };
  }
  // linkedin
  return {
    updated: {
      ...entry,
      status: "published",
      published_at: nowIso,
      failure_reason: undefined,
      verification_note:
        "make_webhook_accepted_no_platform_delivery_confirmation: Worker confirma que o " +
        "webhook Make.com foi aceito (HTTP 2xx) e o item saiu da fila sem cair em DLQ. " +
        "NÃO é confirmação de que o post apareceu no LinkedIn — Make é fire-and-forget " +
        "a partir daqui (garantia mais fraca que Instagram/Threads, ver #5766).",
    },
    changed: true,
  };
}

/**
 * Opções de retry do `verifyWorkerDispatch` (#6016 item 3).
 *
 * O KV do Worker tem lag de propagação: logo após um dispatch bem-sucedido,
 * `GET /list` pode ainda NÃO trazer a entry (~20s depois trazia, visto 2× na
 * mesma sessão em 23/08). Sem retry, a reconciliação interpreta a ausência
 * como "fired" (published) ou reporta "0 confirmadas" — e um operador que
 * leia o 0 como "não entrou" cria POST DUPLICADO ao re-disparar.
 */
export interface VerifyWorkerDispatchRetryOptions {
  /** Total de tentativas de fetch /list+/dlq. Default 3. */
  maxAttempts?: number;
  /** Backoff entre tentativas (ms). Default 5000. */
  backoffMs?: number;
  /** Injetável pra teste. Default `setTimeout` promisificado. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: Required<Omit<VerifyWorkerDispatchRetryOptions, "sleep">> = {
  maxAttempts: 3,
  backoffMs: 5_000,
};

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Pura: keys de entries `scheduled` com `worker_queue_key` ausentes dos dois
 *  key-sets — candidatas à ambiguidade "ainda não propagou × nunca entrou". */
function pendingQueueKeys(posts: PostEntry[], queueKeys: Set<string>, dlqKeys: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of posts) {
    if (!WORKER_RECONCILABLE_PLATFORMS.has(entry.platform)) continue;
    if (entry.status !== "scheduled") continue;
    const key = entry.worker_queue_key as string | undefined;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!queueKeys.has(key) && !dlqKeys.has(key)) out.push(key);
  }
  return out;
}

export async function verifyWorkerDispatch(
  published: SocialPublished,
  workerUrl: string,
  token: string,
  fetchJson: FetchJsonFn = defaultFetchJson,
  now: Date = new Date(),
  retry: VerifyWorkerDispatchRetryOptions = {},
): Promise<{ updated: SocialPublished; changes: number }> {
  const { maxAttempts, backoffMs } = { ...DEFAULT_RETRY, ...retry };
  const sleep = retry.sleep ?? defaultSleep;

  // #6016 item 3: enquanto houver entry `scheduled` cuja key não apareceu nem
  // na fila nem no DLQ, re-tentar com backoff antes de reconciliar — lag de
  // propagação do KV é a causa mais provável logo após o dispatch.
  let listResp: WorkerListResponse | undefined;
  let dlqResp: WorkerDlqResponse | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    [listResp, dlqResp] = await Promise.all([
      fetchWorkerList(workerUrl, token, fetchJson),
      fetchWorkerDlq(workerUrl, token, fetchJson),
    ]);
    const queueKeys = new Set(listResp.items.map((i) => i.key));
    const dlqKeys = new Set(dlqResp.items.map((i) => i.key));
    const pending = pendingQueueKeys(published.posts, queueKeys, dlqKeys);
    if (pending.length === 0) break;
    if (attempt < maxAttempts) {
      console.warn(
        `[verify-social-worker] tentativa ${attempt}/${maxAttempts}: ${pending.length} entry(s) ` +
          `ausente(s) da fila E do DLQ (${pending.join(", ")}) — aguardando ${backoffMs}ms ` +
          `(possível lag de propagação do KV) antes de re-tentar.`,
      );
      await sleep(backoffMs);
    }
  }
  const queueKeys2 = new Set(listResp!.items.map((i) => i.key));
  const dlqKeys2 = new Set(dlqResp!.items.map((i) => i.key));
  const stillPending = pendingQueueKeys(published.posts, queueKeys2, dlqKeys2);
  if (stillPending.length > 0) {
    console.warn(
      `[verify-social-worker] AVISO (#6016): ${stillPending.length} entry(s) continuam ausente(s) da fila ` +
        `E do DLQ apos ${maxAttempts} tentativa(s): ${stillPending.join(", ")}. Isto NAO é "confirmado ausente" — ` +
        `pode ser lag de propagação do KV. NÃO re-dispare com base nesta leitura única.`,
    );
  }

  let changes = 0;
  const updatedPosts: PostEntry[] = published.posts.map((entry) => {
    const { updated, changed } = reconcileWorkerEntry(entry, queueKeys2, dlqKeys2, now);
    if (changed) changes++;
    return updated;
  });

  return { updated: { ...published, posts: updatedPosts }, changes };
}

async function main(): Promise<void> {
  const args = parseArgsLib(process.argv.slice(2)).values;
  const editionDir = args["edition-dir"];
  if (!editionDir) {
    console.error("Uso: verify-social-worker-dispatch.ts --edition-dir <path>");
    process.exit(1);
  }

  const publishedPath = resolveSocialPublishedPath(ROOT, editionDir);
  if (!publishedPath) {
    // Edição sem 06-social-published.json (ex: primeira edição) — nada a
    // reconciliar, best-effort, não bloqueia.
    console.log(`[verify-social-worker] nenhum 06-social-published.json em ${editionDir} — skip.`);
    return;
  }

  const workerUrl = resolveLinkedinWorkerUrl();
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  if (!workerUrl || !workerToken) {
    console.log(
      "[verify-social-worker] DIARIA_LINKEDIN_CRON_URL/TOKEN ausente — pulando reconciliação " +
        "(fail-soft, não bloqueia).",
    );
    return;
  }

  try {
    const published = JSON.parse(readFileSync(publishedPath, "utf8")) as SocialPublished;
    const { updated, changes } = await verifyWorkerDispatch(published, workerUrl, workerToken);
    if (changes > 0) {
      writeFileSync(publishedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
      console.log(`[verify-social-worker] ${changes} post(s) atualizados em ${publishedPath}`);
    } else {
      console.log("[verify-social-worker] nenhuma mudança de status detectada.");
    }
  } catch (e) {
    // Fail-soft: falha de rede/Worker indisponível não deve bloquear a
    // próxima edição — mesmo padrão de verify-facebook-posts.ts (0k).
    console.warn(`[verify-social-worker] falhou (non-fatal): ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
