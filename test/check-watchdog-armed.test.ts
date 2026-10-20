/**
 * check-watchdog-armed.test.ts (#2768, #2814)
 *
 * Cobre a decisão pura `decideWatchdogArmingAction`. NUNCA chama `schtasks`
 * real nem `setup-watchdog-schedule.ps1` (instrução explícita da issue
 * #2768) — apenas strings fixture, mesmo padrão de `test/exec-mode.test.ts`
 * e `test/overnight-watchdog.test.ts`.
 *
 * #2814: cobre também `queryWatchdogTaskExitCode`, o caminho de detecção
 * real usado por `checkWatchdogArmed` desde o fix do bug #1 (falso-negativo
 * em Windows localizado — um parser textual legado (`isWatchdogTaskScheduled`,
 * removido no #7123 por não ter mais consumidor de produção — a detecção
 * real sempre foi via exit code) nunca casava com "Nome da Tarefa:" do
 * schtasks PT-BR. Testado via injeção de um mock de `execFileSync`
 * (parâmetro `exec`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  decideWatchdogArmingAction,
  buildWatchdogWarningMessage,
  queryWatchdogTaskExitCode,
  WATCHDOG_TASK_NAME,
  parseWatchdogTaskState,
  classifyWatchdogTaskHealth,
  decideWatchdogArmedStatus,
  buildWatchdogHealthWarningMessage,
  queryWatchdogTaskVerboseOutput,
  buildWatchdogCannotVerifyMessage,
  checkWatchdogArmed,
  queryLinuxTimerArmed,
  watchdogTimerUnitName,
  buildWatchdogLinuxNotArmedMessage,
  buildWatchdogLinuxDisabledMessage,
  buildWatchdogLinuxCannotVerifyMessage,
  parseTimerOnCalendar,
  decideWatchdogScheduleStatus,
  queryLinuxTimerOnCalendar,
  parseTimersCalendarShow,
  NOT_RELOADED_MARKER,
  buildWatchdogLinuxStaleScheduleMessage,
  type LinuxWatchdogArmedResult,
} from "../scripts/lib/check-watchdog-armed.ts";
import { buildWatchdogOnCalendar, buildWatchdogSystemdUnitFiles } from "../scripts/lib/watchdog-systemd-units.ts";

// ---------------------------------------------------------------------------
// Fixtures de output real do `schtasks /query /tn "..." /fo LIST`
// ---------------------------------------------------------------------------

// Único fixture ainda referenciado nesta suíte fora do parser textual
// removido no #7123 (`isWatchdogTaskScheduled`) — mantido de propósito.
const FIXTURE_TASK_ABSENT = `ERROR: The system cannot find the file specified.\r\n`;

// ---------------------------------------------------------------------------
// decideWatchdogArmingAction
// ---------------------------------------------------------------------------

describe("decideWatchdogArmingAction", () => {
  it("modo cloud → skip_cloud independente de armed", () => {
    assert.equal(decideWatchdogArmingAction("cloud", true), "skip_cloud");
    assert.equal(decideWatchdogArmingAction("cloud", false), "skip_cloud");
  });

  it("modo local + armado → armed", () => {
    assert.equal(decideWatchdogArmingAction("local", true), "armed");
  });

  it("modo local + não armado → not_armed_warn", () => {
    assert.equal(decideWatchdogArmingAction("local", false), "not_armed_warn");
  });
});

// ---------------------------------------------------------------------------
// buildWatchdogWarningMessage
// ---------------------------------------------------------------------------

describe("buildWatchdogWarningMessage", () => {
  it("menciona o nome da task e a via real (systemd, pos-#5115)", () => {
    const msg = buildWatchdogWarningMessage();
    assert.match(msg, new RegExp(WATCHDOG_TASK_NAME));
    assert.match(msg, /systemd/);
    assert.doesNotMatch(msg, /setup-watchdog-schedule\.ps1/);
  });
});

// ---------------------------------------------------------------------------
// queryWatchdogTaskExitCode (#2814 — caminho de detecção real, locale-agnóstico)
// ---------------------------------------------------------------------------

describe("queryWatchdogTaskExitCode", () => {
  it("retorna 0 quando o exec mockado não lança (task existe, independente de locale)", () => {
    const mockExec = (() => "") as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskExitCode(mockExec), 0);
  });

  it("retorna 1 quando o exec mockado lança com status 1 (task ausente, output PT-BR)", () => {
    const mockExec = (() => {
      const err = Object.assign(new Error("comando falhou"), {
        status: 1,
        // Locale PT-BR: mensagem localizada que um parser textual antigo (removido
        // no #7123) nunca reconhecia — o caminho por exit code não olha pra essa
        // string, só pro status. Reusa o fixture EN só como corpo de mensagem
        // qualquer — o que importa é o `status`, não o texto.
        stderr: FIXTURE_TASK_ABSENT,
      });
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskExitCode(mockExec), 1);
  });

  it("retorna o status exato quando o exec mockado lança com outro código (ex: erro de permissão)", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("acesso negado"), { status: 5 });
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskExitCode(mockExec), 5);
  });

  it("retorna 1 (fallback) quando o erro não tem status numérico", () => {
    const mockExec = (() => {
      throw new Error("erro sem status");
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskExitCode(mockExec), 1);
  });

  it("retorna null quando o exec mockado lança ENOENT (schtasks indisponível — não-Windows)", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("spawn schtasks ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskExitCode(mockExec), null);
  });

  it("é robusto a output PT-BR — bug 1 original (#2814)", () => {
    // Regressão direta do bug relatado: schtasks PT-BR emite "Nome da Tarefa:"
    // em vez de "TaskName:". Um parser textual antigo (removido no #7123)
    // falhava nesse fixture (falso negativo); o caminho por exit code (o
    // único em produção) não depende do texto — só do exit code do processo
    // real, então reconhece a task independente do locale do output.
    const PTBR_OUTPUT = "Nome da Tarefa:                       \\Diaria-Overnight-Watchdog\nStatus:                                Pronto";
    const mockExecArmed = (() => PTBR_OUTPUT) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskExitCode(mockExecArmed), 0);
  });
});

// ---------------------------------------------------------------------------
// parseWatchdogTaskState / classifyWatchdogTaskHealth / decideWatchdogArmedStatus (#2944)
// ---------------------------------------------------------------------------

// Fixture real capturada na investigação do #2944 (260703-260704, máquina
// ZENBOOK): task presente, enabled, último run bem-sucedido — o caso são.
const FIXTURE_VERBOSE_HEALTHY = `
Folder: \\
HostName:                             ZENBOOK
TaskName:                             \\Diaria-Overnight-Watchdog
Next Run Time:                        04-Jul-26 6:00:00 PM
Status:                               Ready
Logon Mode:                           Interactive only
Last Run Time:                        04-Jul-26 9:00:00 AM
Last Result:                          0
Author:                               N/A
Task To Run:                          npx tsx "C:\\Users\\pixel\\Projects\\diaria-studio\\scripts\\overnight-watchdog.ts"
Start In:                             C:\\Users\\pixel\\Projects\\diaria-studio
Comment:                               diar.ia.br: watchdog de stall overnight (#2688) - roda a cada 10 min entre 18:00-09:00.
Scheduled Task State:                 Enabled
Repeat: Every:                        0 Hour(s), 10 Minute(s)
`;

const FIXTURE_VERBOSE_DISABLED = FIXTURE_VERBOSE_HEALTHY.replace(
  "Scheduled Task State:                 Enabled",
  "Scheduled Task State:                 Disabled",
);

const FIXTURE_VERBOSE_LAST_RUN_FAILED = FIXTURE_VERBOSE_HEALTHY.replace(
  "Last Result:                          0",
  "Last Result:                          1",
);

const FIXTURE_VERBOSE_NEVER_RUN = FIXTURE_VERBOSE_HEALTHY.replace(
  "Last Run Time:                        04-Jul-26 9:00:00 AM",
  "Last Run Time:                        N/A",
).replace("Last Result:                          0", "Last Result:                          N/A");

describe("parseWatchdogTaskState (#2944)", () => {
  it("fixture real saudável (investigação #2944): enabled=true, lastResult=0, neverRun=false", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_HEALTHY);
    assert.equal(state.enabled, true);
    assert.equal(state.lastResult, 0);
    assert.equal(state.neverRun, false);
    assert.equal(state.lastRunTime, "04-Jul-26 9:00:00 AM");
  });

  it("task desabilitada: enabled=false", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_DISABLED);
    assert.equal(state.enabled, false);
  });

  it("última execução falhou: lastResult != 0", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_LAST_RUN_FAILED);
    assert.equal(state.lastResult, 1);
  });

  it("nunca rodou: neverRun=true, lastResult=null (N/A não é numérico)", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_NEVER_RUN);
    assert.equal(state.neverRun, true);
    assert.equal(state.lastResult, null);
  });

  it("output vazio: todos os campos null/false (fail-soft, não lança)", () => {
    const state = parseWatchdogTaskState("");
    assert.deepEqual(state, {
      enabled: null,
      lastResult: null,
      lastRunTime: null,
      neverRun: false,
    });
  });

  it("output malformado/locale não reconhecido: fail-soft para null (nunca finge saber)", () => {
    const state = parseWatchdogTaskState("Estado da Tarefa Agendada: Habilitada\n");
    assert.equal(state.enabled, null);
  });
});

describe("classifyWatchdogTaskHealth (#2944)", () => {
  it("fixture saudável → healthy", () => {
    assert.equal(
      classifyWatchdogTaskHealth(parseWatchdogTaskState(FIXTURE_VERBOSE_HEALTHY)),
      "healthy",
    );
  });

  it("desabilitada → disabled (mesmo com last result 0 de uma execução anterior)", () => {
    assert.equal(
      classifyWatchdogTaskHealth(parseWatchdogTaskState(FIXTURE_VERBOSE_DISABLED)),
      "disabled",
    );
  });

  it("último run falhou → last_run_failed", () => {
    assert.equal(
      classifyWatchdogTaskHealth(parseWatchdogTaskState(FIXTURE_VERBOSE_LAST_RUN_FAILED)),
      "last_run_failed",
    );
  });

  it("nunca rodou → never_run", () => {
    assert.equal(
      classifyWatchdogTaskHealth(parseWatchdogTaskState(FIXTURE_VERBOSE_NEVER_RUN)),
      "never_run",
    );
  });

  it("Last Result 267009 (SCHED_S_TASK_RUNNING) → healthy, NÃO last_run_failed (finding review 260704)", () => {
    // Sentinela de sucesso/info: a task está rodando AGORA (0x41301). Um health-check
    // que corre durante a execução de 10min do watchdog não deve reportar falha.
    assert.equal(
      classifyWatchdogTaskHealth({ enabled: true, lastResult: 267009, lastRunTime: "04-Jul-26 6:00:02 PM", neverRun: false }),
      "healthy",
    );
    // 267011 (0x41303, "ainda não rodou") também não é falha.
    assert.equal(
      classifyWatchdogTaskHealth({ enabled: true, lastResult: 267011, lastRunTime: "N/D", neverRun: false }),
      "healthy",
    );
    // 267014 (0x41306 TERMINATED) CONTINUA sendo falha (foi o valor do stall 260703).
    assert.equal(
      classifyWatchdogTaskHealth({ enabled: true, lastResult: 267014, lastRunTime: "04-Jul-26 6:00:02 PM", neverRun: false }),
      "last_run_failed",
    );
  });

  it("nenhum campo reconhecido (locale não suportado) → unknown, NÃO disabled/stale (fail-soft, evita regressão #2814)", () => {
    assert.equal(
      classifyWatchdogTaskHealth(
        parseWatchdogTaskState("Estado da Tarefa Agendada: Habilitada\n"),
      ),
      "unknown",
    );
  });
});

describe("decideWatchdogArmedStatus (#2944)", () => {
  it("task ausente → not_armed independente da saúde", () => {
    assert.equal(decideWatchdogArmedStatus(false, "healthy"), "not_armed");
    assert.equal(decideWatchdogArmedStatus(false, "disabled"), "not_armed");
  });

  it("task presente + healthy → armed", () => {
    assert.equal(decideWatchdogArmedStatus(true, "healthy"), "armed");
  });

  it("task presente + unknown (fail-soft) → armed, nunca rebaixa por falta de dado", () => {
    assert.equal(decideWatchdogArmedStatus(true, "unknown"), "armed");
  });

  it("task presente + disabled → armed_but_disabled (o caso central do #2944: falsa confiança)", () => {
    assert.equal(decideWatchdogArmedStatus(true, "disabled"), "armed_but_disabled");
  });

  it("task presente + last_run_failed → armed_but_stale", () => {
    assert.equal(decideWatchdogArmedStatus(true, "last_run_failed"), "armed_but_stale");
  });

  it("task presente + never_run → armed_but_never_run", () => {
    assert.equal(decideWatchdogArmedStatus(true, "never_run"), "armed_but_never_run");
  });
});

describe("buildWatchdogHealthWarningMessage (#2944)", () => {
  it("armed_but_disabled menciona DESABILITADA e o comando de reativação", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_DISABLED);
    const msg = buildWatchdogHealthWarningMessage("armed_but_disabled", state);
    assert.match(msg, /DESABILITADA/);
    assert.match(msg, /\/enable/);
    assert.match(msg, new RegExp(WATCHDOG_TASK_NAME));
  });

  it("armed_but_stale menciona a falha da última execução", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_LAST_RUN_FAILED);
    const msg = buildWatchdogHealthWarningMessage("armed_but_stale", state);
    assert.match(msg, /FALHOU/);
    assert.match(msg, /Last Result: 1/);
  });

  it("armed_but_never_run menciona N/A e o trigger/agendamento", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_NEVER_RUN);
    const msg = buildWatchdogHealthWarningMessage("armed_but_never_run", state);
    assert.match(msg, /NUNCA rodou/);
  });

  it("fallback (status 'armed'/'not_armed') delega para buildWatchdogWarningMessage", () => {
    const state = parseWatchdogTaskState(FIXTURE_VERBOSE_HEALTHY);
    const msg = buildWatchdogHealthWarningMessage("not_armed", state);
    assert.equal(msg, buildWatchdogWarningMessage());
  });
});

// ---------------------------------------------------------------------------
// buildWatchdogCannotVerifyMessage / checkWatchdogArmed roteamento (#4800)
//
// Regressão do bug relatado: numa máquina Linux com `data/` presente (logo
// `mode === "local"`), `detectTaskScheduler` responde `'none'`/`'systemd'`
// (nunca `'windows-task-scheduler'`) — o resultado deve ser o terceiro
// estado explícito `armedStatus: "cannot_verify"`, NUNCA `"not_armed"`
// (que teria mandado o editor rodar um comando pwsh inaplicável naquela
// máquina). `checkWatchdogArmed` é exercitado via as injeções opcionais
// (`execModeFn`/`taskSchedulerFn`/`emitWarn`) — nunca chama `schtasks`,
// PowerShell, nem spawna `npx tsx log-event.ts` de verdade (mesma
// disciplina de fixture-only do resto deste arquivo).
// ---------------------------------------------------------------------------

describe("buildWatchdogCannotVerifyMessage (#4800)", () => {
  it("caso 'systemd': nomeia o systemd e o #4798, nunca sugere um COMANDO de arme (pwsh/ps1)", () => {
    const msg = buildWatchdogCannotVerifyMessage("systemd");
    assert.match(msg, /systemd/);
    assert.match(msg, /#4798/);
    // "schtasks" pode aparecer como EXPLICAÇÃO de por que a checagem não
    // funciona nesta plataforma (esta checagem só sabe consultar schtasks);
    // o que a issue proíbe é sugerir um COMANDO de arme Windows pra rodar
    // (o .ps1 que fazia isso foi removido no #5115).
    assert.doesNotMatch(msg, /pwsh -NoProfile/i);
    assert.doesNotMatch(msg, /powershell -NoProfile/i);
    assert.doesNotMatch(msg, /setup-watchdog-schedule\.ps1/i);
  });

  it("caso 'none': não inventa nenhuma instrução de arme", () => {
    const msg = buildWatchdogCannotVerifyMessage("none");
    assert.doesNotMatch(msg, /pwsh -NoProfile/i);
    assert.doesNotMatch(msg, /powershell -NoProfile/i);
    assert.doesNotMatch(msg, /setup-watchdog-schedule\.ps1/i);
  });

  it("diferencia explicitamente de 'não armado' — diz que não deu pra verificar", () => {
    const msg = buildWatchdogCannotVerifyMessage("none");
    assert.match(msg, /NÃO PÔDE SER VERIFICADO/);
    assert.match(msg, /diferente de "não armado"/);
  });
});

describe("checkWatchdogArmed roteamento por agendador (#4800 regressão)", () => {
  it("Linux sem schtasks disponível (schedulerKind='none') → cannot_verify, NUNCA not_armed", () => {
    const emitted: Array<{ message: string; eventMessage?: string }> = [];
    const result = checkWatchdogArmed({
      execModeFn: () => "local",
      taskSchedulerFn: () => "none",
      emitWarn: (message, eventMessage) => emitted.push({ message, eventMessage }),
    });

    assert.equal(result.mode, "local");
    assert.equal(result.armed, false);
    assert.equal(result.action, "cannot_verify_warn");
    assert.equal(result.armedStatus, "cannot_verify");
    assert.notEqual(result.armedStatus, "not_armed");
    assert.equal(result.taskState, null);
    assert.doesNotMatch(result.message, /pwsh/i);
    assert.doesNotMatch(result.message, /setup-watchdog-schedule\.ps1/i);

    // Warning foi emitido (fail-soft, mas visível) com o rótulo distinto de
    // "watchdog_not_armed" — o run-log não deve mentir por rótulo mesmo com
    // a mensagem já corrigida.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventMessage, "watchdog_cannot_verify");
  });

  it("modo cloud → skip_cloud independente do agendador (taskSchedulerFn nem é chamado)", () => {
    let taskSchedulerCalled = false;
    const result = checkWatchdogArmed({
      execModeFn: () => "cloud",
      taskSchedulerFn: () => {
        taskSchedulerCalled = true;
        return "windows-task-scheduler";
      },
      emitWarn: () => {
        throw new Error("não deveria emitir warning em modo cloud");
      },
    });
    assert.equal(result.action, "skip_cloud");
    assert.equal(taskSchedulerCalled, false);
  });

  // Nota: um teste com `taskSchedulerFn: () => "windows-task-scheduler"` foi
  // deliberadamente OMITIDO aqui — `checkWatchdogArmed` não expõe injeção
  // para `queryWatchdogTaskExitCode`/`queryWatchdogTaskVerboseOutput`
  // (só para `execModeFn`/`taskSchedulerFn`/`emitWarn`), então esse caminho
  // chamaria `schtasks` de verdade em CI Windows — o mesmo motivo pelo qual
  // este arquivo já testa esses dois helpers separadamente, via seus
  // próprios parâmetros `exec` injetáveis (ver `queryWatchdogTaskExitCode`
  // acima), nunca através de `checkWatchdogArmed` end-to-end.
});

describe("queryWatchdogTaskVerboseOutput (#2944)", () => {
  it("retorna o stdout quando o exec mockado não lança", () => {
    const mockExec = (() => FIXTURE_VERBOSE_HEALTHY) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskVerboseOutput(mockExec), FIXTURE_VERBOSE_HEALTHY);
  });

  it("retorna null quando o exec mockado lança (task ausente ou schtasks indisponível)", () => {
    const mockExec = (() => {
      throw new Error("comando falhou");
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryWatchdogTaskVerboseOutput(mockExec), null);
  });
});

// ---------------------------------------------------------------------------
// queryLinuxTimerArmed / branch systemd de checkWatchdogArmed (#4857)
//
// NUNCA chama `systemctl` real — todo caso passa um mock de `exec`
// (`queryLinuxTimerArmed`) ou de `queryLinuxTimerArmedFn`
// (`checkWatchdogArmed`), mesma disciplina de fixture-only do resto deste
// arquivo. `watchdogTimerUnitName()` == "diaria-overnight-watchdog.timer" —
// travado contra `unitBaseName(WATCHDOG_TASK_NAME)` pra nunca divergir em
// silêncio do que `scripts/lib/systemd-units.ts`/`watchdog-systemd-units.ts`
// geram.
// ---------------------------------------------------------------------------

describe("watchdogTimerUnitName (#4857)", () => {
  it("deriva o nome do unit a partir de WATCHDOG_TASK_NAME (kebab-case + .timer)", () => {
    assert.equal(watchdogTimerUnitName(), "diaria-overnight-watchdog.timer");
  });
});

describe("queryLinuxTimerArmed (#4857)", () => {
  it("'enabled' → armed", () => {
    const mockExec = (() => "enabled\n") as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec), { state: "armed", note: null });
  });

  it("'disabled' (stdout, exit 0) → disabled", () => {
    const mockExec = (() => "disabled\n") as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec), { state: "disabled", note: null });
  });

  it("'disabled' via exceção com stdout (variante real do systemctl: is-enabled sai != 0 pra disabled)", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("exit 1"), { status: 1, stdout: "disabled\n", stderr: "" });
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec), { state: "disabled", note: null });
  });

  it("unit ausente ('not-found', caminho de sucesso hipotético) → not_armed", () => {
    const mockExec = (() => "not-found\n") as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec), { state: "not_armed", note: null });
  });

  it("unit ausente via exceção com stdout 'not-found' — REGRESSÃO (#4857, achado ao vivo): " +
    "systemctl --user is-enabled real sai != 0 (não 0) pra unit ausente, com 'not-found' em stdout do ERRO, " +
    "não do caminho de sucesso. Sem este branch, virava cannot_verify.", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("Command failed"), { status: 4, stdout: "not-found\n", stderr: "" });
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec), { state: "not_armed", note: null });
  });

  it("stdout vazio → not_armed", () => {
    const mockExec = (() => "") as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec), { state: "not_armed", note: null });
  });

  it("systemctl ausente (ENOENT) → cannot_verify, note explica o motivo", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec);
    assert.equal(result.state, "cannot_verify");
    assert.match(result.note ?? "", /ENOENT/);
  });

  it("sessão --user indisponível ('Failed to connect to bus') → cannot_verify, nunca not_armed", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("exit 1"), {
        status: 1,
        stdout: "",
        stderr: "Failed to connect to bus: No such file or directory\n",
      });
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec);
    assert.equal(result.state, "cannot_verify");
    assert.notEqual(result.state, "not_armed");
  });

  it("erro inesperado não reconhecido → cannot_verify (conservador — nunca inventa armed/not_armed)", () => {
    const mockExec = (() => {
      throw Object.assign(new Error("exit 3"), { status: 3, stdout: "", stderr: "Permission denied\n" });
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = queryLinuxTimerArmed(WATCHDOG_TASK_NAME, mockExec);
    assert.equal(result.state, "cannot_verify");
    assert.match(result.note ?? "", /Permission denied/);
  });

  it("usa unitBaseName(taskName) — outra task além do watchdog resolve pra outro unit", () => {
    let calledUnit: string | undefined;
    const mockExec = ((_cmd: string, args: string[]) => {
      calledUnit = args[2];
      return "enabled\n";
    }) as unknown as typeof import("node:child_process").execFileSync;
    queryLinuxTimerArmed("Diaria-Apoios-Diff-Alarm", mockExec);
    assert.equal(calledUnit, "diaria-apoios-diff-alarm.timer");
  });
});

describe("queryLinuxTimerArmed — validação real via systemctl (quando disponível, #4857)", () => {
  // Complementa os mocks acima com a validação AUTORITATIVA que encontrou o
  // achado ao vivo desta unidade: bater o `systemctl` DE VERDADE (sessão
  // `--user` desta máquina) contra uma unit garantidamente inexistente —
  // read-only, nunca cria/altera/habilita nenhuma unit — e confirmar que o
  // resultado é `not_armed`, nunca `cannot_verify`. Skip gracioso se
  // `systemctl --user` não responder (ex: CI sem sessão de usuário/bus).
  let userSystemctlWorks = false;
  try {
    execFileSync("systemctl", ["--user", "is-enabled", "diaria-4857-unit-que-nunca-existe.timer"], {
      stdio: "pipe",
    });
    userSystemctlWorks = true; // não deveria chegar aqui (unit não existe)
  } catch (e: unknown) {
    const err = e as { code?: string; stdout?: string; stderr?: string };
    // "Funciona" = o systemctl respondeu de forma reconhecível (stdout
    // "not-found"), não necessariamente com exit 0. Só ENOENT/bus
    // indisponível desqualifica a validação.
    userSystemctlWorks =
      err.code !== "ENOENT" && String(err.stdout ?? "").trim() === "not-found";
  }

  it("unit garantidamente inexistente → not_armed (nunca cannot_verify)", { skip: !userSystemctlWorks }, () => {
    const result = queryLinuxTimerArmed("Diaria-4857-Unit-Que-Nunca-Existe");
    assert.equal(result.state, "not_armed");
  });
});

describe("buildWatchdogLinux*Message (#4857)", () => {
  it("not_armed menciona o unit, o gerador de units e o comando enable --now", () => {
    const msg = buildWatchdogLinuxNotArmedMessage();
    assert.match(msg, /diaria-overnight-watchdog\.timer/);
    assert.match(msg, /setup-watchdog-schedule-systemd\.ts/);
    assert.match(msg, /systemctl --user enable --now/);
  });

  it("disabled menciona DESABILITADA, o #2944 e o comando de reativação", () => {
    const msg = buildWatchdogLinuxDisabledMessage();
    assert.match(msg, /DESABILITADA/);
    assert.match(msg, /#2944/);
    assert.match(msg, /systemctl --user enable --now diaria-overnight-watchdog\.timer/);
  });

  it("cannot_verify inclui o note quando presente, e nunca afirma 'não armado'", () => {
    const msg = buildWatchdogLinuxCannotVerifyMessage("systemctl indisponível (ENOENT) nesta consulta.");
    assert.match(msg, /ENOENT/);
    assert.doesNotMatch(msg, /^Watchdog.*NÃO está armado/);
  });

  it("cannot_verify sem note ainda produz mensagem coerente", () => {
    const msg = buildWatchdogLinuxCannotVerifyMessage(null);
    assert.match(msg, /NÃO PÔDE SER VERIFICADO via systemd/);
  });
});

describe("checkWatchdogArmed — roteamento systemd (#4857, #633)", () => {
  const injected = (result: LinuxWatchdogArmedResult) => ({
    execModeFn: () => "local" as const,
    taskSchedulerFn: () => "systemd" as const,
    queryLinuxTimerArmedFn: () => result,
    // #10571: nunca deixar o default (systemctl real) rodar em teste.
    queryLinuxTimerOnCalendarFn: () => [buildWatchdogOnCalendar()],
  });

  it("timer armado → armed:true, action:'armed', armedStatus:'armed', sem emitir warning", () => {
    const emitted: unknown[] = [];
    const result = checkWatchdogArmed({
      ...injected({ state: "armed", note: null }),
      emitWarn: (...args) => emitted.push(args),
    });
    assert.equal(result.mode, "local");
    assert.equal(result.armed, true);
    assert.equal(result.action, "armed");
    assert.equal(result.armedStatus, "armed");
    assert.equal(result.taskState, null);
    assert.equal(emitted.length, 0);
  });

  it("unit ausente → armed:false, action:'not_armed_warn', armedStatus:'not_armed', emite warning", () => {
    const emitted: Array<{ message: string; eventMessage?: string }> = [];
    const result = checkWatchdogArmed({
      ...injected({ state: "not_armed", note: null }),
      emitWarn: (message, eventMessage) => emitted.push({ message, eventMessage }),
    });
    assert.equal(result.armed, false);
    assert.equal(result.action, "not_armed_warn");
    assert.equal(result.armedStatus, "not_armed");
    assert.match(result.message, /setup-watchdog-schedule-systemd\.ts/);
    assert.equal(emitted.length, 1);
  });

  it("unit desabilitada → armedStatus:'armed_but_disabled', action:'not_armed_warn' (mesma classe do #2944)", () => {
    const result = checkWatchdogArmed({
      ...injected({ state: "disabled", note: null }),
      emitWarn: () => {},
    });
    assert.equal(result.armed, false);
    assert.equal(result.action, "not_armed_warn");
    assert.equal(result.armedStatus, "armed_but_disabled");
    assert.match(result.message, /DESABILITADA/);
  });

  it("consulta falha (cannot_verify) → armedStatus:'cannot_verify', NUNCA not_armed", () => {
    const emitted: Array<{ message: string; eventMessage?: string }> = [];
    const result = checkWatchdogArmed({
      ...injected({ state: "cannot_verify", note: "sessão systemd --user indisponível." }),
      emitWarn: (message, eventMessage) => emitted.push({ message, eventMessage }),
    });
    assert.equal(result.action, "cannot_verify_warn");
    assert.equal(result.armedStatus, "cannot_verify");
    assert.notEqual(result.armedStatus, "not_armed");
    assert.match(result.message, /indisponível/);
    assert.equal(emitted[0]?.eventMessage, "watchdog_cannot_verify");
  });

  it("default (sem queryLinuxTimerArmedFn) usa a função real — não exercitado aqui de propósito (chamaria systemctl real)", () => {
    // Nenhuma asserção de comportamento aqui — este teste documenta a
    // omissão: `checkWatchdogArmed({ taskSchedulerFn: () => "systemd" })`
    // SEM `queryLinuxTimerArmedFn` chamaria `queryLinuxTimerArmed` real (que
    // spawna `systemctl` de verdade) — mesmo motivo pelo qual o caminho
    // Windows já omite esse tipo de teste end-to-end (ver nota acima, describe
    // "checkWatchdogArmed roteamento por agendador"). A cobertura do
    // ROTEAMENTO fica inteiramente nos testes acima, via injeção.
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// #10571 — timer habilitado com OnCalendar antigo não pode reportar "armed"
// ---------------------------------------------------------------------------

/** Unit REAL anterior ao #10565 (janela 18:00–09:00), como `systemctl --user cat` imprime. */
const CAT_TIMER_PRE_10565 = [
  "# /home/vjpixel/.config/systemd/user/diaria-overnight-watchdog.timer",
  "[Unit]",
  "Description=diar.ia.br: watchdog de stall overnight (#2688) (timer) — a cada 10 min, 18:00-09:00 BRT",
  "",
  "[Timer]",
  "OnCalendar=*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo",
  "Persistent=true",
  "Unit=diaria-overnight-watchdog.service",
  "",
  "[Install]",
  "WantedBy=timers.target",
  "",
].join("\n");

