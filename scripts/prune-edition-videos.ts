#!/usr/bin/env node
/**
 * scripts/prune-edition-videos.ts (#10957)
 *
 * Retenção por data dos `.mp4` de `data/editions/`. **Dry-run é o
 * DEFAULT**: sem `--apply` só lista o que sairia, com tamanho e idade —
 * nunca apaga. Política pura em `scripts/lib/edition-video-retention.ts`
 * (data da EDIÇÃO pelo diretório `AAMMDD`, não o mtime).
 *
 * Os vídeos têm cópia fora do disco (YouTube e a fonte no Drive —
 * `fetch-drive-video.ts` baixa de novo se precisar; o R2 dos verticais,
 * habilitado em 27/10/2026, #10772, só guarda 7 dias). Não é tarefa
 * agendada: armar a retenção automática é decisão do editor depois de ver
 * o dry-run (`docs/onedrive-sync-setup.md` item 6).
 *
 * Uso:
 *   npx tsx scripts/prune-edition-videos.ts                  # dry-run, mantém 14 dias
 *   npx tsx scripts/prune-edition-videos.ts --keep-days 7    # outra janela
 *   npx tsx scripts/prune-edition-videos.ts --apply          # apaga de verdade
 *   npx tsx scripts/prune-edition-videos.ts --data-root DIR  # outra raiz (testes/fixture)
 *   npx tsx scripts/prune-edition-videos.ts --json           # saída em JSON
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { walkFileSizes } from "./lib/walk-file-sizes.ts";
import { planVideoRetention, DEFAULT_VIDEO_KEEP_DAYS, isEditionVideo, type VideoRetentionPlan } from "./lib/edition-video-retention.ts";
import { formatBytes } from "./lib/onedrive-quota.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[prune-edition-videos]";

export interface PruneResult {
  plan: VideoRetentionPlan;
  applied: boolean;
  deleted: string[];
  failed: { relPath: string; error: string }[];
}

/** I/O fino — testável contra um tmpdir via `dataRoot`. */
export function pruneEditionVideos(opts: { dataRoot: string; today: Date; keepDays: number; apply: boolean }): PruneResult {
  const editionsDir = join(opts.dataRoot, "editions");
  const files = existsSync(editionsDir) ? walkFileSizes(editionsDir).filter((f) => isEditionVideo(f.relPath)) : [];
  const plan = planVideoRetention(files, opts.today, opts.keepDays);
  const deleted: string[] = [];
  const failed: { relPath: string; error: string }[] = [];
  if (opts.apply) {
    for (const c of plan.remove) {
      try {
        unlinkSync(join(editionsDir, c.relPath));
        deleted.push(c.relPath);
      } catch (e) {
        failed.push({ relPath: c.relPath, error: (e as Error).message });
      }
    }
  }
  return { plan, applied: opts.apply, deleted, failed };
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const keepDays = getIntArg(argv, "keep-days", { min: 1 }) ?? DEFAULT_VIDEO_KEEP_DAYS;
  const dataRoot = getStringArg(argv, "data-root", { example: "/caminho/data" }) ?? resolve(ROOT, "data");
  if (!existsSync(dataRoot)) {
    console.log(`${LOG_PREFIX} ${dataRoot} ausente nesta máquina — nada a fazer.`);
    return;
  }
  const result = pruneEditionVideos({ dataRoot, today: new Date(), keepDays, apply });
  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { plan } = result;
    console.log(`${LOG_PREFIX} retenção: mantém vídeos de edições com até ${keepDays} dia(s).`);
    for (const c of plan.remove) {
      console.log(`  ${apply ? "apagar" : "sairia"}  ${c.relPath}  ${formatBytes(c.sizeBytes)}  (${c.ageDays}d)`);
    }
    console.log(
      `${LOG_PREFIX} ${plan.remove.length} vídeo(s), ${formatBytes(plan.removeBytes)} ${apply ? "a apagar" : "liberáveis"}; ` +
        `${plan.keep.length} dentro da janela; ${plan.undated.length} sem data de edição no caminho (nunca tocados).`,
    );
    if (!apply) console.log(`${LOG_PREFIX} dry-run (default): nada apagado. Rode com --apply para apagar.`);
  }
  if (apply) {
    console.log(`${LOG_PREFIX} apagados: ${result.deleted.length}; falhas: ${result.failed.length}.`);
    for (const f of result.failed) console.error(`${LOG_PREFIX} falha ao apagar ${f.relPath}: ${f.error}`);
    if (result.failed.length > 0) process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`);
    process.exit(1);
  }
}
