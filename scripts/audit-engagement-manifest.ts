/**
 * audit-engagement-manifest.ts (#7197)
 *
 * Reconcilia `data/beehiiv-backup/subscriber-engagement/manifest.json`
 * contra a única fonte que não pode mentir sobre si mesma: as linhas de
 * fato gravadas em cada `{post_id}.jsonl`. Medido ao vivo (#7197): 255 de
 * 256 posts vinham marcados `status: "ok"`, sendo que 7 tinham `count: 0` e
 * 16 tinham `count` menor do que o disco realmente carrega — o manifest
 * "declarava íntegro" um acervo 33% incompleto.
 *
 * Por que isso é possível mesmo com `apply-mcp-subscriber-engagement.ts`
 * sempre escrevendo `count: records.length` no mesmo golpe que grava o
 * JSONL (#7197 não achou um bug de escrita simultânea): o manifest pode
 * divergir do disco por qualquer evento POSTERIOR à escrita original —
 * manifest restaurado de um snapshot OneDrive mais antigo (achado
 * documentado: `onedrive-conflict-backup-durante-edit.md`), ou entries
 * escritas por uma versão do script anterior ao guard de #6496/#7197. Este
 * script fecha o loop pro que já está em disco; o guard write-time em
 * `apply-mcp-subscriber-engagement.ts` (`--confirmed-empty`, #7197) evita
 * que o padrão volte a acontecer daqui pra frente.
 *
 * Regra de reconciliação (pura, `reconcileManifestWithDisk` em
 * `scripts/lib/beehiiv-engagement-manifest.ts` — só entries `status: "ok"`
 * são candidatas):
 *   1. 0 linhas reais em disco → rebaixa pra `pending` (redrenar do zero).
 *   2. `manifest.count` != linhas reais → rebaixa pra `partial` e corrige
 *      `count` pro valor real (disco tem ALGUM dado, só precisa completar).
 *   3. Bate → mantém `ok`, intocado.
 *
 * O que este script NÃO faz (fora de escopo, exige sessão com MCP Beehiiv
 * ao vivo — guard de publicação do overnight/develop não deixa um
 * subagente de dispatch tocar Beehiiv/qualquer API externa "ao vivo"):
 * comparar contra `total_received` que a própria Beehiiv reporta pro post
 * (3ª contagem do checklist da #7197), e re-drenar os posts rebaixados.
 * Rodar `list-posts-for-engagement-backup.ts` depois deste script já
 * reoferece automaticamente tudo que foi rebaixado (não é mais `ok`).
 *
 * Uso:
 *   npx tsx scripts/audit-engagement-manifest.ts                 # aplica e grava
 *   npx tsx scripts/audit-engagement-manifest.ts --dry-run        # só reporta
 *   npx tsx scripts/audit-engagement-manifest.ts --out-dir DIR    # override do diretório
 *   npx tsx scripts/audit-engagement-manifest.ts --json           # relatório em JSON no stdout
 *
 * Output (stdout): por padrão, resumo human-readable com contagem de
 * rebaixamentos + cobertura antes/depois. Com `--json`, emite
 * `{ downgraded: [...], coverage_before: {...}, coverage_after: {...} }`.
 * Stderr: progresso.
 * Exit codes: 0=sucesso (mesmo com 0 rebaixamentos), 1=erro de IO,
 * 2=manifest inexistente.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { countExistingLines } from "./apply-mcp-subscriber-engagement.ts";
import { reconcileManifestWithDisk, coverageSummary, type EngagementManifest } from "./lib/beehiiv-engagement-manifest.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = resolve(ROOT, "data/beehiiv-backup/subscriber-engagement");

function loadManifest(manifestPath: string): EngagementManifest | null {
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as EngagementManifest;
}

function saveManifestAtomic(manifestPath: string, manifest: EngagementManifest): void {
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

/** Lê, pro `outDir` dado, o nº real de linhas de cada post_id do manifest — a fonte da reconciliação. */
export function readActualCounts(manifest: EngagementManifest, outDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of manifest.posts) {
    counts.set(entry.post_id, countExistingLines(resolve(outDir, `${entry.post_id}.jsonl`)));
  }
  return counts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outDirIdx = argv.indexOf("--out-dir");
  const outDir = outDirIdx !== -1 ? resolve(argv[outDirIdx + 1]) : DEFAULT_OUT_DIR;
  const dryRun = argv.includes("--dry-run");
  const asJson = argv.includes("--json");

  const manifestPath = resolve(outDir, "manifest.json");
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    console.error(`[audit-engagement-manifest] manifest não encontrado: ${manifestPath}`);
    process.exit(2);
  }

  const coverageBefore = coverageSummary(manifest);
  const actualCounts = readActualCounts(manifest, outDir);
  const { manifest: reconciled, downgraded } = reconcileManifestWithDisk(manifest, actualCounts);
  const coverageAfter = coverageSummary(reconciled);

  if (!dryRun && downgraded.length > 0) {
    saveManifestAtomic(manifestPath, reconciled);
  }

  if (asJson) {
    console.log(JSON.stringify({ downgraded, coverage_before: coverageBefore, coverage_after: coverageAfter, dry_run: dryRun }, null, 2));
    return;
  }

  process.stderr.write(
    `[audit-engagement-manifest] cobertura ANTES: ${coverageBefore.ok}/${coverageBefore.total} ok\n` +
      `[audit-engagement-manifest] ${downgraded.length} post(s) rebaixado(s) de ok:\n`,
  );
  for (const d of downgraded) {
    process.stderr.write(`  ${d.post_id}: ok → ${d.to} — ${d.reason}\n`);
  }
  process.stderr.write(
    `[audit-engagement-manifest] cobertura DEPOIS: ${coverageAfter.ok}/${coverageAfter.total} ok` +
      `${dryRun ? " (--dry-run, manifest NÃO gravado)" : ""}\n`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
