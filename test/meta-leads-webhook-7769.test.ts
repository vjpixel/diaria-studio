/**
 * test/meta-leads-webhook-7769.test.ts (#7769)
 *
 * Cobre o worker `meta-leads` (ponte Meta Lead Ads → Kit): handshake de
 * verificação, validação de assinatura, parse do payload, normalização do
 * lead e criação no Kit. Mock de fetch, sem rede real (#633).
 *
 * O foco dos casos é o que o worker promete que NÃO acontece: lead não
 * some em silêncio. Por isso há teste explícito pra cada caminho de falha
 * devolver não-200 (pedido de reentrega à Meta) em vez de 200.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLeadFields,
  isEmailLike,
  parseLeadgenPayload,
  resolveVerification,
  verifySignature,
  META_INSTANT_FORM_UTM,
} from "../workers/meta-leads/src/leadgen.ts";
import { handleWebhookPost, processLead, type Env } from "../workers/meta-leads/src/index.ts";

const APP_SECRET = "test-app-secret";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    META_APP_SECRET: APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: "verify-me",
    META_LEADS_PAGE_ACCESS_TOKEN: "page-token",
    KIT_API_KEY: "kit-key",
    META_GRAPH_API_URL: "https://graph.test/v25.0",
    KIT_API_URL: "https://kit.test/v4",
    KIT_UTM_SOURCE_FIELD: "utm_source",
    KIT_UTM_MEDIUM_FIELD: "utm_medium",
    KIT_UTM_CAMPAIGN_FIELD: "utm_campaign",
    KIT_REFERRING_SITE_FIELD: "referring_site",
    KIT_ORIGEM_CADASTRO_FIELD: "origem_cadastro",
    ...overrides,
  };
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function leadgenBody(leadgenId = "LEAD1"): string {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: "PAGE1",
        time: 1757000000,
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: leadgenId,
              form_id: "FORM1",
              ad_id: "AD1",
              page_id: "PAGE1",
              created_time: 1757000000,
            },
          },
        ],
      },
    ],
  });
}

type Call = { url: string; init?: RequestInit };
function makeFetchMock(opts: { graphStatus?: number; kitStatus?: number; fieldData?: unknown } = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith("https://graph.test")) {
      const status = opts.graphStatus ?? 200;
      if (status !== 200) return new Response("graph boom", { status });
      return new Response(
        JSON.stringify({
          id: "LEAD1",
          field_data: opts.fieldData ?? [
            { name: "email", values: ["leitor@example.com"] },
            { name: "full_name", values: ["Maria Silva"] },
          ],
        }),
        { status: 200 },
      );
    }
    const status = opts.kitStatus ?? 201;
    if (status >= 400) return new Response("kit boom", { status });
    return new Response(JSON.stringify({ subscriber: { id: 42 } }), { status });
  }) as typeof fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

function postRequest(body: string, signature: string): Request {
  return new Request("https://meta-leads.test/webhook", {
    method: "POST",
    headers: { "X-Hub-Signature-256": signature, "Content-Type": "application/json" },
    body,
  });
}

describe("resolveVerification — handshake GET", () => {
  it("ecoa o challenge quando o token bate", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-me",
      "hub.challenge": "1234567890",
    });
    const r = resolveVerification(params, "verify-me");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.challenge, "1234567890");
  });

  it("recusa com 403 quando o token não bate", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "errado",
      "hub.challenge": "x",
    });
    const r = resolveVerification(params, "verify-me");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 403);
  });

  it("responde 503 sem token configurado — nunca aceita qualquer subscrição", () => {
    // Guard: um worker sem token que passasse direto deixaria qualquer um
    // apontar uma subscrição de webhook pra este endpoint.
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "qualquer-coisa",
      "hub.challenge": "x",
    });
    const r = resolveVerification(params, undefined);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 503);
  });

  it("recusa modo diferente de subscribe", () => {
    const params = new URLSearchParams({ "hub.mode": "unsubscribe", "hub.verify_token": "verify-me" });
    const r = resolveVerification(params, "verify-me");
    assert.equal(r.ok, false);
  });
});

describe("verifySignature", () => {
  it("aceita assinatura correta do corpo cru", async () => {
    const body = leadgenBody();
    assert.equal(await verifySignature(body, await sign(body), APP_SECRET), true);
  });

  it("recusa assinatura de outro segredo", async () => {
    const body = leadgenBody();
    assert.equal(await verifySignature(body, await sign(body, "outro"), APP_SECRET), false);
  });

  it("recusa quando o corpo muda um byte", async () => {
    const signature = await sign(leadgenBody("LEAD1"));
    assert.equal(await verifySignature(leadgenBody("LEAD2"), signature, APP_SECRET), false);
  });

  it("recusa sem App Secret configurado", async () => {
    const body = leadgenBody();
    assert.equal(await verifySignature(body, await sign(body), undefined), false);
  });

  it("recusa header sem o prefixo sha256=", async () => {
    const body = leadgenBody();
    const raw = (await sign(body)).slice("sha256=".length);
    assert.equal(await verifySignature(body, raw, APP_SECRET), false);
  });
});

describe("parseLeadgenPayload", () => {
  it("extrai leadgen_id, form_id e ad_id", () => {
    const notes = parseLeadgenPayload(leadgenBody("LEAD9"));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].leadgenId, "LEAD9");
    assert.equal(notes[0].formId, "FORM1");
    assert.equal(notes[0].adId, "AD1");
  });

  it("extrai vários leads de várias entries", () => {
    const body = JSON.stringify({
      entry: [
        { changes: [{ field: "leadgen", value: { leadgen_id: "A" } }, { field: "leadgen", value: { leadgen_id: "B" } }] },
        { changes: [{ field: "leadgen", value: { leadgen_id: "C" } }] },
      ],
    });
    assert.deepEqual(parseLeadgenPayload(body).map((n) => n.leadgenId), ["A", "B", "C"]);
  });

  it("ignora change de campo que não seja leadgen", () => {
    const body = JSON.stringify({ entry: [{ changes: [{ field: "feed", value: { post_id: "X" } }] }] });
    assert.deepEqual(parseLeadgenPayload(body), []);
  });

  it("devolve vazio (nunca lança) para JSON malformado", () => {
    assert.deepEqual(parseLeadgenPayload("{nao é json"), []);
  });
});

describe("extractLeadFields", () => {
  it("lê email e full_name canônicos", () => {
    const r = extractLeadFields({
      field_data: [
        { name: "email", values: ["a@b.com"] },
        { name: "full_name", values: ["Ana Souza"] },
      ],
    });
    assert.deepEqual(r, { email: "a@b.com", name: "Ana Souza" });
  });

  it("monta o nome de first_name + last_name", () => {
    const r = extractLeadFields({
      field_data: [
        { name: "email", values: ["a@b.com"] },
        { name: "first_name", values: ["Ana"] },
        { name: "last_name", values: ["Souza"] },
      ],
    });
    assert.equal(r.name, "Ana Souza");
  });

  it("acha o e-mail mesmo se o formulário nomeou o campo de outro jeito", () => {
    // O nome da chave varia conforme o formulário foi montado no painel —
    // um campo com pergunta customizada não pode silenciar o cadastro.
    const r = extractLeadFields({
      field_data: [{ name: "qual_seu_melhor_email", values: ["c@d.com"] }],
    });
    assert.equal(r.email, "c@d.com");
  });

  it("devolve vazio para payload sem field_data", () => {
    assert.deepEqual(extractLeadFields({}), { email: "", name: "" });
  });
});

describe("isEmailLike", () => {
  it("aceita e-mail comum", () => {
    assert.equal(isEmailLike("leitor@diar.ia.br"), true);
  });

  for (const bad of ["", "sem-arroba", "a@b", "a@@b.com", "com espaco@b.com", "a@.com", "a@b."]) {
    it(`recusa ${JSON.stringify(bad)}`, () => {
      assert.equal(isEmailLike(bad), false);
    });
  }
});

describe("handleWebhookPost", () => {
  it("cria o subscriber no Kit com a atribuição do formulário instantâneo", async () => {
    const body = leadgenBody();
    const fetchMock = makeFetchMock();
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: fetchMock });

    assert.equal(res.status, 200);
    const kitCall = fetchMock.calls.find((c) => c.url.startsWith("https://kit.test"));
    assert.ok(kitCall, "deveria ter chamado o Kit");
    const sent = JSON.parse(String(kitCall.init?.body));
    assert.equal(sent.email_address, "leitor@example.com");
    assert.equal(sent.state, "active");
    assert.equal(sent.fields.utm_source, META_INSTANT_FORM_UTM.source);
    assert.equal(sent.fields.utm_campaign, META_INSTANT_FORM_UTM.campaign);
    // O campo que separa lead de formulário instantâneo de quem converteu
    // no site — os dois vêm da MESMA campanha e do mesmo utm_source.
    assert.equal(sent.fields.referring_site, "meta-instant-form");
    assert.equal(sent.fields.origem_cadastro, "kit-nativo");
    assert.equal((kitCall.init?.headers as Record<string, string>)["X-Kit-Api-Key"], "kit-key");
  });

  it("recusa com 403 e não chama nada quando a assinatura é inválida", async () => {
    const fetchMock = makeFetchMock();
    const res = await handleWebhookPost(
      postRequest(leadgenBody(), "sha256=deadbeef"),
      baseEnv(),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 403);
    assert.equal(fetchMock.calls.length, 0);
  });

  it("responde 500 (pede reentrega) quando a Graph falha", async () => {
    // O ponto do worker: falha vira retry da Meta, nunca 200 silencioso.
    const body = leadgenBody();
    const fetchMock = makeFetchMock({ graphStatus: 500 });
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 500);
  });

  it("responde 500 (pede reentrega) quando o Kit rejeita", async () => {
    const body = leadgenBody();
    const fetchMock = makeFetchMock({ kitStatus: 422 });
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 500);
  });

  it("responde 500 quando falta KIT_API_KEY — nunca 200 fail-soft", async () => {
    // Divergência deliberada do resto do repo: secret ausente aqui não pode
    // virar no-op silencioso (foi o que deixou a CAPI do #5504 muda).
    const body = leadgenBody();
    const fetchMock = makeFetchMock();
    const res = await handleWebhookPost(
      postRequest(body, await sign(body)),
      baseEnv({ KIT_API_KEY: undefined }),
      { fetchImpl: fetchMock },
    );
    assert.equal(res.status, 500);
  });

  it("responde 200 para payload sem lead algum", async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ field: "feed", value: {} }] }] });
    const fetchMock = makeFetchMock();
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.length, 0);
  });

  it("responde 200 e não chama o Kit quando o lead não tem e-mail", async () => {
    // Retry traria o mesmo lead sem e-mail pra sempre — 200 encerra, o log
    // registra o formulário mal montado.
    const body = leadgenBody();
    const fetchMock = makeFetchMock({ fieldData: [{ name: "full_name", values: ["Sem Email"] }] });
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 200);
    assert.equal(fetchMock.calls.filter((c) => c.url.startsWith("https://kit.test")).length, 0);
  });

  it("processa todos os leads do lote e pede reentrega se qualquer um falhar", async () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "A" } }, { field: "leadgen", value: { leadgen_id: "B" } }] }],
    });
    const fetchMock = makeFetchMock({ kitStatus: 500 });
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: fetchMock });
    assert.equal(res.status, 500);
    // Os dois foram tentados — um falhar não aborta o resto do lote.
    assert.equal(fetchMock.calls.filter((c) => c.url.startsWith("https://graph.test")).length, 2);
  });
});

describe("processLead", () => {
  it("busca o lead pelo leadgen_id com o page token", async () => {
    const fetchMock = makeFetchMock();
    const r = await processLead(
      baseEnv(),
      { leadgenId: "LEAD7", formId: "F", adId: "A", pageId: "P", createdTime: 0 },
      fetchMock,
    );
    assert.equal(r.ok, true);
    const graphCall = fetchMock.calls.find((c) => c.url.startsWith("https://graph.test"));
    assert.ok(graphCall!.url.includes("LEAD7"));
    assert.ok(graphCall!.url.includes("field_data"));
    assert.equal(
      (graphCall!.init?.headers as Record<string, string>).Authorization,
      "Bearer page-token",
    );
  });

  it("devolve graph_error sem page token — nunca inventa sucesso", async () => {
    const fetchMock = makeFetchMock();
    const r = await processLead(
      baseEnv({ META_LEADS_PAGE_ACCESS_TOKEN: undefined }),
      { leadgenId: "LEAD1", formId: "F", adId: "A", pageId: "P", createdTime: 0 },
      fetchMock,
    );
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "graph_error");
  });
});
