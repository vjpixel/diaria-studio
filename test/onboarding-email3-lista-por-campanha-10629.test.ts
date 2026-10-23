/**
 * test/onboarding-email3-lista-por-campanha-10629.test.ts (#10629)
 *
 * Regressão: o nome da lista D+10 levava só a DATA (`... 2026-10-21`) e
 * `ensureD10List` reusa lista por nome. Uma 2ª rodada `--send` no mesmo dia
 * punha o cohort B na lista do cohort A, e a campanha 2 (que mira a lista
 * inteira) reenviava o e-mail 3 ao cohort A.
 *
 * O mock da Brevo guarda a lista por nome e os membros de cada lista, como a
 * Brevo real faz: o teste falha no código antigo (as duas campanhas miram a
 * mesma lista com A+B) e passa com uma lista por campanha.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { d10ListNameFor, scheduleEmail3Campaign } from "../scripts/onboarding-welcome-run.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Brevo em memória: listas por nome, membros por lista, campanhas com a lista-alvo. */
function fakeBrevo() {
  const lists: { id: number; name: string }[] = [];
  const members = new Map<number, Set<string>>();
  const campaigns: { id: number; listIds: number[] }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "GET" && url.includes("/contacts/lists")) return json(200, { lists });
    if (method === "POST" && url.endsWith("/contacts/lists")) {
      const id = 100 + lists.length;
      lists.push({ id, name: String(body.name) });
      members.set(id, new Set());
      return json(201, { id });
    }
    if (method === "POST" && url.endsWith("/contacts")) {
      for (const id of body.listIds as number[]) members.get(id)!.add(String(body.email));
      return json(201, { id: 1 });
    }
    if (method === "POST" && url.endsWith("/emailCampaigns")) {
      const id = 900 + campaigns.length;
      // #10870: como a Brevo real, só `listIds` conta na criação.
      const listIds = (body.recipients as { listIds?: number[] } | undefined)?.listIds;
      if (!Array.isArray(listIds) || listIds.length === 0) {
        return json(400, { code: "missing_parameter", message: "Either the listIds or segmentIds are mandatory in recipients" });
      }
      campaigns.push({ id, listIds });
      return json(201, { id });
    }
    return json(404, {});
  }) as typeof fetch;
  const recipientsOf = (campaignIdx: number) =>
    [...new Set(campaigns[campaignIdx].listIds.flatMap((l) => [...(members.get(l) ?? [])]))].sort();
  return { lists, campaigns, recipientsOf };
}

function entry(id: string): OnboardingEntry {
  return {
    subscription_id: id,
    email: `${id}@example.com`,
    status_detectado: "active",
    created_at: 0,
    detected_at: "2026-10-11T00:00:00.000Z",
    email1_sent_at: "2026-10-11T00:00:00.000Z",
    email1_brevo_id: null,
    email2_sent_at: "2026-10-14T00:00:00.000Z",
    email2_brevo_id: null,
    email3_state: "pending",
    email3_campaign_id: null,
    email3_decided_at: null,
  };
}

const MORNING = Date.UTC(2026, 9, 21, 12, 5, 0) / 1000; // 09:05 BRT
const AFTERNOON = Date.UTC(2026, 9, 21, 18, 30, 0) / 1000; // reexecução no mesmo dia

async function run(entries: OnboardingEntry[], nowSec: number) {
  return scheduleEmail3Campaign({
    apiKey: "k",
    cfg: { d10_list_name: "Onboarding D10 sem abertura", d10_folder_id: 9 },
    sender: { email: "oi@diar.ia.br", name: "diar.ia.br" },
    snippet: { assunto: "e-mail 3", body: "<p>x</p>" },
    entries,
    nowSec,
    isoNow: new Date(nowSec * 1000).toISOString(),
  });
}

describe("e-mail 3 Brevo: duas rodadas no mesmo dia (#10629)", () => {
  it("a 2ª campanha alcança só o cohort novo — o cohort anterior não recebe de novo", async () => {
    const brevo = fakeBrevo();
    const a = [entry("a1"), entry("a2")];
    const b = [entry("b1")];

    const r1 = await run(a, MORNING);
    const r2 = await run(b, AFTERNOON);

    assert.notEqual(r1.listId, r2.listId, "cada campanha tem a própria lista");
    assert.deepEqual(brevo.recipientsOf(0), ["a1@example.com", "a2@example.com"]);
    assert.deepEqual(brevo.recipientsOf(1), ["b1@example.com"]);
    assert.equal(new Set(brevo.lists.map((l) => l.name)).size, 2);
  });

  it("marca as entradas como campaign_created com o id da própria campanha", async () => {
    fakeBrevo();
    const a = [entry("a1")];
    const b = [entry("b1")];
    const r1 = await run(a, MORNING);
    const r2 = await run(b, AFTERNOON);
    assert.equal(a[0].email3_state, "campaign_created");
    assert.equal(a[0].email3_campaign_id, r1.campaignId);
    assert.equal(b[0].email3_campaign_id, r2.campaignId);
    assert.ok(a[0].email3_scheduled_at);
  });
});

describe("d10ListNameFor (#10629)", () => {
  it("leva data e hora UTC até o segundo", () => {
    assert.equal(d10ListNameFor("Onboarding D10", MORNING), "Onboarding D10 2026-10-21 12:05:00");
  });

  it("mesmo dia, horários diferentes → nomes diferentes", () => {
    assert.notEqual(d10ListNameFor("X", MORNING), d10ListNameFor("X", AFTERNOON));
  });

  it("sem nome configurado usa o default", () => {
    assert.match(d10ListNameFor(undefined, MORNING), /^Onboarding D10 sem abertura 2026-10-21 /);
  });
});
