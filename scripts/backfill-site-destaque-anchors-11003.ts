/**
 * scripts/backfill-site-destaque-anchors-11003.ts (#11003)
 *
 * Leva as âncoras `#d1..#d3` (e o script do modal que não abre na chegada)
 * às páginas de edição JÁ publicadas em `workers/site/public/p/{slug}/
 * index.html`. Páginas novas já saem com as duas coisas de
 * `buildArchivePageHtml`; este script cobre as que foram escritas antes.
 *
 * Só mexe em página cujo formato é reconhecido (manchetes `headline` do
 * render atual — hoje as ~49 edições publicadas pelo backend Kit). O acervo
 * Beehiiv (formato antigo, sem manchete reconhecível) fica intocado. A troca
 * de script e a âncora andam juntas, ou nenhuma (ver
 * `backfillDestaqueAnchors` em `scripts/lib/site-destaque-anchors.ts`).
 *
 * Idempotente. As páginas são estáticas do Worker `diaria-site`: o efeito no
 * ar depende do deploy, que roda sozinho no push para o master.
 *
 * Uso:
 *   npx tsx scripts/backfill-site-destaque-anchors-11003.ts [--dir workers/site/public/p] [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { backfillDestaqueAnchors } from "./lib/site-destaque-anchors.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = resolve(ROOT, "workers", "site", "public", "p");

export interface AnchorBackfillPageResult {
  slug: string;
  outcome: "backfilled" | "sem-manchetes" | "sem-script-do-modal" | "ja-atualizada";
}

export function backfillDestaqueAnchorsDir(dir: string, dryRun: boolean): AnchorBackfillPageResult[] {
  const results: AnchorBackfillPageResult[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const filePath = join(dir, entry.name, "index.html");
    if (!existsSync(filePath)) continue;
    const r = backfillDestaqueAnchors(readFileSync(filePath, "utf8"));
    if (r.changed) {
      if (!dryRun) writeFileSync(filePath, r.html);
      results.push({ slug: entry.name, outcome: "backfilled" });
    } else {
      results.push({ slug: entry.name, outcome: r.skipped ?? "ja-atualizada" });
    }
  }
  return results;
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const dir = values["dir"] ? resolve(ROOT, values["dir"]) : DEFAULT_DIR;
  // Flag bare cai em `flags`, não em `values` (mesma armadilha registrada em
  // backfill-archive-dek-7921.ts).
  const dryRun = flags.has("dry-run") || values["dry-run"] === "true";
  const results = backfillDestaqueAnchorsDir(dir, dryRun);
  const count = (o: AnchorBackfillPageResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  const summary = {
    total: results.length,
    backfilled: count("backfilled"),
    ja_atualizada: count("ja-atualizada"),
    sem_manchetes: count("sem-manchetes"),
    sem_script_do_modal: count("sem-script-do-modal"),
    dry_run: dryRun,
  };
  console.log(JSON.stringify(summary, null, 2));
  // Página com manchete mas sem o script do modal reconhecível é anomalia:
  // fica sem âncora (de propósito) e merece olho humano.
  if (summary.sem_script_do_modal > 0) {
    console.error(
      `[backfill-anchors] ${summary.sem_script_do_modal} página(s) com manchetes mas sem o script do modal reconhecível — ficaram sem âncora: ` +
        results.filter((r) => r.outcome === "sem-script-do-modal").map((r) => r.slug).join(", "),
    );
  }
}

if (isMainModule(import.meta.url)) main();
