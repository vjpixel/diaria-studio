/**
 * test/video-roteiro-confere-12754.test.ts (#12754) — conferência da gravação
 * contra o roteiro (`scripts/lib/diaria/roteiro-gravacao.ts`) e o Passo 8 do
 * `/diaria-video-roteiro` que a usa.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  conferirGravacao,
  numerosDaFala,
  renderConferencia,
  validarRoteiroFalas,
  type RoteiroFalas,
} from "../scripts/lib/diaria/roteiro-gravacao.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROTEIRO: RoteiroFalas = {
  edicao: "261112",
  veiculos: ["The Verge"],
  falas: [
    { id: "H1", texto: "Uma empresa de segurança achou mais de 500 senhas e chaves em projetos públicos do Claude Code.", videos: ["horizontal", "vertical1"] },
    { id: "H2", texto: "Oi! Eu sou o Pixel, editor da diar.ia.br, e neste canal comento as principais notícias de IA.", videos: ["horizontal"] },
    { id: "H3", texto: "O arquivo de configurações locais do Claude guardava as senhas sem ninguém perceber.", videos: ["horizontal", "vertical1"] },
    { id: "H4", texto: "Primeira dica: guarda as senhas num cofre e nunca no código do projeto.", videos: ["horizontal", "vertical2"] },
    { id: "V2-gancho", texto: "Três dicas pra não vazar senha usando o Claude Code no trabalho.", videos: ["vertical2"], gravarAParte: true },
  ],
};

function porId(r: ReturnType<typeof conferirGravacao>, id: string) {
  const f = r.falas.find((x) => x.id === id);
  assert.ok(f, `fala ${id} ausente no resultado`);
  return f;
}

describe("conferirGravacao (#12754)", () => {
  it("gravação fiel, fora da ordem do roteiro e sem pontuação: tudo ok, pronto", () => {
    const trans =
      "três dicas pra não vazar senha usando o Claude Code no trabalho " +
      "oi eu sou o Pixel editor da diar.ia.br e neste canal comento as principais notícias de IA " +
      "uma empresa de segurança achou mais de 500 senhas e chaves em projetos públicos do Claude Code " +
      "o arquivo de configurações locais do Claude guardava as senhas sem ninguém perceber " +
      "primeira dica guarda as senhas num cofre e nunca no código do projeto";
    const r = conferirGravacao(ROTEIRO, trans);
    for (const f of r.falas) assert.equal(f.veredito, "ok", `${f.id}: ${f.motivos.join("; ")}`);
    assert.equal(r.pronto, true);
    assert.deepEqual(r.pendencias, []);
    assert.deepEqual(r.trechosSemFala, []);
  });

  it("fala que não aparece vira faltou e entra nas pendências com os vídeos afetados", () => {
    const trans =
      "uma empresa de segurança achou mais de 500 senhas e chaves em projetos públicos do Claude Code. " +
      "Oi! Eu sou o Pixel, editor da diar.ia.br, e neste canal comento as principais notícias de IA. " +
      "O arquivo de configurações locais do Claude guardava as senhas sem ninguém perceber. " +
      "Três dicas pra não vazar senha usando o Claude Code no trabalho.";
    const r = conferirGravacao(ROTEIRO, trans);
    const h4 = porId(r, "H4");
    assert.equal(h4.veredito, "faltou");
    assert.equal(h4.confirmar, true);
    assert.equal(r.pronto, false);
    assert.deepEqual(r.pendencias.map((p) => p.id), ["H4"]);
    assert.deepEqual(r.videosAfetados, ["horizontal", "vertical2"]);
  });

  it("número trocado vira regravar, mesmo com o resto igual", () => {
    const trans = "uma empresa de segurança achou mais de 300 senhas e chaves em projetos públicos do Claude Code";
    const r = conferirGravacao({ falas: [ROTEIRO.falas[0]] }, trans);
    const h1 = porId(r, "H1");
    assert.equal(h1.veredito, "regravar");
    assert.deepEqual(h1.numerosAusentes, ["500"]);
    assert.deepEqual(r.videosAfetados, ["horizontal", "vertical1"]);
  });

  it("número ditado por extenso não conta como troca", () => {
    const trans = "uma empresa de segurança achou mais de quinhentas senhas e chaves em projetos públicos do Claude Code";
    const r = conferirGravacao({ falas: [ROTEIRO.falas[0]] }, trans);
    assert.equal(porId(r, "H1").veredito, "ok");
  });

  it("milhar com ponto casa com 'dois mil'", () => {
    const r = conferirGravacao(
      { falas: [{ id: "H9", texto: "Foram quase 2.000 projetos afetados no mundo.", videos: ["horizontal"] }] },
      "foram quase dois mil projetos afetados no mundo",
    );
    assert.equal(porId(r, "H9").veredito, "ok");
  });

  it("outras palavras com boa parte do conteúdo: diferente-mas-cabe, a confirmar", () => {
    const trans = "o arquivo de configurações do Claude deixava as senhas guardadas e ninguém notou";
    const r = conferirGravacao({ falas: [ROTEIRO.falas[2]] }, trans);
    const h3 = porId(r, "H3");
    assert.equal(h3.veredito, "diferente-mas-cabe");
    assert.equal(h3.confirmar, true);
    assert.equal(r.pronto, true, "diferente-mas-cabe não é pendência");
  });

  it("veículo dito dentro da fala vira regravar", () => {
    const trans = "uma empresa de segurança, segundo o The Verge, achou mais de 500 senhas e chaves em projetos públicos do Claude Code";
    const r = conferirGravacao({ veiculos: ["The Verge"], falas: [ROTEIRO.falas[0]] }, trans);
    const h1 = porId(r, "H1");
    assert.equal(h1.veredito, "regravar");
    assert.deepEqual(h1.veiculosCitados, ["The Verge"]);
    assert.equal(r.pronto, false);
  });

  it("veículo dito fora de qualquer fala também impede o pronto", () => {
    const trans =
      "uma empresa de segurança achou mais de 500 senhas e chaves em projetos públicos do Claude Code. " +
      "Li isso no The Verge hoje cedo.";
    const r = conferirGravacao({ veiculos: ["The Verge"], falas: [ROTEIRO.falas[0]] }, trans);
    assert.equal(porId(r, "H1").veredito, "ok");
    assert.deepEqual(r.veiculosForaDeFala, ["The Verge"]);
    assert.equal(r.pronto, false);
  });

  it("improviso longo sem fala correspondente aparece em trechosSemFala", () => {
    const trans =
      "uma empresa de segurança achou mais de 500 senhas e chaves em projetos públicos do Claude Code. " +
      "Eu mesmo já esqueci uma chave da Brevo num repositório público ano passado e levei um susto enorme.";
    const r = conferirGravacao({ falas: [ROTEIRO.falas[0]] }, trans);
    assert.equal(r.trechosSemFala.length, 1);
    assert.match(r.trechosSemFala[0], /Brevo/);
  });

  it("transcrição vazia: tudo faltou", () => {
    const r = conferirGravacao(ROTEIRO, "");
    assert.ok(r.falas.every((f) => f.veredito === "faltou"));
    assert.equal(r.pendencias.length, ROTEIRO.falas.length);
  });

  it("render lista vereditos, trechos e pendências", () => {
    const r = conferirGravacao(ROTEIRO, "três dicas pra não vazar senha usando o Claude Code no trabalho");
    const txt = renderConferencia(r);
    assert.match(txt, /V2-gancho \(gravar à parte\) \[vertical 2\]: ok/);
    assert.match(txt, /Pendências:/);
    assert.match(txt, /Vídeos afetados: horizontal, vertical 1, vertical 2/);
  });
});

describe("numerosDaFala / validarRoteiroFalas (#12754)", () => {
  it("normaliza milhar e porcentagem", () => {
    assert.deepEqual(numerosDaFala("Mais de 2.000 casos, 40% deles, em 2026."), ["2000", "40", "2026"]);
  });

  it("rejeita falas sem id, com id repetido ou vídeo desconhecido", () => {
    assert.deepEqual(validarRoteiroFalas(ROTEIRO), []);
    const ruim = validarRoteiroFalas({
      falas: [
        { id: "H1", texto: "x", videos: ["horizontal"] },
        { id: "H1", texto: "y", videos: ["shorts"] },
        { texto: "", videos: [] },
      ],
    });
    assert.ok(ruim.some((p) => p.includes("repetido")));
    assert.ok(ruim.some((p) => p.includes("videos")));
    assert.ok(ruim.some((p) => p.includes("id ausente")));
    assert.deepEqual(validarRoteiroFalas({ falas: [] }), ["`falas` ausente ou vazio"]);
  });
});

describe("SKILL.md do /diaria-video-roteiro cita o passo de conferência (#12754)", () => {
  const skill = readFileSync(join(ROOT, ".claude/skills/diaria-video-roteiro/SKILL.md"), "utf8");
  it("tem o Passo 8 com o script e os quatro vereditos", () => {
    assert.match(skill, /## Passo 8 — Conferir a gravação/);
    assert.match(skill, /scripts\/video-roteiro-confere\.ts/);
    for (const v of ["ok", "diferente-mas-cabe", "regravar", "faltou"]) {
      assert.ok(skill.includes(`**${v}**`), `veredito ${v} ausente`);
    }
  });
});
