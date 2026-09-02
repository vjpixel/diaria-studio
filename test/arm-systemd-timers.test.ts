/**
 * test/arm-systemd-timers.test.ts (#4828, épica #4798)
 *
 * Cobre `scripts/arm-systemd-timers.ts` — o passo de ARME (`systemctl
 * --user daemon-reload` + `enable --now`) separado dos geradores de unit
 * (`setup-systemd-timers.ts`, que continuam só escrevendo arquivo, ver
 * `test/systemd-units.test.ts`).
 *
 * Estrutural: NUNCA chama `systemctl` real — todo `execFileSync` é
 * injetado via mock (mesmo padrão de `test/check-watchdog-armed.test.ts` /
 * `test/scheduled-task-status.test.ts`). `armSystemdTimers` toca o
 * filesystem de verdade, mas só dentro de diretórios temporários
 * (`mkdtempSync`), nunca `~/.config/systemd/user/` real (dispatch da
 * #4828 proíbe explicitamente rodar isto contra o systemd real desta
 * máquina).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armSystemdTimers,
  decideArmAction,
  main as armSystemdTimersMain,
  parseUnitStateOutput,
  queryUnitState,
  reportVerifyOutcome,
  runVerify,
  type SystemdUnitState,
} from "../scripts/arm-systemd-timers.ts";
import {
  listDisabledScheduledTaskNames,
  listScheduledTaskNames,
  type ScheduledTaskDefinition,
} from "../scripts/lib/scheduled-tasks.ts";
import { unitBaseName } from "../scripts/lib/systemd-units.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeTask(name: string): ScheduledTaskDefinition {
  return {
    name,
    description: `fake task ${name}`,
    steps: [{ key: "x", script: "scripts/does-not-exist.ts" }],
    logPath: `fake/${name}.log`,
    schedule: { kind: "daily", hour: 9, minute: 0 },
    issue: "#4828",
  };
}

/** Mock roteador de `execFileSync` — nunca spawna `systemctl` de verdade.
 * `calls` acumula `[cmd, ...args]` de cada invocação, na ordem. */
function makeMockExec(
  handlers: {
    show?: (unit: string) => string;
    daemonReload?: () => void;
    enable?: (unit: string) => void;
  },
  calls: string[][],
): typeof execFileSync {
  return ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const sub = args[1];
    if (sub === "show") {
      const unit = args[2];
      return handlers.show ? handlers.show(unit) : "";
    }
    if (sub === "daemon-reload") {
      handlers.daemonReload?.();
      return "";
    }
    if (sub === "enable") {
      const unit = args[3];
      handlers.enable?.(unit);
      return "";
    }
    return "";
  }) as unknown as typeof execFileSync;
}

function writeFakeUnitFiles(unitsDirAbs: string, unitBase: string): void {
  writeFileSync(join(unitsDirAbs, `${unitBase}.service`), "[Unit]\n", "utf8");
  writeFileSync(join(unitsDirAbs, `${unitBase}.timer`), "[Timer]\n", "utf8");
}

// ---------------------------------------------------------------------------
// parseUnitStateOutput
// ---------------------------------------------------------------------------

describe("parseUnitStateOutput", () => {
  it("parseia LoadState + ActiveState, ordem não importa", () => {
    assert.deepEqual(parseUnitStateOutput("ActiveState=active\nLoadState=loaded\n"), {
      loadState: "loaded",
      activeState: "active",
    });
  });

  it("CRLF (variante real de alguns terminais) parseia igual", () => {
    assert.deepEqual(parseUnitStateOutput("LoadState=not-found\r\nActiveState=inactive\r\n"), {
      loadState: "not-found",
      activeState: "inactive",
    });
  });

  it("output vazio/malformado -> strings vazias, nunca lança", () => {
    assert.deepEqual(parseUnitStateOutput(""), { loadState: "", activeState: "" });
    assert.deepEqual(parseUnitStateOutput("garbage sem = nenhuma linha reconhecida"), {
      loadState: "",
      activeState: "",
    });
  });
});

// ---------------------------------------------------------------------------
// queryUnitState
// ---------------------------------------------------------------------------

