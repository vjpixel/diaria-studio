import type { Env, QueueEntry, WebhookTarget, QueueAction, ReelsContainerRef } from "./index";
import { FETCH_TIMEOUT_MS, CAROUSEL_MAX_ITEMS } from "./index";
import { isUnsupportedCommentTarget } from "./guards";

// ── Dispatch compartilhado entre fire.ts (cron) e durable-object.ts (alarm) ──
//
// (#3817) Antes desta extração, a lógica de "disparar o webhook e interpretar
// o resultado" vivia duplicada em fire.ts e durable-object.ts — cada um com
// sua própria cópia do fetch + interpretação de erro. Ao adicionar o canal
// Instagram, duplicar o branch de novo (2 cópias de fireInstagram) repetiria
// o mesmo problema. fireQueueEntry() é chamado por AMBOS os caminhos — cada
// caller só resolve o `FireConfig` a partir do seu próprio contexto (env do
// Worker no cron; payload persistido no DO storage no alarm) e delega a
// decisão "linkedin vs instagram" + o fetch em si pra cá.
//
// A MECÂNICA de mover pra DLQ/incrementar retry continua local a cada
// caller (fire.ts tem acesso a KV; durable-object.ts só libera o claim e
// deixa o cron aplicar o mesmo guard puro na próxima rodada — mesmo padrão
// já usado por isUnsupportedCommentTarget, ver guards.ts).

export interface InstagramCreds {
  igUserId: string;
  accessToken: string;
  apiVersion: string;
}

// #3944 Parte B
export interface ThreadsCreds {
  userId: string;
  accessToken: string;
  apiVersion: string;
}

/**
 * #8052 — credenciais da API DIRETA do LinkedIn (Images API + Posts API),
 * usadas só pelo caminho carrossel (`fireLinkedInCarousel`). O post
 * single-image continua indo pelo webhook Make (`fireLinkedIn`) — estas
 * credenciais NÃO substituem `MAKE_WEBHOOK_URL`, só habilitam o caminho
 * novo quando a entry carrega `image_urls` com mais de 1 item (ver #8050,
 * que documentou o gap, e #8052, que decide resolvê-lo via API direta em
 * vez de módulo multi-imagem no Make).
 */
export interface LinkedInCreds {
  accessToken: string;
  /** URN do autor do post — página da empresa (`urn:li:organization:{id}`)
   * ou perfil pessoal (`urn:li:person:{id}`). Mesmo URN serve de `owner` no
   * upload de imagem (Images API) e de `author` no post (Posts API). */
  authorUrn: string;
  /** Header `LinkedIn-Version` (formato YYYYMM) exigido por toda chamada às
   * APIs REST versionadas do LinkedIn (Images API + Posts API). */
  apiVersion: string;
}

/** Credenciais/URLs resolvidas pelo caller (fire.ts via env; durable-object.ts via DO payload). */
export interface FireConfig {
  webhookUrl: string;
  pixelWebhookUrl?: string;
  /** #3903 — MAKE_WEBHOOK_API_KEY, enviado como header `x-make-apikey` em todo
   * POST ao webhook Make (diaria ou pixel). Undefined = header omitido
   * (migração incremental, scenario Make ainda sem auth configurada). */
  apiKey?: string;
  instagram?: InstagramCreds;
  /** #10823 — 2ª conta do Instagram (vinculada à página VJ pixel), usada por
   * entries com `ig_account: "vjpixel"`. */
  instagramVjpixel?: InstagramCreds;
  threads?: ThreadsCreds;
  /** #8052 — credenciais da API direta do LinkedIn, só pro caminho carrossel. */
  linkedin?: LinkedInCreds;
  /** #10823 — intervalo entre polls do container de Reels (ms). Só os testes
   * passam; produção usa `REELS_POLL_INTERVAL_MS`. */
  reelsPollIntervalMs?: number;
  /** #10856 — teto total do poll do Reels (ms). Só os testes passam;
   * produção usa `REELS_POLL_DEADLINE_MS`. */
  reelsPollDeadlineMs?: number;
}

export type FireOutcome =
  | { status: "fired" }
  /** Falha transitória — caller deve incrementar retry_count (ou, no caso do
   *  DO, apenas liberar o claim pro cron tentar de novo). */
  /** `reelsContainer` (#10922): container de Reels a retomar na próxima volta
   *  — o caller grava na entry (`reels_container`). Ausente numa falha de Reels
   *  = não há container retomável (a próxima volta cria outro). */
  | { status: "failed"; reason: string; reelsContainer?: ReelsContainerRef }
  /** Falha de configuração/guard — não adianta re-tentar. Caller escreve DLQ
   *  direto (fire.ts) ou libera o claim sem postar (durable-object.ts, que
   *  não tem acesso a KV — o cron aplica o MESMO guard puro na próxima volta
   *  e escreve o DLQ). */
  | { status: "dlq"; reason: string }
  /** #11106 — resposta AMBÍGUA do passo que publica (`threads_publish`:
   *  timeout/rede, 5xx, 2xx sem `id` ou com corpo ilegível): a Meta pode ter
   *  publicado. Nunca volta à fila — nem pelo `retry_count` do cron, nem pelo
   *  release do claim do alarm (que deixaria o cron refazer). Os dois caminhos
   *  marcam o DO como disparado (o alarm não refaz) e a entry vai pra DLQ com
   *  `last_error` começando por `send_unknown:` — o editor confere o perfil. */
  | { status: "send_unknown"; reason: string };

/** #11106 — prefixo do `last_error` na DLQ para envio ambíguo. */
export const SEND_UNKNOWN_PREFIX = "send_unknown:";

/**
 * Resolve o `Env` do Worker pras credenciais Instagram, com default de
 * apiVersion (#3817). Retorna `undefined` se qualquer credencial obrigatória
 * estiver ausente — chamado tanto no enqueue (pra persistir no DO payload)
 * quanto no fire (cron path, que lê direto do env).
 */
export function resolveInstagramCreds(env: Env): InstagramCreds | undefined {
  if (!env.INSTAGRAM_BUSINESS_ACCOUNT_ID || !env.INSTAGRAM_ACCESS_TOKEN) return undefined;
  return {
    igUserId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
    accessToken: env.INSTAGRAM_ACCESS_TOKEN,
    apiVersion: env.INSTAGRAM_API_VERSION || "v25.0",
  };
}

/**
 * #10823 — credenciais da 2ª conta do Instagram (a vinculada à página VJ
 * pixel, publicando com o token dessa página). Mesma versão de API da conta
 * da diar.ia.br. `undefined` se qualquer uma faltar — o enqueue recusa
 * entries `ig_account: "vjpixel"` nesse caso, e o disparo cai em DLQ.
 */
export function resolveInstagramVjpixelCreds(env: Env): InstagramCreds | undefined {
  if (!env.INSTAGRAM_VJPIXEL_ACCOUNT_ID || !env.INSTAGRAM_VJPIXEL_ACCESS_TOKEN) return undefined;
  return {
    igUserId: env.INSTAGRAM_VJPIXEL_ACCOUNT_ID,
    accessToken: env.INSTAGRAM_VJPIXEL_ACCESS_TOKEN,
    apiVersion: env.INSTAGRAM_API_VERSION || "v25.0",
  };
}

/**
 * Resolve o `Env` do Worker pras credenciais Threads, com default de
 * apiVersion (#3944 Parte B). Retorna `undefined` se qualquer credencial
 * obrigatória estiver ausente — mesmo padrão de resolveInstagramCreds acima.
 */
export function resolveThreadsCreds(env: Env): ThreadsCreds | undefined {
  if (!env.THREADS_ACCESS_TOKEN || !env.THREADS_USER_ID) return undefined;
  return {
    userId: env.THREADS_USER_ID,
    accessToken: env.THREADS_ACCESS_TOKEN,
    apiVersion: env.THREADS_API_VERSION || "v1.0",
  };
}

/**
 * Resolve o `Env` do Worker pras credenciais da API direta do LinkedIn
 * (#8052), com default de apiVersion. Retorna `undefined` se qualquer
 * credencial obrigatória estiver ausente — mesmo padrão de
 * resolveInstagramCreds/resolveThreadsCreds acima. Ausência não afeta o
 * caminho single-image (webhook Make, `fireLinkedIn`) — só desabilita o
 * carrossel, que cai em `dlq` com motivo claro (ver `fireQueueEntry`).
 */
export function resolveLinkedInCreds(env: Env): LinkedInCreds | undefined {
  if (!env.LINKEDIN_ACCESS_TOKEN || !env.LINKEDIN_AUTHOR_URN) return undefined;
  return {
    accessToken: env.LINKEDIN_ACCESS_TOKEN,
    authorUrn: env.LINKEDIN_AUTHOR_URN,
    apiVersion: env.LINKEDIN_API_VERSION || "202401",
  };
}

/**
 * Dispara o post do LinkedIn via webhook Make.com (lógica idêntica à que
 * existia inline em fire.ts/durable-object.ts antes da extração #3817).
 *
 * `apiKey` (#3903): quando presente, enviado como header `x-make-apikey` —
 * reativa o `authenticationMethod` que o scenario Make ANTERIOR (2270381) já
 * tinha. Ausente = header omitido (migração incremental, sem auth ainda).
 */
