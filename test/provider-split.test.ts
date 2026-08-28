/**
 * provider-split.test.ts — entrega e engajamento por provedor.
 *
 * Os dois casos de regressão que dão razão ao arquivo são o incidente de
 * 28/08/2026 (#6504): um envio cujo agregado parece "abertura ruim" mas cuja
 * falha é ENTREGA, e concentrada num provedor só. Se `computeProviderSplit`
 * voltar a diluir isso no total, `incidente 260827 (agregado)` quebra; se o
 * gate voltar a aprovar com entrega colapsada, `incidente 260827 (gate)`
 * quebra.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProvider,
  emailDomain,
  computeProviderSplit,
  avaliarRampa,
  rampaPodeCrescer,
  RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT,
  RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT,
  type ProviderSplitInput,
} from "../scripts/lib/provider-split.ts";

/** Entrega tudo que foi enviado — atalho pros casos que não testam entrega. */
function entregaTotal(input: Omit<ProviderSplitInput, "delivered">): ProviderSplitInput {
  return { ...input, delivered: input.sent };
}

describe("emailDomain", () => {
  it("normaliza caixa e espaço em volta", () => {
    assert.equal(emailDomain("  Pessoa@Gmail.COM "), "gmail.com");
  });

  it("usa o ÚLTIMO @ (endereço com @ no local part citado)", () => {
    assert.equal(emailDomain('"a@b"@exemplo.com.br'), "exemplo.com.br");
  });

  it("devolve null pra entrada sem domínio utilizável", () => {
    for (const bad of ["", "   ", "semarroba", "@so-dominio.com", "local@"]) {
      assert.equal(emailDomain(bad), null, `esperava null para ${JSON.stringify(bad)}`);
    }
  });
});

describe("classifyProvider", () => {
  it("reconhece os provedores nomeados", () => {
    const casos: Array<[string, string]> = [
      ["a@gmail.com", "Gmail"],
      ["a@googlemail.com", "Gmail"],
      ["a@hotmail.com", "Microsoft"],
      ["a@outlook.com.br", "Microsoft"],
      ["a@yahoo.com.br", "Yahoo"],
      ["a@icloud.com", "Apple"],
      ["a@proton.me", "Proton"],
      ["a@uol.com.br", "UOL/BOL/Terra"],
    ];
    for (const [email, esperado] of casos) {
      assert.equal(classifyProvider(email), esperado, email);
    }
  });

  it("manda domínio próprio/corporativo e entrada malformada pra Outros", () => {
    assert.equal(classifyProvider("pessoa@empresa.com.br"), "Outros");
    assert.equal(classifyProvider("lixo"), "Outros");
  });

  it("NÃO confunde subdomínio com o provedor (gmail.com.br não é Gmail)", () => {
    assert.equal(classifyProvider("a@gmail.com.br"), "Outros");
    assert.equal(classifyProvider("a@naoegmail.com"), "Outros");
  });
});

