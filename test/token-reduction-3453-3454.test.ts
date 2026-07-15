/**
 * test/token-reduction-3453-3454.test.ts (#3453 + #3454)
 *
 * Trava os cortes de token do overnight (#3453) e do develop (#3454):
 *   - overnight coordenador roda effort `high` (baixado de `xhigh`);
 *   - develop pina `model: sonnet` + `effort: high` (antes não pinava nada);
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

describe("#3453 — overnight: coordenador em effort high", () => {
  it("frontmatter fixa effort: high (não xhigh)", () => {
    const fm = frontmatter(overnight);
    assert.match(fm, /^effort:\s*high\s*$/m, "effort deve ser high no frontmatter");
    assert.doesNotMatch(fm, /effort:\s*xhigh/, "effort NÃO deve mais ser xhigh no frontmatter");
    assert.match(fm, /^model:\s*sonnet\s*$/m, "model deve continuar sonnet");
  });

  it("prosa documenta a troca xhigh → high citando #3453", () => {
    assert.match(overnight, /Effort baixado de `xhigh` → `high` \(#3453\)/);
  });
});

describe("#3454 — develop: coordenador pinado em sonnet/high", () => {
  it("frontmatter pina model: sonnet + effort: high", () => {
    const fm = frontmatter(develop);
    assert.match(fm, /^model:\s*sonnet\s*$/m, "model deve ser sonnet");
    assert.match(fm, /^effort:\s*high\s*$/m, "effort deve ser high");
  });

  it("prosa documenta o pin citando #3454", () => {
    assert.match(develop, /Modelo\/effort do coordenador \(#3454\)/);
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
  it("overnight emite coordinator_tokens_estimate", () => {
    assert.match(overnight, /--message "coordinator_tokens_estimate"/);
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
