/**
 * worker-queue-client.ts (#3944 Parte B)
 *
 * Cliente compartilhado do endpoint `/queue` do Worker Cloudflare
 * `diaria-linkedin-cron`, usado por qualquer canal que agenda via esse
 * Worker além do LinkedIn (Instagram #3817, Threads #3944 Parte B).
 *
 * Extraído de `publish-instagram.ts` (onde vivia como `postToWorkerQueue` /
 * `InstagramQueuePayload`) no momento em que Threads passou a precisar do
 * MESMO cliente — evita a 2ª cópia que a extração original (#3817) já tinha
 * evitado ao reusar o endpoint/schema de resposta do LinkedIn.
 *
 * `image_url` é opcional aqui (Threads publica posts só-texto; Instagram
 * exige imagem — a exigência é validada no caller e no Worker, não neste
 * cliente HTTP genérico).
 */

import { CONFIG } from "./config.ts";
import { parseWorkerQueueResponse } from "./schemas/linkedin-payload.ts";

export interface WorkerQueuePayload {
  text: string;
  image_url?: string | null;
  // #4146 — carrossel (pré-requisito #4153, já implementado no Worker):
  // lista de N URLs (1-10, validada no Worker) usada no lugar de `image_url`
  // quando o post tem mais de 1 imagem (ex: post semanal com 1 card 4:5 por
  // dia). Opcional — omitido/`undefined` preserva o caminho de imagem única
  // (`image_url`) para LinkedIn/Threads/Instagram diário.
  //
  // #8050 identificou que carrossel era implementado só pro `channel:
  // "instagram"` e `"threads"` (`fireInstagramCarousel`/`fireThreadsCarousel`
  // em dispatch.ts) — `channel: "linkedin"` caía em silêncio pro
  // `image_url` ausente (`fireLinkedIn` só encaminhava `image_url` singular
  // ao Make.com). O #8052 fecha o gap: `channel: "linkedin"` com
  // `image_urls` de mais de 1 item agora publica via `fireLinkedInCarousel`
  // — API DIRETA do LinkedIn (Images API + Posts API), sem passar pelo
  // webhook Make (que continua sendo o caminho do post single-image de
  // sempre). Os 3 canais que aceitam `channel` (linkedin/instagram/threads)
  // suportam carrossel hoje.
  image_urls?: string[] | null;
  scheduled_at: string;
  destaque: string;
  // #4101 — "linkedin" adicionado: o Worker (workers/linkedin-cron/src/index.ts)
  // já aceita `channel: "linkedin"` explícito desde sempre (é o default quando
  // omitido, ver dispatch.ts `entry.channel ?? "linkedin"`) — só o tipo local
  // deste cliente compartilhado era mais restrito que o contrato real do
  // servidor. Usado por `publish-weekly-social.ts` pra enfileirar o post
  // semanal de LinkedIn pelo mesmo endpoint `/queue` (Make.com scenario).
  channel: "linkedin" | "instagram" | "threads";
  // #10823 — Reels agendado (só `channel: "instagram"`): `media_type: "REELS"`
  // + `video_url` público (https) no lugar de `image_url`; `collaborators`
  // (≤3 usernames) e `ig_account` (conta que publica, default "diaria"). O
  // Worker valida tudo no enqueue — ver `validateReelsFields` em
  // workers/linkedin-cron/src/index.ts. Monte com `buildReelsQueuePayload`.
  media_type?: "REELS";
  video_url?: string;
  cover_url?: string;
  collaborators?: string[];
  ig_account?: "diaria" | "vjpixel";
  // #11724 — comentário que o Worker publica no post logo depois do
  // `media_publish` (só `channel: "instagram"`, post de imagem/carrossel). Hoje
  // só o 4º post (USE MELHOR) manda, com o permalink da edição. Fail-soft no
  // Worker: falha do comentário nunca derruba a publicação.
  first_comment?: string;
  // #8055 — documento PDF do LinkedIn (só `channel: "linkedin"`): URL https
  // pública que o Worker baixa no disparo e sobe pela Documents API, com o
  // título exigido pela Posts API. `image_urls` junto vira o fallback do
  // Worker (carrossel de imagens) se o documento falhar antes de o post existir.
  document_url?: string;
  document_title?: string;
  // #10906 — chave idempotente: o Worker deriva a key da fila dela, então o
  // MESMO POST repetido (retry do `postToWorkerQueue` depois de uma resposta
  // perdida) cai na mesma entry em vez de criar uma 2ª. Formato aceito:
  // `[A-Za-z0-9._:-]{1,128}` (IDEMPOTENCY_KEY_RE no Worker).
  idempotency_key?: string;
  // #11121/#10983 — repost e comentário como PÁGINA (só `channel: "linkedin"`,
  // API direta do LinkedIn no Worker). `repost` exige `target_post_urn`;
  // `comment` com `webhook_target: "diaria"` exige `target_post_urn` ou
  // `parent_scheduled_at`. Sem os segredos da página no Worker, o enqueue
  // recusa com `WorkerQueueError.code === "linkedin_creds_missing"`. Monte com
  // `scripts/lib/diaria/linkedin-page-actions.ts`.
  action?: "post" | "comment" | "repost";
  webhook_target?: "diaria" | "pixel";
  parent_destaque?: string;
  target_post_urn?: string;
  parent_scheduled_at?: string;
  // #10983 — abertura do D1: o Worker só comenta num post que contenha esse trecho.
  parent_text_hint?: string;
}