describe("computeProviderSplit", () => {
  it("conta entrega sobre ENVIADOS e engajamento sobre ENTREGUES", () => {
    const split = computeProviderSplit({
      sent: ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com", "e@hotmail.com"],
      delivered: ["a@gmail.com", "b@gmail.com", "e@hotmail.com"],
      openers: ["a@gmail.com", "e@hotmail.com"],
      clickers: ["e@hotmail.com"],
    });

    const gmail = split.rows.find((r) => r.provider === "Gmail");
    assert.equal(gmail?.sent, 4);
    assert.equal(gmail?.delivered, 2);
    assert.equal(gmail?.deliveryRatePct, 50);
    assert.equal(gmail?.openers, 1);
    assert.equal(gmail?.openRatePct, 50, "1 abertura sobre 2 ENTREGUES, não sobre 4 enviados");
    assert.equal(gmail?.clickRatePct, 0);

    const ms = split.rows.find((r) => r.provider === "Microsoft");
    assert.equal(ms?.deliveryRatePct, 100);
    assert.equal(ms?.openRatePct, 100);
    assert.equal(ms?.clickRatePct, 100);
  });

  it("não entregue nunca conta como aberto, mesmo com o endereço no envio", () => {
    const split = computeProviderSplit({
      sent: ["a@gmail.com", "b@gmail.com"],
      delivered: ["a@gmail.com"],
      openers: ["a@gmail.com"],
      clickers: [],
    });
    assert.equal(split.gmail.delivered, 1);
    assert.equal(split.gmail.openRatePct, 100);
  });

  it("ordena da maior base para a menor", () => {
    const split = computeProviderSplit(
      entregaTotal({
        sent: ["a@hotmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com"],
        openers: [],
        clickers: [],
      }),
    );
    assert.deepEqual(
      split.rows.map((r) => r.provider),
      ["Gmail", "Microsoft"],
    );
  });

  it("absorve duplicata e diferença de caixa em todos os conjuntos", () => {
    const split = computeProviderSplit({
      sent: ["A@Gmail.com", "a@gmail.com", " a@gmail.com "],
      delivered: ["A@GMAIL.COM"],
      openers: ["A@GMAIL.COM", "a@gmail.com"],
      clickers: [],
    });
    assert.equal(split.total.sent, 1);
    assert.equal(split.total.delivered, 1);
    assert.equal(split.total.openers, 1);
    assert.equal(split.gmail.openRatePct, 100);
  });

  it("ignora quem engajou fora do envio e reporta em foraDoEnvio", () => {
    const split = computeProviderSplit(
      entregaTotal({
        sent: ["fica@gmail.com"],
        openers: ["fica@gmail.com", "estranho@gmail.com"],
        clickers: ["estranho@gmail.com"],
      }),
    );
    assert.equal(split.total.openers, 1, "abridor fora do envio não pode inflar o numerador");
    assert.equal(split.total.clickers, 0);
    assert.deepEqual(split.foraDoEnvio, { openers: 1, clickers: 1 });
  });

  it("reporta em engajouSemEntrega quem abriu sem constar como entregue", () => {
    const split = computeProviderSplit({
      sent: ["a@gmail.com", "b@gmail.com"],
      delivered: ["a@gmail.com"],
      openers: ["a@gmail.com", "b@gmail.com"],
      clickers: ["b@gmail.com"],
    });
    assert.deepEqual(split.engajouSemEntrega, { openers: 1, clickers: 1 });
    assert.equal(split.gmail.openRatePct, 200, "não clampa: 2 aberturas sobre 1 entrega fica visível");
  });

  it("não divide por zero com envio vazio", () => {
    const split = computeProviderSplit({ sent: [], delivered: [], openers: [], clickers: [] });
    assert.deepEqual(split.rows, []);
    assert.equal(split.total.sent, 0);
    assert.equal(split.total.deliveryRatePct, 0);
    assert.equal(split.total.openRatePct, 0);
    assert.equal(split.gmail.openRatePct, 0);
    assert.equal(split.naoGmail.openRatePct, 0);
  });

  it("gmail + naoGmail somam o total nos quatro eixos", () => {
    const split = computeProviderSplit({
      sent: ["a@gmail.com", "b@hotmail.com", "c@empresa.com.br"],
      delivered: ["a@gmail.com", "b@hotmail.com"],
      openers: ["a@gmail.com"],
      clickers: ["b@hotmail.com"],
    });
    for (const eixo of ["sent", "delivered", "openers", "clickers"] as const) {
      assert.equal(
        split.gmail[eixo] + split.naoGmail[eixo],
        split.total[eixo],
        `${eixo} não fecha`,
      );
    }
  });

  it("incidente 260827 (agregado): entrega colapsada num provedor só, abertura normal em quem recebeu", () => {
    // Proporções reais do #6504: Gmail 433 enviados / 122 entregues / 37 aberturas;
    // resto 161 enviados / 129 entregues / 46 aberturas.
    const gmail = Array.from({ length: 433 }, (_, i) => `g${i}@gmail.com`);
    const outros = Array.from({ length: 161 }, (_, i) => `o${i}@empresa.com.br`);
    const split = computeProviderSplit({
      sent: [...gmail, ...outros],
      delivered: [...gmail.slice(0, 122), ...outros.slice(0, 129)],
      openers: [...gmail.slice(0, 37), ...outros.slice(0, 46)],
      clickers: [],
    });

    assert.equal(split.gmail.deliveryRatePct, 28.2, "o Gmail recusou ~72% na porta");
    assert.equal(split.naoGmail.deliveryRatePct, 80.1);
    assert.equal(split.gmail.openRatePct, 30.3, "quem recebeu abriu normal — não é problema de conteúdo");
    assert.equal(split.total.openRatePct, 33.1, "sobre ENTREGUES o agregado é saudável");

    // O número que enganou em 260827 era abertura sobre ENVIADOS (83/594 = 14%).
    // Nenhuma taxa deste módulo pode reproduzi-lo.
    assert.notEqual(split.total.openRatePct, 14);
  });
});

