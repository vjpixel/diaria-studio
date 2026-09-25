/**
 * Testes (#8555): lote de confirmação DOI -> Google Ads (ECL via Data Manager API).
 *
 * Nenhum teste toca a Google Ads/Data Manager API: `sendFn`/`fetch` são
 * sempre mocks e o índice de idempotência vive num diretório temporário.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractGclid,
  isOutOfWindow,
  pickBaseSnapshotDate,
  runConfirmationBatch,
  selectConfirmationCandidates,
  loadConfirmationIndex,
  assessBaseSnapshot,
  toBrtIso,
  indexKey,
  MAX_FAILED_ATTEMPTS,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import {
  authConfigFromEnv,
  sendDataManagerIngest,
  type DataManagerEvent,
  type DataManagerIngestResult,
} from "../scripts/lib/google-data-manager-sender.ts";
import { hashEmailForEnhancedConversions } from "../scripts/lib/google-ads-enhanced-conversions.ts";
import { main as confirmMain, actionIdOf } from "../scripts/upload-google-ads-confirmations.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";

const NOW = new Date("2026-09-20T15:00:00Z");
const BASE_DATE = "2026-09-18";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "gads-confirm-8555-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const r = fn(dir);
    if (r instanceof Promise) return r.finally(cleanup);
    cleanup();
    return r;
  } catch (e) {
    cleanup();
    throw e;
  }
}

function sub(id: number, over: Partial<ConfirmationRosterEntry> = {}): ConfirmationRosterEntry {
  return {
    id,
    email_address: `leitor${id}@example.com`,
    state: "active",
    created_at: "2026-09-18T12:00:00Z",
    ...over,
  };
}
const base = (id: number, state = "inactive"): SubscriberStateRecord => ({ id, state, created_at: "2026-09-18T12:00:00Z" });

const okSend = () => mock.fn(async (_events: DataManagerEvent[]): Promise<DataManagerIngestResult> => ({ ok: true, requestId: "req-1", response: {} }));
/** Falha com resposta HTTP REAL do Google (não-2xx) — conta tentativa (`countsAsAttempt: true`). */
const failSend = (error = "HTTP 500") =>
  mock.fn(async (_events: DataManagerEvent[]): Promise<DataManagerIngestResult> => ({ ok: false, stage: "ingest", error, countsAsAttempt: true }));
/** Falha de TRANSPORTE (rede, env/token ausente, 2xx anômalo) — nunca conta tentativa. */
const transportFailSend = (error = "falha de rede") =>
  mock.fn(async (_events: DataManagerEvent[]): Promise<DataManagerIngestResult> => ({ ok: false, stage: "ingest", error, countsAsAttempt: false }));