async function fireLinkedIn(entry: QueueEntry, webhookUrl: string, apiKey?: string): Promise<FireOutcome> {
  const action: QueueAction = entry.action ?? "post";
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-make-apikey": apiKey } : {}),
      },
      body: JSON.stringify({
        text: entry.text,
        image_url: entry.image_url,
        scheduled_at: entry.scheduled_at,
        destaque: entry.destaque,
        action,
        ...(entry.parent_destaque !== undefined && { parent_destaque: entry.parent_destaque }),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) return { status: "fired" };
    const body = await res.text();
    return { status: "failed", reason: `Make webhook HTTP ${res.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { status: "failed", reason: `fetch timeout after ${FETCH_TIMEOUT_MS}ms` };
    }
    return { status: "failed", reason: `fetch failed: ${err.message}` };
  }
}

/**
 * (#4153) Resolve a lista de imagens efetiva de uma entry: `image_urls` tem
 * prioridade quando presente e não-vazia (carrossel OU single-via-lista);
 * cai pra `image_url` singular quando `image_urls` está ausente (entries
 * legadas — mesma disciplina de backward-compat do `channel` ausente,
 * #3817). Array vazio nunca é gravado pelo enqueue (handleEnqueue rejeita),
 * mas o fallback pra `image_url` cobre esse edge case defensivamente mesmo
 * assim.
 */
function resolveImageUrls(entry: QueueEntry): string[] {
  if (entry.image_urls && entry.image_urls.length > 0) return entry.image_urls;
  if (entry.image_url) return [entry.image_url];
  return [];
}

/**
 * Dispara um carrossel no LinkedIn via API DIRETA (Images API + Posts API,
 * `api.linkedin.com/rest/*`) — #8052, resolve o gap identificado no #8050
 * (`fireLinkedIn` só encaminha `image_url` singular ao Make.com, nunca leu
 * `image_urls`). Decisão do editor: API direta, sem depender de um módulo
 * multi-imagem no scenario Make (opção 2 do #8050, descartada).
 *
 * Fluxo de 2 fases da API REST do LinkedIn:
 *   1. Por imagem (N vezes, na ordem da lista):
 *      a. `POST /rest/images?action=initializeUpload` com `owner=authorUrn`
 *         → devolve `{ value: { uploadUrl, image } }` (`image` é o URN da
 *         imagem, usado no post; `uploadUrl` é uma URL pré-assinada,
 *         válida por tempo limitado).
 *      b. Buscar os BYTES da imagem hospedada (`imageUrl`, já pública —
 *         mesmo asset servido pro Instagram/Facebook/Threads) e fazer PUT
 *         pra `uploadUrl` — diferente da Graph API do Instagram/Facebook
 *         (que aceita `image_url` direto), a Images API do LinkedIn exige
 *         upload de bytes, não uma URL de origem.
 *   2. `POST /rest/posts` com `author=authorUrn`, `commentary=caption` e
 *      `content.multiImage.images[]` (1 entry por URN de imagem, na MESMA
 *      ordem em que foram enviadas) — publica direto (`lifecycleState:
 *      "PUBLISHED"`), sem rascunho intermediário.
 *
 * Falha parcial: mesma política do carrossel Instagram (`fireInstagramCarousel`)
 * — qualquer passo que falhar aborta o post inteiro, outcome SEMPRE "dlq",
 * nunca "failed"/retriable. Publicar um carrossel incompleto (ou reprocessar
 * do zero a cada ciclo de retry, recriando uploads já feitos) é pior que não
 * publicar.
 *
 * Headers exigidos em toda chamada REST do LinkedIn: `Authorization: Bearer
 * {token}`, `LinkedIn-Version: {apiVersion}` (formato YYYYMM) e
 * `X-Restli-Protocol-Version: 2.0.0`.
 */
async function fireLinkedInCarousel(imageUrls: string[], caption: string, creds: LinkedInCreds): Promise<FireOutcome> {
  // Defesa em profundidade — mesmo padrão de fireInstagramCarousel: o enqueue
  // (handleEnqueue) já barra >CAROUSEL_MAX_ITEMS, isto cobre entries
  // legacy/inseridas fora do caminho normal.
  if (imageUrls.length > CAROUSEL_MAX_ITEMS) {
    return {
      status: "dlq",
      reason: `LinkedIn carrossel: ${imageUrls.length} imagens excede o máximo de ${CAROUSEL_MAX_ITEMS} itens`,
    };
  }

  const restHeaders = {
    Authorization: `Bearer ${creds.accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": creds.apiVersion,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  const imageUrns: string[] = [];

  // Fase 1: por imagem — initializeUpload, buscar bytes, PUT pra uploadUrl.
  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];

    let uploadUrl: string;
    let imageUrn: string;
    try {
      const initRes = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
        method: "POST",
        headers: restHeaders,
        body: JSON.stringify({ initializeUploadRequest: { owner: creds.authorUrn } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await initRes.text();
      let data: { value?: { uploadUrl?: string; image?: string }; message?: string };
      try {
        data = JSON.parse(text);
      } catch {
        return {
          status: "dlq",
          reason: `LinkedIn carrossel: initializeUpload ${i + 1}/${imageUrls.length} resposta não-JSON: HTTP ${initRes.status}: ${text.slice(0, 200)} (URNs já obtidos: ${imageUrns.length})`,
        };
      }
      if (!initRes.ok || !data.value?.uploadUrl || !data.value?.image) {
        return {
          status: "dlq",
          reason: `LinkedIn carrossel: initializeUpload ${i + 1}/${imageUrls.length} falhou: HTTP ${initRes.status}: ${data.message ?? text.slice(0, 200)} (URNs já obtidos: ${imageUrns.length})`,
        };
      }
      uploadUrl = data.value.uploadUrl;
      imageUrn = data.value.image;
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        status: "dlq",
        reason: `LinkedIn carrossel: initializeUpload ${i + 1}/${imageUrls.length} fetch ${timeout ? "timeout" : "failed"}: ${err.message} (URNs já obtidos: ${imageUrns.length})`,
      };
    }

    let imageBytes: ArrayBuffer;
    try {
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!imgRes.ok) {
        return {
          status: "dlq",
          reason: `LinkedIn carrossel: fetch da imagem ${i + 1}/${imageUrls.length} (${imageUrl}) falhou: HTTP ${imgRes.status} (URNs já obtidos: ${imageUrns.length})`,
        };
      }
      imageBytes = await imgRes.arrayBuffer();
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        status: "dlq",
        reason: `LinkedIn carrossel: fetch da imagem ${i + 1}/${imageUrls.length} (${imageUrl}) ${timeout ? "timeout" : "failed"}: ${err.message} (URNs já obtidos: ${imageUrns.length})`,
      };
    }

    try {
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        body: imageBytes,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!putRes.ok) {
        const body = await putRes.text();
        return {
          status: "dlq",
          reason: `LinkedIn carrossel: upload da imagem ${i + 1}/${imageUrls.length} falhou: HTTP ${putRes.status}: ${body.slice(0, 200)} (URNs já obtidos: ${imageUrns.length})`,
        };
      }
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        status: "dlq",
        reason: `LinkedIn carrossel: upload da imagem ${i + 1}/${imageUrls.length} fetch ${timeout ? "timeout" : "failed"}: ${err.message} (URNs já obtidos: ${imageUrns.length})`,
      };
    }

    imageUrns.push(imageUrn);
  }

  // Fase 2: criar o post com content.multiImage.images (ordem preservada).
  try {
    const postRes = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({
        author: creds.authorUrn,
        commentary: caption,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: {
          multiImage: {
            images: imageUrns.map((id) => ({ id })),
          },
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (postRes.status === 201 || postRes.ok) return { status: "fired" };
    const body = await postRes.text();
    return {
      status: "dlq",
      reason: `LinkedIn carrossel: POST /rest/posts falhou: HTTP ${postRes.status}: ${body.slice(0, 200)} (images=${imageUrns.join(",")})`,
    };
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      status: "dlq",
      reason: `LinkedIn carrossel: POST /rest/posts fetch ${timeout ? "timeout" : "failed"}: ${err.message} (images=${imageUrns.join(",")})`,
    };
  }
}

/**
 * Dispara o post do Instagram via Graph API direta (#3817 — sem Make, a API
 * do Instagram é aberta e o Make não agregaria nada, só herdaria limitações
 * de conector). Ponto de entrada único do canal Instagram — despacha pro
 * caminho single-image (#3817, inalterado) ou carrossel (#4153) conforme a
 * contagem de imagens resolvida por `resolveImageUrls`.
 */
async function fireInstagram(
  entry: QueueEntry,
  creds: InstagramCreds,
  reelsPollIntervalMs?: number,
  reelsPollDeadlineMs?: number,
): Promise<FireOutcome> {
  if (entry.media_type === "REELS") {
    return fireInstagramReels(
      entry,
      creds,
      reelsPollIntervalMs ?? REELS_POLL_INTERVAL_MS,
      reelsPollDeadlineMs ?? REELS_POLL_DEADLINE_MS,
    );
  }
  const images = resolveImageUrls(entry);
  if (images.length === 0) {
    return { status: "dlq", reason: "image_url ausente — Instagram Graph API exige imagem" };
  }
  if (images.length === 1) {
    return fireInstagramSingle(images[0], entry.text, creds);
  }
  return fireInstagramCarousel(images, entry.text, creds);
}

/**
 * Sequência de 2 passos (idêntica a scripts/publish-instagram.ts):
 *   (1) POST /{ig-user-id}/media          → cria media container
 *   (2) POST /{ig-user-id}/media_publish   → publica o container
 *
 * O container expira em 24h — por isso os 2 passos rodam INTEIROS no momento
 * do disparo (nunca no momento do agendamento). Entre os 2 passos, faz um
 * poll best-effort e limitado do `status_code` do container (imagem única
 * normalmente fica FINISHED de imediato; o poll é só uma rede de segurança
 * contra o raro IN_PROGRESS — nunca bloqueia mais que ~3s).
 *
 * (#4153) Extraída de `fireInstagram` sem alteração de lógica — só passou a
 * receber `imageUrl`/`caption` como parâmetros em vez de ler `entry.image_url`/
 * `entry.text` diretamente, pra ser reusável tanto pro caminho `image_url`
 * legado quanto pro caminho `image_urls` com 1 item só.
 */
async function fireInstagramSingle(imageUrl: string, caption: string, creds: InstagramCreds): Promise<FireOutcome> {
  const base = `https://graph.facebook.com/${creds.apiVersion}`;

  // Passo 1: criar media container
  let containerId: string;
  try {
    const params = new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.igUserId}/media`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return { status: "failed", reason: `Instagram /media resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!res.ok || data.error) {
      return {
        status: "failed",
        reason: `Instagram /media HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`,
      };
    }
    if (!data.id) {
      return { status: "failed", reason: `Instagram /media sem id: ${text.slice(0, 200)}` };
    }
    containerId = data.id;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return { status: "failed", reason: `Instagram /media fetch ${timeout ? "timeout" : "failed"}: ${err.message}` };
  }

  // Passo 1.5: poll best-effort do status_code — até 2 tentativas extras,
  // 1.5s de intervalo (nunca bloqueia mais que ~3s). Imagem única costuma
  // ficar FINISHED de imediato; isto é rede de segurança, não o caminho comum.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Token vai no header Authorization, nunca na query string (#7779).
      const statusRes = await fetch(`${base}/${containerId}?fields=status_code`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as { status_code?: string };
        if (statusData.status_code === "FINISHED") break;
        if (statusData.status_code === "ERROR") {
          return { status: "failed", reason: `Instagram container status_code=ERROR (container_id=${containerId})` };
        }
      }
    } catch {
      // best-effort — segue pro publish mesmo sem confirmar o status
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Passo 2: publicar o container
  try {
    const params = new URLSearchParams({
      creation_id: containerId,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.igUserId}/media_publish`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return {
        status: "failed",
        reason: `Instagram /media_publish resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (container_id=${containerId})`,
      };
    }
    if (!res.ok || data.error) {
      return {
        status: "failed",
        reason: `Instagram /media_publish HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (container_id=${containerId})`,
      };
    }
    if (!data.id) {
      return { status: "failed", reason: `Instagram /media_publish sem id: ${text.slice(0, 200)} (container_id=${containerId})` };
    }
    return { status: "fired" };
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      status: "failed",
      reason: `Instagram /media_publish fetch ${timeout ? "timeout" : "failed"}: ${err.message} (container_id=${containerId})`,
    };
  }
}

/** Nº máximo de tentativas de poll do status de um container Instagram
 * (carrossel) antes de desistir (fail-closed) — #7630. Mesmos valores do
 * poll OBRIGATÓRIO de Threads (`THREADS_POLL_MAX_ATTEMPTS`, #5348) — mantido
 * como constante separada (não reaproveitada) pra permitir ajuste
 * independente por plataforma sem risco de efeito colateral cruzado. */
const IG_POLL_MAX_ATTEMPTS = 10;
/** Intervalo entre tentativas de poll (ms) — #7630. Mesmo racional de
 * `THREADS_POLL_INTERVAL_MS`. */
const IG_POLL_INTERVAL_MS = 2000;

/**
 * Faz polling do status de UM container Instagram (filho de carrossel ou
 * pai) até `status_code=FINISHED`, `ERROR`, ou esgotar `IG_POLL_MAX_ATTEMPTS`
 * — #7630, causa raiz confirmada da #7626.
 *
 * Mesmo padrão de `pollThreadsContainerStatus` acima (#5348) — a diferença
 * de campo é só nomenclatura da Graph API: Instagram usa `status_code`
 * (`FINISHED`/`IN_PROGRESS`/`ERROR`/`EXPIRED`), Threads usa `status`. Falha
 * TRANSITÓRIA (fetch/HTTP/parse) consome o orçamento de tentativas em vez de
 * abortar na 1ª (mesma correção do #5348 self-review); só `ERROR`/`EXPIRED`
 * — sinal real e informativo da própria API — aborta imediato como
 * `permanent: true`.
 *
 * Motivado por erro real capturado ao vivo (reprocessamento manual, achado
 * #7630): `HTTP 400 code=9007 subcode=2207027 "Media ID is not available...
 * please wait for a moment"` — o carrossel criava os N containers filhos e
 * chamava `media_publish` do pai IMEDIATAMENTE, sem esperar a Graph API
 * terminar de processar a mídia (transcodificação assíncrona) — uma race
 * condition transitória que o desenho anterior tratava como falha permanente
 * (`dlq` instantâneo, #4153, sem nenhum retry), matando o carrossel inteiro
 * por um blip que se resolveria sozinho em poucos segundos.
 */
async function pollInstagramContainerStatus(
  base: string,
  containerId: string,
  accessToken: string,
  // #10823 — Reels transcodifica por minutos, não segundos: o caminho de
  // vídeo passa um orçamento maior. Defaults = comportamento do carrossel.
  maxAttempts: number = IG_POLL_MAX_ATTEMPTS,
  intervalMs: number = IG_POLL_INTERVAL_MS,
  // #10856 self-review — teto TOTAL de tempo de parede do poll (ms). Contar
  // tentativas não basta: cada fetch pode levar até FETCH_TIMEOUT_MS, e o pior
  // caso do Reels (36 × (30 s + 5 s)) passaria de 20 min, muito acima do
  // CLAIM_TTL_MS da fila — com o claim expirado, outra volta re-dispararia a
  // mesma entry e o Reels sairia em dobro. Undefined = sem teto (carrossel,
  // cujo pior caso já cabe no TTL).
  deadlineMs?: number,
  // #10954 self-review — container RETOMADO de uma volta anterior: a Graph
  // recusando a consulta com 4xx não transitório N vezes seguidas significa
  // container desconhecido/inválido, não blip. O poll para e devolve
  // `unknownContainer: true` pra o caller descartar o container. Undefined =
  // 4xx segue transitório (container recém-criado, carrossel).
  abortAfterConsecutiveClientErrors?: number,
): Promise<
  | { ok: true }
  | { ok: false; reason: string; permanent: boolean; statusCode?: "ERROR" | "EXPIRED"; unknownContainer?: true }
> {
  let consecutiveClientErrors = 0;
  const deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
  const remaining = () => deadline - Date.now();
  const deadlineExceeded = () => ({
    ok: false as const,
    permanent: false,
    reason:
      `Instagram container não ficou FINISHED dentro do teto total de ` +
      `${Math.round((deadlineMs ?? 0) / 1000)}s do poll — container_id=${containerId}, ` +
      `fail-closed (não publica, retry normal).`,
  });
  const waitBeforeNext = async (attempt: number) => {
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(intervalMs, remaining()))));
    }
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (remaining() <= 0) return deadlineExceeded();
    try {
      // Token vai no header Authorization, nunca na query string (#7779).
      const res = await fetch(`${base}/${containerId}?fields=status_code`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        // O timeout do fetch nunca passa do que resta do teto total.
        signal: AbortSignal.timeout(Math.max(1, Math.min(FETCH_TIMEOUT_MS, remaining()))),
      });
      const text = await res.text();
      let data: { status_code?: string; error?: GraphErrorBody };
      try {
        data = JSON.parse(text);
      } catch {
        console.warn(
          `[instagram-poll] resposta não-JSON na tentativa ${attempt}/${maxAttempts} (container_id=${containerId}): HTTP ${res.status}: ${text.slice(0, 200)} — tratado como transitório, tentando de novo.`,
        );
        await waitBeforeNext(attempt);
        continue;
      }
      if (!res.ok || data.error) {
        const clientError = res.status >= 400 && res.status < 500 && res.status !== 429
          && !isGraphTransientError(data.error);
        consecutiveClientErrors = clientError ? consecutiveClientErrors + 1 : 0;
        if (
          clientError &&
          abortAfterConsecutiveClientErrors !== undefined &&
          consecutiveClientErrors >= abortAfterConsecutiveClientErrors
        ) {
          return {
            ok: false,
            permanent: false,
            unknownContainer: true,
            reason:
              `Instagram container recusado pela Graph (HTTP ${res.status} em ${consecutiveClientErrors} consultas seguidas): ` +
              `${data.error?.message ?? text.slice(0, 200)} (container_id=${containerId})`,
          };
        }
        console.warn(
          `[instagram-poll] HTTP ${res.status} na tentativa ${attempt}/${maxAttempts} (container_id=${containerId}): ${data.error?.message ?? text.slice(0, 200)} — tratado como transitório, tentando de novo.`,
        );
        await waitBeforeNext(attempt);
        continue;
      }
      consecutiveClientErrors = 0;
      if (data.status_code === "FINISHED") return { ok: true };
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        return {
          ok: false,
          permanent: true,
          statusCode: data.status_code,
          reason: `Instagram container status_code=${data.status_code} (container_id=${containerId})`,
        };
      }
      // IN_PROGRESS (ou estado transitório desconhecido) — segue tentando.
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      console.warn(
        `[instagram-poll] fetch ${timeout ? "timeout" : "failed"} na tentativa ${attempt}/${maxAttempts} (container_id=${containerId}): ${err.message} — tratado como transitório, tentando de novo.`,
      );
    }
    await waitBeforeNext(attempt);
  }
  if (remaining() <= 0) return deadlineExceeded();
  return {
    ok: false,
    permanent: false,
    reason:
      `Instagram container nunca ficou FINISHED após ${maxAttempts} tentativas ` +
      `(~${Math.round((maxAttempts * intervalMs) / 1000)}s) — ` +
      `container_id=${containerId}, fail-closed (não publica).`,
  };
}

