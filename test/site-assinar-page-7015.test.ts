/**
 * test/site-assinar-page-7015.test.ts (#7015)
 *
 * Regressão do bug de wordmark em `/assinar` — 3ª ocorrência do mesmo padrão
 * (#4797 extraiu `brand-wordmark.ts`; #7010 achou a HOME reescrevendo a
 * marca à mão, só os pontos em teal, sem o `.br` inteiro; agora `/assinar`).
 * Espelha `test/site-home-page-6375.test.ts` (linhas 279-294, testes do
 * #7010) — mesma trava, mesmo mecanismo, aplicado ao gerador novo desta
 * issue (`scripts/lib/site-assinar-page.ts`).
 *
 * Guard mecânico genérico: `assertWordmarkDisplayCorrect` verifica que
 * QUALQUER trecho de HTML que contenha um `<h1>` (ou qualquer elemento) com
 * "diar" seguido de spans decorativos tem o `.br` inteiro dentro do span
 * teal — não hardcoded pro `/assinar`, reusável pra qualquer superfície
 * futura que reescreva a marca à mão (é exatamente essa reescrita que já
 * causou a 2ª e a 3ª ocorrência do bug).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { WORDMARK_DISPLAY_SEGMENTS } from "../scripts/lib/shared/brand-wordmark.ts";

/** Regex-escapa `s` — usado pra montar `RegExp` a partir de markup literal. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Markup canônico do wordmark de display, derivado por VALOR de
 * `WORDMARK_DISPLAY_SEGMENTS` — não hardcoded aqui, senão o teste trava só a
 * cópia do dia em que foi escrito e não pega drift se `brand-wordmark.ts`
 * mudar a estrutura sem os consumidores acompanharem (mesmo mecanismo do
 * #7010).
 */
const WORDMARK_HTML = WORDMARK_DISPLAY_SEGMENTS.map((seg) => {
  const cls = seg.teal ? ' class="dot"' : "";
  const hidden = seg.decorative ? ' aria-hidden="true"' : "";
  return `<span${cls}${hidden}>${seg.text}</span>`;
}).join("");

/**
 * Guard genérico (não específico a `/assinar`): num HTML de display
 * "diar.ia.br" (h1/nav/logo, não prosa corrida), o "br" precisa estar
 * DENTRO de `class="dot"` — nunca como texto solto atrás do span teal.
 * Reusável por qualquer teste de superfície futura que renderize o
 * wordmark de display.
 */
function assertWordmarkDisplayCorrect(html: string): void {
  assert.match(
    html,
    /<span class="dot">br<\/span>/,
    "'br' precisa estar DENTRO do span teal (class=\"dot\") — reescrever a marca à mão sem consumir WORDMARK_DISPLAY_SEGMENTS tende a colorir só os pontos e deixar '.br' preto",
  );
  assert.ok(
    !html.includes('<span class="dot" aria-hidden="true">br</span>'),
    "'br' não pode estar aria-hidden — um leitor de tela pularia parte do nome da marca",
  );
}

