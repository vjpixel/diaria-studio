/**
 * test/systemd-failed-units-alarm.test.ts (#5563)
 *
 * Lógica pura de `scripts/lib/systemd-failed-units-alarm.ts` + `toAlarmFinding`
 * de `scripts/systemd-failed-units-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSystemctlListUnitsFailedOutput,
  evaluateSystemdFailedUnits,
  isAlarmingVerdict,
  shouldSendSystemdFailedUnitsAlarm,
  markSystemdFailedUnitsAlarmed,
  emptySystemdFailedUnitsAlarmState,
  buildSystemdFailedUnitsAlarmEmail,
  parseUnitDiagnosticShowOutput,
  isValidUnitDiagnosticValue,
  formatUnitDiagnosticFieldsTable,
  buildUnitInvestigationCommand,
  UNIT_DIAGNOSTIC_PROPERTIES,
  ALARM_DEDUP_EXPIRY_MS,
  type UnitDiagnosticFields,
} from "../scripts/lib/systemd-failed-units-alarm.ts";
import { toAlarmFinding, readUnitDiagnosticFields } from "../scripts/systemd-failed-units-alarm.ts";

describe("toAlarmFinding — family obrigatório (#5553/#5557)", () => {
  it("family é sempre 'estado' (condição re-checável a cada sweep — some quando o operador conserta)", () => {
    assert.equal(toAlarmFinding("diaria-edicao-diaria.service").family, "estado");
  });

  it("fingerprint é o nome exato da unit — 1 finding por unit, não agregado", () => {
    const f = toAlarmFinding("diaria-edicao-diaria.service");
    assert.equal(f.check, "systemd-failed-units");
    assert.equal(f.fingerprint, "diaria-edicao-diaria.service");
    assert.equal(f.priority, "P1");
  });
});

describe("parseSystemctlListUnitsFailedOutput", () => {
  it("cenário real do #5563: 1 unit failed, --plain --no-legend", () => {
    const stdout = "diaria-edicao-diaria.service loaded failed failed edicao diaria agendada\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });

  it("múltiplas units failed, cada uma numa linha", () => {
    const stdout =
      "diaria-edicao-diaria.service loaded failed failed edicao\n" +
      "diaria-cursos-error-alarm.service loaded failed failed alarme\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), [
      "diaria-edicao-diaria.service",
      "diaria-cursos-error-alarm.service",
    ]);
  });

  it("saída vazia (--no-legend, nenhuma unit failed) → array vazio", () => {
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(""), []);
  });

  it("tolera glyph de árvore residual como 1º token (fallback se --plain não for honrado)", () => {
    const stdout = "● diaria-edicao-diaria.service loaded failed failed edicao\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });

  it("ignora linhas em branco", () => {
    const stdout = "\n\ndiaria-edicao-diaria.service loaded failed failed edicao\n\n";
    assert.deepEqual(parseSystemctlListUnitsFailedOutput(stdout), ["diaria-edicao-diaria.service"]);
  });
});

describe("evaluateSystemdFailedUnits", () => {
  it("lista vazia → ok", () => {
    assert.deepEqual(evaluateSystemdFailedUnits([]), { verdict: "ok", failedUnits: [] });
  });

  it("1+ units failed → alarm-failed-units, lista ORDENADA independente da ordem de entrada", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-z.service", "diaria-a.service"]);
    assert.equal(ev.verdict, "alarm-failed-units");
    assert.deepEqual(ev.failedUnits, ["diaria-a.service", "diaria-z.service"]);
  });
});

describe("isAlarmingVerdict", () => {
  it("ok → false, alarm-failed-units → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("alarm-failed-units"), true);
  });
});

describe("shouldSendSystemdFailedUnitsAlarm — idempotência por CONJUNTO", () => {
  it("verdict ok nunca alarma", () => {
    assert.equal(
      shouldSendSystemdFailedUnitsAlarm({ verdict: "ok", failedUnits: [] }, emptySystemdFailedUnitsAlarmState()),
      false,
    );
  });

  it("1ª detecção (state vazio) alarma", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, emptySystemdFailedUnitsAlarmState()), true);
  });

  it("mesmo conjunto já alarmado não reenvia", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service", "diaria-b.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-b.service", "diaria-a.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), false);
  });

  it("conjunto MUDOU (unit nova falhou) reenvia mesmo com sobreposição parcial", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service", "diaria-c.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service", "diaria-b.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), true);
  });

  it("conjunto encolheu (uma unit consertada, outra ainda falha) reenvia", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service", "diaria-b.service"]);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state), true);
  });
});

describe("shouldSendSystemdFailedUnitsAlarm — expiração do dedup por CONJUNTO (#5978)", () => {
  it("mesmo conjunto, DENTRO da janela de expiração -> não reenvia (comportamento pré-#5978 preservado)", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const t0 = new Date("2026-08-23T12:00:00Z");
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service"], t0);
    const now = new Date(t0.getTime() + ALARM_DEDUP_EXPIRY_MS - 1);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state, now), false);
  });

  it("mesmo conjunto, ALÉM da janela de expiração -> reenvia mesmo sem mudança nenhuma (#5978: 'parado há 2 dias' nunca fica invisível)", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const t0 = new Date("2026-08-23T12:00:00Z");
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service"], t0);
    const now = new Date(t0.getTime() + ALARM_DEDUP_EXPIRY_MS);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state, now), true);
  });

  it("exatamente na borda (elapsed === ALARM_DEDUP_EXPIRY_MS) -> reenvia (>=, não >)", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const t0 = new Date("2026-08-23T12:00:00Z");
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service"], t0);
    const now = new Date(t0.getTime() + ALARM_DEDUP_EXPIRY_MS);
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, state, now), true);
  });

  it("state pré-#5978 (lastAlarmedAt ausente/null) com o mesmo conjunto -> trata como expirado, reenvia (nunca bloqueia por falta do campo novo)", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const legacyState = { lastAlarmedUnits: ["diaria-a.service"], lastAlarmedAt: null };
    assert.equal(shouldSendSystemdFailedUnitsAlarm(ev, legacyState, new Date("2026-08-23T12:00:00Z")), true);
  });

  it("markSystemdFailedUnitsAlarmed grava lastAlarmedAt = now.toISOString()", () => {
    const now = new Date("2026-08-23T15:30:00Z");
    const state = markSystemdFailedUnitsAlarmed(["diaria-a.service"], now);
    assert.equal(state.lastAlarmedAt, "2026-08-23T15:30:00.000Z");
  });

  it("emptySystemdFailedUnitsAlarmState inclui lastAlarmedAt: null", () => {
    assert.deepEqual(emptySystemdFailedUnitsAlarmState(), { lastAlarmedUnits: null, lastAlarmedAt: null });
  });
});

describe("buildSystemdFailedUnitsAlarmEmail", () => {
  it("lista as units no assunto e no corpo", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-edicao-diaria.service"]);
    const { subject, body } = buildSystemdFailedUnitsAlarmEmail(ev, "");
    assert.match(subject, /diaria-edicao-diaria\.service/);
    assert.match(body, /diaria-edicao-diaria\.service/);
    assert.match(body, /journalctl --user -u/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateSystemdFailedUnits(["diaria-a.service"]);
    const { body } = buildSystemdFailedUnitsAlarmEmail(ev, "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });
});

describe("isValidUnitDiagnosticValue — 2ª barreira, validação de forma por propriedade (#5963)", () => {
  it("Result aceita só os enums conhecidos do systemd", () => {
    assert.equal(isValidUnitDiagnosticValue("Result", "exit-code"), true);
    assert.equal(isValidUnitDiagnosticValue("Result", "timeout"), true);
    assert.equal(isValidUnitDiagnosticValue("Result", "oom-kill"), true);
    assert.equal(isValidUnitDiagnosticValue("Result", "algo-inesperado-do-systemd"), false);
    assert.equal(isValidUnitDiagnosticValue("Result", ""), false);
  });

  it("ExecMainStatus/NRestarts aceitam só inteiro (incl. negativo p/ ExecMainStatus via sinal)", () => {
    assert.equal(isValidUnitDiagnosticValue("ExecMainStatus", "1"), true);
    assert.equal(isValidUnitDiagnosticValue("ExecMainStatus", "0"), true);
    assert.equal(isValidUnitDiagnosticValue("ExecMainStatus", "-1"), true);
    assert.equal(isValidUnitDiagnosticValue("NRestarts", "3"), true);
    assert.equal(isValidUnitDiagnosticValue("NRestarts", "n/a"), false);
    assert.equal(isValidUnitDiagnosticValue("ExecMainStatus", "not-a-number"), false);
    assert.equal(isValidUnitDiagnosticValue("ExecMainStatus", "1; rm -rf /"), false);
  });

  it("timestamps aceitam formato systemd, string vazia, e 'n/a' — descartam qualquer outra coisa", () => {
    assert.equal(isValidUnitDiagnosticValue("ActiveEnterTimestamp", "Sat 2026-08-23 09:00:12 UTC"), true);
    assert.equal(isValidUnitDiagnosticValue("InactiveEnterTimestamp", ""), true);
    assert.equal(isValidUnitDiagnosticValue("InactiveEnterTimestamp", "n/a"), true);
    assert.equal(isValidUnitDiagnosticValue("ActiveEnterTimestamp", "amanhã de manhã"), false);
    assert.equal(
      isValidUnitDiagnosticValue("ActiveEnterTimestamp", "leaked-api-response-with-secret-token=abc123"),
      false,
    );
  });

  it("InvocationID aceita UUID de 32 hex chars ou vazio — descarta qualquer outro texto", () => {
    assert.equal(isValidUnitDiagnosticValue("InvocationID", "0123456789abcdef0123456789abcdef"), true);
    assert.equal(isValidUnitDiagnosticValue("InvocationID", ""), true);
    assert.equal(isValidUnitDiagnosticValue("InvocationID", "not-a-uuid"), false);
    assert.equal(isValidUnitDiagnosticValue("InvocationID", "0123456789abcdef0123456789abcdef-extra"), false);
  });
});

describe("parseUnitDiagnosticShowOutput — allowlist FECHADA + descarte por forma (#5963)", () => {
  it("parseia output válido completo", () => {
    const output = [
      "Result=exit-code",
      "ExecMainStatus=1",
      "NRestarts=0",
      "ActiveEnterTimestamp=Sat 2026-08-23 09:00:12 UTC",
      "InactiveEnterTimestamp=Sat 2026-08-23 09:00:15 UTC",
      "InvocationID=0123456789abcdef0123456789abcdef",
    ].join("\n");
    assert.deepEqual(parseUnitDiagnosticShowOutput(output), {
      Result: "exit-code",
      ExecMainStatus: "1",
      NRestarts: "0",
      ActiveEnterTimestamp: "Sat 2026-08-23 09:00:12 UTC",
      InactiveEnterTimestamp: "Sat 2026-08-23 09:00:15 UTC",
      InvocationID: "0123456789abcdef0123456789abcdef",
    });
  });

  it("propriedade fora da allowlist (ex: ExecMainStatusText, texto livre) nunca aparece no resultado", () => {
    const output = [
      "Result=exit-code",
      "ExecMainStatusText=Bearer sk-leaked-token-abc123 email=assinante@example.com",
      "ExecStart=/usr/bin/node script.ts --api-key=SECRETO",
    ].join("\n");
    const fields = parseUnitDiagnosticShowOutput(output);
    assert.deepEqual(Object.keys(fields), ["Result"]);
    assert.equal(JSON.stringify(fields).includes("SECRETO"), false);
    assert.equal(JSON.stringify(fields).includes("assinante@example.com"), false);
  });

  it("valor com formato inesperado é DESCARTADO (não incluído), não repassado cego", () => {
    const output = ["Result=um-token-de-api-vazado-aqui", "ExecMainStatus=1"].join("\n");
    const fields = parseUnitDiagnosticShowOutput(output);
    assert.equal(fields.Result, undefined);
    assert.equal(fields.ExecMainStatus, "1");
  });

  it("output vazio/malformado nunca lança — resultado vazio", () => {
    assert.deepEqual(parseUnitDiagnosticShowOutput(""), {});
    assert.deepEqual(parseUnitDiagnosticShowOutput("linha sem sinal de igual\n\n"), {});
  });

  it("allowlist cobre exatamente as 6 propriedades da issue #5963", () => {
    assert.deepEqual(
      [...UNIT_DIAGNOSTIC_PROPERTIES].sort(),
      ["ActiveEnterTimestamp", "ExecMainStatus", "InactiveEnterTimestamp", "InvocationID", "NRestarts", "Result"].sort(),
    );
  });
});

describe("formatUnitDiagnosticFieldsTable", () => {
  it("formata tabela markdown com os campos capturados", () => {
    const table = formatUnitDiagnosticFieldsTable({ Result: "exit-code", ExecMainStatus: "1" });
    assert.match(table, /\| Campo \| Valor \|/);
    assert.match(table, /\| Result \| `exit-code` \|/);
    assert.match(table, /\| ExecMainStatus \| `1` \|/);
  });

  it("nenhum campo sobrevivente → string vazia (caller omite a seção)", () => {
    assert.equal(formatUnitDiagnosticFieldsTable({}), "");
  });
});

describe("buildUnitInvestigationCommand", () => {
  it("com InvocationID disponível, usa journalctl por _SYSTEMD_INVOCATION_ID (execução específica)", () => {
    const fields: UnitDiagnosticFields = { InvocationID: "0123456789abcdef0123456789abcdef" };
    assert.equal(
      buildUnitInvestigationCommand("diaria-a.service", fields),
      "journalctl --user _SYSTEMD_INVOCATION_ID=0123456789abcdef0123456789abcdef",
    );
  });

  it("sem InvocationID (descartado/ausente), cai pro comando genérico por unit", () => {
    assert.equal(
      buildUnitInvestigationCommand("diaria-a.service", {}),
      "journalctl --user -u diaria-a.service -n 50",
    );
  });
});

describe("readUnitDiagnosticFields — I/O + fail-soft sem systemctl (#5963)", () => {
  it("parseia a saída de um execFn mockado", () => {
    const mockExec = () => "Result=success\nExecMainStatus=0\n" as unknown as Buffer;
    const fields = readUnitDiagnosticFields("diaria-a.service", mockExec as any);
    assert.deepEqual(fields, { Result: "success", ExecMainStatus: "0" });
  });

  it("máquina sem systemctl (ENOENT) → null, nunca lança (fail-soft — sessão cloud/clone fresco)", () => {
    const mockExec = () => {
      const err = new Error("spawn systemctl ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    assert.equal(readUnitDiagnosticFields("diaria-a.service", mockExec as any), null);
  });

  it("erro genérico de execução (ex: unit inexistente, bus indisponível) também → null, não lança", () => {
    const mockExec = () => {
      throw new Error("Failed to get properties: Unit diaria-a.service not loaded.");
    };
    assert.equal(readUnitDiagnosticFields("diaria-a.service", mockExec as any), null);
  });
});

describe("toAlarmFinding — corpo com campos diagnósticos (#5963)", () => {
  it("sem campos diagnósticos (null, fail-soft), corpo degrada pro formato antigo — sem tabela, comando genérico", () => {
    const finding = toAlarmFinding("diaria-a.service", null);
    assert.doesNotMatch(finding.body, /\| Campo \| Valor \|/);
    assert.match(finding.body, /journalctl --user -u diaria-a\.service -n 50/);
  });

  it("com campos diagnósticos válidos, corpo inclui tabela + comando por InvocationID", () => {
    const fields: UnitDiagnosticFields = {
      Result: "exit-code",
      ExecMainStatus: "1",
      NRestarts: "0",
      InvocationID: "0123456789abcdef0123456789abcdef",
    };
    const finding = toAlarmFinding("diaria-a.service", fields);
    assert.match(finding.body, /\| Campo \| Valor \|/);
    assert.match(finding.body, /\| Result \| `exit-code` \|/);
    assert.match(finding.body, /journalctl --user _SYSTEMD_INVOCATION_ID=0123456789abcdef0123456789abcdef/);
  });

  it("nenhum campo de texto livre (ExecMainStatusText, logs, stdout/stderr) jamais aparece no corpo", () => {
    // simula um objeto de campos que, por bug hipotético upstream, carregasse
    // uma chave fora da allowlist — TS normalmente impede isso, daí o cast;
    // o teste garante que MESMO SE algo vazasse até aqui, o formatador só
    // itera sobre UNIT_DIAGNOSTIC_PROPERTIES, nunca sobre Object.keys(fields).
    const fields = {
      Result: "exit-code",
      ExecMainStatusText: "Bearer sk-leaked-token email=assinante@example.com",
    } as unknown as UnitDiagnosticFields;
    const finding = toAlarmFinding("diaria-a.service", fields);
    assert.equal(finding.body.includes("sk-leaked-token"), false);
    assert.equal(finding.body.includes("assinante@example.com"), false);
    assert.equal(finding.body.includes("ExecMainStatusText"), false);
  });
});
