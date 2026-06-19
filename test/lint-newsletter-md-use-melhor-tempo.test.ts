/**
 * lint-newsletter-md-use-melhor-tempo.test.ts (#2372)
 *
 * Regressão: itens USE MELHOR sem estimativa de tempo (`— N min`) devem
 * causar falha do check `--check use-melhor-tempo`. Após adicionar a
 * estimativa, o check deve passar.
 *
 * Testa tanto o helper puro (`checkUseMelhorTempo`) quanto o CLI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  checkUseMelhorTempo,
  USE_MELHOR_TEMPO_RE,
} from "../scripts/lint-newsletter-md.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECTION_HEADER = "**🛠️ USE MELHOR**";

function makeUseMelhorItem(title: string, url: string, desc: string): string {
  return `**[${title}](${url})**\n${desc}\n`;
}

/**
 * Formato CANÔNICO de produção (#2396): link + descrição na MESMA linha.
 * Ex: `**[Título](URL)** Descrição... (5 min)`
 * Validado em 260615–260619 como o formato real de produção.
 */
function makeUseMelhorItemInline(title: string, url: string, desc: string): string {
  return `**[${title}](${url})** ${desc}\n`;
}

function wrapInUseMelhor(items: string): string {
  return `${SECTION_HEADER}\n\n${items}\n---\n`;
}

// ---------------------------------------------------------------------------
// USE_MELHOR_TEMPO_RE
// ---------------------------------------------------------------------------

describe("USE_MELHOR_TEMPO_RE (#2372)", () => {
  // Formato canônico do writer.md:106 — parênteses (default flow / stitch)
  it("casa '(15 min)' (parênteses — formato canônico writer.md)", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Guia prático de ChatGPT (15 min)"));
  });
  it("casa '(30 min)'", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Tutorial de RAG do zero (30 min)"));
  });
  it("casa '(2 min de leitura)'", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Resumo rápido (2 min de leitura)"));
  });
  // Atalho aprovado 260612 — em/en dash
  it("casa '— 5 min'", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Guia prático de ChatGPT — 5 min"));
  });
  it("casa '— 8 min de leitura'", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Tutorial passo a passo — 8 min de leitura"));
  });
  it("casa '— 15 min' (em dash)", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Como criar currículo com IA — 15 min"));
  });
  it("casa '—5min' (sem espaços)", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Tutorial rápido —5min"));
  });
  it("casa en-dash '– 10 min'", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Curso rápido – 10 min"));
  });
  it("NÃO casa '- 5 min' (hyphen sem parênteses)", () => {
    assert.ok(!USE_MELHOR_TEMPO_RE.test("Tutorial - 5 min"));
  });
  it("NÃO casa descrição sem qualquer estimativa", () => {
    assert.ok(!USE_MELHOR_TEMPO_RE.test("Guia completo de ChatGPT para iniciantes"));
  });
  it("NÃO casa '— minutos' sem número", () => {
    assert.ok(!USE_MELHOR_TEMPO_RE.test("Leva alguns — minutos para completar"));
  });
  it("NÃO casa '(min)' sem número", () => {
    assert.ok(!USE_MELHOR_TEMPO_RE.test("Tempo variável (min) por capítulo"));
  });
  // Formatos com tilde — validados em 260616 e 260617/260618 como produção real (#2396)
  it("casa '(~15 min)' (parênteses com tilde — 260616)", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Prompts prontos para e-mail (~15 min)"));
  });
  it("casa '(~20 min)'", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Tutorial completo (~20 min)"));
  });
  it("casa '~10 min' inline (sem parênteses — 260617/260618)", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Casual, ~10 min. Do acesso básico a truques de prompt."));
  });
  it("casa '~40 min' inline", () => {
    assert.ok(USE_MELHOR_TEMPO_RE.test("Tutorial passo a passo para montar um classificador, ~40 min."));
  });
  it("NÃO casa 'Módulos curtos, no seu ritmo.' (sem qualquer estimativa — 260617 item 2)", () => {
    assert.ok(!USE_MELHOR_TEMPO_RE.test("Formação online gratuita de Google, Sebrae, Itaú e Tera. Módulos curtos, no seu ritmo."));
  });
});

// ---------------------------------------------------------------------------
// checkUseMelhorTempo — helper puro
// ---------------------------------------------------------------------------

