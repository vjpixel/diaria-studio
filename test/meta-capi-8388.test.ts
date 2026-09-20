/**
 * test/meta-capi-8388.test.ts (#8388)
 *
 * Fecha as 2 recomendações de CÓDIGO do Events Manager do dataset `Diar.ia`
 * (a 3ª — "Connect to chat activity" — é "Ignore" no painel, ação de UI):
 *
 * 1. **Currency/value.** `custom_data.value`/`custom_data.currency` presentes
 *    no evento da CAPI E no snippet `fbq(...)` da PROPOSTA de import do pixel
 *    (`docs/gtm-signup-container-import-proposal.json`), com o MESMO par.
 *    O pixel não é código executado por este repo (vive no GTM) — este teste
 *    audita a PROPOSTA versionada de import, NÃO o container ao vivo no GTM
 *    (`GTM-TC8C65ZN`). O container publicado usa o template oficial do Meta
 *    Pixel (`__cvt_5RM3Q`), não a tag Custom HTML que este arquivo descreve —
 *    ver #8578. Os campos podem divergir entre a proposta e o que está no ar;
 *    esta checagem só garante consistência interna do arquivo versionado
 *    contra a constante TS, não confirma o que a Meta recebe de fato.
 * 2. **Match quality.** `client_ip_address`/`client_user_agent`/`fbp`/`fbc`
 *    populados quando o request traz os headers, e AUSENTES (chave fora do
 *    objeto, nunca `""`) quando não traz — string vazia conta pra Meta como
 *    parâmetro presente e de match ruim, pior que ausente.
 *
 * Nenhum teste aqui toca a rede: `routedFetch` intercepta o Graph API, no
 * mesmo molde de `test/meta-capi-wiring-5504.test.ts`. NUNCA disparar evento
 * real pra Meta a partir de teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildCompleteRegistrationEvent,
  buildFbcFromClickId,
  buildMetaCapiLogEvent,
  extractMetaCapiClientSignals,
  readCookieValue,
  META_CAPI_COMPLETE_REGISTRATION_CURRENCY,
  META_CAPI_COMPLETE_REGISTRATION_VALUE,
} from "../scripts/lib/shared/meta-capi.ts";
import { handleJogarSubscribe, type SubscribeDeps as PollSubscribeDeps } from "../workers/poll/src/subscribe.ts";
import type { Env as PollEnv } from "../workers/poll/src/index.ts";
import { handleGateSubscribe } from "../workers/cursos/src/subscribe.ts";
import type { Env as CursosEnv } from "../workers/cursos/src/index.ts";

const NOW = 1_755_000_000; // fixo, pra determinismo

type MetaCall = { url: string; body: Record<string, unknown> };
type CapturedEvent = {
  event_name: string;
  user_data: Record<string, unknown>;
  custom_data?: { value?: number; currency?: string };
};

/** Mesmo molde do `routedFetch` de `test/meta-capi-wiring-5504.test.ts` —
 * Beehiiv responde sucesso fixo, Graph API é só registrado (nunca sai da
 * memória do processo). */
function routedFetch() {
  const metaCalls: MetaCall[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) {
      metaCalls.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : {} });
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { id: "sub_1", status: "active" } }), { status: 201 });
  }) as typeof fetch;
  return { fn, metaCalls };
}

function firstEvent(metaCalls: MetaCall[]): CapturedEvent {
  assert.equal(metaCalls.length, 1, "esperava exatamente 1 chamada ao Graph API");
  const data = metaCalls[0].body.data as CapturedEvent[];
  return data[0];
}