describe("queryUnitState", () => {
  it("sucesso -> state parseado, error null; chama systemctl --user show <unit> --property=...", () => {
    const calls: string[][] = [];
    const exec = makeMockExec({ show: () => "LoadState=loaded\nActiveState=active\n" }, calls);
    const result = queryUnitState("diaria-fake.timer", exec);
    assert.deepEqual(result, { state: { loadState: "loaded", activeState: "active" }, error: null });
    assert.deepEqual(calls, [
      ["systemctl", "--user", "show", "diaria-fake.timer", "--property=LoadState,ActiveState"],
    ]);
  });

  it("ENOENT (systemctl ausente) -> state null, error explica ENOENT", () => {
    const calls: string[][] = [];
    const exec = makeMockExec(
      {
        show: () => {
          throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
        },
      },
      calls,
    );
    const result = queryUnitState("diaria-fake.timer", exec);
    assert.equal(result.state, null);
    assert.match(result.error!, /ENOENT/);
  });

  it("erro genuinamente não reconhecido -> state null, error carrega o stderr (truncado)", () => {
    const calls: string[][] = [];
    const exec = makeMockExec(
      {
        show: () => {
          throw Object.assign(new Error("boom"), { stderr: "Failed to connect to bus: No such file or directory" });
        },
      },
      calls,
    );
    const result = queryUnitState("diaria-fake.timer", exec);
    assert.equal(result.state, null);
    assert.match(result.error!, /Failed to connect to bus/);
  });
});

// ---------------------------------------------------------------------------
// decideArmAction — guard central da #4828
// ---------------------------------------------------------------------------

describe("decideArmAction", () => {
  it("state null (consulta falhou) -> unknown/cannot-verify-state, nunca arma nem pula silenciosamente", () => {
    assert.deepEqual(decideArmAction(null, false), { action: "unknown", reason: "cannot-verify-state" });
    assert.deepEqual(decideArmAction(null, true), { action: "unknown", reason: "cannot-verify-state" });
  });

  it("LoadState=not-found (1ª vez armando) -> SEMPRE arma, independente de --rearm-stopped", () => {
    const state: SystemdUnitState = { loadState: "not-found", activeState: "inactive" };
    assert.deepEqual(decideArmAction(state, false), { action: "arm", reason: "new-unit" });
    assert.deepEqual(decideArmAction(state, true), { action: "arm", reason: "new-unit" });
  });

  it("unit existente + inactive, sem --rearm-stopped -> skip/stopped-deliberately (o core da issue)", () => {
    const state: SystemdUnitState = { loadState: "loaded", activeState: "inactive" };
    assert.deepEqual(decideArmAction(state, false), { action: "skip", reason: "stopped-deliberately" });
  });

  it("unit existente + inactive, COM --rearm-stopped -> arma (comportamento antigo restaurado)", () => {
    const state: SystemdUnitState = { loadState: "loaded", activeState: "inactive" };
    assert.deepEqual(decideArmAction(state, true), { action: "arm", reason: "rearm-stopped-flag" });
  });

  it("unit existente + active -> arma normalmente (enable --now é idempotente)", () => {
    const state: SystemdUnitState = { loadState: "loaded", activeState: "active" };
    assert.deepEqual(decideArmAction(state, false), { action: "arm", reason: "already-active-or-other" });
  });

  it("unit existente + failed (não é 'inactive') -> arma, não é o alvo deste guard", () => {
    const state: SystemdUnitState = { loadState: "loaded", activeState: "failed" };
    assert.deepEqual(decideArmAction(state, false), { action: "arm", reason: "already-active-or-other" });
  });
});

// ---------------------------------------------------------------------------
// armSystemdTimers — orquestração completa (fs real em tmpdir, systemctl mockado)
// ---------------------------------------------------------------------------

