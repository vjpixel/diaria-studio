/**
 * test/visit-origin-10079.test.ts (#10079)
 *
 * As páginas `/evento/agente-ia/{a,b,c,d}` e `/guia/agente-ia` mandavam os
 * eventos do pixel sem a origem da visita: o total misturava newsletter e
 * anúncio, e não dava para medir a página para quem vem do anúncio. Desde o
 * #10079, `origem` (utm_source, ou "meta" com fbclid, ou "direto"),
 * `utm_campaign` e `utm_content` vão em todos os eventos e no beacon do
 * clique, que os repassa em `custom_data` no envio à CAPI.
 *
 * Cobre:
 * 1. o `script.js` das duas páginas, executado de verdade num `vm` com
 *    `window`/`document`/`fbq`/`sendBeacon` falsos: visita, rolagem e clique
 *    levam a origem; o beacon leva a origem e o `_fbc` do cookie;
 * 2. o miolo do beacon (`parseClickBeaconBody`/`clickBeaconCustomData`);
 * 3. a rota `POST /evento/agente-ia/clique` do Worker `site`: o `fbc` do
 *    beacon chega a `user_data.fbc` no corpo enviado à Meta, e a origem chega
 *    a `custom_data` (pergunta da issue: os 0% de fbc no `CliqueIngresso_D`
 *    são do código ou de quem clicou?).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import {
  parseClickBeaconBody,
  validateClickBeacon,
  clickBeaconCustomData,
  CLICK_BEACON_ORIGIN_FIELD_MAX,
} from "../scripts/lib/shared/click-beacon.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const EVENTO_JS = readFileSync(join(process.cwd(), "workers/site/public/evento/agente-ia/script.js"), "utf8");
const GUIA_JS = readFileSync(join(process.cwd(), "workers/site/public/guia/agente-ia/script.js"), "utf8");

type FbqCall = { args: unknown[] };
type Listener = (ev: Record<string, unknown>) => void;

interface FakeLink {
  dataset: { posicao: string };
  href: string;
  hidden: boolean;
  listeners: Listener[];
  addEventListener: (type: string, fn: Listener) => void;
}

function fakeLink(posicao: string): FakeLink {
  const link: FakeLink = {
    dataset: { posicao },
    href: "",
    hidden: true,
    listeners: [],
    addEventListener: (type, fn) => {
      if (type === "click") link.listeners.push(fn);
    },
  };
  return link;
}

/** Roda um `script.js` de página num contexto isolado e devolve o que ele
 * disparou. Nada de DOM real: só o que os dois scripts usam. */
function runPageScript(
  js: string,
  opts: { search: string; cookie?: string; variante?: string; checkoutUrl?: string; fbqThrows?: boolean },
) {
  const fbqCalls: FbqCall[] = [];
  const beacons: Array<{ url: string; body: Promise<string> }> = [];
  const scrollListeners: Array<() => void> = [];
  const links = [fakeLink("topo")];
  const win: Record<string, unknown> = {
    location: { search: opts.search, href: "" },
    fbq: (...args: unknown[]) => {
      fbqCalls.push({ args });
      if (opts.fbqThrows) throw new Error("fbq quebrado");
    },
    __DIA_VID__: "550e8400-e29b-41d4-a716-446655440000",
    EVENT_CHECKOUT_URL: opts.checkoutUrl ?? "https://pay.hotmart.com/G107726319K?checkoutMode=10",
    scrollY: 0,
    innerHeight: 800,
    addEventListener: (type: string, fn: () => void) => {
      if (type === "scroll") scrollListeners.push(fn);
    },
  };
  const doc = {
    body: { dataset: { variante: opts.variante ?? "d" } },
    cookie: opts.cookie ?? "",
    documentElement: { scrollHeight: 1000 },
    querySelectorAll: (sel: string) => (sel === ".checkout-link" ? links : []),
    querySelector: () => null,
  };
  const nav = {
    sendBeacon: (url: string, blob: Blob) => {
      beacons.push({ url, body: blob.text() });
      return true;
    },
  };
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    window: win,
    document: doc,
    navigator: nav,
    URL,
    URLSearchParams,
    Blob,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return 0;
    },
  });
  vm.runInContext(js, context);
  const click = (mods: { ctrlKey?: boolean } = {}) =>
    links[0].listeners.forEach((fn) =>
      fn({ button: 0, metaKey: false, ctrlKey: !!mods.ctrlKey, shiftKey: false, altKey: false, preventDefault: () => {} }),
    );
  const runTimers = () => timers.splice(0).forEach((fn) => fn());
  const locationHref = () => String((win.location as { href: string }).href);
  const scrollToEnd = () => {
    win.scrollY = 1000;
    scrollListeners.forEach((fn) => fn());
  };
  return { fbqCalls, beacons, click, scrollToEnd, runTimers, locationHref };
}