describe("#8388 item 1 — custom_data.value/currency", () => {
  it("o evento da CAPI carrega value/currency das constantes", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/assinar",
      eventTimeSeconds: NOW,
    });
    assert.deepEqual(event.custom_data, {
      value: META_CAPI_COMPLETE_REGISTRATION_VALUE,
      currency: META_CAPI_COMPLETE_REGISTRATION_CURRENCY,
    });
  });

  it("value/currency saem também no caminho batch (system_generated) — mesmo par", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/",
      eventTimeSeconds: NOW,
      actionSource: "system_generated",
    });
    assert.equal(event.custom_data.value, META_CAPI_COMPLETE_REGISTRATION_VALUE);
    assert.equal(event.custom_data.currency, META_CAPI_COMPLETE_REGISTRATION_CURRENCY);
  });

  it("o snippet do PIXEL (PROPOSTA de import do container GTM, não o container ao vivo — #8578) manda o MESMO par — dedup pixel × CAPI depende disso", () => {
    const raw = readFileSync(new URL("../docs/gtm-signup-container-import-proposal.json", import.meta.url), "utf8");
    const container = JSON.parse(raw) as {
      containerVersion: { tag: { name: string; parameter: { key: string; value: string }[] }[] };
    };
    const tag = container.containerVersion.tag.find((t) => t.name.includes("CompleteRegistration"));
    assert.ok(tag, "tag do Meta Pixel CompleteRegistration não encontrada no export do container");
    const html = tag.parameter.find((p) => p.key === "html")?.value ?? "";
    const fbqCall = /fbq\('track',\s*'CompleteRegistration',\s*\{([^}]*)\}\s*\)/.exec(html);
    assert.ok(fbqCall, "snippet fbq('track','CompleteRegistration', {...}) não encontrado na tag");
    const payload = fbqCall[1];

    const value = /\bvalue:\s*([0-9.]+)/.exec(payload);
    assert.ok(value, `o pixel não manda 'value' — payload: ${payload.trim()}`);
    assert.equal(Number(value[1]), META_CAPI_COMPLETE_REGISTRATION_VALUE);

    const currency = /\bcurrency:\s*'([A-Z]{3})'/.exec(payload);
    assert.ok(currency, `o pixel não manda 'currency' — payload: ${payload.trim()}`);
    assert.equal(currency[1], META_CAPI_COMPLETE_REGISTRATION_CURRENCY);
  });
});

