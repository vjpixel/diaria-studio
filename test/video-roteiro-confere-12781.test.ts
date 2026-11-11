/**
 * test/video-roteiro-confere-12781.test.ts — achados 2 e 4 do self-review da
 * PR #12759 (#12754), corrigidos em `scripts/lib/diaria/roteiro-gravacao.ts`:
 *   (2) duas falas reclamando as mesmas palavras: a fala que não foi gravada,
 *       cujas palavras aparecem nas vizinhas, saía `diferente-mas-cabe` em vez
 *       de `faltou`;
 *   (4) a empresa que o roteiro cita de propósito e que também é o veículo
 *       fazia a fala sair `regravar`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conferirGravacao, type RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";

function porId(r: ReturnType<typeof conferirGravacao>, id: string) {
  const f = r.falas.find((x) => x.id === id);
  assert.ok(f, `fala ${id} ausente`);
  return f;
}

describe("#12781 (2): duas falas não reclamam as mesmas palavras", () => {
  // H2 junta as palavras de conteúdo de H1 e H3; o editor gravou só H1 e H3.
  const ROTEIRO: RoteiroFalas = {
    falas: [
      { id: "H1", texto: "O banco lançou um assistente de IA para os clientes.", videos: ["horizontal"] },
      { id: "H2", texto: "O assistente de IA atende os clientes do banco.", videos: ["horizontal"] },
      { id: "H3", texto: "Os clientes reclamam que o atendimento piorou desde então.", videos: ["horizontal"] },
    ],
  };
  const trans = "o banco lançou um assistente de IA para os clientes os clientes reclamam que o atendimento piorou desde então";

  it("a fala que faltou sai faltou, não diferente-mas-cabe", () => {
    const r = conferirGravacao(ROTEIRO, trans);
    assert.equal(porId(r, "H1").veredito, "ok");
    assert.equal(porId(r, "H3").veredito, "ok");
    const h2 = porId(r, "H2");
    assert.equal(h2.veredito, "faltou", `${h2.veredito} ${h2.cobertura} "${h2.trecho}"`);
    assert.ok(r.pendencias.some((p) => p.id === "H2"));
    assert.equal(r.pronto, false);
  });

  it("gravada também, a fala volta a ok (a dedup não rouba palavra que foi dita duas vezes)", () => {
    const r = conferirGravacao(ROTEIRO, `${trans} o assistente de IA atende os clientes do banco`);
    for (const id of ["H1", "H2", "H3"]) assert.equal(porId(r, id).veredito, "ok", id);
    assert.equal(r.pronto, true);
  });

  it("falas vizinhas que repetem uma palavra seguem ok", () => {
    const roteiro: RoteiroFalas = {
      falas: [
        { id: "H1", texto: "A IA do Google errou a previsão do tempo.", videos: ["horizontal"] },
        { id: "H2", texto: "A IA da Microsoft acertou a previsão da semana.", videos: ["horizontal"] },
      ],
    };
    const r = conferirGravacao(roteiro, "a IA do Google errou a previsão do tempo a IA da Microsoft acertou a previsão da semana");
    assert.equal(porId(r, "H1").veredito, "ok");
    assert.equal(porId(r, "H2").veredito, "ok");
  });
});

describe("#12781 (4): empresa que também é o veículo, citada de propósito", () => {
  const ROTEIRO: RoteiroFalas = {
    veiculos: ["Bloomberg", "The Verge"],
    falas: [
      { id: "H1", texto: "A Bloomberg lançou um modelo de IA treinado com dados do mercado.", videos: ["horizontal", "vertical1"] },
      { id: "H2", texto: "O modelo responde perguntas sobre ações em segundos.", videos: ["horizontal"] },
    ],
  };

  it("a fala que cita a empresa no roteiro sai ok, sem veículo citado", () => {
    const r = conferirGravacao(ROTEIRO, "a Bloomberg lançou um modelo de IA treinado com dados do mercado o modelo responde perguntas sobre ações em segundos");
    const h1 = porId(r, "H1");
    assert.equal(h1.veredito, "ok", h1.motivos.join("; "));
    assert.deepEqual(h1.veiculosCitados, []);
    assert.deepEqual(r.veiculosForaDeFala, []);
    assert.equal(r.pronto, true);
  });

  it("a empresa dita fora das falas segue apontada e impede o pronto", () => {
    const r = conferirGravacao(ROTEIRO, "a Bloomberg lançou um modelo de IA treinado com dados do mercado segundo a Bloomberg o modelo responde perguntas sobre ações em segundos");
    assert.equal(porId(r, "H1").veredito, "ok");
    const h2 = porId(r, "H2");
    assert.equal(h2.veredito, "ok", "a Bloomberg do H2 cai fora do trecho aparado");
    assert.deepEqual(r.veiculosForaDeFala, ["Bloomberg"], "dita fora das falas, segue apontada");
    assert.equal(r.pronto, false);
  });

  it("veículo que o roteiro não cita segue regravar dentro da fala", () => {
    const r = conferirGravacao(ROTEIRO, "a Bloomberg lançou um modelo de IA treinado com dados do mercado o modelo segundo o The Verge responde perguntas sobre ações em segundos");
    const h2 = porId(r, "H2");
    assert.equal(h2.veredito, "regravar");
    assert.deepEqual(h2.veiculosCitados, ["The Verge"]);
  });
});
