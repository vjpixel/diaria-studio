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

/** Credenciais/URLs resolvidas pelo caller (fire.ts via env; durable-object.ts via DO payload). */
export interface FireConfig {
  webhookUrl: string;
  pixelWebhookUrl?: string;
  instagram?: InstagramCreds;
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
 * Dispara o post do LinkedIn via webhook Make.com (lógica idêntica à que
 * existia inline em fire.ts/durable-object.ts antes da extração #3817).
 */
async function fireLinkedIn(entry: QueueEntry, webhookUrl: string): Promise<FireOutcome> {
  const action: QueueAction = entry.action ?? "post";
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
 * Dispara o post do Instagram via Graph API direta (#3817 — sem Make, a API
 * do Instagram é aberta e o Make não agregaria nada, só herdaria limitações
 * de conector).
 *
 * Sequência de 2 passos (idêntica a scripts/publish-instagram.ts):
 *   (1) POST /{ig-user-id}/media          → cria media container
 *   (2) POST /{ig-user-id}/media_publish   → publica o container
 *
 * O container expira em 24h — por isso os 2 passos rodam INTEIROS no momento
 * do disparo (nunca no momento do agendamento). Entre os 2 passos, faz um
 * poll best-effort e limitado do `status_code` do container (imagem única
 * normalmente fica FINISHED de imediato; o poll é só uma rede de segurança
 * contra o raro IN_PROGRESS — nunca bloqueia mais que ~3s).
 */
async function fireInstagram(entry: QueueEntry, creds: InstagramCreds): Promise<FireOutcome> {
  if (!entry.image_url) {
    return { status: "dlq", reason: "image_url ausente — Instagram Graph API exige imagem" };
  }
  const base = `https://graph.facebook.com/${creds.apiVersion}`;

  // Passo 1: criar media container
  let containerId: string;
  try {
    const params = new URLSearchParams({
      image_url: entry.image_url,
      caption: entry.text,
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

  return fireLinkedIn(entry, webhookUrl);
}
