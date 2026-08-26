/**
 * scripts/lib/edition-site-page.ts (#6202, fatia do #467)
 *
 * Monta o `ArchivePost` de uma edição **recém-agendada**, a partir dos
 * artefatos locais dela — para que a página do acervo saia pelo MESMO
 * `buildArchivePageHtml` das outras 253.
 *
 * ## Por que sintetizar em vez de ler do cache
 *
 * `gen-archive-pages.ts` gera o acervo a partir de
 * `data/beehiiv-cache/posts/`. Mas no Stage 6 a edição está **agendada, não
 * publicada** — ela só entra no cache depois de sair, horas depois. Esperar o
 * cache significaria a página aparecer sempre um dia atrasada, ou depender de
 * um segundo passo que ninguém dispara.
 *
 * Os insumos já existem por edição:
 *
 * ```
 * _internal/newsletter-final.html   → content.free.web (o corpo)
 * _internal/05-published.json       → post_url (de onde sai o slug) + data
 * 02-reviewed.md                    → título e subtítulo
 * ```
 *
 * ## O que este módulo NÃO faz de propósito
 *
 * Não inventa `status`. Ele carimba `"confirmed"` porque `buildArchivePageHtml`
 * recusa gerar página de rascunho (`isPublishedPost`) — e uma edição que
 * chegou ao Stage 6 com `scheduled_at` confirmado é, para efeito de acervo,
 * uma edição que vai ao ar. Se o agendamento for cancelado depois, a próxima
 * regeneração completa a partir do cache **remove** a página (o gerador
 * apaga a árvore e reescreve), então o estado converge sozinho — não é
 * preciso um caminho de "despublicar" aqui.
 *
 * ## O fragmento precisa virar documento
 *
 * `_internal/newsletter-final.html` é o **fragmento** do corpo do e-mail (o
 * que os ESPs embrulham no shell deles) — medido: não tem `<html>`. Já
 * `buildArchivePageHtml` espera o documento web da Beehiiv e **falha alto**
 * sem essa tag, de propósito (senão o `.replace()` de `lang` viraria no-op
 * silencioso e a página sairia sem metadado nenhum).
 *
 * `wrapFragmentAsDocument` fecha essa distância com o mínimo: `<html><body>`
 * em volta. Nada de `<head>` — `buildArchivePageHtml` injeta charset, título,
 * description e canonical, e é ele que deve continuar sendo o ÚNICO
 * responsável por isso. Duplicar aqui criaria duas convenções de `<head>`
 * divergindo com o tempo, exatamente entre a edição nova e as 253 antigas.
 *
 * Puro: sem I/O. Quem lê arquivo é `publish-edition-site-page.ts`.
 */
import type { ArchivePost } from "./site-archive-pages.ts";

export interface EditionPageInputs {
  /** Conteúdo de `_internal/newsletter-final.html`. */
  html: string;
  /** `post_url`/`web_url` da edição — de onde o slug é extraído. */
  postUrl: string;
  title: string;
  subtitle?: string | null;
  /** ISO do envio (agendado ou realizado). */
  publishedAtIso?: string | null;
}

export type BuildEditionPostResult =
  | { ok: true; post: ArchivePost & { slug: string } }
  | { ok: false; reason: string };

/**
 * Extrai o slug de uma URL de edição (`https://diar.ia.br/p/{slug}`).
 *
 * Rejeita `new-post` — é o mesmo lixo que `isPublishedPost` já filtra no
 * acervo (achado ao vivo no cache real: um post duplicado com esse slug).
 * Deixar passar aqui criaria a página que o gerador se recusa a criar.
 *
 * A revalidação roda DEPOIS do `decodeURIComponent` (#6202 review, problema
 * 5): o regex casa contra o path BRUTO, então `%2F`/`%2E%2E%2F` passam pelo
 * filtro do `[^/?#]+` e só viram `/`/`..` depois de decodificados. Sem essa
 * 2ª checagem, um slug assim chegaria intocado no `join(dir, slug)` de
 * `writePage` — o `..` sai da árvore `workers/site/public/p/`. Rejeita
 * qualquer slug decodificado que contenha `/`, `\` ou `..`.
 */
export function extractSlugFromPostUrl(postUrl: string): string | null {
  try {
    const path = new URL(postUrl).pathname;
    const m = path.match(/\/p\/([^/?#]+)\/?$/);
    if (!m?.[1]) return null;
    const slug = decodeURIComponent(m[1]);
    if (!slug || slug === "new-post") return null;
    if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) return null;
    return slug;
  } catch {
    return null;
  }
}

/**
 * Envolve o fragmento do corpo num documento mínimo.
 *
 * Idempotente: fragmento que já for documento (tiver `<html>`) passa
 * intocado — assim um insumo futuro em formato completo não vira documento
 * aninhado.
 */
export function wrapFragmentAsDocument(fragment: string): string {
  if (/<html(\s[^>]*)?>/i.test(fragment)) return fragment;
  return `<!doctype html>\n<html>\n<body>\n${fragment}\n</body>\n</html>`;
}

export function buildEditionArchivePost(input: EditionPageInputs): BuildEditionPostResult {
  const slug = extractSlugFromPostUrl(input.postUrl);
  if (!slug) {
    return { ok: false, reason: `não foi possível extrair um slug utilizável de "${input.postUrl}"` };
  }
  if (!input.html.trim()) {
    return { ok: false, reason: "newsletter-final.html está vazio — nada a publicar" };
  }
  if (!input.title.trim()) {
    return { ok: false, reason: "edição sem título — a página sairia sem <title>" };
  }

  const ts = input.publishedAtIso ? Date.parse(input.publishedAtIso) : Number.NaN;
  return {
    ok: true,
    post: {
      slug,
      title: input.title,
      subtitle: input.subtitle ?? null,
      // `confirmed` porque `buildArchivePageHtml` recusa rascunho — ver
      // docstring do módulo sobre por que isso é seguro.
      status: "confirmed",
      web_url: input.postUrl,
      publish_date: Number.isFinite(ts) ? Math.floor(ts / 1000) : null,
      content: { free: { web: wrapFragmentAsDocument(input.html) } },
    },
  };
}
