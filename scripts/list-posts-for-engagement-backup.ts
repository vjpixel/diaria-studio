/**
 * list-posts-for-engagement-backup.ts (#6465, fatia 1 do epic #6464)
 *
 * Enumera os posts que ainda faltam drenar via
 * `list_post_subscriber_engagement` MCP, atualizando (nunca substituindo)
 * o manifest de cobertura em `data/beehiiv-backup/subscriber-engagement/manifest.json`.
 * Esse manifest é o mecanismo de retomada — rodar isto de novo só reoferece
 * posts que ainda não estão `status: "ok"` (ver `scripts/lib/beehiiv-engagement-manifest.ts`).
 *
 * Fonte dos posts: um diretório de arquivos `{post_id}.json`, tipicamente
 * `data/beehiiv-backup/{date}/posts/` (produzido por `scripts/backup-beehiiv.ts`)
 * ou `data/beehiiv-cache/posts/` (produzido por `scripts/beehiiv-sync.ts`) —
 * ambos os shapes são tolerados por `extractPostRefFromBackupFile`. Sem
 * `--posts-dir` explícito, usa o backup mais recente sob `data/beehiiv-backup/`
 * (dir cujo nome bate `YYYY-MM-DD`, ordenado lexicograficamente).
 *
 * Este script é puramente de LEITURA local — nenhuma chamada MCP/rede.
 * Quem de fato drena via MCP é o agent `beehiiv-engagement-backup`, que
 * consome a lista impressa aqui no mesmo formato de input que
 * `beehiiv-clicks-enricher` já usa (`post_id=<id> title=<title>` por linha).
 *
 * Uso:
 *   npx tsx scripts/list-posts-for-engagement-backup.ts
 *   npx tsx scripts/list-posts-for-engagement-backup.ts --posts-dir data/beehiiv-cache/posts
 *   npx tsx scripts/list-posts-for-engagement-backup.ts --json   # emite JSON em vez de linhas post_id=...
 *
 * Output (stdout): por padrão, 1 linha `post_id=<id> title=<title>` por post
 * pendente (formato que o agent consome diretamente). Com `--json`, emite
 * `{ pending: [...], coverage: {...} }`.
 * Stderr: progresso.
 * Exit codes: 0=sucesso (mesmo com 0 pendentes — cobertura completa não é
 * erro), 1=erro de IO, 2=nenhum diretório de posts encontrado.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  buildInitialManifest,
  mergeManifestPosts,
  pendingEntries,
  coverageSummary,
  extractPostRefFromBackupFile,
  type EngagementManifest,
} from "./lib/beehiiv-engagement-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_ROOT = resolve(ROOT, "data/beehiiv-backup");
const ENGAGEMENT_DIR = resolve(BACKUP_ROOT, "subscriber-engagement");

/** Acha o subdiretório de backup mais recente cujo nome bate `YYYY-MM-DD` sob `data/beehiiv-backup/`. Pure dado o listing. */
export function latestBackupDateDir(entries: string[]): string | null {
  const dated = entries.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  return dated.length > 0 ? dated[dated.length - 1] : null;
}

/**
 * Lê todos os `.json` de `postsDir` e extrai `{id, title, neverSent}` — pula
 * arquivos que não têm `id` reconhecível. `neverSent` (post em rascunho, sem
 * `publish_date`) propaga pro manifest como `not_applicable`, #6465.
 */
export function discoverPostsFromDir(postsDir: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): Array<{ id: string; title?: string; neverSent?: boolean }> {
  const files = readdirSync(postsDir).filter((f) => f.endsWith(".json"));
  const out: Array<{ id: string; title?: string; neverSent?: boolean }> = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFile(resolve(postsDir, f))) as unknown;
      const ref = extractPostRefFromBackupFile(raw);
      if (ref) out.push(ref);
    } catch {
      // Arquivo ilegível/corrompido — pula, não aborta o scan inteiro.
    }
  }
  return out;
}

function loadManifest(manifestPath: string): EngagementManifest {
  if (!existsSync(manifestPath)) return buildInitialManifest([], new Date().toISOString());
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as EngagementManifest;
  } catch {
    return buildInitialManifest([], new Date().toISOString());
  }
}

function saveManifestAtomic(manifestPath: string, manifest: EngagementManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

function resolvePostsDir(explicit: string | undefined): string | null {
  if (explicit) return resolve(explicit);
  if (!existsSync(BACKUP_ROOT)) return null;
  const latest = latestBackupDateDir(readdirSync(BACKUP_ROOT));
  if (!latest) return null;
  const candidate = resolve(BACKUP_ROOT, latest, "posts");
  return existsSync(candidate) ? candidate : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const postsDirIdx = argv.indexOf("--posts-dir");
  const asJson = argv.includes("--json");

  const postsDir = resolvePostsDir(postsDirIdx !== -1 ? argv[postsDirIdx + 1] : undefined);
  if (!postsDir) {
    console.error(
      "[list-posts-for-engagement-backup] nenhum diretório de posts encontrado — " +
        "rode scripts/backup-beehiiv.ts primeiro, ou passe --posts-dir explícito.",
    );
    process.exit(2);
  }

  process.stderr.write(`[list-posts-for-engagement-backup] fonte: ${postsDir}\n`);
  const discovered = discoverPostsFromDir(postsDir);
  process.stderr.write(`[list-posts-for-engagement-backup] ${discovered.length} posts descobertos\n`);

  const manifestPath = resolve(ENGAGEMENT_DIR, "manifest.json");
  const existing = loadManifest(manifestPath);
  const merged = mergeManifestPosts(existing, discovered, new Date().toISOString());
  saveManifestAtomic(manifestPath, merged);

  const pending = pendingEntries(merged);
  const coverage = coverageSummary(merged);
  process.stderr.write(
    `[list-posts-for-engagement-backup] cobertura: ${coverage.ok}/${coverage.total} ok, ` +
      `${coverage.partial} partial, ${coverage.error} error, ${coverage.pending} pending, ` +
      `${coverage.not_applicable} n/a (nunca enviados)` +
      `${coverage.closed ? " — gap FECHADO" : ""}\n`,
  );

  if (asJson) {
    console.log(JSON.stringify({ pending, coverage }, null, 2));
    return;
  }
  for (const p of pending) {
    console.log(`post_id=${p.post_id} title=${p.title ?? "(sem título)"}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
