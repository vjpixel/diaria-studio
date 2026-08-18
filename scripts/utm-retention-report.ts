/**
 * Relatório de retenção de UTM por braço — §8.4 do protocolo do teste 2608.
 *
 * Lê um snapshot da Beehiiv (o MESMO que a apuração de CAC usa — passar
 * `--snapshot` explícito, nunca "o mais recente", pra não medir retenção sobre
 * uma base diferente da do custo) e imprime o bloco markdown pro relatório
 * congelado.
 *
 * ```bash
 * npx tsx scripts/utm-retention-report.ts --snapshot 2026-09-16
 * npx tsx scripts/utm-retention-report.ts --snapshot 2026-09-16 --desde 2026-09-01 --ate 2026-09-15
 * npx tsx scripts/utm-retention-report.ts --snapshot 2026-09-16 --json
 * ```
 *
 * **Exit code 2 quando o corte REPROVA** — pra que um wrapper de apuração possa
 * parar antes de publicar um ranking de custo que a §3.3 já invalidou. Exit 1 é
 * erro de operação (snapshot ausente, flag inválida).
 */

import {
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import {
  ARM_RETENTION_SPECS,
  computeArmRetention,
  evaluateRetentionCut,
  renderRetentionMarkdown,
} from "./lib/utm-retention.ts";
import { parseSinceToEpochSeconds, parseUntilToEpochSecondsExclusive } from "./cohort-engagement.ts";

const SNAPSHOT_ROOT = "data/beehiiv-backup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const json = process.argv.includes("--json");
  const snapshot = arg("snapshot") ?? latestSnapshotDate(SNAPSHOT_ROOT);
  if (!snapshot) {
    console.error(`erro: nenhum snapshot em ${SNAPSHOT_ROOT}/ e --snapshot não foi passado.`);
    process.exit(1);
  }
  if (!arg("snapshot")) {
    console.error(
      `aviso: --snapshot não informado, usando o mais recente (${snapshot}). ` +
        `Pra apuração congelada, passe o MESMO snapshot do cac-report.`,
    );
  }

  let subs: BeehiivBackupSubscriber[];
  try {
    subs = readSnapshotSubscribers(SNAPSHOT_ROOT, snapshot);
  } catch (err) {
    console.error(`erro: não consegui ler o snapshot ${snapshot}: ${(err as Error).message}`);
    process.exit(1);
  }

  const desde = arg("desde");
  const ate = arg("ate");
  const since = desde ? parseSinceToEpochSeconds(desde) : null;
  const untilExclusive = ate ? parseUntilToEpochSecondsExclusive(ate) : null;

  let semCreated = 0;
  const naJanela = subs.filter((s) => {
    if (since == null && untilExclusive == null) return true;
    if (typeof s.created !== "number" || !Number.isFinite(s.created)) {
      // Nunca assumir dentro/fora — descarta e REPORTA (mesma disciplina de
      // `excludedMissingCreated` em cac.ts).
      semCreated++;
      return false;
    }
    if (since != null && s.created < since) return false;
    if (untilExclusive != null && s.created >= untilExclusive) return false;
    return true;
  });

  const arms = ARM_RETENTION_SPECS.map((spec) => computeArmRetention(naJanela, spec));
  const verdict = evaluateRetentionCut(arms);

  if (json) {
    console.log(JSON.stringify({ snapshot, desde: desde ?? null, ate: ate ?? null, semCreated, arms, verdict }, null, 2));
  } else {
    console.log(`<!-- snapshot: ${snapshot}${desde ? ` · desde ${desde}` : ""}${ate ? ` · até ${ate}` : ""} -->`);
    console.log("");
    console.log(renderRetentionMarkdown(arms, verdict));
    if (semCreated > 0) {
      console.log(`Descartados por \`created\` ausente/inválido (nunca assumidos dentro da janela): ${semCreated}.`);
    }
    for (const a of arms) {
      const hosts = Object.entries(a.orfaosPorHost).sort((x, y) => y[1] - x[1]);
      if (hosts.length > 0) {
        console.log("");
        console.log(`Órfãos de ${a.canal} por host: ${hosts.map(([h, n]) => `${h} (${n})`).join(", ")}.`);
      }
    }
  }

  if (!verdict.passa) process.exit(2);
}

main();