describe("armSystemdTimers", () => {
  let unitsDirAbs: string;
  let targetDirAbs: string;

  after(() => {
    if (unitsDirAbs) rmSync(unitsDirAbs, { recursive: true, force: true });
    if (targetDirAbs) rmSync(targetDirAbs, { recursive: true, force: true });
  });

  it("unit novo (not-found) -> copia, daemon-reload, enable --now; arquivos aparecem no target-dir", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-new");

    const calls: string[][] = [];
    const exec = makeMockExec({ show: () => "LoadState=not-found\nActiveState=inactive\n" }, calls);

    const results = armSystemdTimers([fakeTask("Diaria-Fake-New")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: false,
      exec,
    });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0].decision, { action: "arm", reason: "new-unit" });
    assert.equal(results[0].copied, true);
    assert.equal(results[0].armed, true);
    assert.equal(results[0].error, null);

    // Arquivos de fato copiados pro target-dir.
    assert.equal(readFileSync(join(targetDirAbs, "diaria-fake-new.service"), "utf8"), "[Unit]\n");
    assert.equal(readFileSync(join(targetDirAbs, "diaria-fake-new.timer"), "utf8"), "[Timer]\n");

    // daemon-reload rodou, e enable --now rodou pro unit certo.
    // (entrada = [cmd, ...args]; args[0] é sempre "--user", args[1] é o
    // subcomando ("show"/"daemon-reload"/"enable") -- índice 2 na entrada.)
    assert.ok(calls.some((c) => c[2] === "daemon-reload"));
    assert.ok(calls.some((c) => c[2] === "enable" && c[4] === "diaria-fake-new.timer"));
  });

  it("timer existente + inactive, sem --rearm-stopped -> skip; NUNCA copia, NUNCA chama daemon-reload/enable", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-stopped");

    const calls: string[][] = [];
    const exec = makeMockExec({ show: () => "LoadState=loaded\nActiveState=inactive\n" }, calls);

    const results = armSystemdTimers([fakeTask("Diaria-Fake-Stopped")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: false,
      exec,
    });

    assert.deepEqual(results[0].decision, { action: "skip", reason: "stopped-deliberately" });
    assert.equal(results[0].copied, false);
    assert.equal(results[0].armed, false);
    assert.equal(results[0].error, null);

    assert.ok(!calls.some((c) => c[2] === "daemon-reload"), "daemon-reload não deveria ter rodado");
    assert.ok(!calls.some((c) => c[2] === "enable"), "enable --now não deveria ter rodado");
  });

  it("mesmo cenário COM --rearm-stopped -> religa normalmente (copia + arma)", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-stopped");

    const calls: string[][] = [];
    const exec = makeMockExec({ show: () => "LoadState=loaded\nActiveState=inactive\n" }, calls);

    const results = armSystemdTimers([fakeTask("Diaria-Fake-Stopped")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: true,
      exec,
    });

    assert.deepEqual(results[0].decision, { action: "arm", reason: "rearm-stopped-flag" });
    assert.equal(results[0].copied, true);
    assert.equal(results[0].armed, true);
  });

  it("unit fonte ausente em --units-dir -> decisão arm mas cópia falha, erro aponta pro gerador", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    // Não escreve os arquivos fonte de propósito.

    const calls: string[][] = [];
    const exec = makeMockExec({ show: () => "LoadState=not-found\nActiveState=inactive\n" }, calls);

    const results = armSystemdTimers([fakeTask("Diaria-Fake-Missing-Source")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: false,
      exec,
    });

    assert.equal(results[0].decision.action, "arm");
    assert.equal(results[0].copied, false);
    assert.equal(results[0].armed, false);
    assert.match(results[0].error!, /setup-systemd-timers\.ts --task Diaria-Fake-Missing-Source/);
  });

  it("consulta systemctl falhou (state null) -> unknown, nunca copia nem arma", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-cannot-verify");

    const calls: string[][] = [];
    const exec = makeMockExec(
      {
        show: () => {
          throw Object.assign(new Error("boom"), { code: "ENOENT" });
        },
      },
      calls,
    );

    const results = armSystemdTimers([fakeTask("Diaria-Fake-Cannot-Verify")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: false,
      exec,
    });

    assert.deepEqual(results[0].decision, { action: "unknown", reason: "cannot-verify-state" });
    assert.equal(results[0].copied, false);
    assert.equal(results[0].armed, false);
    assert.match(results[0].error!, /ENOENT/);
  });

  it("daemon-reload falha -> nenhum unit é armado, erro propagado a todos os que seriam armados", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-a");
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-b");

    const calls: string[][] = [];
    const exec = makeMockExec(
      {
        show: () => "LoadState=not-found\nActiveState=inactive\n",
        daemonReload: () => {
          throw Object.assign(new Error("boom"), { stderr: "reload falhou" });
        },
      },
      calls,
    );

    const results = armSystemdTimers([fakeTask("Diaria-Fake-A"), fakeTask("Diaria-Fake-B")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: false,
      exec,
    });

    for (const r of results) {
      assert.equal(r.copied, true, `${r.unit} deveria ter sido copiado antes do daemon-reload falhar`);
      assert.equal(r.armed, false);
      assert.match(r.error!, /daemon-reload falhou/);
    }
    // enable --now nunca deveria ter rodado (daemon-reload falhou antes).
    assert.ok(!calls.some((c) => c[2] === "enable"));
  });

  it("enable --now falha numa task não bloqueia as outras", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-fails");
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-ok");

    const calls: string[][] = [];
    const exec = makeMockExec(
      {
        show: () => "LoadState=not-found\nActiveState=inactive\n",
        enable: (unit) => {
          if (unit === "diaria-fake-fails.timer") {
            throw Object.assign(new Error("boom"), { stderr: "unit malformada" });
          }
        },
      },
      calls,
    );

    const results = armSystemdTimers([fakeTask("Diaria-Fake-Fails"), fakeTask("Diaria-Fake-Ok")], {
      unitsDirAbs,
      targetDirAbs,
      rearmStopped: false,
      exec,
    });

    const failed = results.find((r) => r.unit === "diaria-fake-fails.timer")!;
    const ok = results.find((r) => r.unit === "diaria-fake-ok.timer")!;
    assert.equal(failed.armed, false);
    assert.match(failed.error!, /unit malformada/);
    assert.equal(ok.armed, true);
    assert.equal(ok.error, null);
  });

  it("mix de skip + arm entre várias tasks -> daemon-reload roda 1× só, não por unit armado", () => {
    unitsDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-units-"));
    targetDirAbs = mkdtempSync(join(tmpdir(), "arm-systemd-target-"));
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-new-1");
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-new-2");
    writeFakeUnitFiles(unitsDirAbs, "diaria-fake-parada");

    const calls: string[][] = [];
    const exec = makeMockExec(
      {
        show: (unit) =>
          unit === "diaria-fake-parada.timer"
            ? "LoadState=loaded\nActiveState=inactive\n"
            : "LoadState=not-found\nActiveState=inactive\n",
      },
      calls,
    );

    const results = armSystemdTimers(
      [fakeTask("Diaria-Fake-New-1"), fakeTask("Diaria-Fake-New-2"), fakeTask("Diaria-Fake-Parada")],
      { unitsDirAbs, targetDirAbs, rearmStopped: false, exec },
    );

    const armedCount = results.filter((r) => r.armed).length;
    const skippedCount = results.filter((r) => r.decision.action === "skip").length;
    assert.equal(armedCount, 2);
    assert.equal(skippedCount, 1);

    const daemonReloadCalls = calls.filter((c) => c[2] === "daemon-reload");
    assert.equal(daemonReloadCalls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// CLI main() — só os caminhos que retornam ANTES de tocar systemctl real
// ---------------------------------------------------------------------------

describe("main() — validação de argumentos (nunca chega a chamar systemctl real)", () => {
  it("--task desconhecido -> retorna 1, sem chamar armSystemdTimers/systemctl", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = armSystemdTimersMain(["--task", "Diaria-Nao-Existe-4828"], "/repo/abs");
      assert.equal(code, 1);
    } finally {
      console.error = originalError;
    }
  });

  it("--task sem valor -> retorna 1 (getStringArg lança)", () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = armSystemdTimersMain(["--task"], "/repo/abs");
      assert.equal(code, 1);
    } finally {
      console.error = originalError;
    }
  });
});

