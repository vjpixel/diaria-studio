/**
 * test/ads-spend-ingest-alarm.test.ts (#5597, reescrito no #7518)
 *
 * Lógica pura de `scripts/lib/ads-spend-ingest-alarm.ts` + `toAlarmFinding`
 * de `scripts/ads-spend-ingest-alarm.ts`.
 *
 * Reescrito no #7518 pra refletir o formato REAL de log — dois arquivos
 * separados (um por plataforma), cada um com 1 step por run — em vez do
 * log unificado de 2 steps que a v1 (#5597) fixturava, que descrevia uma
 * task (`Diaria-Ads-Spend-Ingest`) que nunca chegou a existir (ver
 * docstring do módulo pro racional completo da causa raiz).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLatestLogRun,
  isRunFromToday,
  evaluateSinglePlatformLog,
  evaluateAdsSpendIngestAlarm,
  isAlarmingVerdict,
  shouldSendAdsSpendIngestAlarm,
  markAdsSpendIngestAlarmed,
  emptyAdsSpendIngestAlarmState,
  buildAdsSpendIngestAlarmEmail,
  type PlatformLogInput,
} from "../scripts/lib/ads-spend-ingest-alarm.ts";
import { toAlarmFinding } from "../scripts/ads-spend-ingest-alarm.ts";

const GOOGLE_LOG_PATH = "data/aquisicao/.google-ads-ingest.log";
const MICROSOFT_LOG_PATH = "data/aquisicao/.microsoft-ads-ingest.log";

const GOOGLE_OK_RUN =
  "\n===== 2026-08-17T09:50:00.000Z - ingestao diaria de gasto do Google Ads (GAQL) para data/aquisicao/spend.csv =====\n" +
  "----- ingest -----\n" +
  "[google-ads-ingest-spend] ✔ data/aquisicao/spend.csv atualizado (30 linha(s) GAQL agregadas).\n" +
  "===== fim (ingest=0) =====\n";

const GOOGLE_DEFECT_RUN =
  "\n===== 2026-08-17T09:50:00.000Z - ingestao diaria de gasto do Google Ads (GAQL) para data/aquisicao/spend.csv =====\n" +
  "----- ingest -----\n" +
  "[google-ads-ingest-spend] ✖ DEFEITO na ingestão — NÃO é indisponibilidade externa.\n" +
  "  googleAds:search respondeu HTTP 400: queryError...\n" +
  "===== fim (ingest=0) =====\n";

const GOOGLE_DEFECT_RUN_NEXT_DAY = GOOGLE_DEFECT_RUN.replace("2026-08-17", "2026-08-18");

/** Fixture do run REAL medido em produção (09/09/2026, achado da issue) —
 *  renovação do access token respondeu HTTP 502 não-JSON. Classificado
 *  `failureClass: "transient"` por `classifyGoogleAdsFailure` (não bate
 *  nenhum `DEFECT_MARKERS`/`AUTH_PENDING_MARKERS` de
 *  `scripts/lib/google-ads-ingest.ts`) — então NUNCA carrega o texto
 *  "✖ DEFEITO", só "fallback pro CSV manual". Regressão exigida pela issue:
 *  isto tem que alarmar como defeito, não como no-run (o bug original era
 *  o alarme nunca ler NENHUM dos dois, então nunca ver nem isto). */
const GOOGLE_FALLBACK_502_RUN =
  "\n===== 2026-09-09T12:50:00.000Z - ingestao diaria de gasto do Google Ads (GAQL) para data/aquisicao/spend.csv =====\n" +
  "----- ingest -----\n" +
  "[google-ads-ingest-spend] fallback pro CSV manual — renovação do access token respondeu não-JSON (HTTP 502)\n" +
  "  spend.csv não foi alterado. Editar manualmente ou rodar seed-spend-csv.ts se necessário.\n" +
  "===== fim (ingest=0) =====\n";

const MICROSOFT_OK_RUN =
  "\n===== 2026-08-17T09:52:00.000Z - ingestao diaria de gasto do Microsoft Ads (Reporting API) para data/aquisicao/spend.csv =====\n" +
  "----- ingest -----\n" +
  "[microsoft-ads-ingest-spend] ✔ data/aquisicao/spend.csv atualizado via identidade Google (12 linha(s) de relatório agregadas).\n" +
  "===== fim (ingest=0) =====\n";

function input(logPath: string, exists: boolean, content: string | null): PlatformLogInput {
  return { logPath, exists, content };
}

