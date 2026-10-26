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
 *   Cloudflare (via Buffer, chamado do orchestrator top-level ao publicar).
 *   Tem reconciliador PRÓPRIO, `verify-twitter-posts.ts` (#5766), rodando no
 *   mesmo check 0k logo antes deste script — via API GraphQL do Buffer, não
 *   via este Worker. `FIRE_AND_FORGET_PLATFORMS` em `lib/prev-social-status.ts`
 *   não trata mais `twitter` como terminal-by-design desde o #6152.
 *
 * ## Motivo da DLQ e envio ambíguo (#7626, #11106, #11129)
 *
 * Desde o #7626 o Worker grava `last_error` na entry ao mover pra DLQ, e desde
 * o #11106 um envio ambíguo (resposta do publish sem prova de sucesso nem de
 * falha) vai pra DLQ com `last_error` começando por `send_unknown:`, sem
 * refazer. A reconciliação usa os dois: `send_unknown:` vira
 * `status: "send_unknown"` (o post pode ter saído — a invariante
 * `social-published-send-unknown` e o check 0l avisam), o resto vira `failed`
 * com o `last_error` em `failure_reason`. Entry de DLQ antiga, sem
 * `last_error`, cai no texto genérico `DLQ_REASON_PLACEHOLDER`.
 *
 * A DLQ não reusa a key da fila (`buildDlqKey`: `queue:{iso}:{uuid}` →
 * `dlq:{scheduled_at}:{uuid}`): o casamento é pelo uuid (`workerKeyId`).
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
import { runCli } from "./lib/cli-exit.ts";
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

/** Prefixo que o Worker grava em `last_error` num envio ambíguo (`SEND_UNKNOWN_PREFIX` de `workers/linkedin-cron/src/dispatch.ts`, #11106). */
export const WORKER_SEND_UNKNOWN_PREFIX = "send_unknown:";

/** O que o reconciliador precisa de uma entry do `GET /dlq`. */
export interface DlqItemInfo {
  key: string;
  /** Motivo gravado pelo Worker ao mover pra DLQ (#7626); `send_unknown:` = envio ambíguo (#11106). */
  last_error?: string;
}

/** DLQ indexado pelo id da entry (o uuid depois do último `:`), ver `workerKeyId`. */
export type DlqIndex = ReadonlyMap<string, DlqItemInfo>;

/**
 * #11129 — id estável de uma key do Worker: o trecho depois do último `:`.
 * O Worker NÃO reusa a key da fila no DLQ: `buildDlqKey` troca
 * `queue:{iso}:{uuid}` por `dlq:{scheduled_at}:{uuid}` (e o legacy
 * `queue:{uuid}` por `dlq:{scheduled_at}:{uuid}`). Comparar a key inteira
 * nunca casava — a entry que caiu na DLQ sumia da fila E "do DLQ" e era
 * promovida a `published` com alta confiança. O uuid é o que as duas keys
 * têm em comum.
 */
