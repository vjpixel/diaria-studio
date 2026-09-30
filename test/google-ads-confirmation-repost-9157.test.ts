/**
 * #9157: falha que não conta tentativa mas em que o POST `events:ingest` SAIU
 * (2xx sem `requestId`, 2xx não-JSON, rede após envio, 5xx/429) tem teto
 * próprio — antes a task diária re-POSTava o mesmo evento até sair da janela
 * de 90 dias. Nenhum teste toca a API: `sendFn`/`fetch` são sempre mocks.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runConfirmationBatch,
  loadConfirmationIndex,
  indexKey,
  MAX_FAILED_ATTEMPTS,
  MAX_UNCOUNTED_POST_ATTEMPTS,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import {
  sendDataManagerIngest,
  type DataManagerEvent,
  type DataManagerIngestResult,
} from "../scripts/lib/google-data-manager-sender.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";

const NOW = new Date("2026-09-20T15:00:00Z");
const BASE_DATE = "2026-09-18";
const sub = (id: number): ConfirmationRosterEntry => ({
  id,
  email_address: `leitor${id}@example.com`,
  state: "active",
  created_at: "2026-09-18T12:00:00Z",
});
const base = (id: number): SubscriberStateRecord => ({ id, state: "inactive", created_at: "2026-09-18T12:00:00Z" });

const ENV = {
  GOOGLE_ADS_CLIENT_ID: "cid",
  GOOGLE_ADS_CLIENT_SECRET: "sec",
  GOOGLE_ADS_REFRESH_TOKEN: "ref",
};

/** sendFn que passa pelo sender REAL, com fetch mockado: token ok + ingest 200 sem requestId. */
function anomalous2xxSend() {
  const fetchFn = mock.fn(async (url: string | URL | Request): Promise<Response> => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    return new Response("{}", { status: 200 }); // 2xx sem requestId
  });
  const sendFn = mock.fn((events: DataManagerEvent[]) =>
    sendDataManagerIngest({ fetchFn: fetchFn as never, env: ENV as never, payload: { events } as never }),
  );
  return { sendFn, fetchFn };
}

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gads-confirm-9157-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const run = (dir: string, sendFn: (e: DataManagerEvent[]) => Promise<DataManagerIngestResult>) =>
  runConfirmationBatch({
    roster: [sub(1)],
    baseSnapshot: [base(1)],
    baseDate: BASE_DATE,
    indexPath: join(dir, "idx.json"),
    dryRun: false,
    sendFn,
    now: NOW,
    log: () => {},
  });

describe("#9157 — POST ambíguo não é reenviado indefinidamente", () => {
  it("2xx sem requestId por N runs: para de reenviar após MAX_UNCOUNTED_POST_ATTEMPTS", async () => {
    await withTmp(async (dir) => {
      const { sendFn } = anomalous2xxSend();
      const first = await run(dir, sendFn);
      assert.equal(first.failed, 1, "sanidade: o sender real trata 2xx sem requestId como falha");
      for (let i = 1; i < MAX_UNCOUNTED_POST_ATTEMPTS + 10; i++) await run(dir, sendFn);
      assert.equal(sendFn.mock.callCount(), MAX_UNCOUNTED_POST_ATTEMPTS);
      const entry = loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)];
      assert.equal(entry.status, "skipped-failed-permanent");
      assert.equal(entry.uncountedPostAttempts, MAX_UNCOUNTED_POST_ATTEMPTS);
      assert.equal(entry.attempts ?? 0, 0);
    });
  });

  it("5xx (stage ingest, não conta tentativa) consome o teto próprio, tolerando mais que MAX_FAILED_ATTEMPTS", async () => {
    await withTmp(async (dir) => {
      const sendFn = mock.fn(async (_e: DataManagerEvent[]): Promise<DataManagerIngestResult> => ({
        ok: false,
        stage: "ingest",
        error: "HTTP 503",
        countsAsAttempt: false,
      }));
      assert.ok(MAX_UNCOUNTED_POST_ATTEMPTS > MAX_FAILED_ATTEMPTS);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await run(dir, sendFn);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].status, "failed");
      let last;
      for (let i = MAX_FAILED_ATTEMPTS; i < MAX_UNCOUNTED_POST_ATTEMPTS; i++) last = await run(dir, sendFn);
      assert.equal(last!.failedPermanent, 1);
      const after = await run(dir, sendFn);
      assert.equal(after.toSend, 0);
      assert.equal(sendFn.mock.callCount(), MAX_UNCOUNTED_POST_ATTEMPTS);
    });
  });

  it("falha pré-POST (env) nunca consome o teto — nada foi enviado", async () => {
    await withTmp(async (dir) => {
      const sendFn = mock.fn(async (_e: DataManagerEvent[]): Promise<DataManagerIngestResult> => ({
        ok: false,
        stage: "env",
        error: "env ausente",
        missing: ["X"],
        countsAsAttempt: false,
      }));
      for (let i = 0; i < MAX_UNCOUNTED_POST_ATTEMPTS + 3; i++) await run(dir, sendFn);
      assert.equal(sendFn.mock.callCount(), MAX_UNCOUNTED_POST_ATTEMPTS + 3);
      const entry = loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)];
      assert.equal(entry.status, "failed");
      assert.equal(entry.uncountedPostAttempts, undefined);
    });
  });

  it("sucesso depois de POST ambíguo vira submitted normalmente", async () => {
    await withTmp(async (dir) => {
      const { sendFn } = anomalous2xxSend();
      await run(dir, sendFn);
      const ok = mock.fn(async (_e: DataManagerEvent[]): Promise<DataManagerIngestResult> => ({ ok: true, requestId: "r", response: {} }));
      const s = await run(dir, ok);
      assert.equal(s.sent, 1);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].status, "submitted");
    });
  });
});