describe("#8555 — detecção de confirmações", () => {
  it("inactive na base + active hoje = confirmação; já active na base não é", () => {
    const { candidates: c } = selectConfirmationCandidates([sub(1), sub(2), sub(3, { state: "inactive" })], [base(1), base(2, "active"), base(3)], BASE_DATE);
    assert.deepEqual(c.map((x) => x.id), [1]);
    assert.equal(c[0].path, "kit-email");
  });

  it("caminho botão Brevo (confirmou_via) é detectado e rotulado", () => {
    const { candidates: c } = selectConfirmationCandidates([sub(1, { fields: { confirmou_via: "brevo-reativar" } })], [base(1)], BASE_DATE);
    assert.equal(c[0].path, "brevo-botao");
  });

  it("ausente da base + active + cadastrado DEPOIS do snapshot base sobe como ambíguo (não some)", () => {
    const { candidates, skippedNoBase } = selectConfirmationCandidates([sub(1, { created_at: "2026-09-19T12:00:00Z" })], [], BASE_DATE);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].ambiguous, true);
    assert.equal(skippedNoBase, 0);
  });

  it("ausente da base + cadastrado ANTES dela é anomalia contada; confirmou_via promove", () => {
    const r = selectConfirmationCandidates(
      [sub(1, { created_at: "2026-08-01T12:00:00Z" }), sub(2, { created_at: "2026-08-01T12:00:00Z", fields: { confirmou_via: "brevo-reativar" } })],
      [],
      BASE_DATE,
    );
    assert.deepEqual(r.candidates.map((x) => x.id), [2]);
    assert.equal(r.skippedNoBase, 1);
  });

  it("base cancelled/bounced -> active NÃO é confirmação DOI", () => {
    const { candidates } = selectConfirmationCandidates([sub(1), sub(2)], [base(1, "cancelled"), base(2, "bounced")], BASE_DATE);
    assert.equal(candidates.length, 0);
  });

  it("#8616 item 5: candidato carrega clickId cru (origem_click_id), independente do prefixo — o lote da Meta reusa esta detecção", () => {
    const { candidates: withFb } = selectConfirmationCandidates([sub(1, { fields: { origem_click_id: "fbclid:ABC" } })], [base(1)], BASE_DATE);
    assert.equal(withFb[0].clickId, "fbclid:ABC");
    const { candidates: withGc } = selectConfirmationCandidates([sub(2, { fields: { origem_click_id: "gclid:XYZ" } })], [base(2)], BASE_DATE);
    assert.equal(withGc[0].clickId, "gclid:XYZ");
    const { candidates: none } = selectConfirmationCandidates([sub(3)], [base(3)], BASE_DATE);
    assert.equal(none[0].clickId, undefined);
  });

  it("extractGclid só aceita o prefixo gclid:", () => {
    assert.equal(extractGclid({ origem_click_id: "gclid:ABC" }), "ABC");
    assert.equal(extractGclid({ origem_click_id: "fbclid:XYZ" }), undefined);
    assert.equal(extractGclid({}), undefined);
    assert.equal(extractGclid(undefined), undefined);
  });

  it("pickBaseSnapshotDate: mais antigo dentro do lookback, nunca hoje; null sem base", () => {
    const dates = ["2026-09-01", "2026-09-15", "2026-09-17", "2026-09-19", "2026-09-20"];
    assert.equal(pickBaseSnapshotDate(dates, "2026-09-20", 7), "2026-09-15");
    assert.equal(pickBaseSnapshotDate(["2026-09-20"], "2026-09-20", 7), null);
    assert.equal(pickBaseSnapshotDate(["2026-08-01"], "2026-09-20", 7), null);
  });

  it("toBrtIso usa offset -03:00", () => {
    assert.equal(toBrtIso(Date.parse("2026-09-20T15:00:00Z")), "2026-09-20T12:00:00-03:00");
  });

  it("isOutOfWindow: 90 dias, e data ilegível conta como fora", () => {
    const now = NOW.getTime();
    assert.equal(isOutOfWindow("2026-06-30T00:00:00Z", now), false); // 82 dias
    assert.equal(isOutOfWindow("2026-06-01T00:00:00Z", now), true); // 111 dias
    assert.equal(isOutOfWindow("lixo", now), true);
  });
});

