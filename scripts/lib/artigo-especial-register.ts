/**
 * artigo-especial-register.ts (#9099)
 *
 * Registra um Artigo Especial NOVO nos 5 arquivos mantidos à mão do
 * `workers/artigos` — o mesmo conjunto que o PR #9225 (o-jev) editou à mão:
 *
 *   1. `ARTICLES`            scripts/build-artigo-especial-teaser.ts
 *   2. `GATED_ARTICLES`      workers/artigos/src/gated-articles.ts (import + entrada)
 *   3. `run_worker_first`    workers/artigos/wrangler.toml (2 paths por artigo)
 *   4. lista de artigos      workers/artigos/public/index.html (topo da lista)
 *   5. sitemap               workers/artigos/public/sitemap.xml (+ lastmod da home)
 *
 * Os 3 primeiros são amarrados entre si por
 * `test/artigo-especial-registry-sync-9226.test.ts` (esquecer o toml vaza o
 * conteúdo pago sem alarme); os 2 últimos por `test/artigos-sitemap-5126.test.ts`.
 *
 * Cada função é PURA (texto → texto) e IDEMPOTENTE: rodar de novo com os
 * mesmos dados devolve o texto intacto (`changed: false`). Re-registro com
 * título/dek/data novos (o editor ajustou o rascunho) SUBSTITUI a entrada
 * do índice e atualiza o `lastmod` do sitemap — nunca para trás. Âncora
 * ausente → lança, nunca insere "em algum lugar". Slug já registrado em
 * OUTRO ano → lança: `{slug}-full.generated.ts` não tem ano no nome e
 * sobrescreveria o artigo do outro ano.
 */

import { escHtml } from "./html-escape.ts";

export interface RegisterArticle {
  slug: string;
  ano: string;
  titulo: string;
  dek: string;
  autor: string;
  /** "30 de setembro de 2026" */
  dataLonga: string;
  /** AAAA-MM-DD — datePublished. */
  data: string;
  /** AAAA-MM-DD — dateModified; vira o `lastmod` do sitemap. Default = data. */
  lastmod?: string;
}

export interface RegisterEdit {
  text: string;
  changed: boolean;
}

export class ArtigoEspecialRegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtigoEspecialRegisterError";
  }
}

/** "o-jev" → "O_JEV_FULL_HTML" — mesma regra de `exportConstName` do build script. */
export function fullHtmlConstName(slug: string): string {
  return `${slug.toUpperCase().replace(/-/g, "_")}_FULL_HTML`;
}

