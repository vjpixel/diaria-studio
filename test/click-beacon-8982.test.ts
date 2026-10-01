/**
 * test/click-beacon-8982.test.ts (#8982, fold-in da PR #8983)
 *
 * `CliqueIngresso` perdia quase todo o clique real: o listener antigo de
 * `.checkout-link` (workers/site/public/evento/agente-ia/script.js) disparava
 * `fbq('trackCustom', ...)` e o navegador seguia o `href` pra Hotmart no
 * MESMO instante — a navegação cancelava a requisição do pixel antes dela
 * sair. Cobre: o miolo puro de parse/validação do beacon
 * (`scripts/lib/shared/click-beacon.ts`), a montagem do evento CAPI genérico
 * sem e-mail (`buildMetaCapiCustomEvent`), e o wiring da rota
 * `POST /evento/agente-ia/clique` no Worker `site`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseClickBeaconBody,
  validateClickBeacon,
  CLICK_BEACON_FIELD_MAX,
  CLICK_BEACON_ENDPOINT,
  CLICK_BEACON_NAV_DELAY_MS,
} from "../scripts/lib/shared/click-beacon.ts";
import { buildMetaCapiCustomEvent, sendMetaCapiCustomEvent } from "../scripts/lib/shared/meta-capi.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

describe("parseClickBeaconBody (#8982)", () => {
  it("parseia JSON válido com todos os campos", () => {
    const p = parseClickBeaconBody(
      JSON.stringify({ variant: "a", posicao: "hero", event_id: "clique-a-hero-123", external_id: "vid-1", fbc: "fb.1.1.x", fbp: "fb.1.1.y" }),
    );
    assert.deepEqual(p, { variant: "a", posicao: "hero", eventId: "clique-a-hero-123", externalId: "vid-1", fbc: "fb.1.1.x", fbp: "fb.1.1.y" });
  });

  it("JSON malformado → input vazio, nunca lança", () => {
    const p = parseClickBeaconBody("{ not json");
    assert.deepEqual(p, { variant: "", posicao: "", eventId: "", externalId: "", fbc: "", fbp: "" });
  });

  it("corta campos crus em CLICK_BEACON_FIELD_MAX (defesa em profundidade, mesmo padrão de SUBSCRIBE_CLIENT_ORIGIN_MAX)", () => {
    const long = "x".repeat(CLICK_BEACON_FIELD_MAX + 50);
    const p = parseClickBeaconBody(JSON.stringify({ posicao: long, fbc: long }));
    assert.equal(p.posicao.length, CLICK_BEACON_FIELD_MAX);
    assert.equal(p.fbc.length, CLICK_BEACON_FIELD_MAX);
  });

  it("campos ausentes viram string vazia, nunca undefined", () => {
    const p = parseClickBeaconBody(JSON.stringify({ variant: "b" }));
    assert.equal(p.posicao, "");
    assert.equal(p.eventId, "");
    assert.equal(p.externalId, "");
  });
});

describe("validateClickBeacon (#8982)", () => {
  it("variante 'a'/'A' + event_id → eventName CliqueIngresso_A, posicao default sem-posicao", () => {
    const v1 = validateClickBeacon({ variant: "a", posicao: "", eventId: "e1", externalId: "", fbc: "", fbp: "" });
    assert.deepEqual(v1, { ok: true, eventName: "CliqueIngresso_A", eventId: "e1", posicao: "sem-posicao" });
    const v2 = validateClickBeacon({ variant: "A", posicao: "hero", eventId: "e2", externalId: "", fbc: "", fbp: "" });
    assert.deepEqual(v2, { ok: true, eventName: "CliqueIngresso_A", eventId: "e2", posicao: "hero" });
  });

  it("variante 'b'/'B' → eventName CliqueIngresso_B", () => {
    const v = validateClickBeacon({ variant: "B", posicao: "footer", eventId: "e3", externalId: "", fbc: "", fbp: "" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.eventName, "CliqueIngresso_B");
  });

  it("#9335: variante 'c'/'C' → eventName CliqueIngresso_C", () => {
    const v = validateClickBeacon({ variant: "c", posicao: "topo", eventId: "e4", externalId: "", fbc: "", fbp: "" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.eventName, "CliqueIngresso_C");
  });

  it("variante inválida/ausente → invalid_variant", () => {
    assert.deepEqual(validateClickBeacon({ variant: "", posicao: "", eventId: "e", externalId: "", fbc: "", fbp: "" }), {
      ok: false,
      error: "invalid_variant",
    });
    assert.deepEqual(validateClickBeacon({ variant: "d", posicao: "", eventId: "e", externalId: "", fbc: "", fbp: "" }), {
      ok: false,
      error: "invalid_variant",
    });
    assert.deepEqual(validateClickBeacon({ variant: "<script>", posicao: "", eventId: "e", externalId: "", fbc: "", fbp: "" }), {
      ok: false,
      error: "invalid_variant",
    });
  });

  it("event_id ausente → missing_event_id, mesmo com variante válida", () => {
    assert.deepEqual(validateClickBeacon({ variant: "a", posicao: "hero", eventId: "", externalId: "", fbc: "", fbp: "" }), {
      ok: false,
      error: "missing_event_id",
    });
  });
});

describe("buildMetaCapiCustomEvent (#8982)", () => {
  it("monta evento SEM e-mail (user_data.em nunca aparece — este evento não tem cadastro associado)", () => {
    const event = buildMetaCapiCustomEvent({
      eventName: "CliqueIngresso_A",
      eventId: "clique-a-hero-123",
      eventSourceUrl: "https://diar.ia.br/evento/agente-ia/a",
      clientSignals: { externalId: "vid-1", fbc: "fb.1.1.x", fbp: "fb.1.1.y", clientIpAddress: "1.2.3.4", clientUserAgent: "UA" },
    });
    assert.equal(event.event_name, "CliqueIngresso_A");
    assert.equal(event.event_id, "clique-a-hero-123");
    assert.equal(event.action_source, "website");
    assert.deepEqual(event.user_data, {
      external_id: ["vid-1"],
      fbc: "fb.1.1.x",
      fbp: "fb.1.1.y",
      client_ip_address: "1.2.3.4",
      client_user_agent: "UA",
    });
    assert.equal((event.user_data as Record<string, unknown>).em, undefined);
  });

  it("clientSignals ausente → user_data vazio ({}), nunca lança", () => {
    const event = buildMetaCapiCustomEvent({
      eventName: "CliqueIngresso_B",
      eventId: "e",
      eventSourceUrl: "https://diar.ia.br/evento/agente-ia/b",
    });
    assert.deepEqual(event.user_data, {});
  });

  it("customData, quando presente, vira custom_data; ausente, o campo nem aparece", () => {
    const withCustom = buildMetaCapiCustomEvent({
      eventName: "CliqueIngresso_A",
      eventId: "e",
      eventSourceUrl: "https://x.test",
      customData: { posicao: "hero" },
    });
    assert.deepEqual(withCustom.custom_data, { posicao: "hero" });
    const without = buildMetaCapiCustomEvent({ eventName: "CliqueIngresso_A", eventId: "e", eventSourceUrl: "https://x.test" });
    assert.equal(without.custom_data, undefined);
  });
});

describe("sendMetaCapiCustomEvent (#8982) — fail-soft", () => {
  it("sem accessToken → not_configured, nunca chama fetch", async () => {
    let called = false;
    const result = await sendMetaCapiCustomEvent(
      { eventName: "CliqueIngresso_A", eventId: "e", eventSourceUrl: "https://x.test" },
      { accessToken: undefined, fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch },
    );
    assert.deepEqual(result, { ok: false, status: 503, reason: "not_configured" });
    assert.equal(called, false);
  });

  it("com accessToken + fetch ok → ok:true", async () => {
    const result = await sendMetaCapiCustomEvent(
      { eventName: "CliqueIngresso_A", eventId: "e", eventSourceUrl: "https://x.test" },
      { accessToken: "tok", fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch },
    );
    assert.deepEqual(result, { ok: true, status: 200 });
  });
});

// ---- wiring da rota no Worker `site` ----

function fakeEnv(overrides: Partial<Env> = {}): { env: Env; assetCalls: Request[] } {
  const assetCalls: Request[] = [];
  const env: Env = {
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(req);
        return new Response("<html>fake asset</html>", { status: 200 });
      },
    } as unknown as Env["ASSETS"],
    POLL: { get: async () => null } as unknown as Env["POLL"],
    ...overrides,
  };
  return { env, assetCalls };
}

describe("POST /evento/agente-ia/clique — wiring no Worker site (#8982)", () => {
  it("SEMPRE responde 204, mesmo sem META_CAPI_ACCESS_TOKEN configurado (fail-soft — o beacon nunca pode falhar visivelmente)", async () => {
    const { env, assetCalls } = fakeEnv();
    const res = await worker.fetch(
      new Request("https://diar.ia.br/evento/agente-ia/clique", {
        method: "POST",
        body: JSON.stringify({ variant: "a", posicao: "hero", event_id: "e1" }),
      }),
      env,
    );
    assert.equal(res.status, 204);
    assert.equal(assetCalls.length, 0, "nunca deveria cair no ASSETS.fetch");
  });

  it("corpo malformado → ainda 204 (fail-soft total)", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(
      new Request("https://diar.ia.br/evento/agente-ia/clique", { method: "POST", body: "{ not json" }),
      env,
    );
    assert.equal(res.status, 204);
  });

  it("variante inválida → ainda 204, nunca manda evento inválido pra Meta", async () => {
    const { env } = fakeEnv({ META_CAPI_ACCESS_TOKEN: "tok" });
    const res = await worker.fetch(
      new Request("https://diar.ia.br/evento/agente-ia/clique", {
        method: "POST",
        body: JSON.stringify({ variant: "z", event_id: "e1" }),
      }),
      env,
    );
    assert.equal(res.status, 204);
  });

  it("com accessToken configurado, envia CAPI com o event_name/event_id do corpo — awaited quando ctx.waitUntil não está disponível (fallback síncrono)", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const { env } = fakeEnv({ META_CAPI_ACCESS_TOKEN: "tok" });
      const res = await worker.fetch(
        new Request("https://diar.ia.br/evento/agente-ia/clique", {
          method: "POST",
          headers: { Referer: "https://diar.ia.br/evento/agente-ia/a" },
          body: JSON.stringify({
            variant: "a",
            posicao: "hero",
            event_id: "clique-a-hero-123",
            external_id: "550e8400-e29b-41d4-a716-446655440000",
          }),
        }),
        env,
        // sem ctx (undefined) — exercita o fallback `await` direto, mesmo
        // padrão de workers/poll/src/subscribe.ts.
      );
      assert.equal(res.status, 204);
      assert.equal(calls.length, 1);
      const sent = calls[0].body as { data: Array<{ event_name: string; event_id: string; user_data: Record<string, unknown> }> };
      assert.equal(sent.data[0].event_name, "CliqueIngresso_A");
      assert.equal(sent.data[0].event_id, "clique-a-hero-123");
      assert.deepEqual(sent.data[0].user_data.external_id, ["550e8400-e29b-41d4-a716-446655440000"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("GET no mesmo path cai no ASSETS normal (rota é só POST)", async () => {
    const { env, assetCalls } = fakeEnv();
    await worker.fetch(new Request("https://diar.ia.br/evento/agente-ia/clique", { method: "GET" }), env);
    assert.equal(assetCalls.length, 1);
  });
});

describe("CLICK_BEACON_NAV_DELAY_MS vs workers/site/public/evento/agente-ia/script.js (drift)", () => {
  it("o setTimeout(go, 300) hardcoded no JS estático bate com a constante documentada", () => {
    // #8982: o JS estático não importa a constante (sem passo de build — ver
    // docstring de click-beacon.ts), então o único jeito de saber se os dois
    // ainda concordam é este teste de drift lendo o arquivo cru.
    const scriptPath = join(process.cwd(), "workers/site/public/evento/agente-ia/script.js");
    const js = readFileSync(scriptPath, "utf8");
    assert.match(
      js,
      new RegExp(`setTimeout\\(go,\\s*${CLICK_BEACON_NAV_DELAY_MS}\\)`),
      `script.js precisa navegar em até ${CLICK_BEACON_NAV_DELAY_MS}ms — atualize o hardcode ou esta constante juntos`,
    );
  });
});
