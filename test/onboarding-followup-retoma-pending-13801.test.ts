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

  it("#13804: destinatário antigo fora da lista de hoje cancela o lote antigo e cria outro", () => {
    const p = storeWithBlock();
    const t1 = Date.parse("2026-11-18T12:00:00Z");
    const dia1 = [{ kit_subscriber_id: 1, email: "a@x.com" }, { kit_subscriber_id: 2, email: "b@x.com" }, { kit_subscriber_id: 3, email: "c@x.com" }] as never;
    const first = claimFollowupLot(p, "form_lembrete", "2026-11-18", dia1, t1);
    assert.equal(first.action, "create");
    // A (id 1) respondeu o formulário; D (id 4) entrou.
    const dia2 = [{ kit_subscriber_id: 2, email: "b@x.com" }, { kit_subscriber_id: 3, email: "c@x.com" }, { kit_subscriber_id: 4, email: "d@x.com" }] as never;
    const t2 = Date.parse("2026-11-19T12:00:00Z");
    const second = claimFollowupLot(p, "form_lembrete", "2026-11-19", dia2, t2);
    assert.equal(second.action, "create");
    assert.notEqual(second.lot!.lot_id, first.lot!.lot_id);
    assert.notEqual(second.lot!.tag_name, first.lot!.tag_name, "tag nova, sem o A");
    assert.deepEqual(second.lot!.recipient_subscription_ids, ["2", "3", "4"]);
    const lots = readStore(p).store.followup!.lots;
    assert.equal(lots[first.lot!.lot_id].status, "cancelled");
    assert.deepEqual(lots[first.lot!.lot_id].recipient_subscription_ids, ["1", "2", "3"], "lote antigo intacto");
    // Dia 3: o lote cancelado não volta a ser retomado.
    const t3 = Date.parse("2026-11-20T12:00:00Z");
    const third = claimFollowupLot(p, "form_lembrete", "2026-11-20", dia2, t3);
    assert.equal(third.lot!.lot_id, second.lot!.lot_id, "retoma o lote novo (pending), não o cancelado");
  });

  it("#13804: lista de hoje que contém a antiga segue retomando o mesmo lote", () => {
    const p = storeWithBlock();
    const first = claimFollowupLot(p, "form_lembrete", "2026-11-18", recips, Date.parse("2026-11-18T12:00:00Z"));
    const mais = [...(recips as unknown as object[]), { kit_subscriber_id: 3, email: "c@x.com" }] as never;
    const second = claimFollowupLot(p, "form_lembrete", "2026-11-19", mais, Date.parse("2026-11-19T12:00:00Z"));
    assert.equal(second.action, "recreate_after_timeout");
    assert.equal(second.lot!.lot_id, first.lot!.lot_id);
    assert.deepEqual(second.lot!.recipient_subscription_ids, ["1", "2", "3"]);
  });

  it("findResumablePendingLot ignora outro kind e lote com broadcast", () => {
    const lot = { kind: "form", status: "pending", broadcast_id: null, created_at: "x" } as never;
    assert.equal(findResumablePendingLot({ a: lot }, "form_lembrete"), null);
    const withB = { kind: "form_lembrete", status: "pending", broadcast_id: 5, created_at: "x" } as never;
    assert.equal(findResumablePendingLot({ a: withB }, "form_lembrete"), null);
  });
});
