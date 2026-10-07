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
 * Cada função é PURA (texto → texto) e IDEMPOTENTE: rodar de novo pro mesmo
 * slug devolve o texto intacto (`changed: false`). Âncora ausente → lança,
 * nunca insere "em algum lugar" — o arquivo mudou de forma e precisa de
 * olho humano, não de um palpite.
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
  /** AAAA-MM-DD */
  data: string;
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
  if (new RegExp(`slug:\\s*"${a.slug}"`).test(text)) return { text, changed: false };
  const line = `  { slug: "${a.slug}", year: "${a.ano}" },`;
  return {
    text: insertBeforeArrayClose(text, /export const ARTICLES: readonly ArticleConfig\[\] = \[/, line, "build-artigo-especial-teaser.ts"),
    changed: true,
  };
}

/** 2. import + entrada em `GATED_ARTICLES` (workers/artigos/src/gated-articles.ts). */
export function registerInGatedArticles(text: string, a: Pick<RegisterArticle, "slug" | "ano">): RegisterEdit {
  const constName = fullHtmlConstName(a.slug);
  if (new RegExp(`slug:\\s*"${a.slug}"`).test(text)) return { text, changed: false };
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

/** 4. item no TOPO da lista de `public/index.html` (mais recente primeiro). */
export function registerInIndexHtml(text: string, a: RegisterArticle): RegisterEdit {
  const href = `/${a.ano}/${a.slug}/`;
  if (text.includes(`href="${href}"`)) return { text, changed: false };
  const anchor = '<ul class="article-list">';
  const idx = text.indexOf(anchor);
  if (idx === -1) throw new ArtigoEspecialRegisterError(`public/index.html: âncora ${anchor} não encontrada.`);
  const item = `
    <li>
      <h2><a href="${href}">${escHtml(a.titulo)}</a></h2>
      <p>${escHtml(a.dek)}</p>
      <div class="meta">Por ${escHtml(a.autor)} · ${escHtml(a.dataLonga)}</div>
    </li>`;
  const at = idx + anchor.length;
  return { text: `${text.slice(0, at)}${item}${text.slice(at)}`, changed: true };
}

/** 5. `<url>` logo depois da home no sitemap + `lastmod` da home atualizado. */
export function registerInSitemap(text: string, a: Pick<RegisterArticle, "slug" | "ano" | "data">): RegisterEdit {
  const loc = `https://especial.diar.ia.br/${a.ano}/${a.slug}/`;
  if (text.includes(`<loc>${loc}</loc>`)) return { text, changed: false };
  const homeRe = /(<url>\s*<loc>https:\/\/especial\.diar\.ia\.br\/<\/loc>\s*<lastmod>)([^<]*)(<\/lastmod>\s*<\/url>)/;
  const m = homeRe.exec(text);
  if (!m) throw new ArtigoEspecialRegisterError("sitemap.xml: entrada da home (https://especial.diar.ia.br/) não encontrada.");
  const home = `${m[1]}${a.data > m[2] ? a.data : m[2]}${m[3]}`;
  const entry = `\n  <url>\n    <loc>${loc}</loc>\n    <lastmod>${a.data}</lastmod>\n  </url>`;
  return { text: `${text.slice(0, m.index)}${home}${entry}${text.slice(m.index + m[0].length)}`, changed: true };
}
