/**
 * no-arrow-glyph-scan.ts (#9721): varredura do check de CI
 * `scripts/check-no-arrow-glyph.ts` ("nunca a seta `→` em botão, link, CTA
 * ou copy que chega ao leitor"), estendido à seta `←` em #9723 (links de
 * volta/anterior; a detecção vem de `arrowFormsRegex`, que cobre as duas
 * setas e as formas escapadas `&larr;`/`&#8592;`/`&#x2190;`/`\u2190`).
 *
 * Três superfícies, cada uma com um critério:
 *
 *  1. HTML/CSS/JS publicados (`TEXT_ROOTS`): qualquer `→` no arquivo conta,
 *     inclusive em comentário (`_redirects` incluso). O critério é o arquivo
 *     inteiro porque é o que vai pro ar.
 *  2. Geradores/templates do site e da newsletter (`GENERATOR_SPECS`): só os
 *     literais de string/template contam (AST do TypeScript). Comentários e
 *     regex ficam de fora: seta em comentário de código é documentação
 *     técnica interna, fora do escopo da issue.
 *  3. Caixas da newsletter (`data/snippets/`, gitignored e ausente no CI):
 *     varridas quando existem; ausentes, o check só avisa (fail-soft). O
 *     header `<!-- ... -->` não chega ao leitor e é ignorado; `_arquivo/`
 *     (caixas aposentadas) também. Em runtime, `readSnippetFile` já remove a
 *     seta nas posições de CTA (`scripts/lib/shared/arrow-glyph.ts`).
 *
 * Exceção contextual (#9743): nos HTML publicados, `←` no início do rótulo de
 * um `<a rel="prev">` e `→` no fim do de um `<a rel="next">` (nav entre
 * edições e paginação do acervo) passam (`maskSiteNavArrows`). Nos geradores
 * não há exceção: a seta vem de `navPrevLinkText`/`navNextLinkText`.
 *
 * Exceções: `ALLOWLIST`, por arquivo + trecho EXATO. Hoje só texto editorial
 * de edições antigas (corpo de destaque, não UI) que cita a seta como
 * notação. Entrada cujo trecho sumiu do arquivo é reportada como obsoleta,
 * pra lista não apodrecer.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import ts from "typescript";
import { arrowFormsRegex, arrowHitAt, findArrowGlyphs, hasArrowForm } from "./shared/arrow-glyph.ts";

/** Diretórios publicados como estão (assets estáticos de Workers). */
export const TEXT_ROOTS: readonly string[] = [
  "workers/site/public",
  "workers/cursos/public",
  "workers/livros/public",
];

const TEXT_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".txt", ".xml", ".json", ".svg", ".webmanifest", ".md"]);
const TEXT_BASENAMES = new Set(["_redirects", "_headers"]);

/**
 * Geradores/templates cujo OUTPUT chega ao leitor. Entrada é um path exato
 * ou `dir/padrão` com UM `*` no nome do arquivo (sem recursão).
 */
export const GENERATOR_SPECS: readonly string[] = [
  // newsletter (e-mail) e caixas geradas
  "scripts/lib/newsletter-render-html.ts",
  "scripts/lib/shared/hub-divulgacao-box.ts",
  // mensal/anual: `→ [texto](url)` no draft é marcador de ENTRADA (vira
  // botão e a seta some no render); o que se guarda aqui é o output
  "scripts/lib/mensal/monthly-render.ts",
  "scripts/lib/mensal/build-article-page.ts",
  "scripts/lib/anual/annual-render.ts",
  // site diar.ia.br (home, acervo, páginas de edição, assinar, cupom, feed)
  "scripts/lib/site-*.ts",
  "scripts/lib/edition-site-page.ts",
  "scripts/publish-edition-site-page.ts",
  // páginas de confirmação e hubs temáticos (arquivo.diar.ia.br)
  "scripts/lib/shared/confirmado-page.ts",
  "scripts/lib/shared/hub-index-page.ts",
  "scripts/lib/hubs/*.ts",
  "workers/arquivo/src/hubs/*.generated.ts",
  // cursos/livros
  "scripts/build-cursos-page.ts",
  "scripts/build-livros-page.ts",
  "workers/cursos/src/*.generated.ts",
  // Workers que servem HTML/copy direto ao leitor (#9727 resíduo b): É IA?
  // (jogo, embed, ranking, confirmação), artigos especiais, retrospectiva,
  // reativação e acervo. Só literais contam (ver `scanGeneratorSource`).
  "workers/poll/src/*.ts",
  "workers/artigos/src/*.ts",
  "workers/retrospectiva/src/*.ts",
  "workers/reativar/src/*.ts",
  "workers/arquivo/src/*.ts",
  // copy social
  "scripts/lib/weekly-linkedin-render.ts",
];

