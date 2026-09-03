/**
 * test/site-home-signup-utm-prefill-7360.test.ts (#7360)
 *
 * O elo que carrega `utm_source`/`utm_medium`/`utm_campaign` da query string
 * pros hidden inputs do form de assinatura da home —
 * `scripts/lib/site-home-page.ts:541`, `wireSignupForm` via
 * `new URLSearchParams(window.location.search)` — nunca foi exercitado.
 * `test/site-home-signup-submit-6979.test.ts` roda o mesmo script mas SEMPRE
 * com `location.search` vazio (linha 95 daquele arquivo): cobre o pipeline de
 * submit, nunca o prefill em si.
 *
 * Se esse elo quebrar (regex errada, key trocada, `URLSearchParams`
 * indisponível), o cadastro cai no default `diaria-apex` do lado do Worker em
 * silêncio — mesma classe de inversão silenciosa do #6980. Este teste garante
 * que os 3 hidden inputs saem preenchidos com os valores REAIS da query
 * string antes do primeiro submit, e que a ausência de query string não
 * regride o comportamento (inputs continuam vazios, sem lançar).
 *
 * Mesma técnica de extração/execução de `test/site-home-signup-submit-6979.test.ts`:
 * extrai o corpo JS de dentro de `<script>…</script>` de `signupFormScript()`
 * e roda via `new Function("window", "document", body)` sobre um DOM mínimo
 * hand-rolled sobre `EventTarget`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signupFormScript } from "../scripts/lib/site-home-page.ts";

/** Campo mínimo — só o que o script toca (value/checked/disabled/style). */
function makeField(value = ""): any {
  return { value, checked: false, disabled: false, style: {} };
}

/** `.signup-status` mínimo. */
function makeStatus(): any {
  return { style: {}, textContent: "", className: "" };
}

interface FormBundle {
  form: any;
  email: any;
  optin: any;
  website: any;
  btn: any;
  status: any;
  utmSource: any;
  utmMedium: any;
  utmCampaign: any;
}

/** Form mínimo sobre EventTarget nativo, com os seletores que `wireSignupForm` usa. */
function makeForm(): FormBundle {
  const form: any = new EventTarget();
  const email = makeField("novo@example.com");
  const optin = makeField();
  optin.checked = true;
  const website = makeField("");
  // Hidden inputs nascem vazios — mesmo markup de `renderSubscribeForm`
  // (`site-home-page.ts:420-422`, `value=""`).
  const utmSource = makeField("");
  const utmMedium = makeField("");
  const utmCampaign = makeField("");
  const btn = makeField();
  btn.disabled = false;
  const status = makeStatus();

  const selectors: Record<string, any> = {
    'input[name="email"]': email,
    'input[name="optin"]': optin,
    'input[name="website"]': website,
    'input[name="utm_source"]': utmSource,
    'input[name="utm_medium"]': utmMedium,
    'input[name="utm_campaign"]': utmCampaign,
    'button[type="submit"]': btn,
    ".signup-status": status,
  };
  form.querySelector = (sel: string) => selectors[sel] ?? null;
  form.querySelectorAll = (sel: string) =>
    sel === "input, button" ? [email, optin, website, utmSource, utmMedium, utmCampaign, btn] : [];
  form.getAttribute = (attr: string) => (attr === "action" ? "https://eia.diar.ia.br/jogar/subscribe" : null);
  form.reset = () => {};

  return { form, email, optin, website, btn, status, utmSource, utmMedium, utmCampaign };
}

/** Roda o corpo JS de `signupFormScript()` num `window`/`document` mínimos com `search` dado. */
function wireWithSearch(search: string) {
  const bundle = makeForm();
  const win: any = {
    location: { search },
    fetch: () => new Promise(() => {}), // nunca chamado nestes testes — só o prefill é exercitado
    AbortController: typeof AbortController === "function" ? AbortController : undefined,
  };
  const doc: any = { querySelectorAll: (sel: string) => (sel === "form.signup" ? [bundle.form] : []) };
  const raw = signupFormScript();
  const body = raw.replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
  // eslint-disable-next-line no-new-func
  new Function("window", "document", body)(win, doc);
  return bundle;
}

describe("signupFormScript — prefill de UTM a partir de location.search (#7360)", () => {
  it("location.search com utm_source/utm_medium/utm_campaign: hidden inputs recebem os valores reais", () => {
    const { utmSource, utmMedium, utmCampaign } = wireWithSearch(
      "?utm_source=google&utm_medium=cpc&utm_campaign=diaria-lancamento-260901",
    );
    assert.equal(utmSource.value, "google");
    assert.equal(utmMedium.value, "cpc");
    assert.equal(utmCampaign.value, "diaria-lancamento-260901");
  });

  it("query string com apenas utm_source: só o input correspondente é preenchido, os outros ficam vazios", () => {
    const { utmSource, utmMedium, utmCampaign } = wireWithSearch("?utm_source=facebook");
    assert.equal(utmSource.value, "facebook");
    assert.equal(utmMedium.value, "");
    assert.equal(utmCampaign.value, "");
  });

  it("query string com outros parâmetros misturados (gclid, fbclid): ignora o que não é utm_*", () => {
    const { utmSource, utmMedium, utmCampaign } = wireWithSearch(
      "?gclid=abc123&utm_source=microsoft-ads&fbclid=xyz&utm_medium=cpc",
    );
    assert.equal(utmSource.value, "microsoft-ads");
    assert.equal(utmMedium.value, "cpc");
    assert.equal(utmCampaign.value, "");
  });

  it("location.search vazio (regressão — comportamento pré-#7360): hidden inputs continuam vazios, sem lançar", () => {
    const { utmSource, utmMedium, utmCampaign } = wireWithSearch("");
    assert.equal(utmSource.value, "");
    assert.equal(utmMedium.value, "");
    assert.equal(utmCampaign.value, "");
  });

  it("valores prefilled entram no payload do POST no submit subsequente", async () => {
    const bundle = makeForm();
    const calls: any[] = [];
    const win: any = {
      location: { search: "?utm_source=google&utm_medium=cpc&utm_campaign=camp1" },
      fetch: (url: string, options: any) => {
        calls.push(JSON.parse(options.body));
        return new Promise(() => {});
      },
      AbortController: typeof AbortController === "function" ? AbortController : undefined,
    };
    const doc: any = { querySelectorAll: (sel: string) => (sel === "form.signup" ? [bundle.form] : []) };
    const raw = signupFormScript();
    const body = raw.replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
    // eslint-disable-next-line no-new-func
    new Function("window", "document", body)(win, doc);

    const ev = new Event("submit", { bubbles: true, cancelable: true });
    bundle.form.dispatchEvent(ev);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].utm_source, "google");
    assert.equal(calls[0].utm_medium, "cpc");
    assert.equal(calls[0].utm_campaign, "camp1");
  });
});
