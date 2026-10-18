/**
 * test/meta-capi-event-source-url-sem-query-10413.test.ts (#10413)
 *
 * O `Reactivation` do `workers/reativar` passava `url.toString()` como
 * `event_source_url` — e a URL de confirmação carrega
 * `?email=<e-mail em claro>&t=<token>`. Resultado: e-mail em claro e token de
 * confirmação iam pra Meta a cada clique (agora junto com IP/UA, #8543).
 *
 * Trava: (1) o worker manda só origin + pathname; (2) os dois builders de
 * `meta-capi.ts` sanitizam qualquer chamador; (3) o log estruturado idem.
 * Nenhum teste toca rede real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCompleteRegistrationEvent,
  buildMetaCapiCustomEvent,
  buildMetaCapiLogEvent,
  sanitizeEventSourceUrl,
} from "../scripts/lib/shared/meta-capi.ts";
import { handleConfirm, type Env as ReativarEnv } from "../workers/reativar/src/index.ts";

const EMAIL = "ana@example.com";
const TOKEN = "tok10413secret";
const DIRTY = `https://reativar.diaria.workers.dev/?email=${encodeURIComponent(EMAIL)}&t=${TOKEN}#frag`;

function assertClean(value: string) {
  assert.ok(!value.includes("email="), `event_source_url contém email=: ${value}`);
  assert.ok(!value.includes(TOKEN), `event_source_url contém o token: ${value}`);
  assert.ok(!value.includes("ana"), `event_source_url contém o e-mail: ${value}`);
  assert.ok(!value.includes("?") && !value.includes("#"), `event_source_url tem query/fragmento: ${value}`);
}

describe("#10413 — sanitizeEventSourceUrl", () => {
  it("corta query e fragmento, preserva origin + pathname", () => {
    assert.equal(sanitizeEventSourceUrl(DIRTY), "https://reativar.diaria.workers.dev/");
    assert.equal(
      sanitizeEventSourceUrl("https://eia.diar.ia.br/jogar/subscribe?utm_source=x"),
      "https://eia.diar.ia.br/jogar/subscribe",
    );
  });
  it("URL limpa passa intacta", () => {
    assert.equal(sanitizeEventSourceUrl("https://diar.ia.br/"), "https://diar.ia.br/");
    assert.equal(sanitizeEventSourceUrl("https://diar.ia.br/confirmada"), "https://diar.ia.br/confirmada");
  });
  it("URL que não parseia é cortada no 1º ?/#, nunca devolvida crua", () => {
    assert.equal(sanitizeEventSourceUrl("/relativa?email=a%40b.com&t=x"), "/relativa");
    assert.equal(sanitizeEventSourceUrl("nada#t=x"), "nada");
    assert.equal(sanitizeEventSourceUrl("sem-query"), "sem-query");
  });
});

describe("#10413 — builders sanitizam todo chamador", () => {
  it("buildCompleteRegistrationEvent", async () => {
    const ev = await buildCompleteRegistrationEvent({ email: EMAIL, eventSourceUrl: DIRTY, eventName: "Reactivation" });
    assertClean(ev.event_source_url);
    assert.equal(ev.event_source_url, "https://reativar.diaria.workers.dev/");
  });
  it("buildMetaCapiCustomEvent", () => {
    const ev = buildMetaCapiCustomEvent({ eventName: "CliqueIngresso_A", eventId: "e1", eventSourceUrl: DIRTY });
    assertClean(ev.event_source_url);
  });
  it("buildMetaCapiLogEvent também não loga a query", () => {
    const ev = buildMetaCapiLogEvent({ ok: true, status: 200 }, "reativar", DIRTY);
    assertClean(String(ev.eventSourceUrl));
  });
});

describe("#10413 — reativar: Reactivation sai sem e-mail/token na URL", () => {
  it("handleConfirm com ?email=&t= → nenhum event_source_url contém email= nem o token", async () => {
    const metaBodies: Array<{ data: Array<{ event_name: string; event_source_url: string }> }> = [];
    const fn = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("graph.facebook.com")) {
        if (init?.body) metaBodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
      }
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: 404 });
      if (method === "POST") return new Response(JSON.stringify({ data: { id: "s1", status: "active" } }), { status: 201 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const env = {
      BEEHIIV_API_KEY: "k",
      BEEHIIV_PUBLICATION_ID: "pub_1",
      BEEHIIV_API_URL: "https://beehiiv.test/v2",
      META_CAPI_ACCESS_TOKEN: "tok",
    } as ReativarEnv;
    const res = await handleConfirm(new URL(DIRTY), env, fn);
    assert.equal(res.status, 303);
    assert.equal(metaBodies.length, 1);
    const events = metaBodies.flatMap((b) => b.data);
    assert.equal(events[0].event_name, "Reactivation");
    for (const ev of events) assertClean(ev.event_source_url);
    // Corpo inteiro: e-mail em claro e token não aparecem em lugar nenhum.
    const raw = JSON.stringify(metaBodies);
    assert.ok(!raw.includes(EMAIL) && !raw.includes(encodeURIComponent(EMAIL)));
    assert.ok(!raw.includes(TOKEN));
  });
});