/**
 * #10823 — payload de Reels agendado pela fila do Worker. O Instagram não
 * agenda mídia pela Graph API; a fila publica no horário (`scheduled_at`).
 * `image_url` vai `null` (o Worker recusa imagem junto de REELS) e
 * `collaborators` vazio é omitido.
 */
export function buildReelsQueuePayload(input: {
  caption: string;
  videoUrl: string;
  coverUrl?: string;
  scheduledAt: string;
  account?: "diaria" | "vjpixel";
  collaborators?: string[];
  /** #10906 — ver `WorkerQueuePayload.idempotency_key`. */
  idempotencyKey?: string;
}): WorkerQueuePayload {
  return {
    text: input.caption,
    image_url: null,
    scheduled_at: input.scheduledAt,
    destaque: "shorts",
    channel: "instagram",
    media_type: "REELS",
    video_url: input.videoUrl,
    ...(input.coverUrl && { cover_url: input.coverUrl }),
    ...(input.collaborators && input.collaborators.length > 0 && { collaborators: input.collaborators }),
    ...(input.account && { ig_account: input.account }),
    ...(input.idempotencyKey && { idempotency_key: input.idempotencyKey }),
  };
}

/**
 * deleteFromWorkerQueue (#6607)
 *
 * Cliente para `DELETE /queue/:key` — usado por qualquer fluxo de
 * reagendamento ad-hoc que precisa remover uma entry já enfileirada antes
 * de re-enfileirar com novo horário/conteúdo.
 *
 * O Worker (`workers/linkedin-cron/src/index.ts` `handleQueueDelete`)
 * responde `404 { error: "key not found" }` quando a key já não existe —
 * seja porque o post já disparou (o cron deleta a entry após postar) seja
 * porque já foi cancelado/deletado antes. Achado ao vivo (#6607): um
 * reagendamento chamou DELETE, ignorou o status da resposta, e seguiu para
 * o re-enqueue mesmo quando o DELETE não achou a key — criando uma entry
 * DUPLICADA na fila (o post original já tinha disparado). Esta função
 * retorna `alreadyGone: true` em vez de lançar nesse caso, para que o
 * caller trate 404 como sinal de ABORTAR o re-enqueue (opção 2 da issue —
 * mais simples que adicionar um `GET /queue/:key` novo no Worker).
 *
 * `alreadyGone: true` NÃO é sucesso silencioso — o caller deve reportar
 * isto ao editor/log antes de decidir o que fazer (o post pode já ter sido
 * publicado, então reagendar de novo pode duplicar de outra forma se o
 * conteúdo for postado por outro canal).
 */
