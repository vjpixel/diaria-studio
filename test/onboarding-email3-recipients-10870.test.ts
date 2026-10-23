/**
 * test/onboarding-email3-recipients-10870.test.ts (#10870)
 *
 * Regressão: o POST /emailCampaigns do e-mail 3 do onboarding mandava
 * `recipients: { lists: [id] }`. `lists` é o nome do campo na LEITURA da
 * campanha; na criação a Brevo exige `listIds` (ou `segmentIds`) e responde
 * 400 `Either the listIds or segmentIds are mandatory in recipients` — o
 * e-mail 3 falhou em rodadas seguidas e acendeu o alarme do #10603.
 *
 * Tudo via fetch mockado — nenhuma chamada real à Brevo.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertBrevoListId,
  buildEmail3Recipients,
  ensureD10List,
  scheduleEmail3Campaign,
} from "../scripts/onboarding-welcome-run.ts";
import type { OnboardingEntry } from "../scripts/lib/onboarding-store.ts";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/** Brevo mínima que valida `recipients` como a real. `listCreateBody` permite simular resposta sem id. */
function fakeBrevo(opts: { listCreateBody?: unknown; existingLists?: { id: unknown; name: string }[] } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, url, body });
    if (method === "GET" && url.includes("/contacts/lists")) return json(200, { lists: opts.existingLists ?? [] });
    if (method === "POST" && url.endsWith("/contacts/lists")) return json(201, opts.listCreateBody ?? { id: 321 });
    if (method === "POST" && url.endsWith("/contacts")) return json(201, { id: 1 });
    if (method === "POST" && url.endsWith("/emailCampaigns")) {
      const r = body.recipients as { listIds?: unknown; segmentIds?: unknown } | undefined;
      const ok =
        (Array.isArray(r?.listIds) && r!.listIds.length > 0) ||
        (Array.isArray(r?.segmentIds) && r!.segmentIds.length > 0);
      if (!ok) {
        return json(400, {
          code: "missing_parameter",
          message: "Either the listIds or segmentIds are mandatory in recipients",
        });
      }
      return json(201, { id: 777 });
    }
    return json(404, {});
  }) as typeof fetch;
  return { calls, campaignCalls: () => calls.filter((c) => c.url.endsWith("/emailCampaigns")) };
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

const NOW = Date.UTC(2026, 9, 23, 12, 5, 0) / 1000;

function run(entries: OnboardingEntry[]) {
  return scheduleEmail3Campaign({
    apiKey: "k",
    cfg: { d10_list_name: "Onboarding D10 sem abertura", d10_folder_id: 9 },
    sender: { email: "oi@diar.ia.br", name: "diar.ia.br" },
    snippet: { assunto: "e-mail 3", body: "<p>x</p>" },
    entries,
    nowSec: NOW,
    isoNow: new Date(NOW * 1000).toISOString(),
  });
}

describe("e-mail 3: recipients do POST /emailCampaigns (#10870)", () => {
  it("caminho feliz manda recipients.listIds com a lista do cohort (e nunca `lists`)", async () => {
    const brevo = fakeBrevo();
    const es = [entry("a1")];
    const r = await run(es);
    assert.equal(r.campaignId, 777);
    assert.equal(r.listId, 321);
    const [c] = brevo.campaignCalls();
    assert.deepEqual(c.body.recipients, { listIds: [321] });
    assert.equal(es[0].email3_state, "campaign_created");
  });

  it("id de lista ausente na criação falha explícito, antes de criar campanha", async () => {
    const brevo = fakeBrevo({ listCreateBody: {} });
    const es = [entry("a1")];
    await assert.rejects(run(es), /lista D\+10 não resolvida.*POST \/contacts\/lists/);
    assert.equal(brevo.campaignCalls().length, 0, "nenhuma campanha sem lista");
    assert.equal(es[0].email3_state, "pending", "entrada não é marcada");
  });

  it("lista existente com id inválido falha explícito", async () => {
    const name = "Onboarding D10 sem abertura 2026-10-23 12:05:00";
    const brevo = fakeBrevo({ existingLists: [{ id: null, name }] });
    await assert.rejects(run([entry("a1")]), /lista D\+10 não resolvida.*GET \/contacts\/lists/);
    assert.equal(brevo.campaignCalls().length, 0);
  });

  it("cohort vazio não cria lista nem campanha", async () => {
    const brevo = fakeBrevo();
    await assert.rejects(run([]), /cohort vazio/);
    assert.equal(brevo.calls.length, 0);
  });

  it("ensureD10List devolve o id criado quando válido", async () => {
    fakeBrevo({ listCreateBody: { id: 55 } });
    assert.equal(await ensureD10List({ apiKey: "k", listName: "X", folderId: 1 }), 55);
  });
});

describe("buildEmail3Recipients / assertBrevoListId (#10870)", () => {
  it("monta listIds", () => {
    assert.deepEqual(buildEmail3Recipients(12), { listIds: [12] });
  });

  for (const bad of [undefined, null, 0, -1, 1.5, "12", Number.NaN]) {
    it(`recusa id ${JSON.stringify(bad)}`, () => {
      assert.throws(() => assertBrevoListId(bad, "teste"), /lista D\+10 não resolvida — teste/);
    });
  }
});
