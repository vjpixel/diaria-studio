/**
 * kit-provider-split.test.ts (#6491, achado do review) — coleta de dados do
 * corte por provedor.
 *
 * `test/provider-split.test.ts` cobre o CÁLCULO (função pura). Este arquivo
 * cobre a COLETA, que é onde mora o risco real: uma paginação que trunca em
 * silêncio produz uma tabela plausível e um veredito de rampa errado, sem
 * nenhum sinal — e esse veredito é gate de uma decisão de envio de verdade.
 *
 * O review da PR #6491 achou exatamente esse buraco (P1, confiança alta): a
 * versão anterior de `drainPages` fazia `data.subscribers ?? []` e lia
 * `data.pagination?.has_next_page` como `false` quando ausente, então uma
 * resposta 2xx malformada encerrava a paginação como se tivesse terminado.
 * Cada teste de "envelope" abaixo trava um desses caminhos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  drainPages,
  resolveBroadcastId,
  formatTable,
  buildAudienceFilterBody,
  todasOuNenhuma,
  MAX_PAGES,
  type KitEngagedPage,
} from "../scripts/kit-provider-split.ts";

/** Fake de `fetchPage`: devolve as páginas na ordem, seguindo o cursor. */
function pager(paginas: KitEngagedPage[]): (after: string | undefined) => Promise<KitEngagedPage> {
  let i = 0;
  return async () => {
    const p = paginas[i];
    i += 1;
    if (!p) throw new Error("fake pager: pedida página além das configuradas");
    return p;
  };
}

function pagina(emails: string[], next?: string): KitEngagedPage {
  return {
    subscribers: emails.map((e) => ({ email_address: e })),
    pagination: { has_next_page: Boolean(next), end_cursor: next ?? null },
  };
}

describe("drainPages — caminho feliz", () => {
  it("junta as páginas seguindo o cursor até has_next_page=false", async () => {
    const r = await drainPages(pager([pagina(["a@x.com"], "c1"), pagina(["b@x.com"])]), "teste");
    assert.deepEqual(r.emails, ["a@x.com", "b@x.com"]);
    assert.equal(r.descartadas, 0);
  });

  it("aceita subscribers: [] como fim de lista legítimo (vazio ≠ ausente)", async () => {
    const r = await drainPages(pager([{ subscribers: [], pagination: { has_next_page: false } }]), "teste");
    assert.deepEqual(r.emails, []);
  });

  it("passa o end_cursor da página anterior para a próxima chamada", async () => {
    const vistos: Array<string | undefined> = [];
    const paginas = [pagina(["a@x.com"], "cursor-1"), pagina(["b@x.com"])];
    let i = 0;
    await drainPages(async (after) => {
      vistos.push(after);
      const p = paginas[i];
      i += 1;
      return p;
    }, "teste");
    assert.deepEqual(vistos, [undefined, "cursor-1"]);
  });
});

describe("drainPages — envelope inesperado é ERRO, nunca fim de lista", () => {
  it("LANÇA quando 'subscribers' está ausente (não trata como página vazia)", async () => {
    await assert.rejects(
      () => drainPages(pager([{ pagination: { has_next_page: false } }]), "aberturas"),
      /sem a chave "subscribers"/,
    );
  });

  it("LANÇA quando 'pagination' está ausente (não assume fim de lista)", async () => {
    await assert.rejects(
      () => drainPages(pager([{ subscribers: [{ email_address: "a@x.com" }] }]), "aberturas"),
      /sem a chave "pagination"/,
    );
  });

  it("LANÇA quando has_next_page=true mas end_cursor não veio (lista truncada)", async () => {
    await assert.rejects(
      () =>
        drainPages(
          pager([{ subscribers: [{ email_address: "a@x.com" }], pagination: { has_next_page: true, end_cursor: null } }]),
          "cliques",
        ),
      /has_next_page=true mas não trouxe end_cursor/,
    );
  });

  it("o erro nomeia o LABEL, pra dizer qual das quatro coletas quebrou", async () => {
    await assert.rejects(
      () => drainPages(pager([{ pagination: { has_next_page: false } }]), "cliques"),
      /cliques/,
    );
  });

  it("regressão do P1: envelope malformado NÃO devolve lista parcial silenciosa", async () => {
    // Página 1 boa, página 2 malformada. O modo de falha antigo devolvia
    // ["a@x.com"] como se fosse a lista completa.
    await assert.rejects(
      () => drainPages(pager([pagina(["a@x.com"], "c1"), { pagination: { has_next_page: false } }]), "aberturas"),
      /sem a chave "subscribers"/,
    );
  });
});

describe("drainPages — higiene e limites", () => {
  it("conta (não engole) linhas sem e-mail utilizável", async () => {
    const r = await drainPages(
      pager([
        {
          subscribers: [{ email_address: "a@x.com" }, { email_address: "" }, {}, { email_address: "   " }],
          pagination: { has_next_page: false },
        },
      ]),
      "teste",
    );
    assert.deepEqual(r.emails, ["a@x.com"]);
    assert.equal(r.descartadas, 3);
  });

  it("aborta acima de MAX_PAGES em vez de girar em falso", async () => {
    await assert.rejects(
      () => drainPages(async () => pagina(["a@x.com"], "sempre-tem-mais"), "teste"),
      new RegExp(`passou de ${MAX_PAGES} páginas`),
    );
  });
});

