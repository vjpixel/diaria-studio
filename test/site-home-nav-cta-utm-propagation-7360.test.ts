/**
 * test/site-home-nav-cta-utm-propagation-7360.test.ts (#7360)
 *
 * `buildIndexHtml` (`scripts/lib/site-home-page.ts:1266-1281`) embute um IIFE
 * inline (comentário `#6427`) que repassa `window.location.search` — cru,
 * sem reserializar — pro `href` do CTA "Assinar" do nav (`a[href="/assinar"]`,
 * linha 1126) antes do primeiro clique. É o mecanismo IRMÃO do prefill de
 * `signupFormScript()` já coberto por `test/site-home-signup-utm-prefill-7360.test.ts`
 * e `test/site-home-signup-submit-6979.test.ts` (REGRESSÃO #7360): mesma
 * família de risco (perda silenciosa de UTM na home, #6427/#6980), mas nunca
 * tinha teste próprio — `grep` por `ctas\[i\]`/`href="/assinar"` em `test/`
 * não retornava nada antes deste arquivo.
 *
 * Se este elo quebrar (seletor errado, `location.search` não lido, guard
 * `if (!window.location.search) return` invertido), o clique no CTA do nav
 * perde toda a query string de atribuição — inversão silenciosa da mesma
 * classe do #6980/#7360, só que no link estático em vez do form.
 *
 * Técnica: extrai o corpo JS do MESMO `<script>` (via o comentário `#6427`
 * como âncora, já que o HTML final tem vários `<script>` — GTM, o form,
 * este) e roda via `new Function("window", "document", body)` sobre um DOM
 * mínimo hand-rolled, mesma abordagem de `test/site-home-signup-utm-prefill-7360.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";

const FEATURE = {
  slug: "destaque-do-dia",
  title: "Destaque do dia",
  description: "Resumo do destaque",
  url: "https://diar.ia.br/p/destaque-do-dia",
  date: "2026-08-27",
  image: null,
};

/** Extrai o corpo JS do `<script>` do bloco `#6427` (propagação de UTM pro CTA do nav). */
function extractNavCtaScript(html: string): string {
  const marker = "// #6427: repassa a query string ATUAL";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("marcador #6427 não encontrado no HTML de buildIndexHtml");
  const scriptOpen = html.lastIndexOf("<script>", start);
  const scriptClose = html.indexOf("</script>", start);
  if (scriptOpen === -1 || scriptClose === -1) {
    throw new Error("não foi possível isolar o <script>...</script> do bloco #6427");
  }
  return html.slice(scriptOpen + "<script>".length, scriptClose);
}

/** `<a href="/assinar">` mínimo — só o que o IIFE toca (getAttribute/setAttribute). */
function makeAnchor() {
  const attrs: Record<string, string> = { href: "/assinar" };
  return {
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
    get href() {
      return attrs.href;
    },
  };
}

/** Roda o IIFE do bloco #6427 num `window`/`document` mínimos com `search` dado. */
function runWithSearch(search: string) {
  const html = buildIndexHtml({ feature: FEATURE, archive: [] });
  const body = extractNavCtaScript(html);
  const cta = makeAnchor();
  const win: any = { location: { search } };
  const doc: any = {
    querySelectorAll: (sel: string) => (sel === 'a[href="/assinar"]' ? [cta] : []),
  };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", body)(win, doc);
  return cta;
}

describe("buildIndexHtml — propagação de UTM pro CTA do nav via location.search (#7360, bloco #6427)", () => {
  it("location.search com UTMs: href do CTA vira /assinar + a query string INTEIRA (crua, não reserializada)", () => {
    const cta = runWithSearch("?utm_source=google&utm_medium=cpc&utm_campaign=lancamento-260901");
    assert.equal(cta.href, "/assinar?utm_source=google&utm_medium=cpc&utm_campaign=lancamento-260901");
  });

  it("location.search com parâmetros não-UTM misturados (gclid, fbclid): repassa tudo cru, sem filtrar — mesmo contrato do redirect de #7799/confirmado.ts", () => {
    const cta = runWithSearch("?gclid=abc123&utm_source=microsoft-ads&fbclid=xyz");
    assert.equal(cta.href, "/assinar?gclid=abc123&utm_source=microsoft-ads&fbclid=xyz");
  });

  it("location.search vazio: href do CTA continua exatamente /assinar — guard `if (!window.location.search) return` não mexe no atributo", () => {
    const cta = runWithSearch("");
    assert.equal(cta.href, "/assinar");
  });
});
