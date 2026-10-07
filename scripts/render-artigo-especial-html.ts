#!/usr/bin/env node
/**
 * scripts/render-artigo-especial-html.ts (#9099)
 *
 * Etapa D de `/diaria-artigo-especial` (produção): transforma o rascunho
 * aprovado `data/artigo-especial/{ano}-{slug}/draft.md` no artigo do Worker
 * e faz, de uma vez, o que o PR #9225 (o-jev) fez à mão:
 *
 *   1. escreve `workers/artigos/articles-src/{slug}.html`
 *      (`lib/artigo-especial-draft.ts`, CSS base tirado do artigo de
 *      referência — default: o último de `ARTICLES`);
 *   2. registra o artigo em ARTICLES, GATED_ARTICLES, run_worker_first,
 *      public/index.html e public/sitemap.xml
 *      (`lib/artigo-especial-register.ts`, idempotente);
 *   3. gera o teaser `public/{ano}/{slug}/index.html` e o
 *      `src/{slug}-full.generated.ts` — a mesma função do
 *      `build-artigo-especial-teaser.ts`, chamada só para este artigo;
 *   4. relê a fonte gerada com `parseArtigoMetaHtml` (o leitor que a
 *      divulgação usa depois) e falha se faltar og:url/og:image/lede.
 *
 * Não abre PR, não faz deploy, não publica nada — só escreve arquivos no
 * checkout. A capa (`public/{ano}/{slug}/capa.jpg`, 2:1) precisa existir
 * antes: sem ela o gate de registros (`artigo-especial-registry-sync-9226`)
 * reprova o PR; o script recusa seguir (exit 2) em vez de deixar o PR
 * nascer vermelho.
 *
 * Uso:
 *   npx tsx scripts/render-artigo-especial-html.ts --ano 2026 --slug o-jev
 *     [--reference o-jev]   artigo de onde vem o CSS base
 *     [--draft path]        default data/artigo-especial/{ano}-{slug}/draft.md
 *     [--dry-run]           valida e mostra o que mudaria, sem escrever
 *
 * Exit: 0 ok · 1 erro inesperado · 2 rascunho/entrada inválida (mensagem diz o quê)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  ArtigoEspecialDraftError,
  artigoUrl,
  extractBaseStyle,
  formatDataPt,
  parseArtigoEspecialDraft,
  renderArtigoEspecialHtml,
} from "./lib/artigo-especial-draft.ts";
import {
  ArtigoEspecialRegisterError,
  registerInArticlesList,
  registerInGatedArticles,
  registerInIndexHtml,
  registerInSitemap,
  registerInWranglerToml,
  type RegisterArticle,
} from "./lib/artigo-especial-register.ts";
import { parseArtigoMetaHtml } from "./lib/artigo-especial-meta.ts";
import { ARTICLES, buildArticleArtifacts, renderGeneratedTsModule } from "./build-artigo-especial-teaser.ts";

export class RenderArtigoGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderArtigoGuardError";
  }
}

export interface RenderArtigoOptions {
  /** Raiz do repo (injetável pra teste rodar numa cópia temporária). */
  root: string;
  ano: string;
  slug: string;
  draftPath?: string;
  /** Slug do artigo de referência do CSS base. Default: último de ARTICLES. */
  reference?: string;
  dryRun?: boolean;
}

export interface RenderArtigoResult {
  sourcePath: string;
  url: string;
  /** Arquivos que mudaram (ou mudariam, em dry-run), relativos à raiz. */
  changed: string[];
  leadParagraphs: string[];
}

function rel(root: string, p: string): string {
  return p.slice(root.length + 1).replace(/\\/g, "/");
}

