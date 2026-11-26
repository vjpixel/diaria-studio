/**
 * instagram-immediate-publish.ts (#14132)
 *
 * Publicação imediata do Instagram (`publish-instagram.ts` sem `--schedule`)
 * sem republicar o post quando o `/media_publish` falha só na resposta.
 *
 * Antes do #14132 o laço de 3 tentativas envolvia as duas fases (criar o
 * container e publicá-lo). Se o `/media_publish` publicava e a resposta
 * voltava 5xx ou a conexão caía, o `catch` refazia o laço inteiro: container
 * novo, publicação nova, o mesmo post duas ou três vezes no feed.
 *
 * Fases separadas aqui:
 *
 * 1. Criar o container: pode repetir. Container não publicado não aparece no
 *    feed e expira sozinho.
 * 2. Publicar: sempre o MESMO container. Depois de qualquer falha do
 *    `/media_publish`, o estado vem de `GET /{container-id}?fields=status_code`,
 *    nunca de uma nova publicação:
 *    - `PUBLISHED`: o post saiu. O `media_id` vem da listagem
 *      `/{ig-user-id}/media` (legenda igual); não achou, a entry sai
 *      `published` sem id/url, sem republicar.
 *    - `FINISHED`/`IN_PROGRESS`: não publicou; repete o `/media_publish` do
 *      mesmo container (um container só publica uma vez).
 *    - `ERROR`/`EXPIRED`: não publicou e não publica mais: `failed`, re-run
 *      seguro.
 *    - leitura falhou ou status desconhecido: `send_unknown` com o
 *      `ig_container_id`, sem nova tentativa (a retomada pula, #13074).
 */

export type InstagramContainerStatusResult =
  | { status: "ok"; statusCode: string }
  | { status: "error"; error: string };

export type InstagramImmediateOutcome =
  /** `mediaId` ausente: o container está PUBLISHED, mas o post não foi localizado na listagem. */
  | { kind: "published"; containerId: string; mediaId: string | null; recovered?: "container_status" }
  /** Nada foi publicado (provado). */
  | { kind: "failed"; reason: string; containerId?: string }
  /** O post pode ter saído: nunca republicar sem conferir o perfil. */
  | { kind: "send_unknown"; reason: string; containerId: string };

export interface InstagramImmediateDeps {
  label: string;
  createContainer: () => Promise<string>;
  publishContainer: (containerId: string) => Promise<string>;
  containerStatus: (containerId: string) => Promise<InstagramContainerStatusResult>;
  /** Procura o post publicado a partir do container (listagem `/media`). `null` = não achou. */
  findPublishedMedia: () => Promise<string | null>;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** Status de container que provam que o post não saiu e ainda pode sair. */
const RETRYABLE_CONTAINER_STATUSES = new Set(["FINISHED", "IN_PROGRESS"]);
/** Status de container que provam que o post não saiu e não sai mais. */
const DEAD_CONTAINER_STATUSES = new Set(["ERROR", "EXPIRED"]);

/** Ver docstring do módulo. Nunca lança. */
export async function publishInstagramImmediate(deps: InstagramImmediateDeps): Promise<InstagramImmediateOutcome> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const backoffMs = deps.backoffMs ?? ((attempt: number) => Math.pow(2, attempt - 1) * 1000);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((m: string) => console.error(m));

