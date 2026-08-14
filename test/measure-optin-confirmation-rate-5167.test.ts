/**
 * test/measure-optin-confirmation-rate-5167.test.ts (#5167 item 15)
 *
 * Cobre: bucketing de idade do Pending backlog, snapshot puro, delta entre
 * snapshots, persistência JSONL, e o caminho de rede mockado (contagem
 * barata `total_results` + reuso de `fetchPendingBeehiivSubscriptions`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  bucketPendingByAge,
  computeConfirmationSnapshot,
  computeDeltaBetweenSnapshots,
  fetchTotalCountByStatus,
  fetchConfirmationSnapshot,
  appendSnapshotToLog,
  readLatestSnapshot,
  DEFAULT_STALE_THRESHOLD_DAYS,
  type ConfirmationSnapshot,
} from "../scripts/measure-optin-confirmation-rate.ts";
import type { BeehiivPendingSubscription } from "../scripts/sync-pending-to-brevo.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");

function sub(email: string, subscribedOn: string): BeehiivPendingSubscription {
  return { id: "sub-" + email, email, rhSource: "", subscribedOn };
}

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("bucketPendingByAge — classifica Pending por idade (#5167 item 15)", () => {
  it("mais novo que o limiar → fresh", () => {
    const buckets = bucketPendingByAge([sub("a@b.com", isoDaysAgo(1))], NOW, 7);
    assert.deepEqual(buckets, { fresh: 1, stale: 0, unknownAge: 0 });
  });

  it("exatamente no limiar (idade >= threshold) → stale, não fresh", () => {
    const buckets = bucketPendingByAge([sub("a@b.com", isoDaysAgo(7))], NOW, 7);
    assert.deepEqual(buckets, { fresh: 0, stale: 1, unknownAge: 0 });
  });

  it("mais velho que o limiar → stale", () => {
    const buckets = bucketPendingByAge([sub("a@b.com", isoDaysAgo(30))], NOW, 7);
    assert.deepEqual(buckets, { fresh: 0, stale: 1, unknownAge: 0 });
  });

  it("subscribedOn vazio → unknownAge, nunca fresh nem stale", () => {
    const buckets = bucketPendingByAge([sub("a@b.com", "")], NOW, 7);
    assert.deepEqual(buckets, { fresh: 0, stale: 0, unknownAge: 1 });
  });

  it("subscribedOn não-parseável → unknownAge (fail-soft, não lança)", () => {
    const buckets = bucketPendingByAge([sub("a@b.com", "not-a-date")], NOW, 7);
    assert.deepEqual(buckets, { fresh: 0, stale: 0, unknownAge: 1 });
  });

  it("mistura de idades soma corretamente", () => {
    const pending = [
      sub("fresh1@b.com", isoDaysAgo(1)),
      sub("fresh2@b.com", isoDaysAgo(3)),
      sub("stale1@b.com", isoDaysAgo(10)),
      sub("unknown1@b.com", ""),
    ];
    const buckets = bucketPendingByAge(pending, NOW, 7);
    assert.deepEqual(buckets, { fresh: 2, stale: 1, unknownAge: 1 });
  });

  it("default staleThresholdDays é 7 quando omitido", () => {
    const buckets = bucketPendingByAge([sub("a@b.com", isoDaysAgo(8))], NOW);
    assert.equal(DEFAULT_STALE_THRESHOLD_DAYS, 7);
    assert.deepEqual(buckets, { fresh: 0, stale: 1, unknownAge: 0 });
  });
});

describe("computeConfirmationSnapshot — monta o snapshot puro (#5167 item 15)", () => {
  it("calcula confirmationRateEstimate = active / (active + stale), ignorando fresh/unknownAge", () => {
    const pending = [
      sub("fresh@b.com", isoDaysAgo(1)), // fora do denominador
      sub("stale1@b.com", isoDaysAgo(30)),
      sub("stale2@b.com", isoDaysAgo(60)),
      sub("unknown@b.com", ""), // fora do denominador
    ];
    const snapshot = computeConfirmationSnapshot(8, pending, NOW, "baseline", 7);
    assert.equal(snapshot.totalActive, 8);
    assert.equal(snapshot.totalPending, 4);
    assert.equal(snapshot.freshPending, 1);
    assert.equal(snapshot.stalePending, 2);
    assert.equal(snapshot.unknownAgePending, 1);
    assert.equal(snapshot.label, "baseline");
    assert.equal(snapshot.staleThresholdDays, 7);
    // 8 / (8 + 2) = 0.8
    assert.equal(snapshot.confirmationRateEstimate, 0.8);
    assert.equal(snapshot.timestamp, NOW.toISOString());
  });

  it("sem active nem stale (denominador zero) → confirmationRateEstimate null, nunca NaN/Infinity", () => {
    const pending = [sub("fresh@b.com", isoDaysAgo(1))];
    const snapshot = computeConfirmationSnapshot(0, pending, NOW, "", 7);
    assert.equal(snapshot.confirmationRateEstimate, null);
  });

  it("totalPending vazio → snapshot ainda válido, rate = active/(active+0)", () => {
    const snapshot = computeConfirmationSnapshot(5, [], NOW, "", 7);
    assert.equal(snapshot.totalPending, 0);
    assert.equal(snapshot.confirmationRateEstimate, 1);
  });
});

describe("computeDeltaBetweenSnapshots — pura, resolve ordem por timestamp (#5167 item 15)", () => {
  const before: ConfirmationSnapshot = {
    timestamp: "2026-08-01T00:00:00.000Z",
    label: "antes",
    totalActive: 100,
    totalPending: 50,
    freshPending: 10,
    stalePending: 40,
    unknownAgePending: 0,
    staleThresholdDays: 7,
    confirmationRateEstimate: 100 / 140,
  };
  const after: ConfirmationSnapshot = {
    timestamp: "2026-08-14T00:00:00.000Z",
    label: "depois",
    totalActive: 130,
    totalPending: 55,
    freshPending: 20,
    stalePending: 35,
    unknownAgePending: 0,
    staleThresholdDays: 7,
    confirmationRateEstimate: 130 / 165,
  };

  it("ordem (a, b) correta — delta positivo esperado", () => {
    const delta = computeDeltaBetweenSnapshots(before, after);
    assert.equal(delta.fromTimestamp, before.timestamp);
    assert.equal(delta.toTimestamp, after.timestamp);
    assert.equal(delta.deltaActive, 30);
    assert.equal(delta.deltaPending, 5);
    assert.equal(delta.deltaStalePending, -5); // melhora: menos stale
    assert.ok(delta.note.includes("#5095"));
  });

  it("ordem invertida (b, a) — mesmo resultado, resolvida por timestamp não por posição do argumento", () => {
    const delta = computeDeltaBetweenSnapshots(after, before);
    assert.equal(delta.fromTimestamp, before.timestamp);
    assert.equal(delta.toTimestamp, after.timestamp);
    assert.equal(delta.deltaActive, 30);
    assert.equal(delta.deltaStalePending, -5);
  });
});

describe("readLatestSnapshot / appendSnapshotToLog — persistência JSONL (#5167 item 15)", () => {
  it("arquivo ausente → null, nunca lança", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "optin-log-"));
    try {
      const logPath = resolve(dir, "nope", "log.jsonl");
      assert.equal(readLatestSnapshot(logPath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append + read devolve o último snapshot gravado (cria diretório se preciso)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "optin-log-"));
    try {
      const logPath = resolve(dir, "nested", "log.jsonl");
      const snap1 = computeConfirmationSnapshot(10, [], NOW, "primeiro", 7);
      const snap2 = computeConfirmationSnapshot(20, [], new Date(NOW.getTime() + 1000), "segundo", 7);
      appendSnapshotToLog(snap1, logPath);
      appendSnapshotToLog(snap2, logPath);
      const latest = readLatestSnapshot(logPath);
      assert.equal(latest?.label, "segundo");
      assert.equal(latest?.totalActive, 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("última linha corrompida → null (fail-soft), não derruba o script", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "optin-log-"));
    try {
      const logPath = resolve(dir, "log.jsonl");
      appendSnapshotToLog(computeConfirmationSnapshot(1, [], NOW, "ok", 7), logPath);
      appendFileSync(logPath, "{not valid json\n", "utf8");
      assert.equal(readLatestSnapshot(logPath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fetchTotalCountByStatus — contagem barata via total_results (#5167 item 15)", () => {
  function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
    return (async () =>
      ({
        ok,
        status,
        json: async () => body,
      }) as unknown as Response) as typeof fetch;
  }

  it("lê total_results da resposta per_page=1", async () => {
    const fetchImpl = mockFetch({ total_results: 4321 });
    const count = await fetchTotalCountByStatus("pub_1", "key", "active", fetchImpl);
    assert.equal(count, 4321);
  });

  it("!ok → lança com status no erro", async () => {
    const fetchImpl = mockFetch({}, false, 503);
    await assert.rejects(() => fetchTotalCountByStatus("pub_1", "key", "pending", fetchImpl), /503/);
  });

  it("total_results ausente → lança (nunca reporta 0 silencioso)", async () => {
    const fetchImpl = mockFetch({});
    await assert.rejects(
      () => fetchTotalCountByStatus("pub_1", "key", "active", fetchImpl),
      /total_results/,
    );
  });
});

describe("fetchConfirmationSnapshot — orquestra active count + pending list (#5167 item 15)", () => {
  it("combina fetchTotalCountByStatus(active) e fetchPendingBeehiivSubscriptions num snapshot", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("status=active")) {
        return { ok: true, status: 200, json: async () => ({ total_results: 50 }) } as unknown as Response;
      }
      if (u.includes("status=pending")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [
                { id: "1", email: "fresh@b.com", created: Math.floor(NOW.getTime() / 1000) - 86400 },
                { id: "2", email: "stale@b.com", created: Math.floor(NOW.getTime() / 1000) - 30 * 86400 },
              ],
              total_results: 2,
            }),
        } as unknown as Response;
      }
      throw new Error("unexpected url " + u);
    }) as typeof fetch;

    const snapshot = await fetchConfirmationSnapshot("pub_1", "key", fetchImpl, NOW, "baseline", 7);
    assert.equal(snapshot.totalActive, 50);
    assert.equal(snapshot.totalPending, 2);
    assert.equal(snapshot.freshPending, 1);
    assert.equal(snapshot.stalePending, 1);
    // 50 / (50 + 1) ≈ 0.9804
    assert.ok(snapshot.confirmationRateEstimate! > 0.98 && snapshot.confirmationRateEstimate! < 0.99);
  });
});
