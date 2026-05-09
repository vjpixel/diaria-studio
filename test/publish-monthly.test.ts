import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  // Pure rendering / parsing
  escHtml,
  stripBackslashEscapes,
  renderInline,
  renderParagraphs,
  renderDestaque,
  renderIntro,
  renderLaboratorio,
  renderClarice,
  renderOutrasNoticias,
  eiaEditionFromYymm,
  normalizeLabel,
  parseHeaderChunk,
  isSectionLabel,
  splitByLabels,
  draftToEmail,
  wrapEmail,
  // CLI
  parseArgs,
} from "../scripts/publish-monthly.ts";

/**
 * Cobertura de teste pro publish-monthly.ts (#1024).
 *
 * Foco: funções puras (parser + rendering) + parseArgs (validação CLI).
 * Brevo API helpers + main() ficam fora do escopo (precisariam mock infra
 * de fetch). Issue #1024 documenta esse trade-off.
 */

// ─── normalizeLabel ─────────────────────────────────────────────────────────

describe("normalizeLabel", () => {
  it("strip `**` em volta", () => {
    assert.equal(normalizeLabel("**ASSUNTO**"), "ASSUNTO");
  });

  it("strip `\\[` `\\]` escapados (Drive markdown)", () => {
    assert.equal(normalizeLabel("**\\[INTRO\\]**"), "INTRO");
  });

  it("strip brackets simples também (sem backslash)", () => {
    assert.equal(normalizeLabel("**[CLARICE — DIVULGAÇÃO]**"), "CLARICE — DIVULGAÇÃO");
  });

  it("não toca em label sem formatação", () => {
    assert.equal(normalizeLabel("OUTRAS NOTÍCIAS DO MÊS"), "OUTRAS NOTÍCIAS DO MÊS");
  });

  it("trim whitespace", () => {
    assert.equal(normalizeLabel("  **ASSUNTO**  "), "ASSUNTO");
  });
});

// ─── isSectionLabel ─────────────────────────────────────────────────────────

describe("isSectionLabel", () => {
  it("reconhece labels canônicos com bold", () => {
    assert.equal(isSectionLabel("**ASSUNTO**"), true);
    assert.equal(isSectionLabel("**PREVIEW**"), true);
    assert.equal(isSectionLabel("**INTRO**"), true);
    assert.equal(isSectionLabel("**APRESENTAÇÃO**"), true);
    assert.equal(isSectionLabel("**OUTRAS NOTÍCIAS DO MÊS**"), true);
    assert.equal(isSectionLabel("**É IA?**"), true);
    assert.equal(isSectionLabel("**ENCERRAMENTO**"), true);
    assert.equal(isSectionLabel("**PARA ENCERRAR**"), true);
    assert.equal(isSectionLabel("**LABORATÓRIO CLARICE**"), true);
  });

  it("reconhece DESTAQUE com formato Drive (\\[N\\] TEMA)", () => {
    assert.equal(isSectionLabel("**\\[DESTAQUE 1\\] ANTHROPIC**"), true);
    assert.equal(isSectionLabel("**\\[DESTAQUE 99\\] FOO**"), true);
  });

  it("reconhece labels com brackets escapados", () => {
    assert.equal(isSectionLabel("**\\[REMETENTE\\]**"), true);
    assert.equal(isSectionLabel("**\\[INTRO\\]**"), true);
  });

  it("rejeita texto comum", () => {
    assert.equal(isSectionLabel("Esta é uma frase normal."), false);
    assert.equal(isSectionLabel("**bold no meio do texto**"), false);
    assert.equal(isSectionLabel("DESTAQUE 1 sem bold"), false);
  });

  it("rejeita linha vazia", () => {
    assert.equal(isSectionLabel(""), false);
    assert.equal(isSectionLabel("   "), false);
  });
});

// ─── splitByLabels ──────────────────────────────────────────────────────────

