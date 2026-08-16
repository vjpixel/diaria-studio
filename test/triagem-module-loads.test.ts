/**
 * test/triagem-module-loads.test.ts (#5462)
 *
 * Guard de carga do `scripts/studio-ui/public/triagem.js`.
 *
 * **Por que existe.** Este arquivo shipou quebrado em produção: o #5462
 * removeu a constante `DISPATCH_TRACK_EXPLAIN` (o vocabulário passou a vir do
 * servidor em `data.execTrackUi`) mas deixou `renderDispatchTrackLegend()`
 * referenciando ela. Como essa função era chamada no TOP-LEVEL do módulo, o
 * `ReferenceError` matava o script inteiro antes do `fetchIssues()` — a
 * página abria com **tudo zerado**, sem nenhuma mensagem de erro visível.
 *
 * Nada pegou isso: `tsc` não checa `.js` do `public/`, não há eslint neste
 * repo, os 133 testes de unidade cobriam só o classificador e o HTML servido,
 * e o smoke end-to-end batia em `/api/issues` (que estava correto) sem nunca
 * executar o JS do cliente. O `pr-test-analyzer` do review chegou a apontar o
 * buraco — "triagem.js has no DOM harness in this project and is therefore
 * untestable as written" — e a lacuna foi aceita. Este arquivo fecha ela.
 *
 * **O que cobre e o que não.** Não é teste de comportamento de UI: é o
 * mínimo viável que separa "o módulo carrega" de "o módulo explode". Um
 * identificador removido, um import quebrado, ou qualquer throw no caminho de
 * inicialização derruba este teste. Renderização de fato (o que cada badge
 * mostra, quais linhas o filtro esconde) continua coberta pela lógica pura em
 * `triagem-filters.js` e por `issue-exec-track.ts`.
 *
 * O DOM é stubbado com um Proxy deliberadamente permissivo — o objetivo é
 * deixar o módulo RODAR pra ver se ele sobrevive, não simular um browser.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Nó de DOM que aceita qualquer acesso/atribuição sem reclamar. Devolve
 * outro nó pra qualquer propriedade desconhecida, então cadeias arbitrárias
 * (`el.foo.bar.baz`) funcionam sem precisar prever o que o módulo usa. */
function stubNode(): unknown {
  const target: Record<string | symbol, unknown> = {
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    setAttribute() {},
    querySelector: () => stubNode(),
    querySelectorAll: () => [],
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    style: {},
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return stubNode();
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
}

const originals: Record<string, unknown> = {};

/** Ids que `triagem.html` de fato declara, lidos do HTML real em vez de
 * repetidos aqui. `getElementById` devolve `null` pra qualquer id FORA desta
 * lista — como o DOM real faria.
 *
 * Sem isso o stub aceitaria qualquer id e mascararia drift HTML↔JS: renomear
 * um `id` no HTML sem atualizar o `triagem.js` faria
 * `el.refreshBtn.addEventListener(...)` (top-level) lançar `TypeError` em
 * produção — o MESMO sintoma de página zerada deste incidente, por outra via. */
function realHtmlIds(): Set<string> {
  const html = readFileSync(
    new URL("../scripts/studio-ui/public/triagem.html", import.meta.url),
    "utf8",
  );
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
}

function installDomStub(): void {
  for (const key of ["document", "window", "fetch", "location"]) {
    originals[key] = (globalThis as Record<string, unknown>)[key];
  }
  const ids = realHtmlIds();
  (globalThis as Record<string, unknown>).document = new Proxy(
    {
      getElementById: (id: string) => (ids.has(id) ? stubNode() : null),
      createElement: () => stubNode(),
      querySelector: () => stubNode(),
      querySelectorAll: () => [],
      addEventListener() {},
      body: stubNode(),
    } as Record<string | symbol, unknown>,
    {
      get(t, prop) {
        if (prop in t) return (t as Record<string | symbol, unknown>)[prop];
        return stubNode();
      },
    },
  );
  (globalThis as Record<string, unknown>).window = globalThis;
  // `fetch` resolve um payload BEM FORMADO e **populado**. Populado importa:
  // com `issues: []`/`prs: []` os `for` de `renderIssuesTable`/
  // `renderPrsTable`/`renderLabelFilters` completam com ZERO iterações, e
  // nenhum dos helpers de linha (`dispatchBadge`, `priorityBadge`,
  // `labelsBadges`, `ciBadge`, `trackBadge`, `ageLabel`) chega a ser chamado —
  // um identificador órfão dentro de um `<td>` passaria batido, que é
  // exatamente a classe que este guard promete cobrir.
  //
  // Um item de cada tabela basta pra forçar uma passada por cada corpo de
  // loop; cobrir combinações é papel dos testes de lógica pura.
  (globalThis as Record<string, unknown>).fetch = async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        generatedAt: new Date(0).toISOString(),
        issues: [
          {
            number: 1,
            title: "issue de smoke",
            url: "https://example.test/1",
            state: "OPEN",
            labels: ["bug", "P2"],
            priority: "P2",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            files: ["scripts/foo.ts"],
            execTrack: "overnight",
          },
        ],
        prs: [
          {
            number: 2,
            title: "pr de smoke",
            url: "https://example.test/2",
            state: "OPEN",
            isDraft: false,
            headRefName: "overnight/fix-1-slug",
            track: "overnight",
            labels: ["P1"],
            priority: "P1",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            ciState: "green",
            reviewDecision: "APPROVED",
          },
        ],
        execTrackUi: [{ track: "overnight", label: "Overnight", explain: "explicação de smoke" }],
        error: null,
        cached: false,
      }),
    }) as unknown as Response;
}

function restoreDomStub(): void {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
}

describe("triagem.js — guard de carga (#5462)", () => {
  /** Erros que escapam ASSINCRONAMENTE do módulo. `fetchIssues()` é disparado
   * no top-level sem `await`, então um throw dentro dele (o caso real do
   * incidente — a legenda rodava por ali) não rejeita o `import`: vira
   * unhandledRejection depois. Sem capturar, o teste passaria verde e a
   * falha apareceria desancorada, atribuída a outro teste da suíte. */
  const asyncErrors: unknown[] = [];
  const capture = (e: unknown) => asyncErrors.push(e);

  before(() => {
    installDomStub();
    process.on("unhandledRejection", capture);
    process.on("uncaughtException", capture);
  });

  after(() => {
    process.off("unhandledRejection", capture);
    process.off("uncaughtException", capture);
    restoreDomStub();
  });

  it("carrega e inicializa sem lançar — nenhum identificador órfão no caminho de init", async () => {
    // Regressão direta do incidente: `renderDispatchTrackLegend` referenciava
    // `DISPATCH_TRACK_EXPLAIN` já removida, e rodava na inicialização.
    await assert.doesNotReject(
      () => import("../scripts/studio-ui/public/triagem.js"),
      "triagem.js deve carregar com DOM stubbado; um throw aqui é a página abrindo zerada",
    );

    // Deixa o `fetchIssues()` disparado no load completar dentro da fronteira
    // deste teste, pra que o erro dele seja atribuído AQUI.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      asyncErrors.map((e) => (e instanceof Error ? e.message : String(e))),
      [],
      "inicialização de triagem.js lançou de forma assíncrona — página abriria zerada",
    );
  });
});
