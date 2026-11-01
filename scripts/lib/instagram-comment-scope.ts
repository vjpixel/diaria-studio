/**
 * instagram-comment-scope.ts (#11731, #11750)
 *
 * Decide se o 4º post (USE MELHOR) do Instagram pode prometer "Link da edição
 * no primeiro comentário." (#11724). Só promete quando o token QUE VAI
 * COMENTAR comprovadamente tem `instagram_manage_comments`:
 *
 *   - publicação imediata: o token do `.env` (`probeInstagramCommentPermission`);
 *   - `--schedule`: o secret `INSTAGRAM_ACCESS_TOKEN` do Worker
 *     `diaria-linkedin-cron`, consultado em `GET /instagram/comment-scope`
 *     (`probeWorkerInstagramCommentScope`, #11750). Antes do #11750 a sonda
 *     usava o token local como proxy — com os dois tokens renovados em
 *     momentos diferentes, a legenda prometia um comentário que o Worker não
 *     conseguia postar (ou o inverso desligava o comentário à toa).
 *
 * A decisão fica gravada em `_internal/instagram-comment-scope.json` para o
 * preview do Stage 4 (`render-social-html.ts`) ler sem rede. Sem registro,
 * ou com qualquer coisa que não seja `granted: true`, o preview mostra a
 * linha da bio — o mesmo fallback fail-closed do publish.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const INSTAGRAM_API_BASE = "https://graph.facebook.com";

/** Registro da última decisão de escopo, relativo ao diretório da edição. */
export const INSTAGRAM_COMMENT_SCOPE_FILE = "_internal/instagram-comment-scope.json";

/**
 * #11731: permissões que autorizam `POST /{ig-media-id}/comments`. Facebook
 * Login (o fluxo deste repo, `graph.facebook.com`) usa
 * `instagram_manage_comments`; Instagram Login usaria
 * `instagram_business_manage_comments`. Qualquer uma das duas basta.
 * Espelhada em `workers/linkedin-cron/src/dispatch.ts` (o Worker não importa
 * de `scripts/`).
 */
export const INSTAGRAM_COMMENT_PERMISSIONS: readonly string[] = [
  "instagram_manage_comments",
  "instagram_business_manage_comments",
];

/**
 * #11731: decide, a partir da resposta de `GET /me/permissions`
 * (`{ data: [{ permission, status }] }`), se o token pode comentar. Pure.
 * Formato inesperado = `false` (fail-closed: sem prova do escopo, o post não
 * promete comentário).
 */
export function hasInstagramCommentPermission(permissionsJson: unknown): boolean {
  const data = (permissionsJson as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return false;
  return data.some((p) => {
    if (!p || typeof p !== "object") return false;
    const { permission, status } = p as { permission?: unknown; status?: unknown };
    return typeof permission === "string" && INSTAGRAM_COMMENT_PERMISSIONS.includes(permission) && status === "granted";
  });
}

export type InstagramCommentScopeProbe = { ok: true; granted: boolean } | { ok: false; reason: string };

/**
 * #11731: sonda (só leitura) as permissões do token local. NUNCA lança: falha
 * de rede, HTTP de erro ou JSON inválido voltam como `{ ok: false, reason }`.
 * Token no header Authorization, nunca na query string (#7779) — o motivo
 * devolvido não carrega a URL nem o token.
 */
export async function probeInstagramCommentPermission(
  accessToken: string,
  apiVersion: string,
  fetchImpl: typeof fetch = fetch,
  /** Roda antes de D1/D2/D3: fetch pendurado não pode segurar a publicação. Timeout = fail-closed. */
  timeoutMs = 10_000,
): Promise<InstagramCommentScopeProbe> {
  try {
    const url = `${INSTAGRAM_API_BASE}/${apiVersion}/me/permissions`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: `permissões: resposta não-JSON HTTP ${res.status}` };
    }
    const apiError = (data as { error?: { message?: unknown } } | null)?.error;
    if (!res.ok || apiError) {
      const msg = typeof apiError?.message === "string" ? apiError.message : `HTTP ${res.status}`;
      return { ok: false, reason: `permissões: ${msg}` };
    }
    return { ok: true, granted: hasInstagramCommentPermission(data) };
  } catch (e) {
    return { ok: false, reason: `permissões: fetch falhou: ${(e as Error).message}` };
  }
}