describe("splitByLabels", () => {
  it("separa draft em sections por section label", () => {
    const text = `**ASSUNTO**

Subject text

**PREVIEW**

Preview text

**INTRO**

Intro text`;
    const sections = splitByLabels(text);
    assert.equal(sections.length, 3);
    assert.match(sections[0], /^\*\*ASSUNTO\*\*/);
    assert.match(sections[1], /^\*\*PREVIEW\*\*/);
    assert.match(sections[2], /^\*\*INTRO\*\*/);
  });

  it("strip `---` residuais (horizontal rules de markdown)", () => {
    const text = `**ASSUNTO**

Subject

---

**PREVIEW**

Preview`;
    const sections = splitByLabels(text);
    assert.equal(sections.length, 2);
    assert.ok(!sections[0].includes("---"), "Não deve manter --- na seção");
  });

  it("agrupa conteúdo entre labels com a label que vem antes", () => {
    const text = `**INTRO**

Linha 1
Linha 2

**DESTAQUE 1**`;
    const sections = splitByLabels(text);
    assert.equal(sections.length, 2);
    assert.match(sections[0], /Linha 1/);
    assert.match(sections[0], /Linha 2/);
  });
});

// ─── escHtml + stripBackslashEscapes + renderInline ─────────────────────────

describe("escHtml", () => {
  it("escapa caracteres HTML especiais", () => {
    assert.equal(escHtml("a < b > c & d \" e"), "a &lt; b &gt; c &amp; d &quot; e");
  });

  it("não toca em texto plano", () => {
    assert.equal(escHtml("Olá, mundo!"), "Olá, mundo!");
  });
});

describe("stripBackslashEscapes", () => {
  it("strip `\\!`, `\\&`, `\\[`, `\\]`", () => {
    assert.equal(stripBackslashEscapes("Amei\\!"), "Amei!");
    assert.equal(stripBackslashEscapes("J\\&J"), "J&J");
    assert.equal(stripBackslashEscapes("\\[texto\\]"), "[texto]");
  });

  it("não strip outros backslashes", () => {
    assert.equal(stripBackslashEscapes("path\\to\\file"), "path\\to\\file");
  });
});

describe("renderInline", () => {
  it("converte `[texto](url)` em <a>", () => {
    const out = renderInline("Veja [aqui](https://example.com).");
    assert.match(out, /<a href="https:\/\/example\.com"/);
    assert.match(out, />aqui<\/a>/);
  });

  it("converte `**bold**` em <strong>", () => {
    assert.match(renderInline("texto **forte** aqui"), /<strong>forte<\/strong>/);
  });

  it("escapa caracteres HTML em texto não-link", () => {
    assert.match(renderInline("a < b & c"), /a &lt; b &amp; c/);
  });

  it("strippa backslash escapes antes de escapar HTML", () => {
    // \& deve virar & (puro), depois &amp; (escapado)
    assert.match(renderInline("J\\&J caso"), /J&amp;J caso/);
    assert.doesNotMatch(renderInline("J\\&J caso"), /J\\&amp/);
  });

  it("preserva URL com & em link", () => {
    const out = renderInline("[link](https://x.com?a=1&b=2)");
    assert.match(out, /href="https:\/\/x\.com\?a=1&amp;b=2"/);
  });
});

// ─── renderParagraphs ──────────────────────────────────────────────────────