describe("parseTimerOnCalendar (#10571)", () => {
  it("extrai o OnCalendar da unit antiga", () => {
    assert.deepEqual(parseTimerOnCalendar(CAT_TIMER_PRE_10565), [
      "*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo",
    ]);
  });

  it("unit gerada hoje casa com buildWatchdogOnCalendar()", () => {
    const { timerContent } = buildWatchdogSystemdUnitFiles("/repo");
    assert.deepEqual(parseTimerOnCalendar(timerContent), [buildWatchdogOnCalendar()]);
  });

  it("drop-in com OnCalendar= vazio zera a lista antes da nova expressão", () => {
    const out = [
      CAT_TIMER_PRE_10565,
      "# /home/x/.config/systemd/user/diaria-overnight-watchdog.timer.d/override.conf",
      "[Timer]",
      "OnCalendar=",
      `OnCalendar=${buildWatchdogOnCalendar()}`,
    ].join("\n");
    assert.deepEqual(parseTimerOnCalendar(out), [buildWatchdogOnCalendar()]);
  });

  it("comentário com OnCalendar não conta; output vazio → lista vazia", () => {
    assert.deepEqual(parseTimerOnCalendar("# OnCalendar=foo\n; OnCalendar=bar\n"), []);
    assert.deepEqual(parseTimerOnCalendar(""), []);
  });
});

