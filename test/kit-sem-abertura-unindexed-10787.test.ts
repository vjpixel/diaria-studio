/**
 * test/kit-sem-abertura-unindexed-10787.test.ts (#10787)
 *
 * O `/subscribers/filter` do Kit já devolveu 0 sent/opens num broadcast
 * segmentado (26499469) ~17h depois do envio, e os números certos ~22h depois
 * (#10697). O caso perigoso é o parcial: entregues já indexados e aberturas
 * ainda não. Sem guard, cada entregue daquele envio ganhava 1 envio maduro
 * sem abertura e podia cruzar o piso de `min_mature_sends`, sendo movido pra
 * Brevo mesmo tendo aberto. E um broadcast lido vazio aos 7 dias congelava no
 * cache (#10514) e nunca mais era relido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { partitionIndexedEngagement, type BroadcastEngagement } from "../scripts/lib/kit-sem-abertura.ts";
import {
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import type { KitEngagementCache } from "../scripts/lib/kit-engagement-cache.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OUTRO = "leitor-fora-da-base@x.com";

describe("partitionIndexedEngagement (#10787)", () => {
  it("entregues com abertura ou clique é indexado; sem nenhum dos dois, ou sem entregues, não", () => {
    const per: BroadcastEngagement[] = [
      { broadcastId: 1, delivered: ["a@x.com"], opens: ["a@x.com"], clicks: [] },
      { broadcastId: 2, delivered: ["a@x.com"], opens: [], clicks: ["a@x.com"] },
      { broadcastId: 3, delivered: ["a@x.com"], opens: [], clicks: [] },
      { broadcastId: 4, delivered: [], opens: [], clicks: [] },
      { broadcastId: 5, delivered: [], opens: ["b@x.com"], clicks: [] },
    ];
    const { usable, unindexedIds } = partitionIndexedEngagement(per);
    assert.deepEqual(unindexedIds, [3, 4, 5]);
    assert.deepEqual(usable.map((b) => [b.broadcastId, b.delivered.length]), [[1, 1], [2, 1], [3, 0], [4, 0], [5, 0]]);
    assert.deepEqual(usable.find((b) => b.broadcastId === 5)!.opens, ["b@x.com"], "abertura avulsa segue contando (só tira gente)");
    assert.deepEqual(per[2].delivered, ["a@x.com"], "não muta a entrada");
  });
});

function cfg(): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: 295, kit_sem_abertura: { enabled: true } },
    kit: { diaria_exclusion_segment: { enabled: true, segment_id: 99 } },
  };
}

/**
 * 6 broadcasts maduros (= piso default). `leu@x.com` recebeu os 6 e abriu só
 * o 6º; `nunca@x.com` recebeu os 6 e não abriu nada. O 6º chega com as
 * aberturas ainda não indexadas quando `partialLast`.
 */
function deps(opts: { partialLast: boolean; ageDays?: number; cache?: { value: unknown } }) {
  const people = [
    { id: 1, email: "leu@x.com", created_at: "2026-01-01T00:00:00.000Z", tagNames: [] as string[] },
    { id: 2, email: "nunca@x.com", created_at: "2026-01-01T00:00:00.000Z", tagNames: [] as string[] },
  ];
  const age = opts.ageDays ?? 3;
  const records = [1, 2, 3, 4, 5, 6].map((i) => ({
    broadcastId: i,
    sentAt: new Date(NOW - (age + 6 - i) * DAY).toISOString(),
    edition: `e${i}`,
  }));
  const lines: string[] = [];
  let store: BrevoDiariaStore = { contacts: [] };
  const d: KitSemAberturaDeps = {
    nowMs: NOW,
    log: (m) => lines.push(m),
    readRegistry: () => records,
    listKitActive: async () => people.map((p) => ({ ...p })),
    fetchEngagement: async (id) => {
      const delivered = people.map((p) => p.email);
      if (id === 6) {
        return opts.partialLast
          ? { broadcastId: id, delivered, opens: [], clicks: [] }
          : { broadcastId: id, delivered, opens: ["leu@x.com", OUTRO], clicks: [] };
      }
      return { broadcastId: id, delivered, opens: [OUTRO], clicks: [] };
    },
    ...(opts.cache
      ? { engagementCache: { read: () => opts.cache!.value, write: (c: KitEngagementCache) => void (opts.cache!.value = JSON.parse(JSON.stringify(c))) } }
      : {}),
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => {
      store = s;
    },
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async () => null,
    isBrevoBlacklisted: async () => false,
    ingestBrevo: async () => {},
    tagKit: async () => {},
    untagKit: async () => {},
    appendLog: () => {},
  };
  return { d, lines };
}

describe("runKitSemAberturaSync com broadcast parcialmente indexado (#10787)", () => {
  it("aberturas ainda não indexadas no 6º envio ⇒ ele não soma envio a ninguém", async () => {
    const { d, lines } = deps({ partialLast: true });
    const r = await runKitSemAberturaSync(cfg(), { push: false }, d);
    // Sem o guard, `leu@x.com` (e `nunca@x.com`) teriam 6 envios maduros e 0
    // aberturas — a do 6º ainda não indexada — e os dois seriam selecionados.
    assert.equal(r.selected, 0, "com 5 envios indexados ninguém cruza o piso de 6");
    assert.ok(lines.some((l) => l.includes("ainda não indexado") && l.includes("(6)")), lines.join("\n"));
  });

  it("com o 6º indexado, quem abriu fica fora e o aviso não aparece", async () => {
    const { d, lines } = deps({ partialLast: false });
    const r = await runKitSemAberturaSync(cfg(), { push: false }, d);
    assert.equal(r.selected, 1, "só nunca@x.com");
    assert.ok(!lines.some((l) => l.includes("ainda não indexado")));
  });

  it("broadcast lido não indexado aos >= 7 dias não congela no cache (é relido depois)", async () => {
    const cache = { value: null as unknown };
    const { d } = deps({ partialLast: true, ageDays: 10, cache });
    await runKitSemAberturaSync(cfg(), { push: false }, d);
    const frozen = (cache.value as KitEngagementCache).frozen_ids;
    assert.deepEqual(frozen, [1, 2, 3, 4, 5], "o 6º fica fora do cache");
  });
});
