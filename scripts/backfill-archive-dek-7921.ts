/**
 * scripts/backfill-archive-dek-7921.ts (#7921)
 *
 * Injeta `<meta name="dek">` (introduzido por `buildArchivePageHtml`,
 * `scripts/lib/site-archive-pages.ts`, #7921) nas páginas do acervo
 * (`workers/site/public/p/{slug}/index.html`) que já estavam COMMITTED
 * antes dessa mudança. Regenerar via `gen-archive-pages.ts` exigiria
 * `data/beehiiv-cache/posts/*.json` (gitignored — não disponível fora de
 * uma máquina com a junction do OneDrive, ver CLAUDE.md §2b) — este script
 * deriva a dek a partir do que JÁ ESTÁ no HTML committed, sem precisar do
 * cache: `<title>` (D1) + `<meta name="description">` (D1 + D2|D3, #6281).
 *
 * Só age quando a description bate EXATAMENTE `${title}. ${resto}` sem
 * sinal de truncamento (`truncateDescription`, em `site-archive-pages.ts`,
 * acrescenta "…" quando corta em ~155 chars) — nesse caso o "resto"
 * recuperado É o D2|D3 original, sem perda. Quando a description foi
 * truncada, ou não bate esse prefixo (edição só com D1, sem D2/D3;
 * description veio de `meta_default_description`/fallback genérico), PULA a
 * página — fica sem `<meta name="dek">`, mesmo fallback `""` que
 * `extractPageDek`/`buildHomeFeed` já tratam sem quebrar. Nunca grava uma
 * dek corrompida/cortada no meio.
 *
 * A próxima regeneração REAL e completa via `gen-archive-pages.ts` (com
 * `data/beehiiv-cache/` disponível) sempre sobrescreve isto com a dek
 * derivada da fonte (`deriveDek`, determinística e sempre correta) — este
 * backfill é só ponte pra não deixar a home inteira sem dek nenhuma até essa
 * regeneração completa rodar numa máquina com acesso a `data/`.
 *
 * Idempotente: página que já tem `<meta name="dek">` é pulada (não
 * sobrescreve).
 *
 * Uso:
 *   npx tsx scripts/backfill-archive-dek-7921.ts [--dir workers/site/public/p] [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = resolve(ROOT, "workers", "site", "public", "p");

/**
 * Deriva a dek (D2|D3) de uma página já renderizada, a partir só do
 * `<title>`/`<meta name="description">` que ela já carrega — ver docstring
 * do módulo pro critério exato (`null` sempre que a recuperação não é
 * 100% confiável, nunca um valor parcial/truncado).
 */
export function deriveDekFromRenderedPage(html: string): string | null {
  if (/<meta\s+name=["']dek["']/i.test(html)) return null; // já tem — chamador decide pular
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  if (!titleMatch || !descMatch) return null;
  const title = titleMatch[1];
  const description = descMatch[1];
  if (description.endsWith("…")) return null; // truncateDescription cortou — resto não é confiável
  const prefix = `${title}. `;
  if (!description.startsWith(prefix)) return null; // sem D2/D3, ou description não é ownEditionDescription
  const rest = description.slice(prefix.length).trim();
  return rest || null;
}

/**
 * Injeta `<meta name="dek" content="...">` logo após `<meta
 * name="description">` — mesmo ponto de injeção de `buildArchivePageHtml`.
 * `html` sem `<meta name="description">` (nunca deveria acontecer numa
 * página já gerada) passa intocado.
 */
export function injectDekMeta(html: string, dek: string): string {
  const descRe = /<meta\s+name=["']description["']\s+content=["'][^"']*["']>/i;
  const match = html.match(descRe);
  if (!match) return html;
  return html.replace(descRe, `${match[0]}<meta name="dek" content="${dek}">`);
}

export interface BackfillResult {
  slug: string;
  outcome: "backfilled" | "skipped_has_dek" | "skipped_unrecoverable";
}

export function backfillDir(dir: string, dryRun: boolean): BackfillResult[] {
  const results: BackfillResult[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const slug = entry.name;
    const filePath = join(dir, slug, "index.html");
    if (!existsSync(filePath)) continue;
    const html = readFileSync(filePath, "utf8");
    if (/<meta\s+name=["']dek["']/i.test(html)) {
      results.push({ slug, outcome: "skipped_has_dek" });
      continue;
    }
    const dek = deriveDekFromRenderedPage(html);
    if (!dek) {
      results.push({ slug, outcome: "skipped_unrecoverable" });
      continue;
    }
    if (!dryRun) writeFileSync(filePath, injectDekMeta(html, dek));
    results.push({ slug, outcome: "backfilled" });
  }
  return results;
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const dir = values["dir"] ? resolve(ROOT, values["dir"]) : DEFAULT_DIR;
  // `--dry-run` é um FLAG bare (sem valor) — `parseArgs` o registra em
  // `flags`, nunca em `values` (achado ao vivo rodando este script: checar
  // `values["dry-run"]` é sempre `undefined`/falsy pra um flag bare, então
  // `--dry-run` nunca tinha efeito — a 1ª chamada "--dry-run" desta issue já
  // escreveu de verdade). `--dry-run=true`/`--dry-run true` (forma com
  // valor) também funciona por compat, mas o flag bare é o caso normal.
  const dryRun = flags.has("dry-run") || values["dry-run"] === "true";
  const results = backfillDir(dir, dryRun);
  const backfilled = results.filter((r) => r.outcome === "backfilled").length;
  const hasDek = results.filter((r) => r.outcome === "skipped_has_dek").length;
  const unrecoverable = results.filter((r) => r.outcome === "skipped_unrecoverable").length;
  console.log(
    JSON.stringify(
      { total: results.length, backfilled, skipped_has_dek: hasDek, skipped_unrecoverable: unrecoverable, dry_run: dryRun },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) main();
