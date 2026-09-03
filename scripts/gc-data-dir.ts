#!/usr/bin/env node
/**
 * gc-data-dir.ts (#7278)
 *
 * Inventaria e (só com `--apply`) remove cache/intermediário/backup
 * redundante sob `data/` — a pasta do editor, sincronizada por OneDrive,
 * com conteúdo de negócio. Política pura em `scripts/lib/data-dir-gc-policy.ts`
 * (buckets, guard de exclusão, retenção); este script é só a camada fina de
 * I/O (walk do filesystem + dry-run/apply), seguindo a convenção de
 * `prune-audience-history.ts` (#7129).
 *
 * **`--dry-run` é o DEFAULT — `main()` só lista candidatos e por quê, nunca
 * apaga nada, a menos que `--apply` seja passado explicitamente.** O
 * inventário medido vale mais que a deleção; a deleção é decisão do editor
 * (corpo da issue #7278).
 *
 * Escopo desta fatia (ver docstring de `data-dir-gc-policy.ts` pro
 * detalhamento e o que fica de fora — agendamento armado, alarme de cota,
 * normalização de layout de `editions/{AAMMDD}` são follow-up separado):
 *   1. `_internal/_forensic/` de edição FECHADA (Stage 6 concluído).
 *   2. `tmp-*` em `_internal/` de edição FECHADA.
 *   3. `*-embedded.html` em `_internal/` de edição FECHADA.
 *   4. Cópias-irmãs de conflito do OneDrive (`-safeBackup-*`, sufixo de
 *      máquina, `.bak[-data]`) em QUALQUER lugar sob `data/`.
 *   5. `.mv-cache-*.json` (cache MillionVerifier, qualquer idade > 30d).
 *
 * "Edição fechada" = `_internal/.step-6-done.json` existe (Stage 6/
 * Agendamento concluído, `scripts/lib/pipeline-state.ts::sentinelExists`) —
 * critério sugerido no corpo da issue. Edição em andamento nunca é tocada,
 * mesmo que velha (uma edição pode ficar em rascunho por decisão editorial).
 *
 * `dataRoot` é injetável (default `<repo>/data`) — mesmo padrão de
 * `resolveRunLogPath(rootDir)` (`run-log.ts`) — pra testes rodarem contra
 * um tmpdir fixture em vez do `data/` real (junction pro OneDrive do
 * editor, nunca tocado por teste).
 *
 * Uso:
 *   npx tsx scripts/gc-data-dir.ts [--apply] [--json] [--data-root <path>]
 *
 * Sem `--apply`: lista cada candidato (path, bucket, tamanho, motivo) +
 * total por bucket. Com `--apply`: remove de fato, best-effort por arquivo
 * (mesmo padrão de `invalidateSiblingManifests`/`atomicCommitRebuild` —
 * `data/` é junctioned pro OneDrive, que segura arquivo por ~100-500ms
 * durante sync; falha em 1 arquivo não aborta a run inteira nem impede os
 * demais).
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { sentinelExists } from "./lib/pipeline-state.ts";
import {
  type GcCandidate,
  type AgedFile,
  isForensicCacheDir,
  isTmpIntermediateFilename,
  isEmbeddedHtmlFilename,
  isBackupSiblingFilename,
  isMvCacheFilename,
  classifyBackupSiblings,
  classifyMvCache,
  guardCandidates,
} from "./lib/data-dir-gc-policy.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_DATA_ROOT = resolve(ROOT, "data");

// ---------------------------------------------------------------------------
// FS helpers (não-puros — vivem aqui, não no lib de política)
// ---------------------------------------------------------------------------

function toRelPath(dataRoot: string, absPath: string): string {
  return relative(dataRoot, absPath).replace(/\\/g, "/");
}

function ageDaysOf(mtimeMs: number, nowMs: number): number {
  return Math.floor((nowMs - mtimeMs) / 86_400_000);
}

/** Soma recursiva de tamanho — usado só pro bucket `_forensic/` (removido
 *  como árvore inteira, não arquivo a arquivo). */