describe("#8555 — regressão do lote (Data Manager API)", () => {
  it("confirmação SEM gclid SOBE, via hash de e-mail", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath: join(dir, "idx.json"),
        baseDate: BASE_DATE, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 1);
      const events = sendFn.mock.calls[0].arguments[0] as unknown as DataManagerEvent[];
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.equal(ev.adIdentifiers, undefined);
      assert.deepEqual(ev.userData.userIdentifiers, [{ emailAddress: hashEmailForEnhancedConversions("leitor1@example.com") }]);
      assert.equal(ev.transactionId, "diaria-confirmacao-kit-1");
      assert.equal(ev.eventTimestamp, "2026-09-20T12:00:00-03:00");
      assert.equal(ev.eventSource, "WEB");
      assert.equal(summary.sent, 1);
      assert.equal(summary.withGclid, 0);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].requestId, "req-1");
    });
  });

  it("gclid sobe JUNTO com o hash quando existe", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1, { fields: { origem_click_id: "gclid:Cj0K" } })], baseSnapshot: [base(1)],
        indexPath: join(dir, "idx.json"), baseDate: BASE_DATE, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      const events = sendFn.mock.calls[0].arguments[0] as unknown as DataManagerEvent[];
      assert.equal(events[0].adIdentifiers?.gclid, "Cj0K");
      assert.ok(events[0].userData.userIdentifiers.length > 0);
      assert.equal(summary.withGclid, 1);
    });
  });

  it("já enviada (submitted) NÃO reenvia (índice persistido entre rodadas)", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const first = okSend();
      await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        baseDate: BASE_DATE, dryRun: false, sendFn: first, now: NOW, log: () => {},
      });
      assert.equal(loadConfirmationIndex(indexPath)[indexKey(1)].status, "submitted");
      const second = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        baseDate: BASE_DATE, dryRun: false, sendFn: second, now: NOW, log: () => {},
      });
      assert.equal(second.mock.callCount(), 0);
      assert.equal(summary.alreadyIndexed, 1);
      assert.equal(summary.sent, 0);
      // índice não guarda e-mail em claro
      assert.ok(!readFileSync(indexPath, "utf8").includes("example.com"));
    });
  });

  it("fora da janela de 90 dias é REGISTRADA e pulada, nunca some em silêncio", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const logs: string[] = [];
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1, { created_at: "2026-05-01T00:00:00Z" })], baseSnapshot: [base(1)], indexPath,
        baseDate: BASE_DATE, dryRun: false, sendFn, now: NOW, log: (m) => logs.push(m),
      });
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(summary.outOfWindow, 1);
      assert.deepEqual(summary.outOfWindowIds, [1]);
      assert.equal(loadConfirmationIndex(indexPath)[indexKey(1)].status, "skipped-out-of-window");
      assert.ok(logs.some((m) => m.includes("fora da janela") && m.includes("1")));
      // e não volta na rodada seguinte
      const again = await runConfirmationBatch({
        roster: [sub(1, { created_at: "2026-05-01T00:00:00Z" })], baseSnapshot: [base(1)], indexPath,
        baseDate: BASE_DATE, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(again.alreadyIndexed, 1);
      assert.equal(again.outOfWindow, 0);
    });
  });

  it("dry-run: não envia, não grava índice, devolve os eventos", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1), sub(2, { created_at: "2026-05-01T00:00:00Z" })], baseSnapshot: [base(1), base(2)], indexPath,
        baseDate: BASE_DATE, dryRun: true, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(existsSync(indexPath), false);
      assert.equal(summary.events?.length, 1);
      assert.equal(summary.outOfWindow, 1);
    });
  });

  it("persistIndex:false (--validate-only): chama sendFn de verdade, NUNCA grava índice", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        baseDate: BASE_DATE, dryRun: false, persistIndex: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 1);
      assert.equal(summary.sent, 1);
      assert.equal(existsSync(indexPath), false);
    });
  });

  it("falha de envio (chunk inteiro) não marca nada como submetido (reprocessa na próxima)", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const sendFn = failSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        baseDate: BASE_DATE, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(summary.sent, 0);
      assert.equal(summary.failed, 1);
      assert.equal(summary.error, "HTTP 500");
      assert.equal(loadConfirmationIndex(indexPath)[indexKey(1)].status, "failed");
    });
  });

  it("e-mail de teste do editor é descartado e contado", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1, { email_address: "vjpixel+gtm-teste1@gmail.com" })], baseSnapshot: [base(1)],
        indexPath: join(dir, "idx.json"), baseDate: BASE_DATE, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(summary.skippedTestEmails, 1);
    });
  });
});

