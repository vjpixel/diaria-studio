/**
 * #13326: redirect de tracking OPACO de newsletter — o destino não está na URL,
 * só no `Location` que o servidor do provedor devolve.
 *
 * `decodeTrackerUrl` (`inject-inbox-urls.ts`) e `decodeGenericRedirect`
 * (`capture-newsletter-urls.ts`, #10467) só abrem wrapper que carrega o destino
 * num query param. Dois formatos aprovados não carregam:
 *
 * - AlphaSignal: `app.alphasignal.ai/c?uid=…&cid=…&lid=…&mid=…` → 307 com o
 *   destino no `Location`.
 * - HubSpot (Data Points @ DeepLearning.AI, em `info.deeplearning.ai`):
 *   `/e3t/Ctc/…` → 200 com uma página "You're being redirected" (checagem de
 *   bot em JS) cujo link "click here" (`/events/public/v1/encoded/track/tc/…`)
 *   devolve 307 com o destino.
 *
 * Sem resolver, os dois caíam inteiros como "sender-own" (o wrapper fica no
 * domínio do próprio remetente) e as newsletters nunca deram nenhum link ao
 * pool: 100% filtrados em toda edição de 261111 a 261117.
 *
 * A resolução só lê o `Location` do tracker — nunca abre o destino. Só URLs que
 * casam com um padrão conhecido abaixo são requisitadas: link de feedback,
 * unsubscribe ou preferências nunca é tocado (o caller também filtra
 * `isNonContentUrl` antes). Falha de rede/timeout devolve null e o link segue
 * o caminho antigo (filtrado), nunca derruba a captura.
 */

/** Padrões de tracker opaco conhecidos. Path exato, nunca substring de slug. */
const OPAQUE_TRACKER_RULES: Array<{ name: "alphasignal" | "hubspot"; test: (u: URL) => boolean }> = [
  {
    name: "alphasignal",
    test: (u) => /(^|\.)alphasignal\.ai$/i.test(u.hostname) && u.pathname === "/c" && u.searchParams.has("lid"),
  },
  {
    // HubSpot click tracking em qualquer host (o domínio de tracking é do cliente).
    name: "hubspot",
    test: (u) => /^\/e3t\/[A-Za-z]+\/[^/]/.test(u.pathname),
  },
];

function ruleOf(rawUrl: string): (typeof OPAQUE_TRACKER_RULES)[number]["name"] | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return OPAQUE_TRACKER_RULES.find((r) => r.test(u))?.name ?? null;
}

export function isOpaqueTrackerUrl(rawUrl: string): boolean {
  return ruleOf(rawUrl) !== null;
}

/**
 * Link de continuação da página intermediária do HubSpot. Só aceita um href no
 * mesmo host do tracker e no path de tracking (`/events/public/…/track/tc/`):
 * nunca segue um link qualquer da página.
 */
export function extractHubspotRedirectHref(html: string, trackerUrl: string): string | null {
  let host: string;
  try {
    host = new URL(trackerUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const m of html.matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    const href = m[1].replace(/&amp;/g, "&");
    try {
      const u = new URL(href, trackerUrl);
      if (u.hostname.toLowerCase() !== host) continue;
      if (!/^\/events\/public\/v\d+\/encoded\/track\/tc\//.test(u.pathname)) continue;
      return u.toString();
    } catch { /* href inválido: próximo */ }
  }
  return null;
}

export type FetchLike = (url: string, init: { method: string; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const USER_AGENT = "Mozilla/5.0 (compatible; diaria-newsletter-intake/1.0)";

async function requestOnce(fetchImpl: FetchLike, url: string, timeoutMs: number) {
  return fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": USER_AGENT },
  });
}

/** `Location` http(s) absoluto de uma resposta 3xx, ou null. */
function locationOf(res: { status: number; headers: { get(name: string): string | null } }, base: string): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    const u = new URL(loc, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve UM tracker opaco para o destino. null = não é tracker conhecido, a
 * resposta não trouxe destino, ou falhou (rede, timeout). Nunca lança.
 */
export async function resolveOpaqueTracker(
  rawUrl: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<string | null> {
  const rule = ruleOf(rawUrl);
  if (!rule) return null;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    const first = await requestOnce(fetchImpl, rawUrl, timeoutMs);
    const direct = locationOf(first, rawUrl);
    if (direct) return direct;
    if (rule !== "hubspot" || first.status !== 200) return null;
    const href = extractHubspotRedirectHref(await first.text(), rawUrl);
    if (!href) return null;
    return locationOf(await requestOnce(fetchImpl, href, timeoutMs), href);
  } catch {
    return null;
  }
}

/**
 * Resolve em lote, com concorrência limitada e teto de URLs. Devolve só as que
 * resolveram (`url bruta → destino`); quem não resolveu fica de fora e o caller
 * trata o link como antes.
 */
export async function resolveOpaqueTrackers(
  urls: readonly string[],
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; concurrency?: number; maxUrls?: number } = {},
): Promise<{ resolved: Record<string, string>; attempted: number; failed: number; skipped_over_cap: number }> {
  const unique = [...new Set(urls.filter(isOpaqueTrackerUrl))];
  const maxUrls = opts.maxUrls ?? 400;
  const todo = unique.slice(0, maxUrls);
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const resolved: Record<string, string> = {};
  let failed = 0;
  let next = 0;
  async function worker(): Promise<void> {
    while (next < todo.length) {
      const url = todo[next++];
      const dest = await resolveOpaqueTracker(url, opts);
      if (dest) resolved[url] = dest;
      else failed++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return { resolved, attempted: todo.length, failed, skipped_over_cap: unique.length - todo.length };
}
