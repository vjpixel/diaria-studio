/**
 * onboarding-broadcast-exclusion-7916.test.ts (#7916 — compat com #7922)
 *
 * Lotes de onboarding do transporte Kit (#7922) são broadcasts `completed`
 * como qualquer edição. Sem exclusão, `diaria-subscribers-ingest-kit.ts` os
 * ingeria com `edicao=broadcast_id` e `countDistinctEditions` (leitor-store)
 * os contava como edições — inflando o leitor-v1 da coorte nova. Os testes
 * ponta-a-ponta via `main()` estão em `diaria-subscribers-ingest-kit.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectOnboardingBroadcastIds,
  collectOrphanOnboardingLots,
  decideOnboardingBroadcastExclusion,
  excludeOnboardingBroadcasts,
  readOnboardingBroadcastExclusion,
} from "../scripts/lib/onboarding-broadcast-exclusion.ts";
import type { OnboardingKitLot } from "../scripts/lib/onboarding-kit-transport.ts";

function lot(
  lotId: string,
  broadcastId: number | null,
  status: OnboardingKitLot["status"] = broadcastId == null ? "pending" : "completed",
): OnboardingKitLot {
  return {
    lot_id: lotId,
    kind: "email1",
    tag_name: `onboarding-${lotId}`,
    tag_id: 10,
    broadcast_id: broadcastId,
    recipient_subscription_ids: ["s1"],
    recipient_emails: ["a@x.com"],
    status,
    created_at: "2026-10-01T09:00:00.000Z",
    send_at: null,
    last_reconciled_at: null,
    last_error: null,
  };
}

function writeFixture(opts: { enabled: boolean; store: string | null }): string {
  const dir = mkdtempSync(join(tmpdir(), "onb-excl-7916-"));
  writeFileSync(
    resolve(dir, "platform.config.json"),
    JSON.stringify({ onboarding: { store_path: "data/onboarding/store.json", kit_transport: { enabled: opts.enabled } } }),
  );
  if (opts.store != null) {
    mkdirSync(resolve(dir, "data/onboarding"), { recursive: true });
    writeFileSync(resolve(dir, "data/onboarding/store.json"), opts.store);
  }
  return resolve(dir, "platform.config.json");
}

describe("collectOnboardingBroadcastIds", () => {
  it("coleta só broadcast_id não-nulo, como string", () => {
    const ids = collectOnboardingBroadcastIds({ a: lot("a", 501), b: lot("b", null), c: lot("c", 502) });
    assert.deepEqual([...ids].sort(), ["501", "502"]);
  });
  it("lots ausente → vazio, nunca lança", () => {
    assert.equal(collectOnboardingBroadcastIds(undefined).size, 0);
  });
});

describe("collectOrphanOnboardingLots", () => {
  it("pending/created sem id contam; cancelado e com id não", () => {
    const orphans = collectOrphanOnboardingLots({
      a: lot("a", null),
      b: lot("b", null, "created"),
      c: lot("c", null, "cancelled"),
      d: lot("d", 5),
    });
    assert.deepEqual(orphans, ["a", "b"]);
  });
});

describe("excludeOnboardingBroadcasts", () => {
  it("broadcast de onboarding sai; broadcast de edição normal fica (ordem preservada)", () => {
    const { kept, excluded } = excludeOnboardingBroadcasts([{ id: 1 }, { id: 501 }, { id: 2 }], new Set(["501"]));
    assert.deepEqual(
      kept.map((b) => b.id),
      [1, 2],
    );
    assert.deepEqual(
      excluded.map((b) => b.id),
      [501],
    );
  });
});

describe("decideOnboardingBroadcastExclusion — política de falha", () => {
  const base = { lots: undefined, storePath: "/x/store.json" };
  it("store ausente + switch OFF → aviso e conjunto vazio (não quebra)", () => {
    const r = decideOnboardingBroadcastExclusion({ ...base, storeExists: false, corrupted: false, kitTransportEnabled: false });
    assert.equal(r.ids.size, 0);
    assert.equal(r.source, "store-absent");
    assert.ok(r.warning);
  });
  it("store ausente + switch ON → lança (nunca inflar leitor-v1 em silêncio)", () => {
    assert.throws(
      () => decideOnboardingBroadcastExclusion({ ...base, storeExists: false, corrupted: false, kitTransportEnabled: true }),
      /leitor-v1/,
    );
  });
  it("store ilegível + switch ON → lança", () => {
    assert.throws(() =>
      decideOnboardingBroadcastExclusion({ ...base, storeExists: true, corrupted: true, kitTransportEnabled: true }),
    );
  });
  it("store ilegível + switch OFF (pós-rollback) → lança também: o arquivo existir prova que pode haver lotes", () => {
    assert.throws(
      () => decideOnboardingBroadcastExclusion({ ...base, storeExists: true, corrupted: true, kitTransportEnabled: false }),
      /ilegível.*leitor-v1/s,
    );
  });
  it("aviso de store ausente não promete que não há lote algum (rollback perde o store)", () => {
    const r = decideOnboardingBroadcastExclusion({ ...base, storeExists: false, corrupted: false, kitTransportEnabled: false });
    assert.doesNotMatch(r.warning!, /nenhum lote de produção possível/);
    assert.match(r.warning!, /janela anterior/);
  });
  it("lote sem broadcast_id e não cancelado → orphanLots + aviso alto; cancelado não conta", () => {
    const r = decideOnboardingBroadcastExclusion({
      ...base,
      storeExists: true,
      corrupted: false,
      lots: { a: lot("a", 777), b: lot("b", null), c: lot("c", null, "cancelled") },
      kitTransportEnabled: true,
    });
    assert.deepEqual([...r.ids], ["777"]);
    assert.deepEqual(r.orphanLots, ["b"]);
    assert.match(r.warning!, /gap #1/);
  });
  it("store legível + switch OFF (rollback) → ainda exclui os lotes persistidos", () => {
    const r = decideOnboardingBroadcastExclusion({
      ...base,
      storeExists: true,
      corrupted: false,
      lots: { a: lot("a", 777) },
      kitTransportEnabled: false,
    });
    assert.deepEqual([...r.ids], ["777"]);
    assert.equal(r.warning, null);
  });
});

describe("readOnboardingBroadcastExclusion — lê config + store do disco", () => {
  it("store com lotes → ids dos broadcasts (store_path relativo ao diretório do config)", () => {
    const cfg = writeFixture({
      enabled: true,
      store: JSON.stringify({ entries: {}, kit_transport: { lots: { a: lot("a", 900), b: lot("b", null) } } }),
    });
    const r = readOnboardingBroadcastExclusion(cfg);
    assert.equal(r.source, "store");
    assert.deepEqual([...r.ids], ["900"]);
  });
  it("store ausente + switch OFF (estado de produção hoje) → não quebra", () => {
    const r = readOnboardingBroadcastExclusion(writeFixture({ enabled: false, store: null }));
    assert.equal(r.source, "store-absent");
    assert.equal(r.ids.size, 0);
  });
  it("store corrompido + switch ON → lança", () => {
    assert.throws(() => readOnboardingBroadcastExclusion(writeFixture({ enabled: true, store: "{nao-json" })));
  });
  it("store corrompido + switch OFF → lança (independe do switch)", () => {
    assert.throws(() => readOnboardingBroadcastExclusion(writeFixture({ enabled: false, store: "{nao-json" })));
  });
});
