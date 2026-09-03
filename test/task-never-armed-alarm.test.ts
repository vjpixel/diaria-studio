/**
 * test/task-never-armed-alarm.test.ts (#5607)
 *
 * Lógica pura de `scripts/lib/task-never-armed-alarm.ts` + `toNeverArmedFinding`/
 * `toOrphanTimerFinding` de `scripts/task-never-armed-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemctlListTimersOutput,
  evaluateTaskNeverArmed,
  isAlarmingVerdict,
  shouldSendTaskNeverArmedAlarm,
  markTaskNeverArmedAlarmed,
  emptyTaskNeverArmedAlarmState,
  buildTaskNeverArmedAlarmEmail,
  classifyNeverArmedStatus,
  KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES,
} from "../scripts/lib/task-never-armed-alarm.ts";
import {
  toNeverArmedFinding,
  toOrphanTimerFinding,
  toStoppedDeliberatelyFinding,
  readArmedTimerUnitBaseNames,
} from "../scripts/task-never-armed-alarm.ts";
import type { execFileSync } from "node:child_process";

describe("parseSystemctlListTimersOutput", () => {
  it("linha real de `systemctl --user list-timers --all --plain --no-legend`", () => {
    const stdout =
      "Mon 2026-08-17 22:40:00 UTC           6min Mon 2026-08-17 22:30:24 UTC   3min 3s ago diaria-overnight-watchdog.timer              diaria-overnight-watchdog.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-overnight-watchdog"]);
  });

  it("timer que nunca disparou (colunas LAST/PASSED = '-')", () => {
    const stdout = "Mon 2026-08-17 23:00:00 UTC          26min -                                       - diaria-entity-pages-regen.timer              diaria-entity-pages-regen.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-entity-pages-regen"]);
  });

  it("múltiplas linhas → múltiplos nomes-base, na ordem da saída", () => {
    const stdout =
      "Mon ... diaria-a.timer diaria-a.service\n" + "Tue ... diaria-b.timer diaria-b.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-a", "diaria-b"]);
  });

  it("saída vazia (--no-legend, nenhum timer) → array vazio", () => {
    assert.deepEqual(parseSystemctlListTimersOutput(""), []);
  });

  it("ignora linhas em branco", () => {
    const stdout = "\n\nMon ... diaria-a.timer diaria-a.service\n\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-a"]);
  });

  it("linha sem token `.timer` (ex: header residual) é ignorada", () => {
    const stdout = "NEXT LEFT LAST PASSED UNIT ACTIVATES\nMon ... diaria-a.timer diaria-a.service\n";
    assert.deepEqual(parseSystemctlListTimersOutput(stdout), ["diaria-a"]);
  });
});

describe("evaluateTaskNeverArmed", () => {
  it("registro vazio, sem timers armados → ok", () => {
    const ev = evaluateTaskNeverArmed([], []);
    assert.deepEqual(ev, { verdict: "ok", neverArmed: [], stoppedDeliberately: [], orphanTimers: [] });
  });

  it("toda task do registro tem timer armado correspondente → ok", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo-Bar"], ["diaria-foo-bar"]);
    assert.equal(ev.verdict, "ok");
  });

  it("task no registro SEM timer armado → alarm-never-armed (cenário real #5607)", () => {
    const ev = evaluateTaskNeverArmed(
      ["Diaria-Systemd-Failed-Units-Alarm", "Diaria-OneDrive-Sync-Alarm"],
      ["diaria-onedrive-sync-alarm"],
    );
    assert.equal(ev.verdict, "alarm-never-armed");
    assert.deepEqual(ev.neverArmed, ["Diaria-Systemd-Failed-Units-Alarm"]);
    assert.deepEqual(ev.orphanTimers, []);
  });

  it("timer diaria-* armado sem task no registro → alarm-orphan-timers", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo-Bar"], ["diaria-foo-bar", "diaria-renamed-task"]);
    assert.equal(ev.verdict, "alarm-orphan-timers");
    assert.deepEqual(ev.orphanTimers, ["diaria-renamed-task"]);
  });

  it("ambos os casos simultâneos → alarm-both", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Never-Armed"], ["diaria-orphan"]);
    assert.equal(ev.verdict, "alarm-both");
    assert.deepEqual(ev.neverArmed, ["Diaria-Never-Armed"]);
    assert.deepEqual(ev.orphanTimers, ["diaria-orphan"]);
  });

  it("allowlist (KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES) nunca vira orphan — diaria-edicao-diaria, diaria-overnight-watchdog e diaria-node-modules-health-check (#6774)", () => {
    assert.deepEqual(KNOWN_SCHEMA_EXCEPTION_UNIT_NAMES, [
      "diaria-edicao-diaria",
      "diaria-overnight-watchdog",
      "diaria-node-modules-health-check",
    ]);
    const ev = evaluateTaskNeverArmed(
      [],
      ["diaria-edicao-diaria", "diaria-overnight-watchdog", "diaria-node-modules-health-check"],
    );
    assert.equal(ev.verdict, "ok");
  });

  it("#6774/#6658: diaria-node-modules-health-check.timer armado, sem task no registro → não é órfão (exceção de schema, shell puro)", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo-Bar"], ["diaria-foo-bar", "diaria-node-modules-health-check"]);
    assert.equal(ev.verdict, "ok");
    assert.deepEqual(ev.orphanTimers, []);
  });

  it("#6773: task com enabled:false (ex: Diaria-Sunset-Weekly) SEM timer armado não é neverArmed quando listada em disabledTaskNames", () => {
    const ev = evaluateTaskNeverArmed(
      ["Diaria-Sunset-Weekly", "Diaria-Foo-Bar"],
      ["diaria-foo-bar"],
      ["Diaria-Sunset-Weekly"],
    );
    assert.equal(ev.verdict, "ok");
    assert.deepEqual(ev.neverArmed, []);
  });

  it("#6773: sem disabledTaskNames (3º arg omitido), comportamento antigo é preservado — task desabilitada SEM timer ainda alarma", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Sunset-Weekly"], []);
    assert.equal(ev.verdict, "alarm-never-armed");
    assert.deepEqual(ev.neverArmed, ["Diaria-Sunset-Weekly"]);
  });

  it("#6773: task desabilitada com timer armado manualmente ainda conta como 'tem task correspondente' (não vira órfã)", () => {
    const ev = evaluateTaskNeverArmed(
      ["Diaria-Sunset-Weekly"],
      ["diaria-sunset-weekly"],
      ["Diaria-Sunset-Weekly"],
    );
    assert.equal(ev.verdict, "ok");
    assert.deepEqual(ev.orphanTimers, []);
  });

  it("#6773: disabledTaskNames não mascara task HABILITADA homônima por engano — só exclui o nome exato passado", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Sunset-Weekly", "Diaria-Outra"], [], ["Diaria-Sunset-Weekly"]);
    assert.equal(ev.verdict, "alarm-never-armed");
    assert.deepEqual(ev.neverArmed, ["Diaria-Outra"]);
  });

  it("timer fora do prefixo diaria-* nunca vira orphan (fora do escopo deste repo)", () => {
    const ev = evaluateTaskNeverArmed([], ["some-other-vendor-timer"]);
    assert.equal(ev.verdict, "ok");
  });

  it("neverArmed e orphanTimers sempre ordenados independente da ordem de entrada", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Z", "Diaria-A"], []);
    assert.deepEqual(ev.neverArmed, ["Diaria-A", "Diaria-Z"]);
  });

  // #7210 — cenário real da issue: `Diaria-Kit-Doi-Orphan-Guard` tinha timer
  // que EXISTIU nesta máquina (LoadState=loaded) mas está inativo
  // (ActiveState=inactive) porque alguém rodou `systemctl --user stop` de
  // propósito. Antes desta issue, `evaluateTaskNeverArmed` não tinha como
  // saber disso e classificava como "nunca armada" (mesmo achado/prescrição
  // de uma task cujo setup de fato nunca rodou).
  it("#7210: task com timer LOADED+inactive (parada deliberadamente) entra em stoppedDeliberately, subconjunto de neverArmed", () => {
    const unitStates = new Map([["diaria-kit-doi-orphan-guard", { loadState: "loaded", activeState: "inactive" }]]);
    const ev = evaluateTaskNeverArmed(["Diaria-Kit-Doi-Orphan-Guard"], [], [], unitStates);
    assert.equal(ev.verdict, "alarm-never-armed");
    assert.deepEqual(ev.neverArmed, ["Diaria-Kit-Doi-Orphan-Guard"]);
    assert.deepEqual(ev.stoppedDeliberately, ["Diaria-Kit-Doi-Orphan-Guard"]);
  });

  it("#7210: task com timer not-found (setup nunca rodou) NÃO entra em stoppedDeliberately", () => {
    const unitStates = new Map([["diaria-foo", { loadState: "not-found", activeState: "inactive" }]]);
    const ev = evaluateTaskNeverArmed(["Diaria-Foo"], [], [], unitStates);
    assert.deepEqual(ev.neverArmed, ["Diaria-Foo"]);
    assert.deepEqual(ev.stoppedDeliberately, []);
  });

  it("#7210: unitStates omitido (comportamento anterior) → toda task neverArmed cai como stoppedDeliberately vazio", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo"], []);
    assert.deepEqual(ev.neverArmed, ["Diaria-Foo"]);
    assert.deepEqual(ev.stoppedDeliberately, []);
  });

  it("#7210: mistura — uma task nunca configurada + uma parada deliberadamente, cada uma no grupo certo", () => {
    const unitStates = new Map([
      ["diaria-parada", { loadState: "loaded", activeState: "inactive" }],
      ["diaria-nunca-configurada", { loadState: "not-found", activeState: "inactive" }],
    ]);
    const ev = evaluateTaskNeverArmed(["Diaria-Parada", "Diaria-Nunca-Configurada"], [], [], unitStates);
    assert.deepEqual(ev.neverArmed, ["Diaria-Nunca-Configurada", "Diaria-Parada"]);
    assert.deepEqual(ev.stoppedDeliberately, ["Diaria-Parada"]);
  });
});

describe("classifyNeverArmedStatus (#7210)", () => {
  it("null (consulta não feita/falhou) → task-never-setup, lado conservador", () => {
    assert.equal(classifyNeverArmedStatus(null), "task-never-setup");
  });

  it("loadState=not-found → task-never-setup (unit nunca existiu nesta máquina)", () => {
    assert.equal(classifyNeverArmedStatus({ loadState: "not-found", activeState: "inactive" }), "task-never-setup");
  });

  it("loadState=loaded + activeState=inactive → task-stopped-deliberately (o caso #7210)", () => {
    assert.equal(classifyNeverArmedStatus({ loadState: "loaded", activeState: "inactive" }), "task-stopped-deliberately");
  });

  it("loadState=loaded + activeState=active (edge case, não deveria acontecer pra um 'never armed') → ainda task-stopped-deliberately, nunca never-setup", () => {
    assert.equal(classifyNeverArmedStatus({ loadState: "loaded", activeState: "active" }), "task-stopped-deliberately");
  });
});

describe("isAlarmingVerdict", () => {
  it("ok → false; qualquer outro verdict → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("alarm-never-armed"), true);
    assert.equal(isAlarmingVerdict("alarm-orphan-timers"), true);
    assert.equal(isAlarmingVerdict("alarm-both"), true);
  });
});

describe("shouldSendTaskNeverArmedAlarm — idempotência por CONJUNTO", () => {
  it("verdict ok nunca alarma", () => {
    const ev = evaluateTaskNeverArmed([], []);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev, emptyTaskNeverArmedAlarmState()), false);
  });

  it("1ª detecção (state vazio) alarma", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-A"], []);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev, emptyTaskNeverArmedAlarmState()), true);
  });

  it("mesmo conjunto já alarmado não reenvia", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-A"], []);
    const state = markTaskNeverArmedAlarmed(ev);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev, state), false);
  });

  it("conjunto neverArmed mudou → reenvia", () => {
    const state = markTaskNeverArmedAlarmed(evaluateTaskNeverArmed(["Diaria-A"], []));
    const ev2 = evaluateTaskNeverArmed(["Diaria-A", "Diaria-B"], []);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev2, state), true);
  });

  it("neverArmed estável mas orphanTimers mudou → reenvia", () => {
    const state = markTaskNeverArmedAlarmed(evaluateTaskNeverArmed(["Diaria-A"], ["diaria-orphan-1"]));
    const ev2 = evaluateTaskNeverArmed(["Diaria-A"], ["diaria-orphan-1", "diaria-orphan-2"]);
    assert.equal(shouldSendTaskNeverArmedAlarm(ev2, state), true);
  });
});

describe("buildTaskNeverArmedAlarmEmail", () => {
  it("lista neverArmed no assunto e corpo quando presente", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo"], []);
    const { subject, body } = buildTaskNeverArmedAlarmEmail(ev, "");
    assert.match(subject, /1 task\(s\) nunca armada\(s\)/);
    assert.match(body, /Diaria-Foo/);
  });

  it("lista orphanTimers no assunto e corpo quando presente", () => {
    const ev = evaluateTaskNeverArmed([], ["diaria-orphan"]);
    const { subject, body } = buildTaskNeverArmedAlarmEmail(ev, "");
    assert.match(subject, /1 timer\(s\) órfão\(s\)/);
    assert.match(body, /diaria-orphan\.timer/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateTaskNeverArmed(["Diaria-Foo"], []);
    const { body } = buildTaskNeverArmedAlarmEmail(ev, "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });

  it("#7210: task parada deliberadamente sai numa seção separada, com prescrição de decisão (não 'arme via script')", () => {
    const unitStates = new Map([["diaria-kit-doi-orphan-guard", { loadState: "loaded", activeState: "inactive" }]]);
    const ev = evaluateTaskNeverArmed(["Diaria-Kit-Doi-Orphan-Guard"], [], [], unitStates);
    const { subject, body } = buildTaskNeverArmedAlarmEmail(ev, "");
    assert.match(subject, /1 task\(s\) parada\(s\) deliberadamente/);
    assert.doesNotMatch(subject, /nunca armada/);
    assert.match(body, /Diaria-Kit-Doi-Orphan-Guard/);
    assert.match(body, /Decisão pendente do editor/);
  });

  it("#7210: mistura de neverSetup + stoppedDeliberately gera as DUAS seções no mesmo e-mail", () => {
    const unitStates = new Map([["diaria-parada", { loadState: "loaded", activeState: "inactive" }]]);
    const ev = evaluateTaskNeverArmed(["Diaria-Parada", "Diaria-Nunca-Configurada"], [], [], unitStates);
    const { subject, body } = buildTaskNeverArmedAlarmEmail(ev, "");
    assert.match(subject, /1 task\(s\) nunca armada\(s\)/);
    assert.match(subject, /1 task\(s\) parada\(s\) deliberadamente/);
    assert.match(body, /Diaria-Nunca-Configurada/);
    assert.match(body, /Diaria-Parada/);
  });
});

describe("toNeverArmedFinding / toOrphanTimerFinding", () => {
  it("toNeverArmedFinding: family 'estado', priority P1, fingerprint = TaskName exato", () => {
    const f = toNeverArmedFinding("Diaria-Foo-Bar");
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P1");
    assert.equal(f.fingerprint, "Diaria-Foo-Bar");
    assert.equal(f.check, "task-never-armed");
  });

  it("toOrphanTimerFinding: family 'estado', priority P3 (alarme mais fraco)", () => {
    const f = toOrphanTimerFinding("diaria-orphan");
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P3");
    assert.equal(f.fingerprint, "diaria-orphan");
    assert.equal(f.check, "task-never-armed-orphan-timer");
  });

  it("#6772: toNeverArmedFinding carrega a label alarm-acao (só ação humana/de código normaliza)", () => {
    const f = toNeverArmedFinding("Diaria-Foo-Bar");
    assert.ok(f.labels?.includes("alarm-acao"), `esperava 'alarm-acao' em ${JSON.stringify(f.labels)}`);
  });

  it("#6772: toOrphanTimerFinding carrega a label alarm-acao", () => {
    const f = toOrphanTimerFinding("diaria-orphan");
    assert.ok(f.labels?.includes("alarm-acao"), `esperava 'alarm-acao' em ${JSON.stringify(f.labels)}`);
  });

  it("#7210: toStoppedDeliberatelyFinding: check próprio, priority P3 (decisão pendente, não bug mecânico), fingerprint = TaskName exato", () => {
    const f = toStoppedDeliberatelyFinding("Diaria-Kit-Doi-Orphan-Guard");
    assert.equal(f.check, "task-stopped-deliberately");
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P3");
    assert.equal(f.fingerprint, "Diaria-Kit-Doi-Orphan-Guard");
    assert.ok(f.labels?.includes("alarm-acao"));
    assert.match(f.body, /Decisão pendente do editor/);
    assert.doesNotMatch(f.body, /Armar: rodar `scripts\/setup-systemd-timers\.ts`/);
  });
});

// #7039: erro transitório do systemctl (D-Bus indisponível, timeout,
// permissão) precisa virar "não sei" (status: "check-failed"), NUNCA a
// mesma saída que "esta máquina não tem systemd" (status: "no-systemd").
// Os dois colapsavam ambos em `null` antes desta issue, e o caller tratava
// os dois como "conjunto armado vazio, nada a reportar".
describe("readArmedTimerUnitBaseNames (#7039)", () => {
  it("ENOENT (systemctl ausente) -> status 'no-systemd', nunca 'check-failed'", () => {
    const exec = (() => {
      throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof execFileSync;
    assert.deepEqual(readArmedTimerUnitBaseNames(exec), { status: "no-systemd" });
  });

  it("erro transitório (sem .code ENOENT, sem stdout) -> status 'check-failed', NÃO 'no-systemd' nem lista vazia", () => {
    const exec = (() => {
      // Simula D-Bus indisponível: systemctl existe (não é ENOENT), falha,
      // sem stdout algum pra extrair.
      throw Object.assign(new Error("Failed to connect to bus: No such file or directory"), {
        status: 1,
      });
    }) as unknown as typeof execFileSync;
    const result = readArmedTimerUnitBaseNames(exec);
    assert.equal(result.status, "check-failed");
    if (result.status !== "check-failed") return;
    assert.match(result.message, /Failed to connect to bus/);
  });

  it("timeout (código ETIMEDOUT, sem stdout) -> status 'check-failed'", () => {
    const exec = (() => {
      throw Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
    }) as unknown as typeof execFileSync;
    const result = readArmedTimerUnitBaseNames(exec);
    assert.equal(result.status, "check-failed");
  });

  it("erro não-ENOENT mas com stdout presente (quirk de versão do systemd) -> ainda conta como leitura OK", () => {
    const exec = (() => {
      throw Object.assign(new Error("exited with status 1"), {
        status: 1,
        stdout: "Mon ... diaria-a.timer diaria-a.service\n",
      });
    }) as unknown as typeof execFileSync;
    const result = readArmedTimerUnitBaseNames(exec);
    assert.deepEqual(result, { status: "ok", unitBaseNames: ["diaria-a"] });
  });

  it("execução limpa -> status 'ok' com a lista parseada", () => {
    const exec = (() => "" ) as unknown as typeof execFileSync;
    assert.deepEqual(readArmedTimerUnitBaseNames(exec), { status: "ok", unitBaseNames: [] });
  });
});
