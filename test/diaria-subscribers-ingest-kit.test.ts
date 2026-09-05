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
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { drainPages, type KitEngagedPage, type BroadcastAudience, type DrainResult } from "../scripts/kit-provider-split.ts";
import type { KitBroadcastStats, KitBroadcastSummary } from "../scripts/lib/kit-client.ts";
import {
  ingestOneBroadcast,
  main,
  listAllCompletedBroadcasts,
  detectSiblingConflictFiles,
  type KitIngestDeps,
} from "../scripts/diaria-subscribers-ingest-kit.ts";
import {
  openDiariaSubscribersDb,
  getStoreCounts,
  findSubscriberIdByAlias,
  getSubscriptionsForSubscriber,
  getSubscriberTimeline,
} from "../scripts/lib/diaria-subscribers-db.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";

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

  // -------------------------------------------------------------------------
  // Refinamento por-link (#7206) — getBroadcastLinkClicks + fetchUrlClicks
  // -------------------------------------------------------------------------

  it("#7206: com getBroadcastLinkClicks + fetchUrlClicks, grava 'click' COM url por link, além dos 4 eixos", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: fakeFetchAudience({
        sent: ["a@x.com", "b@x.com"],
        delivered: ["a@x.com", "b@x.com"],
        opens: ["a@x.com"],
        clicks: ["a@x.com"],
      }),
      getBroadcastStats: async () => makeStats(2),
      getBroadcastLinkClicks: async () => ({
        clicks: [
          { id: 1, url: "https://diar.ia.br/materia-x", unique_clicks: 1, click_to_delivery_rate: 0.5, click_to_open_rate: 1 },
        ],
      }),
      fetchUrlClicks: async () => ({ emails: ["a@x.com"], descartadas: 0 }),
    };
    const broadcast = { id: 42, subject: "Edição", published_at: "2026-09-01T09:00:00.000Z", send_at: null };
    const outcome = await ingestOneBroadcast(db, broadcast, deps, "2026-09-01T12:00:00.000Z");

    assert.equal(outcome.entry.status, "ok");
    assert.equal(outcome.entry.counts?.clicks_com_url, 1);
    // 2 sent + 2 delivered + 1 open + 1 click (genérico) + 1 click (por-link) = 7
    assert.equal(outcome.eventsNew, 7);

    const subId = findSubscriberIdByAlias(db, "kit", null, "a@x.com");
    const timeline = getSubscriberTimeline(db, subId!);
    const clicksComUrl = timeline.filter((e) => e.type === "click" && e.url != null);
    assert.equal(clicksComUrl.length, 1);
    assert.equal(clicksComUrl[0].url, "https://diar.ia.br/materia-x");
    db.close();
  });

  it("#7206: link com unique_clicks 0 é ignorado — não paga chamada de rede à toa", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    let calledFetchUrl = false;
    const deps = {
      fetchAudience: fakeFetchAudience({ sent: ["a@x.com"], delivered: [], opens: [], clicks: [] }),
      getBroadcastStats: async () => makeStats(1),
      getBroadcastLinkClicks: async () => ({
        clicks: [{ id: 1, url: "https://x", unique_clicks: 0, click_to_delivery_rate: 0, click_to_open_rate: 0 }],
      }),
      fetchUrlClicks: async () => {
        calledFetchUrl = true;
        return { emails: [], descartadas: 0 };
      },
    };
    await ingestOneBroadcast(db, { id: 1, subject: "X", published_at: null, send_at: "2026-01-01T00:00:00.000Z" }, deps);
    assert.equal(calledFetchUrl, false);
    db.close();
  });

  it("#7206: sem getBroadcastLinkClicks/fetchUrlClicks (deps antigas) — ingestão dos 4 eixos segue normal, sem erro", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: fakeFetchAudience({ sent: ["a@x.com"], delivered: ["a@x.com"], opens: [], clicks: [] }),
      getBroadcastStats: async () => makeStats(1),
    };
    const outcome = await ingestOneBroadcast(db, { id: 1, subject: "X", published_at: null, send_at: "2026-01-01T00:00:00.000Z" }, deps);
    assert.equal(outcome.entry.status, "ok");
    assert.equal(outcome.entry.counts?.clicks_com_url, undefined);
    db.close();
  });

  it("#7206: falha no refinamento por-link é fail-soft — os 4 eixos principais seguem gravados, status ok preservado", async () => {
    const db = openDiariaSubscribersDb(":memory:");
    const deps = {
      fetchAudience: fakeFetchAudience({ sent: ["a@x.com"], delivered: ["a@x.com"], opens: [], clicks: [] }),
      getBroadcastStats: async () => makeStats(1),
      getBroadcastLinkClicks: async () => {
        throw new Error("Kit API 500 (shape do filtro urls ainda não confirmado)");
      },
      fetchUrlClicks: async () => ({ emails: [], descartadas: 0 }),
    };
    const outcome = await ingestOneBroadcast(db, { id: 1, subject: "X", published_at: null, send_at: "2026-01-01T00:00:00.000Z" }, deps);
    assert.equal(outcome.entry.status, "ok", "guard segue ancorado só em sent/recipients — refinamento por-link nunca deriva o veredito");
    assert.match(outcome.entry.error ?? "", /refinamento por-link.*7206/);
    assert.equal(outcome.eventsNew, 2, "2 sent + delivered continuam gravados apesar da falha no refinamento");
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
    // Testes deste describe cobrem só a ingestão de audiência por broadcast
    // (pré-existente) — roster fica em `kit-subscribers-ingest.test.ts`.
    // dry-run por padrão (sem --write), então uma lista vazia é inerte aqui.
    listAllRosterSubscribers: async () => [],
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
      listAllRosterSubscribers: async () => [],
    });
    assert.equal(process.exitCode, 1);
    assert.equal(calledFetch, false, "guard de data/ ausente roda ANTES de qualquer chamada de rede");
    process.exitCode = originalExit;
  });
});

