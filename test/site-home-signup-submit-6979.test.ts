/**
 * test/site-home-signup-submit-6979.test.ts (#6979 — review da PR #6976)
 *
 * `test/site-home-signup-6976.test.ts` só faz asserção de MARKUP (regex
 * sobre o HTML gerado). Nada ali exercitava o COMPORTAMENTO do submit — a
 * ramificação por status (200/429/503/outros), o `.catch()` de rede, o
 * honeypot, o guard de duplo submit e as transições de `disabled`. É
 * justamente essa lógica que regride em silêncio (achado 2 do review).
 *
 * Sem jsdom no projeto — mesma técnica de
 * `test/poll-jogar-identify-native-submit-4031.test.ts` (que testa
 * `identityFormScript()` de `workers/poll/src/jogar.ts`): extrai o corpo JS
 * de dentro de `<script>…</script>` de `signupFormScript()` e roda via
 * `new Function("window", "document", body)` sobre um DOM mínimo hand-rolled
 * sobre `EventTarget`.
 *
 * Cobre também o Achado 1 (timeout): sem `AbortController`+`setTimeout`, uma
 * promise de fetch que nunca resolve deixava "Enviando…" pendurado pra
 * sempre. `SIGNUP_FORM_FETCH_TIMEOUT_MS` é exportado de propósito pra este
 * teste não hardcodar o valor (mesmo padrão de `OBSERVED_PROBE_LATENCY_MS`
 * em `test/clarice-healthcheck.test.ts`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signupFormScript, SIGNUP_FORM_FETCH_TIMEOUT_MS } from "../scripts/lib/site-home-page.ts";

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
}

/** Form mínimo sobre EventTarget nativo, com os seletores que `wireSignupForm` usa. */
function makeForm(opts: { email?: string; optinChecked?: boolean; website?: string } = {}): FormBundle {
  const form: any = new EventTarget();
  const email = makeField(opts.email ?? "novo@example.com");
  const optin = makeField();
  optin.checked = opts.optinChecked ?? true;
  const website = makeField(opts.website ?? "");
  const utmSource = makeField();
  const utmMedium = makeField();
  const utmCampaign = makeField();
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
  // Só "input, button" é usado (achado 4 — esconder/desabilitar tudo no sucesso).
  form.querySelectorAll = (sel: string) =>
    sel === "input, button" ? [email, optin, website, utmSource, utmMedium, utmCampaign, btn] : [];
  form.getAttribute = (attr: string) => (attr === "action" ? "https://eia.diar.ia.br/jogar/subscribe" : null);
  form.reset = () => {};

  return { form, email, optin, website, btn, status };
}

/** Roda o corpo JS de `signupFormScript()` num `window`/`document` mínimos. */
function wire(win: any, doc: any) {
  const raw = signupFormScript();
  const body = raw.replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
  // eslint-disable-next-line no-new-func
  new Function("window", "document", body)(win, doc);
}

function setup(
  fetchImpl: (url: string, options: any) => Promise<any>,
  formOpts: { email?: string; optinChecked?: boolean; website?: string } = {},
) {
  const bundle = makeForm(formOpts);
  const win: any = {
    location: { search: "" },
    fetch: fetchImpl,
    AbortController: typeof AbortController === "function" ? AbortController : undefined,
  };
  const doc: any = { querySelectorAll: (sel: string) => (sel === "form.signup" ? [bundle.form] : []) };
  wire(win, doc);
  const submit = () => {
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    bundle.form.dispatchEvent(ev);
    return ev;
  };
  return { ...bundle, submit };
}

