/**
 * test/internal-mode-10080.test.ts (#10080)
 *
 * Modo interno das páginas `/evento/agente-ia/*`, `/guia/agente-ia` e `/produto/conteudo-autentico`:
 * `?interno=1` grava um marcador no localStorage, `?interno=0` apaga. Com o
 * marcador, nenhuma chamada ao pixel da Meta, ao GTM nem ao beacon do clique;
 * o link para o checkout continua funcionando e a página mostra um aviso.
 *
 * Cobre: o bootstrap inline (executado num `vm`), o HTML das 5 páginas (o
 * bootstrap vem antes do GTM e do pixel, e os dois só rodam fora do modo
 * interno) e os dois `script.js` com o modo ligado e desligado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  internalModeBootstrapJs,
  skipWhenInternalJs,
  INTERNAL_MODE_STORAGE_KEY,
} from "../scripts/lib/shared/internal-mode.ts";
import { renderAnalyticsHead } from "../scripts/lib/shared/seo-meta.ts";

const PUBLIC = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "workers/site/public");
const PAGES = ["evento/agente-ia/a", "evento/agente-ia/b", "evento/agente-ia/c", "evento/agente-ia/d", "evento/agente-ia/e", "evento/agente-ia/f", "guia/agente-ia", "produto/conteudo-autentico/a", "produto/conteudo-autentico/b"].map((p) => ({
  name: p,
  html: readFileSync(join(PUBLIC, p, "index.html"), "utf8"),
}));
const EVENTO_JS = readFileSync(join(PUBLIC, "evento/agente-ia/script.js"), "utf8");
const GUIA_JS = readFileSync(join(PUBLIC, "guia/agente-ia/script.js"), "utf8");
const PRODUTO_JS = readFileSync(join(PUBLIC, "produto/conteudo-autentico/b/script.js"), "utf8");

function fakeStorage(initial: Record<string, string> = {}, opts: { throws?: boolean } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (opts.throws) throw new Error("SecurityError");
  };
  return {
    data,
    getItem: (k: string) => (guard(), data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => (guard(), void data.set(k, String(v))),
    removeItem: (k: string) => (guard(), void data.delete(k)),
  };
}

/** Executa o bootstrap inline do <head> e devolve o window resultante. */
function runBootstrap(search: string, storage: ReturnType<typeof fakeStorage>) {
  const replaced: string[] = [];
  const win: Record<string, unknown> = {
    location: { search, href: `https://diar.ia.br/evento/agente-ia/d${search}#oferta` },
    localStorage: storage,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
  };
  const ctx = vm.createContext({ window: win, URLSearchParams, URL });
  vm.runInContext(internalModeBootstrapJs(), ctx);
  return Object.assign(win, { replaced, globals: Object.keys(ctx) });
}

describe("#10080 bootstrap do modo interno", () => {
  it("?interno=1 grava o marcador e liga o modo", () => {
    const storage = fakeStorage();
    const win = runBootstrap("?interno=1", storage);
    assert.equal(win.__DIA_INTERNO__, true);
    assert.equal(storage.data.get(INTERNAL_MODE_STORAGE_KEY), "1");
  });

  it("o marcador vale nas visitas seguintes, sem parâmetro", () => {
    const storage = fakeStorage({ [INTERNAL_MODE_STORAGE_KEY]: "1" });
    assert.equal(runBootstrap("?utm_source=meta", storage).__DIA_INTERNO__, true);
  });

  it("?interno=0 apaga o marcador e desliga o modo", () => {
    const storage = fakeStorage({ [INTERNAL_MODE_STORAGE_KEY]: "1" });
    const win = runBootstrap("?interno=0", storage);
    assert.equal(win.__DIA_INTERNO__, false);
    assert.equal(storage.data.has(INTERNAL_MODE_STORAGE_KEY), false);
  });

  it("sem marcador nem parâmetro: modo normal; valor diferente de 1/0 não muda nada", () => {
    assert.equal(runBootstrap("", fakeStorage()).__DIA_INTERNO__, false);
    assert.equal(runBootstrap("?interno=sim", fakeStorage()).__DIA_INTERNO__, false);
  });

  it("tira só o ?interno da barra de endereço, mantendo UTMs e âncora", () => {
    const win = runBootstrap("?utm_source=meta&interno=1&utm_content=AD99", fakeStorage());
    assert.deepEqual(win.replaced, ["/evento/agente-ia/d?utm_source=meta&utm_content=AD99#oferta"]);
    assert.deepEqual(runBootstrap("?utm_source=meta", fakeStorage()).replaced, [], "sem o parâmetro, não mexe na URL");
  });

  it("não deixa variáveis no escopo global", () => {
    const win = runBootstrap("?interno=1", fakeStorage());
    assert.deepEqual(win.globals.sort(), ["URL", "URLSearchParams", "window"]);
  });

  it("localStorage bloqueado: modo normal, sem erro", () => {
    assert.equal(runBootstrap("?interno=1", fakeStorage({}, { throws: true })).__DIA_INTERNO__, false);
  });
});

