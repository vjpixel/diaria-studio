/**
 * semantic-drift.test.ts (#603, #630)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitByDestaque,
  extractEntities,
  detectDrift,
} from "../scripts/lib/semantic-drift.ts";

describe("splitByDestaque (#603)", () => {
  it("agrupa linhas por destaque", () => {
    const md = `intro line

DESTAQUE 1 | x

linha do d1

DESTAQUE 2 | y

linha do d2`;
    const map = splitByDestaque(md);
    assert.ok(map.has(""));
    assert.ok(map.has("DESTAQUE 1"));
    assert.ok(map.has("DESTAQUE 2"));
    assert.ok(map.get("DESTAQUE 1")!.some((l) => l.includes("linha do d1")));
    assert.ok(map.get("DESTAQUE 2")!.some((l) => l.includes("linha do d2")));
  });

  it("limpa destaque ao entrar em LANÇAMENTOS / PESQUISAS / OUTRAS", () => {
    const md = `DESTAQUE 1 | X

corpo

LANÇAMENTOS

item 1`;
    const map = splitByDestaque(md);
    const lan = map.get("") ?? [];
    assert.ok(lan.some((l) => l.includes("item 1")));
  });
});

describe("extractEntities (#603)", () => {
  it("extrai números simples e com %", () => {
    const { numbers } = extractEntities("crescimento de 30% em 2 anos");
    const values = numbers.map((n) => n.value);
    assert.ok(values.includes("30%"));
    assert.ok(values.includes("2"));
  });

  it("extrai datas ISO", () => {
    const { dates } = extractEntities("anunciado em 2026-05-06");
    assert.ok(dates.some((d) => d.value.includes("2026-05-06")));
  });

  it("extrai datas no formato slash", () => {
    const { dates } = extractEntities("agendado pra 06/05/2026");
    assert.ok(dates.some((d) => d.value.includes("06/05/2026")));
  });

  it("extrai datas em PT-BR (5 de maio)", () => {
    const { dates } = extractEntities("publicado em 5 de maio de 2026");
    assert.ok(dates.some((d) => d.value.includes("5 de maio")));
  });

  it("não double-counta dígitos de uma data como números separados", () => {
    const { numbers, dates } = extractEntities("publicado em 06/05/2026 com 30% crescimento");
    // 06, 05, 2026 não devem aparecer em numbers (já estão na date)
    assert.equal(dates.length, 1);
    const numValues = numbers.map((n) => n.value);
    assert.ok(numValues.includes("30%"));
    assert.equal(numValues.includes("06"), false, "06 da data não deve aparecer em numbers");
    assert.equal(numValues.includes("2026"), false, "2026 da data não deve aparecer em numbers");
  });

  it("snippet inclui contexto", () => {
    const { numbers } = extractEntities("a empresa cresceu 30% no último ano");
    assert.ok(numbers[0].snippet.includes("cresceu 30% no"));
  });
});

describe("detectDrift (#603)", () => {
  it("detecta número novo no email não presente no source", () => {
    const source = `DESTAQUE 1 | X

empresa Y cresceu 10% em 2 anos.`;
    const email = `DESTAQUE 1 | X

empresa Y cresceu 12% em 2 anos.`;
    const drifts = detectDrift(email, source);
    const emailOnly = drifts.filter((d) => d.side === "email");
    const sourceOnly = drifts.filter((d) => d.side === "source");
    assert.ok(emailOnly.some((d) => d.value === "12%"));
    assert.ok(sourceOnly.some((d) => d.value === "10%"));
  });

  it("não emite drift quando entidades batem", () => {
    const source = `DESTAQUE 1 | X

empresa Y cresceu 10% em 2 anos.`;
    const email = `DESTAQUE 1 | X

empresa Y cresceu 10% em 2 anos.`;
    const drifts = detectDrift(email, source);
    assert.equal(drifts.length, 0);
  });

  it("ignora destaques que não existem em ambos", () => {
    const source = "DESTAQUE 1 | X\n\nlinha";
    const email = "DESTAQUE 2 | Y\n\nlinha";
    const drifts = detectDrift(email, source);
    assert.equal(drifts.length, 0, "sem overlap de destaque, não compara");
  });

  it("ignora seção vazia (intro/lançamentos)", () => {
    const source = "intro com 5 itens\n\nDESTAQUE 1 | X\n\ntexto comum";
    const email = "intro com 7 itens\n\nDESTAQUE 1 | X\n\ntexto comum";
    const drifts = detectDrift(email, source);
    // Seção vazia não conta — só destaques
    assert.equal(drifts.length, 0);
  });

  it("detecta drift de data", () => {
    const source = "DESTAQUE 1 | X\n\nlançado em 5 de maio de 2026.";
    const email = "DESTAQUE 1 | X\n\nlançado em 6 de maio de 2026.";
    const drifts = detectDrift(email, source);
    const dateDrifts = drifts.filter((d) => d.kind === "date");
    assert.ok(dateDrifts.length > 0, "deve detectar drift de data");
  });

  it("normaliza vírgula vs ponto (1,5 == 1.5)", () => {
    const source = "DESTAQUE 1 | X\n\ngrowth de 1,5x";
    const email = "DESTAQUE 1 | X\n\ngrowth de 1.5x";
    const drifts = detectDrift(email, source);
    assert.equal(drifts.length, 0, "1,5 e 1.5 devem ser considerados iguais");
  });
});