/** Mesmo idioma de `test/studio-chat.test.ts` — flush de microtasks encadeadas. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("signupFormScript — transições de status/disabled por status HTTP (#6979)", () => {
  it("200 ok: sucesso, reseta e ESCONDE+desabilita TODOS os campos (achado 4 — alinhado com /assinar)", async () => {
    const calls: any[] = [];
    const { submit, status, btn, email, optin, website } = setup((url, options) => {
      calls.push({ url, options });
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    });

    submit();
    assert.equal(btn.disabled, true, "botão desabilita assim que o submit começa");
    assert.equal(status.textContent, "Enviando…");
    assert.equal(status.className, "signup-status ok");

    await flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://eia.diar.ia.br/jogar/subscribe");
    assert.equal(status.textContent, "Pronto! Confira seu e-mail pra confirmar a assinatura.");
    assert.equal(status.className, "signup-status ok");
    // Achado 4: não é só o botão — email/optin/website também escondidos+desabilitados.
    for (const field of [btn, email, optin, website]) {
      assert.equal(field.disabled, true);
      assert.equal(field.style.display, "none");
    }
  });

  it("429: rate limit — mensagem específica, botão reabilita, campos continuam visíveis", async () => {
    const { submit, status, btn, email } = setup(() =>
      Promise.resolve({ status: 429, json: () => Promise.resolve({ ok: false }) }),
    );
    submit();
    await flush();
    assert.equal(status.textContent, "Muitas tentativas. Tente de novo mais tarde.");
    assert.equal(status.className, "signup-status err");
    assert.equal(btn.disabled, false);
    assert.equal(email.style.display, undefined, "429 não deve esconder o form — só sucesso esconde");
  });

  it("503: cadastro indisponível — mensagem específica, botão reabilita", async () => {
    const { submit, status, btn } = setup(() =>
      Promise.resolve({ status: 503, json: () => Promise.resolve({ ok: false }) }),
    );
    submit();
    await flush();
    assert.equal(status.textContent, "Cadastro indisponível agora. Tente de novo em instantes.");
    assert.equal(status.className, "signup-status err");
    assert.equal(btn.disabled, false);
  });

  it("outro status (400/500/...): mensagem genérica, botão reabilita", async () => {
    const { submit, status, btn } = setup(() =>
      Promise.resolve({ status: 400, json: () => Promise.resolve({ ok: false, error: "invalid_email" }) }),
    );
    submit();
    await flush();
    assert.equal(status.textContent, "Não deu pra assinar agora. Confira o e-mail e tente de novo.");
    assert.equal(status.className, "signup-status err");
    assert.equal(btn.disabled, false);
  });

  it("200 mas body.ok !== true (JSON inesperado): trata como falha, não como sucesso", async () => {
    const { submit, status, btn } = setup(() =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false }) }),
    );
    submit();
    await flush();
    assert.equal(status.textContent, "Não deu pra assinar agora. Confira o e-mail e tente de novo.");
    assert.equal(btn.disabled, false);
  });
});

describe("signupFormScript — .catch() de rede (#6979)", () => {
  it("fetch rejeitado (rede fora do ar): mensagem de erro de conexão, botão reabilita", async () => {
    const { submit, status, btn } = setup(() => Promise.reject(new Error("ECONNREFUSED")));
    submit();
    await flush();
    assert.equal(status.textContent, "Erro de conexão. Tente de novo.");
    assert.equal(status.className, "signup-status err");
    assert.equal(btn.disabled, false);
  });

  it("res.json() rejeita (corpo não-JSON): mesmo pipeline de status trata como body null", async () => {
    const { submit, status, btn } = setup(() =>
      Promise.resolve({ status: 200, json: () => Promise.reject(new Error("Unexpected token")) }),
    );
    submit();
    await flush();
    // body vira null → r.body.ok é lançado? Não — `r.status===200 && r.body && r.body.ok`
    // curto-circuita em r.body (null é falsy), cai no "outro status" (mensagem genérica).
    assert.equal(status.textContent, "Não deu pra assinar agora. Confira o e-mail e tente de novo.");
    assert.equal(btn.disabled, false);
  });
});

describe("signupFormScript — guards client-side (nunca chamam fetch) (#6979)", () => {
  it("sem opt-in marcado: NÃO chama fetch, mostra aviso de consentimento, botão nunca desabilita", () => {
    const calls: any[] = [];
    const { submit, status, btn } = setup(
      (url, options) => {
        calls.push({ url, options });
        return new Promise(() => {});
      },
      { optinChecked: false },
    );
    submit();
    assert.equal(calls.length, 0, "guard deve bloquear ANTES do fetch");
    assert.equal(status.textContent, "Marque a caixinha de consentimento pra assinar.");
    assert.equal(btn.disabled, false);
  });

  it("e-mail vazio/sem @: NÃO chama fetch, mostra aviso de formato", () => {
    const calls: any[] = [];
    const { submit, status, btn } = setup(
      (url, options) => {
        calls.push({ url, options });
        return new Promise(() => {});
      },
      { email: "nao-e-email" },
    );
    submit();
    assert.equal(calls.length, 0);
    assert.equal(status.textContent, "Digite um e-mail válido.");
    assert.equal(btn.disabled, false);
  });
});

describe("signupFormScript — honeypot passa no payload, servidor decide o fake-success (#6979)", () => {
  it("o valor do campo 'website' (invisível ao humano) é enviado tal como está — sem filtro client-side", () => {
    const calls: any[] = [];
    const { submit } = setup(
      (url, options) => {
        calls.push(JSON.parse(options.body));
        return new Promise(() => {});
      },
      { website: "http://bot.example" },
    );
    submit();
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].website,
      "http://bot.example",
      "o cliente não julga o honeypot — quem decide fake-success 200 é validateSubscribeInput em workers/poll/src/subscribe.ts",
    );
  });
});

describe("signupFormScript — timeout do fetch (achado 1, #6979)", () => {
  it(`fetch que nunca resolve é abortado após SIGNUP_FORM_FETCH_TIMEOUT_MS (${SIGNUP_FORM_FETCH_TIMEOUT_MS}ms) e cai no MESMO .catch() de erro de rede`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const { submit, status, btn } = setup((url, options) => {
      return new Promise((_resolve, reject) => {
        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }
      });
    });

    submit();
    assert.equal(btn.disabled, true);
    assert.equal(status.textContent, "Enviando…");
    assert.equal(aborted, false, "não deve abortar antes do timeout");

    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS);
    // flush da cadeia abort → reject → .catch()
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(aborted, true, "o AbortController deveria abortar após o timeout");
    assert.equal(
      status.textContent,
      "Erro de conexão. Tente de novo.",
      "mesmo tratamento do .catch() de rede — nunca deixa \"Enviando…\" pendurado pra sempre (era o bug do achado 1)",
    );
    assert.equal(status.className, "signup-status err");
    assert.equal(btn.disabled, false, "botão precisa reabilitar depois do timeout — senão o form fica morto pra sempre");
  });

  it("resposta rápida (antes do timeout) NÃO aborta o fetch", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let aborted = false;
    const { submit, status } = setup((url, options) => {
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          aborted = true;
        });
      }
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    });

    submit();
    // fetch resolve ANTES do timeout disparar — flush real (setImmediate,
    // não mockado) drena a cadeia .then() encadeada por completo.
    await flush();
    t.mock.timers.tick(SIGNUP_FORM_FETCH_TIMEOUT_MS - 1);

    assert.equal(aborted, false, "o clearTimeout no .then() de sucesso deve ter cancelado o abort agendado");
    assert.equal(status.textContent, "Pronto! Confira seu e-mail pra confirmar a assinatura.");
  });
});
