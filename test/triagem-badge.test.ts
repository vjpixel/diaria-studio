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
const { dispatchBadge, claimBadge, reasonCell } = await import("../scripts/studio-ui/public/triagem.js");

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

/** Espelha a forma de `data.execTrackReasonUi` sem importar o lib real: o
 * ponto do teste é que `reasonCell` LÊ a tabela servida em vez de redeclarar
 * as frases. Importar o Record de verdade tornaria o teste incapaz de
 * distinguir as duas coisas. A cobertura de "todo `matched` emitido tem
 * frase" fica em `test/issue-exec-track.test.ts`, do lado do lib. */
const REASON_UI = {
  reasons: {
    "label:kit-migration": { short: "migração Kit em curso", long: "Bloqueada pela migração de canal para o Kit." },
    "marker:aguardando-ate": { short: "data marcada", long: "Volta sozinha ao fluxo na data." },
    "label:windows": { short: "exige máquina Windows", long: "Precisa do Chrome logado / ComfyUI." },
    default: { short: "sem sinal — ninguém triou", long: "Nasce Overnight por construção." },
  },
  actionable: {
    overnight: true,
    develop: true,
    agendada: false,
    bloqueada: false,
    epica: false,
    "fora-de-rodada": false,
  },
};

describe("triagem.js reasonCell — #7644 coluna 'Motivo'", () => {
  it("track não-acionável mostra a frase DA REGRA, não a do track inteiro", () => {
    const html = reasonCell("bloqueada", "label:kit-migration", REASON_UI);
    assert.match(html, /migração Kit em curso/);
    assert.match(html, /class="reason-text"/);
  });

  it("o texto longo vai pro tooltip, não pra célula", () => {
    const html = reasonCell("agendada", "marker:aguardando-ate", REASON_UI);
    assert.match(html, /title="Volta sozinha ao fluxo na data\."/);
    assert.match(html, />data marcada</);
  });

  it("track ACIONÁVEL renderiza '—' mesmo tendo frase disponível pro seu matched", () => {
    // `label:windows` TEM entrada em `reasons` — o que suprime a célula é a
    // acionabilidade do track, não a falta de texto. É a distinção que faz a
    // coluna responder "por que isto não anda" em vez de "por que este track".
    const html = reasonCell("develop", "label:windows", REASON_UI);
    assert.match(html, /class="reason-none"/);
    assert.doesNotMatch(html, /Windows/);
  });

  it("overnight sem sinal não polui a coluna — o badge já sinaliza isso", () => {
    const html = reasonCell("overnight", "default", REASON_UI);
    assert.match(html, /class="reason-none"/);
    assert.doesNotMatch(html, /ninguém triou/);
  });

  it("vocabulário ausente (1º render antes do fetch) degrada pra '—', nunca lança", () => {
    assert.match(reasonCell("bloqueada", "label:kit-migration", undefined), /reason-none/);
  });

  it("matched sem frase na tabela servida degrada pra '—' em vez de imprimir o identificador cru", () => {
    const html = reasonCell("bloqueada", "label:regra-que-o-cliente-nao-conhece", REASON_UI);
    assert.match(html, /class="reason-none"/);
    assert.doesNotMatch(html, /regra-que-o-cliente-nao-conhece/);
  });

  it("track desconhecido pelo mapa de acionabilidade MOSTRA o motivo (leitura conservadora)", () => {
    // Servidor à frente do cliente: valor novo em `ExecTrack` que esta tabela
    // ainda não conhece. Some da coluna só o que sabemos que anda sozinho —
    // assumir acionável por omissão esconderia um bloqueio real.
    const html = reasonCell("track-novo", "label:kit-migration", REASON_UI);
    assert.match(html, /migração Kit em curso/);
  });

  it("escapa o conteúdo servido — a tabela vem do payload, não é confiável por construção", () => {
    const hostile = {
      reasons: { "label:x": { short: "<img src=x onerror=alert(1)>", long: '"><script>alert(1)</script>' } },
      actionable: { bloqueada: false },
    };
    const html = reasonCell("bloqueada", "label:x", hostile);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script/);
  });
});

describe("triagem.js claimBadge — #6436 visibilidade de claim ativo", () => {
  it("claim null/ausente → string vazia, nenhum badge extra", () => {
    assert.equal(claimBadge(null), "");
    assert.equal(claimBadge(undefined), "");
  });

  it("claim da sessão continuo (cron 60min, nunca stale por si só) → 'em andamento — continuo-helios'", () => {
    const html = claimBadge({ kind: "continuo", machineTag: "helios", sessionId: "5d791ef6", claimedAt: "2026-08-20T00:00:00Z" });
    // 28/08 (pedido do editor): kind vira classe própria — continuo ganha cor
    // destacada em vez de sumir no badge neutro. A classe base permanece.
    assert.match(html, /class="claim-badge claim-kind-continuo"/);
    assert.match(html, />em andamento — continuo-helios</);
    assert.match(html, /2026-08-20T00:00:00Z/, "tooltip carrega a data da 1ª reivindicação");
  });

  it("kind com caractere fora de [a-z-] NÃO vira classe (nunca injeta HTML/CSS via kind)", () => {
    const html = claimBadge({ kind: 'x"onmouseover', machineTag: "m", sessionId: "s", claimedAt: null });
    assert.match(html, /class="claim-badge"/);
    assert.ok(!html.includes("claim-kind-"), "kind malformado cai na classe base");
  });

  it("claim sem claimedAt conhecido (sessão pré-#6436) ainda renderiza, sem citar data", () => {
    const html = claimBadge({ kind: "overnight", machineTag: "neo", sessionId: "x", claimedAt: null });
    assert.match(html, />em andamento — overnight-neo</);
    assert.doesNotMatch(html, /desde/);
  });

  it("#7263: claim.stale === true → badge distinto ('sessão possivelmente ociosa'), nunca 'em andamento'", () => {
    const html = claimBadge({
      kind: "develop",
      machineTag: "helios",
      sessionId: "sess-ociosa",
      claimedAt: "2026-09-01T00:00:00Z",
      stale: true,
    });
    assert.match(html, /class="claim-badge claim-stale claim-kind-develop"/);
    assert.match(html, />reivindicada — sessão possivelmente ociosa \(develop-helios\)</);
    assert.doesNotMatch(html, />em andamento/);
    assert.match(html, /OCIOSA/, "tooltip explica o motivo do badge diferente");
  });

  it("claim.stale === false (padrão) segue idêntico ao badge 'em andamento' de sempre", () => {
    const html = claimBadge({ kind: "overnight", machineTag: "neo", sessionId: "x", claimedAt: null, stale: false });
    assert.match(html, />em andamento — overnight-neo</);
    assert.ok(!html.includes("claim-stale"));
  });
});
