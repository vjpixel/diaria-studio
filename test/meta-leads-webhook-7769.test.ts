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
import worker, { handleWebhookPost, processLead, severidadeDeStatus, type Env } from "../workers/meta-leads/src/index.ts";
import { isValidVoteEmailFormat } from "../workers/poll/src/lib.ts";

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

  it("recusa com 400 quando o challenge falta (modo e token corretos)", () => {
    const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me" });
    const r = resolveVerification(params, "verify-me");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
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

  it("recusa corpo RESERIALIZADO — mesma informação, bytes diferentes", async () => {
    // A armadilha que a docstring de verifySignature nomeia: reserializar
    // (JSON.stringify(JSON.parse(body))) preserva o significado e destrói a
    // assinatura. O teste anterior só provava que conteúdo DIFERENTE falha,
    // que é o caso óbvio.
    // Espaçamento no fixture de propósito: é o que a reserialização apaga.
    // Um corpo já compacto reserializaria byte-a-byte igual e o teste não
    // provaria nada (a 1ª versão deste caso caiu exatamente nessa armadilha).
    const original = '{"object": "page", "entry": [{"changes": [{"field": "leadgen", "value": {"leadgen_id": "L1"}}]}]}';
    const reserializado = JSON.stringify(JSON.parse(original));
    const signature = await sign(original);
    assert.equal(await verifySignature(original, signature, APP_SECRET), true);
    assert.notEqual(reserializado, original, "fixture precisa diferir em bytes");
    assert.equal(await verifySignature(reserializado, signature, APP_SECRET), false);
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

  // Os aliases listados no código não tinham teste — um refactor que trocasse
  // a ordem de precedência passaria despercebido.
  for (const [chave, valor] of [["email_address", "x@y.com"], ["e-mail", "x@y.com"]] as const) {
    it(`reconhece o alias de e-mail "${chave}"`, () => {
      assert.equal(extractLeadFields({ field_data: [{ name: chave, values: [valor] }] }).email, valor);
    });
  }

  for (const chave of ["nome_completo", "nome"] as const) {
    it(`reconhece o alias de nome "${chave}"`, () => {
      const r = extractLeadFields({
        field_data: [{ name: "email", values: ["a@b.com"] }, { name: chave, values: ["João Lima"] }],
      });
      assert.equal(r.name, "João Lima");
    });
  }

  it("tolera field_data malformado (não-array, values vazio) sem lançar", () => {
    assert.deepEqual(extractLeadFields({ field_data: "não é array" }), { email: "", name: "" });
    assert.deepEqual(extractLeadFields({ field_data: [{ name: "email", values: [] }] }), { email: "", name: "" });
    assert.deepEqual(extractLeadFields({ field_data: [{ name: "email" }] }), { email: "", name: "" });
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

  it("lote MISTO: o lead que dá certo entra no Kit, e o lote ainda pede reentrega", async () => {
    // O caso que sustenta a decisão de responder 500 pro lote inteiro: o
    // sucesso parcial de fato acontece (efeito colateral real), e a
    // idempotência por e-mail do Kit é o que torna a reentrega segura.
    const body = JSON.stringify({
      entry: [{ changes: [
        { field: "leadgen", value: { leadgen_id: "BOM" } },
        { field: "leadgen", value: { leadgen_id: "RUIM" } },
      ] }],
    });
    const calls: Call[] = [];
    const mixed = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.startsWith("https://graph.test")) {
        if (u.includes("RUIM")) return new Response("graph boom", { status: 500 });
        return new Response(JSON.stringify({ field_data: [{ name: "email", values: ["bom@example.com"] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status: 201 });
    }) as unknown as typeof fetch;

    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: mixed });
    assert.equal(res.status, 500, "lote com 1 falha pede reentrega");
    const kitCalls = calls.filter((c) => c.url.startsWith("https://kit.test"));
    assert.equal(kitCalls.length, 1, "o lead bom foi criado no Kit apesar do irmão falhar");
    assert.equal(JSON.parse(String(kitCalls[0].init?.body)).email_address, "bom@example.com");
  });

  it("grava o nome no Kit quando KIT_NAME_FIELD está configurado", async () => {
    const body = leadgenBody();
    const fetchMock = makeFetchMock();
    await handleWebhookPost(
      postRequest(body, await sign(body)),
      baseEnv({ KIT_NAME_FIELD: "first_name" }),
      { fetchImpl: fetchMock },
    );
    const kitCall = fetchMock.calls.find((c) => c.url.startsWith("https://kit.test"))!;
    assert.equal(JSON.parse(String(kitCall.init?.body)).fields.first_name, "Maria Silva");
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

describe("entrypoint do Worker (export default fetch)", () => {
  // O roteamento real que a Cloudflare invoca não era exercitado por teste
  // nenhum — só as funções internas (achado do review do #7775). Quebrar o
  // path, o método ou o plug do handshake passaria despercebido.
  // `unknown`, não `ExecutionContext`: o tipo global não existe sob
  // `tsconfig.test.json` — ver comentário no `export default` do worker.
  const ctx: unknown = { waitUntil() {}, passThroughOnException() {} };

  it("GET /webhook com token correto ecoa o challenge", async () => {
    const req = new Request("https://x.test/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    const res = await worker.fetch(req, baseEnv(), ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "42");
  });

  it("GET /webhook com token errado responde 403", async () => {
    const req = new Request("https://x.test/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42");
    const res = await worker.fetch(req, baseEnv(), ctx);
    assert.equal(res.status, 403);
  });

  it("POST /webhook chega em handleWebhookPost (assinatura inválida → 403)", async () => {
    const req = postRequest(leadgenBody(), "sha256=deadbeef");
    const res = await worker.fetch(req, baseEnv(), ctx);
    assert.equal(res.status, 403);
  });

  it("path diferente de /webhook responde 404", async () => {
    const res = await worker.fetch(new Request("https://x.test/outra"), baseEnv(), ctx);
    assert.equal(res.status, 404);
  });

  it("método não suportado em /webhook responde 405", async () => {
    const res = await worker.fetch(new Request("https://x.test/webhook", { method: "DELETE" }), baseEnv(), ctx);
    assert.equal(res.status, 405);
  });
});

describe("exceção de rede (fetch rejeita, não devolve status)", () => {
  // Timeout/DNS/AbortError é o modo de falha mais realista em produção e é
  // justamente o que os `catch` dedicados existem pra converter em 500. O
  // mock de status nunca alcançava esses branches.
  const rejecting = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  it("Graph lançando vira 500, nunca 200", async () => {
    const body = leadgenBody();
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: rejecting });
    assert.equal(res.status, 500);
  });

  it("Kit lançando vira 500, nunca 200", async () => {
    const body = leadgenBody();
    const graphOkKitThrows = (async (url: string | URL | Request) => {
      if (String(url).startsWith("https://graph.test")) {
        return new Response(JSON.stringify({ field_data: [{ name: "email", values: ["a@b.com"] }] }), { status: 200 });
      }
      throw new Error("kit unreachable");
    }) as unknown as typeof fetch;
    const res = await handleWebhookPost(postRequest(body, await sign(body)), baseEnv(), { fetchImpl: graphOkKitThrows });
    assert.equal(res.status, 500);
  });
});

describe("severidadeDeStatus", () => {
  // Separa "vai se resolver pela reentrega" de "alguém precisa reautorizar":
  // a reentrega da Meta dura ~7 dias, então credencial revogada perde lead.
  it("401 e 403 são AÇÃO-NECESSÁRIA", () => {
    assert.equal(severidadeDeStatus(401), "AÇÃO-NECESSÁRIA");
    assert.equal(severidadeDeStatus(403), "AÇÃO-NECESSÁRIA");
  });

  it("500, 429 e 503 são TRANSITÓRIO", () => {
    for (const s of [500, 429, 503]) assert.equal(severidadeDeStatus(s), "TRANSITÓRIO");
  });
});

describe("paridade da validação de e-mail com isValidVoteEmailFormat (#3296)", () => {
  // A 1ª versão reimplementou a validação à mão e a docstring afirmava
  // paridade que não existia — faltavam o teto em BYTES UTF-8 e o bloqueio de
  // confusáveis Unicode. Input aqui vem de formulário PÚBLICO, exatamente a
  // classe de entrada que o #3296 endureceu.
  const casos = [
    "leitor@diar.ia.br",
    "com.acento@diária.br",
    "zero​width@b.com", // U+200B (Cf) — deve ser recusado
    "full：width@b.com", // U+FF1A — deve ser recusado
    "control char@b.com", // Cc — deve ser recusado
    "dois:pontos@b.com",
    "a".repeat(250) + "@b.com",
    "ç".repeat(200) + "@b.com", // 400 bytes UTF-8, 201 code units UTF-16
    "",
    "sem-arroba",
  ];

  for (const caso of casos) {
    it(`concorda com a fonte para ${JSON.stringify(caso.slice(0, 40))}`, () => {
      assert.equal(isEmailLike(caso), isValidVoteEmailFormat(caso.trim()));
    });
  }
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
