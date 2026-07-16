/**
 * slug.ts (#1989) — geração de slug acent-correto + meta description pra SEO.
 *
 * `slugify` foi extraído de build-cursos-page.ts (era a única impl; agora
 * compartilhada — cursos page + slug SEO de post). `seoSlug`/`seoMetaDescription`
 * são novos (#1989): o publish flow (Chrome paste de HTML) não seta slug, então
 * a Beehiiv auto-deriva e **mangla acentos PT-BR** (ex: `automa-o`, `p-nico`).
 * Slug quebrado prejudica SEO + UX + compartilhamento.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Slug estável: NFD-strip diacríticos + lowercase + kebab. Pure. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * #1989: slug SEO de post — slugify + trunca em PALAVRA inteira até `maxLen`
 * (default 60ch; slugs muito longos são ruins pra UX/compartilhamento). Nunca
 * corta no meio de uma palavra nem deixa hífen pendente.
 */
export function seoSlug(title: string, maxLen = 60): string {
  const full = slugify(title);
  if (full.length <= maxLen) return full;
  const cut = full.slice(0, maxLen);
  const lastDash = cut.lastIndexOf("-");
  // se há hífen, corta na última palavra inteira; senão usa o corte cru.
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}

/**
 * #1989: meta description SEO — combina título + subtítulo, colapsa espaços,
 * trunca em palavra inteira até `maxLen` (default 155ch — limite prático do
 * snippet do Google) com reticências. Determinístico (sem LLM).
 */
export function seoMetaDescription(title: string, subtitle?: string, maxLen = 155): string {
  const raw = [title, subtitle].filter(Boolean).join(" — ").replace(/\s+/g, " ").trim();
  if (raw.length <= maxLen) return raw;
  const cut = raw.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s—-]+$/, "") + "…";
}

/**
 * #3449: instruções de correção manual do slug SEO na UI do Beehiiv.
 *
 * Contexto: `fix-post-slug.ts --execute` corrige o slug via
 * `PATCH /publications/{pubId}/posts/{postId}` — mas essa rota é gated pelo
 * plano Beehiiv (confirmado 260714, edição real: `403
 * SEND_API_NOT_ENTERPRISE_PLAN`, ver `SlugPlanGatedError` em
 * `fix-post-slug.ts`). Como a correção pós-criação via API está bloqueada em
 * qualquer plano abaixo de Enterprise, a via de escape é a UI manual — este
 * helper gera o texto exato que o orchestrator/editor precisa pra aplicar a
 * correção em `Settings → SEO/URL slug` (campo `#text-input-slug`) do post.
 *
 * Pure — sem I/O, testável com fixtures.
 */
export function formatManualSlugFixInstructions(postId: string, slugTarget: string): string {
  return (
    `Slug não pôde ser corrigido via API (plano Beehiiv não suporta PATCH ` +
    `web_settings.slug — ver #3449). Correção manual:\n` +
    `1. Abrir o post no Beehiiv: https://app.beehiiv.com/posts/${postId}/edit\n` +
    `2. Ir em Settings → SEO/URL slug (campo #text-input-slug)\n` +
    `3. Selecionar todo o conteúdo do campo e digitar: ${slugTarget}\n` +
    `4. Confirmar/salvar — o agendamento (scheduled_at) não é alterado pela edição do slug.`
  );
}