describe("avaliarRampa", () => {
  it("incidente 260827 (gate): entrega colapsada SEGURA mesmo com abertura ótima", () => {
    const gmail = Array.from({ length: 433 }, (_, i) => `g${i}@gmail.com`);
    const split = computeProviderSplit({
      sent: gmail,
      delivered: gmail.slice(0, 122), // 28,2%
      openers: gmail.slice(0, 122), // 100% de abertura sobre entregues
      clickers: [],
    });

    const veredito = avaliarRampa(split);
    assert.equal(veredito.podeCrescer, false);
    assert.match(veredito.motivo, /entrega Gmail/);
    assert.match(veredito.motivo, /28\.2%/);
  });

  it("segura quando a entrega está OK mas a abertura está abaixo do piso", () => {
    const gmail = Array.from({ length: 100 }, (_, i) => `g${i}@gmail.com`);
    const veredito = avaliarRampa(
      computeProviderSplit({
        sent: gmail,
        delivered: gmail,
        openers: gmail.slice(0, RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT - 1),
        clickers: [],
      }),
    );
    assert.equal(veredito.podeCrescer, false);
    assert.match(veredito.motivo, /abertura sobre entregues/);
  });

  it("libera exatamente NOS dois pisos (comparação é >=, não >)", () => {
    const gmail = Array.from({ length: 100 }, (_, i) => `g${i}@gmail.com`);
    const split = computeProviderSplit({
      sent: gmail,
      delivered: gmail.slice(0, RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT),
      openers: gmail.slice(0, RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT),
      clickers: [],
    });
    assert.equal(split.gmail.deliveryRatePct, RAMPA_GMAIL_DELIVERY_RATE_FLOOR_PCT);
    assert.ok(split.gmail.openRatePct >= RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT);
    assert.equal(rampaPodeCrescer(split), true);
  });

  it("segura quando não há nenhum Gmail no envio — 0 de 0 não é aprovação", () => {
    const veredito = avaliarRampa(
      computeProviderSplit(
        entregaTotal({
          sent: ["a@hotmail.com"],
          openers: ["a@hotmail.com"],
          clickers: ["a@hotmail.com"],
        }),
      ),
    );
    assert.equal(veredito.podeCrescer, false);
    assert.match(veredito.motivo, /consulta\/filtro errado/);
  });

  it("o motivo nunca vem vazio, em qualquer veredito", () => {
    const gmail = Array.from({ length: 10 }, (_, i) => `g${i}@gmail.com`);
    const cenarios = [
      { sent: [], delivered: [], openers: [], clickers: [] },
      { sent: gmail, delivered: [], openers: [], clickers: [] },
      { sent: gmail, delivered: gmail, openers: [], clickers: [] },
      { sent: gmail, delivered: gmail, openers: gmail, clickers: gmail },
    ];
    for (const c of cenarios) {
      assert.ok(avaliarRampa(computeProviderSplit(c)).motivo.length > 0);
    }
  });
});