export const SNIPPETS_DIR = "data/snippets";

export interface AllowEntry {
  path: string;
  /** Trecho exato, contendo a seta. */
  fragment: string;
  reason: string;
}

const EDITORIAL = "texto editorial do corpo de uma edição antiga (notação, não botão/link/CTA); preservado verbatim no acervo";

export const ALLOWLIST: readonly AllowEntry[] = [
  {
    path: "workers/site/public/p/ia-cria-ideias-novas-ou-so-recombina-existentes/index.html",
    fragment: "se Merge suceder → mais usuários para a OpenAI → investimento",
    reason: EDITORIAL,
  },
  {
    path: "workers/site/public/p/avalanche-de-desenhos-de-ia-para-bebe-s/index.html",
    fragment: "ChatGPT → letras repetitivas (&quot;la la&quot;, &quot;na na&quot;) → gerador de vídeo IA → animações",
    reason: EDITORIAL,
  },
  {
    path: "workers/site/public/p/agora-qualquer-fone-pode-ser-um-tradutor-ao-vivo/index.html",
    fragment: "Clique em <b>→</b>.",
    reason: `${EDITORIAL}; o tutorial manda clicar no botão "→" do app de terceiro`,
  },
  {
    path: "workers/site/public/p/va-o-surgir-novos-cios-no-governo/index.html",
    fragment: "87% do tráfego global → <b>68%</b>",
    reason: EDITORIAL,
  },
  {
    path: "workers/site/public/p/va-o-surgir-novos-cios-no-governo/index.html",
    fragment: "Gemini: 5,4% → <b>18%</b>",
    reason: EDITORIAL,
  },
];

export type FindingKind = "published" | "generator" | "snippet" | "stale-allowlist" | "missing-generator";

export interface Finding {
  kind: FindingKind;
  path: string;
  line: number;
  col: number;
  context: string;
}

/** Seta em qualquer lugar do arquivo publicado, menos os trechos liberados. */
export function scanPublishedText(path: string, content: string, allowlist: readonly AllowEntry[] = ALLOWLIST): Finding[] {
  const frags = allowlist.filter((a) => a.path === path).map((a) => a.fragment);
  // #9743: a seta de direção da nav do site (`← Anterior`, `Próxima →`) passa
  return findArrowGlyphs(content, frags, { allowSiteNavArrows: true }).map((h) => ({ kind: "published" as const, path, ...h }));
}

/**
 * Seta só dentro de literais de string/template (o que vira HTML/copy).
 * Comentários e regex (`/^→\s*\/u`, que aceita a sintaxe legada na
 * ENTRADA e a remove) não contam.
 */
