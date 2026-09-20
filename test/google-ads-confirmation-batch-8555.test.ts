/**
 * Testes (#8555): lote de confirmação DOI -> Google Ads (ECL).
 *
 * Nenhum teste toca a Google Ads API: `sendFn`/`fetch` são sempre mocks e o
 * índice de idempotência vive num diretório temporário.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractGclid,
  isOutOfWindow,
  pickBaseSnapshotDate,
  runConfirmationBatch,
  selectConfirmationCandidates,
  loadConfirmationIndex,
  toBrtIso,
  indexKey,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import {
  extractPartialFailureIndexes,
  sendConversionPayload,
  authConfigFromEnv,
  resolveActionResourceName,
  type SendPayloadResult,
} from "../scripts/lib/google-ads-conversion-sender.ts";
import { hashEmailForEnhancedConversions } from "../scripts/lib/google-ads-enhanced-conversions.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";

const ACTION = "customers/2369219639/conversionActions/555";
const NOW = new Date("2026-09-20T15:00:00Z");

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

const okSend = () =>
  mock.fn(async (): Promise<SendPayloadResult> => ({ ok: true, response: {} }));

describe("#8555 — detecção de confirmações", () => {
  it("inactive na base + active hoje = confirmação; já active na base não é", () => {
    const c = selectConfirmationCandidates([sub(1), sub(2), sub(3, { state: "inactive" })], [base(1), base(2, "active"), base(3)]);
    assert.deepEqual(c.map((x) => x.id), [1]);
    assert.equal(c[0].path, "kit-email");
  });

  it("caminho botão Brevo (confirmou_via) é detectado e rotulado", () => {
    const c = selectConfirmationCandidates([sub(1, { fields: { confirmou_via: "brevo-reativar" } })], [base(1)]);
    assert.equal(c[0].path, "brevo-botao");
  });

  it("nasceu active sem estado anterior NÃO é confirmação, exceto com confirmou_via", () => {
    const c = selectConfirmationCandidates(
      [sub(1), sub(2, { fields: { confirmou_via: "brevo-reativar" } })],
      [],
    );
    assert.deepEqual(c.map((x) => x.id), [2]);
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

describe("#8555 — regressão do lote", () => {
  it("confirmação SEM gclid SOBE, via hash de e-mail", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath: join(dir, "idx.json"),
        conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 1);
      const payload = (sendFn.mock.calls[0].arguments as unknown as [{ conversions: Array<Record<string, unknown>> }])[0];
      assert.equal(payload.conversions.length, 1);
      const conv = payload.conversions[0];
      assert.equal(conv.gclid, undefined);
      assert.deepEqual(conv.userIdentifiers, [{ hashedEmail: hashEmailForEnhancedConversions("leitor1@example.com") }]);
      assert.equal(conv.conversionAction, ACTION);
      assert.equal(conv.orderId, "diaria-confirmacao-kit-1");
      assert.equal(conv.conversionDateTime, "2026-09-20 12:00:00-03:00");
      assert.equal(summary.sent, 1);
      assert.equal(summary.withGclid, 0);
    });
  });

  it("gclid sobe JUNTO com o hash quando existe", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1, { fields: { origem_click_id: "gclid:Cj0K" } })], baseSnapshot: [base(1)],
        indexPath: join(dir, "idx.json"), conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      const payload = (sendFn.mock.calls[0].arguments as unknown as [{ conversions: Array<Record<string, unknown>> }])[0];
      assert.equal(payload.conversions[0].gclid, "Cj0K");
      assert.ok(payload.conversions[0].userIdentifiers);
      assert.equal(summary.withGclid, 1);
    });
  });

  it("já enviada NÃO reenvia (índice persistido entre rodadas)", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const first = okSend();
      await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        conversionActionResourceName: ACTION, dryRun: false, sendFn: first, now: NOW, log: () => {},
      });
      assert.equal(loadConfirmationIndex(indexPath)[indexKey(1)].status, "sent");
      const second = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        conversionActionResourceName: ACTION, dryRun: false, sendFn: second, now: NOW, log: () => {},
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
        conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: (m) => logs.push(m),
      });
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(summary.outOfWindow, 1);
      assert.deepEqual(summary.outOfWindowIds, [1]);
      assert.equal(loadConfirmationIndex(indexPath)[indexKey(1)].status, "skipped-out-of-window");
      assert.ok(logs.some((m) => m.includes("fora da janela") && m.includes("1")));
      // e não volta na rodada seguinte
      const again = await runConfirmationBatch({
        roster: [sub(1, { created_at: "2026-05-01T00:00:00Z" })], baseSnapshot: [base(1)], indexPath,
        conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(again.alreadyIndexed, 1);
      assert.equal(again.outOfWindow, 0);
    });
  });

  it("dry-run: não envia, não grava índice, devolve o payload", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1), sub(2, { created_at: "2026-05-01T00:00:00Z" })], baseSnapshot: [base(1), base(2)], indexPath,
        conversionActionResourceName: ACTION, dryRun: true, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(existsSync(indexPath), false);
      assert.equal(summary.payload?.conversions.length, 1);
      assert.equal(summary.outOfWindow, 1);
    });
  });

  it("falha de envio não marca nada como enviado (reprocessa na próxima)", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const sendFn = mock.fn(async (): Promise<SendPayloadResult> => ({ ok: false, stage: "upload", error: "HTTP 500" }));
      const summary = await runConfirmationBatch({
        roster: [sub(1)], baseSnapshot: [base(1)], indexPath,
        conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(summary.sent, 0);
      assert.equal(summary.failed, 1);
      assert.equal(summary.error, "HTTP 500");
      assert.deepEqual(loadConfirmationIndex(indexPath), {});
    });
  });

  it("partialFailureError: só o que o Google recusou fica de fora do índice", async () => {
    await withTmp(async (dir) => {
      const indexPath = join(dir, "idx.json");
      const sendFn = mock.fn(async (): Promise<SendPayloadResult> => ({
        ok: true,
        response: {
          partialFailureError: {
            details: [{ errors: [{ location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }] } }] }],
          },
        },
      }));
      const summary = await runConfirmationBatch({
        roster: [sub(1), sub(2)], baseSnapshot: [base(1), base(2)], indexPath,
        conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(summary.sent, 1);
      assert.equal(summary.failed, 1);
      const idx = loadConfirmationIndex(indexPath);
      assert.ok(idx[indexKey(1)]);
      assert.equal(idx[indexKey(2)], undefined);
    });
  });

  it("e-mail de teste do editor é descartado e contado", async () => {
    await withTmp(async (dir) => {
      const sendFn = okSend();
      const summary = await runConfirmationBatch({
        roster: [sub(1, { email_address: "vjpixel+gtm-teste1@gmail.com" })], baseSnapshot: [base(1)],
        indexPath: join(dir, "idx.json"), conversionActionResourceName: ACTION, dryRun: false, sendFn, now: NOW, log: () => {},
      });
      assert.equal(sendFn.mock.callCount(), 0);
      assert.equal(summary.skippedTestEmails, 1);
    });
  });
});

describe("#8555 — módulo de envio extraído", () => {
  it("extractPartialFailureIndexes: sem erro -> [], erro sem índice legível -> null", () => {
    assert.deepEqual(extractPartialFailureIndexes({}), []);
    assert.equal(extractPartialFailureIndexes({ partialFailureError: { message: "x" } }), null);
  });

  it("authConfigFromEnv lista as variáveis ausentes", () => {
    const r = authConfigFromEnv({ GOOGLE_ADS_CLIENT_ID: "a" }, "1");
    assert.ok("missing" in r && r.missing.includes("GOOGLE_ADS_REFRESH_TOKEN"));
  });

  it("resolveActionResourceName: id cru exige customer id", () => {
    assert.equal(resolveActionResourceName("9", undefined).ok, false);
    const r = resolveActionResourceName("9", "236-921-9639");
    assert.ok(r.ok && r.resourceName === "customers/2369219639/conversionActions/9");
  });

  it("sendConversionPayload sem env não chama a rede", async () => {
    const fetchMock = mock.fn(async () => {
      throw new Error("fetch NÃO deveria ser chamado");
    });
    const r = await sendConversionPayload({
      fetchFn: fetchMock as unknown as typeof fetch,
      env: {},
      customerId: "1",
      payload: { conversions: [], partialFailure: true, validateOnly: false },
    });
    assert.equal(r.ok, false);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
