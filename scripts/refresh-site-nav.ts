/**
 * refresh-site-nav.ts (#13323)
 *
 * Propaga uma mudança nos itens do menu global (`NAV_ITEM_DEFS`,
 * `scripts/lib/shared/site-nav.ts`) para as páginas HTML já commitadas que
 * carregam o menu: as `/p/{slug}` e demais páginas de `workers/site/public`,
 * e as páginas estáticas dos hosts irmãos (`workers/artigos`, `cursos`,
 * `livros`). `injectSiteNavAfterBodyOpen` nunca reinjeta numa página que já
 * tem o menu, então sem este passo um item novo só aparecia nas páginas
 * regeneradas depois da mudança.
 *
 * Só o miolo do `<div class="dnav-links">` é reescrito (`refreshSiteNavLinks`),
 * com o item ativo e o `apexBase` inferidos da própria página. Idempotente:
 * rodar de novo sem mudança no menu não grava nada.
 *
 * Uso:
 *   npx tsx scripts/refresh-site-nav.ts [--root workers] [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { refreshSiteNavLinks, SITE_NAV_MARKER } from "./lib/shared/site-nav.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set(["node_modules", ".wrangler", ".git"]);

/** Lista os `.html` sob `dir`, recursivo, pulando dependências e caches. */
export function listHtmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...listHtmlFiles(path));
    else if (name.endsWith(".html")) out.push(path);
  }
  return out;
}

export interface RefreshSiteNavResult {
  scanned: number;
  withNav: number;
  changed: string[];
}

/** Reescreve o menu de toda página com `SITE_NAV_MARKER` sob `rootDir`. */
export function refreshSiteNavUnder(rootDir: string, opts: { dryRun?: boolean } = {}): RefreshSiteNavResult {
  const files = listHtmlFiles(rootDir);
  const changed: string[] = [];
  let withNav = 0;
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    if (!html.includes(SITE_NAV_MARKER)) continue;
    withNav++;
    const next = refreshSiteNavLinks(html);
    if (next === html) continue;
    changed.push(file);
    if (!opts.dryRun) writeFileSync(file, next, "utf8");
  }
  return { scanned: files.length, withNav, changed };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const rootDir = resolve(ROOT, values["root"] ?? "workers");
  const dryRun = flags.has("dry-run");
  const r = refreshSiteNavUnder(rootDir, { dryRun });
  for (const f of r.changed) console.log(`${dryRun ? "mudaria" : "atualizado"}: ${relative(ROOT, f)}`);
  console.log(
    `refresh-site-nav: ${r.changed.length}/${r.withNav} páginas com menu ${dryRun ? "mudariam" : "atualizadas"} (${r.scanned} .html varridos em ${relative(ROOT, rootDir) || "."})`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