/** Pura: `{slug, year}` registrados em `ARTICLES`/`GATED_ARTICLES` (texto do arquivo). */
export function listRegisteredArticles(text: string): Array<{ slug: string; year: string }> {
  return [...text.matchAll(/\{\s*slug:\s*"([^"]+)",\s*year:\s*"(\d{4})"/g)].map((m) => ({ slug: m[1], year: m[2] }));
}

function assertNoYearConflict(text: string, a: { slug: string; ano: string }, file: string): boolean {
  const found = listRegisteredArticles(text).filter((r) => r.slug === a.slug);
  const other = found.find((r) => r.year !== a.ano);
  if (other) {
    throw new ArtigoEspecialRegisterError(
      `${file}: o slug "${a.slug}" já é do artigo de ${other.year} — escolha outro slug (${a.slug}-full.generated.ts sobrescreveria aquele artigo).`,
    );
  }
  return found.length > 0;
}

function insertBeforeArrayClose(text: string, arrayDecl: RegExp, line: string, file: string): string {
  const m = arrayDecl.exec(text);
  if (!m) throw new ArtigoEspecialRegisterError(`${file}: declaração do array não encontrada (${arrayDecl}).`);
  const start = m.index + m[0].length;
  const close = text.indexOf("\n];", start);
  if (close === -1) throw new ArtigoEspecialRegisterError(`${file}: fechamento "];" do array não encontrado.`);
  return `${text.slice(0, close)}\n${line}${text.slice(close)}`;
}

/** 1. `ARTICLES` em scripts/build-artigo-especial-teaser.ts. */
export function registerInArticlesList(text: string, a: Pick<RegisterArticle, "slug" | "ano">): RegisterEdit {
  if (assertNoYearConflict(text, a, "build-artigo-especial-teaser.ts")) return { text, changed: false };
  const line = `  { slug: "${a.slug}", year: "${a.ano}" },`;
  return {
    text: insertBeforeArrayClose(text, /export const ARTICLES: readonly ArticleConfig\[\] = \[/, line, "build-artigo-especial-teaser.ts"),
    changed: true,
  };
}

/** 2. import + entrada em `GATED_ARTICLES` (workers/artigos/src/gated-articles.ts). */
export function registerInGatedArticles(text: string, a: Pick<RegisterArticle, "slug" | "ano">): RegisterEdit {
  if (assertNoYearConflict(text, a, "gated-articles.ts")) return { text, changed: false };
  const constName = fullHtmlConstName(a.slug);
  const imports = [...text.matchAll(/^import \{ \w+ \} from "\.\/[\w-]+-full\.generated\.ts";$/gm)];
  if (imports.length === 0) throw new ArtigoEspecialRegisterError("gated-articles.ts: nenhum import de *-full.generated.ts para ancorar o novo.");
  const last = imports[imports.length - 1];
  const afterImport = last.index! + last[0].length;
  const withImport = `${text.slice(0, afterImport)}\nimport { ${constName} } from "./${a.slug}-full.generated.ts";${text.slice(afterImport)}`;
  const entry = `  { slug: "${a.slug}", year: "${a.ano}", fullHtml: ${constName} },`;
  return {
    text: insertBeforeArrayClose(withImport, /export const GATED_ARTICLES: readonly GatedArticle\[\] = \[/, entry, "gated-articles.ts"),
    changed: true,
  };
}

/** 3. os 2 paths em `run_worker_first` (workers/artigos/wrangler.toml). */
export function registerInWranglerToml(text: string, a: Pick<RegisterArticle, "slug" | "ano">): RegisterEdit {
  const base = `/${a.ano}/${a.slug}/`;
  const m = text.match(/^run_worker_first\s*=\s*\[([\s\S]*?)\n\]/m);
  if (!m) throw new ArtigoEspecialRegisterError("wrangler.toml: bloco run_worker_first = [ ... ] não encontrado.");
  const body = m[1];
  const wanted = [base, `${base}index.html`].filter((p) => !body.includes(`"${p}"`));
  if (wanted.length === 0) return { text, changed: false };
  const insertAt = m.index! + m[0].length - "\n]".length;
  const lines = wanted.map((p) => `\n  "${p}",`).join("");
  return { text: `${text.slice(0, insertAt)}${lines}${text.slice(insertAt)}`, changed: true };
}

function renderIndexItem(a: RegisterArticle): string {
  return `    <li>
      <h2><a href="/${a.ano}/${a.slug}/">${escHtml(a.titulo)}</a></h2>
      <p>${escHtml(a.dek)}</p>
      <div class="meta">Por ${escHtml(a.autor)} · ${escHtml(a.dataLonga)}</div>
    </li>`;
}

/** 4. item no TOPO da lista de `public/index.html` (mais recente primeiro); re-registro substitui o item no lugar. */
export function registerInIndexHtml(text: string, a: RegisterArticle): RegisterEdit {
  const href = `href="/${a.ano}/${a.slug}/"`;
  const item = renderIndexItem(a);
  const hrefIdx = text.indexOf(href);
  if (hrefIdx !== -1) {
    const liStart = text.lastIndexOf("    <li>", hrefIdx);
    const liEndTag = text.indexOf("</li>", hrefIdx);
    if (liStart === -1 || liEndTag === -1) throw new ArtigoEspecialRegisterError(`public/index.html: item de ${href} fora do formato <li> esperado.`);
    const liEnd = liEndTag + "</li>".length;
    if (text.slice(liStart, liEnd) === item) return { text, changed: false };
    return { text: `${text.slice(0, liStart)}${item}${text.slice(liEnd)}`, changed: true };
  }
  const anchor = '<ul class="article-list">';
  const idx = text.indexOf(anchor);
  if (idx === -1) throw new ArtigoEspecialRegisterError(`public/index.html: âncora ${anchor} não encontrada.`);
  const at = idx + anchor.length;
  return { text: `${text.slice(0, at)}\n${item}${text.slice(at)}`, changed: true };
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

/** 5. `<url>` logo depois da home no sitemap + `lastmod` da home; re-registro só AVANÇA o lastmod. */
export function registerInSitemap(text: string, a: Pick<RegisterArticle, "slug" | "ano" | "data" | "lastmod">): RegisterEdit {
  const loc = `https://especial.diar.ia.br/${a.ano}/${a.slug}/`;
  const lastmod = a.lastmod ?? a.data;
  const homeRe = /(<url>\s*<loc>https:\/\/especial\.diar\.ia\.br\/<\/loc>\s*<lastmod>)([^<]*)(<\/lastmod>\s*<\/url>)/;
  const home = homeRe.exec(text);
  if (!home) throw new ArtigoEspecialRegisterError("sitemap.xml: entrada da home (https://especial.diar.ia.br/) não encontrada.");
  const withHome = `${text.slice(0, home.index)}${home[1]}${maxDate(home[2], lastmod)}${home[3]}${text.slice(home.index + home[0].length)}`;

  const escLoc = loc.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const existing = new RegExp(`(<loc>${escLoc}</loc>\\s*<lastmod>)([^<]*)(</lastmod>)`).exec(withHome);
  let out: string;
  if (existing) {
    out = `${withHome.slice(0, existing.index)}${existing[1]}${maxDate(existing[2], lastmod)}${existing[3]}${withHome.slice(existing.index + existing[0].length)}`;
  } else {
    const h = homeRe.exec(withHome)!;
    const at = h.index + h[0].length;
    out = `${withHome.slice(0, at)}\n  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>${withHome.slice(at)}`;
  }
  return { text: out, changed: out !== text };
}
