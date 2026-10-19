/**
 * Verifica a ordem da fila do envio diário da Clarice nas últimas N ondas
 * (#10479, definição de feito do #9824).
 *
 * Lê os snapshots da fila completa que `clarice-build-segment.ts --daily`
 * grava em `segments/daily-queue/` (um por onda) e checa, em cada onda:
 *   (a) nenhum contato incluído tem score menor que algum elegível deixado de fora;
 *   (b) entre scores iguais, todo incluído tem cadastro igual ou mais recente
 *       que todo excluído.
 *
 * Uso:
 *   npx tsx scripts/clarice-verify-daily-queue-order.ts --cycle 2610-11 [--cycle-extra 2609-10] [--last 3] [--data-root DIR]
 *   npx tsx scripts/clarice-verify-daily-queue-order.ts --files a.csv.gz,b.csv.gz
 *
 *   --cycle        ciclo cujos snapshots entram (obrigatório sem --files).
 *   --cycle-extra  outros ciclos, separados por vírgula: 3 ondas consecutivas
 *                  podem cruzar a virada de ciclo. As ondas são ordenadas pelo
 *                  carimbo de montagem no nome do arquivo, não pelo ciclo.
 *   --last N       quantas ondas mais recentes verificar (default 3). Vários
 *                  snapshots da mesma data de envio (rerun do build) contam
 *                  como UMA onda: vale o mais recente (#10489).
 *   --files        lista explícita de snapshots; ignora --cycle/--last.
 *
 * Saída: JSON com o relatório por onda em stdout.
 * Exit: 0 = todas as ondas verificadas passam e há pelo menos N;
 *       1 = alguma onda viola a ordem, ou erro de leitura/argumento;
 *       2 = ordem ok, mas menos de N ondas gravadas (evidência insuficiente).
 * Só lê arquivos locais. Não toca Brevo nem o store.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { clariceSegmentsDir, isValidCycle } from "./lib/clarice-paths.ts";
import {
  DAILY_QUEUE_SNAPSHOT_DIR,
  parseDailyQueueSnapshotGz,
  verifyDailyQueueOrder,
  type DailyQueueOrderReport,
} from "./lib/clarice-daily-queue-snapshot.ts";

export const DEFAULT_LAST = 3;

/** Snapshots de um ciclo, caminho absoluto. Diretório ausente = nenhum. */
export function listDailyQueueSnapshots(cycle: string, dataRoot?: string): string[] {
  const dir = resolve(clariceSegmentsDir(cycle, dataRoot), DAILY_QUEUE_SNAPSHOT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".csv.gz"))
    .map((f) => resolve(dir, f));
}

/**
 * Data de envio no nome do snapshot (`{carimbo}_send-{data}.csv.gz`). `null`
 * para `send-sem-data` ou nome fora do padrão: sem data não há como saber se
 * dois arquivos são a mesma onda.
 */
export function snapshotSendDate(path: string): string | null {
  const m = /_send-(.+)\.csv\.gz$/.exec(basename(path));
  if (!m || m[1] === "sem-data") return null;
  return m[1];
}

/**
 * Um snapshot por onda (#10489): o build `--daily` grava um arquivo a cada
 * execução não-dry, então rerun da mesma onda (falha no import, ajuste de
 * --budget, rerun manual) deixa vários arquivos do mesmo `send-{data}`. Fica
 * o de carimbo mais recente, que é a fila que de fato valeu. Snapshot sem data
 * de envio não é agrupado (cada um conta como onda própria).
 */
export function latestSnapshotPerSendDate(paths: string[]): string[] {
  const sorted = [...paths].sort((a, b) => basename(a).localeCompare(basename(b)));
  const latestByDate = new Map<string, string>();
  for (const p of sorted) {
    const date = snapshotSendDate(p);
    if (date !== null) latestByDate.set(date, p);
  }
  return sorted.filter((p) => {
    const date = snapshotSendDate(p);
    return date === null || latestByDate.get(date) === p;
  });
}

/**
 * As `last` ondas mais recentes, em ordem cronológica (carimbo no início do
 * nome), já com um snapshot só por data de envio (#10489).
 */
export function pickLastSnapshots(paths: string[], last: number): string[] {
  const waves = latestSnapshotPerSendDate(paths);
  return waves.slice(Math.max(0, waves.length - last));
}

export interface WaveVerification extends DailyQueueOrderReport {
  file: string;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let files: string[];
  let last = DEFAULT_LAST;
  try {
    const filesArg = getStringArg(argv, "files", { example: "a.csv.gz,b.csv.gz" });
    last = getIntArg(argv, "last", { min: 1 }) ?? DEFAULT_LAST;
    if (filesArg) {
      files = filesArg.split(",").map((f) => resolve(f.trim())).filter(Boolean);
      last = files.length;
    } else {
      const cycle = getStringArg(argv, "cycle", { example: "2610-11" });
      const extra = getStringArg(argv, "cycle-extra", { example: "2609-10" });
      const cycles = [cycle, ...(extra ? extra.split(",").map((c) => c.trim()) : [])].filter(Boolean) as string[];
      if (cycles.length === 0) throw new Error("--cycle {conteúdo}-{envio} é obrigatório sem --files (ex: --cycle 2610-11).");
      const invalid = cycles.filter((c) => !isValidCycle(c));
      if (invalid.length > 0) throw new Error(`ciclo(s) inválido(s): ${invalid.join(", ")} (formato AAMM-MM).`);
      const dataRoot = getStringArg(argv, "data-root", { example: "data" });
      files = pickLastSnapshots(
        cycles.flatMap((c) => listDailyQueueSnapshots(c, dataRoot)),
        last,
      );
    }
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    return 1;
  }

  const waves: WaveVerification[] = [];
  try {
    for (const file of files) {
      waves.push({ file, ...verifyDailyQueueOrder(parseDailyQueueSnapshotGz(readFileSync(file))) });
    }
  } catch (e) {
    console.error(`❌ falha ao ler snapshot: ${(e as Error).message}`);
    return 1;
  }

  const ok = waves.every((w) => w.ok);
  const enough = waves.length >= last;
  console.log(JSON.stringify({ expected: last, found: waves.length, ok, enough, waves }, null, 2));

  for (const w of waves) {
    const tag = w.ok ? "✅" : "❌";
    console.error(`${tag} ${basename(w.file)}: ${w.included} incluído(s), ${w.excluded} excluído(s), ${w.violations.length} violação(ões)`);
  }
  if (!ok) {
    console.error("❌ a ordem da fila (score DESC, cadastro mais recente desempata, #9824) foi violada em pelo menos uma onda.");
    return 1;
  }
  if (!enough) {
    console.error(`⚠️  só ${waves.length} onda(s) gravada(s), ${last} exigida(s) — ordem ok, mas evidência insuficiente.`);
    return 2;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
