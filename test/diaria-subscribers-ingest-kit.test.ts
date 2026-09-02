/**
 * diaria-subscribers-ingest-kit.test.ts (#6464 fatia 3 — #6586)
 *
 * Cobre a camada de I/O do builder Kit: `ingestOneBroadcast` (fetch + guard
 * + escrita, fail-soft) contra um SQLite `:memory:` real, e `main()` ponta-a-
 * ponta com deps injetadas — sem rede.
 *
 * `fakeFetchAudience` abaixo passa pela `drainPages` REAL (não um stub que
 * pula a paginação) alimentada com o shape literal de resposta de
 * `POST /v4/subscribers/filter` (`{ subscribers: [...], pagination: {...} }`)
 * — é a fixture que o critério de pronto da #6586 pede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { drainPages, type KitEngagedPage, type BroadcastAudience, type DrainResult } from "../scripts/kit-provider-split.ts";
import type { KitBroadcastStats, KitBroadcastSummary } from "../scripts/lib/kit-client.ts";
import { ingestOneBroadcast, main, type KitIngestDeps } from "../scripts/diaria-subscribers-ingest-kit.ts";
import { openDiariaSubscribersDb, getStoreCounts } from "../scripts/lib/diaria-subscribers-db.ts";

/** Fixture literal do shape real de `/subscribers/filter` (1 página, sem cursor). */
function filterPage(emails: string[]): KitEngagedPage {
  return {
    subscribers: emails.map((e) => ({ email_address: e })),
    pagination: { has_next_page: false, end_cursor: null },
  };
}

/** Constrói um `fetchAudience` fake que resolve por eixo a partir de um mapa
 *  de fixtures — passa pela `drainPages` REAL, não um atalho. */
function fakeFetchAudience(
  byAxis: Record<BroadcastAudience, string[]>,
): (broadcastId: number, axis: BroadcastAudience) => Promise<DrainResult> {
  return (_broadcastId, axis) => drainPages(async () => filterPage(byAxis[axis]), axis);
}

function makeStats(recipients: number): KitBroadcastStats {
  return {
    recipients,
    open_rate: 0,
    emails_opened: 0,
    click_rate: 0,
    unsubscribe_rate: 0,
    unsubscribes: 0,
    total_clicks: 0,
    show_total_clicks: false,
    status: "completed",
    progress: 100,
    open_tracking_disabled: false,
    click_tracking_disabled: false,
  };
}

describe("ingestOneBroadcast", () => {
  it("guard ok: sent ingerido bate com stats.recipients → status ok, 4 eixos gravados", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: fakeFetchAudience({
        sent: ["a@x.com", "b@x.com"],
        delivered: ["a@x.com"],
        opens: ["a@x.com"],
        clicks: [],
      }),
      getBroadcastStats: async () => makeStats(2),
    };
    const broadcast: Pick<KitBroadcastSummary, "id" | "subject" | "published_at" | "send_at"> = {
      id: 555,
      subject: "Edição de teste",
      published_at: "2026-08-28T09:00:00.000Z",
      send_at: null,
    };
    const outcome = await ingestOneBroadcast(db, broadcast, deps, "2026-08-28T12:00:00.000Z");
    assert.equal(outcome.entry.status, "ok");
    assert.equal(outcome.entry.id, "555");
    assert.equal(outcome.entry.counts?.sent, 2);
    assert.equal(outcome.entry.counts?.delivered, 1);
    assert.equal(outcome.eventsNew, 4); // 2 sent + 1 delivered + 1 open + 0 click
    assert.equal(getStoreCounts(db).subscribers, 2); // a@x.com, b@x.com
    db.close();
  });

  it("guard falha: sent ingerido diverge de stats.recipients → status partial, mas eventos são gravados", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: fakeFetchAudience({ sent: ["a@x.com"], delivered: [], opens: [], clicks: [] }),
      getBroadcastStats: async () => makeStats(999), // diverge de propósito
    };
    const outcome = await ingestOneBroadcast(
      db,
      { id: 1, subject: "X", published_at: null, send_at: "2026-01-01T00:00:00.000Z" },
      deps,
    );
    assert.equal(outcome.entry.status, "partial");
    assert.match(outcome.entry.error!, /999/);
    assert.equal(outcome.eventsNew, 1, "o que foi coletado é gravado mesmo sob guard falho");
    db.close();
  });

  it("fetch falha (rede/API) → status error, NUNCA lança, zero eventos", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: async () => {
        throw new Error("Kit API 503");
      },
      getBroadcastStats: async () => makeStats(0),
    };
    const outcome = await ingestOneBroadcast(
      db,
      { id: 7, subject: "Y", published_at: null, send_at: null },
      deps,
    );
    assert.equal(outcome.entry.status, "error");
    assert.match(outcome.entry.error!, /503/);
    assert.equal(outcome.eventsNew, 0);
    assert.equal(getStoreCounts(db).subscribers, 0);
    db.close();
  });

  it("ts do evento cai no broadcast (published_at, ou send_at se published_at ausente)", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: fakeFetchAudience({ sent: ["a@x.com"], delivered: [], opens: [], clicks: [] }),
      getBroadcastStats: async () => makeStats(1),
    };
    await ingestOneBroadcast(db, { id: 1, subject: null as any, published_at: null, send_at: "2026-02-02T00:00:00.000Z" }, deps);
    const row = db.prepare("SELECT ts FROM event LIMIT 1").get() as { ts: string };
    assert.equal(row.ts, "2026-02-02T00:00:00.000Z");
    db.close();
  });
});

