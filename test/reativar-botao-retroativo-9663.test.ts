/**
 * test/reativar-botao-retroativo-9663.test.ts (#9663 item 3)
 *
 * Reclassificação retroativa `self_confirmed_kit` → `self_confirmed_kit_botao`
 * via `campaignStats` da Brevo. Só testes com dado sintético e fetch mockado —
 * o script nunca é rodado contra a API real aqui.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReativarLink,
  findReativarClickBefore,
  selectRetroCandidates,
  campaignStatsWindow,
  applyRetroBotaoReclassification,
} from "../scripts/lib/reativar-botao-retroativo.ts";
import { planRetroReclassification } from "../scripts/reclassify-reativar-botao-retroativo.ts";
import type { BrevoDiariaContact, BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const LINK = "https://reativar.diaria.workers.dev/?email=a%40x.com&t=abc";

function contact(over: Partial<BrevoDiariaContact>): BrevoDiariaContact {
  return {
    email: "a@x.com",
    beehiiv_subscription_id: "kit:1",
    status: "promoted_beehiiv",
    opens_count: 1,
    sends_count: 3,
    last_open_rate: 0.3,
    added_at: "2026-09-10T00:00:00Z",
    last_evaluated_at: null,
    promoted_at: "2026-09-29T12:00:00Z",
    resolution_reason: "self_confirmed_kit",
    ...over,
  };
}

test("isReativarLink compara host, não substring", () => {
  assert.equal(isReativarLink(LINK), true);
  assert.equal(isReativarLink("https://diar.ia.br/?r=reativar.diaria.workers.dev"), false);
  assert.equal(isReativarLink("https://evil.com/reativar.diaria.workers.dev"), false);
  assert.equal(isReativarLink("não é url"), false);
  assert.equal(isReativarLink(undefined), false);
});

test("findReativarClickBefore: pega o clique mais antigo ≤ promoted_at; ignora depois/sem hora/outros links", () => {
  const stats = {
    clicked: [
      { campaignId: 1, links: [{ url: "https://outro.com/x", eventTime: "2026-09-25T10:00:00Z" }] },
      { campaignId: 2, links: [{ url: LINK, eventTime: "2026-09-28T10:00:00Z" }] },
      { campaignId: 3, links: [{ url: LINK, eventTime: "2026-09-27T10:00:00Z" }, { url: LINK }] },
      { campaignId: 4, links: [{ url: LINK, eventTime: "2026-10-01T10:00:00Z" }] },
    ],
  };
  assert.deepEqual(findReativarClickBefore(stats, "2026-09-29T12:00:00Z"), {
    url: LINK,
    eventTime: "2026-09-27T10:00:00Z",
    campaignId: 3,
  });
  assert.equal(findReativarClickBefore(stats, "2026-09-26T00:00:00Z"), null);
  assert.equal(findReativarClickBefore({}, "2026-09-29T12:00:00Z"), null);
  assert.equal(findReativarClickBefore(null, "2026-09-29T12:00:00Z"), null);
});

test("selectRetroCandidates: só promoted_beehiiv + self_confirmed_kit a partir de since", () => {
  const store: BrevoDiariaStore = {
    contacts: [
      contact({ email: "ok@x.com" }),
      contact({ email: "antigo@x.com", promoted_at: "2026-09-01T00:00:00Z" }),
      contact({ email: "botao@x.com", resolution_reason: "self_confirmed_kit_botao" }),
      contact({ email: "beehiiv@x.com", resolution_reason: "self_confirmed_beehiiv" }),
      contact({ email: "inbrevo@x.com", status: "in_brevo" }),
    ],
  };
  assert.deepEqual(selectRetroCandidates(store, "2026-09-16").map((c) => c.email), ["ok@x.com"]);
});

test("campaignStatsWindow: recorta em 90 dias e usa added_at quando mais recente", () => {
  assert.deepEqual(campaignStatsWindow("2026-09-10T00:00:00Z", "2026-09-29T12:00:00Z"), {
    startDate: "2026-09-10",
    endDate: "2026-09-29",
  });
  const w = campaignStatsWindow("2025-01-01T00:00:00Z", "2026-09-29T12:00:00Z");
  const days = (Date.parse(w.endDate) - Date.parse(w.startDate)) / 86_400_000;
  assert.ok(days <= 89, `janela de ${days} dias excede o limite da Brevo`);
});

test("applyRetroBotaoReclassification: reclassifica, marca reconciled_at, é idempotente", () => {
  const store: BrevoDiariaStore = { contacts: [contact({ email: "a@x.com" }), contact({ email: "b@x.com" })] };
  const r1 = applyRetroBotaoReclassification(store, ["A@x.com"], "2026-10-05T00:00:00Z");
  assert.equal(r1.changed, 1);
  assert.equal(r1.store.contacts[0].resolution_reason, "self_confirmed_kit_botao");
  assert.equal(r1.store.contacts[0].reconciled_at, "2026-10-05T00:00:00Z");
  assert.equal(r1.store.contacts[0].confirmou_via, undefined);
  assert.equal(r1.store.contacts[1].resolution_reason, "self_confirmed_kit");
  assert.equal(applyRetroBotaoReclassification(r1.store, ["a@x.com"]).changed, 0);
});

test("planRetroReclassification: clique → matched; 404 → notFound; erro de leitura NÃO vira 'não clicou'", async () => {
  const store: BrevoDiariaStore = {
    contacts: [contact({ email: "clicou@x.com" }), contact({ email: "sumiu@x.com" }), contact({ email: "erro@x.com" }), contact({ email: "doi@x.com" })],
  };
  const windows: string[] = [];
  const out = await planRetroReclassification({
    store,
    since: "2026-09-16",
    log: () => {},
    fetchStats: async (email, s, e) => {
      windows.push(`${s}..${e}`);
      if (email === "clicou@x.com") return { clicked: [{ campaignId: 9, links: [{ url: LINK, eventTime: "2026-09-28T10:00:00Z" }] }] };
      if (email === "sumiu@x.com") return null;
      if (email === "erro@x.com") throw new Error("429");
      return { clicked: [] };
    },
  });
  assert.equal(out.candidates, 4);
  assert.deepEqual(out.matched.map((m) => m.email), ["clicou@x.com"]);
  assert.deepEqual(out.notFound, ["sumiu@x.com"]);
  assert.deepEqual(out.errors.map((e) => e.email), ["erro@x.com"]);
  assert.ok(windows.every((w) => w === "2026-09-10..2026-09-29"));
});