  // Fase 1: container (repetir é seguro).
  let containerId: string | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      containerId = await deps.createContainer();
      log(`  Container criado: ${containerId}`);
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log(`Attempt ${attempt}/${maxAttempts} (container) failed for ${deps.label}: ${lastError}`);
      if (attempt < maxAttempts) await sleep(backoffMs(attempt));
    }
  }
  if (!containerId) return { kind: "failed", reason: lastError };

  // Fase 2: publicar o MESMO container; o estado depois da falha vem do container.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const mediaId = await deps.publishContainer(containerId);
      return { kind: "published", containerId, mediaId };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log(`Attempt ${attempt}/${maxAttempts} (media_publish) failed for ${deps.label}: ${lastError}`);
    }

    const st = await deps.containerStatus(containerId);
    if (st.status === "error") {
      return {
        kind: "send_unknown",
        reason:
          `send_unknown: ${lastError} — o post pode ter saído e a leitura do container ${containerId} falhou ` +
          `(${st.error}). Conferir o perfil antes de refazer (#14132).`,
        containerId,
      };
    }
    if (st.statusCode === "PUBLISHED") {
      const mediaId = await deps.findPublishedMedia().catch(() => null);
      log(
        `WARN ${deps.label}: o /media_publish falhou (${lastError}), mas o container ${containerId} está PUBLISHED; ` +
          `${mediaId ? `post ${mediaId} adotado` : "post não localizado na listagem"}, sem republicar (#14132).`,
      );
      return { kind: "published", containerId, mediaId, recovered: "container_status" };
    }
    if (DEAD_CONTAINER_STATUSES.has(st.statusCode)) {
      return { kind: "failed", reason: `${lastError} (container ${containerId} ${st.statusCode}, nada publicado)`, containerId };
    }
    if (!RETRYABLE_CONTAINER_STATUSES.has(st.statusCode)) {
      return {
        kind: "send_unknown",
        reason:
          `send_unknown: ${lastError} — container ${containerId} com status_code ${JSON.stringify(st.statusCode)} ` +
          `desconhecido. Conferir o perfil antes de refazer (#14132).`,
        containerId,
      };
    }
    lastError = `${lastError} (container ${containerId} ${st.statusCode}, não publicado)`;
    if (attempt < maxAttempts) await sleep(backoffMs(attempt));
  }
  return { kind: "failed", reason: lastError, containerId };
}

/** Quantos caracteres do início da legenda precisam coincidir. */
const CAPTION_PREFIX_LEN = 120;

function normalizeCaption(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, CAPTION_PREFIX_LEN);
}

/**
 * Pure: id do post recente da listagem `/{ig-user-id}/media` com o mesmo
 * início de legenda (o 1º, que a Graph devolve do mais novo ao mais antigo).
 */
export function matchInstagramMediaByCaption(
  items: ReadonlyArray<{ id?: unknown; caption?: unknown }>,
  caption: string,
): string | null {
  const want = normalizeCaption(caption);
  if (!want) return null;
  for (const it of items) {
    if (typeof it?.id !== "string" || !it.id || typeof it.caption !== "string") continue;
    if (normalizeCaption(it.caption) === want) return it.id;
  }
  return null;
}

/**
 * `GET /{container-id}?fields=status_code` (token no header, #7779). Nunca
 * lança.
 */
export async function fetchInstagramContainerStatus(input: {
  apiBase: string;
  apiVersion: string;
  containerId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<InstagramContainerStatusResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${input.apiBase}/${input.apiVersion}/${input.containerId}?fields=status_code`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: "error", error: `container HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { status_code?: unknown; error?: unknown };
    if (data.error) return { status: "error", error: `container error: ${JSON.stringify(data.error).slice(0, 200)}` };
    if (typeof data.status_code !== "string") return { status: "error", error: "container sem status_code" };
    return { status: "ok", statusCode: data.status_code };
  } catch (e) {
    return { status: "error", error: `container: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Listagem dos posts recentes da conta e busca pela legenda. Nunca lança;
 * erro de leitura = `null` (o caller já sabe que o container publicou).
 */
export async function findRecentInstagramMediaByCaption(input: {
  apiBase: string;
  apiVersion: string;
  igUserId: string;
  accessToken: string;
  caption: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${input.apiBase}/${input.apiVersion}/${input.igUserId}/media?fields=id,caption,timestamp&limit=10`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const data = (await res.json()) as { data?: unknown };
    if (!Array.isArray(data.data)) return null;
    return matchInstagramMediaByCaption(data.data as Array<{ id?: unknown; caption?: unknown }>, input.caption);
  } catch {
    return null;
  }
}