/** Constrói `KitIngestDeps` fake — 2 broadcasts fixture, sem rede real. */
function fakeDeps(): KitIngestDeps {
  const broadcasts: KitBroadcastSummary[] = [
    {
      id: 1,
      subject: "Edição A",
      send_at: null,
      status: "completed",
      public: true,
      published_at: "2026-08-27T09:00:00.000Z",
      created_at: "2026-08-27T08:00:00.000Z",
      preview_text: null,
      description: null,
      thumbnail_alt: null,
      thumbnail_url: null,
      publication_id: 1,
    },
    {
      id: 2,
      subject: "Edição B",
      send_at: "2026-08-28T09:00:00.000Z",
      status: "completed",
      public: true,
      published_at: null,
      created_at: "2026-08-28T08:00:00.000Z",
      preview_text: null,
      description: null,
      thumbnail_alt: null,
      thumbnail_url: null,
      publication_id: 1,
    },
  ];
  const byAxisByBroadcast: Record<number, Record<BroadcastAudience, string[]>> = {
    1: { sent: ["a@x.com", "b@x.com"], delivered: ["a@x.com"], opens: ["a@x.com"], clicks: [] },
    2: { sent: ["c@x.com"], delivered: ["c@x.com"], opens: [], clicks: [] },
  };
  const statsByBroadcast: Record<number, number> = { 1: 2, 2: 1 }; // recipients = len(sent) — guard passa
  return {
    listAllBroadcasts: async () => broadcasts,
    fetchAudience: (id, axis) => drainPages(async () => filterPage(byAxisByBroadcast[id][axis]), axis),
    getBroadcastStats: async (id) => makeStats(statsByBroadcast[id]),
    sleep: async () => {}, // nunca espera de verdade em teste
  };
}

describe("main() — ponta a ponta com deps injetadas (fixture de /subscribers/filter)", () => {
  it("ingere os 2 broadcasts, grava eventos, persiste manifest com status ok", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-ingest-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true }); // simula data/ presente
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");

    await main(["--db", dbPath, "--manifest", manifestPath], fakeDeps());

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.entries.length, 2);
    assert.ok(manifest.entries.every((e: { status: string }) => e.status === "ok"));

    const db = openDiariaSubscribersDb(dbPath);
    // broadcast 1: 2 sent + 1 delivered + 1 open = 4; broadcast 2: 1 sent + 1 delivered = 2
    assert.equal(getStoreCounts(db).events, 6);
    db.close();
  });

  it("2ª rodada é idempotente — nada pendente, nenhum evento novo", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-ingest-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");

    await main(["--db", dbPath, "--manifest", manifestPath], fakeDeps());
    const db1 = openDiariaSubscribersDb(dbPath);
    const before = getStoreCounts(db1).events;
    db1.close();

    await main(["--db", dbPath, "--manifest", manifestPath], fakeDeps());
    const db2 = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db2).events, before, "manifest já ok — nada re-processado, nada duplicado");
    db2.close();
  });

  it("recusa cedo (exitCode 1) quando data/ está ausente, nunca tenta a rede", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-ingest-nodata-"));
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const originalExit = process.exitCode;
    let calledFetch = false;
    await main(["--db", dbPath], {
      listAllBroadcasts: async () => {
        calledFetch = true;
        return [];
      },
      fetchAudience: async () => ({ emails: [], descartadas: 0 }),
      getBroadcastStats: async () => makeStats(0),
      sleep: async () => {},
    });
    assert.equal(process.exitCode, 1);
    assert.equal(calledFetch, false, "guard de data/ ausente roda ANTES de qualquer chamada de rede");
    process.exitCode = originalExit;
  });
});
