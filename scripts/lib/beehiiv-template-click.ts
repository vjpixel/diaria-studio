/**
 * beehiiv-template-click.ts (#1587)
 *
 * Helper pra clicar no card do template HTML em
 * `/posts/template-library?tab=my_templates`. Cria post novo a partir
 * do template em vez de criar template vazio (overlay "New template").
 *
 * Caso real 260529: orchestrator usou heurística baseada em `text === 'HTML'`
 * e matchou o overlay "New template Create a custom draft template" antes do
 * card real do template HTML — resultado: template vazio rogue
 * (279a534d-93ef-4317-8406-7d40f4af49ce) criado, polui template-library.
 *
 * Estratégia robusta:
 *   1. Query todos `<h3>` da página
 *   2. Encontrar aquele com texto EXATO 'HTML' (após trim)
 *   3. Walk up até o ancestor clickable (card container)
 *   4. Disparar click no inner button/anchor
 *
 * Validation pós-click (caller faz):
 *   - URL deve mudar pra `/posts/{uuid}/edit` (post real)
 *   - Se URL muda pra `/templates/posts/{uuid}/edit` → falha (template rogue)
 */

/**
 * Gera JS string pra dispatch via `mcp__claude-in-chrome__javascript_tool`.
 * Retorna `{ ok: true, templateName }` quando clicou no card correto, ou
 * `{ ok: false, error, candidates? }` quando falhou (helper pra debug).
 */
export function buildHtmlTemplateClickJs(): string {
  return `
    (() => {
      const h3s = Array.from(document.querySelectorAll('h3'));
      const htmlH3 = h3s.find((h) => (h.textContent || '').trim() === 'HTML');
      if (!htmlH3) {
        return {
          ok: false,
          error: "Nenhum <h3> com texto exato 'HTML' encontrado",
          candidates: h3s.slice(0, 10).map((h) => (h.textContent || '').trim().slice(0, 80)),
        };
      }
      // Walk up até achar ancestor com role=button OU button OU a[href]
      let cur = htmlH3.parentElement;
      let card = null;
      for (let i = 0; i < 8 && cur; i++) {
        if (cur.querySelector('button, [role="button"], a[href]')) {
          card = cur;
          break;
        }
        cur = cur.parentElement;
      }
      if (!card) {
        return { ok: false, error: "Não achei ancestor clickable do card HTML" };
      }
      // Pega primeiro clickable dentro do card (ignora se for o card todo)
      const clickable = card.querySelector('button, [role="button"], a[href]');
      if (!clickable) {
        return { ok: false, error: "Sem inner button/anchor no card HTML" };
      }
      clickable.click();
      return { ok: true, templateName: "HTML" };
    })()
  `;
}

/**
 * Pure: valida URL pós-click. Retorna `{ ok: true, postId }` quando criou
 * post real (URL `/posts/{uuid}/edit`), `{ ok: false, kind: "template_rogue", templateId }`
 * quando criou template vazio por engano (`/templates/posts/{uuid}/edit`),
 * ou `{ ok: false, kind: "unknown" }` pra URL sem match.
 */
export type ClickValidationResult =
  | { ok: true; postId: string }
  | { ok: false; kind: "template_rogue"; templateId: string }
  | { ok: false; kind: "unknown"; url: string };

export function validateTemplateClickUrl(url: string): ClickValidationResult {
  // Template rogue (deve ser checado primeiro — path é mais específico)
  const templateMatch = url.match(/\/templates\/posts\/([a-f0-9-]+)\/edit/i);
  if (templateMatch) {
    return { ok: false, kind: "template_rogue", templateId: templateMatch[1] };
  }
  const postMatch = url.match(/\/posts\/([a-f0-9-]+)\/edit/i);
  if (postMatch) {
    return { ok: true, postId: postMatch[1] };
  }
  return { ok: false, kind: "unknown", url };
}
