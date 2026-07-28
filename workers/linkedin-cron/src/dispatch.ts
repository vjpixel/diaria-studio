import type { Env, QueueEntry, WebhookTarget, QueueAction } from "./index";
import { FETCH_TIMEOUT_MS } from "./index";
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

/** Credenciais/URLs resolvidas pelo caller (fire.ts via env; durable-object.ts via DO payload). */
export interface FireConfig {
  webhookUrl: string;
  pixelWebhookUrl?: string;
  /** #3903 — MAKE_WEBHOOK_API_KEY, enviado como header `x-make-apikey` em todo
   * POST ao webhook Make (diaria ou pixel). Undefined = header omitido
   * (migração incremental, scenario Make ainda sem auth configurada). */
  apiKey?: string;
  instagram?: InstagramCreds;
  threads?: ThreadsCreds;
}

export type FireOutcome =
  | { status: "fired" }
  /** Falha transitória — caller deve incrementar retry_count (ou, no caso do
   *  DO, apenas liberar o claim pro cron tentar de novo). */
  | { status: "failed"; reason: string }
  /** Falha de configuração/guard — não adianta re-tentar. Caller escreve DLQ
   *  direto (fire.ts) ou libera o claim sem postar (durable-object.ts, que
   *  não tem acesso a KV — o cron aplica o MESMO guard puro na próxima volta
   *  e escreve o DLQ). */
  | { status: "dlq"; reason: string };

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
 * Dispara o post do Instagram via Graph API direta (#3817 — sem Make, a API
 * do Instagram é aberta e o Make não agregaria nada, só herdaria limitações
 * de conector). Ponto de entrada único do canal Instagram — despacha pro
 * caminho single-image (#3817, inalterado) ou carrossel (#4153) conforme a
 * contagem de imagens resolvida por `resolveImageUrls`.
 */
async function fireInstagram(entry: QueueEntry, creds: InstagramCreds): Promise<FireOutcome> {
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
      const statusRes = await fetch(
        `${base}/${containerId}?fields=status_code&access_token=${encodeURIComponent(creds.accessToken)}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
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

/**
 * Dispara um carrossel Instagram (#4153) — fluxo de 3 passos da Graph API:
 *   1. N containers filhos (`is_carousel_item=true`), 1 POST por imagem, na
 *      ordem da lista — cada um devolve um `creation_id`.
 *   2. 1 container pai (`media_type=CAROUSEL`, `children=[ids]`, `caption`).
 *   3. `media_publish` do container pai.
 *
 * Falha parcial (decisão de escopo #4153): se QUALQUER passo falhar —
 * inclusive um único container filho no meio da lista — o post inteiro é
 * abortado e o outcome é SEMPRE "dlq", nunca "failed"/retriable. Isto é
 * DELIBERADAMENTE diferente do caminho single-image (`fireInstagramSingle`),
 * que deixa falhas transitórias serem re-tentadas pelo `retry_count` normal
 * (#880): publicar um carrossel incompleto é pior que não publicar (o texto
 * do post promete N dias), e re-tentar do zero recriaria N containers a cada
 * ciclo do cron sem garantia de sucesso — a fila de retry padrão foi
 * desenhada pra 1 chamada isolada, não pra uma cadeia de até 7 chamadas
 * interdependentes. Motivo real (não só "cron", crash mid-flight — inclui
 * `alarm()` do DO) é preservado no `reason`, junto com quantos containers já
 * tinham sido criados até o ponto da falha (auditoria manual pelo editor).
 */
async function fireInstagramCarousel(
  imageUrls: string[],
  caption: string,
  creds: InstagramCreds,
): Promise<FireOutcome> {
  // Defesa em profundidade: handleEnqueue já barra >10 itens no enqueue
  // (#4153) — isto cobre entries legacy/inseridas fora do caminho normal
  // (mesmo padrão de fireThreads guardando texto >500 chars, ver acima).
  if (imageUrls.length > 10) {
    return {
      status: "dlq",
      reason: `Instagram carrossel: ${imageUrls.length} imagens excede o máximo de 10 da Graph API`,
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
 * Dispara um post no Threads via Threads API oficial da Meta (#3944 Parte B).
 *
 * Sequência de 2 passos (idêntica a scripts/publish-threads.ts, modo imediato):
 *   (1) POST /{threads-user-id}/threads         → cria media container (media_type=TEXT)
 *   (2) POST /{threads-user-id}/threads_publish  → publica o container
 *
 * Diferenças deliberadas vs fireInstagram: (a) sem exigência de imagem —
 * Threads aceita posts só-texto; (b) sem poll de status_code — a Threads API
 * não documenta/precisa desse passo (publish-threads.ts local também não
 * faz); (c) guard de tamanho ANTES do passo 1 — chunking agendado (thread
 * multi-post via reply_to_id) não é suportado aqui: encadear chunks com
 * retry automático arriscaria duplicar posts já publicados. Textos >500
 * chars são rejeitados já no enqueue (index.ts::handleEnqueue); este guard
 * aqui é defesa em profundidade pra items legacy/inseridos fora do enqueue
 * normal.
 */
async function fireThreads(entry: QueueEntry, creds: ThreadsCreds): Promise<FireOutcome> {
  if (entry.text.length > 500) {
    return {
      status: "dlq",
      reason: "texto excede 500 chars — chunking agendado não suportado, ver #3944 Parte B",
    };
  }
  const base = `https://graph.threads.net/${creds.apiVersion}`;

  // Passo 1: criar media container
  let containerId: string;
  try {
    const params = new URLSearchParams({
      media_type: "TEXT",
      text: entry.text,
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
      return { status: "failed", reason: `Threads /threads resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    if (!res.ok || data.error) {
      return {
        status: "failed",
        reason: `Threads /threads HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`,
      };
    }
    if (!data.id) {
      return { status: "failed", reason: `Threads /threads sem id: ${text.slice(0, 200)}` };
    }
    containerId = data.id;
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return { status: "failed", reason: `Threads /threads fetch ${timeout ? "timeout" : "failed"}: ${err.message}` };
  }

  // Passo 2: publicar o container
  try {
    const params = new URLSearchParams({
      creation_id: containerId,
      access_token: creds.accessToken,
    });
    const res = await fetch(`${base}/${creds.userId}/threads_publish`, {
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
        reason: `Threads /threads_publish resposta não-JSON: HTTP ${res.status}: ${text.slice(0, 200)} (container_id=${containerId})`,
      };
    }
    if (!res.ok || data.error) {
      return {
        status: "failed",
        reason: `Threads /threads_publish HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)} (container_id=${containerId})`,
      };
    }
    if (!data.id) {
      return { status: "failed", reason: `Threads /threads_publish sem id: ${text.slice(0, 200)} (container_id=${containerId})` };
    }
    return { status: "fired" };
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === "AbortError" || err.name === "TimeoutError";
    return {
      status: "failed",
      reason: `Threads /threads_publish fetch ${timeout ? "timeout" : "failed"}: ${err.message} (container_id=${containerId})`,
    };
  }
}

/**
 * Ponto único de dispatch — branch por `entry.channel` (default "linkedin"
 * pra backward-compat com entries no KV de produção anteriores a #3817, que
 * nunca tinham esse campo).
 */
export async function fireQueueEntry(entry: QueueEntry, config: FireConfig): Promise<FireOutcome> {
  const channel = entry.channel ?? "linkedin";

  if (channel === "instagram") {
    if (!config.instagram) {
      return {
        status: "dlq",
        reason:
          "channel=instagram mas credenciais Instagram (INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN) não configuradas",
      };
    }
    return fireInstagram(entry, config.instagram);
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
