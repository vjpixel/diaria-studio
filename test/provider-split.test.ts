/**
 * provider-split.test.ts — corte de engajamento por provedor.
 *
 * O caso de regressão que dá nome ao arquivo é o incidente de 28/08/2026: um
 * envio cujo agregado parece "ruim" mas cuja queda está inteira num provedor.
 * Se `computeProviderSplit` voltar a diluir isso no total, o teste
 * `incidente 260827` quebra.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProvider,
  emailDomain,
  computeProviderSplit,
  rampaPodeCrescer,
  RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT,
} from "../scripts/lib/provider-split.ts";

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
  it("conta abertura e clique sobre os DESTINATÁRIOS do provedor", () => {
    const split = computeProviderSplit({
      recipients: ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com", "e@hotmail.com"],
      openers: ["a@gmail.com", "e@hotmail.com"],
      clickers: ["e@hotmail.com"],
    });

    const gmail = split.rows.find((r) => r.provider === "Gmail");
    assert.equal(gmail?.recipients, 4);
    assert.equal(gmail?.openers, 1);
    assert.equal(gmail?.openRatePct, 25);
    assert.equal(gmail?.clickRatePct, 0);

    const ms = split.rows.find((r) => r.provider === "Microsoft");
    assert.equal(ms?.openRatePct, 100);
    assert.equal(ms?.clickRatePct, 100);
  });

  it("ordena da maior base para a menor", () => {
    const split = computeProviderSplit({
      recipients: ["a@hotmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com"],
      openers: [],
      clickers: [],
    });
    assert.deepEqual(
      split.rows.map((r) => r.provider),
      ["Gmail", "Microsoft"],
    );
  });

  it("absorve duplicata e diferença de caixa nos três conjuntos", () => {
    const split = computeProviderSplit({
      recipients: ["A@Gmail.com", "a@gmail.com", " a@gmail.com "],
      openers: ["A@GMAIL.COM", "a@gmail.com"],
      clickers: [],
    });
    assert.equal(split.total.recipients, 1);
    assert.equal(split.total.openers, 1);
    assert.equal(split.gmail.openRatePct, 100);
  });

  it("ignora quem abriu/clicou mas não está mais na lista, e reporta em foraDaLista", () => {
    const split = computeProviderSplit({
      recipients: ["fica@gmail.com"],
      openers: ["fica@gmail.com", "saiu@gmail.com"],
      clickers: ["saiu@gmail.com"],
    });
    assert.equal(split.total.openers, 1, "abridor fora da lista não pode inflar o numerador");
    assert.equal(split.total.clickers, 0);
    assert.deepEqual(split.foraDaLista, { openers: 1, clickers: 1 });
  });

  it("não divide por zero com lista vazia", () => {
    const split = computeProviderSplit({ recipients: [], openers: [], clickers: [] });
    assert.deepEqual(split.rows, []);
    assert.equal(split.total.recipients, 0);
    assert.equal(split.total.openRatePct, 0);
    assert.equal(split.gmail.openRatePct, 0);
    assert.equal(split.naoGmail.openRatePct, 0);
  });

  it("gmail + naoGmail somam o total", () => {
    const split = computeProviderSplit({
      recipients: ["a@gmail.com", "b@hotmail.com", "c@empresa.com.br"],
      openers: ["a@gmail.com", "c@empresa.com.br"],
      clickers: ["b@hotmail.com"],
    });
    assert.equal(split.gmail.recipients + split.naoGmail.recipients, split.total.recipients);
    assert.equal(split.gmail.openers + split.naoGmail.openers, split.total.openers);
    assert.equal(split.gmail.clickers + split.naoGmail.clickers, split.total.clickers);
  });

  it("incidente 260827: agregado medíocre esconde colapso num provedor só", () => {
    // 10 Gmail (1 abre, 0 clicam) + 5 de outros provedores (4 abrem, 2 clicam).
    // Agregado: 33% de abertura — parece aceitável. O corte mostra 10% × 80%.
    const gmail = Array.from({ length: 10 }, (_, i) => `g${i}@gmail.com`);
    const outros = Array.from({ length: 5 }, (_, i) => `o${i}@empresa.com.br`);
    const split = computeProviderSplit({
      recipients: [...gmail, ...outros],
      openers: [gmail[0], outros[0], outros[1], outros[2], outros[3]],
      clickers: [outros[0], outros[1]],
    });

    assert.equal(split.total.openRatePct, 33.3);
    assert.equal(split.gmail.openRatePct, 10);
    assert.equal(split.gmail.clickRatePct, 0);
    assert.equal(split.naoGmail.openRatePct, 80);
    assert.equal(split.naoGmail.clickRatePct, 40);
  });
});

describe("rampaPodeCrescer", () => {
  it("segura a onda abaixo do piso", () => {
    const split = computeProviderSplit({
      recipients: ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com", "e@gmail.com"],
      openers: [], // 0%
      clickers: [],
    });
    assert.equal(rampaPodeCrescer(split), false);
  });

  it("libera exatamente NO piso (comparação é >=, não >)", () => {
    const recipients = Array.from({ length: 100 }, (_, i) => `g${i}@gmail.com`);
    const split = computeProviderSplit({
      recipients,
      openers: recipients.slice(0, RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT),
      clickers: [],
    });
    assert.equal(split.gmail.openRatePct, RAMPA_GMAIL_OPEN_RATE_FLOOR_PCT);
    assert.equal(rampaPodeCrescer(split), true);
  });

  it("segura quando não há nenhum Gmail no lote — 0 de 0 não é aprovação", () => {
    const split = computeProviderSplit({
      recipients: ["a@hotmail.com"],
      openers: ["a@hotmail.com"],
      clickers: ["a@hotmail.com"],
    });
    assert.equal(rampaPodeCrescer(split), false);
  });
});
