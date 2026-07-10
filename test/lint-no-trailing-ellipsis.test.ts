/**
 * test/lint-no-trailing-ellipsis.test.ts (#2881)
 *
 * Regressão (#633) do lint `checkNoTrailingEllipsis` +
 * `lint-newsletter-md.ts --check no-trailing-ellipsis` (WARN-ONLY, #2715
 * pattern — mesma convenção de title-publisher-suffix/title-trailing-period).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkNoTrailingEllipsis } from "../scripts/lib/lint-checks/no-trailing-ellipsis.ts";

function radarItem(title: string, description: string): string {
  return `RADAR\n\n[${title}](https://example.com/radar)\n${description}\n`;
}

function useMelhorInline(title: string, description: string): string {
  return `USE MELHOR\n\n**[${title}](https://example.com/tool)** ${description}\n`;
}

describe("checkNoTrailingEllipsis (#2881)", () => {
  // caso (a) — descrição termina em reticência
  it("CASO REAL 260703: flagra descrição RADAR terminando em '…'", () => {
    const md = radarItem(
      "Gestão lança Matriz de Competências em IA",
      "com ênfase em ética, transparência, não-discriminação, segurança e soberania…",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "RADAR");
  });

  it("CASO REAL 260703: flagra descrição RADAR terminando em '...' (ascii)", () => {
    const md = radarItem(
      "AI summaries of Tripadvisor",
      "um hotel processado por casos de intoxicação alimentar em massa foi descrito como...",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });

  it("flagra descrição LANÇAMENTOS terminando em reticência", () => {
    const md =
      "LANÇAMENTOS\n\n[Nova ferramenta de IA generativa](https://example.com/l1)\nA empresa lançou o produto após meses de espera…\n";
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].section, "LANÇAMENTOS");
  });

  it("NÃO flagra item USE MELHOR inline cuja descrição termina corretamente (não em reticência)", () => {
    const md = useMelhorInline(
      "Tutorial de prompt engineering",
      "Aprenda a escrever prompts melhores em poucos minutos (5 min).",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, true);
  });

  it("flagra item USE MELHOR inline cuja descrição termina em reticência", () => {
    const md = useMelhorInline(
      "Tutorial de prompt engineering",
      "Aprenda a escrever prompts melhores em poucos minutos e…",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "USE MELHOR");
  });

  // caso (b) — descrição completa legítima, não deve ser flagrada
  it("NÃO flagra descrição completa e legítima", () => {
    const md = radarItem(
      "Startup brasileira capta rodada Series A",
      "A empresa vai usar o aporte para expandir operações na América Latina.",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  // caso (c) — reticência no MEIO da descrição (uso legítimo), não flagrar
  it("NÃO flagra reticência no MEIO da descrição (uso legítimo)", () => {
    const md = radarItem(
      "Resultado inesperado de pesquisa",
      "Os pesquisadores esperavam um resultado… e tiveram uma surpresa completamente diferente.",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, true);
  });

  it("retorna ok:true para newsletter limpa multi-seção", () => {
    const md = [
      radarItem("Google anuncia novidades no I/O 2026", "Detalhes completos do evento anual."),
      "---",
      "LANÇAMENTOS",
      "",
      "[Nova plataforma de dados abertos](https://example.com/l2)",
      "Iniciativa do governo federal para dados públicos.",
    ].join("\n");
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, true);
  });

  // #2918 bug 2: ANY_SECTION_HEADER_RE não listava É IA? / ERRO INTENCIONAL /
  // SORTEIO / PARA ENCERRAR — se o `---` entre RADAR e um desses headers
  // fosse removido numa edição manual no Drive, `currentSection` ficava
  // "preso" em RADAR e a prosa de encerramento virava falso-positivo com
  // label errado.
  for (const header of ["É IA?", "ERRO INTENCIONAL", "SORTEIO", "PARA ENCERRAR"]) {
    it(`#2918 bug 2: header '${header}' (sem '---' antes) encerra a seção RADAR corretamente`, () => {
      const md = [
        "RADAR",
        "",
        "[Item real do radar](https://example.com/radar)",
        "Descrição completa e legítima.",
        "",
        header,
        "",
        "[Um link qualquer](https://example.com/outro)",
        "Texto fora de escopo que termina em reticência…",
      ].join("\n");
      const result = checkNoTrailingEllipsis(md);
      assert.equal(
        result.ok,
        true,
        `esperava ok:true — '${header}' deve encerrar o scan de RADAR, não deixar 'preso'`,
      );
    });
  }

  // #2918 bug 3: INLINE_LINK_WITH_TEXT_RE excluía `)` do grupo de URL mas não
  // `(` — uma URL com parênteses balanceados (ex: Wikipedia disambiguation)
  // não casava o regex inteiro, o item não era reconhecido, e a reticência
  // final passava despercebida.
  it("#2918 bug 3: reconhece item inline cuja URL tem parênteses balanceados e flagra reticência final", () => {
    const md = [
      "RADAR",
      "",
      "**[Modelo de linguagem](https://en.wikipedia.org/wiki/GPT-4_(disambiguation))** Descrição que termina em reticência…",
    ].join("\n");
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "RADAR");
  });

  // #3196 CASO REAL 260709 — USE MELHOR TikTok: reticência de truncamento fica
  // ANTES do sufixo "(N min)" (estimativa de tempo auto-injetada pelo stitch),
  // então a string "termina" em "(5 min)", não em "…" — sem stripTrailingTimeSuffix
  // o match escapa.
  it("#3196 CASO REAL 260709: flagra reticência ANTES do sufixo (N min) (USE MELHOR TikTok)", () => {
    const md = useMelhorInline(
      "Truque de vídeo no TikTok",
      "Descobri um truque incrível. Sabe quando o rosto sai todo diferente? Então... (5 min)",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "USE MELHOR");
  });

  it("#3196: NÃO flagra quando o sufixo (N min) vem após descrição limpa (sem reticência)", () => {
    const md = useMelhorInline(
      "Tutorial de prompt engineering",
      "Aprenda a escrever prompts melhores em poucos minutos (5 min)",
    );
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, true);
  });

  it("ignora descrição em seção DESTAQUE (fora de escopo)", () => {
    const md = [
      "DESTAQUE 1 | INTELIGÊNCIA ARTIFICIAL",
      "",
      "[Modelo de IA da Meta supera GPT-4 em benchmarks](https://example.com/d1)",
      "",
      "Por que isso importa: o texto do destaque pode legitimamente conter reticência…",
      "",
      "---",
    ].join("\n");
    const result = checkNoTrailingEllipsis(md);
    assert.equal(result.ok, true, "checagem é escopo só de seções secundárias, não de DESTAQUE");
  });
});

describe("lint-newsletter-md.ts CLI --check no-trailing-ellipsis (WARN-ONLY, #2715 pattern)", () => {
  function runLint(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  }

  it("exit 0 (não 1) mesmo com descrição terminando em reticência", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-no-trailing-ellipsis-warnonly-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, radarItem("Título", "Descrição truncada pela fonte…"), "utf8");
      const r = runLint(["--check", "no-trailing-ellipsis", "--md", mdPath]);
      assert.equal(r.status, 0, `esperava exit 0 (WARN-ONLY), obteve ${r.status}. stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, "result.ok deve continuar false — o match ainda é reportado no JSON");
      assert.equal(out.errors.length, 1);
      assert.match(r.stderr, /⚠️/, "stderr deve usar ⚠️ (warning), não ❌");
      assert.doesNotMatch(r.stderr, /❌/, "stderr NÃO deve conter ❌ (não é gate-blocking)");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("exit 0 pra descrição limpa (sem reticência)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-no-trailing-ellipsis-clean-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      writeFileSync(mdPath, radarItem("Título", "Descrição completa e legítima."), "utf8");
      const r = runLint(["--check", "no-trailing-ellipsis", "--md", mdPath]);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.errors.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
