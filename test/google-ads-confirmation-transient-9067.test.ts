/**
 * Regressão #9067 (par do #9022 da Meta): 5xx/429 da Data Manager API
 * (instabilidade/throttling do Google) NÃO podem consumir tentativa do lote de
 * confirmação DOI — senão uma queda transitória marca o candidato como
 * `skipped-failed-permanent` para sempre. 4xx (exceto 429) segue consumindo e
 * desiste na `MAX_FAILED_ATTEMPTS`-ésima. O teto dos transitórios é a janela
 * de 90 dias do lote.
 *
 * Nenhum teste toca o Google: `fetchFn` é mock; índice em dir temporário.
 * O `sendFn` do lote é o `sendDataManagerIngest` REAL sobre o fetch mockado —
 * cobre a decisão do sender e o consumo dela pelo lote juntos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_FAILED_ATTEMPTS,
  indexKey,
  loadConfirmationIndex,
  runConfirmationBatch,
  type ConfirmationRosterEntry,
} from "../scripts/lib/google-ads-confirmation-batch.ts";
import {
  buildDataManagerIngestPayload,
  isTransientDataManagerStatus,
  sendDataManagerIngest,
} from "../scripts/lib/google-data-manager-sender.ts";
import type { SubscriberStateRecord } from "../scripts/lib/subscriber-state-snapshot.ts";

const NOW = new Date("2026-09-20T15:00:00Z");
const BASE_DATE = "2026-09-18";
const CREATED_AT = "2026-09-18T12:00:00Z";
const ENV = { GOOGLE_ADS_CLIENT_ID: "id", GOOGLE_ADS_CLIENT_SECRET: "secret", GOOGLE_ADS_REFRESH_TOKEN: "refresh" };

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gads-confirm-9067-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const sub = (id: number): ConfirmationRosterEntry => ({
  id,
  email_address: `leitor${id}@example.com`,
  state: "active",
  created_at: CREATED_AT,
});
const base = (id: number): SubscriberStateRecord => ({ id, state: "inactive", created_at: CREATED_AT });

/** fetch mock: token OK sempre; `events:ingest` responde `ingestStatus`. */
function fetchWith(ingestStatus: number): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `HTTP ${ingestStatus}` } }), { status: ingestStatus });
  }) as unknown as typeof fetch;
}

async function runWithStatus(dir: string, ingestStatus: number, now: Date = NOW) {
  return runConfirmationBatch({
    roster: [sub(1)],
    baseSnapshot: [base(1)],
    baseDate: BASE_DATE,
    indexPath: join(dir, "idx.json"),
    dryRun: false,
    now,
    log: () => {},
    sendFn: (events) =>
      sendDataManagerIngest({
        fetchFn: fetchWith(ingestStatus),
        env: ENV,
        payload: buildDataManagerIngestPayload(events, { customerId: "1", productDestinationId: "2", validateOnly: false }),
      }),
  });
}

describe("#9067 — isTransientDataManagerStatus", () => {
  it("429 e 5xx são transitórios; 4xx e 2xx não", () => {
    for (const s of [429, 500, 502, 503, 504, 599]) assert.equal(isTransientDataManagerStatus(s), true, String(s));
    for (const s of [200, 400, 401, 403, 404, 409, 428, 430, 600]) assert.equal(isTransientDataManagerStatus(s), false, String(s));
  });
});

describe("#9067 — sendDataManagerIngest: countsAsAttempt por status", () => {
  const payload = buildDataManagerIngestPayload([], { customerId: "1", productDestinationId: "2", validateOnly: true });
  for (const [status, expected] of [
    [400, true],
    [403, true],
    [429, false],
    [500, false],
    [503, false],
  ] as const) {
    it(`HTTP ${status} → countsAsAttempt ${expected}`, async () => {
      const r = await sendDataManagerIngest({ fetchFn: fetchWith(status), env: ENV, payload });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.stage, "ingest");
      assert.equal(r.countsAsAttempt, expected);
      assert.match(r.error, new RegExp(String(status)));
    });
  }
});

describe("#9067 — lote de confirmação: 5xx/429 não esgotam o teto", () => {
  for (const status of [429, 503]) {
    it(`${MAX_FAILED_ATTEMPTS + 2} rodadas com HTTP ${status}: segue failed, attempts 0, sem failedPermanent`, async () => {
      await withTmp(async (dir) => {
        let last;
        for (let i = 0; i < MAX_FAILED_ATTEMPTS + 2; i++) last = await runWithStatus(dir, status);
        const entry = loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)];
        assert.equal(entry.status, "failed");
        assert.equal(entry.attempts ?? 0, 0);
        assert.equal(last!.failedPermanent, 0);
        assert.equal(last!.toSend, 1); // continua no pool de retry
      });
    });
  }

  it("depois de 5xx, um 2xx envia normalmente (o candidato não se perdeu)", async () => {
    await withTmp(async (dir) => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await runWithStatus(dir, 500);
      const summary = await runConfirmationBatch({
        roster: [sub(1)],
        baseSnapshot: [base(1)],
        baseDate: BASE_DATE,
        indexPath: join(dir, "idx.json"),
        dryRun: false,
        now: NOW,
        log: () => {},
        sendFn: async () => ({ ok: true, requestId: "req-ok", response: {} }),
      });
      assert.equal(summary.sent, 1);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].status, "submitted");
    });
  });

  it("4xx permanente continua consumindo e desiste na MAX_FAILED_ATTEMPTS-ésima", async () => {
    await withTmp(async (dir) => {
      let last;
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) last = await runWithStatus(dir, 400);
      assert.equal(last!.failedPermanent, 1);
      const entry = loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)];
      assert.equal(entry.status, "skipped-failed-permanent");
      assert.equal(entry.attempts, MAX_FAILED_ATTEMPTS);
    });
  });

  it("teto dos transitórios é a janela de 90 dias: fora dela vira skipped-out-of-window", async () => {
    await withTmp(async (dir) => {
      await runWithStatus(dir, 503);
      const later = new Date(Date.parse(CREATED_AT) + 91 * 24 * 60 * 60 * 1000);
      const summary = await runWithStatus(dir, 503, later);
      assert.equal(summary.outOfWindow, 1);
      assert.equal(summary.toSend, 0);
      assert.equal(loadConfirmationIndex(join(dir, "idx.json"))[indexKey(1)].status, "skipped-out-of-window");
    });
  });
});
