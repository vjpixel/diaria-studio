/**
 * test/continuo-stuck-pr.test.ts (#8767)
 *
 * Regressão da lógica pura do resolvedor de PRs `continuo/*` travadas. Os
 * cenários espelham as 4 PRs paradas de 24/09/2026 (#8703, #8705, #8754,
 * #8755) — cada uma ficou 1-2 dias sem nenhum processo com ação terminal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countRejectReviews,
  decideStuckPrAction,
  extractLinkedIssues,
  buildCloseComment,
  REJECT_CAP,
  STALE_HOURS_BEFORE_ACTION,
  type StuckPrInput,
} from "../scripts/lib/continuo-stuck-pr.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pr(over: Partial<StuckPrInput> = {}): StuckPrInput {
  return {
    number: 1,
    title: "fix(#100): algo",
    body: "Closes #100",
    headRefName: "continuo/fix-100",
    isDraft: false,
    labels: [],
    mergeable: "MERGEABLE",
    ciVerdict: "pass",
    linkedIssues: [{ number: 100, state: "OPEN" }],
    rejectCount: 0,
    updateBranchDone: false,
    behindBy: 0,
    hoursSinceLastCommit: 24,
    ...over,
  };
}

describe("extractLinkedIssues", () => {
  it("título fix(#N) + palavras-chave do corpo (en/pt)", () => {
    assert.deepEqual(extractLinkedIssues("fix(#8665): worktree", "Correção do #8665."), [8665]);
    assert.deepEqual(extractLinkedIssues("fix(#8697): x", "Fecha #8697.\n\nFixes #1"), [1, 8697]);
    assert.deepEqual(extractLinkedIssues("x", "**Closes #8693** (post-mortem)"), [8693]);
  });
  it("PR de rescue 'REFS #N, NÃO CLOSES' não declara issue nenhuma", () => {
    assert.deepEqual(extractLinkedIssues("chore(#7130): trabalho órfão", "REFS #7130, NÃO CLOSES (achado)"), []);
  });
  it("menção solta (#N sem palavra-chave) não conta", () => {
    assert.deepEqual(extractLinkedIssues("chore: algo", "ver #123 e #456"), []);
  });
});

describe("countRejectReviews", () => {
  it("conta só o marcador estruturado com verdict=reject", () => {
    const bodies = [
      "<!-- continuo-review: run=1 at=x verdict=reject head=a -->",
      "Review automatizado (1 agente, effort low): reject em prosa",
      "<!-- continuo-review: run=2 at=y verdict=approve head=b -->",
      "texto\n<!-- continuo-review: run=3 at=z verdict=reject head=c -->",
    ];
    assert.equal(countRejectReviews(bodies), 2);
  });
});

describe("decideStuckPrAction", () => {
  it("fora de escopo: branch não-continuo, draft e bloqueio-execucao (caso #8755) são skip", () => {
    assert.equal(decideStuckPrAction(pr({ headRefName: "claude/x" })).kind, "skip");
    assert.equal(decideStuckPrAction(pr({ isDraft: true, ciVerdict: "fail" })).kind, "skip");
    assert.equal(decideStuckPrAction(pr({ labels: ["bloqueio-execucao"], rejectCount: 9 })).kind, "skip");
  });

  it("caso #8754: issue declarada fechada pelo master → close_superseded, mesmo com commit recente", () => {
    const a = decideStuckPrAction(pr({ linkedIssues: [{ number: 8665, state: "CLOSED" }], hoursSinceLastCommit: 0.5 }));
    assert.deepEqual(a, { kind: "close_superseded", issues: [8665] });
  });

  it("superseded exige TODAS as issues fechadas", () => {
    const a = decideStuckPrAction(
      pr({ linkedIssues: [{ number: 1, state: "CLOSED" }, { number: 2, state: "OPEN" }] }),
    );
    assert.notEqual(a.kind, "close_superseded");
  });

  it("nenhuma ação de fechamento/update antes de ficar parada", () => {
    const a = decideStuckPrAction(
      pr({ rejectCount: 10, hoursSinceLastCommit: STALE_HOURS_BEFORE_ACTION - 1 }),
    );
    assert.equal(a.kind, "skip");
    assert.equal(decideStuckPrAction(pr({ rejectCount: 10, hoursSinceLastCommit: null })).kind, "skip");
  });

  it("caso #8703: reviews reject no teto → close_reject_cap", () => {
    assert.equal(decideStuckPrAction(pr({ rejectCount: REJECT_CAP - 1 })).kind, "skip");
    assert.deepEqual(decideStuckPrAction(pr({ rejectCount: REJECT_CAP })), { kind: "close_reject_cap", rejectCount: REJECT_CAP });
  });

  it("conflito parado → close_conflict", () => {
    assert.equal(decideStuckPrAction(pr({ mergeable: "CONFLICTING" })).kind, "close_conflict");
  });

  it("caso #8705: CI vermelho + atrás do master + sem update anterior → update_branch (não gasta o cap de CI-fix)", () => {
    const a = decideStuckPrAction(
      pr({ ciVerdict: "fail", behindBy: 40, labels: ["continuo-ci-fix-tentado"] }),
    );
    assert.deepEqual(a, { kind: "update_branch", behindBy: 40 });
  });

  it("update-branch é 1x por PR: com marcador e CI-fix gasto → close_ci_red", () => {
    const a = decideStuckPrAction(
      pr({ ciVerdict: "fail", behindBy: 5, updateBranchDone: true, labels: ["continuo-ci-fix-tentado"] }),
    );
    assert.equal(a.kind, "close_ci_red");
  });

  it("CI vermelho em dia com o master + CI-fix gasto → close_ci_red", () => {
    assert.equal(
      decideStuckPrAction(pr({ ciVerdict: "fail", behindBy: 0, labels: ["continuo-ci-fix-tentado"] })).kind,
      "close_ci_red",
    );
  });

  it("CI vermelho sem tentativa de CI-fix ainda fica com o ci-fixer (§3b)", () => {
    assert.equal(decideStuckPrAction(pr({ ciVerdict: "fail", behindBy: 0 })).kind, "skip");
  });

  it("behind desconhecido (null) nunca fecha nem atualiza", () => {
    assert.equal(
      decideStuckPrAction(pr({ ciVerdict: "fail", behindBy: null, labels: ["continuo-ci-fix-tentado"] })).kind,
      "skip",
    );
  });

  it("CI pending/pass não gera ação", () => {
    assert.equal(decideStuckPrAction(pr({ ciVerdict: "pending" })).kind, "skip");
    assert.equal(decideStuckPrAction(pr({ ciVerdict: "pass" })).kind, "skip");
  });
});

describe("buildCloseComment", () => {
  it("fechamento não-superseded avisa que a issue aberta volta à fila", () => {
    const c = buildCloseComment({ kind: "close_ci_red" }, { linkedIssues: [{ number: 100, state: "OPEN" }] });
    assert.match(c, /#100/);
    assert.match(c, /volta à fila/);
  });
});

describe("wiring em continuo-pr-review.sh", () => {
  const review = readFileSync(resolve(ROOT, "hermes/scripts/continuo-pr-review.sh"), "utf8");
  it("o resolvedor roda antes da listagem de PRs do laço de review", () => {
    const call = review.indexOf("npx tsx scripts/continuo-resolve-stuck-prs.ts");
    const list = review.indexOf("PR_NUMBERS=$(gh pr list");
    assert.ok(call > 0, "continuo-pr-review.sh não chama o resolvedor");
    assert.ok(call < list, "o resolvedor tem de rodar antes do laço (PR fechada não é revisada de novo)");
  });
  it("#8766: o prompt de review usa diff three-dot, nunca two-dot contra BASE_SHA", () => {
    const prompt = review.slice(review.indexOf('PROMPT="'));
    assert.match(prompt, /git diff \$BASE_SHA\.\.\.\$HEAD_SHA/);
    // a única ocorrência two-dot permitida é a da própria advertência "Nunca use"
    const twoDot = prompt.match(/git diff \$BASE_SHA\.\.\$HEAD_SHA/g) ?? [];
    assert.equal(twoDot.length, 1);
    assert.match(prompt, /Nunca use \\`git diff \$BASE_SHA\.\.\$HEAD_SHA\\`/);
  });
});
