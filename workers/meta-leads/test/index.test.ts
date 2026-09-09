/**
 * Tests for workers/meta-leads (#7769).
 *
 * Roda em Node via `--import tsx` (mesmo padrão de
 * `workers/linkedin-cron/test/index.test.ts`) — o worker só usa Web
 * standards (`crypto.subtle`, `fetch`, `Request`/`Response`/`URL`, todos
 * globais no Node ≥18), sem nenhum binding real de Workers runtime
 * (KV/DO), então não precisa de miniflare/workerd pra testar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hmacSha256Hex, verifyMetaSignature, constantTimeEquals } from "../src/crypto.ts";
import {
  extractFieldValue,
  resolveLeadContact,
  fetchMetaLead,
  DEFAULT_GRAPH_API_VERSION,
  type MetaLead,
} from "../src/graph.ts";
import { createKitSubscriberFromLead } from "../src/kit.ts";
import { META_LEADS_UTM } from "../src/utm.ts";
import { redactPii } from "../src/redact.ts";
import {
  handleVerify,
  handleWebhookPost,
  extractLeadgenIds,
  processLead,
  isPlausibleEmail,
  type Env,
} from "../src/index.ts";
import { findExternalUtmSurface } from "../../../scripts/lib/shared/utm-registry.ts";

// ── crypto.ts ────────────────────────────────────────────────────────────

describe("constantTimeEquals", () => {
  it("true para strings idênticas", () => {
    assert.equal(constantTimeEquals("abc", "abc"), true);
  });
  it("false para comprimentos diferentes", () => {
    assert.equal(constantTimeEquals("abc", "abcd"), false);
  });
  it("false para mesmo comprimento, conteúdo diferente", () => {
    assert.equal(constantTimeEquals("abc", "abd"), false);
  });
});

describe("hmacSha256Hex + verifyMetaSignature", () => {
  const secret = "test-app-secret";
  const body = JSON.stringify({ object: "page", entry: [{ id: "1" }] });

  it("aceita assinatura correta no formato sha256={hex}", async () => {
    const hex = await hmacSha256Hex(secret, body);
    const ok = await verifyMetaSignature(secret, body, `sha256=${hex}`);
    assert.equal(ok, true);
  });

  it("rejeita assinatura incorreta (HMAC de outro secret)", async () => {
    const wrongHex = await hmacSha256Hex("outro-secret", body);
    const ok = await verifyMetaSignature(secret, body, `sha256=${wrongHex}`);
    assert.equal(ok, false);
  });

  it("rejeita header sem o prefixo sha256=", async () => {
    const hex = await hmacSha256Hex(secret, body);
    const ok = await verifyMetaSignature(secret, body, hex);
    assert.equal(ok, false);
  });

  it("rejeita header ausente", async () => {
    const ok = await verifyMetaSignature(secret, body, null);
    assert.equal(ok, false);
  });

  it("rejeita quando o corpo foi alterado após a assinatura ser calculada (assinatura é sobre o corpo CRU)", async () => {
    const hex = await hmacSha256Hex(secret, body);
    const tamperedBody = body.replace('"page"', '"group"');
    const ok = await verifyMetaSignature(secret, tamperedBody, `sha256=${hex}`);
    assert.equal(ok, false);
  });

  it("rejeita quando app secret está vazio (fail-closed, nunca 'sem verificação')", async () => {
    const hex = await hmacSha256Hex(secret, body);
    const ok = await verifyMetaSignature("", body, `sha256=${hex}`);
    assert.equal(ok, false);
  });
});

// ── GET /webhook handshake ──────────────────────────────────────────────

describe("handleVerify", () => {
  const env: Env = { META_WEBHOOK_VERIFY_TOKEN: "meu-token-secreto" } as Env;

  it("ecoa hub.challenge quando mode+token batem", () => {
    const url = new URL("https://x.workers.dev/webhook?hub.mode=subscribe&hub.verify_token=meu-token-secreto&hub.challenge=1234567890");
    const res = handleVerify(url, env);
    assert.equal(res.status, 200);
  });

  it("rejeita token incorreto", () => {
    const url = new URL("https://x.workers.dev/webhook?hub.mode=subscribe&hub.verify_token=token-errado&hub.challenge=1234567890");
    const res = handleVerify(url, env);
    assert.equal(res.status, 403);
  });

  it("rejeita mode diferente de subscribe", () => {
    const url = new URL("https://x.workers.dev/webhook?hub.mode=unsubscribe&hub.verify_token=meu-token-secreto&hub.challenge=1234567890");
    const res = handleVerify(url, env);
    assert.equal(res.status, 403);
  });

  it("rejeita quando META_WEBHOOK_VERIFY_TOKEN não está configurado", () => {
    const url = new URL("https://x.workers.dev/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1234567890");
    const res = handleVerify(url, {} as Env);
    assert.equal(res.status, 403);
  });
});

// ── graph.ts ─────────────────────────────────────────────────────────────

describe("extractFieldValue / resolveLeadContact", () => {
  it("resolve email + full_name quando presentes", () => {
    const lead: MetaLead = {
      id: "L1",
      field_data: [
        { name: "email", values: ["leitor@example.com"] },
        { name: "full_name", values: ["Fulano de Tal"] },
      ],
    };
    const contact = resolveLeadContact(lead);
    assert.equal(contact.email, "leitor@example.com");
    assert.equal(contact.name, "Fulano de Tal");
  });

  it("compõe nome a partir de first_name + last_name quando full_name ausente", () => {
    const lead: MetaLead = {
      id: "L2",
      field_data: [
        { name: "email", values: ["leitor2@example.com"] },
        { name: "first_name", values: ["Fulana"] },
        { name: "last_name", values: ["Beltrana"] },
      ],
    };
    const contact = resolveLeadContact(lead);
    assert.equal(contact.name, "Fulana Beltrana");
  });

  it("retorna string vazia quando field_data está ausente", () => {
    assert.equal(extractFieldValue(undefined, ["email"]), "");
  });

  it("é case-insensitive no nome do campo", () => {
    const lead: MetaLead = { id: "L3", field_data: [{ name: "EMAIL", values: ["x@y.com"] }] };
    assert.equal(resolveLeadContact(lead).email, "x@y.com");
  });
});

describe("fetchMetaLead", () => {
  it("retorna ok:false sem tentar rede quando access token está ausente", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMetaLead("L1", "", fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  it("retorna o lead em caso de sucesso", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "L1", field_data: [{ name: "email", values: ["a@b.com"] }] }), { status: 200 })
    ) as unknown as typeof fetch;
    const result = await fetchMetaLead("L1", "token", fetchImpl);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.lead.id, "L1");
  });

  it("propaga falha 4xx/5xx da Graph API como ok:false (nunca lança)", async () => {
    const fetchImpl = (async () => new Response("Invalid OAuth access token", { status: 401 })) as unknown as typeof fetch;
    const result = await fetchMetaLead("L1", "token-invalido", fetchImpl);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /graph_api_401/);
  });

  it("trata exceção de fetch (rede indisponível) como ok:false, nunca lança", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchMetaLead("L1", "token", fetchImpl);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /fetch_exception/);
  });

  it("usa a versão default da Graph API quando não sobrescrita", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ id: "L1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchMetaLead("L1", "token", fetchImpl);
    assert.match(capturedUrl, new RegExp(`/${DEFAULT_GRAPH_API_VERSION}/`));
  });

  // Achado P3/média do review da PR #7777: token na query string vazaria pro
  // Cloudflare Logs (head_sampling_rate = 1), inclusive dentro de
  // `String(err)` de uma exceção de fetch, que em vários runtimes embute a URL.
  it("NUNCA põe o access token na query string — vai no header Authorization", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "L1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchMetaLead("L1", "token-secreto-123", fetchImpl);
    assert.ok(!capturedUrl.includes("token-secreto-123"), "token vazou na URL");
    assert.ok(!capturedUrl.includes("access_token"), "query string ainda tem access_token");
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    assert.equal(headers?.Authorization, "Bearer token-secreto-123");
  });

  it("redige PII do corpo de erro do Graph antes de embutir no reason", async () => {
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"Invalid user lead@exemplo.com.br"}}', {
        status: 400,
      })) as unknown as typeof fetch;
    const result = await fetchMetaLead("L1", "token", fetchImpl);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(!result.reason.includes("lead@exemplo.com.br"), "e-mail vazou no reason");
    assert.match(result.reason, /\[email redigido\]/);
  });
});

// ── redactPii (achado P2/alta do review da PR #7777) ──────────────────────

describe("redactPii", () => {
  it("redige e-mail em texto livre de terceiro", () => {
    const out = redactPii(`{"errors":{"email_address":["'maria.silva@gmail.com' is invalid"]}}`);
    assert.ok(!out.includes("maria.silva@gmail.com"));
    assert.match(out, /\[email redigido\]/);
    // preserva o que torna o erro diagnosticável
    assert.match(out, /email_address/);
    assert.match(out, /is invalid/);
  });

  it("redige telefone", () => {
    const out = redactPii("phone +55 11 91234-5678 rejected");
    assert.ok(!out.includes("91234-5678"));
    assert.match(out, /\[telefone redigido\]/);
    assert.match(out, /rejected/);
  });

  it("redige TODOS os e-mails, não só o primeiro", () => {
    const out = redactPii("a@b.com e c@d.com.br falharam");
    assert.ok(!out.includes("a@b.com"));
    assert.ok(!out.includes("c@d.com.br"));
    assert.equal(out.match(/\[email redigido\]/g)?.length, 2);
  });

  it("texto sem PII passa intacto", () => {
    const s = '{"error":{"code":190,"message":"Invalid OAuth access token"}}';
    assert.equal(redactPii(s), s);
  });
});

// ── isPlausibleEmail ─────────────────────────────────────────────────────

describe("isPlausibleEmail", () => {
  it("aceita email bem-formado", () => assert.equal(isPlausibleEmail("a@b.com"), true));
  it("rejeita string vazia", () => assert.equal(isPlausibleEmail(""), false));
  it("rejeita sem @", () => assert.equal(isPlausibleEmail("abc.com"), false));
  it("rejeita sem domínio com ponto", () => assert.equal(isPlausibleEmail("a@b"), false));
});

// ── kit.ts ───────────────────────────────────────────────────────────────

describe("createKitSubscriberFromLead", () => {
  const utm = META_LEADS_UTM;

  it("retorna not_configured sem tentar rede quando KIT_API_KEY ausente", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await createKitSubscriberFromLead({}, { email: "a@b.com", name: "A" }, utm, fetchImpl);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  it("cria o subscriber com state active + campos de atribuição configurados", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ subscriber: { id: 42 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const env = {
      KIT_API_KEY: "kit-key",
      KIT_UTM_SOURCE_FIELD: "utm_source",
      KIT_UTM_MEDIUM_FIELD: "utm_medium",
      KIT_UTM_CAMPAIGN_FIELD: "utm_campaign",
      KIT_REFERRING_SITE_FIELD: "referring_site",
      KIT_ORIGEM_CADASTRO_FIELD: "origem_cadastro",
      KIT_NAME_FIELD: "name",
    };
    const result = await createKitSubscriberFromLead(env, { email: "lead@example.com", name: "Lead Teste" }, utm, fetchImpl);
    assert.equal(result.ok, true);
    assert.equal(capturedBody?.email_address, "lead@example.com");
    assert.equal(capturedBody?.state, "active");
    const fields = capturedBody?.fields as Record<string, string>;
    assert.equal(fields.utm_source, "meta-ads");
    assert.equal(fields.utm_medium, "paid_social");
    assert.equal(fields.utm_campaign, "ads-meta-2608");
    assert.equal(fields.referring_site, "meta-instant-form");
    assert.equal(fields.origem_cadastro, "kit-nativo");
    assert.equal(fields.name, "Lead Teste");
    assert.equal(capturedHeaders?.["X-Kit-Api-Key"], "kit-key");
  });

  it("não manda campo de atribuição cuja var de nome não está configurada (gate-por-ausência)", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createKitSubscriberFromLead(
      { KIT_API_KEY: "kit-key" },
      { email: "lead@example.com", name: "" },
      utm,
      fetchImpl,
    );
    assert.equal(result.ok, true);
    assert.equal(capturedBody?.fields, undefined);
  });

  it("propaga erro do Kit (ex: 422) como ok:false com o corpo truncado", async () => {
    const fetchImpl = (async () => new Response('{"error":"invalid email"}', { status: 422 })) as unknown as typeof fetch;
    const result = await createKitSubscriberFromLead({ KIT_API_KEY: "kit-key" }, { email: "a@b.com", name: "" }, utm, fetchImpl);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 422);
      assert.match(result.reason, /kit_422/);
    }
  });

  it("trata exceção de fetch (Kit indisponível) como ok:false, nunca lança", async () => {
    const fetchImpl = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const result = await createKitSubscriberFromLead({ KIT_API_KEY: "kit-key" }, { email: "a@b.com", name: "" }, utm, fetchImpl);
    assert.equal(result.ok, false);
  });
});

// ── utm.ts sincronizado com scripts/lib/shared/utm-registry.ts ──────────

describe("META_LEADS_UTM sincronizado com o registry canônico (ads-meta-2608)", () => {
  it("source/medium/campaign batem a entrada ads-meta-2608 do registry", () => {
    const surface = findExternalUtmSurface("ads-meta-2608");
    assert.ok(surface, "entrada ads-meta-2608 deveria existir em utm-registry.ts");
    assert.equal(META_LEADS_UTM.source, surface!.source);
    assert.equal(META_LEADS_UTM.medium, surface!.medium);
    assert.equal(META_LEADS_UTM.campaign, surface!.campaign);
  });
});

// ── extractLeadgenIds ─────────────────────────────────────────────────────

describe("extractLeadgenIds", () => {
  it("extrai leadgen_id de changes com field=leadgen", () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "PAGE1",
          changes: [
            { field: "leadgen", value: { leadgen_id: "LG1" } },
            { field: "leadgen", value: { leadgen_id: "LG2" } },
          ],
        },
      ],
    };
    assert.deepEqual(extractLeadgenIds(payload), ["LG1", "LG2"]);
  });

  it("ignora changes com field diferente de leadgen", () => {
    const payload = {
      object: "page",
      entry: [{ id: "P1", changes: [{ field: "feed", value: {} }] }],
    };
    assert.deepEqual(extractLeadgenIds(payload), []);
  });

  it("payload sem entry/changes não lança, devolve array vazio", () => {
    assert.deepEqual(extractLeadgenIds({}), []);
  });
});

// ── processLead (integração dos 3 módulos com fetch mockado) ─────────────

describe("processLead", () => {
  const env: Env = {
    META_LEADS_PAGE_ACCESS_TOKEN: "page-token",
    KIT_API_KEY: "kit-key",
    KIT_UTM_SOURCE_FIELD: "utm_source",
  } as Env;

  it("caminho feliz: busca o lead e cria o subscriber", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({ id: "LG1", field_data: [{ name: "email", values: ["ok@example.com"] }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const outcome = await processLead("LG1", env, fetchImpl);
    assert.equal(outcome.ok, true);
  });

  it("falha ao buscar o lead → ok:false com reason, nunca lança", async () => {
    const fetchImpl = (async () => new Response("erro", { status: 500 })) as unknown as typeof fetch;
    const outcome = await processLead("LG1", env, fetchImpl);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.reason);
  });

  it("lead sem email válido → ok:false, nunca chama o Kit", async () => {
    let kitCalled = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("graph.facebook.com")) {
        return new Response(JSON.stringify({ id: "LG1", field_data: [] }), { status: 200 });
      }
      kitCalled = true;
      return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const outcome = await processLead("LG1", env, fetchImpl);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "missing_or_invalid_email");
    assert.equal(kitCalled, false);
  });

  it("lead ok mas Kit falha → ok:false", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({ id: "LG1", field_data: [{ name: "email", values: ["ok@example.com"] }] }),
          { status: 200 },
        );
      }
      return new Response("kit down", { status: 503 });
    }) as unknown as typeof fetch;
    const outcome = await processLead("LG1", env, fetchImpl);
    assert.equal(outcome.ok, false);
  });
});

// ── handleWebhookPost (end-to-end do endpoint) ────────────────────────────

describe("handleWebhookPost", () => {
  const secret = "app-secret-e2e";
  const env: Env = {
    META_APP_SECRET: secret,
    META_LEADS_PAGE_ACCESS_TOKEN: "page-token",
    KIT_API_KEY: "kit-key",
  } as Env;

  async function sign(body: string): Promise<string> {
    return `sha256=${await hmacSha256Hex(secret, body)}`;
  }

  it("403 quando a assinatura está ausente — nunca processa lead nenhum", async () => {
    const body = JSON.stringify({ object: "page", entry: [{ changes: [{ field: "leadgen", value: { leadgen_id: "LG1" } }] }] });
    const request = new Request("https://x.workers.dev/webhook", { method: "POST", body });
    const res = await handleWebhookPost(request, env, (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch);
    assert.equal(res.status, 403);
  });

  it("403 quando a assinatura é inválida (payload adulterado ou secret errado)", async () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const badSig = await sign('{"different":"body"}');
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": badSig },
    });
    const res = await handleWebhookPost(request, env);
    assert.equal(res.status, 403);
  });

  it("200 com processed:0 para payload sem changes leadgen (object=page)", async () => {
    const body = JSON.stringify({ object: "page", entry: [{ id: "P1", changes: [{ field: "feed", value: {} }] }] });
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    const res = await handleWebhookPost(request, env);
    assert.equal(res.status, 200);
    const parsed = await res.json();
    assert.equal(parsed.processed, 0);
  });

  it("200 quando object não é 'page'", async () => {
    const body = JSON.stringify({ object: "user", entry: [] });
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    const res = await handleWebhookPost(request, env);
    assert.equal(res.status, 200);
  });

  it("200 e cria o subscriber no caminho feliz com 1 leadgen_id", async () => {
    const body = JSON.stringify({
      object: "page",
      entry: [{ id: "PAGE1", changes: [{ field: "leadgen", value: { leadgen_id: "LG1" } }] }],
    });
    let kitCalled = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("graph.facebook.com")) {
        return new Response(
          JSON.stringify({ id: "LG1", field_data: [{ name: "email", values: ["lead@example.com"] }] }),
          { status: 200 },
        );
      }
      kitCalled = true;
      return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    const res = await handleWebhookPost(request, env, fetchImpl);
    assert.equal(res.status, 200);
    assert.equal(kitCalled, true);
    const parsed = await res.json();
    assert.equal(parsed.processed, 1);
  });

  it("502 (não-200, dispara retry da Meta) quando o processamento de QUALQUER lead falha — mesmo com outros bem-sucedidos no mesmo payload", async () => {
    const body = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "PAGE1",
          changes: [
            { field: "leadgen", value: { leadgen_id: "LG-OK" } },
            { field: "leadgen", value: { leadgen_id: "LG-FAIL" } },
          ],
        },
      ],
    });
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("LG-OK")) {
        return new Response(
          JSON.stringify({ id: "LG-OK", field_data: [{ name: "email", values: ["ok@example.com"] }] }),
          { status: 200 },
        );
      }
      if (u.includes("LG-FAIL")) {
        return new Response("erro simulado", { status: 500 });
      }
      // Chamada ao Kit para o lead que teve sucesso no fetch do Graph.
      return new Response(JSON.stringify({ subscriber: { id: 1 } }), { status: 201 });
    }) as unknown as typeof fetch;
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    const res = await handleWebhookPost(request, env, fetchImpl);
    assert.equal(res.status, 502);
    const parsed = await res.json();
    assert.equal(parsed.ok, false);
    assert.equal(parsed.failed.length, 1);
    assert.equal(parsed.failed[0].leadgenId, "LG-FAIL");
  });

  it("400 para corpo JSON malformado apesar de assinatura correta sobre esse corpo cru", async () => {
    const body = "{not-json";
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    const res = await handleWebhookPost(request, env);
    assert.equal(res.status, 400);
  });

  // #7769 self-review: `JSON.parse("null")` NÃO lança — sem o guard de
  // "é objeto, não array" em handleWebhookPost, `payload.object` explodiria
  // num TypeError não-tratado (500 opaco) para qualquer um destes 4 corpos,
  // apesar de todos serem JSON sintaticamente válido.
  for (const body of ["null", "true", "42", '"uma string qualquer"']) {
    it(`400 (não crash) para corpo JSON válido porém não-objeto: ${body}`, async () => {
      const request = new Request("https://x.workers.dev/webhook", {
        method: "POST",
        body,
        headers: { "X-Hub-Signature-256": await sign(body) },
      });
      const res = await handleWebhookPost(request, env);
      assert.equal(res.status, 400);
    });
  }

  it("400 para corpo JSON válido que é um array (não objeto de payload)", async () => {
    const body = "[1,2,3]";
    const request = new Request("https://x.workers.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Hub-Signature-256": await sign(body) },
    });
    const res = await handleWebhookPost(request, env);
    assert.equal(res.status, 400);
  });
});