describe("resolveBroadcastId", () => {
  it("aceita --broadcast com inteiro positivo", () => {
    assert.equal(resolveBroadcastId(["--broadcast", "25622689"]), 25622689);
  });

  it("erro de USO quando a flag está ausente", () => {
    assert.throws(() => resolveBroadcastId([]), /uso: npx tsx/);
  });

  it("LANÇA em valor não-inteiro em vez de virar 0 silenciosamente", () => {
    assert.throws(() => resolveBroadcastId(["--broadcast", "abc"]));
  });

  it("LANÇA em zero e em negativo (id de broadcast começa em 1)", () => {
    assert.throws(() => resolveBroadcastId(["--broadcast", "0"]));
    assert.throws(() => resolveBroadcastId(["--broadcast", "-5"]));
  });
});

describe("formatTable", () => {
  it("alinha as colunas numéricas à direita e o provedor à esquerda", () => {
    const out = formatTable([
      {
        provider: "Gmail",
        sent: 433,
        delivered: 122,
        openers: 37,
        clickers: 2,
        deliveryRatePct: 28.2,
        openRatePct: 30.3,
        clickRatePct: 1.6,
      },
      {
        provider: "Total",
        sent: 594,
        delivered: 251,
        openers: 83,
        clickers: 24,
        deliveryRatePct: 42.3,
        openRatePct: 33.1,
        clickRatePct: 4,
      },
    ]);
    const linhas = out.split("\n");
    assert.equal(linhas.length, 4, "cabeçalho + régua + 2 linhas");
    assert.ok(linhas[0].startsWith("provedor"));
    assert.ok(linhas[2].startsWith("Gmail"));
    assert.ok(linhas[2].includes("28.2%"), "taxa formatada com 1 casa");
    assert.ok(linhas[3].includes("4.0%"), "inteiro também sai com 1 casa");
    const larguras = new Set(linhas.map((l) => l.length));
    assert.equal(larguras.size, 1, "todas as linhas com a mesma largura");
  });

  it("a coluna de ENTREGA aparece — é o eixo que o #6504 mostrou ser o decisivo", () => {
    const out = formatTable([
      {
        provider: "Gmail",
        sent: 433,
        delivered: 122,
        openers: 37,
        clickers: 2,
        deliveryRatePct: 28.2,
        openRatePct: 30.3,
        clickRatePct: 1.6,
      },
    ]);
    assert.match(out.split("\n")[0], /entregues/);
    assert.match(out.split("\n")[0], /entrega/);
  });
});

describe("buildAudienceFilterBody", () => {
  it("pede o TIPO que o caller nomeou — o eixo não pode sair trocado", () => {
    // O risco concreto (#6513, P1): trocar "sent" por "delivered" inverte
    // numerador e denominador da taxa de entrega e vira o gate de cabeça pra
    // baixo, com tabela plausível e nenhum teste falhando.
    for (const tipo of ["sent", "delivered", "opens", "clicks"] as const) {
      const body = buildAudienceFilterBody(25622689, tipo) as {
        all: Array<{ type: string; any: Array<{ type: string; ids: number[] }> }>;
      };
      assert.equal(body.all[0].type, tipo, `eixo ${tipo} pediu outra coisa`);
      assert.deepEqual(body.all[0].any[0], { type: "broadcasts", ids: [25622689] });
    }
  });

  it("escopa no broadcast pedido, nunca na conta inteira", () => {
    const body = buildAudienceFilterBody(42, "sent") as {
      all: Array<{ any: Array<{ ids: number[] }> }>;
    };
    assert.deepEqual(body.all[0].any[0].ids, [42]);
  });

  it("só manda 'after' quando há cursor (1ª página não leva a chave)", () => {
    assert.equal("after" in buildAudienceFilterBody(1, "sent"), false);
    assert.equal(buildAudienceFilterBody(1, "sent", "cursor-x").after, "cursor-x");
  });
});

describe("todasOuNenhuma", () => {
  it("devolve os valores na ORDEM das tarefas quando todas resolvem", async () => {
    const r = await todasOuNenhuma<[number, string]>([Promise.resolve(1), Promise.resolve("a")]);
    assert.deepEqual(r, [1, "a"]);
  });

  it("nomeia TODAS as falhas, não só a primeira a rejeitar", async () => {
    // `Promise.all` descartaria a segunda falha em silêncio — com 5 chamadas
    // concorrentes contra a mesma conta, mais de uma cai junto (#6513, P3).
    await assert.rejects(
      () =>
        todasOuNenhuma([
          Promise.reject(new Error("enviados quebrou")),
          Promise.reject(new Error("entregues quebrou")),
          Promise.resolve(3),
        ]),
      (err: Error) => {
        assert.match(err.message, /2 de 3 coleta\(s\) falharam/);
        assert.match(err.message, /enviados quebrou/);
        assert.match(err.message, /entregues quebrou/);
        return true;
      },
    );
  });

  it("indica o ÍNDICE da tarefa que falhou", async () => {
    await assert.rejects(
      () => todasOuNenhuma([Promise.resolve(1), Promise.reject(new Error("boom"))]),
      /\[1\] boom/,
    );
  });

  it("rejeição não-Error também é reportada legivelmente", async () => {
    await assert.rejects(() => todasOuNenhuma([Promise.reject("string crua")]), /string crua/);
  });
});
