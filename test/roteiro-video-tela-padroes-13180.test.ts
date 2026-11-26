/**
 * test/roteiro-video-tela-padroes-13180.test.ts (#13180)
 *
 * Padrões do texto de tela que o editor fixou na revisão do roteiro da 261116:
 *   - os verticais saem sem tela (a página só mostra o box no horizontal);
 *   - título do box na primeira linha, inteira entre `**`, em negrito;
 *   - um item por linha, sem empresa entre parênteses, sem "(padrão)"
 *     (`avisosTela`, que avisa e nunca invalida);
 *   - o `**` não chega ao XML da montagem (`readRoteiroTelas`).
 * E o Passo 5 do `/diaria-video-roteiro` registra as regras.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validarRoteiroFalas, type RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { avisosTela, readRoteiroTelas, ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";
import { renderRoteiroPagina, telaHtml } from "../scripts/lib/diaria/roteiro-pagina.ts";
import { readSkillWithReferences } from "./_helpers/skill-text.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
const base = (): RoteiroFalas => JSON.parse(readFileSync(FIXTURE, "utf8"));
const TELA_H6 = "**Artificial Analysis Intelligence Index**\nHydrogen: 51\nArgon: 50\nClaude Sonnet 5.5: 55";

function comTela(): RoteiroFalas {
  const r = base();
  const h6 = r.falas.find((f) => f.id === "H6");
  assert.ok(h6 && h6.videos.includes("horizontal") && h6.videos.some((v) => v !== "horizontal"), "H6 da fixture tem de estar no horizontal e num vertical");
  h6.tela = TELA_H6;
  return r;
}

function secao(html: string, de: string, ate?: string): string {
  const i = html.indexOf(`aria-label="${de}"`);
  assert.ok(i > 0, `seção ${de} ausente`);
  const j = ate ? html.indexOf(`aria-label="${ate}"`, i) : html.indexOf('aria-label="Notas para a edição"', i);
  return html.slice(i, j > i ? j : undefined);
}

describe("#13180: a página", () => {
  const r = comTela();
  assert.deepEqual(validarRoteiroFalas(r), []);
  const html = renderRoteiroPagina(r);

  it("o box Na tela aparece no horizontal, com o título em negrito na linha própria", () => {
    const h = secao(html, "horizontal", "vertical 1");
    assert.match(h, /<aside class="tela"><b>Na tela<\/b><strong>Artificial Analysis Intelligence Index<\/strong><br>Hydrogen: 51<br>Argon: 50<br>Claude Sonnet 5.5: 55<\/aside>/);
  });

  it("os verticais saem sem box de tela", () => {
    assert.ok(!secao(html, "vertical 1", "vertical 2").includes('class="tela"'));
    assert.ok(!secao(html, "vertical 2").includes('class="tela"'));
  });

  it("nenhum ** cru na página", () => {
    assert.ok(!html.includes("**"));
  });

  it("telaHtml: só a linha inteira entre ** vira negrito, e escapa o resto", () => {
    assert.equal(telaHtml("**Título**\nA: 1"), "<strong>Título</strong><br>A: 1");
    assert.equal(telaHtml("x < y"), "x &lt; y");
  });
});

describe("#13180: avisosTela", () => {
  const fala = (tela: string, videos: RoteiroFalas["falas"][number]["videos"] = ["horizontal"]) => ({
    falas: [{ id: "H1", texto: "Uma fala.", videos, tela }],
  });

  it("box no padrão não avisa", () => {
    assert.deepEqual(avisosTela(fala(TELA_H6)), []);
    assert.deepEqual(avisosTela(fala("**Gemini 4**\nCarbon (Ultra)\nArgon (Pro)\nHydrogen (grátis)")), []);
  });

  it("avisa ' · ', empresa entre parênteses, '(padrão)', ** no meio e tela só no vertical", () => {
    assert.ok(avisosTela(fala("App do Gemini · Busca do Google")).some((a) => /um item por linha/.test(a)));
    assert.ok(avisosTela(fala("Claude Sonnet 5.5 (Anthropic)")).some((a) => /\(Anthropic\).*nome do modelo basta/.test(a)));
    assert.ok(avisosTela(fala("Hydrogen (padrão)")).some((a) => /\(padrão\)/.test(a)));
    assert.ok(avisosTela(fala("Índice (dados do Google)")).some((a) => /\(dados do Google\)/.test(a)));
    assert.ok(avisosTela(fala("O **Hydrogen** ganhou")).some((a) => /\*\* fora de uma linha inteira/.test(a)));
    assert.ok(avisosTela(fala("Hydrogen: 51", ["vertical1"])).some((a) => /só está nos verticais/.test(a)));
  });

  it("avisa, nunca invalida", () => {
    assert.deepEqual(validarRoteiroFalas(fala("App · Busca (padrão)")), []);
  });
});

describe("#13180: o XML da montagem recebe a tela sem **", () => {
  it("readRoteiroTelas tira a marcação do título", () => {
    const dir = mkdtempSync(join(tmpdir(), "tela-13180-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify(comTela()));
      const telas = readRoteiroTelas(dir, () => {});
      const h6 = telas.find((t) => t.id === "H6");
      assert.ok(h6);
      assert.equal(h6.tela, "Artificial Analysis Intelligence Index\nHydrogen: 51\nArgon: 50\nClaude Sonnet 5.5: 55");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13180/#13178: a skill registra as regras", () => {
  // #14040: o Passo 8 vive em reference/; o helper junta SKILL.md + reference/*.md.
  const skill = readSkillWithReferences("diaria-video-roteiro");
  it("Passo 5: padrões do texto de tela", () => {
    for (const trecho of ["Só no horizontal.", "Um item por linha", "Sem empresa entre parênteses", "Um box pode cobrir duas falas vizinhas", "Nada que não valha para todo o público da fala"]) {
      assert.ok(skill.includes(trecho), trecho);
    }
  });
  it("Passo 8: regravar só para mudança de sentido, quebra de regra ou fala incompreensível", () => {
    assert.match(skill, /\*\*regravar\*\*, só em três casos: \(a\) mudança de sentido/);
    assert.match(skill, /\(c\) fala incompreensível/);
    assert.match(skill, /diferença de precisão que não muda o que o espectador entende/);
  });
});
