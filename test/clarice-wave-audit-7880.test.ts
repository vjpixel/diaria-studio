/**
 * test/clarice-wave-audit-7880.test.ts (#7880)
 *
 * Cobertura pura (sem rede) de `scripts/lib/clarice-wave-audit.ts` —
 * `monthWindowIso`, `buildLiveListIndex`, `mergeLiveListIndexes`,
 * `findWaveListCollisions`. Cobre em especial a armadilha documentada na
 * issue (#7880): campanha `suspended` com data fictícia (`2035-01-01`) NUNCA
 * deve contar como colisão — reproduzida aqui como "o índice é construído só
 * a partir de campanhas já filtradas por status=sent/status=queued", nunca
 * de uma lista bruta que incluísse `suspended`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  monthWindowIso,
  buildLiveListIndex,
  mergeLiveListIndexes,
  findWaveListCollisions,
  type WaveContact,
} from "../scripts/lib/clarice-wave-audit.ts";
import type { BrevoDraftCampaignRaw } from "../scripts/lib/brevo-client.ts";

function campaign(p: Partial<BrevoDraftCampaignRaw> & { id: number }): BrevoDraftCampaignRaw {
  return { name: `campanha ${p.id}`, status: "sent", recipients: undefined, ...p };
}

describe("monthWindowIso (#7880)", () => {
  it("YYYY-MM válido => janela [1º dia 00:00 UTC, 1º dia do mês seguinte)", () => {
    const w = monthWindowIso("2026-09");
    assert.equal(w.startIso, "2026-09-01T00:00:00.000Z");
    assert.equal(w.endIsoExclusive, "2026-10-01T00:00:00.000Z");
  });

  it("rollover dezembro => janeiro do ano seguinte", () => {
    const w = monthWindowIso("2026-12");
    assert.equal(w.startIso, "2026-12-01T00:00:00.000Z");
    assert.equal(w.endIsoExclusive, "2027-01-01T00:00:00.000Z");
  });

  it("formato inválido lança", () => {
    assert.throws(() => monthWindowIso("2026-9"), /inválido/);
    assert.throws(() => monthWindowIso("set-2026"), /inválido/);
  });

  it("mês fora de 01-12 lança", () => {
    assert.throws(() => monthWindowIso("2026-13"), /inválido/);
    assert.throws(() => monthWindowIso("2026-00"), /inválido/);
  });
});

describe("buildLiveListIndex (#7880)", () => {
  const window = monthWindowIso("2026-09");

  it("indexa campanha sent dentro da janela por list_id", () => {
    const campaigns = [
      campaign({ id: 1, sentDate: "2026-09-10T00:00:00Z", recipients: { lists: [72] } }),
    ];
    const idx = buildLiveListIndex(campaigns, "sent", window);
    assert.deepEqual([...idx.keys()], ["72"]);
    assert.equal(idx.get("72")![0].id, 1);
    assert.equal(idx.get("72")![0].status, "sent");
  });

  it("usa scheduledAt (não sentDate) pra status=queued", () => {
    const campaigns = [
      campaign({ id: 2, status: "queued", sentDate: null, scheduledAt: "2026-09-15T00:00:00Z", recipients: { lists: [88] } }),
    ];
    const idx = buildLiveListIndex(campaigns, "queued", window);
    assert.deepEqual([...idx.keys()], ["88"]);
    assert.equal(idx.get("88")![0].date, "2026-09-15T00:00:00Z");
  });

  it("campanha fora da janela do mês é excluída", () => {
    const campaigns = [
      campaign({ id: 1, sentDate: "2026-08-31T23:59:59Z", recipients: { lists: [72] } }), // antes
      campaign({ id: 2, sentDate: "2026-10-01T00:00:00Z", recipients: { lists: [73] } }), // depois (exclusive)
      campaign({ id: 3, sentDate: "2026-09-30T23:59:59Z", recipients: { lists: [74] } }), // dentro, borda
    ];
    const idx = buildLiveListIndex(campaigns, "sent", window);
    assert.deepEqual([...idx.keys()], ["74"]);
  });

  it("campanha sem a data relevante é excluída (não dá pra confirmar a janela)", () => {
    const campaigns = [campaign({ id: 1, sentDate: null, recipients: { lists: [72] } })];
    const idx = buildLiveListIndex(campaigns, "sent", window);
    assert.equal(idx.size, 0);
  });

  it("armadilha do #7880: campanha suspended com data FICTÍCIA de 2035 nunca chega aqui — quem chama só busca status=sent/status=queued", () => {
    // Simula o que aconteceria SE uma campanha suspended vazasse pro array
    // (o que fetchCampaignsByStatus nunca faz, pois filtra por status na
    // própria query — mas este teste documenta que MESMO se vazasse, cairia
    // fora de qualquer janela de mês real que um operador passaria).
    const suspendedLeaked = campaign({
      id: 99,
      status: "suspended",
      sentDate: null,
      scheduledAt: "2035-01-01T00:00:00Z",
      recipients: { lists: [62] },
    });
    const idx = buildLiveListIndex([suspendedLeaked], "queued", window);
    assert.equal(idx.size, 0, "2035 nunca cai dentro da janela de 2026-09");
  });

  it("--exclude-list remove a lista da PRÓPRIA onda do índice", () => {
    const campaigns = [
      campaign({ id: 1, sentDate: "2026-09-10T00:00:00Z", recipients: { lists: [72, 73] } }),
    ];
    const idx = buildLiveListIndex(campaigns, "sent", window, new Set(["72"]));
    assert.deepEqual([...idx.keys()], ["73"]);
  });

  it("lista vazia de campanhas => índice vazio, sem lançar", () => {
    assert.equal(buildLiveListIndex([], "sent", window).size, 0);
  });
});

describe("mergeLiveListIndexes (#7880)", () => {
  it("une sent+queued sem mutar nenhum dos dois, concatenando por chave comum", () => {
    const a = new Map([["72", [{ id: 1, name: "a", status: "sent" }]]]);
    const b = new Map([
      ["72", [{ id: 2, name: "b", status: "queued" }]],
      ["88", [{ id: 3, name: "c", status: "queued" }]],
    ]);
    const merged = mergeLiveListIndexes(a, b);
    assert.equal(merged.get("72")!.length, 2);
    assert.equal(merged.get("88")!.length, 1);
    // não mutou os originais
    assert.equal(a.get("72")!.length, 1);
    assert.equal(b.get("72")!.length, 1);
  });
});

describe("findWaveListCollisions (#7880)", () => {
  const window = monthWindowIso("2026-09");

  it("contato cujo brevo_list_ids intersecta o índice => colisão", () => {
    const idx = buildLiveListIndex(
      [campaign({ id: 1, name: "d10-set", sentDate: "2026-09-05T00:00:00Z", recipients: { lists: [72] } })],
      "sent",
      window,
    );
    const contacts: WaveContact[] = [
      { email: "colide@x.com", brevo_list_ids: JSON.stringify([72, 999]) },
      { email: "livre@x.com", brevo_list_ids: JSON.stringify([50]) },
    ];
    const collisions = findWaveListCollisions(contacts, idx);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].email, "colide@x.com");
    assert.deepEqual(collisions[0].listIds, ["72"]);
    assert.equal(collisions[0].campaigns[0].name, "d10-set");
  });

  it("contato sem brevo_list_ids (null) nunca colide, nunca lança", () => {
    const idx = buildLiveListIndex(
      [campaign({ id: 1, sentDate: "2026-09-05T00:00:00Z", recipients: { lists: [72] } })],
      "sent",
      window,
    );
    const collisions = findWaveListCollisions([{ email: "sem-lista@x.com", brevo_list_ids: null }], idx);
    assert.deepEqual(collisions, []);
  });

  it("brevo_list_ids corrompido (JSON inválido) é tratado como [] — nunca lança", () => {
    const idx = buildLiveListIndex(
      [campaign({ id: 1, sentDate: "2026-09-05T00:00:00Z", recipients: { lists: [72] } })],
      "sent",
      window,
    );
    assert.doesNotThrow(() =>
      findWaveListCollisions([{ email: "corrompido@x.com", brevo_list_ids: "{{{not json" }], idx),
    );
  });

  it("índice vazio => nunca colide (short-circuit sem custo)", () => {
    const collisions = findWaveListCollisions(
      [{ email: "x@x.com", brevo_list_ids: JSON.stringify([72]) }],
      new Map(),
    );
    assert.deepEqual(collisions, []);
  });

  it("dedup de campanhas quando o mesmo contato colide em 2 listas alimentadas pela MESMA campanha", () => {
    const idx = buildLiveListIndex(
      [campaign({ id: 1, sentDate: "2026-09-05T00:00:00Z", recipients: { lists: [72, 73] } })],
      "sent",
      window,
    );
    const collisions = findWaveListCollisions(
      [{ email: "duas-listas@x.com", brevo_list_ids: JSON.stringify([72, 73]) }],
      idx,
    );
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].campaigns.length, 1, "mesma campanha (#1) não deve aparecer 2×");
  });
});