describe("renderParagraphs", () => {
  it("renderiza paragráfos como <p>", () => {
    const out = renderParagraphs("Para 1.\n\nPara 2.");
    assert.match(out, /<p[^>]*>Para 1\.<\/p>/);
    assert.match(out, /<p[^>]*>Para 2\.<\/p>/);
  });

  it("detecta lista com `- ` e renderiza como <ul>", () => {
    const out = renderParagraphs("- item 1\n- item 2");
    assert.match(out, /<ul/);
    assert.match(out, /<li[^>]*>item 1<\/li>/);
    assert.match(out, /<li[^>]*>item 2<\/li>/);
  });

  it("detecta lista numerada e renderiza como <ol>", () => {
    const out = renderParagraphs("1. primeiro\n2. segundo");
    assert.match(out, /<ol/);
    assert.match(out, /<li[^>]*>primeiro<\/li>/);
    assert.match(out, /<li[^>]*>segundo<\/li>/);
  });

  it("trata blocos mistos (parágrafo + lista) corretamente", () => {
    const out = renderParagraphs("Acesse:\n\n- link 1\n- link 2");
    assert.match(out, /<p[^>]*>Acesse:<\/p>/);
    assert.match(out, /<ul/);
  });
});

// ─── parseHeaderChunk ──────────────────────────────────────────────────────

describe("parseHeaderChunk", () => {
  it("extrai ASSUNTO numerado (formato antigo)", () => {
    const r = parseHeaderChunk("ASSUNTO\n\n1. Subject A\n2. Subject B");
    assert.equal(r.subjectOptions.length, 2);
    assert.equal(r.subjectOptions[0], "Subject A");
  });

  it("ASSUNTO sem numeração: trata como subject único", () => {
    const r = parseHeaderChunk("ASSUNTO\n\nMy single subject");
    assert.equal(r.subjectOptions.length, 1);
    assert.equal(r.subjectOptions[0], "My single subject");
  });

  it("extrai PREVIEW", () => {
    const r = parseHeaderChunk("ASSUNTO\nSubj\nPREVIEW\nMy preview text");
    assert.equal(r.preview, "My preview text");
  });

  it("extrai INTRO", () => {
    const r = parseHeaderChunk("ASSUNTO\nS\nPREVIEW\nP\nINTRO\nIntro body");
    assert.equal(r.intro, "Intro body");
  });

  it("aceita labels com bold (Drive markdown)", () => {
    const r = parseHeaderChunk("**ASSUNTO**\nMeu subject");
    assert.equal(r.subjectOptions[0], "Meu subject");
  });

  it("aceita labels com brackets escapados", () => {
    const r = parseHeaderChunk("**\\[ASSUNTO\\]**\nSubj from Drive");
    assert.equal(r.subjectOptions[0], "Subj from Drive");
  });
});

// ─── renderDestaque ────────────────────────────────────────────────────────

describe("renderDestaque", () => {
  it("formato antigo `DESTAQUE 1 | ANTHROPIC` extrai tema", () => {
    const chunk = "DESTAQUE 1 | ANTHROPIC\n\n**Título do destaque**\n\nParágrafo 1.";
    const out = renderDestaque(chunk);
    assert.match(out, />ANTHROPIC</);
    assert.match(out, /Título do destaque/);
    assert.doesNotMatch(out, /\*\*/, "não deve ter ** literal");
  });

  it("formato Drive `\\[DESTAQUE 1\\] ANTHROPIC` extrai tema", () => {
    const chunk = "**\\[DESTAQUE 2\\] BRASIL**\n\n**Título**\n\nBody.";
    const out = renderDestaque(chunk);
    assert.match(out, />BRASIL</);
  });

  it("renderiza `O fio condutor:` como pull-quote separado", () => {
    const chunk = "DESTAQUE 1 | TEMA\n\nTitle\n\nMain para.\n\nO fio condutor: Insight final.";
    const out = renderDestaque(chunk);
    assert.match(out, /Insight final\./);
    assert.match(out, /font-style:italic/, "fio condutor deve ter estilo italic");
  });

  it("override de tema funciona (uso em LABORATÓRIO CLARICE)", () => {
    const chunk = "WHATEVER\n\nTitle\n\nBody.";
    const out = renderDestaque(chunk, "OVERRIDE LABEL");
    assert.match(out, />OVERRIDE LABEL</);
  });
});

// ─── renderIntro ───────────────────────────────────────────────────────────