describe("checkUseMelhorTempo (#2372) — helper puro", () => {
  it("ok=true quando todos os itens têm '— N min'", () => {
    const md = wrapInUseMelhor(
      makeUseMelhorItem(
        "Tutorial ChatGPT",
        "https://example.com/tutorial",
        "Como usar ChatGPT para produtividade no trabalho — 5 min",
      ) +
        "\n" +
        makeUseMelhorItem(
          "Guia Python",
          "https://example.com/python",
          "Getting started com Python para iniciantes — 10 min de leitura",
        ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.errors.length, 0);
    assert.equal(r.checked, 2);
  });

  it("ok=false quando item sem '— N min' (caso regressão #2372)", () => {
    const md = wrapInUseMelhor(
      makeUseMelhorItem(
        "Tutorial ChatGPT",
        "https://example.com/tutorial",
        "Como usar ChatGPT para produtividade no trabalho",
      ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].item, 1);
    assert.match(r.errors[0].excerpt, /Como usar ChatGPT/);
  });

  it("ok=false para múltiplos itens sem tempo", () => {
    const md = wrapInUseMelhor(
      makeUseMelhorItem(
        "Tutorial A",
        "https://example.com/a",
        "Sem estimativa de tempo aqui",
      ) +
        "\n" +
        makeUseMelhorItem(
          "Tutorial B",
          "https://example.com/b",
          "Também sem estimativa — opa, este tem — 3 min",
        ) +
        "\n" +
        makeUseMelhorItem(
          "Tutorial C",
          "https://example.com/c",
          "Outro sem tempo",
        ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, false);
    // Items A e C sem tempo, B tem
    assert.equal(r.errors.length, 2);
    assert.equal(r.checked, 3);
  });

  it("ok=true quando seção USE MELHOR está vazia (sem items)", () => {
    const md = `${SECTION_HEADER}\n\n---\n`;
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 0);
  });

  it("ok=true quando não há seção USE MELHOR no MD", () => {
    const md = "Apenas destaques sem USE MELHOR.";
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 0);
  });

  it("passa após adicionar '— N min' à descrição (regressão fix)", () => {
    const itemSemTempo = makeUseMelhorItem(
      "ChatGPT para iniciantes",
      "https://example.com/chatgpt",
      "Guia passo a passo para usar ChatGPT no trabalho",
    );
    const itemComTempo = makeUseMelhorItem(
      "ChatGPT para iniciantes",
      "https://example.com/chatgpt",
      "Guia passo a passo para usar ChatGPT no trabalho — 7 min",
    );
    const mdSem = wrapInUseMelhor(itemSemTempo);
    const mdCom = wrapInUseMelhor(itemComTempo);

    const rSem = checkUseMelhorTempo(mdSem);
    const rCom = checkUseMelhorTempo(mdCom);

    assert.equal(rSem.ok, false, "deve falhar sem tempo");
    assert.equal(rCom.ok, true, "deve passar com tempo");
  });

  it("header sem emoji: 'USE MELHOR' é reconhecido", () => {
    const md = `**USE MELHOR**\n\n**[Tutorial](https://x.com/t)**\nDescrição sem tempo\n\n---\n`;
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, false);
    assert.equal(r.checked, 1);
  });

  it("ok=true com formato parênteses '(N min)' (output real do stitch + editor)", () => {
    // O writer.md:106 documenta parênteses como formato canônico — o check
    // deve aceitar para não quebrar toda edição do fluxo default.
    const md = wrapInUseMelhor(
      makeUseMelhorItem(
        "Tutorial RAG",
        "https://example.com/rag",
        "Tutorial completo de RAG do zero com LangChain (30 min)",
      ) +
        "\n" +
        makeUseMelhorItem(
          "ChatGPT no trabalho",
          "https://example.com/cg",
          "Como usar ChatGPT para produtividade (5 min de leitura)",
        ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.checked, 2);
  });

  // -------------------------------------------------------------------------
  // Formato CANÔNICO de produção: link+descrição na MESMA linha (#2396)
  // -------------------------------------------------------------------------

  it("formato inline: item COM tempo passa — checked=1 ok=true (#2396 fix)", () => {
    // Linha real de 260619: `**[Título](URL)** desc... (8 min)`
    const md = wrapInUseMelhor(
      makeUseMelhorItemInline(
        "The Art of Loop Engineering",
        "https://www.langchain.com/blog/the-art-of-loop-engineering",
        "O post explora o loop central de agentes de IA, como empilhar e estender loops torna os agentes mais eficazes e como monitorar cada nível com primitivas do LangChain (8 min).",
      ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.checked, 1, "deve contar o item inline (was: checked=0 no-op)");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.errors.length, 0);
  });

  it("formato inline: item SEM tempo é detectado — checked=1 ok=false (#2396 fix)", () => {
    // Linha real de 260617: `**[...Inteligência artificial...]** Formação online... Módulos curtos, no seu ritmo.`
    const md = wrapInUseMelhor(
      makeUseMelhorItemInline(
        "Inteligência artificial nos pequenos negócios",
        "https://www.seudinheiro.com/2026/seu-negocio/ia-pequenos-negocios/",
        "Formação online gratuita de Google, Sebrae, Itaú e Tera para empreendedores. Módulos curtos, no seu ritmo.",
      ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.checked, 1, "deve contar o item sem tempo");
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].item, 1);
    assert.match(r.errors[0].excerpt, /Formação online gratuita/);
  });

  it("formato inline misto: 3 itens, 1 sem tempo — checked=3 errors=1 (#2396)", () => {
    // Simula mix real: 2 com tempo + 1 sem tempo
    const md = wrapInUseMelhor(
      makeUseMelhorItemInline(
        "Tutorial A",
        "https://example.com/a",
        "Descrição com tempo (5 min).",
      ) +
        "\n" +
        makeUseMelhorItemInline(
          "Tutorial B",
          "https://example.com/b",
          "Descrição sem estimativa de leitura aqui.",
        ) +
        "\n" +
        makeUseMelhorItemInline(
          "Tutorial C",
          "https://example.com/c",
          "Outro com tempo — 10 min.",
        ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.checked, 3, "deve contar todos os 3 itens inline");
    assert.equal(r.ok, false);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].item, 2);
  });

  it("formato inline: descrição com bold-leading NÃO é FP (#2396 fix #2)", () => {
    // FP anterior: `**OpenAI** lança... (5 min)` na MESMA linha era tratado como header-bold
    // → "(sem descrição)". Agora: o bold na descrição inline não é FP.
    // No formato 2-linhas: `**[Título](URL)**\n**OpenAI** lança algo (5 min)\n`
    const md = wrapInUseMelhor(
      makeUseMelhorItem(
        "OpenAI Academy",
        "https://openai.com/academy",
        "**OpenAI** lança cursos gratuitos para aplicar IA no trabalho. (5 min)",
      ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.checked, 1, "deve contar o item");
    assert.equal(r.ok, true, `FP: bold-leading na descrição não deve ser '(sem descrição)': ${JSON.stringify(r.errors)}`);
  });

  it("formato inline: (~15 min) e ~10 min inline são aceitos (#2396)", () => {
    // Validado em 260616 e 260617/260618
    const md = wrapInUseMelhor(
      makeUseMelhorItemInline(
        "ChatGPT no trabalho",
        "https://example.com/cg",
        "Prompts prontos para e-mail, resumo de documentos. (~15 min)",
      ) +
        "\n" +
        makeUseMelhorItemInline(
          "Cursor AI",
          "https://example.com/cursor",
          "Dev iniciante, ~8 min. Como usar o modo Agent do Cursor para editar código em linguagem natural.",
        ),
    );
    const r = checkUseMelhorTempo(md);
    assert.equal(r.checked, 2);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });
});

// ---------------------------------------------------------------------------
// CLI --check use-melhor-tempo
// ---------------------------------------------------------------------------

describe("--check use-melhor-tempo CLI (#2372)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("exit 0 quando todos itens têm estimativa de tempo", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-tempo-ok-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = wrapInUseMelhor(
        makeUseMelhorItem(
          "ChatGPT tutorial",
          "https://example.com/cg",
          "Como usar ChatGPT no trabalho — 5 min",
        ),
      );
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "use-melhor-tempo", "--md", mdPath]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 quando item sem estimativa de tempo", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-tempo-fail-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = wrapInUseMelhor(
        makeUseMelhorItem(
          "ChatGPT tutorial",
          "https://example.com/cg",
          "Como usar ChatGPT no trabalho (sem estimativa)",
        ),
      );
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "use-melhor-tempo", "--md", mdPath]);
      assert.equal(r.status, 1, "deve falhar com exit 1");
      assert.match(r.stderr, /use-melhor-tempo/);
      assert.match(r.stderr, /N min/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 sem --md", () => {
    const r = runCli(["--check", "use-melhor-tempo"]);
    assert.equal(r.status, 2);
  });
});
