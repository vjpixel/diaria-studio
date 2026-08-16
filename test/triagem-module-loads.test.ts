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
import { LOADING_COUNT, LOADING_MESSAGE } from "../scripts/studio-ui/public/triagem-filters.js";

/** Nó de DOM que aceita qualquer acesso/atribuição sem reclamar. Devolve
 * outro nó pra qualquer propriedade desconhecida, então cadeias arbitrárias
 * (`el.foo.bar.baz`) funcionam sem precisar prever o que o módulo usa. */
/** Nós criados por id, pra que o teste possa INSPECIONAR o que o módulo
 * escreveu (contador, mensagem de estado vazio) em vez de só verificar que
 * nada lançou. */
const nodesById = new Map<string, Record<string, unknown>>();

function stubNode(): unknown {
  const listeners = new Map<string, Array<() => void>>();
  const target: Record<string | symbol, unknown> = {
    // Guarda os handlers pra que o teste possa DISPARAR eventos (ex: clique
    // em "Atualizar") — sem isso não dá pra reproduzir dois fetches em voo.
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    /** Só-para-teste: dispara os handlers registrados para `type`. */
    __fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
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
      getElementById: (id: string) => {
        if (!ids.has(id)) return null;
        let node = nodesById.get(id);
        if (!node) {
          node = stubNode() as Record<string, unknown>;
          nodesById.set(id, node);
        }
        return node;
      },
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
  (globalThis as Record<string, unknown>).fetch = async () => {
    if (gateFetch) await gateFetch;
    return {
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
    } as unknown as Response;
  };
}

/** Quando setado, o `fetch` stubbado só resolve depois desta promise — deixa o
 * teste observar a tela DURANTE o carregamento. */
let gateFetch: Promise<void> | null = null;

function restoreDomStub(): void {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
}

describe("triagem.js — guard de carga (#5462) + estado de carregamento (#5472)", () => {
  /** Erros que escapam ASSINCRONAMENTE do módulo. `fetchIssues()` é disparado
   * no top-level sem `await`, então um throw dentro dele (o caso real do
   * incidente — a legenda rodava por ali) não rejeita o `import`: vira
   * unhandledRejection depois. Sem capturar, o teste passaria verde e a
   * falha apareceria desancorada, atribuída a outro teste da suíte. */
  const asyncErrors: unknown[] = [];
  const capture = (e: unknown) => asyncErrors.push(e);
  let liberarFetch!: () => void;

  before(() => {
    // Segura o fetch ANTES do módulo ser importado — é a única janela em que
    // dá pra observar o 1º carregamento, já que o ESM cacheia o módulo e o
    // `fetchIssues()` de abertura roda uma vez só. Evita ter que exportar
    // qualquer API só-para-teste do código de produção.
    gateFetch = new Promise<void>((resolve) => {
      liberarFetch = resolve;
    });
    installDomStub();
    process.on("unhandledRejection", capture);
    process.on("uncaughtException", capture);
  });

  after(() => {
    process.off("unhandledRejection", capture);
    process.off("uncaughtException", capture);
    restoreDomStub();
    gateFetch = null;
  });

  it("carrega, mostra 'carregando…' durante o fetch, e resolve pro dado real", async () => {
    // (1) Regressão do #5468: `renderDispatchTrackLegend` referenciava
    // `DISPATCH_TRACK_EXPLAIN` já removida e rodava na inicialização.
    await assert.doesNotReject(
      () => import("../scripts/studio-ui/public/triagem.js"),
      "triagem.js deve carregar com DOM stubbado; um throw aqui é a página abrindo zerada",
    );

    // (2) #5472 — com o fetch ainda em voo, a tela precisa dizer "estou
    // buscando", não "não há nada". Testar só `emptyStateMessage` (puro) não
    // cobriria isto: o modo de falha aqui é o módulo nunca RENDERIZAR antes
    // do await, e aí a mensagem existe na função e nunca chega à tela.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(nodesById.get("issues-count")?.textContent, LOADING_COUNT, "contador de issues deveria mostrar o placeholder");
    assert.equal(nodesById.get("prs-count")?.textContent, LOADING_COUNT, "contador de PRs deveria mostrar o placeholder");
    assert.equal(nodesById.get("issues-empty")?.textContent, LOADING_MESSAGE);
    assert.equal(nodesById.get("issues-empty")?.hidden, false, "a mensagem precisa estar VISÍVEL, não só preenchida");

    // (3) Liberado: números reais do payload (1 issue, 1 PR), sem "carregando".
    liberarFetch();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(nodesById.get("issues-count")?.textContent, "1");
    assert.equal(nodesById.get("prs-count")?.textContent, "1");
    // Com resultados, o contêiner de estado-vazio é ESCONDIDO, não reescrito —
    // `updateEmptyState` só toca `textContent` quando há mensagem a mostrar.
    // O "carregando…" fica no DOM, invisível; é `hidden` que importa aqui.
    assert.equal(nodesById.get("issues-empty")?.hidden, true, "com 1 issue renderizada, o estado-vazio deve sumir");
    assert.equal(nodesById.get("prs-empty")?.hidden, true);

    assert.deepEqual(
      asyncErrors.map((e) => (e instanceof Error ? e.message : String(e))),
      [],
      "inicialização de triagem.js lançou de forma assíncrona — página abriria zerada",
    );
  });

  // Achado do review do PR #5478 (P2): sem guard de sequência, a resposta
  // ANTIGA que chega por último sobrescreve a nova — a tela passa a mostrar
  // dado velho como se fosse fresco, sem sinal nenhum. Reproduzido aqui
  // fazendo o 1º fetch resolver DEPOIS do 2º, que é o caso que a ordem
  // natural de chegada esconde.
  it("resposta obsoleta que chega atrasada não sobrescreve a mais recente", async () => {
    const respostas: Array<{ liberar: () => void; issues: unknown[] }> = [];
    (globalThis as Record<string, unknown>).fetch = async () => {
      const entrada = { liberar: () => {}, issues: [] as unknown[] };
      const espera = new Promise<void>((resolve) => {
        entrada.liberar = resolve;
      });
      respostas.push(entrada);
      await espera;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          generatedAt: new Date(0).toISOString(),
          issues: entrada.issues,
          prs: [],
          execTrackUi: [],
          error: null,
          cached: false,
        }),
      } as unknown as Response;
    };

    const mod = await import("../scripts/studio-ui/public/triagem.js");
    void mod;
    // Dois fetches em voo, disparados pelo mesmo caminho do botão "Atualizar".
    const clicar = () => (nodesById.get("refresh-btn")?.__fire as ((t: string) => void))("click");
    clicar();
    clicar();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(respostas.length, 2, "os dois fetches precisam estar em voo pra reproduzir a corrida");

    // O 2º (mais novo) traz 2 issues e responde PRIMEIRO.
    respostas[1].issues = [{ number: 9, title: "novo", url: "u", state: "OPEN", labels: [], priority: null, files: [], execTrack: "overnight" }, { number: 10, title: "novo2", url: "u", state: "OPEN", labels: [], priority: null, files: [], execTrack: "overnight" }];
    respostas[1].liberar();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(nodesById.get("issues-count")?.textContent, "2", "a resposta nova deveria ter sido renderizada");

    // Só então o 1º (obsoleto) responde, com 0 issues. Não pode reverter a tela.
    respostas[0].liberar();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      nodesById.get("issues-count")?.textContent,
      "2",
      "resposta obsoleta sobrescreveu a mais recente — dado velho exibido como fresco",
    );
  });
});