export function runRenderArtigoEspecialHtml(opts: RenderArtigoOptions): RenderArtigoResult {
  const { root, ano, slug } = opts;
  const worker = resolve(root, "workers", "artigos");
  const draftPath = opts.draftPath ?? resolve(root, "data", "artigo-especial", `${ano}-${slug}`, "draft.md");
  if (!existsSync(draftPath)) throw new RenderArtigoGuardError(`rascunho ausente: ${draftPath}`);

  const draft = parseArtigoEspecialDraft(readFileSync(draftPath, "utf8"));
  if (draft.meta.slug !== slug || draft.meta.ano !== ano) {
    throw new RenderArtigoGuardError(
      `frontmatter diz ${draft.meta.ano}/${draft.meta.slug}, a chamada pediu ${ano}/${slug} — alinhe os dois (o slug vira URL pública).`,
    );
  }

  const reference = opts.reference ?? ARTICLES[ARTICLES.length - 1].slug;
  if (reference === slug) throw new RenderArtigoGuardError("--reference não pode ser o próprio artigo (o CSS base vem de um artigo já publicado).");
  const refPath = resolve(worker, "articles-src", `${reference}.html`);
  if (!existsSync(refPath)) throw new RenderArtigoGuardError(`artigo de referência ausente: ${refPath}`);
  const html = renderArtigoEspecialHtml(draft, extractBaseStyle(readFileSync(refPath, "utf8")));

  // Auto-conferência com o MESMO leitor que a divulgação usa depois.
  const meta = parseArtigoMetaHtml(html);
  const url = artigoUrl(ano, slug);
  if (meta.url !== url || !meta.image || meta.leadParagraphs.length === 0 || meta.title !== draft.meta.titulo) {
    throw new RenderArtigoGuardError(`HTML gerado não passa no leitor de metadados (url=${meta.url}, image=${meta.image}, lede=${meta.leadParagraphs.length}).`);
  }

  const publicDir = resolve(worker, "public", ano, slug);
  const capa = resolve(publicDir, draft.meta.capa);
  if (!existsSync(capa)) {
    throw new RenderArtigoGuardError(
      `capa ausente: ${rel(root, capa)} — gere a imagem 2:1 (Van Gogh impasto, ver Etapa D da skill) e salve aí antes de rodar.`,
    );
  }

  const article = { slug, year: ano };
  const artifacts = buildArticleArtifacts(html, article);
  const reg: RegisterArticle = {
    slug,
    ano,
    titulo: draft.meta.titulo,
    dek: draft.meta.dek,
    autor: draft.meta.autor,
    dataLonga: formatDataPt(draft.meta.data).longa,
    data: draft.meta.data,
  };

  const writes: Array<{ path: string; content: string }> = [
    { path: resolve(worker, "articles-src", `${slug}.html`), content: html },
    { path: resolve(publicDir, "index.html"), content: artifacts.teaser },
    { path: resolve(worker, "src", `${slug}-full.generated.ts`), content: renderGeneratedTsModule(article, artifacts.full) },
  ];
  const edits: Array<{ path: string; apply: (t: string) => { text: string; changed: boolean } }> = [
    { path: resolve(root, "scripts", "build-artigo-especial-teaser.ts"), apply: (t) => registerInArticlesList(t, reg) },
    { path: resolve(worker, "src", "gated-articles.ts"), apply: (t) => registerInGatedArticles(t, reg) },
    { path: resolve(worker, "wrangler.toml"), apply: (t) => registerInWranglerToml(t, reg) },
    { path: resolve(worker, "public", "index.html"), apply: (t) => registerInIndexHtml(t, reg) },
    { path: resolve(worker, "public", "sitemap.xml"), apply: (t) => registerInSitemap(t, reg) },
  ];

  const changed: string[] = [];
  const pending: Array<{ path: string; content: string }> = [];
  for (const w of writes) {
    const before = existsSync(w.path) ? readFileSync(w.path, "utf8") : null;
    if (before !== w.content) pending.push(w);
  }
  // Calcula TODAS as edições antes de gravar qualquer uma — âncora quebrada
  // num arquivo não deixa os outros meio registrados.
  for (const e of edits) {
    const { text, changed: c } = e.apply(readFileSync(e.path, "utf8"));
    if (c) pending.push({ path: e.path, content: text });
  }
  for (const p of pending) changed.push(rel(root, p.path));

  if (!opts.dryRun) {
    for (const p of pending) {
      mkdirSync(dirname(p.path), { recursive: true });
      writeFileSync(p.path, p.content, "utf8");
    }
  }
  return { sourcePath: writes[0].path, url, changed, leadParagraphs: meta.leadParagraphs };
}

function main(): void {
  const argv = process.argv.slice(2);
  const ano = getStringArg(argv, "ano", { example: "2026" });
  const slug = getStringArg(argv, "slug", { example: "o-jev" });
  if (!ano || !slug) {
    console.error("Uso: npx tsx scripts/render-artigo-especial-html.ts --ano AAAA --slug slug [--reference slug] [--draft path] [--dry-run]");
    process.exit(2);
  }
  const root = resolve(import.meta.dirname, "..");
  const draftArg = getStringArg(argv, "draft", { example: "data/artigo-especial/2026-o-jev/draft.md" });
  try {
    const r = runRenderArtigoEspecialHtml({
      root,
      ano,
      slug,
      draftPath: draftArg ? resolve(root, draftArg) : undefined,
      reference: getStringArg(argv, "reference", { example: "o-jev" }),
      dryRun: hasFlag(argv, "dry-run"),
    });
    const verb = hasFlag(argv, "dry-run") ? "mudaria" : "mudou";
    console.log(`OK — ${r.url}`);
    console.log(`${r.changed.length} arquivo(s) ${verb}:`);
    for (const c of r.changed) console.log(`  ${c}`);
    console.log(`lede lido de volta: "${r.leadParagraphs[0].slice(0, 100)}…"`);
  } catch (e) {
    const guard = e instanceof RenderArtigoGuardError || e instanceof ArtigoEspecialDraftError || e instanceof ArtigoEspecialRegisterError;
    console.error(`${guard ? "ERRO" : "ERRO inesperado"}: ${(e as Error).message}`);
    process.exit(guard ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) main();
