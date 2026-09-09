/**
 * test/allowlist-blast-radius-7688.test.ts (#7688)
 *
 * Trava o guard de blast radius da allowlist da Retrospectiva do Mês — o que
 * faltava para `build-apoiador-allowlist.ts` deixar de ser o único sync de
 * audiência do projeto que sobrescrevia o estado anterior sem olhar para ele.
 *
 * O caso concreto que motivou (08/09/2026): o push do limiar novo levou o KV
 * de 21 para 10 e-mails — 52% de remoção — sem nenhum aviso proporcional. Ali
 * a queda era esperada; a mesma queda vinda de uma leitura parcial do apoia.se
 * teria sido aplicada exatamente igual. E quem sai não perde um e-mail futuro:
 * perde acesso às Retrospectivas do Mês JÁ publicadas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseCurrentAllowlist,
  evaluateAllowlistBlastRadius,
} from "../scripts/build-apoiador-allowlist.ts";
import { APOIO_TAG_BLAST_RADIUS_THRESHOLD } from "../scripts/lib/shared/kit-apoio-tag.ts";

const emails = (n: number, prefixo = "a") =>
  Array.from({ length: n }, (_, i) => `${prefixo}${i + 1}@x.com`);

describe("#7688 — parseCurrentAllowlist: ausente é vazio, corrompido é ERRO", () => {
  it("chave ausente (null) → [] — é o 1º push, não há remoção possível", () => {
    assert.deepEqual(parseCurrentAllowlist(null), []);
  });

  it("string vazia → []", () => {
    assert.deepEqual(parseCurrentAllowlist("   "), []);
  });

  it("array de e-mails → array", () => {
    assert.deepEqual(parseCurrentAllowlist('["a@x.com","b@x.com"]'), ["a@x.com", "b@x.com"]);
  });

  it("array vazio gravado → []", () => {
    assert.deepEqual(parseCurrentAllowlist("[]"), []);
  });

  it("JSON inválido LANÇA — nunca vira [] (isso zeraria as remoções)", () => {
    // O ponto: tratar lixo como "lista vazia" faria o guard calcular 0
    // remoções e liberar a sobrescrita — exatamente o silêncio que ele existe
    // pra impedir.
    assert.throws(() => parseCurrentAllowlist("{{{"), /não é JSON válido/);
  });

  it("JSON válido mas do tipo errado LANÇA", () => {
    for (const raw of ['{"a":1}', '"texto"', "42", '[1,2,3]', '["ok", 7]']) {
      assert.throws(() => parseCurrentAllowlist(raw), /array de strings|não é JSON válido/, raw);
    }
  });
});

describe("#7688 — evaluateAllowlistBlastRadius: quem entra, quem sai, e quando bloquear", () => {
  it("lista quem SAI, não só a contagem", () => {
    const r = evaluateAllowlistBlastRadius(["a@x.com", "c@x.com"], ["a@x.com", "b@x.com"], false);
    assert.deepEqual(r.entram, ["c@x.com"]);
    assert.deepEqual(r.saem, ["b@x.com"]);
    assert.deepEqual(r.inalterados, ["a@x.com"]);
  });

  it("casa por e-mail normalizado (caixa/espaço não inventam remoção)", () => {
    const r = evaluateAllowlistBlastRadius(["  A@X.com "], ["a@x.com"], false);
    assert.deepEqual(r.saem, []);
    assert.deepEqual(r.entram, []);
  });

  it("1º push (KV vazio) NUNCA bloqueia — só há adições", () => {
    const r = evaluateAllowlistBlastRadius(emails(30), [], false);
    assert.equal(r.blocked, false);
    assert.equal(r.saem.length, 0);
  });

  it("só adições nunca bloqueia, por maior que seja", () => {
    const r = evaluateAllowlistBlastRadius(emails(100), emails(3), false);
    assert.equal(r.blocked, false);
  });

  it("30% exato NÃO bloqueia; 31% bloqueia (o limiar é > , não >=)", () => {
    const atual = emails(10);
    // 3/10 = 30%
    assert.equal(evaluateAllowlistBlastRadius(atual.slice(0, 7), atual, false).blocked, false);
    // 4/10 = 40%
    assert.equal(evaluateAllowlistBlastRadius(atual.slice(0, 6), atual, false).blocked, true);
  });

  it("o caso real de 08/09/2026 (21 → 10, 52%) BLOQUEARIA", () => {
    // Regressão do incidente que motivou a issue: a queda era legítima (o
    // limiar mudou), mas foi aplicada sem que nada a submetesse a confirmação.
    const atual = emails(21);
    const novo = atual.slice(0, 10);
    const r = evaluateAllowlistBlastRadius(novo, atual, false);
    assert.equal(r.blocked, true);
    assert.equal(r.saem.length, 11);
    assert.ok(r.ratio > 0.5, `ratio inesperado: ${r.ratio}`);
  });

  it("--force-blast-radius libera a MESMA queda", () => {
    const atual = emails(21);
    const r = evaluateAllowlistBlastRadius(atual.slice(0, 10), atual, true);
    assert.equal(r.blocked, false);
    assert.equal(r.saem.length, 11, "força não muda o diff — só a decisão");
  });

  it("esvaziar a allowlist inteira bloqueia (o pior caso, e o mais provável de um bug)", () => {
    const atual = emails(12);
    assert.equal(evaluateAllowlistBlastRadius([], atual, false).blocked, true);
  });

  it("usa o MESMO limiar dos syncs de audiência vizinhos", () => {
    // Se alguém afrouxar este guard, que seja em um lugar só — duas respostas
    // diferentes pra mesma pergunta é a origem do próximo bug.
    assert.equal(APOIO_TAG_BLAST_RADIUS_THRESHOLD, 0.3);
  });
});