export function scanGeneratorSource(path: string, source: string): Finding[] {
  if (!hasArrowForm(source)) return [];
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      ts.isJsxText(node)
    ) {
      const start = node.getStart(sf);
      const raw = source.slice(start, node.getEnd());
      // `→` literal e as formas escapadas (`&rarr;`, `\u2192`…, #9727 resíduo a)
      for (const m of raw.matchAll(arrowFormsRegex())) {
        out.push({ kind: "generator", path, ...arrowHitAt(source, start + m.index) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Caixa: o header `<!-- ... -->` não chega ao leitor (é removido no load). */
export function scanSnippet(path: string, content: string): Finding[] {
  // Troca o comentário por espaços (preservando quebras) pra manter linha/coluna.
  const visible = content.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  return findArrowGlyphs(visible).map((h) => ({
    kind: "snippet" as const,
    path,
    ...h,
    context: arrowHitAt(content, indexOf(content, h.line, h.col)).context,
  }));
}

function indexOf(text: string, line: number, col: number): number {
  let idx = 0;
  for (let l = 1; l < line; l++) idx = text.indexOf("\n", idx) + 1;
  return idx + col - 1;
}

/** Entradas da allowlist cujo trecho não está mais no arquivo. */
export function staleAllowlistEntries(
  readFile: (path: string) => string | null,
  allowlist: readonly AllowEntry[] = ALLOWLIST,
): Finding[] {
  return allowlist
    .filter((a) => {
      const content = readFile(a.path);
      return content === null || !content.includes(a.fragment);
    })
    .map((a) => ({ kind: "stale-allowlist" as const, path: a.path, line: 0, col: 0, context: a.fragment }));
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function walk(dir: string, skipDirNames: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (skipDirNames.has(name) || name === "node_modules") continue;
      out.push(...walk(full, skipDirNames));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function isPublishedTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || TEXT_BASENAMES.has(basename(path));
}

/**
 * Resolve `GENERATOR_SPECS` em paths relativos existentes. Spec que não
 * resolve nada (arquivo renomeado/removido, glob vazio) vai em `missing`:
 * um gerador que some da varredura em silêncio desarmaria o guard.
 */
export function resolveGeneratorFiles(
  rootDir: string,
  specs: readonly string[] = GENERATOR_SPECS,
): { files: string[]; missing: string[] } {
  const out: string[] = [];
  const missing: string[] = [];
  for (const spec of specs) {
    const slash = spec.lastIndexOf("/");
    const dir = spec.slice(0, slash);
    const pattern = spec.slice(slash + 1);
    if (!pattern.includes("*")) {
      if (existsSync(join(rootDir, spec))) out.push(spec);
      else missing.push(spec);
      continue;
    }
    const abs = join(rootDir, dir);
    const [pre, post] = pattern.split("*", 2);
    const matched = existsSync(abs)
      ? readdirSync(abs)
          .sort()
          .filter((name) => name.startsWith(pre) && name.endsWith(post) && statSync(join(abs, name)).isFile())
      : [];
    if (matched.length === 0) missing.push(spec);
    for (const name of matched) out.push(`${dir}/${name}`);
  }
  return { files: [...new Set(out)], missing };
}

export interface ScanResult {
  findings: Finding[];
  scannedPublished: number;
  scannedGenerators: number;
  scannedSnippets: number;
  /** `false` quando `data/snippets/` não existe (CI, clone fresco). */
  snippetsPresent: boolean;
}

export interface ScanRepoOptions {
  /**
   * `false` pula `data/snippets/` (conteúdo do editor, gitignored) e varre só
   * o que é versionado. Default `true`: o check de CLI segue varrendo as
   * caixas quando existem. Os testes que afirmam "o repo real está limpo"
   * passam `false` pra não depender do `data/` montado na máquina (#9739).
   */
  includeSnippets?: boolean;
}

export function scanRepo(rootDir: string, opts: ScanRepoOptions = {}): ScanResult {
  const includeSnippets = opts.includeSnippets ?? true;
  const findings: Finding[] = [];
  let scannedPublished = 0;
  for (const root of TEXT_ROOTS) {
    const abs = join(rootDir, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (!isPublishedTextFile(file)) continue;
      scannedPublished++;
      findings.push(...scanPublishedText(toPosix(relative(rootDir, file)), readFileSync(file, "utf8")));
    }
  }
  const { files: generators, missing } = resolveGeneratorFiles(rootDir);
  for (const spec of missing) findings.push({ kind: "missing-generator", path: spec, line: 0, col: 0, context: spec });
  for (const rel of generators) {
    findings.push(...scanGeneratorSource(rel, readFileSync(join(rootDir, rel), "utf8")));
  }
  const snippetsAbs = join(rootDir, SNIPPETS_DIR);
  const snippetsPresent = includeSnippets && existsSync(snippetsAbs);
  let scannedSnippets = 0;
  if (snippetsPresent) {
    for (const file of walk(snippetsAbs, new Set(["_arquivo"]))) {
      if (extname(file).toLowerCase() !== ".md") continue;
      scannedSnippets++;
      findings.push(...scanSnippet(toPosix(relative(rootDir, file)), readFileSync(file, "utf8")));
    }
  }
  findings.push(
    ...staleAllowlistEntries((p) => {
      const abs = join(rootDir, p);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    }),
  );
  return { findings, scannedPublished, scannedGenerators: generators.length, scannedSnippets, snippetsPresent };
}
