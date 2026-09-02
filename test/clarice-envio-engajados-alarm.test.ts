/**
 * test/clarice-envio-engajados-alarm.test.ts (#6945)
 *
 * Lógica pura de `scripts/lib/clarice-envio-engajados-alarm.ts`. Mesmo
 * molde de test/clarice-envio-alarm.test.ts (irmão ramp-warm), com o
 * vocabulário de sufixo PRÓPRIO desta automação (ver docstring do módulo
 * pro porquê `-lock-held` diverge do irmão).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickLatestEnvioEngajadosReport,
  classifyEnvioEngajadosReportId,
  evaluateEnvioEngajadosAlarm,
  shouldSendEnvioEngajadosAlarm,
  markEnvioEngajadosAlarmed,
  emptyEnvioEngajadosAlarmState,
  buildEnvioEngajadosAlarmEmail,
  type EnvioEngajadosAlarmReportFile,
} from "../scripts/lib/clarice-envio-engajados-alarm.ts";

const AAMMDD = "260902";

function report(reportId: string, mtimeMs: number): EnvioEngajadosAlarmReportFile {
  return { reportId, mtimeMs };
}

describe("pickLatestEnvioEngajadosReport", () => {
  it("escolhe o de mtime mais recente", () => {
    const r = pickLatestEnvioEngajadosReport([
      report(`envio-engajados-${AAMMDD}-abort`, 100),
      report(`envio-engajados-${AAMMDD}`, 200),
    ]);
    assert.equal(r?.reportId, `envio-engajados-${AAMMDD}`);
  });

  it("array vazio => null", () => {
    assert.equal(pickLatestEnvioEngajadosReport([]), null);
  });
});

describe("classifyEnvioEngajadosReportId", () => {
  it("sem sufixo (sucesso) => ok", () => {
    assert.equal(classifyEnvioEngajadosReportId(`envio-engajados-${AAMMDD}`, AAMMDD), "ok");
  });

  for (const suffix of ["-paused", "-sem-ciclo-elegivel", "-sem-assunto-travado", "-dry-run", "-lock-held"]) {
    it(`pausa/skip legítimo "${suffix}" => ok`, () => {
      assert.equal(classifyEnvioEngajadosReportId(`envio-engajados-${AAMMDD}${suffix}`, AAMMDD), "ok");
    });
  }

  it('"-abort" => alarm', () => {
    assert.equal(classifyEnvioEngajadosReportId(`envio-engajados-${AAMMDD}-abort`, AAMMDD), "alarm");
  });

  it("sufixo desconhecido/futuro => alarm (fail-toward-alarming)", () => {
    assert.equal(classifyEnvioEngajadosReportId(`envio-engajados-${AAMMDD}-motivo-novo`, AAMMDD), "alarm");
  });

  it("reportId de OUTRO dia => alarm", () => {
    assert.equal(classifyEnvioEngajadosReportId(`envio-engajados-260901`, AAMMDD), "alarm");
  });

  it("reportId do irmão ramp-warm (prefixo diferente) => alarm — nunca confunde os dois relatórios", () => {
    assert.equal(classifyEnvioEngajadosReportId(`envio-${AAMMDD}`, AAMMDD), "alarm");
  });
});

describe("evaluateEnvioEngajadosAlarm", () => {
  it("nenhum relatório => alarm-no-report, reportId null", () => {
    assert.deepEqual(evaluateEnvioEngajadosAlarm([], AAMMDD), { verdict: "alarm-no-report", reportId: null });
  });

  it("relatório de sucesso => ok", () => {
    const r = evaluateEnvioEngajadosAlarm([report(`envio-engajados-${AAMMDD}`, 100)], AAMMDD);
    assert.deepEqual(r, { verdict: "ok", reportId: `envio-engajados-${AAMMDD}` });
  });

  it("relatório de abort => alarm-failure", () => {
    const r = evaluateEnvioEngajadosAlarm([report(`envio-engajados-${AAMMDD}-abort`, 100)], AAMMDD);
    assert.deepEqual(r, { verdict: "alarm-failure", reportId: `envio-engajados-${AAMMDD}-abort` });
  });

  it("relatório de lock-held => ok (self-heals, ver docstring do módulo)", () => {
    const r = evaluateEnvioEngajadosAlarm([report(`envio-engajados-${AAMMDD}-lock-held`, 100)], AAMMDD);
    assert.equal(r.verdict, "ok");
  });

  it("2 candidatos: abort seguido de sucesso (retry) => ok, o ÚLTIMO desfecho vence", () => {
    const r = evaluateEnvioEngajadosAlarm(
      [report(`envio-engajados-${AAMMDD}-abort`, 100), report(`envio-engajados-${AAMMDD}`, 200)],
      AAMMDD,
    );
    assert.equal(r.verdict, "ok");
  });
});

describe("shouldSendEnvioEngajadosAlarm / markEnvioEngajadosAlarmed (idempotência)", () => {
  it("verdict ok nunca dispara alarme", () => {
    const state = emptyEnvioEngajadosAlarmState();
    assert.equal(shouldSendEnvioEngajadosAlarm({ verdict: "ok", reportId: `envio-engajados-${AAMMDD}` }, state, AAMMDD), false);
  });

  it("verdict alarm-failure com estado vazio dispara", () => {
    const state = emptyEnvioEngajadosAlarmState();
    assert.equal(
      shouldSendEnvioEngajadosAlarm({ verdict: "alarm-failure", reportId: `envio-engajados-${AAMMDD}-abort` }, state, AAMMDD),
      true,
    );
  });

  it("já alarmado pro MESMO aammdd não dispara de novo", () => {
    const marked = markEnvioEngajadosAlarmed(emptyEnvioEngajadosAlarmState(), AAMMDD);
    assert.equal(
      shouldSendEnvioEngajadosAlarm({ verdict: "alarm-failure", reportId: `envio-engajados-${AAMMDD}-abort` }, marked, AAMMDD),
      false,
    );
  });

  it("alarmado ONTEM dispara de novo HOJE (dia diferente)", () => {
    const marked = markEnvioEngajadosAlarmed(emptyEnvioEngajadosAlarmState(), "260901");
    assert.equal(
      shouldSendEnvioEngajadosAlarm({ verdict: "alarm-failure", reportId: `envio-engajados-${AAMMDD}-abort` }, marked, AAMMDD),
      true,
    );
  });
});

describe("buildEnvioEngajadosAlarmEmail", () => {
  it("alarm-no-report: assunto/corpo nomeiam a task e o comando de diagnóstico", () => {
    const { subject, body } = buildEnvioEngajadosAlarmEmail({ verdict: "alarm-no-report", reportId: null }, AAMMDD);
    assert.match(subject, /Diaria-Clarice-Envio-Engajados/);
    assert.match(subject, new RegExp(AAMMDD));
    assert.match(body, /journalctl/);
  });

  it("alarm-failure: assunto/corpo citam o reportId", () => {
    const reportId = `envio-engajados-${AAMMDD}-abort`;
    const { subject, body } = buildEnvioEngajadosAlarmEmail({ verdict: "alarm-failure", reportId }, AAMMDD);
    assert.match(subject, new RegExp(reportId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(body, /data\/clarice-subscribers\/envio-reports/);
  });
});