describe("#8388 item 3 — helpers puros de match quality", () => {
  it("readCookieValue lê o cookie certo e devolve undefined (nunca '') pra ausente/vazio", () => {
    assert.equal(readCookieValue("_fbp=fb.1.100.200; other=x", "_fbp"), "fb.1.100.200");
    assert.equal(readCookieValue("a=1; _fbc=fb.1.100.abc", "_fbc"), "fb.1.100.abc");
    assert.equal(readCookieValue("_fbp=; a=1", "_fbp"), undefined);
    assert.equal(readCookieValue("a=1", "_fbp"), undefined);
    assert.equal(readCookieValue(null, "_fbp"), undefined);
    // prefixo não pode casar por engano (`x_fbp` ≠ `_fbp`)
    assert.equal(readCookieValue("x_fbp=fb.1.1.z", "_fbp"), undefined);
  });

  it("buildFbcFromClickId monta fb.1.{ms}.{fbclid} só pra click id da Meta", () => {
    assert.equal(buildFbcFromClickId("fbclid:AbC-123", 1_700_000_000_000), "fb.1.1700000000000.AbC-123");
    assert.equal(buildFbcFromClickId("gclid:AbC123", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromClickId("msclkid:AbC123", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromClickId("", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromClickId(undefined, 1_700_000_000_000), undefined);
    // payload vazio ou com caracteres fora do formato é descartado, nunca repassado
    assert.equal(buildFbcFromClickId("fbclid:", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromClickId("fbclid:a b", 1_700_000_000_000), undefined);
    assert.equal(buildFbcFromClickId("fbclid:</script>", 1_700_000_000_000), undefined);
  });

  it("extractMetaCapiClientSignals popula os 4 sinais quando o request traz tudo", () => {
    const headers = new Headers({
      "CF-Connecting-IP": "203.0.113.7",
      "user-agent": "Mozilla/5.0 (Test)",
      Cookie: "_fbp=fb.1.1700000000000.123456; _fbc=fb.1.1699999999999.AbC",
    });
    assert.deepEqual(extractMetaCapiClientSignals(headers), {
      clientIpAddress: "203.0.113.7",
      clientUserAgent: "Mozilla/5.0 (Test)",
      fbp: "fb.1.1700000000000.123456",
      fbc: "fb.1.1699999999999.AbC",
    });
  });

  it("sem headers, NENHUMA chave é emitida — nunca string vazia", () => {
    const signals = extractMetaCapiClientSignals(new Headers());
    assert.deepEqual(signals, {});
    assert.ok(!("clientIpAddress" in signals));
    assert.ok(!("clientUserAgent" in signals));
  });

  it("X-Forwarded-For é fallback do CF-Connecting-IP e usa só a 1ª entrada", () => {
    const headers = new Headers({ "X-Forwarded-For": "198.51.100.9, 203.0.113.1" });
    assert.equal(extractMetaCapiClientSignals(headers).clientIpAddress, "198.51.100.9");
  });

  it("cookie _fbc real tem precedência sobre o derivado do click_id", () => {
    const headers = new Headers({ Cookie: "_fbc=fb.1.111.COOKIE" });
    const signals = extractMetaCapiClientSignals(headers, { clickId: "fbclid:CLICK", fbcCreationTimeMs: 222 });
    assert.equal(signals.fbc, "fb.1.111.COOKIE");
  });

  it("sem cookie _fbc, o fbc vem do click_id do #8003", () => {
    const signals = extractMetaCapiClientSignals(new Headers(), {
      clickId: "fbclid:CLICK",
      fbcCreationTimeMs: 222,
    });
    assert.equal(signals.fbc, "fb.1.222.CLICK");
  });

  it("cookie _fbc malformado NÃO bloqueia o fallback pro click_id (descarta o lixo, mantém o sinal bom)", () => {
    const headers = new Headers({ Cookie: "_fbc=lixo" });
    const signals = extractMetaCapiClientSignals(headers, {
      clickId: "fbclid:CLICK",
      fbcCreationTimeMs: 333,
    });
    assert.equal(signals.fbc, "fb.1.333.CLICK");
  });

  it("cookie _fbp/_fbc malformado é DESCARTADO (lixo do cliente não vai pra Meta)", () => {
    const headers = new Headers({ Cookie: "_fbp=lixo; _fbc=tambem-lixo" });
    const signals = extractMetaCapiClientSignals(headers);
    assert.equal(signals.fbp, undefined);
    assert.equal(signals.fbc, undefined);
  });
});

describe("#8388 item 3 — user_data do evento", () => {
  it("os 4 sinais entram no user_data em CLARO, ao lado do `em` hasheado", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/assinar",
      eventTimeSeconds: NOW,
      clientSignals: {
        clientIpAddress: "203.0.113.7",
        clientUserAgent: "Mozilla/5.0 (Test)",
        fbp: "fb.1.100.200",
        fbc: "fb.1.99.AbC",
      },
    });
    assert.match(event.user_data.em[0], /^[0-9a-f]{64}$/);
    assert.equal(event.user_data.client_ip_address, "203.0.113.7");
    assert.equal(event.user_data.client_user_agent, "Mozilla/5.0 (Test)");
    assert.equal(event.user_data.fbp, "fb.1.100.200");
    assert.equal(event.user_data.fbc, "fb.1.99.AbC");
  });

  it("sinal ausente/vazio NÃO vira chave — `client_ip_address: ''` seria match ruim, pior que ausente", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/assinar",
      eventTimeSeconds: NOW,
      clientSignals: { clientIpAddress: "", clientUserAgent: undefined },
    });
    assert.ok(!("client_ip_address" in event.user_data));
    assert.ok(!("client_user_agent" in event.user_data));
    assert.ok(!("fbp" in event.user_data));
    assert.ok(!("fbc" in event.user_data));
  });

  it("sem clientSignals (batch server-side) o user_data segue sendo só `em`", async () => {
    const event = await buildCompleteRegistrationEvent({
      email: "leitor@example.com",
      eventSourceUrl: "https://diar.ia.br/",
      eventTimeSeconds: NOW,
      actionSource: "system_generated",
    });
    assert.deepEqual(Object.keys(event.user_data), ["em"]);
  });

  it("o log estruturado NUNCA carrega IP/UA/e-mail — só worker + desfecho", () => {
    const logged = JSON.stringify([
      buildMetaCapiLogEvent({ ok: true, status: 200 }, "poll"),
      buildMetaCapiLogEvent({ ok: false, status: 503, reason: "not_configured" }, "cursos"),
      buildMetaCapiLogEvent({ ok: false, status: 401, reason: "meta_error" }, "reativar"),
    ]);
    for (const leak of ["203.0.113.7", "Mozilla", "@example.com", "fb.1."]) {
      assert.ok(!logged.includes(leak), `log vazou ${leak}`);
    }
  });
});