describe("listAllCompletedBroadcasts — paginação de /broadcasts?status=completed", () => {
  it("junta as páginas seguindo end_cursor até has_next_page=false", async () => {
    const orig = globalThis.fetch;
    const origKey = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const body =
        calls === 1
          ? { broadcasts: [{ id: 1 }], pagination: { has_next_page: true, end_cursor: "c1" } }
          : { broadcasts: [{ id: 2 }], pagination: { has_next_page: false, end_cursor: null } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const broadcasts = await listAllCompletedBroadcasts();
      assert.deepEqual(broadcasts.map((b: any) => b.id), [1, 2]);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = orig;
      if (origKey !== undefined) process.env.KIT_API_KEY = origKey;
      else delete process.env.KIT_API_KEY;
    }
  });

  it("has_next_page=true SEM end_cursor é erro — nunca trata como fim de lista silencioso (achado de self-review, #6491)", async () => {
    const orig = globalThis.fetch;
    const origKey = process.env.KIT_API_KEY;
    process.env.KIT_API_KEY = "test-key";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ broadcasts: [{ id: 1 }], pagination: { has_next_page: true, end_cursor: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      await assert.rejects(() => listAllCompletedBroadcasts(), /end_cursor/);
    } finally {
      globalThis.fetch = orig;
      if (origKey !== undefined) process.env.KIT_API_KEY = origKey;
      else delete process.env.KIT_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// detectSiblingConflictFiles (#7174)
// ---------------------------------------------------------------------------

describe("detectSiblingConflictFiles", () => {
  it("detecta cópias de conflito no padrão medido em data/run-log.jsonl", () => {
    const files = ["captura-log.jsonl", "captura-log-Neo.jsonl", "captura-log-Zenbook-2.jsonl", "outro-arquivo.json"];
    const conflicts = detectSiblingConflictFiles(files, "captura-log.jsonl");
    assert.deepEqual(conflicts.sort(), ["captura-log-Neo.jsonl", "captura-log-Zenbook-2.jsonl"]);
  });

  it("nenhum conflito quando só o arquivo esperado existe", () => {
    assert.deepEqual(detectSiblingConflictFiles(["captura-log.jsonl", "outro.json"], "captura-log.jsonl"), []);
  });

  it("funciona pro .db (diaria-subscribers-safeBackup-0001.db)", () => {
    const files = ["diaria-subscribers.db", "diaria-subscribers-safeBackup-0001.db"];
    assert.deepEqual(detectSiblingConflictFiles(files, "diaria-subscribers.db"), ["diaria-subscribers-safeBackup-0001.db"]);
  });
});

// ---------------------------------------------------------------------------
// main() — Passo 1, ingestão de ROSTER (#7174)
// ---------------------------------------------------------------------------

function makeKitSub(overrides: Partial<KitSubscriberSummary> = {}): KitSubscriberSummary {
  return {
    id: 1,
    email_address: "roster@example.com",
    state: "active",
    created_at: "2026-08-25T10:00:00.000Z",
    fields: { utm_source: "sparkloop-upscribe" },
    ...overrides,
  };
}

describe("main() — Passo 1, ingestão de roster (#7174)", () => {
  it("sem --write: dry-run — lista o roster mas NÃO grava subscription nem captura-log", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-roster-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");
    const capturaLogPath = resolve(tmp, "data/metrics/captura-log.jsonl");

    await main(["--db", dbPath, "--manifest", manifestPath, "--captura-log", capturaLogPath], {
      listAllBroadcasts: async () => [],
      fetchAudience: async () => ({ emails: [], descartadas: 0 }),
      getBroadcastStats: async () => makeStats(0),
      sleep: async () => {},
      listAllRosterSubscribers: async () => [makeKitSub()],
    });

    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).subscriptions, 0, "dry-run nunca grava subscription");
    db.close();
    assert.equal(existsSyncSafe(capturaLogPath), false, "dry-run nunca escreve captura-log.jsonl");
  });

  it("com --write: grava subscription + evento subscribe + 1 linha em captura-log.jsonl", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-roster-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");
    const capturaLogPath = resolve(tmp, "data/metrics/captura-log.jsonl");

    await main(["--db", dbPath, "--manifest", manifestPath, "--captura-log", capturaLogPath, "--write"], {
      listAllBroadcasts: async () => [],
      fetchAudience: async () => ({ emails: [], descartadas: 0 }),
      getBroadcastStats: async () => makeStats(0),
      sleep: async () => {},
      listAllRosterSubscribers: async () => [makeKitSub()],
    });

    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).subscriptions, 1);
    const subscriberId = findSubscriberIdByAlias(db, "kit", "1", "roster@example.com");
    assert.notEqual(subscriberId, null);
    const [sub] = getSubscriptionsForSubscriber(db, subscriberId!);
    assert.equal(sub.source, "sparkloop-upscribe");
    db.close();

    const lines = readFileSync(capturaLogPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.total_retornado_api, 1);
    assert.equal(entry.novos_gravados, 1);
    assert.equal(entry.exit, 0);
  });

  it("re-execução com --write no mesmo processo APPEND uma 2ª linha em captura-log.jsonl (idempotente nos dados, não no log)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-roster-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");
    const capturaLogPath = resolve(tmp, "data/metrics/captura-log.jsonl");
    const deps: KitIngestDeps = {
      listAllBroadcasts: async () => [],
      fetchAudience: async () => ({ emails: [], descartadas: 0 }),
      getBroadcastStats: async () => makeStats(0),
      sleep: async () => {},
      listAllRosterSubscribers: async () => [makeKitSub()],
    };

    await main(["--db", dbPath, "--manifest", manifestPath, "--captura-log", capturaLogPath, "--write"], deps);
    await main(["--db", dbPath, "--manifest", manifestPath, "--captura-log", capturaLogPath, "--write"], deps);

    const db = openDiariaSubscribersDb(dbPath);
    assert.equal(getStoreCounts(db).subscriptions, 1, "subscription não duplica na 2ª rodada");
    db.close();

    const lines = readFileSync(capturaLogPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "captura-log ganha 1 linha POR EXECUÇÃO, mesmo sem nada novo pra gravar");
    const secondEntry = JSON.parse(lines[1]);
    assert.equal(secondEntry.novos_gravados, 0, "2ª rodada: o cadastro já era conhecido, 0 eventos NOVOS");
  });

  it("abortar (exit 1) quando detecta cópia de conflito do OneDrive no diretório do captura-log", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-roster-conflict-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");
    const metricsDir = resolve(tmp, "data/metrics");
    mkdirSync(metricsDir, { recursive: true });
    const capturaLogPath = resolve(metricsDir, "captura-log.jsonl");
    writeFileSync(resolve(metricsDir, "captura-log-Neo.jsonl"), "");

    let calledRoster = false;
    const originalExit = process.exitCode;
    await main(["--db", dbPath, "--manifest", manifestPath, "--captura-log", capturaLogPath, "--write"], {
      listAllBroadcasts: async () => [],
      fetchAudience: async () => ({ emails: [], descartadas: 0 }),
      getBroadcastStats: async () => makeStats(0),
      sleep: async () => {},
      listAllRosterSubscribers: async () => {
        calledRoster = true;
        return [makeKitSub()];
      },
    });
    assert.equal(process.exitCode, 1);
    assert.equal(calledRoster, false, "guard de conflito roda ANTES de listar o roster");
    process.exitCode = originalExit;
  });

  it("--skip-roster pula o Passo 1 inteiro — nem lista o roster (útil pra testar só o Passo 2 sem pagar a chamada de rede)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "diaria-kit-roster-skip-"));
    mkdirSync(resolve(tmp, "data"), { recursive: true });
    const dbPath = resolve(tmp, "data/diaria-subscribers/diaria-subscribers.db");
    const manifestPath = resolve(tmp, "data/diaria-subscribers/kit-ingest-manifest.json");

    let calledRoster = false;
    await main(["--db", dbPath, "--manifest", manifestPath, "--skip-roster"], {
      listAllBroadcasts: async () => [],
      fetchAudience: async () => ({ emails: [], descartadas: 0 }),
      getBroadcastStats: async () => makeStats(0),
      sleep: async () => {},
      listAllRosterSubscribers: async () => {
        calledRoster = true;
        return [makeKitSub()];
      },
    });
    assert.equal(calledRoster, false);
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