const AD_VISIT = "?utm_source=meta&utm_content=AD99&fbclid=teste";
const AD_COOKIE = "_fbc=fb.1.1760000000000.teste; _fbp=fb.1.1760000000000.123";

describe("#10079 evento/agente-ia/script.js — origem em todos os eventos", () => {
  it("visita de anúncio: VisitaPagina, Rolagem50/90 e CliqueIngresso levam origem=meta e utm_content", () => {
    const page = runPageScript(EVENTO_JS, { search: AD_VISIT, cookie: AD_COOKIE });
    page.scrollToEnd();
    page.click();
    const names = page.fbqCalls.map((c) => c.args[1]);
    assert.deepEqual(names, ["VisitaPagina_D", "Rolagem50_D", "Rolagem90_D", "CliqueIngresso_D"], "nomes dos eventos não mudam");
    for (const call of page.fbqCalls) {
      assert.equal(call.args[0], "trackCustom");
      const params = call.args[2] as Record<string, string>;
      assert.equal(params.origem, "meta", `${String(call.args[1])} sem origem`);
      assert.equal(params.utm_content, "AD99");
      assert.equal(params.utm_campaign, undefined, "utm_campaign ausente na URL não vira string vazia");
    }
    const clique = page.fbqCalls[3].args;
    assert.equal((clique[2] as Record<string, string>).posicao, "topo");
    assert.match(String((clique[3] as { eventID: string }).eventID), /^clique-d-topo-/);
  });

  it("o beacon do clique leva origem, utm_content, utm_campaign e o _fbc do cookie", async () => {
    const page = runPageScript(EVENTO_JS, { search: `${AD_VISIT}&utm_campaign=evento-1710`, cookie: AD_COOKIE });
    page.click();
    assert.equal(page.beacons.length, 1);
    assert.equal(page.beacons[0].url, "/evento/agente-ia/clique");
    const body = JSON.parse(await page.beacons[0].body);
    assert.equal(body.variant, "d");
    assert.equal(body.origem, "meta");
    assert.equal(body.utm_content, "AD99");
    assert.equal(body.utm_campaign, "evento-1710");
    assert.equal(body.fbc, "fb.1.1760000000000.teste");
    const eventId = (page.fbqCalls.at(-1)?.args[3] as { eventID: string }).eventID;
    assert.equal(body.event_id, eventId, "mesmo event_id do fbq, senão a Meta não deduplica");
  });

  it("visita sem parâmetros chega com origem=direto, sem utm_campaign/utm_content", async () => {
    const page = runPageScript(EVENTO_JS, { search: "" });
    page.click();
    for (const call of page.fbqCalls) {
      assert.deepEqual(Object.keys(call.args[2] as object).sort(), call.args[1] === "CliqueIngresso_D" ? ["origem", "posicao"] : ["origem"]);
      assert.equal((call.args[2] as Record<string, string>).origem, "direto");
    }
    const body = JSON.parse(await page.beacons[0].body);
    assert.equal(body.origem, "direto");
    assert.equal(body.utm_campaign, "");
    assert.equal(body.utm_content, "");
  });

  it("só fbclid (anúncio sem UTM) → origem=meta; utm_source vence o fbclid", () => {
    const soFbclid = runPageScript(EVENTO_JS, { search: "?fbclid=abc" });
    assert.equal((soFbclid.fbqCalls[0].args[2] as Record<string, string>).origem, "meta");
    const newsletter = runPageScript(EVENTO_JS, { search: "?utm_source=diaria&fbclid=abc" });
    assert.equal((newsletter.fbqCalls[0].args[2] as Record<string, string>).origem, "diaria");
  });

  it("corta cada campo no mesmo teto do servidor", () => {
    const long = "x".repeat(CLICK_BEACON_ORIGIN_FIELD_MAX + 40);
    const page = runPageScript(EVENTO_JS, { search: `?utm_source=${long}&utm_content=${long}` });
    const params = page.fbqCalls[0].args[2] as Record<string, string>;
    assert.equal(params.origem.length, CLICK_BEACON_ORIGIN_FIELD_MAX);
    assert.equal(params.utm_content.length, CLICK_BEACON_ORIGIN_FIELD_MAX);
  });
});