describe("parseLatestLogRun", () => {
  it("log null → null", () => {
    assert.equal(parseLatestLogRun(null), null);
  });

  it("log vazio → null", () => {
    assert.equal(parseLatestLogRun(""), null);
  });

  it("log sem cabeçalho reconhecível → null (formato inesperado, fail-toward-cannot-verify)", () => {
    assert.equal(parseLatestLogRun("algum texto solto sem cabeçalho ====="), null);
  });

  it("1 run → extrai o texto inteiro e o timestamp do cabeçalho", () => {
    const result = parseLatestLogRun(GOOGLE_OK_RUN);
    assert.ok(result);
    assert.equal(result!.startedAt, "2026-08-17T09:50:00.000Z");
    assert.match(result!.text, /Google Ads/);
    assert.match(result!.text, /fim \(ingest=0\)/);
  });

  it("múltiplos runs concatenados → extrai só o ÚLTIMO", () => {
    const first =
      "\n===== 2026-08-15T09:50:00.000Z - ingestao diaria de gasto do Google Ads (GAQL) para data/aquisicao/spend.csv =====\n" +
      "conteúdo do dia 15, não deveria aparecer no resultado\n" +
      "===== fim (ingest=0) =====\n";
    const combined = first + GOOGLE_OK_RUN;
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

describe("evaluateSinglePlatformLog — tri-state honesto por plataforma", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("log ausente → cannot-verify (config errada/task nunca armada), NUNCA no-run", () => {
    const ev = evaluateSinglePlatformLog("google", GOOGLE_LOG_PATH, false, null, NOW);
    assert.equal(ev.verdict, "cannot-verify");
    assert.equal(ev.cannotVerifyReason, "log_missing");
  });

  it("log presente mas sem run reconhecível (vazio/corrompido) → cannot-verify, reason log_unparseable", () => {
    const ev = evaluateSinglePlatformLog("google", GOOGLE_LOG_PATH, true, "", NOW);
    assert.equal(ev.verdict, "cannot-verify");
    assert.equal(ev.cannotVerifyReason, "log_unparseable");
  });

  it("log presente sem run de HOJE → no-run", () => {
    const yesterdayRun = GOOGLE_OK_RUN.replace("2026-08-17", "2026-08-16");
    const ev = evaluateSinglePlatformLog("google", GOOGLE_LOG_PATH, true, yesterdayRun, NOW);
    assert.equal(ev.verdict, "no-run");
  });

  it("run de HOJE limpo → ok", () => {
    const ev = evaluateSinglePlatformLog("google", GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN, NOW);
    assert.equal(ev.verdict, "ok");
  });

  it("run de HOJE com '✖ DEFEITO' → defect", () => {
    const ev = evaluateSinglePlatformLog("google", GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN, NOW);
    assert.equal(ev.verdict, "defect");
  });

  it("run REAL do dia (fallback 502, sem '✖ DEFEITO' literal) → defect, não ok (regressão #7518)", () => {
    const ev = evaluateSinglePlatformLog(
      "google",
      GOOGLE_LOG_PATH,
      true,
      GOOGLE_FALLBACK_502_RUN.replace("2026-09-09", NOW.toISOString().slice(0, 10)),
      NOW,
    );
    assert.equal(ev.verdict, "defect");
  });
});

describe("evaluateAdsSpendIngestAlarm — composição do veredito combinado", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("as 2 plataformas ok → combinado ok", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    assert.equal(ev.verdict, "ok");
  });

  it("os 2 logs ausentes → cannot-verify, NUNCA no-run (o bug original desta issue)", () => {
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, false, null), input(MICROSOFT_LOG_PATH, false, null), NOW);
    assert.equal(ev.verdict, "cannot-verify");
  });

  it("1 log ausente + outro ok → cannot-verify (nunca reporta ok sem ter olhado as 2)", () => {
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN), input(MICROSOFT_LOG_PATH, false, null), NOW);
    assert.equal(ev.verdict, "cannot-verify");
  });

  it("1 plataforma defect + outra ok → combinado alarm-defect (defeito confirmado sempre vence)", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    assert.equal(ev.verdict, "alarm-defect");
  });

  it("1 plataforma defect + outra cannot-verify → alarm-defect (defeito vence estado desconhecido)", () => {
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN), input(MICROSOFT_LOG_PATH, false, null), NOW);
    assert.equal(ev.verdict, "alarm-defect");
  });

  it("1 plataforma no-run + outra ok, nenhuma cannot-verify/defect → alarm-no-run", () => {
    const yesterdayRun = MICROSOFT_OK_RUN.replace("2026-08-17", "2026-08-16");
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN), input(MICROSOFT_LOG_PATH, true, yesterdayRun), NOW);
    assert.equal(ev.verdict, "alarm-no-run");
  });

  it("run REAL do dia (fallback 502) numa plataforma, outra ok → combinado alarm-defect, não alarm-no-run", () => {
    const todayFallback = GOOGLE_FALLBACK_502_RUN.replace("2026-09-09", "2026-08-17");
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, true, todayFallback), input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN), NOW);
    assert.equal(ev.verdict, "alarm-defect");
  });
});

describe("isAlarmingVerdict", () => {
  it("ok e cannot-verify → false (cannot-verify é fail-soft do próprio alarme); alarm-defect/alarm-no-run → true", () => {
    assert.equal(isAlarmingVerdict("ok"), false);
    assert.equal(isAlarmingVerdict("cannot-verify"), false);
    assert.equal(isAlarmingVerdict("alarm-defect"), true);
    assert.equal(isAlarmingVerdict("alarm-no-run"), true);
  });
});