/**
 * #11750: valida a resposta de `GET /instagram/comment-scope` do Worker.
 * Pure. Só `{ ok: true, granted: boolean }` conta como resposta válida; o
 * resto vira `{ ok: false }` (fail-closed).
 */
export function parseWorkerCommentScope(body: unknown): InstagramCommentScopeProbe {
  if (!body || typeof body !== "object") return { ok: false, reason: "worker: resposta sem objeto JSON" };
  const b = body as { ok?: unknown; granted?: unknown; reason?: unknown };
  if (b.ok === true && typeof b.granted === "boolean") return { ok: true, granted: b.granted };
  if (b.ok === false) {
    return { ok: false, reason: `worker: ${typeof b.reason === "string" ? b.reason : "sonda falhou"}` };
  }
  return { ok: false, reason: "worker: resposta fora do formato { ok, granted }" };
}

/**
 * #11750: pergunta ao Worker se o token DELE pode comentar. NUNCA lança.
 * Worker antigo (sem a rota) responde 404 → `{ ok: false }`, que o publish
 * trata como "sem escopo" (linha da bio). O motivo não carrega o token.
 */
export async function probeWorkerInstagramCommentScope(
  workerUrl: string,
  workerToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<InstagramCommentScopeProbe> {
  try {
    const url = workerUrl.replace(/\/+$/, "") + "/instagram/comment-scope";
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { "X-Diaria-Token": workerToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `worker: HTTP ${res.status}` };
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: `worker: resposta não-JSON HTTP ${res.status}` };
    }
    return parseWorkerCommentScope(data);
  } catch (e) {
    return { ok: false, reason: `worker: fetch falhou: ${(e as Error).message}` };
  }
}

/**
 * #11750: URL do Worker que agenda o Instagram — mesma precedência do
 * `--schedule` de `publish-instagram.ts` (env > config instagram > config
 * linkedin; é a mesma instância `diaria-linkedin-cron`). `""` = não configurado.
 */
export function resolveInstagramWorkerUrl(
  platformConfig: unknown,
  env: Record<string, string | undefined> = process.env,
): string {
  const social = (platformConfig as {
    publishing?: { social?: Record<string, { cloudflare_worker_url?: string } | undefined> };
  } | null)?.publishing?.social;
  return (
    env.DIARIA_LINKEDIN_CRON_URL ??
    social?.instagram?.cloudflare_worker_url ??
    social?.linkedin?.cloudflare_worker_url ??
    ""
  );
}

export type InstagramCommentScopeSource = "worker" | "local";

export interface InstagramCommentScopeRecord {
  granted: boolean;
  /** De quem é o token sondado: o do Worker (`--schedule`) ou o do `.env`. */
  source: InstagramCommentScopeSource;
  checked_at: string;
  /** Motivo quando a sonda falhou (`granted: false` por falta de prova). */
  reason?: string;
}

/** #11750: grava a decisão em `_internal/` para o preview do Stage 4. */
export function writeInstagramCommentScopeRecord(
  editionDir: string,
  probe: InstagramCommentScopeProbe,
  source: InstagramCommentScopeSource,
  now: Date = new Date(),
): InstagramCommentScopeRecord {
  const record: InstagramCommentScopeRecord = {
    granted: probe.ok && probe.granted,
    source,
    checked_at: now.toISOString(),
    ...(!probe.ok && { reason: probe.reason }),
  };
  const path = resolve(editionDir, INSTAGRAM_COMMENT_SCOPE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return record;
}

/**
 * #11750: o preview pode mostrar a linha do comentário? Só com registro
 * válido e `granted: true`. Ausente, ilegível ou qualquer outro formato =
 * `false` (linha da bio, mesmo fallback do publish). Nunca lança.
 */
export function readInstagramCommentScopeGranted(editionDir: string): boolean {
  try {
    const path = resolve(editionDir, INSTAGRAM_COMMENT_SCOPE_FILE);
    if (!existsSync(path)) return false;
    const data = JSON.parse(readFileSync(path, "utf8")) as { granted?: unknown };
    return data?.granted === true;
  } catch {
    return false;
  }
}
