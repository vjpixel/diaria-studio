/**
 * annual-relink.ts (#7587 item 2) — relink dos links da edição ANUAL pras
 * edições diárias da diar.ia.br de onde os itens vieram, mesma política do
 * digest mensal (#4048/#4066).
 *
 * Diferença de escopo em relação ao mensal: lá o relink cobre só os
 * destaques (Use Melhor/Radar ficam na fonte, seções de serviço). **A anual
 * não tem essas seções — vale para TODOS os links** (`servicoUrls` sempre
 * vazio aqui).
 *
 * A lógica pura de reescrita (`normUrl`, `slugifyAnchor`, `buildUrlToEdition`,
 * `buildRelink`) é reusada AS-IS de `monthly-relink-to-diaria.ts` — só o
 * RESOLVER de URL de edição é diferente, e é aqui que mora a armadilha:
 * `makeEditionUrlResolver` (mensal) indexa por `publish_date` cru, que nas
 * edições importadas em bloco (agosto/2025) carrega a data da IMPORTAÇÃO —
 * com ele, nenhuma edição de agosto/2025 casaria. Este resolver indexa por
 * `editorialDate()` (`displayed_date ?? publish_date`) e filtra
 * `status === "confirmed"`, igual à própria coleta da anual
 * (`annual-collect.ts`). Medido na 1ª rodada real: 93/102 links com o
 * resolver do mensal, 98/102 com este.
 */

import { buildUrlToEdition, buildRelink, type DestaqueRef, type RelinkResult } from "../../monthly-relink-to-diaria.ts";
import { editorialDate, type UnifiedCachedPost } from "../shared/edition-cache-reader.ts";
import { unixToEdition } from "./annual-collect.ts";

/**
 * edição AAMMDD → URL canônica, a partir do cache unificado (Beehiiv + Kit).
 * Só edições publicadas (`status === "confirmed"`) contam; a 1ª por data
 * editorial vence quando há duplicata entre caches.
 */
export function makeAnnualEditionUrlResolver(
  posts: readonly UnifiedCachedPost[],
): (edition: string) => string | null {
  const byEdition = new Map<string, string>();
  for (const post of posts) {
    if (post.status !== "confirmed" || !post.web_url) continue;
    const secs = editorialDate(post);
    if (secs === undefined || secs === null) continue;
    const edition = unixToEdition(secs);
    if (byEdition.has(edition)) continue; // 1ª ocorrência vence — mesma regra do mensal
    byEdition.set(edition, String(post.web_url).replace(/^https:\/\/diaria\.beehiiv\.com/, "https://diar.ia.br"));
  }
  return (edition: string) => byEdition.get(edition) ?? null;
}

/**
 * Reescreve o HTML da anual. Pura: não lê nem escreve arquivo — os callers
 * (`publish-annual-kit.ts`, testes) montam `destaques`/`posts` a partir do
 * disco.
 */
export function relinkAnnualEditionHtml(
  html: string,
  destaques: readonly DestaqueRef[],
  posts: readonly UnifiedCachedPost[],
  campaignOverride?: string,
  sourceOverride?: string,
): RelinkResult & { ambiguous: { url: string; editions: string[] }[] } {
  const { urlToEdition, ambiguous } = buildUrlToEdition([...destaques]);
  const editionUrl = makeAnnualEditionUrlResolver(posts);
  // Sem seções de serviço na anual — todo link é elegível ao relink.
  const servicoUrls = new Set<string>();
  const r = buildRelink(html, { urlToEdition, servicoUrls, editionUrl }, campaignOverride, sourceOverride);
  return { ...r, ambiguous };
}
