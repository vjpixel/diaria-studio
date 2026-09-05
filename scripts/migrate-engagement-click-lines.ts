/**
 * migrate-engagement-click-lines.ts (#7460, residual do #7181/#7172)
 *
 * One-off (mas idempotente e seguro pra rodar de novo) que fecha o item 3
 * do escopo do #7460: migra as linhas classe B (schema de
 * `list_post_click_subscribers` — `subscription_id`/`url`/`url_hash`/
 * `clicked_at`) já misturadas no `.jsonl` de engagement, medidas pelo
 * #7181 em 199 linhas / 6 arquivos, pro arquivo/formato próprio delas
 * (`data/beehiiv-backup/click-subscribers/{post_id}.jsonl`).
 *
 * Usa o mesmo classificador (`classifyEngagementRecords`,
 * `scripts/lib/beehiiv-engagement-read.ts`) e o mesmo roteador
 * (`routeClickIdentityRecords`, `scripts/apply-mcp-subscriber-engagement.ts`)
 * que o guard write-time passa a usar — este script só aplica a MESMA regra
 * retroativamente ao que já estava em disco antes do guard existir.
 *
 * Para cada `{post_id}.jsonl` em `data/beehiiv-backup/subscriber-engagement/`
 * (ignora `manifest.json`, `_backup-*`/`_quarantine-*`, e qualquer entrada
 * que não seja um `post_*.jsonl`):
 *   1. Classifica cada linha.
 *   2. Linhas `click-identity` são roteadas pro `click-subscribers/{post_id}.jsonl`
 *      irmão (append + dedup por conteúdo, mesma função do guard write-time).
 *   3. Linhas `stub`/`malformed` são REPORTADAS (nunca descartadas por este
 *      script — na medição de 05/09/2026 o acervo não tinha nenhuma; se
 *      aparecer, é achado novo, não silenciado aqui).
 *   4. O resto (canônica + classes recuperáveis C/D) fica no `.jsonl` de
 *      engagement, reescrito só se alguma linha B foi removida.
 *   5. `manifest.count` da entry afetada é corrigido pro novo total (#7181:
 *      "sem isso, verifyBeehiivIngestion marca esses posts partial pra
 *      sempre").
 *
 * Idempotente: rodar 2x não duplica nada (dedup por conteúdo no destino) e
 * não altera arquivos sem linha classe B.
 *
 * Uso: `npx tsx scripts/migrate-engagement-click-lines.ts [--dry-run] [--out-dir DIR]`
 */
import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { classifyEngagementRecords } from "./lib/beehiiv-engagement-read.ts";
import { routeClickIdentityRecords } from "./apply-mcp-subscriber-engagement.ts";
import { upsertEntry, type EngagementManifest, type EngagementManifestEntry } from "./lib/beehiiv-engagement-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");

export interface FileMigrationResult {
  post_id: string;
  before_count: number;
  after_count: number;
  routed_click_count: number;
  discarded_garbage_count: number;
}

/** Nome de arquivo elegível: `post_<qualquercoisa>.jsonl` — exclui `manifest.json` e diretórios auxiliares. */
export function isEngagementJsonlFile(name: string): boolean {
  return /^post_.+\.jsonl$/.test(name);
}

/** Migra 1 arquivo já lido (linhas cruas parseadas) — puro, sem IO, pra testabilidade.
 *  Retorna `null` quando não há nenhuma linha classe B (nada a fazer). */
export function planFileMigration(
  postId: string,
  rawLines: unknown[],
): { keep: unknown[]; clickLines: unknown[]; garbageLines: unknown[] } | null {
  const classified = classifyEngagementRecords(rawLines);
  const clickLines: unknown[] = [];
  const garbageLines: unknown[] = [];
  const keep: unknown[] = [];
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i];
    if (c.class === "click-identity") clickLines.push(rawLines[i]);
    else if (c.class === "stub" || c.class === "malformed") garbageLines.push(rawLines[i]);
    else keep.push(rawLines[i]);
  }
  if (clickLines.length === 0) return null;
  return { keep, clickLines, garbageLines };
}

function readJsonlLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

function writeJsonlAtomic(path: string, records: unknown[]): void {
  const tmp = `${path}.tmp`;
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDirIdx = argv.indexOf("--out-dir");
  const outDir = outDirIdx !== -1 ? resolve(argv[outDirIdx + 1]) : DEFAULT_OUT_DIR;
  const dryRun = argv.includes("--dry-run");

  if (!existsSync(outDir)) {
    console.error(`[migrate-engagement-click-lines] diretório não encontrado: ${outDir}`);
    process.exit(2);
  }

  const entries = readdirSync(outDir).filter((name) => {
    const full = resolve(outDir, name);
    return statSync(full).isFile() && isEngagementJsonlFile(name);
  });

  const manifestPath = resolve(outDir, "manifest.json");
  let manifest = loadManifest(manifestPath);

  const results: FileMigrationResult[] = [];
  let totalGarbage = 0;

  for (const name of entries) {
    const postId = name.replace(/\.jsonl$/, "");
    const filePath = resolve(outDir, name);
    const rawLines = readJsonlLines(filePath);
    const plan = planFileMigration(postId, rawLines);
    if (!plan) continue;

    const beforeCount = rawLines.length;
    results.push({
      post_id: postId,
      before_count: beforeCount,
      after_count: plan.keep.length,
      routed_click_count: plan.clickLines.length,
      discarded_garbage_count: plan.garbageLines.length,
    });
    totalGarbage += plan.garbageLines.length;

    if (dryRun) continue;

    writeJsonlAtomic(filePath, plan.keep);
    routeClickIdentityRecords(outDir, postId, plan.clickLines);

    if (manifest) {
      const existingEntry = manifest.posts.find((p) => p.post_id === postId);
      if (existingEntry) {
        const entry: EngagementManifestEntry = { ...existingEntry, count: plan.keep.length };
        manifest = upsertEntry(manifest, entry);
      }
    }
  }

  if (!dryRun && manifest) {
    saveManifestAtomic(manifestPath, manifest);
  }

  const totalClickLines = results.reduce((sum, r) => sum + r.routed_click_count, 0);
  console.log(
    JSON.stringify(
      {
        dry_run: dryRun,
        files_touched: results.length,
        total_click_lines_routed: totalClickLines,
        total_garbage_lines_found: totalGarbage,
        results,
      },
      null,
      2,
    ),
  );

  if (totalGarbage > 0) {
    console.error(
      `[migrate-engagement-click-lines] AVISO: ${totalGarbage} linha(s) stub/malformada(s) encontradas — ` +
        `não descartadas por este script (fora do escopo do #7460 item 3), reportadas pra investigação separada.`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
