/**
 * test/cursos-gate-page-conversion-7358.test.ts (#7358)
 *
 * `workers/cursos/src/gate-page.ts` (`GET /gate`) tem UM form que serve DOIS
 * propósitos — primeiro tenta `POST /gate/verify` (assinante já ativo
 * confirmando e-mail pra desbloquear) e, se não achar, vira cadastro inline
 * (`POST /gate/subscribe`). A decisão do editor na #7358 (item 2) é que só o
 * CADASTRO conta como conversão — verificar um assinante que já existe não é
 * um lead novo, e contar os dois igualaria o funil de mídia paga a um evento
 * que às vezes nem é aquisição.
 *
 * Sem jsdom no projeto — mesma técnica de
 * `test/site-home-signup-submit-6979.test.ts`/
 * `test/poll-jogar-identify-native-submit-4031.test.ts`: extrai o corpo JS
 * de dentro de `<script>…</script>` do HTML retornado por `renderGatePage()`
 * e roda via `new Function("window", "document", body)` sobre um DOM mínimo
 * hand-rolled sobre `EventTarget`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderGatePage } from "../workers/cursos/src/gate-page.ts";

function makeField(value = ""): any {
  return { value, checked: false, disabled: false, style: {}, textContent: "" };
}

interface GateFormBundle {
  form: any;
  email: any;
  name: any;
  nameLabel: any;
  optinRow: any;
  optin: any;
  msg: any;
  btn: any;
}

function makeGateForm(): GateFormBundle {
  const form: any = {};
  form.addEventListener = (_type: string, cb: (ev: any) => void) => {
    form._submitHandler = cb;
  };
  form.website = makeField("");
  const email = makeField();
  const name = makeField();
  const nameLabel = { style: {} };
  const optinRow = { style: {} };
  const optin = makeField();
  const msg = { textContent: "", className: "" };
  const btn = makeField();
  btn.disabled = false;
  return { form, email, name, nameLabel, optinRow, optin, msg, btn };
}

/**
 * Extrai e roda o corpo do `<script>` inline de `renderGatePage()`. Ao
 * contrário de `signupFormScript()` (site-home-page.ts, que chama
 * `window.fetch(...)`), o script de `gate-page.ts` chama `fetch(...)` GLOBAL
 * — por isso `fetch` também vira parâmetro injetado de `new Function`, senão
 * o mock nunca é usado (bare `fetch` resolveria pro `fetch` real do Node,
 * batendo numa URL relativa inválida e caindo sempre no `.catch()`).
 */
function wire(win: any, doc: any, fetchImpl: (url: string, options: any) => Promise<any>) {
  const html = renderGatePage();
  // #5498 acrescentou o container GTM (`renderAnalyticsHead()`) no <head> —
  // é o 1º <script> do documento. O script do form (`gate-form`) é o 2º;
  // localizar pelo conteúdo (`getElementById('gate-form')`) em vez de pela
  // ordem, pra não quebrar se um novo <script> for inserido no meio.
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
  const target = scripts.find((s) => s.includes("gate-form"));
  assert.ok(target, "renderGatePage() deveria conter um <script> com o wiring de #gate-form");
  const body = target!.replace(/^<script>/, "").replace(/<\/script>$/, "");
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "fetch", body)(win, doc, fetchImpl);
}

function setup(fetchImpl: (url: string, options: any) => Promise<any>) {
  const bundle = makeGateForm();
  const ids: Record<string, any> = {
    "gate-form": bundle.form,
    email: bundle.email,
    name: bundle.name,
    "name-label": bundle.nameLabel,
    "optin-row": bundle.optinRow,
    optin: bundle.optin,
    msg: bundle.msg,
    "submit-btn": bundle.btn,
  };
  const win: any = { location: { href: "" } };
  const doc: any = { getElementById: (id: string) => ids[id] ?? null };
  wire(win, doc, fetchImpl);
  const submit = () => bundle.form._submitHandler({ preventDefault: () => {} });
  return { ...bundle, win, submit };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("gate-page.ts — evento de conversão só no CADASTRO, nunca na VERIFICAÇÃO (#7358)", () => {
  it("modo verify, sucesso (assinante já ativo): NÃO empurra dataLayer", async () => {
    const { win, email, submit } = setup(() =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }),
    );
    email.value = "assinante@example.com";
    submit();
    await flush();
    assert.equal(win.location.href, "/", "verify bem-sucedido redireciona normalmente");
    assert.equal(win.dataLayer, undefined, "verificar um assinante já ativo não é conversão nova");
  });

  it("modo verify falha (não encontrado) e depois modo subscribe com sucesso: empurra signedUp com o e-mail", async () => {
    let call = 0;
    const { win, email, optin, submit } = setup((_url, options) => {
      call += 1;
      const body = JSON.parse(options.body);
      if (call === 1) {
        // 1ª submissão: /gate/verify não encontra assinatura ativa.
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false }) });
      }
      // 2ª submissão: /gate/subscribe, já em modo cadastro.
      assert.equal(body.optin, true);
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
    });
    email.value = "novo@example.com";
    submit();
    await flush();
    assert.equal(win.dataLayer, undefined, "1ª tentativa (verify) ainda não é conversão");

    optin.checked = true;
    submit();
    await flush();
    assert.equal(call, 2);
    assert.ok(Array.isArray(win.dataLayer));
    assert.deepEqual(win.dataLayer, [{ event: "signedUp", eventProps: { email: "novo@example.com" } }]);
  });

  it("modo subscribe sem optin marcado: NÃO chama /gate/subscribe nem empurra dataLayer", async () => {
    const calls: string[] = [];
    const { win, email, submit } = setup((_url, options) => {
      calls.push(JSON.parse(options.body).email ? "verify-or-subscribe" : "unknown");
      return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false }) });
    });
    email.value = "sem-optin@example.com";
    submit();
    await flush();
    assert.equal(calls.length, 1, "só a 1ª chamada (verify) deveria ter acontecido");

    // Sem marcar optin, a 2ª submissão nem chega a chamar fetch de novo.
    submit();
    await flush();
    assert.equal(calls.length, 1, "sem optin marcado, /gate/subscribe nunca é chamado");
    assert.equal(win.dataLayer, undefined);
  });
});