describe("decideWatchdogScheduleStatus (#10571)", () => {
  it("unit antiga → stale", () => {
    assert.equal(decideWatchdogScheduleStatus(parseTimerOnCalendar(CAT_TIMER_PRE_10565)), "stale");
  });
  it("expressão atual (com espaços extras) → match", () => {
    assert.equal(decideWatchdogScheduleStatus([`  ${buildWatchdogOnCalendar().replace(" ", "   ")} `]), "match");
  });
  it("expressão atual + extra → match (extra só amplia cobertura)", () => {
    assert.equal(decideWatchdogScheduleStatus(["*-*-* 03:00", buildWatchdogOnCalendar()]), "match");
  });
  it("leitura falhou (null) ou sem expressão → unknown (fail-soft)", () => {
    assert.equal(decideWatchdogScheduleStatus(null), "unknown");
    assert.equal(decideWatchdogScheduleStatus([]), "unknown");
  });
});

describe("queryLinuxTimerOnCalendar (#10571, exec injetado)", () => {
  it("show sem nada parseável → cai no systemctl --user cat <unit>.timer (só leitura) e parseia", () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exec = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return args[1] === "show" ? "TimersCalendar=\n" : CAT_TIMER_PRE_10565;
    }) as unknown as typeof execFileSync;
    const r = queryLinuxTimerOnCalendar(WATCHDOG_TASK_NAME, exec);
    assert.deepEqual(r, ["*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo"]);
    assert.equal(calls[0].cmd, "systemctl");
    assert.deepEqual(calls[0].args, ["--user", "show", "-p", "TimersCalendar", watchdogTimerUnitName()]);
    assert.deepEqual(calls[1].args, ["--user", "cat", watchdogTimerUnitName()]);
  });

  it("erro do systemctl → null (fail-soft)", () => {
    const exec = (() => {
      throw Object.assign(new Error("boom"), { status: 1 });
    }) as unknown as typeof execFileSync;
    assert.equal(queryLinuxTimerOnCalendar(WATCHDOG_TASK_NAME, exec), null);
  });
});

