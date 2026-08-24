/**
 * test/clarice-envio-guard-alarm.test.ts (#5220)
 *
 * Lógica pura de `scripts/lib/clarice-envio-guard-alarm.ts`. Cobre o Gap 2
 * da issue #5220: `Diaria-Clarice-Envio-Alarm` (20:30) lê `envio-{aammdd}*`
 * do dia inteiro e escolhe o mais recente por mtime — o relatório do run das
 * 19:00 sempre vence o do guard da MESMA manhã (~15h mais novo), então uma
 * falha do guard das 05:00 ficava invisível. Esta lógica lê SÓ a família
 * `-guard-*`, isolada — nunca compete com o run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickLatestGuardReport,
  classifyGuardReportId,
  evaluateGuardAlarm,
  shouldSendGuardAlarm,
  markGuardAlarmed,
  emptyEnvioGuardAlarmState,
  buildGuardAlarmEmail,
  type EnvioGuardAlarmReportFile,
} from "../scripts/lib/clarice-envio-guard-alarm.ts";

const AAMMDD = "260812";

function report(reportId: string, mtimeMs: number): EnvioGuardAlarmReportFile {
  return { reportId, mtimeMs };
}

describe("pickLatestGuardReport", () => {
  it("escolhe o de mtime mais recente", () => {
    const r = pickLatestGuardReport([
      report(`envio-${AAMMDD}-guard-abort`, 100),
      report(`envio-${AAMMDD}-guard-ok`, 200),
    ]);
    assert.equal(r?.reportId, `envio-${AAMMDD}-guard-ok`);
  });

  it("array vazio => null", () => {
    assert.equal(pickLatestGuardReport([]), null);
  });

  it("1 único candidato => ele mesmo", () => {
    const r = pickLatestGuardReport([report(`envio-${AAMMDD}-guard-paused`, 50)]);
    assert.equal(r?.reportId, `envio-${AAMMDD}-guard-paused`);
  });
});

describe("classifyGuardReportId", () => {
  for (const suffix of ["-paused", "-nada-a-fazer", "-ok", "-cancelou"]) {
    it(`desfecho esperado "${suffix}" => ok`, () => {
      assert.equal(classifyGuardReportId(`envio-${AAMMDD}-guard${suffix}`, AAMMDD), "ok");
    });
  }

  it('"-cancelamento-incompleto" => alarm (cancelamento NÃO confirmado)', () => {
    assert.equal(classifyGuardReportId(`envio-${AAMMDD}-guard-cancelamento-incompleto`, AAMMDD), "alarm");
  });

  it('"-lock-held" => alarm', () => {
    assert.equal(classifyGuardReportId(`envio-${AAMMDD}-guard-lock-held`, AAMMDD), "alarm");
  });

  it('"-abort" => alarm', () => {
    assert.equal(classifyGuardReportId(`envio-${AAMMDD}-guard-abort`, AAMMDD), "alarm");
  });

  // #5220 — o caso central da issue: TODO caminho de fallback alarma, mesmo
  // quando o fallback "funcionou" (deixou passar OU suspendeu com sucesso).
  for (const suffix of ["-prereq-fallback-deixou-passar", "-prereq-fallback-cancelou", "-prereq-fallback-cancelamento-incompleto", "-prereq-falhou-sem-pendencia"]) {
    it(`caminho de fallback "${suffix}" => SEMPRE alarm, mesmo quando o fallback funcionou`, () => {
      assert.equal(classifyGuardReportId(`envio-${AAMMDD}-guard${suffix}`, AAMMDD), "alarm");
    });
  }

  it("sufixo desconhecido/futuro => alarm (fail-toward-alarming, nunca mascara silenciosamente)", () => {
    assert.equal(classifyGuardReportId(`envio-${AAMMDD}-guard-algum-motivo-novo-nunca-visto`, AAMMDD), "alarm");
  });

  it("reportId de OUTRO dia (aammdd não bate) => alarm — nunca confunde relatório de ontem com o de hoje", () => {
    assert.equal(classifyGuardReportId("envio-260811-guard-ok", AAMMDD), "alarm");
  });

  it("reportId do RUN das 19:00 (sem '-guard') => alarm — nunca confunde com a família do guard", () => {
    assert.equal(classifyGuardReportId(`envio-${AAMMDD}`, AAMMDD), "alarm");
    assert.equal(classifyGuardReportId(`envio-${AAMMDD}-paused`, AAMMDD), "alarm");
  });
});

describe("evaluateGuardAlarm", () => {
  it("nenhum relatório => alarm-no-report, reportId null", () => {
    const r = evaluateGuardAlarm([], AAMMDD);
    assert.deepEqual(r, { verdict: "alarm-no-report", reportId: null });
  });

  it("relatório -guard-ok => ok", () => {
    const r = evaluateGuardAlarm([report(`envio-${AAMMDD}-guard-ok`, 100)], AAMMDD);
    assert.deepEqual(r, { verdict: "ok", reportId: `envio-${AAMMDD}-guard-ok` });
  });

  it("relatório -guard-prereq-fallback-deixou-passar => alarm-failure (cenário central da issue #5220)", () => {
    const r = evaluateGuardAlarm([report(`envio-${AAMMDD}-guard-prereq-fallback-deixou-passar`, 100)], AAMMDD);
    assert.deepEqual(r, { verdict: "alarm-failure", reportId: `envio-${AAMMDD}-guard-prereq-fallback-deixou-passar` });
  });

  // #6041 — P2 alarm-evento (evento histórico, não se auto-resolve): o
  // desfecho `cancelamento-incompleto-nao-ok` indica que o guard caiu no
  // fallback (#5220: pré-requisito falhou após retry, freio anterior não-OK,
  // cancelamento incompleto). Causa raiz: #6029 (curto-circuito de cota no
  // ?fresh=1 do painel Clarice) — corrigido em #6044 (8805ab15); o evento
  // #6041 permanece no tracking `alarm-issues` como registro histórico.
  it("relatório -prereq-fallback-cancelamento-incompleto-nao-ok => alarm-failure (regressão #6041 / #6029 corrigido em #6044)", () => {
    const r = evaluateGuardAlarm(
      [report(`envio-${AAMMDD}-guard-prereq-fallback-cancelamento-incompleto-nao-ok`, 100)],
      AAMMDD,
    );
    assert.deepEqual(r, { verdict: "alarm-failure", reportId: `envio-${AAMMDD}-guard-prereq-fallback-cancelamento-incompleto-nao-ok` });
  });

  it("#6041 verifica que 'cancelamento-incompleto-nao-ok' NÃO é OK (fail-toward-alarming)", () => {
    assert.equal(
      classifyGuardReportId(`envio-${AAMMDD}-guard-prereq-fallback-cancelamento-incompleto-nao-ok`, AAMMDD),
      "alarm",
    );
  });

  it("2 candidatos (retry manual no mesmo dia): abort seguido de sucesso => ok, o ÚLTIMO desfecho vence", () => {
    const r = evaluateGuardAlarm(
      [report(`envio-${AAMMDD}-guard-abort`, 100), report(`envio-${AAMMDD}-guard-ok`, 200)],
      AAMMDD,
    );
    assert.equal(r.verdict, "ok");
  });

  it("relatório do RUN das 19:00 no mesmo dia (sem -guard) NUNCA é escolhido, mesmo sendo o mais recente por mtime", () => {
    const r = evaluateGuardAlarm(
      [report(`envio-${AAMMDD}-guard-ok`, 100), report(`envio-${AAMMDD}`, 999999)],
      AAMMDD,
    );
    // O caller (listTodayGuardReports) já filtra por prefixo antes de chegar
    // aqui — este teste documenta que, MESMO que um candidato de outra
    // família vazasse pra cá, ele nunca teria prioridade silenciosa: seria
    // classificado alarm (reportId não bate no prefixo -guard), não ok.
    assert.equal(r.verdict, "alarm-failure");
  });
});

describe("idempotência — shouldSendGuardAlarm / markGuardAlarmed", () => {
  it("verdict ok => nunca alarma, independente do estado", () => {
    const evaluation = { verdict: "ok" as const, reportId: `envio-${AAMMDD}-guard-ok` };
    assert.equal(shouldSendGuardAlarm(evaluation, emptyEnvioGuardAlarmState(), AAMMDD), false);
  });

  it("verdict alarm-failure + nunca alarmado antes => alarma", () => {
    const evaluation = { verdict: "alarm-failure" as const, reportId: `envio-${AAMMDD}-guard-abort` };
    assert.equal(shouldSendGuardAlarm(evaluation, emptyEnvioGuardAlarmState(), AAMMDD), true);
  });

  it("verdict alarm-failure + JÁ alarmado pro MESMO aammdd => não reenvia", () => {
    const evaluation = { verdict: "alarm-failure" as const, reportId: `envio-${AAMMDD}-guard-abort` };
    const state = markGuardAlarmed(emptyEnvioGuardAlarmState(), AAMMDD);
    assert.equal(shouldSendGuardAlarm(evaluation, state, AAMMDD), false);
  });

  it("verdict alarm-failure + alarmado num DIA DIFERENTE => alarma de novo (dia novo, falha nova)", () => {
    const evaluation = { verdict: "alarm-failure" as const, reportId: "envio-260813-guard-abort" };
    const state = markGuardAlarmed(emptyEnvioGuardAlarmState(), AAMMDD); // alarmado ONTEM
    assert.equal(shouldSendGuardAlarm(evaluation, state, "260813"), true);
  });

  it("alarm-no-report também alarma (mesma disciplina de alarm-failure)", () => {
    const evaluation = { verdict: "alarm-no-report" as const, reportId: null };
    assert.equal(shouldSendGuardAlarm(evaluation, emptyEnvioGuardAlarmState(), AAMMDD), true);
  });
});

describe("buildGuardAlarmEmail", () => {
  it("alarm-no-report: assunto e corpo mencionam a ausência de relatório e o comando de diagnóstico", () => {
    const { subject, body } = buildGuardAlarmEmail({ verdict: "alarm-no-report", reportId: null }, AAMMDD);
    assert.match(subject, /nenhum relat[óo]rio/i);
    assert.match(subject, new RegExp(AAMMDD));
    assert.match(body, /journalctl/);
    assert.match(body, /diaria-clarice-envio-guard/);
  });

  it("alarm-failure: assunto e corpo citam o reportId exato e mencionam o fallback/#5220", () => {
    const reportId = `envio-${AAMMDD}-guard-prereq-fallback-deixou-passar`;
    const { subject, body } = buildGuardAlarmEmail({ verdict: "alarm-failure", reportId }, AAMMDD);
    assert.match(subject, new RegExp(reportId));
    assert.match(body, new RegExp(reportId));
    assert.match(body, /fallback/);
    assert.match(body, /06:00/);
  });
});

describe("buildGuardAlarmEmail com issueRef (#5339) — prova de fumaça do wiring alarm-issues", () => {
  it("cita o número da issue quando issueRef foi criado/reusado", () => {
    const reportId = `envio-${AAMMDD}-guard-prereq-fallback-deixou-passar`;
    const { body } = buildGuardAlarmEmail(
      { verdict: "alarm-failure", reportId },
      AAMMDD,
      { issueNumber: 5342, url: "https://github.com/vjpixel/diaria-studio/issues/5342", action: "created" },
    );
    assert.match(body, /Issue: #5342/);
    assert.match(body, /issues\/5342/);
  });

  it("action 'failed' cita o motivo em vez de um número — e-mail nunca perde o achado por falha de gh", () => {
    const { body } = buildGuardAlarmEmail(
      { verdict: "alarm-no-report", reportId: null },
      AAMMDD,
      { issueNumber: null, url: null, action: "failed", error: "gh não autenticado" },
    );
    assert.match(body, /falha ao criar\/reusar \(gh não autenticado\)/);
  });

  it("sem issueRef (undefined) — corpo sai igual ao comportamento pré-#5339, sem quebrar", () => {
    const { body } = buildGuardAlarmEmail({ verdict: "alarm-no-report", reportId: null }, AAMMDD);
    assert.doesNotMatch(body, /Issue:/);
  });
});
