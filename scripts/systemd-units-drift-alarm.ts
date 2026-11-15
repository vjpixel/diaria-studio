#!/usr/bin/env node
/**
 * scripts/systemd-units-drift-alarm.ts (#13152)
 *
 * Versão agendada do `setup-systemd-timers.ts --diff-installed` (#13136):
 * gera em memória as units do registro, compara com as instaladas em
 * `~/.config/systemd/user/` e abre (ou atualiza) uma issue de alarme quando
 * alguma diverge. Task `Diaria-Systemd-Units-Drift-Alarm`. Lógica pura em
 * `scripts/lib/systemd-units-drift-alarm.ts`.
 *
 * SÓ LEITURA do systemd: não escreve unit, não chama `systemctl`. Rearmar
 * segue manual (receita de `buildArmInstructions` em `setup-systemd-timers.ts`).
 *
 * Só roda do CHECKOUT PRINCIPAL. De um worktree, o `WorkingDirectory=` e o
 * caminho do `ExecStart=` gerados apontam para o worktree e todo `.service`
 * sairia divergente: o script recusa (exit 2) em vez de alarmar falso.
 *
 * Uso:
 *   npx tsx scripts/systemd-units-drift-alarm.ts              # compara + alarma/fecha
 *   npx tsx scripts/systemd-units-drift-alarm.ts --dry-run    # compara + imprime, sem gh
 *   npx tsx scripts/systemd-units-drift-alarm.ts --installed-dir <dir>
 *
 * Exit codes: 0 = sem divergência, ou divergência registrada na issue de
 * alarme (o alarme é a issue, não a unit `failed`: sair 1 aqui faria o
 * `Diaria-Systemd-Failed-Units-Alarm` avisar de novo o mesmo achado);
 * 1 = falha real (node do `.nvmrc` não resolvido, pasta de units ilegível,
 * `gh` falhou ao registrar); 2 = rodado de um worktree.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSupersededAlarmIssues, type CloseSupersededResult } from "./lib/alarm-issues.ts";
import { applyCliAction, type CliSpec, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { notifyEditor, type NotifyEditorFinding, type NotifyEditorResult } from "./lib/editor-notify.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { SCHEDULED_TASKS, type ScheduledTaskDefinition } from "./lib/scheduled-tasks.ts";
import { resolveCheckedSystemdNodeBinary } from "./lib/systemd-node-binary-checked.ts";
import type { InstalledUnitDiff } from "./lib/systemd-node-binary.ts";
import { systemdUserUnitDir } from "./lib/systemd-unit-exit-guard.ts";
import { buildSystemdUnitsDriftFinding, SYSTEMD_UNITS_DRIFT_CHECK } from "./lib/systemd-units-drift-alarm.ts";
import { collectInstalledUnitDiffs } from "./setup-systemd-timers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[systemd-units-drift-alarm]";

export const CLI_SPEC: CliSpec = {
  script: "scripts/systemd-units-drift-alarm.ts",
  booleans: ["dry-run"],
  values: ["installed-dir"],
};

/** `true` quando `.git` em `repoRootAbs` é ARQUIVO (worktree ligado). */
export function isLinkedWorktreeRoot(repoRootAbs: string): boolean {
  try {
    return statSync(join(repoRootAbs, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Dependências injetáveis (teste). Produção usa os defaults. */
export interface DriftAlarmDeps {
  repoRootAbs?: string;
  isWorktree?: (repoRootAbs: string) => boolean;
  resolveNodeBin?: () => string;
  tasks?: ScheduledTaskDefinition[];
  collect?: (
    tasks: ScheduledTaskDefinition[],
    repoRootAbs: string,
    nodeBin: string,
    installedDirAbs: string,
  ) => InstalledUnitDiff[];
  notify?: (finding: NotifyEditorFinding, cwd: string) => Promise<NotifyEditorResult>;
  closeSuperseded?: (check: string, fingerprint: string | null, cwd: string) => CloseSupersededResult;
}

function logClose(res: CloseSupersededResult): void {
  if (!res.listed) {
    console.warn(`${LOG_PREFIX} não foi possível listar issues de alarme abertas — fechamento automático adiado.`);
    return;
  }
  for (const n of res.closed) console.log(`${LOG_PREFIX} issue #${n} fechada (estado anterior não reproduz mais).`);
  for (const n of res.failed) console.error(`${LOG_PREFIX} falha ao fechar #${n} — retry na próxima execução.`);
}

export async function main(argv: string[], deps: DriftAlarmDeps = {}): Promise<number> {
  // #12503: argv validado antes de qualquer I/O (flag desconhecida = exit 1).
  const cliExit = applyCliAction(argv, CLI_SPEC);
  if (cliExit !== null) return cliExit;
  const repoRootAbs = deps.repoRootAbs ?? ROOT;
  const isDryRun = hasFlag(argv, "dry-run");
  let installedDirArg: string | undefined;
  try {
    installedDirArg = getStringArg(argv, "installed-dir", { example: "~/.config/systemd/user" });
  } catch (e) {
    console.error(`${LOG_PREFIX} ${(e as Error).message}`);
    return 1;
  }
  const installedDirAbs = installedDirArg ?? systemdUserUnitDir();

  if ((deps.isWorktree ?? isLinkedWorktreeRoot)(repoRootAbs)) {
    console.error(
      `${LOG_PREFIX} ${repoRootAbs} é um worktree: o WorkingDirectory= gerado apontaria para ele e todo .service ` +
        "sairia divergente. Rode do checkout principal (#13152).",
    );
    return 2;
  }

  let nodeBin: string;
  let diffs: InstalledUnitDiff[];
  try {
    nodeBin = (deps.resolveNodeBin ?? (() => resolveCheckedSystemdNodeBinary(undefined).path))();
    const tasks = (deps.tasks ?? SCHEDULED_TASKS).filter((t) => t.enabled !== false);
    diffs = (deps.collect ?? collectInstalledUnitDiffs)(tasks, repoRootAbs, nodeBin, installedDirAbs);
  } catch (e) {
    // Nada verificado: nunca vira "sem divergência" nem fecha issue aberta.
    console.error(`${LOG_PREFIX} nada verificado: ${(e as Error).message}`);
    return 1;
  }

  const finding = buildSystemdUnitsDriftFinding(diffs, installedDirAbs);
  const closeSuperseded = deps.closeSuperseded ?? ((c, f, cwd) => closeSupersededAlarmIssues(c, f, cwd));

  if (!finding) {
    console.log(`${LOG_PREFIX} ${diffs.length} unit(s) geradas, nenhuma instalada diverge (node ${nodeBin}).`);
    if (isDryRun) console.log(`${LOG_PREFIX} --dry-run: fecharia a(s) issue(s) abertas deste alarme — gh NÃO chamado.`);
    else logClose(closeSuperseded(SYSTEMD_UNITS_DRIFT_CHECK, null, repoRootAbs));
    return 0;
  }

  console.log(`${LOG_PREFIX} ${finding.subject}`);
  for (const d of finding.differs) console.log(`  DIVERGE ${d.fileName}`);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${finding.subject}\n--- body ---\n${finding.body}`);
    return 0;
  }

  const notify = deps.notify ?? ((f, cwd) => notifyEditor(f, { cwd }));
  const result = await notify(
    {
      check: SYSTEMD_UNITS_DRIFT_CHECK,
      fingerprint: finding.fingerprint,
      severity: "acao",
      family: "estado",
      priority: "P3",
      subject: finding.subject,
      body: finding.body,
    },
    repoRootAbs,
  );
  if (result.issue?.action === "failed") {
    console.error(`${LOG_PREFIX} ensureAlarmIssue falhou: ${result.issue.error}`);
    return 1;
  }
  console.log(`${LOG_PREFIX} alarme registrado (issue #${result.issue?.issueNumber ?? "?"}).`);
  logClose(closeSuperseded(SYSTEMD_UNITS_DRIFT_CHECK, finding.fingerprint, repoRootAbs));
  return 0;
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv(ROOT);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`${LOG_PREFIX} erro:`, e);
      process.exitCode = 1;
    },
  );
}