describe("#8388 — wiring: os handlers de cadastro mandam os sinais de fato", () => {
  function pollEnv(over: Partial<PollEnv> = {}): PollEnv {
    return {
      POLL: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      } as unknown as PollEnv["POLL"],
      POLL_SECRET: "s",
      ADMIN_SECRET: "s",
      ALLOWED_ORIGINS: "*",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      META_CAPI_ACCESS_TOKEN: "tok",
      ...over,
    } as PollEnv;
  }

  function cursosEnv(over: Partial<CursosEnv> = {}): CursosEnv {
    return {
      ASSETS: {} as CursosEnv["ASSETS"],
      CURSOS_SUBSCRIBERS: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => ({ keys: [], list_complete: true, cursor: undefined }),
      } as unknown as CursosEnv["CURSOS_SUBSCRIBERS"],
      COOKIE_HMAC_SECRET: "cookie-secret",
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      META_CAPI_ACCESS_TOKEN: "tok",
      ...over,
    } as CursosEnv;
  }

  const body = JSON.stringify({
    name: "Ana",
    email: "ana@example.com",
    optin: true,
    website: "",
    click_id: "fbclid:CLICK123",
  });

  it("poll: IP, UA, _fbp e fbc (do click_id) chegam ao payload — e value/currency junto", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleJogarSubscribe(
      new Request("https://eia.diar.ia.br/jogar/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.7",
          "user-agent": "Mozilla/5.0 (Test)",
          Cookie: "_fbp=fb.1.1700000000000.123456",
        },
        body,
      }),
      pollEnv(),
      { fetchImpl: fn } as PollSubscribeDeps,
    );
    assert.equal(res.status, 200);
    const event = firstEvent(metaCalls);
    assert.equal(event.user_data.client_ip_address, "203.0.113.7");
    assert.equal(event.user_data.client_user_agent, "Mozilla/5.0 (Test)");
    assert.equal(event.user_data.fbp, "fb.1.1700000000000.123456");
    assert.match(String(event.user_data.fbc), /^fb\.1\.\d+\.CLICK123$/);
    assert.deepEqual(event.custom_data, {
      value: META_CAPI_COMPLETE_REGISTRATION_VALUE,
      currency: META_CAPI_COMPLETE_REGISTRATION_CURRENCY,
    });
    // o e-mail em claro continua sem sair daqui
    assert.ok(!JSON.stringify(metaCalls[0].body).includes("ana@example.com"));
  });

  it("poll: sem os headers, as chaves ficam FORA do user_data (nunca string vazia)", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleJogarSubscribe(
      new Request("https://eia.diar.ia.br/jogar/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ana", email: "ana@example.com", optin: true, website: "" }),
      }),
      pollEnv(),
      { fetchImpl: fn } as PollSubscribeDeps,
    );
    assert.equal(res.status, 200);
    const event = firstEvent(metaCalls);
    assert.ok(!("client_ip_address" in event.user_data));
    assert.ok(!("fbp" in event.user_data));
    assert.ok(!("fbc" in event.user_data));
  });

  it("cursos: mesmos sinais chegam ao payload do gate", async () => {
    const { fn, metaCalls } = routedFetch();
    const res = await handleGateSubscribe(
      new Request("https://cursos.diar.ia.br/gate/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "198.51.100.9",
          "user-agent": "Mozilla/5.0 (Gate)",
          Cookie: "_fbc=fb.1.1699999999999.COOKIE",
        },
        body,
      }),
      cursosEnv(),
      { fetchImpl: fn },
    );
    assert.equal(res.status, 200);
    const event = firstEvent(metaCalls);
    assert.equal(event.user_data.client_ip_address, "198.51.100.9");
    assert.equal(event.user_data.client_user_agent, "Mozilla/5.0 (Gate)");
    assert.equal(event.user_data.fbc, "fb.1.1699999999999.COOKIE");
    assert.equal(event.custom_data?.currency, META_CAPI_COMPLETE_REGISTRATION_CURRENCY);
  });
});