describe("renderIntro", () => {
  it("renderiza com label 'Resumo do mês' em teal", () => {
    const out = renderIntro("Sumário do mês foi assim.");
    assert.match(out, /Resumo do mês/i);
    assert.match(out, /#00A0A0/, "label deve ser teal");
  });

  it("renderiza body em italic 19px", () => {
    const out = renderIntro("Sumário.");
    assert.match(out, /font-style:italic/);
    assert.match(out, /font-size:19px/);
  });

  it("renderiza com border-left teal", () => {
    const out = renderIntro("Sumário.");
    assert.match(out, /border-left:4px solid #00A0A0/);
  });
});

// ─── renderLaboratorio ─────────────────────────────────────────────────────

describe("renderLaboratorio", () => {
  it("renderiza caixa com border dashed", () => {
    const chunk = "LABORATÓRIO CLARICE\n\n**Subtítulo**\n\nPara.\n\n1. Item 1\n2. Item 2\n\nFim.";
    const out = renderLaboratorio(chunk);
    assert.match(out, /border:2px dashed/);
    assert.match(out, /LABORATÓRIO CLARICE/);
  });

  it("renderiza subtítulo como h3 (não h2)", () => {
    const chunk = "LABORATÓRIO CLARICE\n\n**Editar texto**\n\nPara.";
    const out = renderLaboratorio(chunk);
    assert.match(out, /<h3[^>]*>Editar texto<\/h3>/);
  });

  it("renderiza lista numerada como <ol>", () => {
    const chunk = "LABORATÓRIO CLARICE\n\n**Subtítulo**\n\n1. Primeiro\n2. Segundo\n3. Terceiro";
    const out = renderLaboratorio(chunk);
    assert.match(out, /<ol/);
    assert.match(out, /<li[^>]*>Primeiro<\/li>/);
    assert.match(out, /<li[^>]*>Terceiro<\/li>/);
  });

  it("renderiza paragráfos não-lista normalmente", () => {
    const chunk = "LABORATÓRIO CLARICE\n\n**Sub**\n\nIsso é um parágrafo.";
    const out = renderLaboratorio(chunk);
    assert.match(out, /<p[^>]*>Isso é um parágrafo\.<\/p>/);
  });
});

// ─── renderOutrasNoticias ──────────────────────────────────────────────────

describe("renderOutrasNoticias", () => {
  it("renderiza items com link como bold + descrição", () => {
    const chunk = `OUTRAS NOTÍCIAS DO MÊS

[Título 1](https://x.com)

Descrição do primeiro item.

[Título 2](https://y.com)

Descrição do segundo item.`;
    const out = renderOutrasNoticias(chunk);
    assert.match(out, /Outras Notícias do Mês/);
    assert.match(out, /<a href="https:\/\/x\.com"[^>]*>Título 1<\/a>/);
    assert.match(out, /Descrição do primeiro item\./);
    assert.match(out, /<a href="https:\/\/y\.com"[^>]*>Título 2<\/a>/);
  });
});

// ─── eiaEditionFromYymm ────────────────────────────────────────────────────

describe("eiaEditionFromYymm", () => {
  it("último dia do mês: 30 de abril (260430)", () => {
    assert.equal(eiaEditionFromYymm("2604"), "260430");
  });

  it("último dia: 31 de janeiro (260131)", () => {
    assert.equal(eiaEditionFromYymm("2601"), "260131");
  });

  it("fevereiro não-bissexto (250228)", () => {
    assert.equal(eiaEditionFromYymm("2502"), "250228");
  });

  it("fevereiro bissexto (240229)", () => {
    assert.equal(eiaEditionFromYymm("2402"), "240229");
  });
});

// ─── parseArgs ─────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  // Helper pra capturar process.exit calls durante testes (parseArgs chama
  // exit em validation errors).
  function withMockedExit(fn: () => void): { exitCode: number | null; stderr: string } {
    let exitCode: number | null = null;
    let stderr = "";
    const realExit = process.exit;
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error mocking
    process.exit = (code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__mocked_exit__");
    };
    process.stderr.write = ((data: string) => {
      stderr += data;
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__mocked_exit__") throw e;
    } finally {
      process.exit = realExit;
      process.stderr.write = realStderrWrite;
    }
    return { exitCode, stderr };
  }

  it("básico: --yymm 2604", () => {
    const r = parseArgs(["--yymm", "2604"]);
    assert.equal(r.yymm, "2604");
    assert.equal(r.sendTest, false);
    assert.equal(r.sendNow, false);
    assert.equal(r.dryRun, false);
  });

  it("--list-id N", () => {
    const r = parseArgs(["--yymm", "2604", "--list-id", "9"]);
    assert.equal(r.listIdOverride, 9);
  });

  it("--list-id rejeita não-positivo", () => {
    const { exitCode, stderr } = withMockedExit(() => {
      parseArgs(["--yymm", "2604", "--list-id", "-1"]);
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /--list-id inválido/);
  });

  it("--send-test-to valida formato de email", () => {
    const ok = parseArgs(["--yymm", "2604", "--send-test", "--send-test-to", "x@y.com"]);
    assert.equal(ok.sendTestTo, "x@y.com");

    const { exitCode, stderr } = withMockedExit(() => {
      parseArgs(["--yymm", "2604", "--send-test", "--send-test-to", "not-an-email"]);
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /--send-test-to inválido/);
  });

  it("--schedule-at aceita ISO futuro", () => {
    const future = "2099-01-01T00:00:00Z";
    const r = parseArgs(["--yymm", "2604", "--schedule-at", future]);
    assert.match(r.scheduleAt!, /^2099-01-01/);
  });

  it("--schedule-at rejeita ISO no passado", () => {
    const { exitCode, stderr } = withMockedExit(() => {
      parseArgs(["--yymm", "2604", "--schedule-at", "2020-01-01T00:00:00Z"]);
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /deve estar no futuro/);
  });

  it("--schedule-at rejeita string inválida", () => {
    const { exitCode, stderr } = withMockedExit(() => {
      parseArgs(["--yymm", "2604", "--schedule-at", "bobagem"]);
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /não é ISO 8601/);
  });

  it("--update-existing aceita inteiro positivo", () => {
    const r = parseArgs(["--yymm", "2604", "--update-existing", "42"]);
    assert.equal(r.updateExisting, 42);
  });

  it("--update-existing rejeita não-positivo", () => {
    const { exitCode } = withMockedExit(() => {
      parseArgs(["--yymm", "2604", "--update-existing", "0"]);
    });
    assert.equal(exitCode, 1);
  });

  it("--yymm obrigatório", () => {
    const { exitCode } = withMockedExit(() => {
      parseArgs(["--send-test"]);
    });
    assert.equal(exitCode, 1);
  });

  it("--yymm formato YYMM (4 dígitos)", () => {
    const { exitCode } = withMockedExit(() => {
      parseArgs(["--yymm", "260408"]); // 6 dígitos, formato AAMMDD
    });
    assert.equal(exitCode, 1);
  });

  // Nota: --send-test-to sem --send-test é validado em main(), não em parseArgs.
  // parseArgs aceita o flag isolado e armazena em sendTestTo; main() rejeita.
  it("--send-test-to isolado é parseado mas main() rejeita (validação separada)", () => {
    const r = parseArgs(["--yymm", "2604", "--send-test-to", "x@y.com"]);
    assert.equal(r.sendTestTo, "x@y.com");
    assert.equal(r.sendTest, false);
    // Validação cruzada acontece em main(), não em parseArgs.
  });
});

// ─── wrapEmail ─────────────────────────────────────────────────────────────

describe("wrapEmail", () => {
  it("retorna HTML doctype + estrutura básica", () => {
    const out = wrapEmail("Test Subject", ["<p>body 1</p>"]);
    assert.match(out, /<!DOCTYPE html/);
    assert.match(out, /<html xmlns/);
    assert.match(out, /<title>Test Subject<\/title>/);
    assert.match(out, /<p>body 1<\/p>/);
  });

  it("escapa caracteres HTML no subject", () => {
    const out = wrapEmail("A & B < C", []);
    assert.match(out, /<title>A &amp; B &lt; C<\/title>/);
  });

  it("junta múltiplos bodyParts com divider entre eles", () => {
    const out = wrapEmail("S", ["<p>parte 1</p>", "<p>parte 2</p>"]);
    assert.match(out, /<p>parte 1<\/p>/);
    assert.match(out, /<p>parte 2<\/p>/);
    // Divider tem hr inside
    const dividerMatches = out.match(/<hr style="border:none;border-top:1px solid #e0e0e0;"/g);
    assert.equal(dividerMatches?.length, 1, "Esperava 1 divider entre 2 parts");
  });

  it("zero bodyParts produz HTML válido (só wrapper, sem body)", () => {
    const out = wrapEmail("S", []);
    assert.match(out, /<title>S<\/title>/);
    assert.match(out, /<\/html>/);
  });

  it("é mobile-friendly (viewport meta + max-width 600)", () => {
    const out = wrapEmail("S", []);
    assert.match(out, /name="viewport"/);
    assert.match(out, /max-width:600px/);
  });
});

// ─── draftToEmail (integration de pure functions) ──────────────────────────

describe("draftToEmail", () => {
  const mkDraft = (sections: string) => sections.trim();

  it("draft mínimo com ASSUNTO + PREVIEW", () => {
    const draft = mkDraft(`**ASSUNTO**

Meu Subject

**PREVIEW**

Meu preview`);
    const r = draftToEmail(draft, null, "2604");
    assert.equal(r.subject, "Meu Subject");
    assert.equal(r.previewText, "Meu preview");
  });

  it("chosenSubject sobrescreve subject do draft", () => {
    const draft = mkDraft(`**ASSUNTO**\nIgnore-me\n**PREVIEW**\nP`);
    const r = draftToEmail(draft, "Forced subject", "2604");
    assert.equal(r.subject, "Forced subject");
  });

  it("REMETENTE é skipped (não vai pro corpo)", () => {
    const draft = mkDraft(`**REMETENTE**

ti@clarice.ai

**ASSUNTO**

Subj

**PREVIEW**

P`);
    const r = draftToEmail(draft, null, "2604");
    assert.doesNotMatch(r.html, /ti@clarice\.ai/);
  });

  it("LABORATÓRIO CLARICE renderiza via renderLaboratorio (caixa + h3)", () => {
    const draft = mkDraft(`**ASSUNTO**

S

**PREVIEW**

P

**LABORATÓRIO CLARICE**

**Tutorial sub**

Texto do lab.`);
    const r = draftToEmail(draft, null, "2604");
    assert.match(r.html, /<h3[^>]*>Tutorial sub<\/h3>/);
    assert.match(r.html, /border:2px dashed/);
  });

  it("INTRO renderiza com label 'Resumo do mês'", () => {
    const draft = mkDraft(`**ASSUNTO**\nS\n**PREVIEW**\nP\n**INTRO**\nSumário aqui.`);
    const r = draftToEmail(draft, null, "2604");
    assert.match(r.html, /Resumo do mês/i);
  });

  it("PARA ENCERRAR alias de ENCERRAMENTO", () => {
    const draft = mkDraft(`**ASSUNTO**\nS\n**PREVIEW**\nP\n**PARA ENCERRAR**\n\nFim da edição.`);
    const r = draftToEmail(draft, null, "2604");
    assert.match(r.html, /Fim da edição/);
  });
});
