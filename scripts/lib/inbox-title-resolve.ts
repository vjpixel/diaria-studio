/**
 * lib/inbox-title-resolve.ts (#2833)
 *
 * Resolução de títulos placeholder de artigos submetidos via inbox editorial
 * (`(inbox)`) — busca o `<title>` real via fetch antes do dedup rodar, pra
 * evitar falso-positivo de similaridade de título (#485).
 *
 * Extraído de dedup.ts — movimentação pura, sem mudança de comportamento.
 * dedup.ts re-exporta esses símbolos pra manter compat com importadores
 * existentes (`./dedup.ts` / `../scripts/dedup.ts`).
 */

import { CONFIG } from "./config.ts";

// ---------------------------------------------------------------------------
// Inbox title resolution (#485)
// ---------------------------------------------------------------------------

/** Placeholder values that indicate an unresolved inbox title. */
const INBOX_TITLE_PLACEHOLDERS = ["(inbox)", "(no title)", "(sem título)"];

/** Returns true if the article title is a placeholder that needs resolution. */
export function needsTitleResolution(title: string | undefined | null): boolean {
  if (!title || !title.trim()) return true;
  const lower = title.trim().toLowerCase();
  if (INBOX_TITLE_PLACEHOLDERS.includes(lower)) return true;
  if (/^\(inbox/i.test(lower)) return true;
  if (/^\[inbox\]/i.test(lower)) return true;
  return false;
}

/**
 * Fetches the real title of a page by parsing its `<title>` tag.
 * Returns null on network error, non-OK response, or missing `<title>`.
 */
export async function fetchTitle(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Diar.ia/1.0 (https://diar.ia.br; diariaeditor@gmail.com)",
      },
      signal: AbortSignal.timeout(CONFIG.timeouts.fetch),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim().replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}

/**
 * For each article with a placeholder title (e.g. `(inbox)`), resolves the
 * real title via an HTTP fetch. Processed in parallel up to `concurrency`
 * simultaneous requests. Articles that fail to resolve keep their original
 * title. Never throws — uses Promise.allSettled internally.
 *
 * @param articles    Mutable array; titles are updated in-place on success.
 * @param concurrency Max parallel fetches (default: 15).
 */
export async function resolveInboxTitles(
  articles: { url: string; title?: string | null; [key: string]: unknown }[],
  concurrency = CONFIG.dedup.titleResolutionConcurrency,
): Promise<{ resolved: number; failed: number }> {
  const targets = articles
    .map((a, i) => ({ idx: i, article: a }))
    .filter(({ article }) => needsTitleResolution(article.title));

  if (targets.length === 0) return { resolved: 0, failed: 0 };

  let resolved = 0;
  let failed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const job = targets[cursor++];
      const title = await fetchTitle(job.article.url);
      if (title) {
        articles[job.idx].title = title;
        resolved++;
      } else {
        failed++;
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, targets.length)) },
    () => worker(),
  );
  await Promise.allSettled(workers);

  return { resolved, failed };
}
