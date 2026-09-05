/**
 * fix-engagement-fabricated-titles.ts (#7460, residual do #7181/#7172, item 4)
 *
 * Decisão registrada (#7460 item 4 — "decidir o destino das 10 entries
 * 'Post N/20' com títulos fabricados"): NÃO remover as 10 entries nem
 * re-drenar do zero. Medição em 05/09/2026 (ver corpo do PR #7460) mostrou
 * que os 10 posts já foram RE-DRENADOS de verdade entre 03 e 04/09/2026
 * (`fetched_at` recente, `count` alto, 0 stub/malformado remanescente em
 * qualquer um dos 10 — só 1 deles, `post_048a8526…`, ainda carrega as 100
 * linhas classe C do #7181, que são dado real recuperável, não lixo) — o
 * único problema remanescente é o TÍTULO placeholder gravado durante o
 * backfill original (`"Post 11/20"` … `"Post 20/20"`), nunca o conteúdo.
 *
 * Este script corrige só o título: busca o título REAL de cada post em
 * `data/beehiiv-cache/posts/{post_id}.json` (já sincronizado pelo
 * `beehiiv-sync.ts` semanal — nenhuma chamada de rede aqui) e substitui o
 * placeholder no manifest. Nunca inventa um título — se o cache não tiver
 * o post, a entry é reportada e deixada como está (fail-soft, nunca
 * fabrica um título melhor que o placeholder).
 *
 * Uso: `npx tsx scripts/fix-engagement-fabricated-titles.ts [--dry-run] [--out-dir DIR] [--cache-dir DIR]`
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import {
  extractPostRefFromBackupFile,
  upsertEntry,
  type EngagementManifest,
  type EngagementManifestEntry,
} from "./lib/beehiiv-engagement-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");
const DEFAULT_CACHE_DIR = resolve(ROOT, "data/beehiiv-cache/posts");

/** Assinatura EXATA da leva fabricada do #7181 — `"Post 11/20"` … `"Post 20/20"`. */
export const FABRICATED_TITLE_RE = /^Post \d+\/20$/;

export interface TitleFixEntry {
  post_id: string;
  old_title: string;
  new_title: string | null;
}

/** Puro: dado o manifest e um lookup de título real por post_id, produz o
 *  manifest corrigido + a lista do que mudou (e o que não pôde mudar). */
export function planTitleFixes(
  manifest: EngagementManifest,
  realTitleByPostId: Map<string, string>,
): { manifest: EngagementManifest; fixed: TitleFixEntry[]; unresolved: TitleFixEntry[] } {
  const fixed: TitleFixEntry[] = [];
  const unresolved: TitleFixEntry[] = [];
  let result = manifest;
  for (const entry of manifest.posts) {
    if (!entry.title || !FABRICATED_TITLE_RE.test(entry.title)) continue;
    const realTitle = realTitleByPostId.get(entry.post_id);
    if (!realTitle) {
      unresolved.push({ post_id: entry.post_id, old_title: entry.title, new_title: null });
      continue;
    }
    fixed.push({ post_id: entry.post_id, old_title: entry.title, new_title: realTitle });
    const updated: EngagementManifestEntry = { ...entry, title: realTitle };
    result = upsertEntry(result, updated);
  }
  return { manifest: result, fixed, unresolved };
}

function loadManifest(manifestPath: string): EngagementManifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as EngagementManifest;
  } catch {
    return null;
  }
}

function saveManifestAtomic(manifestPath: string, manifest: EngagementManifest): void {
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

function readRealTitle(cacheDir: string, postId: string): string | null {
  const path = resolve(cacheDir, `${postId}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const ref = extractPostRefFromBackupFile(raw);
    return ref?.title ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDirIdx = argv.indexOf("--out-dir");
  const cacheDirIdx = argv.indexOf("--cache-dir");
  const outDir = outDirIdx !== -1 ? resolve(argv[outDirIdx + 1]) : DEFAULT_OUT_DIR;
  const cacheDir = cacheDirIdx !== -1 ? resolve(argv[cacheDirIdx + 1]) : DEFAULT_CACHE_DIR;
  const dryRun = argv.includes("--dry-run");

  const manifestPath = resolve(outDir, "manifest.json");
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    console.error(`[fix-engagement-fabricated-titles] manifest não encontrado: ${manifestPath}`);
    process.exit(2);
  }

  const candidatePostIds = manifest.posts
    .filter((p) => p.title && FABRICATED_TITLE_RE.test(p.title))
    .map((p) => p.post_id);
  const realTitleByPostId = new Map<string, string>();
  for (const postId of candidatePostIds) {
    const title = readRealTitle(cacheDir, postId);
    if (title) realTitleByPostId.set(postId, title);
  }

  const { manifest: updated, fixed, unresolved } = planTitleFixes(manifest, realTitleByPostId);

  if (!dryRun && fixed.length > 0) {
    saveManifestAtomic(manifestPath, updated);
  }

  console.log(JSON.stringify({ dry_run: dryRun, fixed, unresolved }, null, 2));
  if (unresolved.length > 0) {
    console.error(
      `[fix-engagement-fabricated-titles] ${unresolved.length} entry(ies) sem título real no cache — ` +
        `título placeholder mantido, nunca inventado.`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