describe("#10079 guia/agente-ia/script.js — origem em todos os eventos", () => {
  it("GuiaVisita, GuiaRolagem50/90 e GuiaClique levam origem=meta e utm_content", () => {
    const page = runPageScript(GUIA_JS, { search: AD_VISIT });
    page.scrollToEnd();
    page.click();
    assert.deepEqual(
      page.fbqCalls.map((c) => c.args[1]),
      ["GuiaVisita", "GuiaRolagem50", "GuiaRolagem90", "GuiaClique"],
    );
    for (const call of page.fbqCalls) {
      const params = call.args[2] as Record<string, string>;
      assert.equal(params.origem, "meta");
      assert.equal(params.utm_content, "AD99");
    }
    assert.equal((page.fbqCalls[3].args[2] as Record<string, string>).posicao, "topo");
  });

  it("visita sem parâmetros → origem=direto", () => {
    const page = runPageScript(GUIA_JS, { search: "" });
    // JSON: o objeto nasce em outro realm (vm), e deepStrictEqual compara protótipos.
    assert.deepEqual(JSON.parse(JSON.stringify(page.fbqCalls[0].args[2])), { origem: "direto" });
  });
});

describe("#10079 drift: regra de origem no JS estático", () => {
  it("as duas páginas cortam em CLICK_BEACON_ORIGIN_FIELD_MAX", () => {
    for (const js of [EVENTO_JS, GUIA_JS]) {
      assert.match(js, new RegExp(`const ORIGIN_FIELD_MAX = ${CLICK_BEACON_ORIGIN_FIELD_MAX};`));
    }
  });

  it("visitOrigin é idêntica nas duas páginas (sem passo de build, é cópia)", () => {
    const fn = (js: string) => js.match(/function visitOrigin\(search\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn(EVENTO_JS));
    assert.equal(fn(EVENTO_JS), fn(GUIA_JS));
  });

  it("não declara `origin` no topo (encobriria window.origin para os outros scripts da página)", () => {
    for (const js of [EVENTO_JS, GUIA_JS]) assert.doesNotMatch(js, /^(?:const|let|var) origin\b/m);
  });
});

describe("#10079 casos de borda da origem", () => {
  it("utm_source vazio ou só com espaços cai para a regra do fbclid", () => {
    const vazio = runPageScript(EVENTO_JS, { search: "?utm_source=&fbclid=x" });
    assert.equal((vazio.fbqCalls[0].args[2] as Record<string, string>).origem, "meta");
    const espacos = runPageScript(EVENTO_JS, { search: "?utm_source=%20%20" });
    assert.equal((espacos.fbqCalls[0].args[2] as Record<string, string>).origem, "direto");
  });

  it("corte não deixa espaço no fim (fbq e CAPI mandam o mesmo valor)", () => {
    const valor = "a".repeat(CLICK_BEACON_ORIGIN_FIELD_MAX - 1) + "%20b";
    const page = runPageScript(EVENTO_JS, { search: `?utm_content=${valor}` });
    const content = (page.fbqCalls[0].args[2] as Record<string, string>).utm_content;
    assert.equal(content, "a".repeat(CLICK_BEACON_ORIGIN_FIELD_MAX - 1));
    assert.equal(parseClickBeaconBody(JSON.stringify({ utm_content: content })).utmContent, content);
  });

  it("fbq que lança não impede a navegação para o checkout", () => {
    const page = runPageScript(EVENTO_JS, { search: AD_VISIT, fbqThrows: true });
    page.click();
    page.runTimers();
    assert.match(page.locationHref(), /^https:\/\/pay\.hotmart\.com\//);
  });

  it("clique com modificador (nova aba) também leva a origem, sem beacon", () => {
    const page = runPageScript(EVENTO_JS, { search: AD_VISIT });
    page.click({ ctrlKey: true });
    const last = page.fbqCalls.at(-1)!.args;
    assert.equal(last[1], "CliqueIngresso_D");
    assert.equal((last[2] as Record<string, string>).origem, "meta");
    assert.equal(page.beacons.length, 0);
  });

  it("clique comum navega para o checkout com as UTMs depois do beacon", () => {
    const page = runPageScript(EVENTO_JS, { search: AD_VISIT });
    page.click();
    assert.equal(page.locationHref(), "", "não navega antes do timer");
    page.runTimers();
    const dest = new URL(page.locationHref());
    assert.equal(dest.searchParams.get("utm_content"), "AD99");
    assert.equal(dest.searchParams.get("fbclid"), "teste");
  });
});

describe("#10079 parseClickBeaconBody / clickBeaconCustomData", () => {
  it("lê origem, utm_campaign e utm_content do corpo", () => {
    const p = parseClickBeaconBody(
      JSON.stringify({ variant: "d", event_id: "e1", origem: "meta", utm_campaign: "c1", utm_content: "AD99" }),
    );
    assert.equal(p.origem, "meta");
    assert.equal(p.utmCampaign, "c1");
    assert.equal(p.utmContent, "AD99");
  });

  it("corta em CLICK_BEACON_ORIGIN_FIELD_MAX e ignora tipo errado", () => {
    const long = "y".repeat(CLICK_BEACON_ORIGIN_FIELD_MAX + 10);
    const p = parseClickBeaconBody(JSON.stringify({ origem: long, utm_campaign: 42, utm_content: { a: 1 } }));
    assert.equal(p.origem.length, CLICK_BEACON_ORIGIN_FIELD_MAX);
    assert.equal(p.utmCampaign, "");
    assert.equal(p.utmContent, "");
  });

  it("custom_data omite campo vazio (beacon de script antigo em cache não manda origem)", () => {
    const antigo = parseClickBeaconBody(JSON.stringify({ variant: "d", event_id: "e1", posicao: "topo" }));
    const v = validateClickBeacon(antigo);
    assert.ok(v.ok);
    if (v.ok) assert.deepEqual(clickBeaconCustomData(antigo, v), { posicao: "topo" });
  });
});

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } as unknown as Env["ASSETS"],
    POLL: { get: async () => null } as unknown as Env["POLL"],
    ...overrides,
  };
}

