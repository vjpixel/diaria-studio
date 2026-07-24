/**
 * test/poll-jogar-identify-native-submit-4031.test.ts (#4031)
 *
 * Regressão do bug 260724: submeter o form de identidade do "É IA?" web
 * (`#jogar-identity-form`) com o jogador JÁ identificado voltava o jogo pro
 * par 1 em vez de re-identificar.
 *
 * Causa: `identityFormScript()` fazia early-return quando `localStorage` tinha
 * `eia_web_identified_email`, ANTES de atachar o handler de submit. O <form>
 * não tem `action`, então um submit sem handler vira navegação NATIVA (GET pro
 * mesmo path → /jogar → sequência reinicia no par 1). O fix atacha o handler
 * (com preventDefault) SEMPRE, identificado ou não.
 *
 * Sem jsdom no projeto — usamos um DOM mínimo hand-rolled sobre o EventTarget
 * nativo do Node, rodando a IIFE do script via `new Function`. A asserção-chave
 * é comportamental: dispatch de um evento "submit" cancelável → o handler
 * PRECISA ter chamado preventDefault (`defaultPrevented === true`), nos DOIS
 * estados (identificado e não). Se `defaultPrevented` for false, o browser real
 * navegaria — exatamente o bug.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identityFormScript } from "../workers/poll/src/jogar.ts";

/** Input mínimo: guarda um value e ignora o resto. */
function makeInput(value = ""): any {
  return { value, checked: false, disabled: false };
}

/** Form mínimo sobre EventTarget nativo — só o que o script toca. */
function makeForm(): any {
  const form: any = new EventTarget();
  const inputs: Record<string, any> = {
    'input[name="name"]': makeInput("Fulano"),
    'input[name="email"]': makeInput("novo@example.com"),
    'input[name="optin"]': makeInput(),
    'input[name="website"]': makeInput(""),
    ".signup-status": { hidden: true, textContent: "", className: "" },
    'button[type="submit"]': { disabled: false },
  };
  form.hidden = false;
  form.reset = () => {};
  form.querySelector = (sel: string) => inputs[sel] ?? null;
  form.querySelectorAll = () => [];
  return form;
}

/** Roda a IIFE de identityFormScript() num DOM mínimo e devolve o form. */
function runScript(opts: { identified: string | null }): { form: any; submit: () => Event } {
  const store: Record<string, string> = {};
  if (opts.identified) store["eia_web_identified_email"] = opts.identified;

  const form = makeForm();
  const note = { hidden: true, textContent: "" };
  const doc = {
    getElementById: (id: string) =>
      id === "jogar-identity-form" ? form : id === "jogar-identified-note" ? note : null,
  };
  const win: any = {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
    __jogarSessionEmail: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@web.eia.diaria.local",
    __jogarRepresentativeEdition: "260601",
    // fetch nunca deve ser chamado ANTES do preventDefault; devolve um thenable
    // inerte pra não estourar caso o handler prossiga.
    fetch: () => ({ then: () => ({ then: () => ({ catch: () => {} }) }) }),
  };

  // Extrai o corpo JS de dentro das tags <script>…</script>.
  const raw = identityFormScript();
  const body = raw.replace(/^\s*<script>/, "").replace(/<\/script>\s*$/, "");
  // A IIFE referencia `window` e `document` como globais — injeta via params.
  // eslint-disable-next-line no-new-func
  new Function("window", "document", body)(win, doc);

  const submit = () => {
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    return ev;
  };
  return { form, submit };
}

describe("identityFormScript — submit nunca navega nativamente (#4031)", () => {
  it("NÃO identificado: submit chama preventDefault", () => {
    const { submit } = runScript({ identified: null });
    const ev = submit();
    assert.equal(ev.defaultPrevented, true, "handler deve preventDefault no estado não-identificado");
  });

  it("JÁ identificado: submit AINDA chama preventDefault (regressão do reset-pro-par-1)", () => {
    const { submit } = runScript({ identified: "primeiro@example.com" });
    const ev = submit();
    assert.equal(
      ev.defaultPrevented,
      true,
      "com o jogador identificado, o handler PRECISA continuar atachado — senão o form (sem action) navega nativamente pro par 1",
    );
  });
});
