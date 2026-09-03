/**
 * test/subscribe-form-fetch-timeout-6981.test.ts (#6981)
 *
 * `test/site-home-signup-submit-6979.test.ts` já cobre o timeout do form da
 * HOME (`signupFormScript()`, site-home-page.ts). Esta issue (#6981) achou
 * que NENHUMA outra cópia do mesmo padrão de submit tinha `AbortController`+
 * timeout — sem isso, uma promise de fetch que nunca resolve (DNS travado,
 * proxy/firewall engolindo o POST cross-origin, Worker pendurado) deixa
 * "Enviando…" pendurado pra sempre, sem erro visível e sem caminho de retry
 * a não ser recarregar a página.
 *
 * Cobre a mesma técnica de `test/poll-jogar-identify-native-submit-4031.test.ts`
 * (extrai o corpo JS de dentro de `<script>…</script>` e roda via
 * `new Function("window", "document", body)` sobre um DOM mínimo baseado em
 * `EventTarget`), aplicada às 3 superfícies corrigidas pelo #6981 além da
 * home:
 *
 *   - `inlineSignupScript()` (workers/poll/src/jogar.ts) — form embutido no
 *     `/jogar`/`/jogar/quiz` (id fixo `jogar-signup-form`).
 *   - `renderCuradoriaCtaSubscribeScript()` (scripts/lib/shared/curadoria-page.ts)
 *     — CTA `.cta-subscribe-form`, reusado por hub pages, entity pages e o
 *     acervo (`render-archive.ts`) — a maior superfície de reuso das ~10
 *     citadas na issue.
 *   - `renderSubscribeCtaScript()` (scripts/build-livros-page.ts) — CTA
 *     `.cta-subscribe-form` da página de livros (hero + fim de lista).
 *
 * Todas as 3 reusam `SIGNUP_FORM_FETCH_TIMEOUT_MS` (site-home-page.ts, #6979)
 * — mesmo valor, não um número escolhido de novo por superfície (pedido
 * explícito do editor no comentário da #6981).
 *
 *   - o form standalone de `/assinar` (`buildAssinarHtml()`,
 *     scripts/lib/site-assinar-page.ts) — extraído do HTML completo (único
 *     `<script>` da página), id fixo `assinar-form`.
 *
 * `workers/poll/src/web-gate.ts` (fluxo verify→subscribe→identify encadeado
 * do gate) fica de fora desta rodada — não segue o padrão simples de 1
 * fetch por submit que a técnica abaixo cobre; ver corpo da issue #6981
 * para o inventário completo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { inlineSignupScript } from "../workers/poll/src/jogar.ts";
import { renderCuradoriaCtaSubscribeScript } from "../scripts/lib/shared/curadoria-page.ts";
import { renderSubscribeCtaScript } from "../scripts/build-livros-page.ts";
import { SIGNUP_FORM_FETCH_TIMEOUT_MS } from "../scripts/lib/site-home-page.ts";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";

/** Campo mínimo — só o que os scripts tocam (value/checked/disabled/style). */
function makeField(value = "", checked = false): any {
  return { value, checked, disabled: false, style: {} };
}

function makeStatus(hidden = true): any {
  return { hidden, textContent: "", className: "" };
}

/** Form mínimo sobre EventTarget nativo — cobre os 2 shapes usados pelas 3
 * superfícies (".signup-status"/".cta-status", id/data-source). */
function makeForm(opts: {
  statusClass: ".signup-status" | ".cta-status";
  email?: string;
  optinChecked?: boolean;
  website?: string;
  dataSource?: string;
}) {
  const form: any = new EventTarget();
  const email = makeField(opts.email ?? "novo@example.com");
  const optin = makeField("on", opts.optinChecked ?? true);
  const website = makeField(opts.website ?? "");
  const name = makeField("");
  const btn = makeField();
  const status = makeStatus();

  const selectors: Record<string, any> = {
    'input[name="email"]': email,
    'input[name="optin"]': optin,
    'input[name="website"]': website,
    'input[name="name"]': name,
    'button[type="submit"]': btn,
    [opts.statusClass]: status,
  };
  form.querySelector = (sel: string) => selectors[sel] ?? null;
  form.querySelectorAll = (sel: string) =>
    sel === "input, button" ? [email, optin, website, name, btn] : [];
  form.getAttribute = (attr: string) => (attr === "data-source" ? (opts.dataSource ?? "") : null);
  form.reset = () => {};

  const submit = () => {
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    return ev;
  };

  return { form, email, optin, website, btn, status, submit };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Extrai o corpo JS de dentro de `<script>…</script>`. */
function scriptBody(raw: string): string {
  return raw.replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
}

/** Extrai o corpo JS do `<script>…</script>` que faz o wiring do form, de
 * dentro de um documento HTML completo (usado por `buildAssinarHtml()`, que
 * não expõe o script como função separada — a página inteira é um único
 * template literal). #7358 acrescentou o container GTM (`renderAnalyticsHead()`)
 * no `<head>` — é o 1º `<script>` do documento agora, então localizar pelo
 * conteúdo (`getElementById('assinar-form')`) em vez de pegar o 1º match. */
function scriptBodyFromFullHtml(html: string): string {
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
  const target = scripts.find((s) => s.includes("assinar-form"));
  if (!target) throw new Error("nenhum <script> com o wiring de #assinar-form encontrado no HTML");
  return target.replace(/^<script>/, "").replace(/<\/script>$/, "");
}

describe("inlineSignupScript() — timeout do fetch (#6981)", () => {
  it(`form embutido (id='jogar-signup-form'): fetch que nunca resolve é abortado após ${SIGNUP_FORM_FETCH_TIMEOUT_MS}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const bundle = makeForm({ statusClass: ".signup-status" });
    const win: any = {
      fetch: (_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          if (options.signal) {
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }
        }),
      AbortController: typeof AbortController === "function" ? AbortController : undefined,
    };
    const doc: any = { getElementById: (id: string) => (id === "jogar-signup-form" ? bundle.form : null) };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", scriptBody(inlineSignupScript("jogar")))(win, doc);

    bundle.submit();
    assert.equal(bundle.btn.disabled, true);
    assert.equal(aborted, false, "não deve abortar antes do timeout");

    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(aborted, true, "o AbortController deveria abortar após o timeout");
    assert.equal(bundle.status.textContent, "Erro de conexão. Tente de novo.");
    assert.equal(bundle.btn.disabled, false, "botão precisa reabilitar — senão o form fica morto pra sempre");
  });
});

describe("renderCuradoriaCtaSubscribeScript() — timeout do fetch (#6981)", () => {
  it(`CTA de hub/entidade/acervo ('.cta-subscribe-form'): fetch que nunca resolve é abortado após ${SIGNUP_FORM_FETCH_TIMEOUT_MS}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const bundle = makeForm({ statusClass: ".cta-status", dataSource: "hub-google-gemini" });
    const win: any = {
      fetch: (_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          if (options.signal) {
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }
        }),
      AbortController: typeof AbortController === "function" ? AbortController : undefined,
    };
    const doc: any = { querySelectorAll: (sel: string) => (sel === ".cta-subscribe-form" ? [bundle.form] : []) };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", scriptBody(renderCuradoriaCtaSubscribeScript()))(win, doc);

    bundle.submit();
    assert.equal(bundle.btn.disabled, true);

    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(aborted, true, "o AbortController deveria abortar após o timeout");
    assert.equal(bundle.status.textContent, "Erro de conexão. Tente de novo.");
    assert.equal(bundle.btn.disabled, false);
  });
});

