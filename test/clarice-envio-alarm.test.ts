/**
 * test/clarice-envio-alarm.test.ts (#5058, item 2)
 *
 * Lógica pura de `scripts/lib/clarice-envio-alarm.ts`. Cobre exatamente o
 * cenário real da issue #5058: a task `Diaria-Clarice-Envio` (19:00 BRT)
 * falha/aborta e NENHUM mecanismo detectava isso — a onda de 12/08 só
 * existiu porque um humano montou à mão.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickLatestEnvioReport,
  classifyEnvioReportId,
  evaluateEnvioAlarm,
  shouldSendEnvioAlarm,
  markEnvioAlarmed,
  emptyEnvioAlarmState,
  buildEnvioAlarmEmail,
  type EnvioAlarmReportFile,
} from "../scripts/lib/clarice-envio-alarm.ts";

const AAMMDD = "260811";

function report(reportId: string, mtimeMs: number): EnvioAlarmReportFile {
  return { reportId, mtimeMs };
}

describe("pickLatestEnvioReport", () => {
  it("escolhe o de mtime mais recente", () => {
    const r = pickLatestEnvioReport([
      report(`envio-${AAMMDD}-abort`, 100),
      report(`envio-${AAMMDD}`, 200),
    ]);
    assert.equal(r?.reportId, `envio-${AAMMDD}`);
  });

  it("array vazio => null", () => {
    assert.equal(pickLatestEnvioReport([]), null);
  });

  it("1 único candidato => ele mesmo", () => {
    const r = pickLatestEnvioReport([report(`envio-${AAMMDD}-paused`, 50)]);
    assert.equal(r?.reportId, `envio-${AAMMDD}-paused`);
  });
});

describe("classifyEnvioReportId", () => {
  it("sem sufixo (sucesso/incerto) => ok", () => {
    assert.equal(classifyEnvioReportId(`envio-${AAMMDD}`, AAMMDD), "ok");
  });

  for (const suffix of ["-paused", "-sem-ciclo-elegivel", "-abc-iniciar", "-onda-ja-existe", "-fila-insuficiente", "-freio-stop", "-sem-volume"]) {
    it(`pausa legítima "${suffix}" => ok`, () => {
      assert.equal(classifyEnvioReportId(`envio-${AAMMDD}${suffix}`, AAMMDD), "ok");
    });
  }

  it('"-abort" (o cenário REAL da issue #5058) => alarm', () => {
    assert.equal(classifyEnvioReportId(`envio-${AAMMDD}-abort`, AAMMDD), "alarm");
  });

  it('"-lock-held" => alarm', () => {
    assert.equal(classifyEnvioReportId(`envio-${AAMMDD}-lock-held`, AAMMDD), "alarm");
  });

  it("sufixo desconhecido/futuro => alarm (fail-toward-alarming, nunca mascara silenciosamente)", () => {
    assert.equal(classifyEnvioReportId(`envio-${AAMMDD}-algum-motivo-novo-nunca-visto`, AAMMDD), "alarm");
  });

  it("reportId de OUTRO dia (aammdd não bate) => alarm — nunca confunde relatório de ontem com o de hoje", () => {
    assert.equal(classifyEnvioReportId("envio-260810", AAMMDD), "alarm");
  });
});

describe("evaluateEnvioAlarm", () => {
  it("nenhum relatório => alarm-no-report, reportId null", () => {
    const r = evaluateEnvioAlarm([], AAMMDD);
    assert.deepEqual(r, { verdict: "alarm-no-report", reportId: null });
  });

  it("relatório de sucesso => ok", () => {
    const r = evaluateEnvioAlarm([report(`envio-${AAMMDD}`, 100)], AAMMDD);
    assert.deepEqual(r, { verdict: "ok", reportId: `envio-${AAMMDD}` });
  });

  it("relatório de abort (cenário real 260811) => alarm-failure", () => {
    const r = evaluateEnvioAlarm([report(`envio-${AAMMDD}-abort`, 100)], AAMMDD);
    assert.deepEqual(r, { verdict: "alarm-failure", reportId: `envio-${AAMMDD}-abort` });
  });

  it("2 candidatos (retry manual no mesmo dia): abort seguido de sucesso => ok, o ÚLTIMO desfecho vence", () => {
    const r = evaluateEnvioAlarm(
      [report(`envio-${AAMMDD}-abort`, 100), report(`envio-${AAMMDD}`, 200)],
      AAMMDD,
    );
    assert.equal(r.verdict, "ok");
  });

  it("2 candidatos: sucesso seguido de abort (retry que piorou) => alarm-failure, o ÚLTIMO desfecho vence", () => {
    const r = evaluateEnvioAlarm(
      [report(`envio-${AAMMDD}`, 100), report(`envio-${AAMMDD}-abort`, 200)],
      AAMMDD,
    );
    assert.equal(r.verdict, "alarm-failure");
  });
});

describe("idempotência — shouldSendEnvioAlarm / markEnvioAlarmed", () => {
  it("verdict ok => nunca alarma, independente do estado", () => {
    const evaluation = { verdict: "ok" as const, reportId: `envio-${AAMMDD}` };
    assert.equal(shouldSendEnvioAlarm(evaluation, emptyEnvioAlarmState(), AAMMDD), false);
  });

  it("verdict alarm-failure + nunca alarmado antes => alarma", () => {
    const evaluation = { verdict: "alarm-failure" as const, reportId: `envio-${AAMMDD}-abort` };
    assert.equal(shouldSendEnvioAlarm(evaluation, emptyEnvioAlarmState(), AAMMDD), true);
  });

  it("verdict alarm-failure + JÁ alarmado pro MESMO aammdd => não reenvia", () => {
    const evaluation = { verdict: "alarm-failure" as const, reportId: `envio-${AAMMDD}-abort` };
    const state = markEnvioAlarmed(emptyEnvioAlarmState(), AAMMDD);
    assert.equal(shouldSendEnvioAlarm(evaluation, state, AAMMDD), false);
  });

  it("verdict alarm-failure + alarmado num DIA DIFERENTE => alarma de novo (dia novo, falha nova)", () => {
    const evaluation = { verdict: "alarm-failure" as const, reportId: `envio-260812-abort` };
    const state = markEnvioAlarmed(emptyEnvioAlarmState(), AAMMDD); // alarmado ONTEM
    assert.equal(shouldSendEnvioAlarm(evaluation, state, "260812"), true);
  });

  it("alarm-no-report também alarma (mesma disciplina de alarm-failure)", () => {
    const evaluation = { verdict: "alarm-no-report" as const, reportId: null };
    assert.equal(shouldSendEnvioAlarm(evaluation, emptyEnvioAlarmState(), AAMMDD), true);
  });
});

describe("buildEnvioAlarmEmail", () => {
  it("alarm-no-report: assunto e corpo mencionam a ausência de relatório e o comando de diagnóstico", () => {
    const { subject, body } = buildEnvioAlarmEmail({ verdict: "alarm-no-report", reportId: null }, AAMMDD);
    assert.match(subject, /nenhum relat[óo]rio/i);
    assert.match(subject, new RegExp(AAMMDD));
    assert.match(body, /journalctl/);
    assert.match(body, /diaria-clarice-envio/);
  });

  it("alarm-failure: assunto e corpo citam o reportId exato e orientam pra montagem manual", () => {
    const reportId = `envio-${AAMMDD}-abort`;
    const { subject, body } = buildEnvioAlarmEmail({ verdict: "alarm-failure", reportId }, AAMMDD);
    assert.match(subject, new RegExp(reportId));
    assert.match(body, new RegExp(reportId));
    assert.match(body, /diaria-clarice-envio/);
    assert.match(body, /06:00/);
  });
});
