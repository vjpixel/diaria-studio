/**
 * test/token-reduction-3453-3454.test.ts (#3453 + #3454)
 *
 * Trava os cortes de token do overnight (#3453) e do develop (#3454):
 *   - overnight coordenador roda `claude-sonnet-5-5`/`medium` (histórico:
 *     xhigh→high→medium/sonnet→opus-5-5/low no #8941→sonnet-5-5/medium no #9530);
 *   - develop pina `model: claude-opus-5-5` + `effort: medium` (antes não
 *     pinava nada; #8941 trocou o modelo de sonnet, manteve o racional de
 *     effort moderado);
 *   - checklist de dispatch compartilhado (`context/overnight-dispatch-rules.md`)
 *     existe e é citado pelas duas skills (dedup do boilerplate, #3453 Rec 4 /
 *     #3454 Rec 2);
 *   - instrumentação de token do coordenador presente nas duas skills (#3453
 *     Rec 1 / #3454 Rec 1);
 *   - heurística de agrupamento mais agressiva (baixo-risco/baixo-blast-radius)
 *     no overnight (#3453 Rec 3).
 *
 * Não testa comportamento do LLM (SKILL.md é prompt); testa presença/ausência
 * de strings no texto-fonte, como overnight-skill-coordinator-model-report.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERNIGHT = resolve(ROOT, ".claude/skills/diaria-overnight/SKILL.md");
const DEVELOP = resolve(ROOT, ".claude/skills/diaria-develop/SKILL.md");
const DISPATCH_RULES = resolve(ROOT, "context/overnight-dispatch-rules.md");

const overnight = readFileSync(OVERNIGHT, "utf8");
const develop = readFileSync(DEVELOP, "utf8");

/** Frontmatter YAML entre os dois primeiros `---` do arquivo. */
function frontmatter(content: string): string {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "arquivo deve ter frontmatter delimitado por ---");
  return m![1];
}

describe("#3453/#5306/#8941/#9530 — overnight: coordenador em claude-sonnet-5-5/medium (histórico: xhigh→high→medium→opus-5-5/low→sonnet-5-5/medium)", () => {
  it("frontmatter fixa model: claude-sonnet-5-5 + effort: medium (#9530)", () => {
    const fm = frontmatter(overnight);
    assert.match(fm, /^model:\s*claude-sonnet-5-5\s*$/m, "model deve ser claude-sonnet-5-5 (#9530)");
    assert.match(fm, /^effort:\s*medium\s*$/m, "effort deve ser medium (#9530)");
    assert.doesNotMatch(fm, /^model:\s*sonnet\s*$/m, "alias sonnet não — pin por ID (#9003)");
  });

  it("prosa documenta a troca de modelo citando #8941 e #9530", () => {
    assert.match(overnight, /#8941/);
    assert.match(overnight, /#9530/);
  });

  it("implementador e fixer saem pelos agents dedicados, nunca general-purpose com effort low (#9081/#9530)", () => {
    assert.match(overnight, /subagent_type: "dev-implementador"/);
    assert.match(overnight, /subagent_type: "dev-fixer"/);
    assert.doesNotMatch(overnight, /effort: "low"/);
  });
});

describe("#3454/#8941 — develop: coordenador pinado em claude-opus-5-5/medium", () => {
  it("frontmatter pina model: claude-opus-5-5 + effort: medium", () => {
    const fm = frontmatter(develop);
    assert.match(fm, /^model:\s*claude-opus-5-5\s*$/m, "model deve ser claude-opus-5-5 (#8941)");
    assert.match(fm, /^effort:\s*medium\s*$/m, "effort deve ser medium");
  });

  it("prosa documenta o pin citando #3454", () => {
    assert.match(develop, /Modelo\/effort do coordenador \(#3454/);
  });
});

describe("#3453 Rec 4 / #3454 Rec 2 — checklist de dispatch compartilhado", () => {
  it("context/overnight-dispatch-rules.md existe", () => {
    assert.ok(existsSync(DISPATCH_RULES), "arquivo compartilhado deve existir");
  });

  it("as duas skills citam o path do checklist compartilhado", () => {
    assert.match(overnight, /context\/overnight-dispatch-rules\.md/, "overnight deve citar o checklist");
    assert.match(develop, /context\/overnight-dispatch-rules\.md/, "develop deve citar o checklist");
  });
});

describe("#3453 Rec 1 / #3454 Rec 1 — instrumentação de token do coordenador", () => {
  // #9874: a emissão à mão via `log-event.ts` saiu `unavailable` em 126/126
  // ocorrências reais — o harness não expõe usage por tool call. O número só
  // existe no transcript local, que `coordinator-usage-estimate.ts` (#6634)
  // lê; o patch de prosa dos SKILL.md apontando pra ele nunca tinha sido
  // aplicado. Trava as 3 skills no script e proíbe a forma à mão.
  it("overnight, develop e continuo emitem coordinator_tokens_estimate via coordinator-usage-estimate.ts, nunca à mão (#9874)", () => {
    const continuo = readFileSync(resolve(ROOT, ".claude/skills/diaria-continuo/SKILL.md"), "utf8");
    for (const [name, text, agent] of [
      ["overnight", overnight, "overnight"],
      ["develop", develop, "develop"],
      ["continuo", continuo, "continuo"],
    ] as const) {
      assert.match(
        text,
        new RegExp(`npx tsx scripts/coordinator-usage-estimate\\.ts --edition \\{[^}]+\\} --agent ${agent} --phase`),
        `${name} deve emitir via coordinator-usage-estimate.ts`,
      );
      assert.doesNotMatch(
        text,
        /--message "coordinator_tokens_estimate"/,
        `${name} não pode instruir a emissão à mão via log-event.ts`,
      );
    }
  });

  it("develop emite subagent_metrics e coordinator_model", () => {
    assert.match(develop, /--message "subagent_metrics"/);
    assert.match(develop, /--message "coordinator_model"/);
  });
});

describe("#3453 Rec 3 — agrupamento mais agressivo por baixo risco", () => {
  it("overnight inclui baixo-risco + baixo-blast-radius como critério de lote", () => {
    assert.match(overnight, /baixo-risco \+ baixo-blast-radius \(#3453 Rec 3\)/);
  });
});