describe("renderSubscribeCtaScript() (livros) — timeout do fetch (#6981)", () => {
  it(`CTA hero/fim-de-lista de livros ('.cta-subscribe-form'): fetch que nunca resolve é abortado após ${SIGNUP_FORM_FETCH_TIMEOUT_MS}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const bundle = makeForm({ statusClass: ".cta-status", dataSource: "livros-hero" });
    const win: any = {
      fetch: (_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          if (options.signal) {
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }
        }),
      AbortController: typeof AbortController === "function" ? AbortController : undefined,
    };
    const doc: any = { querySelectorAll: (sel: string) => (sel === ".cta-subscribe-form" ? [bundle.form] : []) };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", scriptBody(renderSubscribeCtaScript()))(win, doc);

    bundle.submit();
    assert.equal(bundle.btn.disabled, true);

    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(aborted, true, "o AbortController deveria abortar após o timeout");
    assert.equal(bundle.status.textContent, "Erro de conexão. Tente de novo.");
    assert.equal(bundle.btn.disabled, false);
  });

  it("resposta rápida (antes do timeout) NÃO aborta o fetch — sucesso normal continua funcionando", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const bundle = makeForm({ statusClass: ".cta-status" });
    const win: any = {
      fetch: (_url: string, options: any) => {
        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
      },
      AbortController: typeof AbortController === "function" ? AbortController : undefined,
    };
    const doc: any = { querySelectorAll: (sel: string) => (sel === ".cta-subscribe-form" ? [bundle.form] : []) };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", scriptBody(renderSubscribeCtaScript()))(win, doc);

    bundle.submit();
    await flush();
    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS - 1);

    assert.equal(aborted, false, "o clearTimeout no sucesso deve ter cancelado o abort agendado");
    assert.equal(bundle.status.textContent, "Pronto! Confira seu e-mail pra confirmar a assinatura.");
  });
});


describe("buildAssinarHtml() (/assinar) — timeout do fetch (#6981)", () => {
  it(`form standalone (id='assinar-form'): fetch que nunca resolve é abortado após ${SIGNUP_FORM_FETCH_TIMEOUT_MS}ms`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const bundle = makeForm({ statusClass: ".signup-status" });
    // buildAssinarHtml usa ".status" (não ".signup-status"/".cta-status") e
    // seu setStatus() escreve status.style.display (não status.hidden) —
    // precisa do shape completo de campo (style presente).
    const statusEl: any = { style: {}, textContent: "", className: "" };
    (bundle.form.querySelector as any) = (sel: string) => {
      const selectors: Record<string, any> = {
        'input[name="email"]': bundle.email,
        'input[name="optin"]': bundle.optin,
        'input[name="website"]': bundle.website,
        'input[name="name"]': makeField(""),
        'button[type="submit"]': bundle.btn,
        ".status": statusEl,
        "#utm_source": null,
        "#utm_medium": null,
        "#utm_campaign": null,
      };
      return selectors[sel] ?? null;
    };

    const win: any = {
      fetch: (_url: string, options: any) =>
        new Promise((_resolve, reject) => {
          if (options.signal) {
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }
        }),
      AbortController: typeof AbortController === "function" ? AbortController : undefined,
      location: { search: "" },
    };
    const doc: any = { getElementById: (id: string) => (id === "assinar-form" ? bundle.form : null) };
    // eslint-disable-next-line no-new-func
    new Function("window", "document", scriptBodyFromFullHtml(buildAssinarHtml()))(win, doc);

    bundle.submit();
    assert.equal(bundle.btn.disabled, true);
    assert.equal(aborted, false, "não deve abortar antes do timeout");

    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(aborted, true, "o AbortController deveria abortar após o timeout");
    assert.equal(statusEl.textContent, "Erro de conexão. Tente de novo.");
    assert.equal(bundle.btn.disabled, false, "botão precisa reabilitar — senão o form fica morto pra sempre");
  });
});