/** Saída REAL de `systemctl --user show -p TimersCalendar diaria-overnight-watchdog.timer`
 * no `300` (20/10/2026), com o timer pré-#10565 carregado. */
const SHOW_TIMER_PRE_10565 =
  "TimersCalendar={ OnCalendar=*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo ; next_elapse=Tue 2026-10-20 00:30:00 UTC }\n";

/** `systemctl cat` quando o arquivo novo foi copiado mas falta daemon-reload:
 * o disco já tem a expressão atual, o carregado ainda é o velho. */
const CAT_TIMER_CHANGED_ON_DISK = [
  "# Warning: diaria-overnight-watchdog.timer changed on disk, the version systemd has loaded is outdated.",
  "# This output shows the current version of the unit's original fragment and drop-in files.",
  "# If fragments or drop-ins were added or removed, they are not properly reflected in this output.",
  "# Run 'systemctl --user daemon-reload' to reload units.",
  "# /home/vjpixel/.config/systemd/user/diaria-overnight-watchdog.timer",
  "[Timer]",
  `OnCalendar=${buildWatchdogOnCalendar()}`,
  "",
].join("\n");

describe("#10576 — agendamento CARREGADO, não o arquivo em disco", () => {
  it("parseTimersCalendarShow lê a saída real do show", () => {
    assert.deepEqual(parseTimersCalendarShow(SHOW_TIMER_PRE_10565), ["*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo"]);
  });

  it("várias expressões (uma linha cada) → todas; vazio → []", () => {
    const out = SHOW_TIMER_PRE_10565 + `TimersCalendar={ OnCalendar=${buildWatchdogOnCalendar()} ; next_elapse=n/a }\n`;
    assert.deepEqual(parseTimersCalendarShow(out), ["*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo", buildWatchdogOnCalendar()]);
    assert.deepEqual(parseTimersCalendarShow("TimersCalendar=\n"), []);
    assert.deepEqual(parseTimersCalendarShow(""), []);
  });

  it("disco atualizado sem daemon-reload: show (carregado, velho) vence o cat (disco, novo) → stale", () => {
    const exec = ((_cmd: string, args: readonly string[]) =>
      args[1] === "show" ? SHOW_TIMER_PRE_10565 : CAT_TIMER_CHANGED_ON_DISK) as unknown as typeof execFileSync;
    const effective = queryLinuxTimerOnCalendar(WATCHDOG_TASK_NAME, exec);
    assert.equal(decideWatchdogScheduleStatus(effective), "stale");
    const result = checkWatchdogArmed({
      execModeFn: () => "local",
      taskSchedulerFn: () => "systemd",
      queryLinuxTimerArmedFn: () => ({ state: "armed", note: null }),
      queryLinuxTimerOnCalendarFn: () => effective,
      emitWarn: () => {},
    });
    assert.equal(result.armedStatus, "armed_but_stale_schedule");
  });

  it("show falha e cat traz o aviso 'changed on disk' → marcador de não-recarregado → stale", () => {
    const exec = ((_cmd: string, args: readonly string[]) => {
      if (args[1] === "show") throw new Error("Unknown property");
      return CAT_TIMER_CHANGED_ON_DISK;
    }) as unknown as typeof execFileSync;
    const effective = queryLinuxTimerOnCalendar(WATCHDOG_TASK_NAME, exec);
    assert.deepEqual(effective, [NOT_RELOADED_MARKER]);
    assert.equal(decideWatchdogScheduleStatus(effective), "stale");
  });

  it("controle: carregado com a expressão atual → match", () => {
    const show = `TimersCalendar={ OnCalendar=${buildWatchdogOnCalendar()} ; next_elapse=Tue 2026-10-20 00:30:00 UTC }\n`;
    const exec = (() => show) as unknown as typeof execFileSync;
    assert.equal(decideWatchdogScheduleStatus(queryLinuxTimerOnCalendar(WATCHDOG_TASK_NAME, exec)), "match");
  });
});

