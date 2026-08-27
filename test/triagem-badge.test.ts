/**
 * test/triagem-badge.test.ts (#6200)
 *
 * `classifyExecTrackWithRule` (scripts/lib/issue-exec-track.ts, #6212) já
 * cobre qual `matched` cada regra emite. Este arquivo cobre o outro lado do
 * escopo da #6200 — item 3: a Triagem precisa renderizar um badge
 * VISUALMENTE distinto quando `matched === "default"` (issue nunca
 * verificada, `overnight` só por omissão) contra qualquer outro valor
 * (issue classificada por sinal positivo explícito).
 *
 * Testa `dispatchBadge` exportada de `triagem.js` diretamente — sem simular
 * DOM, já que a função é pura (recebe `track`/`matched`/vocabulário, devolve
 * uma string de HTML). O guard de carga em `triagem-module-loads.test.ts`
 * continua cobrindo "o módulo não explode"; este cobre "a célula certa tem o
 * conteúdo certo" pro caso que motivou a issue.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

/** `triagem.js` monta `el = { ...: document.getElementById(...) }` no
 * TOP-LEVEL do módulo (mesmo padrão que `triagem-module-loads.test.ts` já
 * precisa stubar) — sem `document`/`fetch` globais o `import` lança antes de
 * `dispatchBadge` sequer existir. Stub mínimo, deliberadamente mais raso que
 * o de `triagem-module-loads.test.ts` (que precisa simular renderização de
 * verdade): só o suficiente pra o módulo carregar sem lançar. */
function stubNode(): unknown {
  const target: Record<string, unknown> = {
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
    querySelector: () => stubNode(),
    querySelectorAll: () => [],
    innerHTML: "",
    textContent: "",
    className: "",
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    style: {},
  };
  return new Proxy(target, {
    get: (t, prop) => (prop in t ? t[prop as string] : stubNode()),
    set: (t, prop, value) => ((t[prop as string] = value), true),
  });
}

const originals: Record<string, unknown> = {};

// Instalado como CHAMADA DIRETA, não `before(...)` — o `import` dinâmico
// logo abaixo roda no top-level do módulo de teste, antes que qualquer hook
// registrado via node:test tenha chance de executar. Precisa estar em vigor
// já na hora do `import`.
for (const key of ["document", "window", "fetch"]) {
  originals[key] = (globalThis as Record<string, unknown>)[key];
}
(globalThis as Record<string, unknown>).document = new Proxy(
  { getElementById: () => stubNode(), createElement: () => stubNode(), body: stubNode(), addEventListener() {} },
  { get: (t, prop) => (prop in t ? (t as Record<string, unknown>)[prop as string] : stubNode()) },
);
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ generatedAt: new Date(0).toISOString(), issues: [], prs: [], execTrackUi: [], error: null, cached: false }),
});

// TS7016 — `triagem.js` é módulo `.js` puro sem `.d.ts` (mesmo padrão de
// `triagem-module-loads.test.ts`, `studio-triagem-filters.test.ts` e todo
// outro teste que importa direto de `scripts/studio-ui/public/*.js`; ver
// `test/tsc-baseline.json`/`scripts/typecheck-ratchet.ts` — a baseline é
// chaveada por arquivo+código, então um arquivo de teste NOVO precisa
// suprimir localmente em vez de herdar a entrada já aceita de outro arquivo).
// @ts-expect-error TS7016
const { dispatchBadge } = await import("../scripts/studio-ui/public/triagem.js");

after(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});

const EXEC_TRACK_UI = [
  { track: "overnight", label: "Overnight", explain: "Resolvida hoje à noite, sem intervenção." },
  { track: "develop", label: "Develop", explain: "Precisa do editor presente." },
];

describe("triagem.js dispatchBadge — #6200 badge de 'sem sinal'", () => {
  it("matched === 'default' acrescenta o sufixo visível e a classe dispatch-default", () => {
    const html = dispatchBadge("overnight", "default", EXEC_TRACK_UI);
    assert.match(html, /class="dispatch-badge dispatch-overnight dispatch-default"/);
    assert.match(html, /Overnight ·sem sinal/);
    assert.match(html, /Nenhum sinal positivo/, "o tooltip precisa explicar o motivo, não só marcar visualmente");
  });

  it("matched vindo de uma label real NÃO aciona o sufixo/classe 'sem sinal'", () => {
    const html = dispatchBadge("overnight", "label:alarm-evento", EXEC_TRACK_UI);
    assert.doesNotMatch(html, /dispatch-default/);
    assert.doesNotMatch(html, /sem sinal/);
    assert.match(html, /class="dispatch-badge dispatch-overnight"/);
    assert.match(html, />Overnight</);
  });

  it("matched ausente (chamada de legenda, sem issue real por trás) não marca 'sem sinal'", () => {
    const html = dispatchBadge("develop", undefined, EXEC_TRACK_UI);
    assert.doesNotMatch(html, /dispatch-default/);
    assert.doesNotMatch(html, /sem sinal/);
  });
});