export function workerKeyId(key: string): string {
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

/** Indexa os itens do `GET /dlq` por `workerKeyId`. */
export function buildDlqIndex(items: ReadonlyArray<{ key: string; last_error?: unknown }>): DlqIndex {
  const out = new Map<string, DlqItemInfo>();
  for (const it of items) {
    if (typeof it.key !== "string" || !it.key) continue;
    out.set(workerKeyId(it.key), {
      key: it.key,
      ...(typeof it.last_error === "string" && it.last_error ? { last_error: it.last_error } : {}),
    });
  }
  return out;
}

function toDlqIndex(dlq: Set<string> | DlqIndex): DlqIndex {
  return dlq instanceof Set ? buildDlqIndex([...dlq].map((key) => ({ key }))) : dlq;
}

/**
 * Reconciliação pura de UMA entry contra os key-sets da fila ativa e do DLQ.
 * Testável sem network.
 *
 * Só age sobre entries de canal reconciliável (`WORKER_RECONCILABLE_PLATFORMS`)
 * que ainda estão `status: "scheduled"` E têm `worker_queue_key` (entries sem
 * a key — legacy, ou `fallback_used` do LinkedIn que nunca passou pela fila —
 * não têm como ser confrontadas, ficam intocadas).
 *
 * DLQ (#11129): casa pelo id da key (`workerKeyId`), não pela key inteira. Com
 * `last_error` começando por `send_unknown:` (envio ambíguo, #11106) a entry
 * vira `send_unknown` — o post pode ter saído, então não é `failed` (que se
 * refaz) — e a invariante `social-published-send-unknown` e o check 0l passam
 * a enxergar o caso. Os demais itens da DLQ viram `failed`, com o `last_error`
 * do Worker quando houver.
 */
export function reconcileWorkerEntry(
  entry: PostEntry,
  queueKeys: Set<string>,
  dlq: Set<string> | DlqIndex,
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

  const dead = toDlqIndex(dlq).get(workerKeyId(key));
  if (dead) {
    const lastError = dead.last_error;
    if (lastError?.startsWith(WORKER_SEND_UNKNOWN_PREFIX)) {
      return {
        updated: {
          ...entry,
          status: "send_unknown",
          failure_reason: lastError,
          worker_dlq_key: dead.key,
          verification_note:
            "worker_send_unknown: o Worker recebeu resposta ambígua do publish (timeout, 5xx ou 2xx sem id) " +
            "e moveu o item pra DLQ sem refazer — o post PODE ter saído. Conferir o perfil na rede antes de qualquer nova tentativa (#11129).",
        },
        changed: true,
      };
    }
    return {
      updated: {
        ...entry,
        status: "failed",
        failure_reason: lastError ? `worker_dlq: ${lastError}` : DLQ_REASON_PLACEHOLDER,
        worker_dlq_key: dead.key,
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
function pendingQueueKeys(posts: PostEntry[], queueKeys: Set<string>, dlq: DlqIndex): string[] {
  const out: string[] = [];
  for (const entry of posts) {
    if (!WORKER_RECONCILABLE_PLATFORMS.has(entry.platform)) continue;
    if (entry.status !== "scheduled") continue;
    const key = entry.worker_queue_key as string | undefined;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!queueKeys.has(key) && !dlq.has(workerKeyId(key))) out.push(key);
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
): Promise<{ updated: SocialPublished; changes: number; inQueue: number }> {
  const rawRetry = { ...DEFAULT_RETRY, ...retry };
  const maxAttempts = Math.max(1, rawRetry.maxAttempts);
  const backoffMs = rawRetry.backoffMs;
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
    const pending = pendingQueueKeys(published.posts, queueKeys, buildDlqIndex(dlqResp.items));
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
  const dlqIndex = buildDlqIndex(dlqResp!.items);
  const stillPending = pendingQueueKeys(published.posts, queueKeys2, dlqIndex);
  if (stillPending.length > 0) {
    console.warn(
      `[verify-social-worker] AVISO (#6016): ${stillPending.length} entry(s) continuam ausente(s) da fila ` +
        `E do DLQ apos ${maxAttempts} tentativa(s): ${stillPending.join(", ")}. Isto NAO é "confirmado ausente" — ` +
        `pode ser lag de propagação do KV. NÃO re-dispare com base nesta leitura única.`,
    );
  }

  let changes = 0;
  const updatedPosts: PostEntry[] = published.posts.map((entry) => {
    const { updated, changed } = reconcileWorkerEntry(entry, queueKeys2, dlqIndex, now);
    if (changed) changes++;
    return updated;
  });

  // #9259: `changes` conta TRANSIÇÕES de status (disparado/DLQ) — uma entry
  // recém-enfileirada e ainda na fila conta 0 ali. `inQueue` é o número de
  // entries `scheduled` cuja key o Worker de fato lista na fila ativa, que é
  // o que um "confirmado na fila" deve reportar.
  const inQueue = updatedPosts.filter(
    (p) =>
      WORKER_RECONCILABLE_PLATFORMS.has(p.platform) &&
      p.status === "scheduled" &&
      typeof p.worker_queue_key === "string" &&
      queueKeys2.has(p.worker_queue_key),
  ).length;

  return { updated: { ...published, posts: updatedPosts }, changes, inQueue };
}

/** #9259 — resumo da reconciliação pós-dispatch. Separa o que está
 *  confirmado na fila (`inQueue`) do que mudou de status (`changes`). */
export function formatVerifySummary(result: { changes: number; inQueue?: number }): string {
  const fila = result.inQueue === undefined ? "?" : String(result.inQueue);
  return `${fila} entrada(s) confirmada(s) na fila; ${result.changes} reconciliada(s) (disparada/DLQ).`;
}

async function main(): Promise<number | void> {
  const args = parseArgsLib(process.argv.slice(2)).values;
  const editionDir = args["edition-dir"];
  if (!editionDir) {
    console.error("Uso: verify-social-worker-dispatch.ts --edition-dir <path>");
    return 1;
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
      // #11129: envio ambíguo no Worker — o post pode ter saído; o editor confere antes de refazer.
      for (const p of updated.posts.filter((x) => x.status === "send_unknown" && typeof x.worker_dlq_key === "string")) {
        console.warn(`[verify-social-worker] AVISO: ${p.platform}/${p.destaque ?? "?"} em envio ambíguo no Worker (${p.failure_reason ?? "send_unknown"}) — confira o perfil antes de refazer.`);
      }
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
  // #9911: grava process.exitCode em vez de process.exit — no Windows (Node 24) o exit logo após um fetch sai 127.
  runCli(main, { onError: (e) => console.error(e) });
}