function dirSizeBytes(absDir: string): number {
  let total = 0;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const p = resolve(absDir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

/** Lista arquivos (não-recursiva) diretamente sob `absDir`, com tamanho e idade. */
function listFilesShallow(dataRoot: string, absDir: string, nowMs: number): AgedFile[] {
  if (!existsSync(absDir)) return [];
  const out: AgedFile[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const p = resolve(absDir, entry.name);
    const st = statSync(p);
    out.push({ relPath: toRelPath(dataRoot, p), sizeBytes: st.size, ageDays: ageDaysOf(st.mtimeMs, nowMs) });
  }
  return out;
}

/** Walk recursivo de `data/` inteiro pra achar cópias-irmãs de conflito e
 *  cache MV — não desce em `_internal/_forensic` de edição fechada (já
 *  contado como 1 candidato só) nem nos diretórios do guard (evita gastar
 *  tempo andando `beehiiv-backup/`, que pode ser grande). */
function walkForSiblingsAndCache(
  dataRoot: string,
  absDir: string,
  nowMs: number,
  siblings: AgedFile[],
  mvCache: AgedFile[],
): void {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const p = resolve(absDir, entry.name);
    const rel = toRelPath(dataRoot, p);
    if (entry.isDirectory()) {
      if (rel === "beehiiv-backup" || rel.startsWith("beehiiv-backup/")) continue;
      if (rel === "snippets" || rel.startsWith("snippets/")) continue;
      if (isForensicCacheDir(rel)) continue; // contado à parte, pelo passo de edições
      walkForSiblingsAndCache(dataRoot, p, nowMs, siblings, mvCache);
      continue;
    }
    if (!entry.isFile()) continue;
    const st = statSync(p);
    const aged: AgedFile = { relPath: rel, sizeBytes: st.size, ageDays: ageDaysOf(st.mtimeMs, nowMs) };
    if (isBackupSiblingFilename(entry.name)) siblings.push(aged);
    if (isMvCacheFilename(entry.name)) mvCache.push(aged);
  }
}

/** Enumera diretórios de edição, nos DOIS layouts (#7278 achado colateral):
 *  `editions/{YYMM}/{AAMMDD}` (atual) e `editions/{AAMMDD}` (residual, 15
 *  diretórios medidos em julho/2026). Normalizar pro layout único é
 *  follow-up separado — este script só precisa ENXERGAR os dois pra não
 *  errar silenciosamente. */
function listEditionDirs(editionsRoot: string): string[] {
  if (!existsSync(editionsRoot)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(editionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (/^\d{6}$/.test(entry.name)) {
      out.push(resolve(editionsRoot, entry.name)); // layout flat residual
      continue;
    }
    if (/^\d{4}$/.test(entry.name)) {
      const monthDir = resolve(editionsRoot, entry.name);
      for (const sub of readdirSync(monthDir, { withFileTypes: true })) {
        if (sub.isDirectory() && /^\d{6}$/.test(sub.name)) out.push(resolve(monthDir, sub.name));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coleta de candidatos
// ---------------------------------------------------------------------------

export function collectCandidates(dataRoot: string = DEFAULT_DATA_ROOT, nowMs: number = Date.now()): GcCandidate[] {
  if (!existsSync(dataRoot)) return [];
  const candidates: GcCandidate[] = [];
  const editionsRoot = resolve(dataRoot, "editions");

  // Buckets 1-3: dentro de `_internal/` de edições FECHADAS.
  for (const editionDir of listEditionDirs(editionsRoot)) {
    if (!sentinelExists(editionDir, 6)) continue; // não fechada — nunca tocar
    const internalDir = resolve(editionDir, "_internal");
    if (!existsSync(internalDir)) continue;

    const forensicDir = resolve(internalDir, "_forensic");
    if (existsSync(forensicDir)) {
      candidates.push({
        relPath: toRelPath(dataRoot, forensicDir),
        bucket: "forensic-cache",
        sizeBytes: dirSizeBytes(forensicDir),
        reason: "cache intra-edição de HTML bruto (url-body-cache.ts) — edição fechada, #959 já proíbe expor a agentes",
      });
    }

    for (const f of listFilesShallow(dataRoot, internalDir, nowMs)) {
      const basename = f.relPath.split("/").pop()!;
      if (isTmpIntermediateFilename(basename)) {
        candidates.push({
          ...f,
          bucket: "tmp-intermediate",
          reason: "intermediário do Stage 1 — resultado já vive em 01-approved.json/01-categorized.md, edição fechada",
        });
      } else if (isEmbeddedHtmlFilename(basename)) {
        candidates.push({
          ...f,
          bucket: "embedded-html",
          reason: "render derivado (regenerável do markdown), edição fechada",
        });
      }
    }
  }

  // Buckets 4-5: qualquer lugar sob `data/`.
  const siblings: AgedFile[] = [];
  const mvCache: AgedFile[] = [];
  walkForSiblingsAndCache(dataRoot, dataRoot, nowMs, siblings, mvCache);
  candidates.push(...classifyBackupSiblings(siblings));
  candidates.push(...classifyMvCache(mvCache));

  return guardCandidates(candidates);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const apply = hasFlag(argv, "apply");
  const asJson = hasFlag(argv, "json");
  const dataRoot = getArg(argv, "data-root") || DEFAULT_DATA_ROOT;

  if (!existsSync(dataRoot)) {
    console.error(`[gc-data-dir] ${dataRoot} não existe — nada a fazer (ver CLAUDE.md setup, passo 2b).`);
    return;
  }

  const candidates = collectCandidates(dataRoot);
  const totalBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);

  if (asJson) {
    console.log(JSON.stringify({ apply, total_bytes: totalBytes, candidates }, null, 2));
  } else {
    for (const c of candidates) {
      console.log(`[${c.bucket}] ${formatBytes(c.sizeBytes).padStart(9)}  ${c.relPath}  — ${c.reason}`);
    }
    const byBucket = new Map<string, { count: number; bytes: number }>();
    for (const c of candidates) {
      const cur = byBucket.get(c.bucket) ?? { count: 0, bytes: 0 };
      cur.count++;
      cur.bytes += c.sizeBytes;
      byBucket.set(c.bucket, cur);
    }
    console.log("");
    for (const [bucket, { count, bytes }] of byBucket) {
      console.log(`  ${bucket}: ${count} item(ns), ${formatBytes(bytes)}`);
    }
    console.log(
      `\n[gc-data-dir] total: ${candidates.length} item(ns), ${formatBytes(totalBytes)}` +
        (apply ? "" : " [dry-run — nada removido; rode com --apply pra remover de fato]"),
    );
  }

  if (!apply) return;

  let removed = 0;
  let failed = 0;
  for (const c of candidates) {
    const abs = resolve(dataRoot, c.relPath);
    try {
      rmSync(abs, { recursive: true, force: true });
      removed++;
    } catch (e) {
      failed++;
      console.error(
        `⚠️  [gc-data-dir] falha ao remover ${c.relPath}: ${e instanceof Error ? e.message : String(e)} — seguindo (best-effort).`,
      );
    }
  }
  console.log(`[gc-data-dir] --apply: ${removed} removido(s), ${failed} falha(s).`);
}

if (isMainModule(import.meta.url)) {
  main();
}
