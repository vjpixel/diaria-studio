/**
 * scripts/lib/diaria/newsletter-final-esp-guard.ts (#13568)
 *
 * `_internal/newsletter-final.html` (e o `_internal/newsletter-draft.html` que
 * o alimenta) é a variante NEUTRA do HTML da edição: link de voto do "É IA?"
 * com `{{email}}` cru (`render-newsletter-html.ts` sem `--esp`, default
 * `beehiiv`). É dela que a página do site (`publish-edition-site-page.ts`,
 * §5b-site) parte, e o sanitizador de `site-archive-pages.ts` só reconhece
 * `{{email}}`: qualquer outra merge tag sobra crua e o guard #6202/#6210
 * recusa a página com exit 5.
 *
 * Incidente 261118: outra sessão regravou `newsletter-final.html` com a
 * variante Kit (`?email={{ subscriber.email_address }}`), a página `/p/{slug}`
 * não saiu no Stage 5 e o link de WhatsApp do e-mail pode ter dado 404. A
 * variante Kit tem arquivo próprio (`_internal/newsletter-final-kit.html`,
 * `render-kit-html-preview.ts`), e o publisher do Kit renderiza em memória
 * (`buildKitHtml`) — nada legítimo grava merge tag de ESP específico no
 * caminho canônico.
 *
 * Este módulo é a fonte única dessa regra, consumida pelos dois escritores do
 * caminho canônico: `render-newsletter-html.ts` (recusa `--esp kit|brevo` com
 * `--out` canônico) e `substitute-image-urls.ts` (recusa gravar
 * `newsletter-final.html` com merge tag de Kit/Brevo, qualquer que seja a
 * origem do HTML de entrada). Puro, sem I/O.
 */

import { basename, dirname } from "node:path";

/** Arquivos canônicos da variante neutra (só dentro de `_internal/`). */
export const NEUTRAL_HTML_BASENAMES: ReadonlySet<string> = new Set([
  "newsletter-draft.html",
  "newsletter-final.html",
]);

/**
 * Merge tags que só existem num ESP específico e que a página do site não
 * resolve: Liquid do Kit (`{{ subscriber.* }}`) e Brevo (`{{ contact.* }}`).
 * `{{email}}` (neutro) e `{{IMG:...}}` (placeholder de imagem) ficam de fora.
 */
const ESP_SPECIFIC_MERGE_TAG_RE = /\{\{\s*(?:subscriber|contact)\.[A-Za-z0-9_]+\s*\}\}/g;

/** `true` quando `path` é `_internal/newsletter-draft.html` ou `_internal/newsletter-final.html`. */
export function isNeutralHtmlPath(path: string): boolean {
  if (!NEUTRAL_HTML_BASENAMES.has(basename(path))) return false;
  return basename(dirname(path)) === "_internal";
}

/** Merge tags de ESP específico presentes no HTML (únicas, ordem de 1ª aparição). */
export function findEspSpecificMergeTags(html: string): string[] {
  return [...new Set(html.match(ESP_SPECIFIC_MERGE_TAG_RE) ?? [])];
}

/**
 * `render-newsletter-html.ts`: `--esp` diferente de `beehiiv` com `--out` num
 * caminho canônico. Devolve a mensagem de recusa, ou `null` se pode gravar.
 */
export function checkRenderEspForOut(esp: string, outPath: string | undefined): string | null {
  if (esp === "beehiiv" || !outPath || !isNeutralHtmlPath(outPath)) return null;
  return (
    `--esp ${esp} com --out ${basename(outPath)} recusado (#13568): ${basename(outPath)} é a variante ` +
    `neutra (link de voto com {{email}}), de onde sai a página do site; a merge tag do ${esp} ali faz ` +
    `publish-edition-site-page.ts sair com exit 5. Rode sem --esp para o caminho canônico. ` +
    `A variante Kit tem arquivo próprio: npx tsx scripts/render-kit-html-preview.ts <edition-dir> ` +
    `(grava _internal/newsletter-final-kit.html).`
  );
}

/**
 * `substitute-image-urls.ts`: HTML com merge tag de ESP específico prestes a
 * ser gravado num caminho canônico. Devolve a mensagem de recusa, ou `null`.
 */
export function checkNeutralHtmlWrite(outPath: string, html: string): string | null {
  if (!isNeutralHtmlPath(outPath)) return null;
  const tags = findEspSpecificMergeTags(html);
  if (tags.length === 0) return null;
  return (
    `${basename(outPath)} não gravado (#13568): o HTML traz merge tag de ESP específico ` +
    `(${tags.join(", ")}). ${basename(outPath)} é a variante neutra ({{email}}) e alimenta a página ` +
    `do site, que recusa essas tags (publish-edition-site-page.ts exit 5). Re-renderize sem --esp: ` +
    `npx tsx scripts/render-newsletter-html.ts <edition-dir> --format html --out <edition-dir>/_internal/newsletter-draft.html ` +
    `e rode este script de novo. Para a variante Kit: scripts/render-kit-html-preview.ts.`
  );
}