describe("checkWatchdogArmed — agendamento defasado (#10571, #633)", () => {
  const base = {
    execModeFn: () => "local" as const,
    taskSchedulerFn: () => "systemd" as const,
    queryLinuxTimerArmedFn: (): LinuxWatchdogArmedResult => ({ state: "armed", note: null }),
  };

  it("timer habilitado com OnCalendar pré-#10565 → armed_but_stale_schedule, not_armed_warn, emite warning", () => {
    const emitted: string[] = [];
    const result = checkWatchdogArmed({
      ...base,
      queryLinuxTimerOnCalendarFn: () => parseTimerOnCalendar(CAT_TIMER_PRE_10565),
      emitWarn: (m) => emitted.push(m),
    });
    assert.equal(result.armed, false);
    assert.equal(result.action, "not_armed_warn");
    assert.equal(result.armedStatus, "armed_but_stale_schedule");
    assert.match(result.message, /AGENDAMENTO DEFASADO/);
    assert.match(result.message, /00\.\.08,18\.\.23/);
    assert.equal(emitted.length, 1);
  });

  it("leitura do OnCalendar falha (null ou lança) → continua armed (fail-soft)", () => {
    for (const fn of [() => null, () => { throw new Error("x"); }]) {
      const emitted: string[] = [];
      const result = checkWatchdogArmed({ ...base, queryLinuxTimerOnCalendarFn: fn, emitWarn: (m) => emitted.push(m) });
      assert.equal(result.armedStatus, "armed");
      assert.equal(result.action, "armed");
      assert.equal(emitted.length, 0);
    }
  });

  it("OnCalendar atual → armed", () => {
    const result = checkWatchdogArmed({
      ...base,
      queryLinuxTimerOnCalendarFn: () => [buildWatchdogOnCalendar()],
      emitWarn: () => {},
    });
    assert.equal(result.armedStatus, "armed");
  });

  it("timer desabilitado nem consulta o agendamento", () => {
    let called = false;
    const result = checkWatchdogArmed({
      ...base,
      queryLinuxTimerArmedFn: () => ({ state: "disabled", note: null }),
      queryLinuxTimerOnCalendarFn: () => { called = true; return null; },
      emitWarn: () => {},
    });
    assert.equal(result.armedStatus, "armed_but_disabled");
    assert.equal(called, false);
  });

  it("mensagem cita o esperado e o comando de rearme", () => {
    const msg = buildWatchdogLinuxStaleScheduleMessage(["*-*-* 00..08,18..23:00/10:00 America/Sao_Paulo"]);
    assert.ok(msg.includes(buildWatchdogOnCalendar()));
    assert.match(msg, /daemon-reload/);
  });
});