describe("#10080 HTML das páginas", () => {
  const loaderBody = renderAnalyticsHead().match(/<script>(\(function\(w,d,s,l,i\)[\s\S]*?)<\/script>/)?.[1];

  for (const page of PAGES) {
    it(`${page.name}: bootstrap inline igual ao helper, antes do GTM e do pixel`, () => {
      const boot = `<script>${internalModeBootstrapJs()}</script>`;
      assert.equal(page.html.split(boot).length - 1, 1, "bootstrap ausente, divergente do helper ou duplicado");
      const bootAt = page.html.indexOf(boot);
      assert.ok(bootAt < page.html.indexOf("googletagmanager.com/gtm.js"), "GTM antes do bootstrap");
      assert.ok(bootAt < page.html.indexOf("fbq('init'"), "pixel antes do bootstrap");
    });

    it(`${page.name}: GTM só carrega fora do modo interno (loader igual ao de renderAnalyticsHead)`, () => {
      assert.ok(loaderBody);
      assert.ok(page.html.includes(`<script>${skipWhenInternalJs(loaderBody)}</script>`));
      assert.equal(page.html.split("googletagmanager.com/gtm.js").length - 1, 1);
    });

    it(`${page.name}: pixel só inicializa fora do modo interno (e só em diar.ia.br)`, () => {
      const m = page.html.match(/<!-- Meta Pixel[\s\S]*?<script>([\s\S]*?)<\/script>/);
      assert.ok(m);
      assert.ok(m[1].includes(String.raw`if (/(^|\.)diar\.ia\.br$/.test(window.location.hostname) && !window.__DIA_INTERNO__) {`));
    });
  }
});

/** Roda um script.js de página com o modo interno ligado ou não. */
function runPage(js: string, interno: boolean, search = "?utm_source=meta&fbclid=x") {
  const fbqCalls: unknown[][] = [];
  const beacons: string[] = [];
  const appended: Array<{ textContent: string; className: string }> = [];
  const timers: Array<() => void> = [];
  const links = [
    {
      dataset: { posicao: "topo" },
      href: "",
      hidden: true,
      listeners: [] as Array<(ev: Record<string, unknown>) => void>,
      addEventListener(type: string, fn: (ev: Record<string, unknown>) => void) {
        if (type === "click") this.listeners.push(fn);
      },
    },
  ];
  const win: Record<string, unknown> = {
    location: { search, href: "" },
    fbq: (...args: unknown[]) => fbqCalls.push(args),
    __DIA_INTERNO__: interno,
    EVENT_CHECKOUT_URL: "https://pay.hotmart.com/G107726319K?checkoutMode=10",
    scrollY: 0,
    innerHeight: 800,
    addEventListener: () => {},
  };
  const doc = {
    body: {
      dataset: { variante: "d" },
      appendChild: (el: { textContent: string; className: string }) => appended.push(el),
    },
    cookie: "",
    documentElement: { scrollHeight: 1000 },
    querySelectorAll: (sel: string) => (sel === ".checkout-link" ? links : []),
    querySelector: () => null,
    createElement: () => ({ textContent: "", className: "", style: {}, setAttribute() {} }),
  };
  const context = vm.createContext({
    window: win,
    document: doc,
    navigator: {
      sendBeacon: (url: string) => {
        beacons.push(url);
        return true;
      },
    },
    URL,
    URLSearchParams,
    Blob,
    setTimeout: (fn: () => void) => (timers.push(fn), 0),
  });
  vm.runInContext(js, context);
  let prevented = false;
  links[0].listeners.forEach((fn) =>
    fn({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented = true;
      },
    }),
  );
  timers.splice(0).forEach((fn) => fn());
  // Destino do clique: navegação pelo script (location.href) ou, sem
  // preventDefault, a navegação nativa do link.
  const scripted = String((win.location as { href: string }).href);
  return { fbqCalls, beacons, appended, href: scripted || (prevented ? "" : links[0].href) };
}

describe("#10080 script.js com o modo interno", () => {
  for (const [name, js] of [
    ["evento", EVENTO_JS],
    ["guia", GUIA_JS],
    ["produto", PRODUTO_JS],
  ] as const) {
    it(`${name}: ligado — nenhuma chamada ao fbq nem ao beacon, aviso na página, clique segue para o checkout`, () => {
      const r = runPage(js, true);
      assert.equal(r.fbqCalls.length, 0);
      assert.equal(r.beacons.length, 0);
      assert.equal(r.appended.length, 1);
      assert.equal(r.appended[0].textContent, "Modo interno: visita não medida");
      assert.doesNotMatch(r.appended[0].textContent, /→/);
      assert.match(r.href, /^https:\/\/pay\.hotmart\.com\//);
    });

    it(`${name}: o parâmetro interno nunca segue para o checkout`, () => {
      const r = runPage(js, true, "?utm_source=meta&interno=1");
      assert.doesNotMatch(r.href, /interno/);
      assert.match(r.href, /utm_source=meta/);
    });

    it(`${name}: desligado — eventos voltam a disparar e não há aviso`, () => {
      const r = runPage(js, false);
      assert.ok(r.fbqCalls.length >= 2, "visita e clique");
      assert.equal(r.appended.length, 0);
      assert.match(r.href, /^https:\/\/pay\.hotmart\.com\//);
      if (name === "evento") assert.deepEqual(r.beacons, ["/evento/agente-ia/clique"]);
    });
  }
});