/** #10823 — orçamento do poll do container de Reels: 36 × 5s = 3 min. O
 * vídeo é transcodificado de forma assíncrona pela Graph API (minutos, não os
 * segundos de uma imagem). Cabe no limite de tempo de parede do alarm do DO e
 * do cron. Esgotar NÃO é DLQ: vira `failed` e o retry normal cria um container
 * novo na próxima volta (container não publicado não aparece pra ninguém). */
export const REELS_POLL_MAX_ATTEMPTS = 36;

/** #10954 self-review — consultas de status do container RETOMADO que a Graph
 * recusa com 4xx (exceto 429) em sequência antes de o container ser dado como
 * desconhecido e descartado. 3, e não 1, pra um 400 isolado não jogar fora um
 * container que ainda processava. */
export const REELS_RESUMED_CONTAINER_MAX_CLIENT_ERRORS = 3;
export const REELS_POLL_INTERVAL_MS = 5000;
/** #10856 self-review — teto TOTAL de tempo de parede do poll do Reels.
 * Somado ao fetch de criação do container e ao de `media_publish` (até
 * `FETCH_TIMEOUT_MS` cada) e às 2 consultas de dedup do #10877 (até
 * `REELS_VERIFY_FETCH_TIMEOUT_MS` cada), o disparo inteiro fica em ≤4,5 min,
 * abaixo do `CLAIM_TTL_MS` (5 min) da fila — o claim nunca expira com o 1º
 * disparo ainda em andamento, então outra volta não re-dispara o mesmo Reels.
 * Estouro = `failed` sem publicar (retry normal cria container novo).
 * #10877: baixou de 210 s pra 190 s pra abrir espaço às consultas de dedup. */
