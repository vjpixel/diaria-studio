/**
 * test/prompt-regression-eval.test.ts (#8143)
 *
 * Cobertura da lógica DETERMINÍSTICA de `scripts/lib/prompt-regression-eval.ts`
 * — graders mecânicos, repetição com maioria, comparação pareada, montagem
 * de input/prompt e parsing de custo. Nenhum teste aqui spawna `claude` de
 * verdade — `runAgentRepetitions` é testado com `callClaudeCliFn` injetado
 * (mesmo padrão de `test/holistic-critique.test.ts`/
 * `test/claude-cli-subprocess.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMPT_EVAL_AGENTS,
  isPromptEvalAgent,
  runMechanicalGraders,
  wrapSocialWriterOutputForGrading,
  checkRepetitionConsistency,
  compareBaselineVsCandidate,
  stripAgentFrontmatter,
  readAgentBodyFromDisk,
  readAgentBodyAtGitRef,
  readApprovedHighlight,
  readApprovedHighlightTitles,
  buildWriterDestaqueInput,
  buildSocialWriterInput,
  buildAgentReplayPrompt,
  parseClaudeCliJsonResult,
  runAgentRepetitions,
  verdictsFromOutcomes,
  type GraderVerdict,
} from "../scripts/lib/prompt-regression-eval.ts";

function withTmpDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("isPromptEvalAgent (#8143)", () => {
  it("aceita só writer-destaque e social-writer", () => {
    assert.equal(isPromptEvalAgent("writer-destaque"), true);
    assert.equal(isPromptEvalAgent("social-writer"), true);
    assert.equal(isPromptEvalAgent("writer"), false);
    assert.equal(isPromptEvalAgent(""), false);
  });

  it("PROMPT_EVAL_AGENTS lista exatamente os 2 agents da 1ª fatia", () => {
    assert.deepEqual([...PROMPT_EVAL_AGENTS].sort(), ["social-writer", "writer-destaque"]);
  });
});

describe("stripAgentFrontmatter (#8143)", () => {
  it("remove o bloco YAML entre --- e devolve só o corpo", () => {
    const md = "---\nname: x\nmodel: sonnet\n---\nCorpo do agent aqui.\n";
    assert.equal(stripAgentFrontmatter(md), "Corpo do agent aqui.\n");
  });

  it("sem frontmatter, devolve o texto intacto", () => {
    const md = "Sem frontmatter nenhum.";
    assert.equal(stripAgentFrontmatter(md), md);
  });
});

describe("runMechanicalGraders — banned-lexicon (#7260, agent-agnóstico)", () => {
  it("writer-destaque: acusa 'agentivo' no texto produzido", () => {
    withTmpDir("prompt-eval-grader-", (dir) => {
      const md = "**DESTAQUE 1 | MERCADO**\n\n**[Um título qualquer aqui](https://x.com)**\n\nTexto com comportamento agentivo demais.\n";
      const verdicts = runMechanicalGraders("writer-destaque", md, dir, dir);
      const lexicon = verdicts.find((v) => v.name === "banned-lexicon")!;
      assert.equal(lexicon.evaluable, true);
      assert.equal(lexicon.ok, false);
    });
  });

  it("social-writer: texto limpo passa", () => {
    withTmpDir("prompt-eval-grader-", (dir) => {
      const md = "## d1\n\nTexto agêntico correto, sem a forma banida.\n";
      const verdicts = runMechanicalGraders("social-writer", md, dir, dir);
      const lexicon = verdicts.find((v) => v.name === "banned-lexicon")!;
      assert.equal(lexicon.ok, true);
    });
  });
});

describe("runMechanicalGraders — title-length-52-chars (#8143, checkTitleLengths — desvio deliberado de ScoringFeatureRow, ver docstring do módulo)", () => {
  it("writer-destaque: título curto passa", () => {
    withTmpDir("prompt-eval-title-", (dir) => {
      const md = "**DESTAQUE 1 | MERCADO**\n\n**[Título curto o suficiente](https://x.com)**\n\nBody aqui.\n";
      const verdicts = runMechanicalGraders("writer-destaque", md, dir, dir);
      const title = verdicts.find((v) => v.name === "title-length-52-chars")!;
      assert.equal(title.evaluable, true);
      assert.equal(title.ok, true);
    });
  });

  it("writer-destaque: título >52 chars falha", () => {
    withTmpDir("prompt-eval-title-", (dir) => {
      const longTitle = "Este título aqui é propositalmente longo demais para caber no limite de 52 caracteres exigido";
      const md = `**DESTAQUE 1 | MERCADO**\n\n**[${longTitle}](https://x.com)**\n\nBody aqui.\n`;
      const verdicts = runMechanicalGraders("writer-destaque", md, dir, dir);
      const title = verdicts.find((v) => v.name === "title-length-52-chars")!;
      assert.equal(title.ok, false);
    });
  });

  it("social-writer: grader não-avaliável (não escreve título de destaque)", () => {
    withTmpDir("prompt-eval-title-", (dir) => {
      const verdicts = runMechanicalGraders("social-writer", "## d1\n\nTexto qualquer.\n", dir, dir);
      const title = verdicts.find((v) => v.name === "title-length-52-chars")!;
      assert.equal(title.evaluable, false);
      assert.equal(title.ok, null);
    });
  });
});

describe("wrapSocialWriterOutputForGrading + runMechanicalGraders — carousel-text-overflow (#6078)", () => {
  it("social-writer: 03-social.md ausente no fixture — grader não-avaliável", () => {
    withTmpDir("prompt-eval-carousel-", (dir) => {
      const verdicts = runMechanicalGraders("social-writer", "## d1\n\ntexto\n", dir, dir);
      const carousel = verdicts.find((v) => v.name === "carousel-text-overflow")!;
      assert.equal(carousel.evaluable, false);
    });
  });

  it("writer-destaque: grader não-avaliável (não escreve o corpo do carrossel)", () => {
    withTmpDir("prompt-eval-carousel-", (dir) => {
      const verdicts = runMechanicalGraders("writer-destaque", "**DESTAQUE 1 | X**\n\n**[T](https://x.com)**\n", dir, dir);
      const carousel = verdicts.find((v) => v.name === "carousel-text-overflow")!;
      assert.equal(carousel.evaluable, false);
    });
  });

  it("wrapSocialWriterOutputForGrading envelopa em '# Social' pra extractSection casar", () => {
    const wrapped = wrapSocialWriterOutputForGrading("## d1\n\ncorpo\n");
    assert.ok(wrapped.startsWith("# Social\n\n"));
    assert.ok(wrapped.includes("## d1"));
  });

  it("social-writer com 03-social.md escrito no fixture: grader avaliável, sem overflow em corpo curto", () => {
    withTmpDir("prompt-eval-carousel-", (dir) => {
      const raw = "## d1\n\nParágrafo curto o suficiente pra não estourar o card.\n";
      writeFileSync(join(dir, "03-social.md"), wrapSocialWriterOutputForGrading(raw), "utf8");
      const verdicts = runMechanicalGraders("social-writer", raw, dir, dir);
      const carousel = verdicts.find((v) => v.name === "carousel-text-overflow")!;
      assert.equal(carousel.evaluable, true);
      assert.equal(carousel.ok, true);
    });
  });
});

describe("runMechanicalGraders — newsletter-lint-gate-blocking (runStage2LintReport, best-effort)", () => {
  it("sem _internal/02-draft.md no fixture: não-avaliável, nunca fabricado como ok", () => {
    withTmpDir("prompt-eval-lint-", (dir) => {
      const verdicts = runMechanicalGraders("writer-destaque", "qualquer coisa", dir, dir);
      const lint = verdicts.find((v) => v.name === "newsletter-lint-gate-blocking")!;
      assert.equal(lint.evaluable, false);
      assert.equal(lint.ok, null);
    });
  });
});

describe("checkRepetitionConsistency (#8143 item 4 — mesma disciplina de holistic-critique.ts)", () => {
  function verdict(name: string, ok: boolean): GraderVerdict {
    return { name, evaluable: true, ok };
  }

  it("3 repetições concordantes: consistent=true, agreedOk reflete o valor comum", () => {
    const repetitions = [[verdict("x", true)], [verdict("x", true)], [verdict("x", true)]];
    const result = checkRepetitionConsistency(repetitions);
    assert.equal(result.length, 1);
    assert.equal(result[0].consistent, true);
    assert.equal(result[0].agreedOk, true);
  });

  it("divergência entre repetições: consistent=false, agreedOk=null (NUNCA decide por maioria simples)", () => {
    const repetitions = [[verdict("x", true)], [verdict("x", true)], [verdict("x", false)]];
    const result = checkRepetitionConsistency(repetitions);
    assert.equal(result[0].consistent, false);
    assert.equal(result[0].agreedOk, null);
  });

  it("1 repetição não-avaliável entre 3 já invalida a consistência (mesmo padrão de voto malformado do holistic-critique)", () => {
    const repetitions = [[verdict("x", true)], [{ name: "x", evaluable: false, ok: null }], [verdict("x", true)]];
    const result = checkRepetitionConsistency(repetitions);
    assert.equal(result[0].consistent, false);
    assert.equal(result[0].agreedOk, null);
  });

  it("array vazio de repetições: retorna []", () => {
    assert.deepEqual(checkRepetitionConsistency([]), []);
  });

  it("agrega múltiplos graders por nome, ordenado alfabeticamente", () => {
    const repetitions = [
      [verdict("b", true), verdict("a", false)],
      [verdict("b", true), verdict("a", false)],
    ];
    const result = checkRepetitionConsistency(repetitions);
    assert.deepEqual(result.map((r) => r.name), ["a", "b"]);
  });
});

describe("compareBaselineVsCandidate (#8143 item 3 — sempre pareado, nunca nota isolada)", () => {
  function consistency(name: string, ok: boolean): { name: string; consistent: boolean; agreedOk: boolean | null; runs: (boolean | null)[] } {
    return { name, consistent: true, agreedOk: ok, runs: [ok] };
  }

  it("baseline ok, candidato falha: regressed", () => {
    const deltas = compareBaselineVsCandidate([consistency("x", true)], [consistency("x", false)]);
    assert.equal(deltas[0].verdict, "regressed");
  });

  it("baseline falha, candidato ok: improved", () => {
    const deltas = compareBaselineVsCandidate([consistency("x", false)], [consistency("x", true)]);
    assert.equal(deltas[0].verdict, "improved");
  });

  it("os dois ok: unchanged", () => {
    const deltas = compareBaselineVsCandidate([consistency("x", true)], [consistency("x", true)]);
    assert.equal(deltas[0].verdict, "unchanged");
  });

  it("baseline não convergiu nas repetições: inconclusive, nunca regressed/improved fabricado", () => {
    const deltas = compareBaselineVsCandidate(
      [{ name: "x", consistent: false, agreedOk: null, runs: [true, false] }],
      [consistency("x", true)],
    );
    assert.equal(deltas[0].verdict, "inconclusive");
  });

  it("grader ausente de um dos dois lados: inconclusive", () => {
    const deltas = compareBaselineVsCandidate([consistency("x", true)], []);
    assert.equal(deltas[0].verdict, "inconclusive");
  });
});

describe("readAgentBodyFromDisk / readAgentBodyAtGitRef (#8143)", () => {
  it("readAgentBodyFromDisk lê .claude/agents/{agent}.md e strippa frontmatter", () => {
    withTmpDir("prompt-eval-agentbody-", (dir) => {
      mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
      writeFileSync(join(dir, ".claude", "agents", "writer-destaque.md"), "---\nname: writer-destaque\n---\nCorpo real.\n", "utf8");
      const body = readAgentBodyFromDisk(dir, "writer-destaque");
      assert.equal(body, "Corpo real.\n");
    });
  });

  it("readAgentBodyAtGitRef chama git show com o ref e path corretos, via execFn injetado", () => {
    const calls: Array<{ args: string[]; opts: { cwd: string; encoding: "utf8" } }> = [];
    const execFn = (args: string[], opts: { cwd: string; encoding: "utf8" }) => {
      calls.push({ args, opts });
      return "---\nname: social-writer\n---\nCorpo do master.\n";
    };
    const body = readAgentBodyAtGitRef("/repo", "social-writer", "origin/master", execFn);
    assert.equal(body, "Corpo do master.\n");
    assert.deepEqual(calls[0].args, ["show", "origin/master:.claude/agents/social-writer.md"]);
    assert.equal(calls[0].opts.cwd, "/repo");
  });

  it("readAgentBodyAtGitRef propaga exceção do git (ref/arquivo inexistente) sem fallback silencioso", () => {
    const execFn = () => {
      throw new Error("fatal: path does not exist");
    };
    assert.throws(() => readAgentBodyAtGitRef("/repo", "social-writer", "origin/master", execFn));
  });
});

describe("readApprovedHighlight / readApprovedHighlightTitles (#8143)", () => {
  function writeApproved(dir: string, highlights: unknown[]): string {
    const p = join(dir, "01-approved.json");
    writeFileSync(p, JSON.stringify({ highlights }), "utf8");
    return p;
  }

  it("lê article direto do highlight (shape sem indireção .article)", () => {
    withTmpDir("prompt-eval-approved-", (dir) => {
      const p = writeApproved(dir, [{ url: "https://x.com/1", title: "T1", summary: "S1" }]);
      const article = readApprovedHighlight(p, 1);
      assert.equal(article.url, "https://x.com/1");
      assert.equal(article.title, "T1");
    });
  });

  it("lê article sob .article (indireção usada em highlights reais)", () => {
    withTmpDir("prompt-eval-approved-", (dir) => {
      const p = writeApproved(dir, [{ article: { url: "https://x.com/2", title: "T2" } }]);
      const article = readApprovedHighlight(p, 1);
      assert.equal(article.url, "https://x.com/2");
    });
  });

  it("destaqueIndex fora do array: lança com mensagem explícita", () => {
    withTmpDir("prompt-eval-approved-", (dir) => {
      const p = writeApproved(dir, [{ url: "https://x.com/1", title: "T1" }]);
      assert.throws(() => readApprovedHighlight(p, 3), /highlights\[2\] ausente/);
    });
  });

  it("readApprovedHighlightTitles retorna os títulos na ordem, usando '' pra entrada sem título", () => {
    withTmpDir("prompt-eval-approved-", (dir) => {
      const p = writeApproved(dir, [{ url: "https://x.com/1", title: "T1" }, { article: { url: "https://x.com/2", title: "T2" } }]);
      assert.deepEqual(readApprovedHighlightTitles(p), ["T1", "T2"]);
    });
  });
});

describe("buildWriterDestaqueInput / buildSocialWriterInput (#8143 — payload EXATO do coordenador real)", () => {
  it("writer-destaque: campos batem com o Input documentado em .claude/agents/writer-destaque.md", () => {
    const input = buildWriterDestaqueInput({
      destaqueN: 1,
      article: { url: "https://x.com", title: "Título X", category: "mercado", summary: "resumo" },
      categoryLabel: "MERCADO",
      peerTitles: ["Peer 1", "Peer 2"],
      editionDateIso: "2026-09-16T00:00:00.000Z",
      outPathRel: "_internal/02-d1-draft.md",
      imagePromptOutPathRel: "_internal/02-d1-prompt.md",
    });
    assert.equal(input.destaque_n, 1);
    assert.deepEqual(input.peer_titles, ["Peer 1", "Peer 2"]);
    assert.equal(input.category_label, "MERCADO");
    assert.equal((input.destaque as { url: string }).url, "https://x.com");
    assert.equal(input.out_path, "_internal/02-d1-draft.md");
  });

  it("social-writer: só 2 paths, sem objeto de destaque inline", () => {
    const input = buildSocialWriterInput({ approvedJsonPathRel: "_internal/01-approved.json", outDirRel: "." });
    assert.deepEqual(input, { approved_json_path: "_internal/01-approved.json", out_dir: "." });
  });
});

describe("buildAgentReplayPrompt (#8143)", () => {
  it("inclui o corpo do agent + o input em JSON + instrução de gravar/responder", () => {
    const prompt = buildAgentReplayPrompt("Instrução do agent.", "social-writer", { out_dir: "." });
    assert.ok(prompt.includes("Instrução do agent."));
    assert.ok(prompt.includes('"out_dir": "."'));
    assert.ok(prompt.includes("social-writer.md"));
  });
});

describe("parseClaudeCliJsonResult (#8143 — custo MEDIDO, não estimado)", () => {
  it("soma input+output+cache tokens em subagent_tokens", () => {
    const raw = JSON.stringify({
      usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 10 },
      num_turns: 4,
      duration_ms: 12345,
      result: "texto final",
    });
    const usage = parseClaudeCliJsonResult(raw)!;
    assert.equal(usage.subagent_tokens, 1260);
    assert.equal(usage.tool_uses, 4);
    assert.equal(usage.duration_ms, 12345);
    assert.equal(usage.resultText, "texto final");
  });

  it("JSON malformado: retorna null, nunca fabrica usage zero", () => {
    assert.equal(parseClaudeCliJsonResult("não é json"), null);
  });

  it("campos de usage ausentes: 0 explícito, nunca NaN", () => {
    const usage = parseClaudeCliJsonResult(JSON.stringify({}))!;
    assert.equal(usage.subagent_tokens, 0);
    assert.equal(usage.tool_uses, 0);
    assert.equal(usage.duration_ms, 0);
    assert.equal(usage.resultText, null);
  });
});

describe("runAgentRepetitions (#8143 item 6 — default dry-run NUNCA spawna claude de verdade)", () => {
  it("dry-run: nunca chama callClaudeCliFn, produz N outcomes vazios", () => {
    let calls = 0;
    const outcomes = runAgentRepetitions({
      agent: "social-writer",
      agentBody: "corpo",
      input: {},
      cwd: "/tmp/x",
      producedFileAbsPath: "/tmp/x/out.md",
      editionDirForGrading: "/tmp/x",
      rootDir: "/repo",
      repetitions: 3,
      dryRun: true,
      callClaudeCliFn: () => {
        calls++;
        return "{}";
      },
    });
    assert.equal(calls, 0);
    assert.equal(outcomes.length, 3);
    assert.ok(outcomes.every((o) => o.dryRun === true && o.verdicts.length === 0 && o.usage === null));
  });

  it("live (injetado): chama callClaudeCliFn N vezes, lê o arquivo produzido, roda graders e parseia usage", () => {
    withTmpDir("prompt-eval-live-", (dir) => {
      const producedPath = join(dir, "out.md");
      let calls = 0;
      const outcomes = runAgentRepetitions({
        agent: "social-writer",
        agentBody: "corpo do agent",
        input: { out_dir: "." },
        cwd: dir,
        producedFileAbsPath: producedPath,
        editionDirForGrading: dir,
        rootDir: dir,
        repetitions: 2,
        dryRun: false,
        callClaudeCliFn: (_prompt, opts) => {
          calls++;
          assert.equal(opts.outputFormat, "json");
          writeFileSync(producedPath, "## d1\n\nTexto curto, sem overflow.\n", "utf8");
          return JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 }, num_turns: 2, duration_ms: 500, result: "ok" });
        },
      });
      assert.equal(calls, 2);
      assert.equal(outcomes.length, 2);
      for (const o of outcomes) {
        assert.equal(o.dryRun, false);
        assert.ok(o.rawText?.includes("## d1"));
        assert.equal(o.usage?.subagent_tokens, 120);
        assert.ok(o.verdicts.some((v) => v.name === "banned-lexicon"));
      }
    });
  });

  it("verdictsFromOutcomes filtra fora as repetições dry-run", () => {
    const outcomes = runAgentRepetitions({
      agent: "social-writer",
      agentBody: "corpo",
      input: {},
      cwd: "/tmp/x",
      producedFileAbsPath: "/tmp/x/out.md",
      editionDirForGrading: "/tmp/x",
      rootDir: "/repo",
      repetitions: 2,
      dryRun: true,
    });
    assert.deepEqual(verdictsFromOutcomes(outcomes), []);
  });
});
