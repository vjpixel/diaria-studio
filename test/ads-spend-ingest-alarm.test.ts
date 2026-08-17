/**
 * test/ads-spend-ingest-alarm.test.ts (#5597)
 *
 * Lógica pura de `scripts/lib/ads-spend-ingest-alarm.ts` + `toAlarmFinding`
 * de `scripts/ads-spend-ingest-alarm.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLatestLogRun,
  isRunFromToday,
  evaluateAdsSpendIngestAlarm,
  isAlarmingVerdict,
  shouldSendAdsSpendIngestAlarm,
  markAdsSpendIngestAlarmed,
  emptyAdsSpendIngestAlarmState,
  buildAdsSpendIngestAlarmEmail,
} from "../scripts/lib/ads-spend-ingest-alarm.ts";
import { toAlarmFinding } from "../scripts/ads-spend-ingest-alarm.ts";

const OK_RUN =
  "\n===== 2026-08-17T09:50:00.000Z - ingestão de gasto de aquisição =====\n" +
  "----- google -----\n" +
  "[google-ads-ingest-spend] ✔ data/aquisicao/spend.csv atualizado (30 linha(s) GAQL agregadas).\n" +
  "----- microsoft -----\n" +
  "[microsoft-ads-ingest-spend] fallback pro CSV manual — variável(is) de ambiente ausente(s): MICROSOFT_ADS_CLIENT_ID\n" +
  "===== fim (google=0 microsoft=0) =====\n";

const DEFECT_RUN =
  "\n===== 2026-08-17T09:50:00.000Z - ingestão de gasto de aquisição =====\n" +
  "----- google -----\n" +
  "[google-ads-ingest-spend] ✖ DEFEITO na ingestão — NÃO é indisponibilidade externa.\n" +
  "  googleAds:search respondeu HTTP 400: queryError...\n" +
  "===== fim (google=0) =====\n";

const DEFECT_RUN_NEXT_DAY =
  "\n===== 2026-08-18T09:50:00.000Z - ingestão de gasto de aquisição =====\n" +
  "----- google -----\n" +
  "[google-ads-ingest-spend] ✖ DEFEITO na ingestão — NÃO é indisponibilidade externa.\n" +
  "  googleAds:search respondeu HTTP 400: queryError...\n" +
  "===== fim (google=0) =====\n";

describe("parseLatestLogRun", () => {
  it("log null → null", () => {
    assert.equal(parseLatestLogRun(null), null);
  });

  it("log vazio → null", () => {
    assert.equal(parseLatestLogRun(""), null);
  });

  it("log sem cabeçalho reconhecível → null (formato inesperado, fail-toward-alarming)", () => {
    assert.equal(parseLatestLogRun("algum texto solto sem cabeçalho ====="), null);
  });

  it("1 run → extrai o texto inteiro e o timestamp do cabeçalho", () => {
    const result = parseLatestLogRun(OK_RUN);
    assert.ok(result);
    assert.equal(result!.startedAt, "2026-08-17T09:50:00.000Z");
    assert.match(result!.text, /ingestão de gasto de aquisição/);
    assert.match(result!.text, /fim \(google=0 microsoft=0\)/);
  });

  it("múltiplos runs concatenados → extrai só o ÚLTIMO", () => {
    const first =
      "\n===== 2026-08-15T09:50:00.000Z - ingestão de gasto de aquisição =====\n" +
      "conteúdo do dia 15, não deveria aparecer no resultado\n" +
      "===== fim (google=0) =====\n";
    const combined = first + OK_RUN;
    const result = parseLatestLogRun(combined);
    assert.ok(result);
    assert.equal(result!.startedAt, "2026-08-17T09:50:00.000Z");
    assert.doesNotMatch(result!.text, /dia 15/);
  });
});

describe("isRunFromToday", () => {
  it("mesmo dia-calendário UTC → true", () => {
    assert.equal(isRunFromToday("2026-08-17T09:50:00.000Z", new Date("2026-08-17T20:00:00.000Z")), true);
  });

  it("dia diferente → false", () => {
    assert.equal(isRunFromToday("2026-08-16T09:50:00.000Z", new Date("2026-08-17T20:00:00.000Z")), false);
  });

  it("timestamp malformado → false, nunca lança", () => {
    assert.equal(isRunFromToday("not-a-date", new Date("2026-08-17T20:00:00.000Z")), false);
  });
});

describe("evaluateAdsSpendIngestAlarm", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("log null (task nunca rodou/nunca armada) → alarm-no-run", () => {
    const ev = evaluateAdsSpendIngestAlarm(null, NOW);
    assert.equal(ev.verdict, "alarm-no-run");
    assert.equal(ev.latestRun, null);
  });

  it("run de HOJE sem marcador de defeito → ok", () => {
    const ev = evaluateAdsSpendIngestAlarm(OK_RUN, NOW);
    assert.equal(ev.verdict, "ok");
  });

  it("run de HOJE com '✖ DEFEITO' → alarm-defect (o caso concreto que motivou a issue)", () => {
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW);
    assert.equal(ev.verdict, "alarm-defect");
    assert.match(ev.latestRun ?? "", /DEFEITO/);
  });

  it("run existe mas é de ONTEM (task não rodou hoje) → alarm-no-run, mesmo com log presente", () => {
    const yesterdayRun = OK_RUN.replace("2026-08-17", "2026-08-16");
    const ev = evaluateAdsSpendIngestAlarm(yesterdayRun, NOW);
    assert.equal(ev.verdict, "alarm-no-run");
  });
});

describe("isAlarmingVerdict", () => {
  it("ok → false; alarm-defect/alarm-no-run → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("alarm-defect"), true);
    assert.equal(isAlarmingVerdict("alarm-no-run"), true);
  });
});

describe("shouldSendAdsSpendIngestAlarm — idempotência por dia", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("verdict ok nunca alarma", () => {
    const ev = evaluateAdsSpendIngestAlarm(OK_RUN, NOW);
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, emptyAdsSpendIngestAlarmState(), NOW), false);
  });

  it("1ª detecção do dia alarma", () => {
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW);
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, emptyAdsSpendIngestAlarmState(), NOW), true);
  });

  it("já alarmado HOJE não reenvia", () => {
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW);
    const state = markAdsSpendIngestAlarmed(NOW);
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, state, NOW), false);
  });

  it("dia seguinte com o mesmo defeito reenvia (dedup é por dia, não por conteúdo)", () => {
    const state = markAdsSpendIngestAlarmed(NOW);
    const tomorrow = new Date("2026-08-18T20:00:00.000Z");
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN.replace("2026-08-17", "2026-08-18"), tomorrow);
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, state, tomorrow), true);
  });
});

describe("buildAdsSpendIngestAlarmEmail", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("alarm-defect: assunto/corpo mencionam DEFEITO e citam o logPath", () => {
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW);
    const { subject, body } = buildAdsSpendIngestAlarmEmail(ev, "data/aquisicao/.ads-spend-ingest.log", "");
    assert.match(subject, /DEFEITO/);
    assert.match(body, /data\/aquisicao\/\.ads-spend-ingest\.log/);
    assert.match(body, /DEFEITO/);
  });

  it("alarm-no-run: assunto/corpo mencionam ausência de execução", () => {
    const ev = evaluateAdsSpendIngestAlarm(null, NOW);
    const { subject, body } = buildAdsSpendIngestAlarmEmail(ev, "data/aquisicao/.ads-spend-ingest.log", "");
    assert.match(subject, /nenhuma execução/);
    assert.match(body, /systemctl/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW);
    const { body } = buildAdsSpendIngestAlarmEmail(ev, "x.log", "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });
});

describe("toAlarmFinding", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("family 'estado', priority P1 pra defeito real", () => {
    const ev = evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW);
    const f = toAlarmFinding(ev);
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P1");
    assert.equal(f.check, "ads-spend-ingest");
  });

  it("priority P2 pra 'nenhuma execução hoje' — menos grave que defeito confirmado", () => {
    const ev = evaluateAdsSpendIngestAlarm(null, NOW);
    const f = toAlarmFinding(ev);
    assert.equal(f.priority, "P2");
  });

  it("fingerprint distingue defect de no-run, mas cada um é fixo (nunca varia por timestamp) — family 'estado' precisa disso pro auto-close por streak", () => {
    const defectFinding = toAlarmFinding(evaluateAdsSpendIngestAlarm(DEFECT_RUN, NOW));
    const noRunFinding = toAlarmFinding(evaluateAdsSpendIngestAlarm(null, NOW));
    assert.notEqual(defectFinding.fingerprint, noRunFinding.fingerprint);
    assert.equal(noRunFinding.fingerprint, "no-run");
    assert.equal(defectFinding.fingerprint, "defect");

    // Duas execuções em dias diferentes com o MESMO tipo de defeito devem
    // produzir o MESMO fingerprint — senão cada dia com defeito abre uma
    // issue nova em vez de acumular streak pro auto-close (mesmo padrão de
    // `clarice-envio-alarm.ts` pros achados family "estado").
    const defectFindingNextDay = toAlarmFinding(
      evaluateAdsSpendIngestAlarm(DEFECT_RUN_NEXT_DAY, new Date("2026-08-18T20:00:00.000Z")),
    );
    assert.equal(defectFindingNextDay.fingerprint, defectFinding.fingerprint);
  });
});