export const REELS_POLL_DEADLINE_MS = 190_000;

/** #10877 — timeout de cada consulta de dedup (lista de mídias da conta antes
 * de criar o container; `status_code` do container depois de um
 * `media_publish` que falhou). Menor que `FETCH_TIMEOUT_MS` pra caber no
 * `CLAIM_TTL_MS` junto com o resto do disparo. */
export const REELS_VERIFY_FETCH_TIMEOUT_MS = 10_000;

/** #10877 — janela da busca por Reels já publicado: mídias da conta com
 * legenda idêntica publicadas a partir de `scheduled_at - 24h`. */
export const REELS_DEDUP_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** #10877 — quantas mídias recentes da conta a busca de dedup lê. */
const REELS_DEDUP_MEDIA_LIMIT = 25;

/** Corpo de `error` da Graph API (só os campos que a classificação usa). */
export interface GraphErrorBody {
  message?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
}

/**
 * #10992 — códigos de limite de taxa da Graph API (doc "Rate Limiting" /
 * "Error codes" da Meta): 4 (app), 17 (usuário), 32 (página), 613 (limite
 * customizado) e 80000-80014 (Business Use Case — 80002 é o do Instagram).
 * Chegam com HTTP 400/403, não 429.
 */
export const GRAPH_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  4, 17, 32, 613,
  ...Array.from({ length: 15 }, (_, i) => 80000 + i),
]);

/**
 * #10992 — erro da Graph que passa sozinho: limite de taxa
 * (`GRAPH_RATE_LIMIT_CODES`) ou `is_transient: true` declarado pela própria
 * Meta. Independe do status HTTP (os limites vêm como 400/403).
 */
export function isGraphTransientError(error: GraphErrorBody | undefined | null): boolean {
  if (!error || typeof error !== "object") return false;
  if (error.is_transient === true) return true;
  return typeof error.code === "number" && GRAPH_RATE_LIMIT_CODES.has(error.code);
}

export type ReelLookup =
  | { kind: "found"; mediaId: string }
  | { kind: "absent" }
  /** Não deu pra consultar. `transient` = vale tentar de novo na próxima volta
   * (5xx, 429, limite de taxa da Graph em 400/403, timeout, resposta
   * ilegível — #10992); `false` = recusa definitiva da Graph (demais 4xx). */
  | { kind: "unverifiable"; reason: string; transient: boolean };

/**
 * #10877 — procura, entre as mídias recentes da conta, um Reels com a MESMA
 * legenda publicado a partir de `sinceMs`. É a defesa contra o Reels em dobro:
 * se uma volta anterior chamou `/media_publish`, estourou o tempo (ou caiu) e
 * a Meta publicou mesmo assim, o resultado foi `failed` e a fila re-tenta. O
 * id do container daquela volta não sobrevive (o caminho do alarm do DO não
 * grava nada no KV), então a prova de "já saiu" tem que vir da própria conta.
 *
 * Legenda idêntica é a identidade: a do Reels diário carrega o link da edição
 * com UTM, e um Reels manual com a mesma legenda (ex.: `publish-shorts.ts
 * --now`) também é duplicata. Timestamp ilegível conta como dentro da janela
 * (na dúvida, não publica de novo).
 */
export async function findPublishedReel(
  base: string,
  creds: InstagramCreds,
  caption: string,
  sinceMs: number,
): Promise<ReelLookup> {
  try {
    const fields = "id,caption,timestamp,media_product_type";
    // Token no header Authorization, nunca na query string (#7779).
    const res = await fetch(`${base}/${creds.igUserId}/media?fields=${fields}&limit=${REELS_DEDUP_MEDIA_LIMIT}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(REELS_VERIFY_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: {
      data?: Array<{ id?: string; caption?: string; timestamp?: string; media_product_type?: string }>;
      error?: GraphErrorBody;
    };
    try {
      data = JSON.parse(text);
    } catch {
      return { kind: "unverifiable", transient: true, reason: `lista de mídias resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!res.ok || data.error) {
      return {
        kind: "unverifiable",
        // #10992 item 3: limite de taxa da Graph chega como 400/403 com
        // `error.code` 4/17/32/613/80000-80014 — é transitório (passa sozinho),
        // não recusa definitiva; tratar como 4xx fazia publicar SEM a busca
        // prévia justo na volta de retry, quando o dedup importa.
        transient: res.status >= 500 || res.status === 429 || isGraphTransientError(data.error),
        reason: `lista de mídias HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`,
      };
    }
    if (!Array.isArray(data.data)) {
      return { kind: "unverifiable", transient: true, reason: `lista de mídias sem \`data\`: ${text.slice(0, 200)}` };
    }
    const want = caption.trim();
    for (const m of data.data) {
      if (!m?.id || (m.caption ?? "").trim() !== want) continue;
      if (m.media_product_type && m.media_product_type !== "REELS") continue;
      const ts = Date.parse(m.timestamp ?? "");
      if (!Number.isNaN(ts) && ts < sinceMs) continue;
      return { kind: "found", mediaId: m.id };
    }
    return { kind: "absent" };
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return { kind: "unverifiable", transient: true, reason: `lista de mídias fetch ${timeout ? "timeout" : "failed"}: ${err.message}` };
  }
}

/**
 * #10877 — depois de um `/media_publish` que falhou (timeout, queda, resposta
 * ilegível, erro), confere o `status_code` do container: `PUBLISHED` quer dizer
 * que a Meta publicou apesar da falha — é sucesso, não retry. Qualquer outra
 * resposta (inclusive erro na consulta) devolve `false` e o caller segue com o
 * `failed`; a busca por legenda no início da próxima volta é a 2ª rede.
 */