describe("buildAssinarHtml (#7015)", () => {
  const html = buildAssinarHtml();

  it("usa a MESMA estrutura canônica do wordmark que a home (#7010) — '.br' inteiro em teal, não só o ponto", () => {
    assert.match(html, new RegExp(`<h1>${reEscape(WORDMARK_HTML)}</h1>`));
    assertWordmarkDisplayCorrect(html);
  });

  it("os 2 pontos separadores continuam aria-hidden (decorativos)", () => {
    assert.equal((html.match(/<span class="dot" aria-hidden="true">\.<\/span>/g) ?? []).length, 2);
  });

  it("preserva o form de cadastro (source=apex, action pro worker poll) — gerador não deve tocar no resto do conteúdo", () => {
    assert.match(html, /action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
    assert.match(html, /<input type="hidden" name="source" value="apex">/);
  });
});

describe("regressão do bug original (#7015) — HTML anterior sem o gerador falharia este guard", () => {
  it("o markup antigo (só pontos coloridos, 'br' texto solto) É rejeitado pelo guard genérico", () => {
    const buggyH1 = `<h1>diar<span class="dot">.</span>ia<span class="dot">.</span>br</h1>`;
    assert.throws(() => assertWordmarkDisplayCorrect(buggyH1));
  });
});

/**
 * Conversão de cadastro (#7358/#7361, achado 2 do fleet review pré-merge da
 * PR #7372): `/assinar` é a superfície mais importante do fix — era a ÚNICA
 * página do apex sem o container GTM nenhum. Mesma técnica de
 * `test/subscribe-form-fetch-timeout-6981.test.ts`
 * (`scriptBodyFromFullHtml`) — extrai o `<script>` que contém o wiring de
 * `#assinar-form` de dentro do documento completo e roda via `new Function`.
 */
function makeAssinarField(value = "", checked = false): any {
  return { value, checked, disabled: false, style: {} };
}

function wireAssinarForm(fetchImpl: (url: string, options: any) => Promise<any>, emailValue: string) {
  const form: any = new EventTarget();
  const email = makeAssinarField(emailValue);
  const optin = makeAssinarField("on", true);
  const website = makeAssinarField("");
  const name = makeAssinarField("");
  const btn = makeAssinarField();
  const status: any = { style: {}, textContent: "", className: "" };
  const selectors: Record<string, any> = {
    'input[name="email"]': email,
    'input[name="optin"]': optin,
    'input[name="website"]': website,
    'input[name="name"]': name,
    'button[type="submit"]': btn,
    ".status": status,
    "#utm_source": null,
    "#utm_medium": null,
    "#utm_campaign": null,
  };
  form.querySelector = (sel: string) => selectors[sel] ?? null;
  form.querySelectorAll = (sel: string) => (sel === "input, button" ? [email, optin, website, name, btn] : []);
  form.getAttribute = (attr: string) => (attr === "action" ? "https://eia.diar.ia.br/jogar/subscribe" : null);
  form.reset = () => {};

  const win: any = {
    location: { search: "" },
    fetch: fetchImpl,
    AbortController: typeof AbortController === "function" ? AbortController : undefined,
  };
  const doc: any = { getElementById: (id: string) => (id === "assinar-form" ? form : null) };
  const html = buildAssinarHtml();
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
  const target = scripts.find((s) => s.includes("assinar-form"));
  assert.ok(target, "buildAssinarHtml() deveria conter um <script> com o wiring de #assinar-form");
  const body = target!.replace(/^<script>/, "").replace(/<\/script>$/, "");
  // eslint-disable-next-line no-new-func
  new Function("window", "document", body)(win, doc);

  const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return { win, status, btn, submit };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("buildAssinarHtml() — evento de conversão pro dataLayer (#7358/#7361)", () => {
  it("200 + ok: empurra signedUp com o e-mail cadastrado", async () => {
    const { win, submit } = wireAssinarForm(
      () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }),
      "leitor@example.com",
    );
    submit();
    await flushMicrotasks();
    assert.ok(Array.isArray(win.dataLayer));
    assert.deepEqual(win.dataLayer, [{ event: "signedUp", eventProps: { email: "leitor@example.com" } }]);
  });

  it("200 mas body.ok !== true: NÃO empurra o evento de conversão", async () => {
    const { win, submit } = wireAssinarForm(
      () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false }) }),
      "leitor@example.com",
    );
    submit();
    await flushMicrotasks();
    assert.equal(win.dataLayer, undefined);
  });

  it("dataLayer.push que lança não quebra o setStatus/reset do form (achado 1 do fleet review — try/catch em pushSignupConversionEventJs)", async () => {
    const { win, status, btn, submit } = wireAssinarForm(
      () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }),
      "leitor@example.com",
    );
    Object.defineProperty(win, "dataLayer", {
      get() {
        throw new Error("extensão de privacidade congelou dataLayer");
      },
      configurable: true,
    });
    submit();
    await flushMicrotasks();
    assert.equal(
      status.textContent,
      "Pronto! Confira seu e-mail pra confirmar a assinatura.",
      "sucesso do cadastro precisa aparecer pro usuário mesmo com dataLayer.push falhando",
    );
    assert.equal(status.className, "status ok");
    assert.equal(btn.disabled, true, "campos ficam desabilitados no sucesso (achado 4 do #6979), não reabilitados como em erro");
  });
});
