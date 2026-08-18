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
 * ## Exit codes — o contrato que um wrapper de apuração lê
 *
 * | código | significado | ação |
 * |---|---|---|
 * | 0 | `passa` — todos os braços medidos, nenhum violou o corte | seguir |
 * | 1 | erro de OPERAÇÃO (snapshot ausente, data malformada, janela invertida) | consertar o comando |
 * | 2 | `reprova` — a comparação de custo está morta (§3.3 regra (a)) | não publicar ranking |
 * | 3 | `incompleto` — algum braço sem denominador | decisão humana (§248) |
 *
 * **2 e 3 são distintos de propósito:** as duas exigem ação humana, mas ações
 * diferentes. E 1 é distinto de 3 porque "não sei ler o snapshot" não é a mesma
 * coisa que "li e não havia dado" — a 1ª versão disto confundia os dois:
 * `readSnapshotSubscribers` devolve `[]` (não lança) quando o diretório não
 * existe, então um typo na data virava "sem dado" com exit 0.
 *
 * `main()` é exportado e recebe `snapshotRoot` opcional (#5650) pra permitir
 * teste de processo real (fixture em tmpdir) sem `process.exit` matando o
 * runner — segue o mesmo padrão de `cac-report.ts`: nunca chama
 * `process.exit` diretamente, só seta `process.exitCode` e retorna.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isMainModule } from "./lib/cli-args.ts";
import {
  latestSnapshotDate,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import {
  ARM_RETENTION_SPECS,
  computeArmRetention,
  countInatribuiveis,
  evaluateRetentionCut,
  exitCodeForOutcome,
  renderRetentionMarkdown,
} from "./lib/utm-retention.ts";
import {
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  resolveWindowGuardError,
} from "./cohort-engagement.ts";

const DEFAULT_SNAPSHOT_ROOT = "data/beehiiv-backup";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `snapshotRoot` default `DEFAULT_SNAPSHOT_ROOT` (caminho relativo ao cwd,
 * comportamento CLI inalterado). Testes injetam um tmpdir aqui pra nunca
 * depender de `data/beehiiv-backup` real. Nunca chama `process.exit` — só
 * seta `process.exitCode` e retorna, pra ser seguro de invocar dentro do
 * próprio processo de teste (`node:test`) sem encerrá-lo.
 */
export function main(argv: string[] = process.argv.slice(2), snapshotRoot: string = DEFAULT_SNAPSHOT_ROOT): void {
  function abort(msg: string): void {
    console.error(`erro: ${msg}`);
    process.exitCode = 1;
  }

  const json = argv.includes("--json");
  const snapshotArg = arg(argv, "snapshot");
  const snapshot = snapshotArg ?? latestSnapshotDate(snapshotRoot);
  if (!snapshot) return abort(`nenhum snapshot em ${snapshotRoot}/ e --snapshot não foi passado.`);
  if (!snapshotArg) {
    console.error(
      `aviso: --snapshot não informado, usando o mais recente (${snapshot}). ` +
        `Pra apuração congelada, passe o MESMO snapshot do cac-report.`,
    );
  }

  // Guard explícito: `readSnapshotSubscribers` NÃO lança com diretório ausente,
  // devolve []. Sem isto, um typo na data produziria "nenhum braço medido" —
  // indistinguível de um teste que ainda não veiculou.
  if (!existsSync(join(snapshotRoot, snapshot))) {
    return abort(`snapshot ${snapshot} não existe em ${snapshotRoot}/. Confira a data.`);
  }

  let subs: BeehiivBackupSubscriber[];
  try {
    subs = readSnapshotSubscribers(snapshotRoot, snapshot);
  } catch (err) {
    return abort(`não consegui ler o snapshot ${snapshot}: ${(err as Error).message}`);
  }

  const desde = arg(argv, "desde");
  const ate = arg(argv, "ate");
  let since: number | null = null;
  let untilExclusive: number | null = null;
  try {
    since = desde ? parseSinceToEpochSeconds(desde) : null;
    untilExclusive = ate ? parseUntilToEpochSecondsExclusive(ate) : null;
  } catch (err) {
    // Sem isto o processo morre com stack trace cru de cohort-engagement.ts,
    // inconsistente com o resto do arquivo e pior pra quem depura.
    return abort(`data inválida em --desde/--ate: ${(err as Error).message}`);
  }

  // Janela invertida devolveria zero assinantes com exit 0 — resultado vazio que
  // parece "não veiculou", quando é erro de digitação. Mesmo guard que
  // cohort-engagement.ts já aplica.
  const guardErr = resolveWindowGuardError({ since, untilExclusive }, { since: desde, until: ate });
  if (guardErr) return abort(guardErr);

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
  const inatribuiveis = countInatribuiveis(naJanela);

  if (json) {
    console.log(
      JSON.stringify(
        { snapshot, desde: desde ?? null, ate: ate ?? null, semCreated, inatribuiveis, arms, verdict },
        null,
        2,
      ),
    );
  } else {
    console.log(`<!-- snapshot: ${snapshot}${desde ? ` · desde ${desde}` : ""}${ate ? ` · até ${ate}` : ""} -->`);
    console.log("");
    console.log(renderRetentionMarkdown(arms, verdict, inatribuiveis));
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

  process.exitCode = exitCodeForOutcome(verdict.outcome);
}

if (isMainModule(import.meta.url)) {
  main();
}
