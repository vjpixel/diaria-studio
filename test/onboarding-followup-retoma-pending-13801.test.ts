/**
 * #13801: lote `pending` sem broadcast (429 do Kit na marcação das tags) de
 * um dia anterior é RETOMADO no dia seguinte — mesma tag, mesmo lote — e não
 * recriado com tag nova.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFollowupLot, findResumablePendingLot } from "../scripts/onboarding-followup-run.ts";
import { emptyStore, readStore, writeStore } from "../scripts/lib/onboarding-store.ts";

const recips = [{ kit_subscriber_id: 1, email: "a@x.com" }, { kit_subscriber_id: 2, email: "b@x.com" }] as never;

function storeWithBlock(): string {
  const p = join(mkdtempSync(join(tmpdir(), "followup-13801-")), "store.json");
  writeStore(emptyStore(), p);
  return p;
}

describe("claimFollowupLot retoma pending de outro dia (#13801)", () => {
  it("dia 2 reaproveita o lote/tag do dia 1 em vez de criar outro", () => {
    const p = storeWithBlock();
    const t1 = Date.parse("2026-11-18T12:00:00Z");
    const first = claimFollowupLot(p, "form_lembrete", "2026-11-18", recips, t1);
    assert.equal(first.action, "create");
    first.lot!.tag_id = 26105806; // tag já criada antes do 429
    const t2 = Date.parse("2026-11-19T12:00:00Z");
    const second = claimFollowupLot(p, "form_lembrete", "2026-11-19", recips, t2);
    assert.equal(second.action, "recreate_after_timeout");
    assert.equal(second.lot!.lot_id, first.lot!.lot_id);
    const lots = Object.keys(readStore(p).store.followup!.lots);
    assert.equal(lots.length, 1, "nenhum lote novo");
  });

  it("lote recente (< stale) de outro dia bloqueia em vez de duplicar", () => {
    const p = storeWithBlock();
    const t1 = Date.parse("2026-11-18T23:59:00Z");
    claimFollowupLot(p, "form_lembrete", "2026-11-18", recips, t1);
    const r = claimFollowupLot(p, "form_lembrete", "2026-11-19", recips, t1 + 60_000);
    assert.equal(r.action, "blocked_concurrent");
  });

  it("findResumablePendingLot ignora outro kind e lote com broadcast", () => {
    const lot = { kind: "form", status: "pending", broadcast_id: null, created_at: "x" } as never;
    assert.equal(findResumablePendingLot({ a: lot }, "form_lembrete"), null);
    const withB = { kind: "form_lembrete", status: "pending", broadcast_id: 5, created_at: "x" } as never;
    assert.equal(findResumablePendingLot({ a: withB }, "form_lembrete"), null);
  });
});
