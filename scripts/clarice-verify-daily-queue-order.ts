/**
 * Verifica a ordem da fila do envio diário da Clarice nas últimas N ondas
 * (#10479, definição de feito do #9824).
 *
 * Lê os snapshots da fila completa que `clarice-build-segment.ts --daily`
 * grava em `segments/daily-queue/` (um por onda) e checa, em cada onda:
 *   (a) nenhum contato incluído tem score menor que algum elegível deixado de fora;
 *   (b) entre scores iguais, todo incluído tem cadastro igual ou mais recente
 *       que todo excluído;
 *   (c) #10546: os incluídos do snapshot são EXATAMENTE a onda importada na
 *       Brevo. Sem (c) a prova é circular: o snapshot já sai ordenado pelo
 *       mesmo comparador que (a)/(b) testam. A onda importada sai das células
 *       `d{N}-{dia}{DD}-manifest.json` do `segments/` do snapshot (as mesmas
 *       que `clarice-import-waves.ts` subiu e reconciliou contra a lista da
 *       Brevo, #4577/#4720), e só conta quando o registro
 *       `d{N}-{dia}{DD}-lists.json` prova que o import terminou. Snapshot sem
 *       data de envio ou sem import registrado não conta como onda provada.
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
 * Exit: 0 = todas as ondas passam, inclusive contra o import, e há pelo menos N;
 *       1 = alguma onda viola a ordem ou diverge da onda importada, ou erro de
 *           leitura/argumento;
 *       2 = sem violação, mas menos de N ondas gravadas ou alguma sem import
 *           registrado (evidência insuficiente).
 * Só lê arquivos locais. Não toca Brevo nem o store.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getIntArg, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { clariceSegmentsDir, isValidCycle } from "./lib/clarice-paths.ts";
import {
  DAILY_QUEUE_SNAPSHOT_DIR,
  compareQueueWithImported,
  parseDailyQueueSnapshotGz,
  verifyDailyQueueOrder,
  type DailyQueueImportCheck,
  type DailyQueueOrderReport,
} from "./lib/clarice-daily-queue-snapshot.ts";
import { waveDateFragment } from "./lib/clarice-wave-plan.ts";
import { extractCsvEmails, normalizeImportCsv } from "./clarice-import-waves.ts";

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
  /** #10546: comparação com a onda importada; `null` = sem import registrado
   *  para a data de envio do snapshot (onda não provada). */
  importCheck: DailyQueueImportCheck | null;
  /** Grupos (`d{N}-{dia}{DD}`) cujas células formaram a onda importada. */
  importedGroups: string[];
}

/**
 * #10546: e-mails da onda IMPORTADA na data de envio de um snapshot.
 * `segmentsDir` é o `segments/` do ciclo (o pai de `daily-queue/`). Lê cada
 * `d{N}-{dia}{DD}-manifest.json` daquela data que tenha o registro
 * `-lists.json` ao lado (import concluído) e une os e-mails das células.
 * `null` quando a data é desconhecida ou nenhuma onda dela foi importada.
 */
export function importedWaveEmails(
  segmentsDir: string,
  sendDate: string | null,
): { groups: string[]; emails: string[] } | null {
  if (!sendDate || !existsSync(segmentsDir)) return null;
  let frag: string;
  try {
    frag = waveDateFragment(sendDate);
  } catch {
    return null;
  }
  const re = new RegExp(`^(d\\d+-${frag})-manifest\\.json$`);
  const groups = readdirSync(segmentsDir)
    .map((f) => re.exec(f)?.[1])
    .filter((g): g is string => !!g && existsSync(resolve(segmentsDir, `${g}-lists.json`)))
    .sort();
  if (groups.length === 0) return null;
  const emails: string[] = [];
  for (const g of groups) {
    const manifest = JSON.parse(readFileSync(resolve(segmentsDir, `${g}-manifest.json`), "utf8")) as unknown;
    if (!Array.isArray(manifest)) throw new Error(`${g}-manifest.json não é uma lista`);
    for (const entry of manifest as Array<{ file?: unknown }>) {
      if (typeof entry?.file !== "string") throw new Error(`${g}-manifest.json: entrada sem 'file'`);
      emails.push(...extractCsvEmails(normalizeImportCsv(readFileSync(resolve(segmentsDir, entry.file), "utf8"))));
    }
  }
  return { groups, emails };
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
      const rows = parseDailyQueueSnapshotGz(readFileSync(file));
      const imported = importedWaveEmails(dirname(dirname(file)), snapshotSendDate(file));
      const importCheck = imported ? compareQueueWithImported(rows, imported.emails) : null;
      waves.push({ file, ...verifyDailyQueueOrder(rows), importCheck, importedGroups: imported?.groups ?? [] });
    }
  } catch (e) {
    console.error(`❌ falha ao ler snapshot: ${(e as Error).message}`);
    return 1;
  }

  const orderOk = waves.every((w) => w.ok);
  const importOk = waves.every((w) => w.importCheck === null || w.importCheck.ok);
  const ok = orderOk && importOk;
  const unproven = waves.filter((w) => w.importCheck === null).length;
  const enough = waves.length >= last && unproven === 0;
  console.log(JSON.stringify({ expected: last, found: waves.length, ok, enough, unproven, waves }, null, 2));

  for (const w of waves) {
    const imp = w.importCheck;
    const tag = !w.ok || (imp && !imp.ok) ? "❌" : imp ? "✅" : "⚠️ ";
    const impText = imp
      ? `import ${imp.imported} (${imp.includedNotImported.count} incluído(s) fora do import, ${imp.importedNotIncluded.count} importado(s) fora dos incluídos)`
      : "sem import registrado";
    console.error(
      `${tag} ${basename(w.file)}: ${w.included} incluído(s), ${w.excluded} excluído(s), ${w.violations.length} violação(ões) de ordem, ${impText}`,
    );
  }
  if (!orderOk) {
    console.error("❌ a ordem da fila (score DESC, cadastro mais recente desempata, #9824) foi violada em pelo menos uma onda.");
  }
  if (!importOk) {
    console.error("❌ o snapshot da fila diverge da onda importada em pelo menos uma onda (#10546): a fila gravada não é a que foi enviada.");
  }
  if (!ok) return 1;
  if (!enough) {
    console.error(
      `⚠️  ${waves.length - unproven} onda(s) provada(s) contra o import, ${last} exigida(s)` +
        (unproven > 0 ? ` (${unproven} sem import registrado)` : "") +
        " — sem violação, mas evidência insuficiente.",
    );
    return 2;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
