/**
 * test/onboarding-continuity-kit-transport-7922.test.ts (#7922, §3 de
 * docs/onboarding-kit-cutover.md — "Alarme de continuidade (#7839)
 * confirmado operante para o novo transporte, não só para o Brevo")
 *
 * Regressão #7922: o alarme de continuidade só lia a streak de DETECÇÃO
 * (`consecutive_zero_detections`, alimentada por `onboarding-welcome-run.ts`)
 * e o texto falava em "Brevo transacional". Com o Kit ativo, a detecção
 * continua saudável mesmo se o executor Kit parar de criar os broadcasts —
 * e ninguém recebe o e-mail 1/2. Regressões cobertas:
 *   1. o transporte ativo é derivado de `onboarding.kit_transport.enabled`
 *      e nomeado no e-mail;
 *   2. o executor Kit grava `kit_transport.last_send_run` +
 *      `consecutive_failed_send_runs` (`recordKitSendRun`/`stampKitSendRun`)
 *      sem apagar lotes/entries, e o `readStore` não descarta esses campos;
 *   3. tri-state honesto (#7776) da saúde do Kit: nunca `ok` sem rodada
 *      `--send` registrada e fresca — com o switch ligado, rodada ausente ou
 *      parada é ACHADO (issue + e-mail), não só log;
 *   4. um check em `cannot-verify` não conta como "resolvido" — não fecha a
 *      issue aberta dele (`planEvaluatedChecks`/`reconcileEvaluatedChecks`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveActiveOnboardingTransport,
  evaluateKitTransportHealth,
  evaluateOnboardingContinuity,
  buildOnboardingContinuityAlarmEmail,
  buildKitTransportAlarmEmail,
  KIT_SEND_FAILURE_ALARM_THRESHOLD_RUNS,
  RUN_FRESHNESS_MAX_HORAS,
  ZERO_DETECTION_ALARM_THRESHOLD_RUNS,
} from "../scripts/lib/onboarding-continuity-alarm.ts";
import { recordKitSendRun, isFailedKitSendRun, type OnboardingKitLot, type KitSendRunRecord } from "../scripts/lib/onboarding-kit-transport.ts";
import { readStore, writeStore, emptyStore } from "../scripts/lib/onboarding-store.ts";
import { stampKitSendRun } from "../scripts/onboarding-kit-transport-run.ts";
import {
  planEvaluatedChecks,
  reconcileEvaluatedChecks,
  buildContinuityAlarmMessage,
  toKitTransportAlarmFinding,
  toAlarmFinding,
  readKitTransportEnabled,
  evaluateContinuityRound,
  DETECTION_CHECK,
  KIT_TRANSPORT_CHECK,
} from "../scripts/onboarding-continuity-alarm.ts";
import type { AlarmIssuesState, AlarmFindingOutcome, GhRunFn } from "../scripts/lib/alarm-issues.ts";

const NOW = new Date("2026-10-01T12:10:00Z");
const FRESH = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
const OLD = new Date(NOW.getTime() - (RUN_FRESHNESS_MAX_HORAS + 1) * 3_600_000).toISOString();

/** Registro de rodada completo (todos os campos obrigatórios). */
function rec(o: Partial<KitSendRunRecord> = {}): KitSendRunRecord {
  return { at: FRESH, lots_created: 0, lots_failed: 0, refresh_candidates: 0, refresh_failed: 0, content_skipped: 0, ...o };
}

function lot(overrides: Partial<OnboardingKitLot> = {}): OnboardingKitLot {
  return {
    lot_id: "email1-2026-09-30-01",
    kind: "email1",
    tag_name: "onboarding-email1-2026-09-30-01",
    tag_id: 1,
    broadcast_id: 777,
    recipient_subscription_ids: ["1"],
    recipient_emails: ["a@example.com"],
    status: "completed",
    created_at: "2026-09-30T12:05:00.000Z",
    send_at: "2026-09-30T12:06:00.000Z",
    last_reconciled_at: null,
    last_error: null,
    ...overrides,
  };
}