async function captureCapiSend(request: Request): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const res = await worker.fetch(request, fakeEnv({ META_CAPI_ACCESS_TOKEN: "tok" }));
    assert.equal(res.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

describe("#10079 POST /evento/agente-ia/clique — fbc e origem chegam ao envio para a CAPI", () => {
  it("fbc no corpo do beacon vira user_data.fbc; origem/utm_campaign/utm_content vão em custom_data", async () => {
    const sent = await captureCapiSend(
      new Request("https://diar.ia.br/evento/agente-ia/clique", {
        method: "POST",
        headers: { Referer: "https://diar.ia.br/evento/agente-ia/d?utm_source=meta&utm_content=AD99&fbclid=teste" },
        body: JSON.stringify({
          variant: "d",
          posicao: "topo",
          event_id: "clique-d-topo-1",
          fbc: "fb.1.1760000000000.teste",
          fbp: "fb.1.1760000000000.123",
          origem: "meta",
          utm_campaign: "evento-1710",
          utm_content: "AD99",
        }),
      }),
    );
    assert.equal(sent.length, 1);
    const event = (sent[0].data as Array<Record<string, unknown>>)[0];
    assert.equal(event.event_name, "CliqueIngresso_D");
    assert.equal(event.event_id, "clique-d-topo-1");
    const userData = event.user_data as Record<string, unknown>;
    assert.equal(userData.fbc, "fb.1.1760000000000.teste");
    assert.equal(userData.fbp, "fb.1.1760000000000.123");
    assert.deepEqual(event.custom_data, {
      posicao: "topo",
      origem: "meta",
      utm_campaign: "evento-1710",
      utm_content: "AD99",
    });
  });

  it("fbc só no cookie do request (beacon same-origin) também chega a user_data.fbc", async () => {
    const sent = await captureCapiSend(
      new Request("https://diar.ia.br/evento/agente-ia/clique", {
        method: "POST",
        headers: { Cookie: "_fbc=fb.1.1760000000000.cookie" },
        body: JSON.stringify({ variant: "d", posicao: "topo", event_id: "e2", origem: "direto" }),
      }),
    );
    const event = (sent[0].data as Array<Record<string, unknown>>)[0];
    assert.equal((event.user_data as Record<string, unknown>).fbc, "fb.1.1760000000000.cookie");
    assert.deepEqual(event.custom_data, { posicao: "topo", origem: "direto" });
  });
});
