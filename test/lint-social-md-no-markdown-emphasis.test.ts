/**
 * test/lint-social-md-no-markdown-emphasis.test.ts (#6862)
 *
 * Regra `no_markdown_emphasis` — nenhuma plataforma social renderiza
 * markdown, então `**bold**`/`__bold__`/`*italic*`/`_italic_` saindo literal
 * é sempre defeito. Cobre a função pura, o wiring `--check` do CLI, o wiring
 * GATE-BLOCKING no agregador de Stage 4, e — o ponto central da issue —
 * confirma que o carrossel (que lê o MESMO 03-social.md) segue preservando
 * o negrito, porque não passa por este lint nem pela sanitização de
 * publicação.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintNoMarkdownEmphasis } from "../scripts/lib/social-lint-rules.ts";
import { runStage4SocialLintReport } from "../scripts/lint-social-md.ts";
import { extractSection, extractDestaqueBlock } from "../scripts/lib/extract-section.ts";

describe("lintNoMarkdownEmphasis (#6862, GATE-BLOCKING)", () => {
  it("texto sem ênfase -> ok:true, sem matches", () => {
    const md = "# Social\n\n## d1\n\nUm texto qualquer sem marcação nenhuma, bem longo pra passar em outros lints.\n";
    const result = lintNoMarkdownEmphasis(md);
    assert.equal(result.ok, true);
    assert.deepEqual(result.matches, []);
  });

  it("#6862 caso real: **bold** em ## d1 -> ok:false, nomeia a linha", () => {
    const md = "# Social\n\n## d1\n\n**Por que isso importa:** o atacante assume um papel.\n";
    const result = lintNoMarkdownEmphasis(md);
    assert.equal(result.ok, false);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].line, 5);
    assert.ok(result.matches[0].context.includes("Por que isso importa"));
  });

  it("múltiplos destaques com ênfase -> 1 match por linha afetada", () => {
    const md = "# Social\n\n## d1\n\n**negrito** em d1.\n\n## d2\n\ntexto limpo em d2.\n\n## d3\n\n_itálico_ em d3.\n";
    const result = lintNoMarkdownEmphasis(md);
    assert.equal(result.ok, false);
    assert.equal(result.matches.length, 2);
  });

  it("não flaga asterisco/underscore legítimo no meio de palavra", () => {
    const md = "# Social\n\n## d1\n\nO campo se chama user_name e o resultado é 3*4=12.\n";
    const result = lintNoMarkdownEmphasis(md);
    assert.equal(result.ok, true);
  });
});

describe("lint-social-md.ts --check no-markdown-emphasis (CLI, #6862)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "diaria-6862-"));

  it("exit 1 + JSON com matches quando há ênfase", () => {
    const path = join(tmpDir, "com-enfase.md");
    writeFileSync(path, "# Social\n\n## d1\n\n**bold** literal aqui.\n");
    const result = spawnSync("npx", ["tsx", "scripts/lint-social-md.ts", "--check", "no-markdown-emphasis", "--md", path], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.equal(result.status, 1, `esperava exit 1, veio ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.matches.length, 1);
  });

  it("exit 0 quando não há ênfase", () => {
    const path = join(tmpDir, "sem-enfase.md");
    writeFileSync(path, "# Social\n\n## d1\n\ntexto limpo sem marcação nenhuma.\n");
    const result = spawnSync("npx", ["tsx", "scripts/lint-social-md.ts", "--check", "no-markdown-emphasis", "--md", path], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.equal(result.status, 0, `esperava exit 0, veio ${result.status}. stderr: ${result.stderr}`);
  });

  after(() => rmSync(tmpDir, { recursive: true, force: true }));
});

describe("runStage4SocialLintReport — no-markdown-emphasis é GATE-BLOCKING (#6862)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "diaria-6862-stage4-"));

  it("edição com ** em algum destaque -> passed:false, check no-markdown-emphasis presente e reprovado", () => {
    writeFileSync(
      join(tmpDir, "03-social.md"),
      "# Social\n\n## d1\n\n**Por que isso importa:** frase qualquer bem longa pra passar em outros checks do gate.\n\n## d2\n\ntexto limpo em d2, também longo o bastante.\n\n## d3\n\ntexto limpo em d3, idem.\n\n## post_pixel\n\n{outros_count} novidades em {edition_url}.\n",
    );
    const report = runStage4SocialLintReport(tmpDir);
    const check = report.checks.find((c) => c.id === "no-markdown-emphasis");
    assert.ok(check, "check no-markdown-emphasis deveria estar presente no relatório");
    assert.equal(check!.ok, false);
    assert.equal(check!.severity, "gate-blocking");
    assert.equal(report.passed, false, "gate inteiro deve reprovar quando um check gate-blocking falha");
  });

  after(() => rmSync(tmpDir, { recursive: true, force: true }));
});

describe("#6862 — carrossel PRESERVA o negrito (o ponto central da issue)", () => {
  it("gen-carousel-cards.ts lê o mesmo 03-social.md via extractDestaqueBlock, sem passar pelo strip/lint — ** chega intacto no texto que vira card", () => {
    // Mesma extração que scripts/gen-carousel-cards.ts usa (extractSection +
    // extractDestaqueBlock, sem nenhuma chamada a stripMarkdownEmphasis nem
    // a lintNoMarkdownEmphasis no caminho) — reproduzido aqui em vez de
    // importar gen-carousel-cards.ts inteiro (que teria efeitos colaterais
    // de renderização de imagem fora do escopo deste teste).
    const md = "# Social\n\n## d1\n\n**Por que isso importa:** o negrito tem que sobreviver aqui.\n";
    const section = extractSection(md, "Social");
    assert.ok(section, "seção Social deveria existir");
    const dText = extractDestaqueBlock(section!, "d1");
    assert.ok(dText, "destaque d1 deveria existir");
    assert.ok(
      dText!.includes("**Por que isso importa:**"),
      `o carrossel deve receber o ** intacto, veio: ${JSON.stringify(dText)}`,
    );
  });
});