// ---------------------------------------------------------------------------
// --verify (#7032) — declarado × armado, nas duas direções.
//
// Reusa a mesma leitura de `list-timers --all` (`readArmedTimerUnitBaseNames`)
// e a mesma comparação pura (`evaluateTaskNeverArmed`) de
// `scripts/task-never-armed-alarm.ts`/`scripts/lib/task-never-armed-alarm.ts`
// (#5607/#6773, já cobertas por `test/task-never-armed-alarm.test.ts`) — os
// testes aqui cobrem a FRONTEIRA nova (`runVerify`/`reportVerifyOutcome`/
// `main --verify`), não reimplementam a cobertura da comparação em si.
// `exec` é sempre mockado — nunca spawna `systemctl` de verdade, e nenhum
// teste depende de `systemctl` existir ou não na máquina que roda o teste
// (achado #7037: uma versão anterior desta suíte tinha um teste que
// injetava `exec` real e dependia de ENOENT — passava no Windows, falhava
// no CI Linux; `main` agora aceita `exec` injetável no caminho `--verify`
// pra sustentar isso).
// ---------------------------------------------------------------------------

describe("runVerify / reportVerifyOutcome (#7032)", () => {
  /** Uma linha de `systemctl --user list-timers --all --plain --no-legend`
   * real tem várias colunas com espaços internos (datas, durações) — só o
   * token terminando em `.timer` importa pro parser
   * (`parseSystemctlListTimersOutput`). `n/a` nas colunas NEXT/LEFT é
   * exatamente o que aparece pra um timer que existe mas está parado
   * (`ActiveState=inactive`, `LoadState=loaded`) — usado no teste de
   * "parado deliberadamente" abaixo pra não fingir uma coluna que a
   * ferramenta real não produziria para esse caso. */
  function timerLine(unitBase: string, opts: { stopped?: boolean } = {}): string {
    const next = opts.stopped ? "n/a" : "Tue 2026-09-02 09:00:00 -03";
    const left = opts.stopped ? "n/a" : "8h left";
    return `${next} ${left} n/a n/a ${unitBase}.timer ${unitBase}.service`;
  }

  function execListTimers(unitBases: string[], opts: { stopped?: string[] } = {}): typeof execFileSync {
    const stoppedSet = new Set(opts.stopped ?? []);
    return ((cmd: string, args: string[]) => {
      if (cmd === "systemctl" && args[1] === "list-timers") {
        return unitBases.map((u) => timerLine(u, { stopped: stoppedSet.has(u) })).join("\n") + "\n";
      }
      throw new Error(`exec inesperado em teste --verify: ${cmd} ${args.join(" ")}`);
    }) as unknown as typeof execFileSync;
  }

  /** Tasks habilitadas do registro REAL — `--verify` sempre lê
   * `scripts/lib/scheduled-tasks.ts` de verdade (não é injetável, só a
   * leitura de `systemctl` é), então os testes constroem cenários a partir
   * dele em vez de fixtures isoladas. */
  function enabledTaskNames(): string[] {
    const disabled = new Set(listDisabledScheduledTaskNames());
    return listScheduledTaskNames().filter((n) => !disabled.has(n));
  }

  it("caso limpo — toda task habilitada tem timer armado -> evaluated/ok, exit 0", () => {
    const declared = enabledTaskNames();
    const outcome = runVerify(execListTimers(declared.map(unitBaseName)));
    assert.equal(outcome.kind, "evaluated");
    assert.equal(outcome.kind === "evaluated" && outcome.evaluation.verdict, "ok");
    assert.equal(reportVerifyOutcome(outcome), 0);
  });

  it("declarada mas não armada (caso real #6810) -> exit 1, neverArmed inclui a task", () => {
    const declared = enabledTaskNames();
    assert.ok(declared.length > 1, "precisa de >=2 tasks habilitadas no registro real pro cenário");
    const [missing, ...rest] = declared;
    const outcome = runVerify(execListTimers(rest.map(unitBaseName)));
    assert.equal(outcome.kind, "evaluated");
    if (outcome.kind !== "evaluated") return;
    assert.ok(["alarm-never-armed", "alarm-both"].includes(outcome.evaluation.verdict));
    assert.ok(outcome.evaluation.neverArmed.includes(missing));
    assert.equal(reportVerifyOutcome(outcome), 1);
  });

  it("armada mas não declarada (caso real #6798) -> exit 1, orphanTimers inclui o unit", () => {
    const declared = enabledTaskNames();
    const orphan = "diaria-timer-orfao-de-teste-7032";
    const outcome = runVerify(execListTimers([...declared.map(unitBaseName), orphan]));
    assert.equal(outcome.kind, "evaluated");
    if (outcome.kind !== "evaluated") return;
    assert.ok(["alarm-orphan-timers", "alarm-both"].includes(outcome.evaluation.verdict));
    assert.ok(outcome.evaluation.orphanTimers.includes(orphan));
    assert.equal(reportVerifyOutcome(outcome), 1);
  });

  it("timer parado deliberadamente (systemctl stop sem disable) continua listado -> NÃO é reportado como drift", () => {
    const declared = enabledTaskNames();
    const [stopped, ...rest] = declared;
    const outcome = runVerify(
      execListTimers(declared.map(unitBaseName), { stopped: [unitBaseName(stopped)] }),
    );
    assert.equal(outcome.kind, "evaluated");
    if (outcome.kind !== "evaluated") return;
    // presente em list-timers --all (mesmo "n/a"/"n/a") -> conta como
    // armado; nada aqui deve aparecer em neverArmed nem orphanTimers.
    assert.equal(outcome.evaluation.verdict, "ok");
    assert.deepEqual(outcome.evaluation.neverArmed, []);
    void rest; // só documenta a forma do array desestruturado acima
  });

  it("systemctl indisponível (ENOENT) -> kind unavailable, exit 0, nunca lança", () => {
    const exec = (() => {
      throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof execFileSync;
    const outcome = runVerify(exec);
    assert.deepEqual(outcome, { kind: "unavailable" });
    assert.equal(reportVerifyOutcome(outcome), 0);
  });

  it("main(['--verify']) com systemctl indisponível (ENOENT injetado) -> nunca lança, sai 0", () => {
    // #7037 (self-review): a versão original desta checagem NÃO injetava
    // `exec` e dependia de `systemctl` não existir de verdade na máquina
    // que roda o teste — passava no Windows (onde foi escrito) e falhava no
    // CI (Ubuntu, `systemctl` existe). `main` agora aceita `exec` injetável
    // (3º parâmetro, mesmo padrão de `readArmedTimerUnitBaseNames`), então
    // simulamos o ENOENT em vez de depender do SO — vale igual em qualquer
    // máquina, com ou sem systemd.
    const exec = (() => {
      throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof execFileSync;
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = armSystemdTimersMain(["--verify"], "/repo/abs", exec);
      assert.equal(code, 0);
    } finally {
      console.log = originalLog;
    }
  });

  // #7037: --verify recusa combinar com as flags do fluxo de armar, em vez
  // de aceitar e ignorá-las em silêncio (achado de self-review do #7032 —
  // `--verify --task X` antes rodava o verify GLOBAL sem avisar que --task
  // foi ignorado).
  for (const combo of [
    ["--verify", "--task", "Diaria-Apoios-Diff-Alarm"],
    ["--verify", "--rearm-stopped"],
    ["--verify", "--units-dir", "/tmp/units"],
    ["--verify", "--target-dir", "/tmp/target"],
    ["--task", "Diaria-Apoios-Diff-Alarm", "--verify"],
  ]) {
    it(`main(${JSON.stringify(combo)}) -> recusa, exit 2, nunca chama runVerify nem o fluxo de armar`, () => {
      const originalError = console.error;
      const errors: string[] = [];
      console.error = (...a: unknown[]) => {
        errors.push(a.join(" "));
      };
      try {
        const code = armSystemdTimersMain(combo, "/repo/abs");
        assert.equal(code, 2);
        assert.ok(errors.some((line) => line.includes("--verify") && line.includes("não aceita")));
      } finally {
        console.error = originalError;
      }
    });
  }

  it("main(['--verify']) sozinho continua funcionando (regressão da recusa acima)", () => {
    // Mesma disciplina do teste ENOENT acima: injeta `exec` com uma saída de
    // `list-timers` válida (caso limpo — toda task declarada armada) em vez
    // de depender de haver ou não `systemctl` real na máquina do teste, e
    // verifica o exit code determinístico esperado (0).
    const exec = execListTimers(enabledTaskNames().map(unitBaseName));
    const originalLog = console.log;
    console.log = () => {};
    try {
      const code = armSystemdTimersMain(["--verify"], "/repo/abs", exec);
      assert.equal(code, 0);
    } finally {
      console.log = originalLog;
    }
  });
});
