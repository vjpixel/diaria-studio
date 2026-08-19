/**
 * test/clarice-overlap-5697.test.ts (#5697)
 *
 * Cobertura pura (sem rede) de `findOverlappingListCampaigns` —
 * `scripts/lib/clarice-overlap.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findOverlappingListCampaigns } from "../scripts/lib/clarice-overlap.ts";
import type { BrevoDraftCampaignRaw } from "../scripts/lib/brevo-client.ts";

function campaign(p: Partial<BrevoDraftCampaignRaw> & { id: number }): BrevoDraftCampaignRaw {
  return { name: `campanha ${p.id}`, status: "sent", sentDate: null, recipients: undefined, ...p };
}

describe("findOverlappingListCampaigns (#5697)", () => {
  it("nenhuma sobreposição quando cada lista alimenta só 1 campanha", () => {
    const campaigns = [
      campaign({ id: 1, recipients: { lists: [10] } }),
      campaign({ id: 2, recipients: { lists: [11] } }),
    ];
    assert.deepEqual(findOverlappingListCampaigns(campaigns), []);
  });

  it("detecta lista alimentando 2 campanhas sent distintas", () => {
    const campaigns = [
      campaign({ id: 1, name: "d1-seg", sentDate: "2026-08-01T10:00:00Z", recipients: { lists: [72] } }),
      campaign({ id: 2, name: "d1-seg-reenvio", sentDate: "2026-08-02T10:00:00Z", recipients: { lists: [72] } }),
    ];
    const overlaps = findOverlappingListCampaigns(campaigns);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].listId, "72");
    assert.equal(overlaps[0].campaigns.length, 2);
    assert.deepEqual(
      overlaps[0].campaigns.map((c) => c.id),
      [1, 2],
    );
  });

  it("campanha sem recipients.lists não quebra (tratada como vazio)", () => {
    const campaigns = [campaign({ id: 1 }), campaign({ id: 2, recipients: { lists: [5] } })];
    assert.deepEqual(findOverlappingListCampaigns(campaigns), []);
  });

  it("3 campanhas na mesma lista => 1 overlap com 3 campanhas", () => {
    const campaigns = [1, 2, 3].map((id) => campaign({ id, recipients: { lists: [99] } }));
    const overlaps = findOverlappingListCampaigns(campaigns);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].campaigns.length, 3);
  });

  it("filtro --since/--until: exclui campanhas fora da janela", () => {
    const campaigns = [
      campaign({ id: 1, sentDate: "2026-07-15T00:00:00Z", recipients: { lists: [72] } }), // fora (antes)
      campaign({ id: 2, sentDate: "2026-08-05T00:00:00Z", recipients: { lists: [72] } }), // dentro
      campaign({ id: 3, sentDate: "2026-08-10T00:00:00Z", recipients: { lists: [72] } }), // dentro
      campaign({ id: 4, sentDate: "2026-09-01T00:00:00Z", recipients: { lists: [72] } }), // fora (depois)
    ];
    const overlaps = findOverlappingListCampaigns(campaigns, { since: "2026-08-01", until: "2026-08-31" });
    assert.equal(overlaps.length, 1);
    assert.deepEqual(
      overlaps[0].campaigns.map((c) => c.id),
      [2, 3],
    );
  });

  it("filtro de período ativo: campanha sem sentDate é excluída (não dá pra confirmar a janela)", () => {
    const campaigns = [
      campaign({ id: 1, sentDate: null, recipients: { lists: [72] } }),
      campaign({ id: 2, sentDate: "2026-08-05T00:00:00Z", recipients: { lists: [72] } }),
    ];
    const overlaps = findOverlappingListCampaigns(campaigns, { since: "2026-08-01" });
    // só a #2 sobrevive ao filtro => lista 72 fica com 1 campanha só => sem overlap
    assert.deepEqual(overlaps, []);
  });

  it("sem filtro de período, campanha sem sentDate participa normalmente", () => {
    const campaigns = [
      campaign({ id: 1, sentDate: null, recipients: { lists: [72] } }),
      campaign({ id: 2, sentDate: null, recipients: { lists: [72] } }),
    ];
    const overlaps = findOverlappingListCampaigns(campaigns);
    assert.equal(overlaps.length, 1);
  });

  it("lista vazia de campanhas => sem overlaps, sem lançar", () => {
    assert.deepEqual(findOverlappingListCampaigns([]), []);
  });
});