export async function deleteFromWorkerQueue(
  workerUrl: string,
  token: string,
  key: string,
  logPrefix = "worker-queue-client",
): Promise<{ deleted: boolean; alreadyGone: boolean; key: string }> {
  const deleteUrl = workerUrl.replace(/\/+$/, "") + "/queue/" + encodeURIComponent(key).replace(/%3A/g, ":");
  const res = await fetch(deleteUrl, {
    method: "DELETE",
    headers: { "X-Diaria-Token": token },
    signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
  });
  if (res.status === 404) {
    console.warn(
      `[${logPrefix}] DELETE ${key} → 404 (key not found — post já disparou ou já foi removido antes). ` +
        `Abortando re-enqueue para evitar entry duplicada.`,
    );
    return { deleted: false, alreadyGone: true, key };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Worker queue DELETE HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return { deleted: true, alreadyGone: false, key };
}

/** Resultado de `findWorkerQueueEntryByIdempotencyKey` (#12664). */
export type IdempotencyLookupResult =
  | { status: "found"; key: string }
  /** Toda tentativa leu a fila e nenhuma trouxe a chave. */
  | { status: "absent" }
  /** Alguma tentativa não conseguiu ler a fila: a ausência não está provada. */
  | { status: "error"; error: string };

export interface IdempotencyLookupOptions {
  /** Leituras de `GET /list`. Default 3: o KV leva ~20s pra listar uma entry nova (#6016). */
  maxAttempts?: number;
  /** Espera entre leituras (ms). Default 10000. */
  backoffMs?: number;
  /** Injetável pra teste. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * #12664 — procura na fila do Worker (`GET /list`) a entry de uma
 * `idempotency_key`. Usado depois de um POST que terminou em 5xx/timeout:
 * o Worker pode ter gravado a entry e perdido a resposta, e publicar por outro
 * caminho por cima duplicaria o post.
 *
 * `/list` sai do KV, que demora a listar uma entry recém-gravada; por isso a
 * leitura se repete. Achou em qualquer tentativa: `found`. `absent` só quando
 * TODAS as leituras deram certo e nenhuma trouxe a chave. Qualquer leitura com
 * erro devolve `error` (nunca lança): o caller não pode tratar isso como
 * ausência.
 */
export async function findWorkerQueueEntryByIdempotencyKey(
  workerUrl: string,
  token: string,
  idempotencyKey: string,
  opts: IdempotencyLookupOptions = {},
): Promise<IdempotencyLookupResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const listUrl = workerUrl.replace(/\/+$/, "") + "/list";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoffMs);
    try {
      const res = await fetch(listUrl, {
        headers: { "X-Diaria-Token": token },
        signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
      });
      if (!res.ok) {
        const body = await res.text();
        return { status: "error", error: `Worker /list HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const parsed = (await res.json()) as { items?: unknown };
      if (!Array.isArray(parsed.items)) {
        return { status: "error", error: "Worker /list sem `items` no corpo" };
      }
      for (const item of parsed.items as Array<Record<string, unknown>>) {
        if (item && item.idempotency_key === idempotencyKey && typeof item.key === "string") {
          return { status: "found", key: item.key };
        }
      }
    } catch (e) {
      return { status: "error", error: `Worker /list: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { status: "absent" };
}

/**
 * WorkerQueueError (#8303)
 *
 * Erro tipado lançado quando o Worker responde HTTP não-2xx a `POST /queue`.
 * Carrega `status` + `code` (opcional — o `code` machine-readable que o
 * Worker inclui no corpo JSON pra rejeições que o caller precisa distinguir
 * programaticamente, ex: `"linkedin_creds_missing"` — ver
 * `workers/linkedin-cron/src/index.ts::handleEnqueue`). Callers que só
 * precisam logar o erro continuam funcionando sem mudança (é um `Error`
 * normal); callers que precisam ramificar por causa (como
 * `publish-weekly-social.ts`, que em `linkedin_creds_missing` reenfileira só a
 * capa como imagem única via Make, em vez de marcar `"failed"`) checam `.code` em vez de fazer
 * parsing de string na mensagem — mais robusto a mudança de texto no Worker.
 */
export class WorkerQueueError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Corpo da resposta inteiro (a mensagem corta em 300 chars). #12661: o 409
   *  do enqueue idempotente traz `error` e `key` depois de uma `message` longa. */
  readonly body: string;

  constructor(status: number, body: string, code?: string) {
    super(`Worker queue HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "WorkerQueueError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function postToWorkerQueue(
  workerUrl: string,
  token: string,
  payload: WorkerQueuePayload,
  maxAttempts = 2,
  logPrefix = "worker-queue-client",
): Promise<{ queued: true; key: string; scheduled_at: string; destaque: string; duplicate?: boolean }> {
  const queueUrl = workerUrl.replace(/\/+$/, "") + "/queue";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(queueUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Diaria-Token": token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        // #8303 — extrai `code` do corpo JSON quando presente, pra callers
        // ramificarem sem parsear a mensagem de erro em prosa. Corpo não-JSON
        // (ou sem `code`) não é erro — cai pro WorkerQueueError sem code, que
        // qualquer caller já tratava como falha genérica antes desta mudança.
        let code: string | undefined;
        try {
          const parsed = JSON.parse(bodyText) as { code?: string };
          if (typeof parsed.code === "string") code = parsed.code;
        } catch {
          // corpo não é JSON — segue sem code
        }
        throw new WorkerQueueError(res.status, bodyText, code);
      }
      const text = await res.text();
      let parsed: ReturnType<typeof parseWorkerQueueResponse>;
      try {
        parsed = parseWorkerQueueResponse(JSON.parse(text));
      } catch (parseErr) {
        throw new Error(
          `Worker response inválido (schema ou JSON): ${text.slice(0, 200)} — ${(parseErr as Error).message}`,
        );
      }
      // #10906 — o Worker achou a entry da mesma `idempotency_key` (o POST
      // anterior foi gravado mesmo com a resposta perdida): sucesso, sem 2ª entry.
      if (parsed.duplicate === true) {
        console.error(`[${logPrefix}] worker: ${parsed.key} já estava na fila (idempotency_key) — reaproveitada, nada duplicado`);
      }
      return parsed as { queued: true; key: string; scheduled_at: string; destaque: string; duplicate?: boolean };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`[${logPrefix}] worker attempt ${attempt} failed: ${lastError.message}`);
      // #8303 — HTTP 4xx é rejeição de VALIDAÇÃO (payload/config inválidos p/
      // este request específico) — reenviar o MESMO payload não muda o
      // resultado, só atrasa o erro em CONFIG.timeouts.makeWebhook + 2s à
      // toa. Diferente de 5xx/timeout/rede, que são transitórios e o retry
      // já existia pra cobrir. Não muda o comportamento de erros não-HTTP
      // (rede, timeout, parse) — só de WorkerQueueError com status 4xx.
      const isClientError = e instanceof WorkerQueueError && e.status >= 400 && e.status < 500;
      if (attempt < maxAttempts && !isClientError) {
        await new Promise((r) => setTimeout(r, 2000));
      } else if (isClientError) {
        break;
      }
    }
  }
  throw lastError ?? new Error("worker_queue_failed");
}
