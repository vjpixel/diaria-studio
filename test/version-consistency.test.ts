/**
 * version-consistency.test.ts (#630)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  destaqueHeaderAt,
  extractVersionMentions,
  detectInconsistencies,
} from "../scripts/lib/version-consistency.ts";

describe("destaqueHeaderAt (#630)", () => {
  it("identifica header DESTAQUE N", () => {
    assert.equal(destaqueHeaderAt("DESTAQUE 1 | 🔒 SEGURANÇA", ""), "DESTAQUE 1");
    assert.equal(destaqueHeaderAt("DESTAQUE 2 | 📈 TENDÊNCIA", ""), "DESTAQUE 2");
  });

  it("preserva destaque atual em linha de conteúdo", () => {
    assert.equal(destaqueHeaderAt("conteúdo qualquer", "DESTAQUE 1"), "DESTAQUE 1");
  });

  it("limpa quando entra em outras seções", () => {
    assert.equal(destaqueHeaderAt("LANÇAMENTOS", "DESTAQUE 3"), "");
    assert.equal(destaqueHeaderAt("PESQUISAS", "DESTAQUE 3"), "");
    assert.equal(destaqueHeaderAt("OUTRAS NOTÍCIAS", "DESTAQUE 3"), "");
    assert.equal(destaqueHeaderAt("É IA?", "DESTAQUE 1"), "");
    assert.equal(destaqueHeaderAt("---", "DESTAQUE 1"), "");
  });

  it("DESTAQUE em case-insensitive", () => {
    assert.equal(destaqueHeaderAt("destaque 5 | x", ""), "DESTAQUE 5");
  });
});

describe("extractVersionMentions (#630)", () => {
  it("extrai V4, V5 do texto", () => {
    const md = `DESTAQUE 1 | TEST

DeepSeek V4 lança modelo

O V4 supera o V5 anterior em benchmarks.`;
    const mentions = extractVersionMentions(md);
    const versions = mentions.map((m) => m.version);
    assert.ok(versions.includes("V4"));
    assert.ok(versions.includes("V5"));
    assert.equal(mentions.every((m) => m.destaque === "DESTAQUE 1"), true);
  });

  it("não match em palavras com V mas sem dígito", () => {
    const md = "DESTAQUE 1 | X\n\nThe Vendor was excellent.";
    const mentions = extractVersionMentions(md);
    assert.equal(mentions.length, 0);
  });

  it("não match em ano (2026)", () => {
    const md = "DESTAQUE 1 | X\n\nEm 2026, o setor cresceu.";
    const mentions = extractVersionMentions(md);
    assert.equal(mentions.length, 0);
  });

  it("preserva line number 1-indexed", () => {
    const md = "linha 1\nlinha 2 V3\nlinha 3";
    const mentions = extractVersionMentions(md);
    assert.equal(mentions[0].line, 2);
  });

  it("destaque vazio para mentions fora de seção destaque", () => {
    const md = `LANÇAMENTOS

V4 do produto X anunciado.`;
    const mentions = extractVersionMentions(md);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].destaque, "");
  });

  it("captura V com decimal (V4.5, V12.3)", () => {
    const md = "DESTAQUE 1 | X\n\nO V4.5 lançou hoje.";
    const mentions = extractVersionMentions(md);
    assert.equal(mentions[0].version, "V4.5");
  });

  it("snippet inclui contexto da menção", () => {
    const md = "DESTAQUE 1 | X\n\nOlha o DeepSeek V4 chegou hoje.";
    const mentions = extractVersionMentions(md);
    assert.ok(mentions[0].snippet.includes("DeepSeek V4"));
  });
});

describe("detectInconsistencies (#630)", () => {
  it("flag quando 2+ versões distintas no mesmo destaque", () => {
    const md = `DESTAQUE 2 | TENDÊNCIA

DeepSeek V4 muda o jogo. O V5 ainda não saiu mas V6 já está em rumores.`;
    const mentions = extractVersionMentions(md);
    const groups = detectInconsistencies(mentions);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].destaque, "DESTAQUE 2");
    const versions = new Set(groups[0].mentions.map((m) => m.version));
    assert.ok(versions.has("V4"));
    assert.ok(versions.has("V5"));
    assert.ok(versions.has("V6"));
  });

  it("não flag quando todas as versões iguais", () => {
    const md = `DESTAQUE 1 | X

V4 do produto. O V4 é melhor que V4.`;
    const mentions = extractVersionMentions(md);
    const groups = detectInconsistencies(mentions);
    assert.equal(groups.length, 0);
  });

  it("não flag mentions fora de destaque", () => {
    const md = `LANÇAMENTOS

V4 do produto A.
V5 do produto B.`;
    const mentions = extractVersionMentions(md);
    const groups = detectInconsistencies(mentions);
    assert.equal(groups.length, 0);
  });

  it("flags em destaques distintos são reportados separadamente", () => {
    const md = `DESTAQUE 1 | X

V1 e V2 do produto A.

DESTAQUE 2 | Y

V8 e V9 do produto B.`;
    const mentions = extractVersionMentions(md);
    const groups = detectInconsistencies(mentions);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.destaque).sort(), ["DESTAQUE 1", "DESTAQUE 2"]);
  });

  it("regression: cenário 260505 (V4 título + V5/V6/V7 corpo) é detectado", () => {
    const md = `DESTAQUE 2 | TENDÊNCIA

V4 da DeepSeek muda o jogo dos chips chineses

O DeepSeek V5 superou seus antecessores em benchmarks.

A novidade geopolítica é que o V6 foi treinado com chips da Huawei.

O efeito de mercado é direto: a eficiência do V7 derruba os preços.`;
    const mentions = extractVersionMentions(md);
    const groups = detectInconsistencies(mentions);
    assert.equal(groups.length, 1);
    const versions = new Set(groups[0].mentions.map((m) => m.version));
    assert.deepEqual(
      [...versions].sort(),
      ["V4", "V5", "V6", "V7"],
    );
  });
});
