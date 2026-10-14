/**
 * test/evento-e-float-cta-origin-10217.test.ts (#10217)
 *
 * `/evento/agente-ia/e/script.js` disparava `fbq("trackCustom",
 * "CliqueFlutuante_E", {})` direto — o evento saía sem `origem`/
 * `utm_campaign`/`utm_content` (#10079) e ignorava o modo interno (#10080).
 * Agora passa pelo `track()` do script comum. Os dois scripts são executados
 * de verdade, na ordem da página (comum → variante), num mesmo `vm`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const COMMON_JS = readFileSync(join(process.cwd(), "workers/site/public/evento/agente-ia/script.js"), "utf8");
const E_JS = readFileSync(join(process.cwd(), "workers/site/public/evento/agente-ia/e/script.js"), "utf8");
const E_HTML = readFileSync(join(process.cwd(), "workers/site/public/evento/agente-ia/e/index.html"), "utf8");

/** Objeto criado dentro do `vm` tem outro Object.prototype — normaliza pro deepEqual. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

function runVariantE(opts: { search: string; interno?: boolean }) {
  const fbqCalls: unknown[][] = [];
  const floatListeners: Array<() => void> = [];
  const floatCta = {
    hidden: true,
    tabIndex: -1,
    classList: { toggle: () => {} },
    setAttribute: () => {},
    addEventListener: (type: string, fn: () => void) => {
      if (type === "click") floatListeners.push(fn);
    },
  };
  const win: Record<string, unknown> = {
    location: { search: opts.search, href: "" },
    fbq: (...args: unknown[]) => fbqCalls.push(args),
    EVENT_CHECKOUT_URL: "",
    scrollY: 0,
    innerHeight: 800,
    addEventListener: () => {},
    ...(opts.interno ? { __DIA_INTERNO__: true } : {}),
  };
  const doc = {
    body: { dataset: { variante: "e" }, appendChild: () => {} },
    cookie: "",
    documentElement: { scrollHeight: 1000 },
    createElement: () => ({ setAttribute: () => {}, style: {} }),
    querySelectorAll: () => [],
    querySelector: (sel: string) => (sel === ".float-cta" ? floatCta : null),
  };
  const context = vm.createContext({ window: win, document: doc, navigator: {}, URL, URLSearchParams, Blob, setTimeout });
  vm.runInContext(COMMON_JS, context);
  vm.runInContext(E_JS, context);
  const clickFloat = () => floatListeners.forEach((fn) => fn());
  return { fbqCalls, clickFloat, floatListeners };
}

describe("#10217 /evento/agente-ia/e — CliqueFlutuante_E leva a origem da visita", () => {
  it("REGRESSÃO: clique no botão flutuante de visita de anúncio sai com origem=meta, utm_campaign e utm_content", () => {
    const page = runVariantE({ search: "?utm_source=meta&utm_campaign=evento-1710&utm_content=AD99&fbclid=x" });
    assert.equal(page.floatListeners.length, 1);
    page.clickFloat();
    const call = page.fbqCalls.find((c) => c[1] === "CliqueFlutuante_E");
    assert.ok(call, "CliqueFlutuante_E não disparou");
    assert.equal(call[0], "trackCustom");
    assert.deepEqual(plain(call[2]), { origem: "meta", utm_campaign: "evento-1710", utm_content: "AD99" });
  });

  it("visita direta → origem=direto", () => {
    const page = runVariantE({ search: "" });
    page.clickFloat();
    const call = page.fbqCalls.find((c) => c[1] === "CliqueFlutuante_E");
    assert.deepEqual(plain(call?.[2]), { origem: "direto" });
  });

  it("modo interno (#10080): o clique flutuante não vai para a Meta", () => {
    const page = runVariantE({ search: "?utm_source=meta", interno: true });
    page.clickFloat();
    assert.deepEqual(page.fbqCalls, []);
  });

  it("o script comum (que define track) carrega ANTES do da variante", () => {
    const common = E_HTML.indexOf('src="/evento/agente-ia/script.js"');
    const variant = E_HTML.indexOf('src="/evento/agente-ia/e/script.js"');
    assert.ok(common >= 0 && variant > common, "ordem dos <script defer> mudou — track() não existiria no clique");
  });

  it("nenhum fbq direto sobra no script da variante", () => {
    assert.doesNotMatch(E_JS, /fbq\s*\(/);
  });
});