describe("#7922 — transporte ativo derivado do kill switch", () => {
  it("só `true` literal liga o Kit", () => {
    assert.equal(resolveActiveOnboardingTransport(true), "kit");
    assert.equal(resolveActiveOnboardingTransport(false), "brevo");
    assert.equal(resolveActiveOnboardingTransport(undefined), "brevo");
    assert.equal(resolveActiveOnboardingTransport("true"), "brevo");
  });

  it("readKitTransportEnabled: lê o switch e não lança com config ilegível", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuity-kit-cfg-"));
    try {
      const ok = join(dir, "ok.json");
      writeFileSync(ok, JSON.stringify({ onboarding: { kit_transport: { enabled: true } } }));
      assert.deepEqual(readKitTransportEnabled(ok), { enabled: true, error: null });
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ não é json");
      const r = readKitTransportEnabled(bad);
      assert.equal(r.enabled, undefined);
      assert.ok(r.error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("e-mail de detecção nomeia o transporte ativo (antes dizia sempre 'Brevo transacional')", () => {
    const ev = evaluateOnboardingContinuity(true, false, ZERO_DETECTION_ALARM_THRESHOLD_RUNS, undefined, FRESH, NOW);
    const kit = buildOnboardingContinuityAlarmEmail(ev, "", "kit").body;
    assert.match(kit, /transporte de envio ativo: Kit/);
    assert.match(kit, /onboarding-kit-transport-run\.ts/);
    const brevo = buildOnboardingContinuityAlarmEmail(ev, "").body;
    assert.match(brevo, /transporte de envio ativo: Brevo transacional/);
  });
});

describe("#7922 — executor Kit alimenta o sinal (recordKitSendRun / stampKitSendRun)", () => {
  it("streak incrementa com lote falho e zera numa rodada limpa", () => {
    const kt: { last_send_run?: KitSendRunRecord | null; consecutive_failed_send_runs?: number } = {};
    recordKitSendRun(kt, rec({ at: "2026-09-29T12:05:00Z", lots_created: 0, lots_failed: 1 }));
    assert.equal(kt.consecutive_failed_send_runs, 1);
    recordKitSendRun(kt, rec({ at: "2026-09-30T12:05:00Z", lots_created: 0, lots_failed: 2 }));
    assert.equal(kt.consecutive_failed_send_runs, 2);
    assert.deepEqual(kt.last_send_run, rec({ at: "2026-09-30T12:05:00Z", lots_created: 0, lots_failed: 2 }));
    recordKitSendRun(kt, rec({ at: "2026-10-01T12:05:00Z", lots_created: 3, lots_failed: 0 }));
    assert.equal(kt.consecutive_failed_send_runs, 0);
  });

  it("Kit fora do ar (refresh de TODOS os candidatos falhou, 0 lotes tentados) conta como falha; falha parcial não", () => {
    assert.equal(isFailedKitSendRun(rec({ at: FRESH, lots_created: 0, lots_failed: 0, refresh_candidates: 3, refresh_failed: 3 })), true);
    assert.equal(isFailedKitSendRun(rec({ at: FRESH, lots_created: 1, lots_failed: 0, refresh_candidates: 3, refresh_failed: 1 })), false);
    assert.equal(isFailedKitSendRun(rec({ at: FRESH, lots_created: 0, lots_failed: 0, refresh_candidates: 0, refresh_failed: 0 })), false);
    assert.equal(isFailedKitSendRun({ at: FRESH, lots_created: 0, lots_failed: 0 } as KitSendRunRecord), false, "registro antigo sem os campos novos");
    assert.equal(isFailedKitSendRun(rec({ aborted: true, error: "x" })), true, "rodada abortada é falha");
    assert.equal(isFailedKitSendRun(rec({ content_skipped: 1 })), true, "snippet ausente/pendente é falha (e-mail não sai)");
    const kt: { consecutive_failed_send_runs?: number } = {};
    recordKitSendRun(kt, rec({ at: FRESH, lots_created: 0, lots_failed: 0, refresh_candidates: 2, refresh_failed: 2 }));
    assert.equal(kt.consecutive_failed_send_runs, 1);
  });

  it("readStore preserva last_send_run/consecutive_failed_send_runs (regressão #7922: normalizava kit_transport só pra { lots })", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuity-kit-store-"));
    try {
      const p = join(dir, "store.json");
      const s = emptyStore();
      s.kit_transport = { lots: { [lot().lot_id]: lot() }, last_send_run: rec({ at: FRESH, lots_created: 1, lots_failed: 0 }), consecutive_failed_send_runs: 0 };
      writeStore(s, p);
      const back = readStore(p).store.kit_transport!;
      assert.deepEqual(back.last_send_run, rec({ at: FRESH, lots_created: 1, lots_failed: 0 }));
      assert.equal(back.consecutive_failed_send_runs, 0);
      // Store anterior ao campo: nada fabricado.
      writeFileSync(p, JSON.stringify({ version: 1, entries: {}, kit_transport: { lots: {} } }));
      const legacy = readStore(p).store.kit_transport!;
      assert.equal("last_send_run" in legacy, false);
      assert.equal("consecutive_failed_send_runs" in legacy, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stampKitSendRun grava sob lock sem apagar lotes nem entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuity-kit-stamp-"));
    try {
      const p = join(dir, "store.json");
      const s = emptyStore();
      s.consecutive_zero_detections = 1;
      s.last_zero_detection_run_at = FRESH;
      s.entries["1"] = {
        subscription_id: "1",
        email: "a@example.com",
        status_detectado: "active",
        created_at: 1,
        detected_at: FRESH,
        email1_sent_at: FRESH,
        email1_brevo_id: null,
        email2_sent_at: null,
        email2_brevo_id: null,
        email3_state: "pending",
        email3_campaign_id: null,
        email3_decided_at: null,
      };
      s.kit_transport = { lots: { [lot().lot_id]: lot() } };
      writeStore(s, p);
      stampKitSendRun(p, rec({ at: FRESH, lots_created: 0, lots_failed: 1 }));
      stampKitSendRun(p, rec({ at: FRESH, lots_created: 0, lots_failed: 1 }));
      const back = readStore(p).store;
      assert.equal(back.kit_transport!.consecutive_failed_send_runs, 2);
      assert.deepEqual(back.kit_transport!.lots[lot().lot_id], lot());
      assert.equal(back.entries["1"]!.email1_sent_at, FRESH);
      // Campos do executor Brevo intocados.
      assert.equal(back.consecutive_zero_detections, 1);
      assert.equal(back.last_zero_detection_run_at, FRESH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stampKitSendRun recusa store corrompido sem sobrescrevê-lo", () => {
    const dir = mkdtempSync(join(tmpdir(), "continuity-kit-stamp-bad-"));
    try {
      const p = join(dir, "store.json");
      writeFileSync(p, "{ corrompido");
      assert.throws(() => stampKitSendRun(p, rec({ at: FRESH, lots_created: 0, lots_failed: 0 })), /CORROMPIDO/);
      assert.equal(readFileSync(p, "utf8"), "{ corrompido");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#7922 — evaluateKitTransportHealth (tri-state honesto, #7776)", () => {
  it("store ausente/corrompido → cannot-verify", () => {
    assert.equal(evaluateKitTransportHealth(false, false, undefined, undefined, NOW).cannotVerifyReason, "store_missing");
    assert.equal(evaluateKitTransportHealth(true, true, undefined, undefined, NOW).cannotVerifyReason, "store_corrupted");
  });

  it("transporte Kit ativo sem nenhuma rodada --send registrada → ACHADO (stale/rodada_ausente), NUNCA ok", () => {
    const ev = evaluateKitTransportHealth(true, false, {}, undefined, NOW);
    assert.equal(ev.verdict, "stale");
    assert.equal(ev.staleReason, "rodada_ausente");
    assert.equal(ev.cannotVerifyReason, null);
  });

  it("última rodada --send além do teto de frescor → ACHADO (stale/rodada_parada), mesmo com streak 0", () => {
    const ev = evaluateKitTransportHealth(true, false, { last_send_run: rec({ at: OLD, lots_created: 2, lots_failed: 0 }), consecutive_failed_send_runs: 0 }, undefined, NOW);
    assert.equal(ev.verdict, "stale");
    assert.equal(ev.staleReason, "rodada_parada");
  });

  it("timestamp ilegível → tratado como rodada ausente (achado), nunca fresco", () => {
    const ev = evaluateKitTransportHealth(true, false, { last_send_run: rec({ at: "ontem", lots_created: 0, lots_failed: 0 }) }, undefined, NOW);
    assert.equal(ev.staleReason, "rodada_ausente");
  });

  it("rodada fresca, 1 falha (abaixo do limiar) → ok; no limiar → stale", () => {
    const ok = evaluateKitTransportHealth(true, false, { last_send_run: rec({ at: FRESH, lots_created: 0, lots_failed: 1 }), consecutive_failed_send_runs: 1 }, undefined, NOW);
    assert.equal(ok.verdict, "ok");
    const stale = evaluateKitTransportHealth(
      true,
      false,
      { last_send_run: rec({ at: FRESH, lots_created: 0, lots_failed: 1 }), consecutive_failed_send_runs: KIT_SEND_FAILURE_ALARM_THRESHOLD_RUNS },
      undefined,
      NOW,
    );
    assert.equal(stale.verdict, "stale");
    assert.equal(stale.consecutiveFailedRuns, KIT_SEND_FAILURE_ALARM_THRESHOLD_RUNS);
    const { subject, body } = buildKitTransportAlarmEmail(stale, "\n\nIssues:\n  - #1 (u)");
    assert.match(subject, /transporte Kit/);
    assert.match(body, /onboarding-kit-transport-run\.ts/);
    assert.match(body, /e-mail 3/, "cita também o rascunho do e-mail 3");
    assert.match(body, /#1/);
  });
});

describe("#7922 — reconciliação de issues só sobre checks avaliados", () => {
  const state: AlarmIssuesState = {
    [`${KIT_TRANSPORT_CHECK}:kit-send-failure-streak`]: { issueNumber: 50, url: "u50", missingStreak: 0, closedAt: null, family: "estado" },
    [`${DETECTION_CHECK}:zero-detection-streak`]: { issueNumber: 40, url: "u40", missingStreak: 0, closedAt: null, family: "estado" },
  };

  it("check Kit em cannot-verify: a issue aberta dele NÃO avança pra 'resolvido'", () => {
    const actions = planEvaluatedChecks([], state, new Set([DETECTION_CHECK]), 2);
    assert.deepEqual(
      actions.map((a) => ("key" in a ? a.key : a.kind)),
      [`${DETECTION_CHECK}:zero-detection-streak`],
      "só a issue da detecção (avaliada, sem achado) deve receber ação",
    );
  });

  it("check Kit avaliado e saudável: a issue dele começa a resolver", () => {
    const actions = planEvaluatedChecks([], state, new Set([DETECTION_CHECK, KIT_TRANSPORT_CHECK]), 2);
    assert.equal(actions.length, 2);
    assert.ok(actions.every((a) => a.kind === "comment_resolved"));
  });

  it("reconcileEvaluatedChecks preserva byte a byte a entrada do check não avaliado", () => {
    const calls: string[][] = [];
    const run: GhRunFn = (args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" } as ReturnType<GhRunFn>;
    };
    const { nextState } = reconcileEvaluatedChecks([], state, new Set([DETECTION_CHECK]), { cwd: ".", closeAfterRuns: 2, run, now: NOW });
    assert.deepEqual(nextState[`${KIT_TRANSPORT_CHECK}:kit-send-failure-streak`], state[`${KIT_TRANSPORT_CHECK}:kit-send-failure-streak`]);
    assert.equal(nextState[`${DETECTION_CHECK}:zero-detection-streak`]!.missingStreak, 1);
    assert.ok(calls.every((c) => !c.join(" ").includes("50")), "nenhuma chamada gh deve tocar a issue #50 do check não avaliado");
  });

  it("achado do Kit tem check/fingerprint próprios (issue separada da detecção)", () => {
    const kitEv = evaluateKitTransportHealth(true, false, { last_send_run: rec({ at: FRESH, lots_created: 0, lots_failed: 1 }), consecutive_failed_send_runs: 2 }, undefined, NOW);
    const detEv = evaluateOnboardingContinuity(true, false, 5, undefined, FRESH, NOW);
    const kf = toKitTransportAlarmFinding(kitEv);
    const df = toAlarmFinding(detEv);
    assert.equal(kf.check, KIT_TRANSPORT_CHECK);
    assert.equal(df.check, DETECTION_CHECK);
    assert.notEqual(kf.fingerprint, df.fingerprint);
  });

  it("e-mail combina as duas seções quando os dois checks qualificam", () => {
    const kitEv = evaluateKitTransportHealth(true, false, { last_send_run: rec({ at: FRESH, lots_created: 0, lots_failed: 1 }), consecutive_failed_send_runs: 2 }, undefined, NOW);
    const detEv = evaluateOnboardingContinuity(true, false, 5, undefined, FRESH, NOW);
    const outcomes = [
      { check: DETECTION_CHECK, fingerprint: "zero-detection-streak", action: "created", issueNumber: 40, url: "u40" },
      { check: KIT_TRANSPORT_CHECK, fingerprint: "kit-send-failure-streak", action: "created", issueNumber: 50, url: "u50" },
    ] as unknown as AlarmFindingOutcome[];
    const both = buildContinuityAlarmMessage(outcomes, detEv, kitEv, "kit");
    assert.match(both.subject, /detecção E transporte Kit/);
    assert.match(both.body, /#40/);
    assert.match(both.body, /#50/);
    const onlyKit = buildContinuityAlarmMessage([outcomes[1]!], detEv, kitEv, "kit");
    assert.match(onlyKit.subject, /transporte Kit do onboarding não está entregando/);
    assert.doesNotMatch(onlyKit.body, /#40/);
  });
});

describe("#7922 — evaluateContinuityRound (decisão da rodada, sem I/O)", () => {
  const healthyDetection = { consecutive_zero_detections: 0, last_zero_detection_run_at: FRESH };

  it("transporte BREVO: check Kit não é avaliado, mas entra na reconciliação SEM achado (issue Kit aberta fecha no rollback)", () => {
    const r = evaluateContinuityRound({
      storeExists: true,
      corrupted: false,
      store: { ...healthyDetection, kit_transport: { lots: {} } },
      cfgRead: { enabled: false, error: null },
      now: NOW,
    });
    assert.equal(r.transport, "brevo");
    assert.equal(r.kitEvaluation, null);
    assert.ok(r.evaluatedChecks.has(KIT_TRANSPORT_CHECK));
    assert.equal(r.findings.length, 0);
  });

  it("transporte KIT sem rodada registrada: achado próprio (executor não roda), fingerprint distinto do de falhas", () => {
    const r = evaluateContinuityRound({
      storeExists: true,
      corrupted: false,
      store: { ...healthyDetection, kit_transport: { lots: {} } },
      cfgRead: { enabled: true, error: null },
      now: NOW,
    });
    assert.equal(r.transport, "kit");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]!.check, KIT_TRANSPORT_CHECK);
    assert.equal(r.findings[0]!.fingerprint, "kit-send-run-stalled");
    const failing = evaluateContinuityRound({
      storeExists: true,
      corrupted: false,
      store: { ...healthyDetection, kit_transport: { lots: {}, last_send_run: rec({ lots_failed: 1 }), consecutive_failed_send_runs: 2 } },
      cfgRead: { enabled: true, error: null },
      now: NOW,
    });
    assert.equal(failing.findings[0]!.fingerprint, "kit-send-failure-streak");
  });

  it("transporte KIT saudável: avaliado, sem achado", () => {
    const r = evaluateContinuityRound({
      storeExists: true,
      corrupted: false,
      store: { ...healthyDetection, kit_transport: { lots: {}, last_send_run: rec({ lots_created: 2 }), consecutive_failed_send_runs: 0 } },
      cfgRead: { enabled: true, error: null },
      now: NOW,
    });
    assert.equal(r.kitEvaluation!.verdict, "ok");
    assert.ok(r.evaluatedChecks.has(KIT_TRANSPORT_CHECK));
    assert.equal(r.findings.length, 0);
  });

  it("config ILEGÍVEL: transporte 'desconhecido' — check Kit fora da reconciliação, e-mail não rotula Brevo", () => {
    const r = evaluateContinuityRound({
      storeExists: true,
      corrupted: false,
      store: { consecutive_zero_detections: 5, last_zero_detection_run_at: FRESH, kit_transport: { lots: {} } },
      cfgRead: { enabled: undefined, error: "Unexpected token" },
      now: NOW,
    });
    assert.equal(r.transport, "desconhecido");
    assert.equal(r.evaluatedChecks.has(KIT_TRANSPORT_CHECK), false);
    const outcomes = [{ check: DETECTION_CHECK, fingerprint: "zero-detection-streak", action: "created", issueNumber: 40, url: "u40" }] as unknown as AlarmFindingOutcome[];
    const { body } = buildContinuityAlarmMessage(outcomes, r.evaluation, r.kitEvaluation, r.transport);
    assert.match(body, /transporte de envio ativo: desconhecido/);
    assert.doesNotMatch(body, /Brevo transacional/);
  });

  it("store ilegível com Kit ativo: nenhum check avaliado (nem alarma, nem fecha)", () => {
    const r = evaluateContinuityRound({
      storeExists: true,
      corrupted: true,
      store: { kit_transport: { lots: {} } },
      cfgRead: { enabled: true, error: null },
      now: NOW,
    });
    assert.equal(r.evaluatedChecks.size, 0);
    assert.equal(r.findings.length, 0);
  });
});
