/**
 * beehiiv-timestamp.ts (#572)
 *
 * Extrai a "data efetiva de publicação" de um post retornado pela Beehiiv API.
 *
 * Histórico:
 *   - Pré-#326: API retornava `published_at` como ISO string.
 *   - #326: API parou de popular `published_at` em `list_posts`. Fallback usava
 *     `published_at || scheduled_at || updated_at`.
 *   - #572: API mudou de novo — `published_at`/`scheduled_at`/`updated_at` voltam
 *     `null` em todos os posts. Único campo válido é `publish_date` (Unix seconds).
 *
 * Estratégia: tentar todos os campos conhecidos, na ordem do mais novo (ISO
 * preferido) pro mais antigo (Unix seconds). Retorna `null` quando nenhum
 * dos campos é parseável — caller deve detectar o `null` e fazer loud fail
 * (não silenciar como "post sem timestamp").
 */

export interface BeehiivPostTimestamps {
  /** ISO string. Histórico (pré-#326). */
  published_at?: string | null;
  /** ISO string. Disponível em posts agendados ou já enviados. */
  scheduled_at?: string | null;
  /** ISO string. Último recurso. */
  updated_at?: string | null;
  /** Unix timestamp em SEGUNDOS (não ms). Adicionado em #572. */
  publish_date?: number | null;
}

/**
 * Retorna a data efetiva de publicação como Date, ou `null` se nenhum campo
 * conhecido tem valor parseável OU se o timestamp está no futuro relativo a `now`
 * (post agendado, não publicado — #573).
 *
 * @param post  Post da Beehiiv API com campos de timestamp.
 * @param now   Opcional. Se passado, filtra posts com timestamp > now (agendados).
 *              Sem `now`, retorna o timestamp parseado mesmo se futuro.
 *
 * Não lança — caller decide o que fazer com `null` (loud fail recomendado).
 */
export function extractPublishedDate(
  post: BeehiivPostTimestamps,
  now?: Date,
): Date | null {
  let parsed: Date | null = null;

  // 1. ISO strings (preferido — mais explícito e auditável)
  for (const field of ["published_at", "scheduled_at", "updated_at"] as const) {
    const v = post[field];
    if (typeof v === "string" && v.trim().length > 0) {
      const ms = Date.parse(v);
      if (!isNaN(ms)) {
        parsed = new Date(ms);
        break;
      }
    }
  }

  // 2. Unix seconds (#572 — Beehiiv API atual). Multiplicar por 1000 pra ms.
  if (
    !parsed &&
    typeof post.publish_date === "number" &&
    post.publish_date > 0
  ) {
    // Sanity check: publish_date deve ser um Unix timestamp realista (segundos).
    // Se vier em ms por engano, > 1e12. Detectar e ajustar.
    const seconds =
      post.publish_date > 1e12
        ? Math.floor(post.publish_date / 1000) // veio em ms, normalizar
        : post.publish_date;
    parsed = new Date(seconds * 1000);
  }

  if (!parsed) return null;

  // #573: posts com timestamp no futuro são agendados, não publicados.
  // Filtrar quando `now` é passado (callers que processam dedup querem
  // só edições já enviadas pra audiência).
  if (now && parsed.getTime() > now.getTime()) return null;

  return parsed;
}

/**
 * ISO string ou `null`. Conveniência para serializar em JSON sem perder
 * a granularidade da data.
 */
export function extractPublishedAtIso(
  post: BeehiivPostTimestamps,
  now?: Date,
): string | null {
  const d = extractPublishedDate(post, now);
  return d ? d.toISOString() : null;
}