describe("shouldSendAdsSpendIngestAlarm — idempotência por dia", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("verdict ok nunca alarma", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, emptyAdsSpendIngestAlarmState(), NOW), false);
  });

  it("verdict cannot-verify nunca alarma", () => {
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, false, null), input(MICROSOFT_LOG_PATH, false, null), NOW);
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, emptyAdsSpendIngestAlarmState(), NOW), false);
  });

  it("1ª detecção do dia alarma", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, emptyAdsSpendIngestAlarmState(), NOW), true);
  });

  it("já alarmado HOJE não reenvia", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    const state = markAdsSpendIngestAlarmed(NOW);
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, state, NOW), false);
  });

  it("dia seguinte com o mesmo defeito reenvia (dedup é por dia, não por conteúdo)", () => {
    const state = markAdsSpendIngestAlarmed(NOW);
    const tomorrow = new Date("2026-08-18T20:00:00.000Z");
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN_NEXT_DAY),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN.replace("2026-08-17", "2026-08-18")),
      tomorrow,
    );
    assert.equal(shouldSendAdsSpendIngestAlarm(ev, state, tomorrow), true);
  });
});

describe("buildAdsSpendIngestAlarmEmail", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("alarm-defect: assunto/corpo mencionam DEFEITO e citam os logPaths", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    const { subject, body } = buildAdsSpendIngestAlarmEmail(ev, "");
    assert.match(subject, /DEFEITO/);
    assert.match(body, new RegExp(GOOGLE_LOG_PATH.replace(/[/.]/g, "\\$&")));
    assert.match(body, /DEFEITO/);
  });

  it("alarm-no-run: assunto/corpo mencionam ausência de execução", () => {
    const yesterdayRun = MICROSOFT_OK_RUN.replace("2026-08-17", "2026-08-16");
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN), input(MICROSOFT_LOG_PATH, true, yesterdayRun), NOW);
    const { subject, body } = buildAdsSpendIngestAlarmEmail(ev, "");
    assert.match(subject, /nenhuma execução/);
    assert.match(body, /systemctl/);
  });

  it("inclui issueLines quando fornecido", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    const { body } = buildAdsSpendIngestAlarmEmail(ev, "\n\nIssues:\n  - #999 (https://x)");
    assert.match(body, /#999/);
  });
});

describe("toAlarmFinding", () => {
  const NOW = new Date("2026-08-17T20:00:00.000Z");

  it("family 'estado', priority P1 pra defeito real", () => {
    const ev = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    const f = toAlarmFinding(ev);
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P1");
    assert.equal(f.check, "ads-spend-ingest");
  });

  it("priority P2 pra 'nenhuma execução hoje' — menos grave que defeito confirmado", () => {
    const yesterdayRun = MICROSOFT_OK_RUN.replace("2026-08-17", "2026-08-16");
    const ev = evaluateAdsSpendIngestAlarm(input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN), input(MICROSOFT_LOG_PATH, true, yesterdayRun), NOW);
    const f = toAlarmFinding(ev);
    assert.equal(f.priority, "P2");
  });

  it("fingerprint distingue defect de no-run, mas cada um é fixo (nunca varia por timestamp/plataforma) — family 'estado' precisa disso pro auto-close por streak", () => {
    const defectEv = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN),
      NOW,
    );
    const noRunEv = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN.replace("2026-08-17", "2026-08-16")),
      NOW,
    );
    const defectFinding = toAlarmFinding(defectEv);
    const noRunFinding = toAlarmFinding(noRunEv);
    assert.notEqual(defectFinding.fingerprint, noRunFinding.fingerprint);
    assert.equal(noRunFinding.fingerprint, "no-run");
    assert.equal(defectFinding.fingerprint, "defect");

    // Duas execuções em dias diferentes com o MESMO tipo de defeito devem
    // produzir o MESMO fingerprint — senão cada dia com defeito abre uma
    // issue nova em vez de acumular streak pro auto-close (mesmo padrão de
    // `clarice-envio-alarm.ts` pros achados family "estado").
    const defectEvNextDay = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_DEFECT_RUN_NEXT_DAY),
      input(MICROSOFT_LOG_PATH, true, MICROSOFT_OK_RUN.replace("2026-08-17", "2026-08-18")),
      new Date("2026-08-18T20:00:00.000Z"),
    );
    assert.equal(toAlarmFinding(defectEvNextDay).fingerprint, defectFinding.fingerprint);

    // Defeito na OUTRA plataforma (Microsoft, não Google) deve produzir o
    // MESMO fingerprint "defect" — o streak/auto-close é por TIPO de
    // achado, não por qual plataforma falhou.
    const defectMicrosoftEv = evaluateAdsSpendIngestAlarm(
      input(GOOGLE_LOG_PATH, true, GOOGLE_OK_RUN),
      input(
        MICROSOFT_LOG_PATH,
        true,
        MICROSOFT_OK_RUN.replace("✔ data/aquisicao/spend.csv atualizado via identidade Google", "✖ DEFEITO na ingestão — não indisponibilidade"),
      ),
      NOW,
    );
    assert.equal(toAlarmFinding(defectMicrosoftEv).fingerprint, "defect");
  });
});