async function containerWasPublished(base: string, containerId: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/${containerId}?fields=status_code`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REELS_VERIFY_FETCH_TIMEOUT_MS),
    });
    const data = JSON.parse(await res.text()) as { status_code?: string };
    return res.ok && data.status_code === "PUBLISHED";
  } catch {
    return false;
  }
}

/**
 * Dispara um Reels agendado (#10823) — fluxo da Graph API com vídeo por URL:
 *   1. POST /{ig-user-id}/media com `media_type=REELS`, `video_url` (público,
 *      a Graph baixa), `caption`, `share_to_feed=true` e, se houver,
 *      `collaborators` (lista JSON — cada conta aceita o convite no app).
 *   2. Poll OBRIGATÓRIO do `status_code` até FINISHED (mesmo helper do
 *      carrossel, #7630, com orçamento de vídeo). ERROR/EXPIRED = DLQ (o vídeo
 *      não serve; re-tentar com o mesmo arquivo dá o mesmo erro).
 *   3. POST /{ig-user-id}/media_publish.
 *
 * Diferente de `publish-shorts.ts` (upload resumable do binário local), aqui o
 * vídeo já precisa estar numa URL pública no disparo — o Worker não tem o
 * arquivo. Falhas transitórias (HTTP/fetch/poll esgotado) são `failed`
 * (retry normal); nada é publicado até o passo 3.
 */
async function fireInstagramReels(
  entry: QueueEntry,
  creds: InstagramCreds,
  pollIntervalMs: number,
  pollDeadlineMs: number,
): Promise<FireOutcome> {
  if (!entry.video_url) {
    return { status: "dlq", reason: "Instagram Reels: video_url ausente" };
  }
  const base = `https://graph.facebook.com/${creds.apiVersion}`;
  // #10922 — container de uma volta anterior que ainda serve: a volta retoma o
  // processamento dele em vez de criar outro. Toda falha desta volta devolve o
  // container em uso (`reelsContainer`) pra próxima volta seguir dele.
  let container: ReelsContainerRef | null = resumableReelsContainer(entry.reels_container, Date.now());
  const fail = (reason: string): FireOutcome =>
    container ? { status: "failed", reason, reelsContainer: container } : { status: "failed", reason };

  // #10877 — antes de criar container novo, confere se uma volta anterior já
  // publicou este Reels (media_publish que estourou o tempo mas saiu). Roda em
  // toda volta, não só em retry: o caminho do alarm do DO não incrementa
  // `retry_count`, então "1ª tentativa" não é distinguível de forma confiável.
  const scheduledMs = Date.parse(entry.scheduled_at);
  const prior = await findPublishedReel(
    base,
    creds,
    entry.text,
    (Number.isNaN(scheduledMs) ? Date.now() : scheduledMs) - REELS_DEDUP_LOOKBACK_MS,
  );
  if (prior.kind === "found") {
    console.warn(
      `[instagram-reels] Reels com a mesma legenda já publicado (media_id=${prior.mediaId}) — ` +
        `tratado como disparado, sem criar container novo (#10877).`,
    );
    return { status: "fired" };
  }
  if (prior.kind === "unverifiable") {
    if (prior.transient) {
      // Sem saber se já saiu, não publica: falha transitória na consulta vira
      // retry normal (custa uma volta do cron; o Reels em dobro não tem desfazer).
      return fail(`Instagram Reels: dedup inconclusivo, não publica nesta volta — ${prior.reason}`);
    }
    // Recusa da Graph (4xx, ex.: token sem permissão de leitura): repetir dá o
    // mesmo erro e travaria todo Reels na DLQ. Segue sem a 1ª rede; a conferência
    // do container depois do media_publish continua valendo.
    console.warn(`[instagram-reels] dedup indisponível (${prior.reason}) — publicando sem a busca prévia (#10877).`);
  }

  const resumed = container !== null;
  if (container) {
    console.log(
      `[instagram-reels] retomando o container ${container.id} criado em ${container.created_at}, sem criar outro (#10922).`,
    );
  } else {
    try {
      const params = new URLSearchParams({
        media_type: "REELS",
        video_url: entry.video_url,
        caption: entry.text,
        share_to_feed: "true",
        access_token: creds.accessToken,
      });
      if (entry.cover_url) params.set("cover_url", entry.cover_url);
      if (entry.collaborators && entry.collaborators.length > 0) {
        params.set("collaborators", JSON.stringify(entry.collaborators));
      }
      const res = await fetch(`${base}/${creds.igUserId}/media`, {
        method: "POST",
        body: params,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let data: { id?: string; error?: { message?: string } };
      try {
        data = JSON.parse(text);
      } catch {
        return { status: "failed", reason: `Instagram Reels /media resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      if (!res.ok || data.error) {
        return {
          status: "failed",
          reason: `Instagram Reels /media HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`,
        };
      }
      if (!data.id) {
        return { status: "failed", reason: `Instagram Reels /media sem id: ${text.slice(0, 200)}` };
      }
      container = { id: data.id, created_at: new Date().toISOString() };
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      return { status: "failed", reason: `Instagram Reels /media fetch ${timeout ? "timeout" : "failed"}: ${err.message}` };
    }
  }
  const containerId = container.id;

  const poll = await pollInstagramContainerStatus(
    base,
    containerId,
    creds.accessToken,
    REELS_POLL_MAX_ATTEMPTS,
    pollIntervalMs,
    pollDeadlineMs,
    resumed ? REELS_RESUMED_CONTAINER_MAX_CLIENT_ERRORS : undefined,
  );
  if (!poll.ok) {
    // #10922 — container retomado que expirou não condena o vídeo: a próxima
    // volta cria outro (sem `reelsContainer`). ERROR segue DLQ (o arquivo não serve).
    if (poll.permanent && resumed && poll.statusCode === "EXPIRED") {
      return { status: "failed", reason: `Instagram Reels: container retomado expirou, a próxima volta cria outro — ${poll.reason}` };
    }
    // #10954 self-review — container retomado que a Graph não reconhece mais
    // (4xx seguidos): descartá-lo, senão toda volta insiste nele até a DLQ.
    if (resumed && poll.unknownContainer) {
      return { status: "failed", reason: `Instagram Reels: container retomado recusado, a próxima volta cria outro — ${poll.reason}` };
    }
    if (poll.permanent) return { status: "dlq", reason: `Instagram Reels: ${poll.reason}` };
    return fail(`Instagram Reels: ${poll.reason}`);
  }
  // #10922 — medição do tempo real de processamento da Meta (`wrangler tail`).
  const processedMs = Date.now() - Date.parse(container.created_at);
  if (!Number.isNaN(processedMs)) {
    console.log(
      `[instagram-reels] container ${containerId} FINISHED ${Math.round(processedMs / 1000)} s depois de criado` +
        `${resumed ? " (retomado de volta anterior)" : ""} (#10922).`,
    );
  }

  const publishFailure = await publishReelsContainer(base, creds, containerId);
  if (publishFailure === null) return { status: "fired" };
  // #10877 — falha no media_publish não prova que o Reels não saiu (timeout com
  // a Meta publicando do outro lado). Container PUBLISHED = sucesso, nunca retry.
  if (await containerWasPublished(base, containerId, creds.accessToken)) {
    console.warn(
      `[instagram-reels] media_publish falhou (${publishFailure}) mas o container ${containerId} ` +
        `está PUBLISHED — tratado como disparado (#10877).`,
    );
    return { status: "fired" };
  }
  // #10922 — o container FINISHED segue valendo: a próxima volta só publica.
  return fail(`Instagram Reels /media_publish ${publishFailure} (container_id=${containerId})`);
}

/** #10922 — idade máxima do container retomado. A Graph expira o container em
 * 24 h; com 1 h de folga a volta nunca aposta num container prestes a expirar. */
export const REELS_CONTAINER_RESUME_MAX_AGE_MS = 23 * 60 * 60 * 1000;

/**
 * #10922 — o container gravado na entry ainda pode ser retomado? Formato
 * inválido, data ilegível, no futuro (relógio) ou mais velho que
 * `REELS_CONTAINER_RESUME_MAX_AGE_MS` → `null` (a volta cria outro).
 */
export function resumableReelsContainer(ref: unknown, nowMs: number): ReelsContainerRef | null {
  if (!ref || typeof ref !== "object") return null;
  const { id, created_at } = ref as Partial<ReelsContainerRef>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof created_at !== "string") return null;
  const t = Date.parse(created_at);
  if (Number.isNaN(t)) return null;
  const age = nowMs - t;
  if (age < -5 * 60_000 || age > REELS_CONTAINER_RESUME_MAX_AGE_MS) return null;
  return { id, created_at };
}

/**
 * #10922 — junta o container da entry do KV com o guardado no DO (o alarm
 * grava lá; o cron lê a entry do KV). O mais recente vence: depois de um
 * container expirado o cron cria outro e o do DO fica para trás.
 */
export function pickReelsContainer(a: unknown, b: unknown, nowMs: number): ReelsContainerRef | null {
  const ra = resumableReelsContainer(a, nowMs);
  const rb = resumableReelsContainer(b, nowMs);
  if (!ra) return rb;
  if (!rb) return ra;
  return Date.parse(rb.created_at) > Date.parse(ra.created_at) ? rb : ra;
}

/** POST /media_publish do container de Reels. `null` = publicado (com id);
 * string = o motivo da falha, sem o container_id (o caller acrescenta). */
async function publishReelsContainer(base: string, creds: InstagramCreds, containerId: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ creation_id: containerId, access_token: creds.accessToken });
    const res = await fetch(`${base}/${creds.igUserId}/media_publish`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return `resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
    if (!res.ok || data.error) return `HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`;
    if (!data.id) return `sem id: ${text.slice(0, 200)}`;
    return null;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return `fetch ${timeout ? "timeout" : "failed"}: ${err.message}`;
  }
}

/**
 * Dispara um carrossel Instagram (#4153) — fluxo de 3 passos da Graph API:
 *   1. N containers filhos (`is_carousel_item=true`), 1 POST por imagem, na
 *      ordem da lista — cada um devolve um `creation_id`, seguido de poll
 *      OBRIGATÓRIO até `FINISHED` (#7630 — ver `pollInstagramContainerStatus`
 *      acima; antes não havia poll aqui, só no caminho single-image).
 *   2. 1 container pai (`media_type=CAROUSEL`, `children=[ids]`, `caption`),
 *      seguido do MESMO poll obrigatório.
 *   3. `media_publish` do container pai.
 *
 * Falha parcial (decisão de escopo #4153, mantida pelo #7630): se QUALQUER
 * passo falhar — inclusive o poll de um único container filho — o post
 * inteiro é abortado e o outcome é SEMPRE "dlq", nunca "failed"/retriable.
 * Isto é DELIBERADAMENTE diferente do caminho single-image
 * (`fireInstagramSingle`), que deixa falhas transitórias serem re-tentadas
 * pelo `retry_count` normal (#880): publicar um carrossel incompleto é pior
 * que não publicar (o texto do post promete N dias), e re-tentar do zero
 * recriaria N containers a cada ciclo do cron sem garantia de sucesso — a
 * fila de retry padrão foi desenhada pra 1 chamada isolada, não pra uma
 * cadeia de até 7 chamadas interdependentes. O que o #7630 muda NÃO é essa
 * política de retry externo — é que agora o poll interno (dentro da MESMA
 * invocação, antes de decidir dlq) dá à Graph API a chance de terminar de
 * processar a mídia antes do próximo passo depender dela, eliminando a race
 * condition que antes gerava um `dlq` para um erro puramente transitório.
 * Motivo real (não só "cron", crash mid-flight — inclui `alarm()` do DO) é
 * preservado no `reason`, junto com quantos containers já tinham sido
 * criados até o ponto da falha (auditoria manual pelo editor).
 */
async function fireInstagramCarousel(
  imageUrls: string[],
  caption: string,
  creds: InstagramCreds,
): Promise<FireOutcome> {
  // Defesa em profundidade: handleEnqueue já barra >CAROUSEL_MAX_ITEMS no
  // enqueue (#4153) — isto cobre entries legacy/inseridas fora do caminho
  // normal (mesmo padrão de fireThreads guardando texto >500 chars, ver acima).
  if (imageUrls.length > CAROUSEL_MAX_ITEMS) {
    return {
      status: "dlq",
      reason: `Instagram carrossel: ${imageUrls.length} imagens excede o máximo de ${CAROUSEL_MAX_ITEMS} da Graph API`,
    };
  }

  const base = `https://graph.facebook.com/${creds.apiVersion}`;
  const childIds: string[] = [];

  // Passo 1: N containers filhos — 1 POST por imagem, na ordem da lista.
  // `is_carousel_item=true` e SEM caption (a Graph API só aceita caption no
  // container pai — colocar caption num filho é rejeitado pela API).
  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    try {
      const params = new URLSearchParams({
        image_url: imageUrl,
        is_carousel_item: "true",
        access_token: creds.accessToken,
      });
      const res = await fetch(`${base}/${creds.igUserId}/media`, {
        method: "POST",
        body: params,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let data: { id?: string; error?: { message?: string } };
      try {
        data = JSON.parse(text);
      } catch {
        return {
          status: "dlq",
          reason: `Instagram carrossel: child container ${i + 1}/${imageUrls.length} resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (containers já criados: ${childIds.length})`,
        };
      }
      if (!res.ok || data.error) {
        return {
          status: "dlq",
          reason: `Instagram carrossel: child container ${i + 1}/${imageUrls.length} falhou: HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (containers já criados: ${childIds.length})`,
        };
      }
      if (!data.id) {
        return {
          status: "dlq",
          reason: `Instagram carrossel: child container ${i + 1}/${imageUrls.length} sem id: ${text.slice(0, 200)} (containers já criados: ${childIds.length})`,
        };
      }
      childIds.push(data.id);
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        status: "dlq",
        reason: `Instagram carrossel: child container ${i + 1}/${imageUrls.length} fetch ${timeout ? "timeout" : "failed"}: ${err.message} (containers já criados: ${childIds.length})`,
      };
    }

    // Poll OBRIGATÓRIO (#7630) — sem isto, um filho ainda `IN_PROGRESS`
    // (transcodificação assíncrona da Graph API) referenciado pelo container
    // pai no passo seguinte causa o erro 9007 "Media ID is not available"
    // capturado ao vivo na investigação da #7626 — uma race condition
    // transitória que o `dlq` instantâneo tratava como permanente.
    const childPoll = await pollInstagramContainerStatus(base, childIds[childIds.length - 1], creds.accessToken);
    if (!childPoll.ok) {
      return {
        status: "dlq",
        reason: `Instagram carrossel: child container ${i + 1}/${imageUrls.length} (id=${childIds[childIds.length - 1]}) — ${childPoll.reason} (containers já criados: ${childIds.length})`,
      };
    }
  }

  // Passo 2: container pai — media_type=CAROUSEL + children (ordem
  // preservada, mesma ordem dos POSTs do passo 1) + caption.
  let parentId: string;
  try {
    const params = new URLSearchParams({
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.igUserId}/media`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return {
        status: "dlq",
        reason: `Instagram carrossel: container pai resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (children=${childIds.join(",")})`,
      };
    }
    if (!res.ok || data.error) {
      return {
        status: "dlq",
        reason: `Instagram carrossel: container pai falhou: HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (children=${childIds.join(",")})`,
      };
    }
    if (!data.id) {
      return {
        status: "dlq",
        reason: `Instagram carrossel: container pai sem id: ${text.slice(0, 200)} (children=${childIds.join(",")})`,
      };
    }
    parentId = data.id;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      status: "dlq",
      reason: `Instagram carrossel: container pai fetch ${timeout ? "timeout" : "failed"}: ${err.message} (children=${childIds.join(",")})`,
    };
  }

  // Poll OBRIGATÓRIO do container pai (#7630) — mesmo racional dos filhos:
  // o container CAROUSEL também processa antes de ficar publicável.
  const parentPoll = await pollInstagramContainerStatus(base, parentId, creds.accessToken);
  if (!parentPoll.ok) {
    return { status: "dlq", reason: `Instagram carrossel: container pai (id=${parentId}) — ${parentPoll.reason}` };
  }

  // Passo 3: publicar o container pai — NENHUMA chamada aqui acontece se
  // qualquer passo acima retornou cedo.
  try {
    const params = new URLSearchParams({
      creation_id: parentId,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.igUserId}/media_publish`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return {
        status: "dlq",
        reason: `Instagram carrossel: media_publish resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (parent_id=${parentId})`,
      };
    }
    if (!res.ok || data.error) {
      return {
        status: "dlq",
        reason: `Instagram carrossel: media_publish falhou: HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (parent_id=${parentId})`,
      };
    }
    if (!data.id) {
      return {
        status: "dlq",
        reason: `Instagram carrossel: media_publish sem id: ${text.slice(0, 200)} (parent_id=${parentId})`,
      };
    }
    return { status: "fired" };
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      status: "dlq",
      reason: `Instagram carrossel: media_publish fetch ${timeout ? "timeout" : "failed"}: ${err.message} (parent_id=${parentId})`,
    };
  }
}

/**
 * Dispara um post no Threads via Threads API oficial da Meta (#3944 Parte B,
 * carrossel de imagem #5348).
 *
 * Ponto único de entrada do canal Threads — despacha pro caminho TEXT-only
 * (`fireThreadsText`, inalterado desde #3944 Parte B), imagem única
 * (`fireThreadsSingleImage`, #5348) ou carrossel (`fireThreadsCarousel`,
 * #5348) conforme a contagem de imagens resolvida por `resolveImageUrls` —
 * mesmo padrão de `fireInstagram` acima. Guard de tamanho (≤500 chars)
 * roda ANTES de qualquer dispatch, pros 3 caminhos: chunking agendado
 * (thread multi-post via reply_to_id) não é suportado aqui — encadear
 * chunks com retry automático arriscaria duplicar posts já publicados.
 * Textos >500 chars são rejeitados já no enqueue (index.ts::handleEnqueue);
 * este guard aqui é defesa em profundidade pra items legacy/inseridos fora
 * do enqueue normal.
 */
async function fireThreads(entry: QueueEntry, creds: ThreadsCreds): Promise<FireOutcome> {
  if (entry.text.length > 500) {
    return {
      status: "dlq",
      reason: "texto excede 500 chars — chunking agendado não suportado, ver #3944 Parte B",
    };
  }
  const images = resolveImageUrls(entry);
  if (images.length === 0) return fireThreadsText(entry.text, creds);
  if (images.length === 1) return fireThreadsSingleImage(images[0], entry.text, creds);
  return fireThreadsCarousel(images, entry.text, creds);
}

/**
 * Caminho TEXT-only original (#3944 Parte B, extraído sem alteração de
 * lógica pra `fireThreads` poder despachar por contagem de imagem, #5348).
 *
 * Sequência de 2 passos (idêntica a scripts/publish-threads.ts, modo imediato):
 *   (1) POST /{threads-user-id}/threads         → cria media container (media_type=TEXT)
 *   (2) POST /{threads-user-id}/threads_publish  → publica o container
 *
 * Sem poll de status — a Threads API não documenta/precisa desse passo pra
 * containers TEXT (publish-threads.ts local também não faz). Diferente dos
 * 2 caminhos com imagem abaixo, onde o poll é OBRIGATÓRIO (ver doc-comment
 * de `pollThreadsContainerStatus`).
 */
async function fireThreadsText(text: string, creds: ThreadsCreds): Promise<FireOutcome> {
  const base = `https://graph.threads.net/${creds.apiVersion}`;

  // Passo 1: criar media container
  let containerId: string;
  try {
    const params = new URLSearchParams({
      media_type: "TEXT",
      text,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.userId}/threads`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const resText = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(resText);
    } catch {
      return { status: "failed", reason: `Threads /threads resposta não-JSON: HTTP ${res.status}: ${resText.slice(0, 200)}` };
    }
    if (!res.ok || data.error) {
      return {
        status: "failed",
        reason: `Threads /threads HTTP ${res.status}: ${data.error?.message ?? resText.slice(0, 200)}`,
      };
    }
    if (!data.id) {
      return { status: "failed", reason: `Threads /threads sem id: ${resText.slice(0, 200)}` };
    }
    containerId = data.id;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return { status: "failed", reason: `Threads /threads fetch ${timeout ? "timeout" : "failed"}: ${err.message}` };
  }

  // Passo 2: publicar o container
  return publishThreadsCreation(base, creds, containerId, {
    label: "Threads /threads_publish",
    idSuffix: `(container_id=${containerId})`,
    definiteFailure: "failed",
  });
}

/**
 * #11106 — passo `threads_publish`, compartilhado pelos 3 caminhos Threads
 * (texto, imagem única, carrossel). Mesma classificação do modo imediato do
 * `scripts/publish-threads.ts` (#11076, `publishThreadsContainer`):
 *
 * - **Ambíguo → `send_unknown`** (a Meta pode ter publicado, refazer duplica o
 *   post): fetch lançou (timeout/rede), HTTP 5xx, 2xx sem `id`, 2xx com corpo
 *   ilegível.
 * - **Falha definitiva → `definiteFailure`**: HTTP 4xx (ou `error` no corpo de
 *   um 2xx), resposta 4xx ilegível. Nada saiu; texto e imagem única seguem
 *   retriable (`failed`), o carrossel segue `dlq` como antes.
 */
async function publishThreadsCreation(
  base: string,
  creds: ThreadsCreds,
  creationId: string,
  opts: { label: string; idSuffix: string; definiteFailure: "failed" | "dlq" },
): Promise<FireOutcome> {
  const { label, idSuffix, definiteFailure } = opts;
  const ambiguous = (reason: string): FireOutcome => ({ status: "send_unknown", reason: `${SEND_UNKNOWN_PREFIX} ${reason}` });
  let res: Response;
  let text: string;
  try {
    const params = new URLSearchParams({ creation_id: creationId, access_token: creds.accessToken });
    res = await fetch(`${base}/${creds.userId}/threads_publish`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return ambiguous(`${label} fetch ${timeout ? "timeout" : "failed"}: ${err.message} ${idSuffix}`);
  }
  const serverError = res.status >= 500;
  let data: { id?: string; error?: { message?: string } };
  try {
    data = JSON.parse(text);
  } catch {
    const reason = `${label} resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} ${idSuffix}`;
    return res.ok || serverError ? ambiguous(reason) : { status: definiteFailure, reason };
  }
  if (!res.ok || data.error) {
    const reason = `${label} HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} ${idSuffix}`;
    return serverError ? ambiguous(reason) : { status: definiteFailure, reason };
  }
  if (!data.id) return ambiguous(`${label} sem id: ${text.slice(0, 200)} ${idSuffix}`);
  return { status: "fired" };
}

/** Nº máximo de tentativas de poll do status de um container Threads antes
 * de desistir (fail-closed) — #5348. */
const THREADS_POLL_MAX_ATTEMPTS = 10;
/** Intervalo entre tentativas de poll (ms) — #5348. Total no pior caso:
 * ~9 × 2s = 18s de espera + até 10 fetches de ~30s cada só se cada um
 * travar no timeout (limite superior raro, não o caminho comum). */
const THREADS_POLL_INTERVAL_MS = 2000;

/**
 * Faz polling do status de UM container Threads (imagem ou carrossel pai)
 * até `FINISHED`, `ERROR`/`EXPIRED`, ou esgotar `THREADS_POLL_MAX_ATTEMPTS`
 * — #5348.
 *
 * Diferente do poll BEST-EFFORT que `fireInstagramSingle` já faz pro
 * Instagram (2 tentativas, ~3s, segue pro publish mesmo sem confirmar): a
 * Threads API não garante `FINISHED` imediato pra containers de imagem
 * (achado da investigação da issue #5348) — publicar um `creation_id` cujo
 * container ainda está `IN_PROGRESS` falha na API. Este poll é portanto
 * OBRIGATÓRIO e FAIL-CLOSED: qualquer resultado que não seja `FINISHED`
 * dentro do orçamento de tentativas retorna falha em vez de seguir pro
 * publish às cegas. Nunca poll infinito: o teto de tentativas é fixo
 * (`THREADS_POLL_MAX_ATTEMPTS`), não recursivo/sem limite.
 *
 * #5348 self-review (silent-failure-hunter): a 1ª versão abortava no
 * PRIMEIRO erro transitório (timeout de fetch, HTTP não-2xx, resposta
 * não-JSON) em vez de consumir o orçamento de tentativas — um único blip de
 * rede em QUALQUER das até 10 tentativas derrubava o post inteiro pra DLQ,
 * mesmo com 9 tentativas ainda disponíveis. Corrigido pra reservar o abort
 * IMEDIATO só pro sinal REAL e informativo da própria Threads API
 * (`status: "ERROR"`/`"EXPIRED"` — o container está de fato quebrado,
 * re-tentar o poll não muda isso) — mesmo padrão que o script local
 * `scripts/publish-threads.ts::waitForContainerReady` já usava pra esse
 * mesmo endpoint. Erro transitório (fetch/HTTP/parse) loga um warning e cai
 * pro mesmo sleep-and-retry do `IN_PROGRESS`, só falhando de fato quando as
 * tentativas se esgotam de verdade.
 *
 * `permanent: true` no retorno de falha (só no branch `ERROR`/`EXPIRED`)
 * sinaliza ao caller que re-tentar a chamada NÃO vai ajudar — usado por
 * `fireThreadsSingleImage` pra decidir `dlq` (não-retriable) vs `failed`
 * (retriable via `retry_count`) sem duplicar essa lógica de classificação.
 */
async function pollThreadsContainerStatus(
  base: string,
  containerId: string,
  accessToken: string,
): Promise<{ ok: true } | { ok: false; reason: string; permanent: boolean }> {
  for (let attempt = 1; attempt <= THREADS_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      // Token vai no header Authorization, nunca na query string (#7779).
      const res = await fetch(`${base}/${containerId}?fields=status,error_message`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let data: { status?: string; error_message?: string; error?: { message?: string } };
      try {
        data = JSON.parse(text);
      } catch {
        console.warn(
          `[threads-poll] resposta não-JSON na tentativa ${attempt}/${THREADS_POLL_MAX_ATTEMPTS} (container_id=${containerId}): HTTP ${res.status}: ${text.slice(0, 200)} — tratado como transitório, tentando de novo.`,
        );
        if (attempt < THREADS_POLL_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, THREADS_POLL_INTERVAL_MS));
        continue;
      }
      if (!res.ok || data.error) {
        console.warn(
          `[threads-poll] HTTP ${res.status} na tentativa ${attempt}/${THREADS_POLL_MAX_ATTEMPTS} (container_id=${containerId}): ${data.error?.message ?? text.slice(0, 200)} — tratado como transitório, tentando de novo.`,
        );
        if (attempt < THREADS_POLL_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, THREADS_POLL_INTERVAL_MS));
        continue;
      }
      if (data.status === "FINISHED") return { ok: true };
      if (data.status === "ERROR" || data.status === "EXPIRED") {
        return {
          ok: false,
          permanent: true,
          reason: `Threads container status=${data.status} (container_id=${containerId})${data.error_message ? `: ${data.error_message}` : ""}`,
        };
      }
      // IN_PROGRESS (ou estado transitório desconhecido) — segue tentando.
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      console.warn(
        `[threads-poll] fetch ${timeout ? "timeout" : "failed"} na tentativa ${attempt}/${THREADS_POLL_MAX_ATTEMPTS} (container_id=${containerId}): ${err.message} — tratado como transitório, tentando de novo.`,
      );
    }
    if (attempt < THREADS_POLL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, THREADS_POLL_INTERVAL_MS));
    }
  }
  return {
    ok: false,
    permanent: false,
    reason:
      `Threads container nunca ficou FINISHED após ${THREADS_POLL_MAX_ATTEMPTS} tentativas ` +
      `(~${Math.round((THREADS_POLL_MAX_ATTEMPTS * THREADS_POLL_INTERVAL_MS) / 1000)}s) — ` +
      `container_id=${containerId}, fail-closed (não publica).`,
  };
}

/**
 * Dispara um post Threads com UMA imagem (#5348) — container `media_type:
 * "IMAGE"` + poll OBRIGATÓRIO (ver `pollThreadsContainerStatus`) + publish.
 * Extraído de `fireThreadsCarousel` como caso N=1 explícito porque a Graph
 * API do Threads não aceita `media_type: "CAROUSEL"` com um único child —
 * imagem única usa o container `IMAGE` direto, sem container pai.
 *
 * #5348 self-review (code-reviewer + silent-failure-hunter, independentes):
 * diferente de `fireThreadsCarousel` (N containers interdependentes — um
 * re-try do zero recriaria todos, daí `dlq` sempre), este é estruturalmente
 * uma chamada ISOLADA de 2-3 passos, o mesmo formato de `fireInstagramSingle`
 * (que usa `status:"failed"`/retriable pro passo 1 E pro passo 2 — nunca
 * `dlq`). Falha na CRIAÇÃO do container (antes de qualquer efeito colateral
 * publicado) e falha DEFINITIVA no PUBLISH (4xx) são `"failed"`, retriable via
 * `retry_count` normal, igual ao Instagram. Resposta AMBÍGUA do publish
 * (timeout, 5xx, 2xx sem id) é `send_unknown`, nunca refeita (#11106 — a
 * premissa antiga "`threads_publish` só publica quando bem-sucedido" não vale
 * quando a resposta se perde: a Meta pode ter publicado).
 * Só a falha do POLL usa `poll.permanent` pra decidir: `ERROR`/`EXPIRED`
 * (container genuinamente quebrado, re-tentar não muda o resultado) vira
 * `dlq`; timeout de tentativas esgotadas (`permanent:false` — pode ter sido
 * só lentidão do lado da Meta) vira `failed`, retriable.
 */
async function fireThreadsSingleImage(imageUrl: string, caption: string, creds: ThreadsCreds): Promise<FireOutcome> {
  const base = `https://graph.threads.net/${creds.apiVersion}`;

  let containerId: string;
  try {
    const params = new URLSearchParams({
      media_type: "IMAGE",
      image_url: imageUrl,
      text: caption,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.userId}/threads`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return { status: "failed", reason: `Threads /threads (IMAGE) resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!res.ok || data.error) {
      return { status: "failed", reason: `Threads /threads (IMAGE) HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}` };
    }
    if (!data.id) {
      return { status: "failed", reason: `Threads /threads (IMAGE) sem id: ${text.slice(0, 200)}` };
    }
    containerId = data.id;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return { status: "failed", reason: `Threads /threads (IMAGE) fetch ${timeout ? "timeout" : "failed"}: ${err.message}` };
  }

  const poll = await pollThreadsContainerStatus(base, containerId, creds.accessToken);
  if (!poll.ok) return { status: poll.permanent ? "dlq" : "failed", reason: poll.reason };

  return publishThreadsCreation(base, creds, containerId, {
    label: "Threads /threads_publish",
    idSuffix: `(container_id=${containerId})`,
    definiteFailure: "failed",
  });
}

/**
 * Dispara um carrossel Threads (#5348) — fluxo de 3 passos da Threads API,
 * mesmo padrão de `fireInstagramCarousel` acima, com UMA diferença
 * estrutural: poll de status é OBRIGATÓRIO em CADA container (filhos E o
 * pai), não best-effort:
 *   1. N containers filhos (`media_type: "IMAGE"`, `is_carousel_item: true`),
 *      1 POST por imagem na ordem da lista — cada um seguido de poll
 *      obrigatório até `FINISHED` antes do próximo passo poder usá-lo.
 *   2. 1 container pai (`media_type: "CAROUSEL"`, `children=[ids]`, `text`
 *      = caption) — seguido do MESMO poll obrigatório.
 *   3. `threads_publish` do container pai.
 *
 * Falha parcial (mesma decisão de escopo do #4153/Instagram): se QUALQUER
 * passo falhar — inclusive o poll de um único container filho — o post
 * inteiro é abortado e o outcome é SEMPRE "dlq", nunca "failed"/retriable:
 * publicar um carrossel incompleto é pior que não publicar (o texto do post
 * promete N itens), e re-tentar do zero recriaria N containers a cada ciclo
 * do cron sem garantia de sucesso.
 */
async function fireThreadsCarousel(imageUrls: string[], caption: string, creds: ThreadsCreds): Promise<FireOutcome> {
  // Defesa em profundidade — mesmo padrão de fireInstagramCarousel: o enqueue
  // (index.ts::handleEnqueue) já barra >CAROUSEL_MAX_ITEMS, isto cobre
  // entries legacy/inseridas fora do caminho normal.
  if (imageUrls.length > CAROUSEL_MAX_ITEMS) {
    return {
      status: "dlq",
      reason: `Threads carrossel: ${imageUrls.length} imagens excede o máximo de ${CAROUSEL_MAX_ITEMS} da Graph API`,
    };
  }

  const base = `https://graph.threads.net/${creds.apiVersion}`;
  const childIds: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    let childId: string;
    try {
      const params = new URLSearchParams({
        media_type: "IMAGE",
        image_url: imageUrl,
        is_carousel_item: "true",
        access_token: creds.accessToken,
      });
      const res = await fetch(`${base}/${creds.userId}/threads`, {
        method: "POST",
        body: params,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let data: { id?: string; error?: { message?: string } };
      try {
        data = JSON.parse(text);
      } catch {
        return {
          status: "dlq",
          reason: `Threads carrossel: child container ${i + 1}/${imageUrls.length} resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (containers já criados: ${childIds.length})`,
        };
      }
      if (!res.ok || data.error) {
        return {
          status: "dlq",
          reason: `Threads carrossel: child container ${i + 1}/${imageUrls.length} falhou: HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (containers já criados: ${childIds.length})`,
        };
      }
      if (!data.id) {
        return {
          status: "dlq",
          reason: `Threads carrossel: child container ${i + 1}/${imageUrls.length} sem id: ${text.slice(0, 200)} (containers já criados: ${childIds.length})`,
        };
      }
      childId = data.id;
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "AbortError" || err.name === "TimeoutError";
      return {
        status: "dlq",
        reason: `Threads carrossel: child container ${i + 1}/${imageUrls.length} fetch ${timeout ? "timeout" : "failed"}: ${err.message} (containers já criados: ${childIds.length})`,
      };
    }

    // Poll OBRIGATÓRIO — o próximo passo (container pai) referencia este
    // filho por id; usá-lo antes de FINISHED falha na API.
    const childPoll = await pollThreadsContainerStatus(base, childId, creds.accessToken);
    if (!childPoll.ok) {
      return {
        status: "dlq",
        reason: `Threads carrossel: child container ${i + 1}/${imageUrls.length} (id=${childId}) — ${childPoll.reason} (containers já criados: ${childIds.length + 1})`,
      };
    }
    childIds.push(childId);
  }

  // Passo 2: container pai — media_type=CAROUSEL + children (ordem
  // preservada) + text (caption só entra no pai, mesmo padrão do Instagram).
  let parentId: string;
  try {
    const params = new URLSearchParams({
      media_type: "CAROUSEL",
      children: childIds.join(","),
      text: caption,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.userId}/threads`, {
      method: "POST",
      body: params,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: { id?: string; error?: { message?: string } };
    try {
      data = JSON.parse(text);
    } catch {
      return {
        status: "dlq",
        reason: `Threads carrossel: container pai resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (children=${childIds.join(",")})`,
      };
    }
    if (!res.ok || data.error) {
      return {
        status: "dlq",
        reason: `Threads carrossel: container pai falhou: HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (children=${childIds.join(",")})`,
      };
    }
    if (!data.id) {
      return {
        status: "dlq",
        reason: `Threads carrossel: container pai sem id: ${text.slice(0, 200)} (children=${childIds.join(",")})`,
      };
    }
    parentId = data.id;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      status: "dlq",
      reason: `Threads carrossel: container pai fetch ${timeout ? "timeout" : "failed"}: ${err.message} (children=${childIds.join(",")})`,
    };
  }

  // Poll OBRIGATÓRIO do container pai — mesmo racional dos filhos.
  const parentPoll = await pollThreadsContainerStatus(base, parentId, creds.accessToken);
  if (!parentPoll.ok) {
    return { status: "dlq", reason: `Threads carrossel: container pai (id=${parentId}) — ${parentPoll.reason}` };
  }

  // Passo 3: publicar o container pai (#11106: resposta ambígua vira send_unknown).
  return publishThreadsCreation(base, creds, parentId, {
    label: "Threads carrossel: threads_publish",
    idSuffix: `(parent_id=${parentId})`,
    definiteFailure: "dlq",
  });
}

/**
 * Ponto único de dispatch — branch por `entry.channel` (default "linkedin"
 * pra backward-compat com entries no KV de produção anteriores a #3817, que
 * nunca tinham esse campo).
 */
export async function fireQueueEntry(entry: QueueEntry, config: FireConfig): Promise<FireOutcome> {
  const channel = entry.channel ?? "linkedin";

  if (channel === "instagram") {
    // #10823 — conta por entry; ausente = diar.ia.br (backward-compat).
    if (entry.ig_account === "vjpixel") {
      if (!config.instagramVjpixel) {
        return {
          status: "dlq",
          reason:
            "channel=instagram, ig_account=vjpixel mas credenciais (INSTAGRAM_VJPIXEL_ACCOUNT_ID/INSTAGRAM_VJPIXEL_ACCESS_TOKEN) não configuradas",
        };
      }
      return fireInstagram(entry, config.instagramVjpixel, config.reelsPollIntervalMs, config.reelsPollDeadlineMs);
    }
    if (!config.instagram) {
      return {
        status: "dlq",
        reason:
          "channel=instagram mas credenciais Instagram (INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN) não configuradas",
      };
    }
    return fireInstagram(entry, config.instagram, config.reelsPollIntervalMs, config.reelsPollDeadlineMs);
  }

  if (channel === "threads") {
    if (!config.threads) {
      return {
        status: "dlq",
        reason: "channel=threads mas credenciais Threads (THREADS_ACCESS_TOKEN/THREADS_USER_ID) não configuradas",
      };
    }
    return fireThreads(entry, config.threads);
  }

  // channel === "linkedin" (ou ausente — default de backward-compat)

  // #8052 (reverte o guard fail-fast do #8050): `image_urls` com mais de 1
  // item agora publica via API DIRETA do LinkedIn (`fireLinkedInCarousel`),
  // em vez do webhook Make (que só encaminha `image_url` singular e nunca
  // leu `image_urls`) — mesmo padrão de ramificação de `fireInstagram`/
  // `fireThreads` (Instagram/Threads: > 1 imagem = carrossel, Graph/Threads
  // API direta, sem Make).
  const linkedInImages = resolveImageUrls(entry);
  if (linkedInImages.length > 1) {
    if (!config.linkedin) {
      return {
        status: "dlq",
        reason:
          "channel=linkedin com carrossel (image_urls) mas credenciais da API direta do LinkedIn (LINKEDIN_ACCESS_TOKEN/LINKEDIN_AUTHOR_URN) não configuradas — ver #8052",
      };
    }
    return fireLinkedInCarousel(linkedInImages, entry.text, config.linkedin);
  }

  const webhookTarget: WebhookTarget = entry.webhook_target ?? "diaria";
  const action: QueueAction = entry.action ?? "post";

  // (#3662/#3667) guard compartilhado — action=comment só é suportado por
  // webhookTarget=pixel. Ver guards.ts pro histórico completo do bug.
  if (isUnsupportedCommentTarget(action, webhookTarget)) {
    return {
      status: "dlq",
      reason: `action=comment mas webhook_target=${webhookTarget} (só "pixel" suporta comment)`,
    };
  }

  let webhookUrl: string;
  if (webhookTarget === "pixel") {
    if (!config.pixelWebhookUrl) {
      return { status: "dlq", reason: "webhook_target=pixel mas MAKE_PIXEL_WEBHOOK_URL não configurado" };
    }
    webhookUrl = config.pixelWebhookUrl;
  } else {
    webhookUrl = config.webhookUrl;
  }

  return fireLinkedIn(entry, webhookUrl, config.apiKey);
}