describe("#8555 — módulo de envio (Data Manager API)", () => {
  it("authConfigFromEnv lista as variáveis ausentes (sem developer token/login customer id)", () => {
    const r = authConfigFromEnv({ GOOGLE_ADS_CLIENT_ID: "a" });
    assert.ok("missing" in r && r.missing.includes("GOOGLE_ADS_REFRESH_TOKEN"));
    assert.ok("missing" in r && !r.missing.includes("GOOGLE_ADS_DEVELOPER_TOKEN" as never));
  });

  it("sendDataManagerIngest sem env não chama a rede", async () => {
    const fetchMock = mock.fn(async () => {
      throw new Error("fetch NÃO deveria ser chamado");
    });
    const r = await sendDataManagerIngest({
      fetchFn: fetchMock as unknown as typeof fetch,
      env: {},
      payload: { destinations: [], encoding: "HEX", validateOnly: true, events: [] },
    });
    assert.equal(r.ok, false);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

const run = (dir: string, over: Partial<Parameters<typeof runConfirmationBatch>[0]>) =>
  runConfirmationBatch({
    roster: [], baseSnapshot: [], baseDate: BASE_DATE, indexPath: join(dir, "idx.json"),
    dryRun: false, sendFn: okSend(), now: NOW, log: () => {}, ...over,
  });

describe("#8555 — revisão: conciliação por id, falhas e índice", () => {
  it("multi-chunk (#8555 fleet review item 3): chunk 1 sucesso, chunk 2 falha — offsets corretos", async () => {
    await withTmp(async (dir) => {
      const roster = [sub(1), sub(2), sub(3)];
      const baseSnapshot = [base(1), base(2), base(3)];
      const calls: DataManagerEvent[][] = [];
      const sendFn = mock.fn(async (events: DataManagerEvent[]): Promise<DataManagerIngestResult> => {
        calls.push(events);
        return calls.length === 1
          ? { ok: true, requestId: "req-chunk1", response: {} }
          : { ok: false, stage: "ingest", error: "chunk 2 recusado", countsAsAttempt: true };
      });
      // chunkSize:2 -> chunk 1 = [id 1, id 2] (sucesso), chunk 2 = [id 3] (falha).
      const summary = await run(dir, { roster, baseSnapshot, sendFn, chunkSize: 2 });
      assert.equal(sendFn.mock.callCount(), 2);
      assert.equal(calls[0].length, 2);
      assert.equal(calls[1].length, 1);
      // offset correto: o evento do chunk 2 é o do id 3, não uma repetição do chunk 1.
      assert.equal(calls[1][0].transactionId, "diaria-confirmacao-kit-3");

      assert.equal(summary.sent, 2);
      assert.equal(summary.failed, 1);
      assert.deepEqual(summary.failedIds, [3]);

      const idx = loadConfirmationIndex(join(dir, "idx.json"));
      assert.equal(idx[indexKey(1)].status, "submitted");
      assert.equal(idx[indexKey(1)].requestId, "req-chunk1");
      assert.equal(idx[indexKey(2)].status, "submitted");
      assert.equal(idx[indexKey(2)].requestId, "req-chunk1");
      assert.equal(idx[indexKey(3)].status, "failed");
      assert.equal(idx[indexKey(3)].attempts, 1);
    });
  });

  it("dois ids com o MESMO e-mail: cada um é indexado pelo próprio id", async () => {
    await withTmp(async (dir) => {
      const roster = [sub(1, { email_address: "igual@example.com" }), sub(2, { email_address: "igual@example.com" })];
      const summary = await run(dir, { roster, baseSnapshot: [base(1), base(2)] });
      assert.equal(summary.sent, 2);
      const idx = loadConfirmationIndex(join(dir, "idx.json"));
      assert.ok(idx[indexKey(1)] && idx[indexKey(2)]);
    });
  });

  it("[teste, real1, real2] com chunk inteiro falhando: real1 e real2 falham juntos (granularidade de chunk)", async () => {
    await withTmp(async (dir) => {
      const roster = [sub(1, { email_address: "vjpixel+gtm-x@gmail.com" }), sub(2), sub(3)];
      const sendFn = failSend("recusado");
      const summary = await run(dir, { roster, baseSnapshot: [base(1), base(2), base(3)], sendFn });
      const idx = loadConfirmationIndex(join(dir, "idx.json"));
      assert.equal(idx[indexKey(1)].status, "skipped-test-email");
      assert.equal(idx[indexKey(2)].status, "failed");
      assert.equal(idx[indexKey(3)].status, "failed");
      assert.deepEqual(summary.failedIds.sort(), [2, 3]);
      assert.equal(summary.sent, 0);
      assert.ok(summary.googleErrors.length > 0);
    });
  });

  it("índice corrompido/inválido LANÇA (nunca vira {})", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "idx.json");
      writeFileSync(path, "{ não é json");
      assert.throws(() => loadConfirmationIndex(path), /ilegível/);
      writeFileSync(path, JSON.stringify({ "kit-1": { status: "lixo" } }));
      assert.throws(() => loadConfirmationIndex(path), /inválido/);
      await assert.rejects(run(dir, { roster: [sub(1)], baseSnapshot: [base(1)] }));
    });
  });

  it("recusa repetida vira skipped-failed-permanent após MAX_FAILED_ATTEMPTS", async () => {
    await withTmp(async (dir) => {
      const sendFn = failSend();
      const args = { roster: [sub(1)], baseSnapshot: [base(1)], sendFn };
      await run(dir, args);
      await run(dir, args);
      const third = await run(dir, args);
      assert.equal(third.failedPermanent, 1);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].status, "skipped-failed-permanent");
      const fourth = await run(dir, args);
      assert.equal(fourth.toSend, 0);
    });
  });

  it("N falhas de TRANSPORTE consecutivas NUNCA chegam a skipped-failed-permanent (não contam tentativa)", async () => {
    await withTmp(async (dir) => {
      const sendFn = transportFailSend();
      const args = { roster: [sub(1)], baseSnapshot: [base(1)], sendFn };
      let last;
      for (let i = 0; i < MAX_FAILED_ATTEMPTS + 5; i++) last = await run(dir, args);
      assert.equal(last!.failedPermanent, 0);
      const entry = loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)];
      assert.equal(entry.status, "failed");
      assert.equal(entry.attempts ?? 0, 0);
      // continua sendo tentado (nunca sai do toSend por causa do teto)
      assert.equal(last!.toSend, 1);
    });
  });

  it("N recusas HTTP (não-2xx) REAIS do Google chegam a skipped-failed-permanent normalmente", async () => {
    await withTmp(async (dir) => {
      const sendFn = failSend(); // countsAsAttempt: true
      const args = { roster: [sub(1)], baseSnapshot: [base(1)], sendFn };
      let last;
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) last = await run(dir, args);
      assert.equal(last!.failedPermanent, 1);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].status, "skipped-failed-permanent");
    });
  });

  it("alterna transporte e recusa real: só a recusa real conta tentativa", async () => {
    await withTmp(async (dir) => {
      const args = { roster: [sub(1)], baseSnapshot: [base(1)] };
      await run(dir, { ...args, sendFn: transportFailSend() }); // não conta
      await run(dir, { ...args, sendFn: failSend() }); // conta: attempts=1
      await run(dir, { ...args, sendFn: transportFailSend() }); // não conta
      const summary = await run(dir, { ...args, sendFn: failSend() }); // conta: attempts=2
      const entry = loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)];
      assert.equal(entry.attempts, 2);
      assert.equal(entry.status, "failed");
      assert.equal(summary.failedPermanent, 0);
    });
  });

  it("recusa que sai da janela do snapshot base continua sendo retentada (status failed no índice)", async () => {
    await withTmp(async (dir) => {
      const sendFn = failSend();
      await run(dir, { roster: [sub(1)], baseSnapshot: [base(1)], sendFn });
      const ok = okSend();
      // agora o snapshot base já o traz active: sem o retry por índice ele sumiria
      const summary = await run(dir, { roster: [sub(1)], baseSnapshot: [base(1, "active")], sendFn: ok });
      assert.equal(ok.mock.callCount(), 1);
      assert.equal(summary.sent, 1);
    });
  });

  it("created_at ilegível NÃO é indexado (tenta de novo amanhã)", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await run(dir, { roster: [sub(1, { created_at: "lixo" })], baseSnapshot: [base(1)], sendFn });
      assert.equal(summary.skippedBadDate, 1);
      assert.equal(summary.outOfWindow, 0);
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(existsSync(join(dir, "idx.json")), false);
    });
  });

  it("falha ao gravar o índice pós-envio loga os ids enviados e relança", async () => {
    await withTmp(async (dir) => {
      const logs: string[] = [];
      // índice "dentro" de um arquivo: mkdir do diretório pai falha
      const blocker = join(dir, "arquivo");
      writeFileSync(blocker, "x");
      await assert.rejects(
        run(dir, { roster: [sub(7)], baseSnapshot: [base(7)], indexPath: join(blocker, "idx.json"), log: (m) => logs.push(m) }),
      );
      assert.ok(logs.some((m) => m.includes("ids enviados: 7")));
    });
  });

  it("assessBaseSnapshot: vazio ou < 50% do roster é problema", () => {
    assert.ok(assessBaseSnapshot(0, 100));
    assert.ok(assessBaseSnapshot(10, 100));
    assert.equal(assessBaseSnapshot(90, 100), null);
  });
});

