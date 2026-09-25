#!/usr/bin/env node
/**
 * scripts/tmp-disk-alarm.ts (#8828)
 *
 * Alarme agendado: lê a ocupação real do filesystem de `/tmp`
 * (`fs.statfsSync`) e alarma quando cruza
 * `DEFAULT_TMP_DISK_ALARM_THRESHOLD_PCT` (80%, ver docstring de
 * `scripts/lib/tmp-disk-alarm.ts`). Origem: EDQUOT em 25/09/2026 derrubou
 * TODO comando Bash de TODA sessão de Claude Code na máquina `300` sem
 * nenhum aviso prévio — este alarme é a rede de segurança contra a
 * PRÓXIMA vez, cobrindo `/tmp` inteiro (não só a fatia de
 * `scripts/cleanup-tmp-300.ts`, que só limpa o que é deste projeto).
 *
 * Mesmo molde de `scripts/kit-subscriber-limit-alarm.ts`: este arquivo faz
 * só I/O (`statfsSync` + issue via `scripts/lib/alarm-issues.ts` +
 * e-mail); toda decisão (threshold, corpo do achado) é pura e testada em
 * `scripts/lib/tmp-disk-alarm.ts`.
 *
 * ## Uso
 *
 *   npx tsx scripts/tmp-disk-alarm.ts               # avalia + persiste + alarma se NOVO cruzamento
 *   npx tsx scripts/tmp-disk-alarm.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/tmp-disk-alarm.ts --path /tmp    # override do path checado (default /tmp; testes)
 *   npx tsx scripts/tmp-disk-alarm.ts --to email@x   # override do destinatário
 *
 * ## Guard de publicação
 *
 * Só LEITURA (`statfsSync`) — nenhuma escrita no filesystem, nenhuma
 * decisão de limpar nada (isso é `scripts/cleanup-tmp-300.ts`, script
 * separado e deliberadamente conservador).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { statfsSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import {
  evaluateTmpDiskAlarm,
  blocksToGiB,
  TMP_DISK_ALARM_FINDING_KEY,
  type TmpDiskEvaluation,
} from "./lib/tmp-disk-alarm.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "tmp-disk-alarm", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[tmp-disk-alarm]";
/** Cadência da task é diária (#8828) — 2 execuções limpas consecutivas =
 *  ~2 dias sem cruzar o threshold antes de fechar a issue automaticamente,
 *  mesmo default do resto do repo. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

function toAlarmFindings(evaluation: TmpDiskEvaluation, blockSizeBytes: number, path: string): AlarmFinding[] {
  if (!evaluation.triggered) return [];
  const thresholdDisplay = `${Math.round(evaluation.thresholdPct * 100)}%`;
  const occupancyDisplay = `${Math.round(evaluation.occupancyPct * 100)}%`;
  const totalGiB = blocksToGiB(evaluation.totalBlocks, blockSizeBytes).toFixed(1);
  const availableGiB = blocksToGiB(evaluation.availableBlocks, blockSizeBytes).toFixed(1);
  return [
    {
      check: TMP_DISK_ALARM_FINDING_KEY,
      fingerprint: TMP_DISK_ALARM_FINDING_KEY,
      family: "estado",
      title: `[diar.ia.br] ${path}: ocupação em ${occupancyDisplay} cruzou o alarme de ${thresholdDisplay} (${availableGiB} GiB livres de ${totalGiB} GiB)`,
      body: [
        `Achado automático do alarme \`Diaria-Tmp-Disk-Alarm\` (\`scripts/tmp-disk-alarm.ts\`).`,
        "",
        `Filesystem: ${path} | ocupação: ${occupancyDisplay} | threshold: ${thresholdDisplay} | ` +
          `total: ${totalGiB} GiB | disponível: ${availableGiB} GiB.`,
        "",
        "Origem: em 25/09/2026 o /tmp do servidor 300 estourou a cota (EDQUOT)",
        "sem nenhum aviso prévio, derrubando todo comando Bash de toda sessão",
        "de Claude Code na máquina (#8828). Este alarme existe pra avisar ANTES",
        "da próxima vez.",
        "",
        "`scripts/cleanup-tmp-300.ts` (task diária) limpa só a fatia de /tmp que",
        "é deste projeto (/tmp/claude-{uid}) — se este achado persistir mesmo",
        "com essa limpeza rodando, o consumo real está em outro lugar (cache do",
        "wrangler/esbuild, clones de isolamento de worktree do harness, caches",
        "de ferramenta como gh-cli-cache/node-compile-cache/tsx-1000) e precisa",
        "de limpeza manual na máquina — ver diagnóstico completo na docstring",
        "de scripts/cleanup-tmp-300.ts.",
        "",
        "Esta issue é criada automaticamente pelo alarme e será",
        "comentada/fechada sozinha quando a ocupação cair de volta abaixo do",
        `threshold por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
      ].join("\n"),
      labels: ["bug"],
      priority: "P1",
    },
  ];
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const path = getArg(argv, "path") || "/tmp";

  const stat = statfsSync(path);
  const evaluation = evaluateTmpDiskAlarm({ totalBlocks: stat.blocks, availableBlocks: stat.bavail });

  console.log(
    `${LOG_PREFIX} path=${path} ocupacao=${Math.round(evaluation.occupancyPct * 100)}% ` +
      `threshold=${Math.round(evaluation.thresholdPct * 100)}% triggered=${evaluation.triggered}`,
  );

  const alarmFindings = toAlarmFindings(evaluation, stat.bsize, path);
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const o of findingOutcomes) {
    if (o.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${o.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (abaixo do threshold).`);
    return;
  }

  const result = await notifyEditorForOutcomes(
    findingOutcomes,
    "acao",
    () => ({
      subject: `[diar.ia.br] ${path}: ocupação cruzou ${Math.round(evaluation.thresholdPct * 100)}%`,
      body: alarmFindings[0]?.body ?? "",
    }),
    {
      cwd: ROOT,
      platformConfigPath: PLATFORM_CONFIG_PATH,
      emailTo: toOverride,
      legacyResendIntent: "dedupe-new-occurrences-only",
    },
  );
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado.`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
