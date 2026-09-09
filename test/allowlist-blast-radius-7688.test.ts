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
  decideAllowlistPush,
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

  it("denominador é DEDUPLICADO — allowlist com repetidos não dilui a razão", () => {
    // Achado do review: `current.length` cru contra um numerador já
    // normalizado faria o guard bloquear MENOS do que deveria. Só alcançável
    // por uma escrita forçada/à mão anterior, mas é justamente o estado em que
    // o guard mais precisa funcionar.
    const atual = ["a@x.com", "A@X.com", " a@x.com ", "b@x.com"]; // 2 distintos
    const r = evaluateAllowlistBlastRadius(["b@x.com"], atual, false);
    assert.equal(r.currentCount, 2, "deduplicado");
    assert.deepEqual(r.saem, ["a@x.com"]);
    assert.equal(r.ratio, 0.5);
    assert.equal(r.blocked, true, "1 de 2 é 50% — bloqueia; com denominador 4 daria 25% e passaria");
  });
});

describe("#7688 — decideAllowlistPush: o miolo da issue (ler ANTES de sobrescrever)", () => {
  const dez = emails(10);

  it("leitura ok e queda pequena → push, com o diff preenchido", async () => {
    const d = await decideAllowlistPush({
      next: dez.slice(0, 8),
      force: false,
      readCurrent: async () => JSON.stringify(dez),
    });
    assert.equal(d.action, "push");
    assert.equal(d.action === "push" ? d.blast.saem.length : -1, 2);
  });

  it("queda acima do limiar → refuse, e a razão diz o que conferir", async () => {
    const d = await decideAllowlistPush({
      next: dez.slice(0, 4),
      force: false,
      readCurrent: async () => JSON.stringify(dez),
    });
    assert.equal(d.action, "refuse");
    assert.match(d.action === "refuse" ? d.reason : "", /leitura parcial do apoia\.se/);
  });

  it("mesma queda COM force → push (a decisão consciente), com diff", async () => {
    const d = await decideAllowlistPush({
      next: dez.slice(0, 4),
      force: true,
      readCurrent: async () => JSON.stringify(dez),
    });
    assert.equal(d.action, "push");
    assert.equal(d.action === "push" ? d.blast.saem.length : -1, 6);
  });

  it("LEITURA falha sem force → refuse (nunca sobrescreve às cegas)", async () => {
    const d = await decideAllowlistPush({
      next: dez,
      force: false,
      readCurrent: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    assert.equal(d.action, "refuse");
    assert.match(d.action === "refuse" ? d.reason : "", /ETIMEDOUT/);
    assert.match(d.action === "refuse" ? d.reason : "", /--force-blast-radius/);
  });

  it("leitura falha COM force → push-unverified, e NÃO inventa um diff", async () => {
    // O ponto: a 1ª versão caía pra `current = []` e logava "-0 saem
    // (atual: 0)" — autoritativo e falso, justo quando o operador mais precisa
    // saber que não sabe. Agora o desfecho é um estado próprio, sem diff.
    const d = await decideAllowlistPush({
      next: dez,
      force: true,
      readCurrent: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    assert.equal(d.action, "push-unverified");
    assert.match(d.action === "push-unverified" ? d.reason : "", /DESCONHECIDAS/);
    assert.ok(!("blast" in d), "não pode carregar um diff que não existe");
  });

  it("KV corrompido sem force → refuse (não trata lixo como lista vazia)", async () => {
    const d = await decideAllowlistPush({
      next: dez,
      force: false,
      readCurrent: async () => "{{{",
    });
    assert.equal(d.action, "refuse");
    assert.match(d.action === "refuse" ? d.reason : "", /não é JSON válido/);
  });

  it("chave ausente (1º push) → push sem bloquear, mesmo com a lista inteira entrando", async () => {
    const d = await decideAllowlistPush({ next: dez, force: false, readCurrent: async () => null });
    assert.equal(d.action, "push");
    assert.equal(d.action === "push" ? d.blast.entram.length : -1, 10);
    assert.equal(d.action === "push" ? d.blast.saem.length : -1, 0);
  });

  it("esvaziar a allowlist inteira → refuse", async () => {
    const d = await decideAllowlistPush({
      next: [],
      force: false,
      readCurrent: async () => JSON.stringify(dez),
    });
    assert.equal(d.action, "refuse");
  });

  it("o caso real de 08/09/2026 (21 → 10) → refuse", async () => {
    const atual = emails(21);
    const d = await decideAllowlistPush({
      next: atual.slice(0, 10),
      force: false,
      readCurrent: async () => JSON.stringify(atual),
    });
    assert.equal(d.action, "refuse");
    assert.match(d.action === "refuse" ? d.reason : "", /11\/21/);
  });
});
