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
  resolveEditionArg,
  kitDiariaPublishedPath,
  readEditionKitBroadcastId,
  kitDeliverySplitPath,
  buildKitDeliveryRecord,
  persistKitDeliverySplit,
  appendKitDeliveryHistory,
  DEFAULT_KIT_DELIVERY_HISTORY_PATH,
  formatTable,
  buildAudienceFilterBody,
  buildUrlClickFilterBody,
  todasOuNenhuma,
  MAX_PAGES,
  type KitEngagedPage,
} from "../scripts/kit-provider-split.ts";
import { computeProviderSplit } from "../scripts/lib/provider-split.ts";
import type { KitBroadcastStats } from "../scripts/lib/kit-client.ts";
import { resolve as resolvePath } from "node:path";

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

describe("buildUrlClickFilterBody (#7206)", () => {
  it("sempre pede type: 'clicks' — escopar por URL nunca troca o eixo", () => {
    const body = buildUrlClickFilterBody(25622689, "https://diar.ia.br/x") as {
      all: Array<{ type: string; any: Array<{ type: string; ids: number[] }>; urls: string[] }>;
    };
    assert.equal(body.all[0].type, "clicks");
    assert.deepEqual(body.all[0].any[0], { type: "broadcasts", ids: [25622689] });
    assert.deepEqual(body.all[0].urls, ["https://diar.ia.br/x"]);
  });

  it("escopa a URL pedida, não outra", () => {
    const body = buildUrlClickFilterBody(1, "https://diar.ia.br/a") as { all: Array<{ urls: string[] }> };
    assert.deepEqual(body.all[0].urls, ["https://diar.ia.br/a"]);
  });

  it("só manda 'after' quando há cursor (1ª página não leva a chave)", () => {
    assert.equal("after" in buildUrlClickFilterBody(1, "https://x"), false);
    assert.equal(buildUrlClickFilterBody(1, "https://x", "cursor-x").after, "cursor-x");
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

// #6504 item 1: --edition + persistência ------------------------------------

describe("resolveEditionArg", () => {
  it("ausente → undefined (fica no caminho --broadcast de sempre)", () => {
    assert.equal(resolveEditionArg([]), undefined);
  });

  it("aceita AAMMDD de 6 dígitos", () => {
    assert.equal(resolveEditionArg(["--edition", "260828"]), "260828");
  });

  it("LANÇA em formato inválido (não 6 dígitos)", () => {
    assert.throws(() => resolveEditionArg(["--edition", "2608"]), /--edition inválido/);
    assert.throws(() => resolveEditionArg(["--edition", "26082899"]), /--edition inválido/);
    assert.throws(() => resolveEditionArg(["--edition", "abc"]), /--edition inválido/);
  });
});

describe("kitDiariaPublishedPath / readEditionKitBroadcastId", () => {
  it("monta o path dentro de _internal/", () => {
    assert.equal(
      kitDiariaPublishedPath("data/editions/2608/260828"),
      resolvePath("data/editions/2608/260828", "_internal", "kit-diaria-published.json"),
    );
  });

  it("lê broadcast_id de um kit-diaria-published.json válido", () => {
    const fakeRead = () => JSON.stringify({ broadcast_id: 25622689, status: "scheduled" });
    assert.equal(readEditionKitBroadcastId("data/editions/2608/260828", fakeRead), 25622689);
  });

  it("LANÇA (mensagem acionável) quando o arquivo não existe — nunca degrada pra 'nada a medir'", () => {
    const fakeRead = (): string => {
      throw new Error("ENOENT");
    };
    assert.throws(
      () => readEditionKitBroadcastId("data/editions/2608/260828", fakeRead),
      /não encontrado.*kit-diaria-stage5-dispatch/,
    );
  });

  it("LANÇA em JSON malformado", () => {
    const fakeRead = () => "{ isto não é json";
    assert.throws(() => readEditionKitBroadcastId("d", fakeRead), /não é JSON válido/);
  });

  it("LANÇA quando broadcast_id não é numérico/está ausente", () => {
    assert.throws(
      () => readEditionKitBroadcastId("d", () => JSON.stringify({ status: "draft" })),
      /não tem "broadcast_id" numérico/,
    );
    assert.throws(
      () => readEditionKitBroadcastId("d", () => JSON.stringify({ broadcast_id: "25622689" })),
      /não tem "broadcast_id" numérico/,
    );
  });
});

function fakeStats(overrides: Partial<KitBroadcastStats> = {}): KitBroadcastStats {
  return { recipients: 594, open_rate: 13.97, click_rate: 4.04, ...overrides } as KitBroadcastStats;
}

describe("buildKitDeliveryRecord", () => {
  it("monta o registro persistido a partir do split + veredito já computados", () => {
    const split = computeProviderSplit({
      sent: ["a@gmail.com", "b@gmail.com", "c@outlook.com"],
      delivered: ["a@gmail.com", "c@outlook.com"],
      openers: ["a@gmail.com"],
      clickers: [],
    });
    const now = new Date("2026-08-28T12:00:00.000Z");
    const record = buildKitDeliveryRecord("260828", 25622689, fakeStats(), split, [], { podeCrescer: false, motivo: "SEGURAR — teste", avisos: [] }, now);

    assert.equal(record.edition, "260828");
    assert.equal(record.broadcastId, 25622689);
    assert.equal(record.measuredAt, "2026-08-28T12:00:00.000Z");
    assert.equal(record.kitStats.recipients, 594);
    assert.equal(record.split.total.sent, 3);
    assert.equal(record.split.gmail.sent, 2);
    assert.equal(record.integridade.ok, true);
    assert.equal(record.rampa.podeCrescer, false);
  });

  it("integridade.ok reflete os avisos passados", () => {
    const split = computeProviderSplit({ sent: [], delivered: [], openers: [], clickers: [] });
    const record = buildKitDeliveryRecord(
      "260828",
      1,
      fakeStats(),
      split,
      [{ codigo: "total-nao-bate", mensagem: "x" }],
      { podeCrescer: false, motivo: "x", avisos: [] },
    );
    assert.equal(record.integridade.ok, false);
    assert.equal(record.integridade.avisos.length, 1);
  });
});

describe("persistKitDeliverySplit / appendKitDeliveryHistory — I/O injetado, sem tocar disco", () => {
  it("persistKitDeliverySplit escreve em _internal/kit-delivery-split.json via write injetado", () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
    const split = computeProviderSplit({ sent: [], delivered: [], openers: [], clickers: [] });
    const record = buildKitDeliveryRecord("260828", 1, fakeStats(), split, [], { podeCrescer: false, motivo: "x", avisos: [] });

    const path = persistKitDeliverySplit("data/editions/2608/260828", record, {
      mkdirSync: (p) => mkdirs.push(p),
      writeFile: (p, c) => writes.push({ path: p, content: c }),
    });

    assert.equal(path, kitDeliverySplitPath("data/editions/2608/260828"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, path);
    assert.deepEqual(JSON.parse(writes[0].content), record);
    assert.equal(mkdirs.length, 1);
  });

  it("appendKitDeliveryHistory anexa 1 linha JSONL por registro, no path default", () => {
    const appended: Array<{ path: string; data: string }> = [];
    const split = computeProviderSplit({ sent: [], delivered: [], openers: [], clickers: [] });
    const record = buildKitDeliveryRecord("260828", 1, fakeStats(), split, [], { podeCrescer: false, motivo: "x", avisos: [] });

    appendKitDeliveryHistory([record], DEFAULT_KIT_DELIVERY_HISTORY_PATH, {
      mkdirSync: () => {},
      appendFileSync: (p, d) => appended.push({ path: p, data: d }),
    });

    assert.equal(appended.length, 1);
    assert.equal(appended[0].path, DEFAULT_KIT_DELIVERY_HISTORY_PATH);
    assert.equal(appended[0].data, JSON.stringify(record) + "\n");
  });

  it("appendKitDeliveryHistory é no-op (não chama I/O) com lista vazia", () => {
    let called = false;
    appendKitDeliveryHistory([], DEFAULT_KIT_DELIVERY_HISTORY_PATH, {
      mkdirSync: () => {
        called = true;
      },
      appendFileSync: () => {
        called = true;
      },
    });
    assert.equal(called, false);
  });
});