describe("#8555 — CLI main()", () => {
  const yesterday = () => new Date(Date.now() - 24 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const noFetch = () => mock.fn(async () => { throw new Error("fetch NÃO deveria ser chamado"); });

  it("sem snapshot base: exit 1", async () => {
    await withTmp(async (dir) => {
      const code = await confirmMain(["--snapshot-root", dir, "--index", join(dir, "i.json")], noFetch() as unknown as typeof fetch, async () => [sub(1)]);
      assert.equal(code, 1);
    });
  });

  it("--send sem id da ação: exit 1, sem rede", async () => {
    await withTmp(async (dir) => {
      const f = noFetch();
      const saved = process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID;
      delete process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID;
      try {
        const code = await confirmMain(["--send", "--snapshot-root", dir], f as unknown as typeof fetch, async () => [sub(1)]);
        assert.equal(code, 1);
        assert.equal(f.mock.callCount(), 0);
      } finally {
        if (saved !== undefined) process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID = saved;
      }
    });
  });

  it("--send sem customer-id: exit 1, sem rede", async () => {
    await withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), JSON.stringify(base(1)) + "\n");
      const f = noFetch();
      const saved = process.env.GOOGLE_ADS_CUSTOMER_ID;
      delete process.env.GOOGLE_ADS_CUSTOMER_ID;
      try {
        const code = await confirmMain(
          ["--send", "--conversion-action-id", "555", "--snapshot-root", dir],
          f as unknown as typeof fetch,
          async () => [sub(1)],
        );
        assert.equal(code, 1);
        assert.equal(f.mock.callCount(), 0);
      } finally {
        if (saved !== undefined) process.env.GOOGLE_ADS_CUSTOMER_ID = saved;
      }
    });
  });

  // ATENÇÃO ao montar estes testes: sem snapshot válido o script sai 1 ANTES de olhar a ação, e um
  // `assert.equal(code, 1)` passaria mesmo com o guard desligado (medido: 39/39 verdes sem o guard).
  // Por isso o snapshot existe, o dry-run SEM o guard sairia 0, e o que se afirma é a MENSAGEM do guard.
  async function runRefusingPrimary(actionArg: string, extra: string[]) {
    return withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), JSON.stringify(base(1)) + "\n");
      const f = noFetch();
      const err = mock.method(console, "error", () => {});
      try {
        const code = await confirmMain(
          ["--conversion-action-id", actionArg, "--customer-id", "2369219639", "--snapshot-root", dir, "--index", join(dir, "i.json"), ...extra],
          f as unknown as typeof fetch,
          async () => [sub(1)],
        );
        return { code, calls: f.mock.callCount(), lines: err.mock.calls.map((c) => String(c.arguments[0])) };
      } finally {
        err.mock.restore();
      }
    });
  }

  it("recusa a ação de CADASTRO 7418673798 como destino — em --send e em dry-run (#8555)", async () => {
    for (const extra of [["--send"], []]) {
      const r = await runRefusingPrimary("7418673798", extra);
      assert.equal(r.code, 1, `deveria recusar (extra=${JSON.stringify(extra)})`);
      assert.equal(r.calls, 0);
      assert.ok(r.lines.some((l) => l.includes("ação de CADASTRO") && l.includes("recusada")), `mensagem do guard ausente: ${r.lines.join(" | ")}`);
    }
  });

  it("recusa a primária também quando vem como resource name completo", async () => {
    const r = await runRefusingPrimary("customers/2369219639/conversionActions/7418673798", ["--send"]);
    assert.equal(r.code, 1);
    assert.equal(r.calls, 0);
    assert.ok(r.lines.some((l) => l.includes("ação de CADASTRO") && l.includes("recusada")));
  });

  it("actionIdOf: EXATO, nunca por sufixo — id maior terminando na primária não é a primária", () => {
    assert.equal(actionIdOf("7418673798"), "7418673798");
    assert.equal(actionIdOf(" 7418673798 "), "7418673798");
    assert.equal(actionIdOf("customers/2369219639/conversionActions/7418673798"), "7418673798");
    assert.equal(actionIdOf("997418673798"), "997418673798");
    assert.equal(actionIdOf("customers/2369219639/conversionActions/997418673798"), "997418673798");
    assert.equal(actionIdOf("abc7418673798"), null);
    assert.equal(actionIdOf(""), null);
  });

  it("controle: uma ação SECUNDÁRIA qualquer NÃO é recusada pelo guard (dry-run sai 0)", async () => {
    const r = await runRefusingPrimary("7762768203", []);
    assert.equal(r.code, 0);
    assert.ok(!r.lines.some((l) => l.includes("recusada")));
  });

  it("argumento e env divergentes: usa o argumento e AVISA em stderr (não escolhe em silêncio)", async () => {
    await withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), JSON.stringify(base(1)) + "\n");
      const saved = process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID;
      process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID = "111";
      const err = mock.method(console, "error", () => {});
      try {
        const code = await confirmMain(
          ["--conversion-action-id", "555", "--customer-id", "2369219639", "--snapshot-root", dir, "--index", join(dir, "i.json")],
          noFetch() as unknown as typeof fetch,
          async () => [sub(1)],
        );
        assert.equal(code, 0);
        const lines = err.mock.calls.map((c) => String(c.arguments[0]));
        assert.ok(lines.some((l) => l.includes("diverge de GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID") && l.includes("555") && l.includes("111")));
      } finally {
        err.mock.restore();
        if (saved === undefined) delete process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID;
        else process.env.GOOGLE_ADS_CONFIRMATION_CONVERSION_ACTION_ID = saved;
      }
    });
  });

  it("--send --dry-run juntos = dry-run: exit 0, sem rede, sem índice", async () => {
    await withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), JSON.stringify(base(1)) + "\n");
      const f = noFetch();
      const idx = join(dir, "i.json");
      const code = await confirmMain(
        ["--send", "--dry-run", "--conversion-action-id", "555", "--customer-id", "2369219639", "--snapshot-root", dir, "--index", idx],
        f as unknown as typeof fetch,
        async () => [sub(1)],
      );
      assert.equal(code, 0);
      assert.equal(f.mock.callCount(), 0);
      assert.equal(existsSync(idx), false);
    });
  });

  it("--validate-only SEM --send: continua dry-run, sem rede", async () => {
    await withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), JSON.stringify(base(1)) + "\n");
      const f = noFetch();
      const idx = join(dir, "i.json");
      const code = await confirmMain(
        ["--validate-only", "--conversion-action-id", "555", "--customer-id", "2369219639", "--snapshot-root", dir, "--index", idx],
        f as unknown as typeof fetch,
        async () => [sub(1)],
      );
      assert.equal(code, 0);
      assert.equal(f.mock.callCount(), 0);
      assert.equal(existsSync(idx), false);
    });
  });

  it("--send --validate-only: chama a rede (via sendFn) mas NUNCA grava índice", async () => {
    await withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), JSON.stringify(base(1)) + "\n");
      // fetchFn simula o fluxo completo: refresh token + POST events:ingest com 2xx.
      const fetchFn = mock.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("oauth2.googleapis.com")) {
          return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        }
        void init;
        return new Response(JSON.stringify({ requestId: "req-validate" }), { status: 200 });
      });
      const idx = join(dir, "i.json");
      const env = {
        GOOGLE_ADS_CLIENT_ID: "id", GOOGLE_ADS_CLIENT_SECRET: "secret", GOOGLE_ADS_REFRESH_TOKEN: "refresh",
      };
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        const code = await confirmMain(
          ["--send", "--validate-only", "--conversion-action-id", "555", "--customer-id", "2369219639", "--snapshot-root", dir, "--index", idx],
          fetchFn as unknown as typeof fetch,
          async () => [sub(1)],
        );
        assert.equal(code, 0);
        assert.ok(fetchFn.mock.callCount() >= 1);
        assert.equal(existsSync(idx), false);
        const lastCall = fetchFn.mock.calls[fetchFn.mock.calls.length - 1];
        const body = JSON.parse(String((lastCall.arguments[1] as RequestInit).body));
        assert.equal(body.validateOnly, true);
      } finally {
        process.env = saved;
      }
    });
  });

  it("snapshot base vazio: exit 1", async () => {
    await withTmp(async (dir) => {
      const snapDir = join(dir, yesterday());
      mkdirSync(snapDir, { recursive: true });
      writeFileSync(join(snapDir, "subscribers.jsonl"), "");
      const code = await confirmMain(["--snapshot-root", dir], noFetch() as unknown as typeof fetch, async () => [sub(1)]);
      assert.equal(code, 1);
    });
  });
});
