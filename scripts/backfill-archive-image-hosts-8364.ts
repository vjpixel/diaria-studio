/**
 * scripts/backfill-archive-image-hosts-8364.ts (#8364)
 *
 * Aplica `rewriteLegacyPollWorkersDevImageHost` + `rewriteMigratedBeehiivImages`
 * diretamente nas páginas do acervo JÁ COMMITTED
 * (`workers/site/public/p/{slug}/index.html`) — mesmo racional de
 * `backfill-archive-dek-7921.ts`: regenerar via `gen-archive-pages.ts`
 * exigiria `data/beehiiv-cache/posts/*.json` (gitignored, só disponível numa
 * máquina com a junction do OneDrive, ver CLAUDE.md). Este script deriva a
 * correção a partir do HTML já servido, sem precisar do cache.
 *
 * Idempotente: rodar de novo sobre páginas já corrigidas não muda nada (as
 * duas funções de reescrita são no-op quando o host legado já sumiu). A
 * próxima regeneração REAL via `gen-archive-pages.ts` sempre sobrescreve
 * isto com o mesmo resultado — `buildArchivePageHtml` aplica as MESMAS duas
 * funções (ver `scripts/lib/site-archive-pages.ts`), então backfill e
 * geração nunca divergem.
 *
 * Duas partes independentes, uma sem custo/credencial e outra dependente do
 * mapa de migração:
 *   - `poll.diaria.workers.dev/img/` → `diar.ia.br/img/{key}`: troca cega de
 *     host, MESMO KV, sempre segura — não precisa de nenhuma credencial
 *     nem de rede. Roda e corrige de verdade toda vez.
 *   - `media.beehiiv.com` → `diar.ia.br/img/{key}`: só corrige as URLs já
 *     presentes em `archive-image-migration.json` (bytes já no KV real —
 *     ver `migrate-archive-beehiiv-images.ts`). Mapa vazio → nenhuma mudança
 *     nesta parte, sem erro.
 *
 * Uso:
 *   npx tsx scripts/backfill-archive-image-hosts-8364.ts [--dir workers/site/public/p] [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  ARCHIVE_BASE_URL,
  rewriteLegacyPollWorkersDevImageHost,
} from "./lib/site-archive-pages.ts";
import { loadArchiveImageMigrationMap, rewriteMigratedBeehiivImages } from "./lib/archive-image-migration.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = resolve(ROOT, "workers", "site", "public", "p");

export interface ImageHostBackfillResult {
  slug: string;
  changed: boolean;
}

/** Miolo puro — reusado pelo teste sem tocar disco. */
export function backfillImageHosts(
  html: string,
  map: Record<string, { key: string; alt: string }>,
): { html: string; changed: boolean } {
  let out = rewriteLegacyPollWorkersDevImageHost(html);
  out = rewriteMigratedBeehiivImages(out, map, ARCHIVE_BASE_URL);
  return { html: out, changed: out !== html };
}

export function backfillImageHostsDir(dir: string, dryRun: boolean): ImageHostBackfillResult[] {
  const map = loadArchiveImageMigrationMap().map;
  const results: ImageHostBackfillResult[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const slug = entry.name;
    const filePath = join(dir, slug, "index.html");
    if (!existsSync(filePath)) continue;
    const html = readFileSync(filePath, "utf8");
    const { html: rewritten, changed } = backfillImageHosts(html, map);
    if (changed && !dryRun) writeFileSync(filePath, rewritten, "utf8");
    results.push({ slug, changed });
  }
  return results;
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const dir = values["dir"] ? resolve(ROOT, values["dir"]) : DEFAULT_DIR;
  const dryRun = flags.has("dry-run") || values["dry-run"] === "true";
  const results = backfillImageHostsDir(dir, dryRun);
  const changed = results.filter((r) => r.changed).length;
  console.log(
    JSON.stringify({ total: results.length, changed, dry_run: dryRun }, null, 2),
  );
}

if (isMainModule(import.meta.url)) main();
