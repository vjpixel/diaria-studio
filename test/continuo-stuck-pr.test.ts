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
  EXECUTION_BLOCK_LABEL,
  extractLinkedIssues,
  needsDraftBlockLabel,
  buildCloseComment,
  buildRefreshComment,
  countRefreshes,
  hasApprovalForHead,
  REFRESH_BRANCH_MARKER,
  REFRESH_CAP,
  REJECT_CAP,
  UPDATE_BRANCH_MARKER,
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
  it("#8773: título multi-issue fix(#A, #B) extrai TODAS as issues do grupo", () => {
    assert.deepEqual(extractLinkedIssues("fix(#8766, #8767): review do contínuo", "Closes #8766"), [8766, 8767]);
    assert.deepEqual(
      extractLinkedIssues("chore(#8758, #8759, #8760): lote de fixes", "sem palavra-chave no corpo"),
      [8758, 8759, 8760],
    );
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

  it("#8773: título fix(#A, #B) com só #A fechada — linkedIssues completo (via extractLinkedIssues) não é superseded", () => {
    const linked = extractLinkedIssues("fix(#8766, #8767): review do contínuo", "Closes #8766");
    const linkedIssues = linked.map((n) => ({ number: n, state: n === 8766 ? ("CLOSED" as const) : ("OPEN" as const) }));
    const a = decideStuckPrAction(pr({ linkedIssues }));
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

describe("#12460 — draft do contínuo sem bloqueio-execucao ganha a label", () => {
  it("caso #12351: draft continuo/fix-* sem a label → precisa da label", () => {
    assert.equal(
      needsDraftBlockLabel({ headRefName: "continuo/fix-12241-bing-ai-performance", isDraft: true, labels: ["continuo-escalado"] }),
      true,
    );
  });
  it("draft que já tem a label (resgate, #7484) → nada a fazer", () => {
    assert.equal(
      needsDraftBlockLabel({ headRefName: "continuo/rescue-x", isDraft: true, labels: [EXECUTION_BLOCK_LABEL] }),
      false,
    );
  });
  it("PR não-draft nunca recebe a label (o merger precisa continuar vendo-a)", () => {
    assert.equal(needsDraftBlockLabel({ headRefName: "continuo/fix-1", isDraft: false, labels: [] }), false);
  });
  it("draft fora de continuo/* (overnight, editor) não é tocado", () => {
    assert.equal(needsDraftBlockLabel({ headRefName: "overnight/fix-1-x", isDraft: true, labels: [] }), false);
  });
  it("a label aplicada é a mesma que o alarme de fila (watch-continuo-health.sh) exclui", () => {
    const watch = readFileSync(resolve(ROOT, "hermes/scripts/watch-continuo-health.sh"), "utf8");
    assert.ok(
      watch.includes(`.isDraft and (any(.labels[]; .name == "${EXECUTION_BLOCK_LABEL}"))`),
      "o filtro da fila no watch não usa a mesma label que o resolvedor aplica",
    );
  });
  it("o resolvedor chama needsDraftBlockLabel e aplica por REST antes do skip de draft", () => {
    const cli = readFileSync(resolve(ROOT, "scripts/continuo-resolve-stuck-prs.ts"), "utf8");
    const call = cli.indexOf("needsDraftBlockLabel({");
    const skip = cli.indexOf("if (raw.isDraft ||");
    assert.ok(call > 0 && skip > call, "a checagem do draft tem de vir antes do continue de draft");
    assert.match(cli, /addPrLabelsRest\(raw\.number, \[EXECUTION_BLOCK_LABEL\]/);
  });
  it("o prompt do implementador do contínuo manda abrir draft já com a label", () => {
    const skill = readFileSync(resolve(ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md"), "utf8");
    assert.match(skill, /--draft --label bloqueio-execucao/);
  });
});

describe("#12907 — PR aprovada e verde parada recebe o master antes de conflitar", () => {
  // Cenário das 11 PRs da auditoria (docs/continuo-pr-audit-12907.md):
  // `verdict=approve`, CI verde, sem commit há 6h+, master andando. Antes,
  // nada acontecia até o `CONFLICTING`, e aí vinha o `close_conflict`.
  const ready = (over: Partial<StuckPrInput> = {}) =>
    pr({ ciVerdict: "pass", approved: true, retido: false, sensitive: false, refreshCount: 0, behindBy: 7, ...over });

  it("aprovada + verde + parada + atrás do master → refresh_branch", () => {
    assert.deepEqual(decideStuckPrAction(ready()), { kind: "refresh_branch", behindBy: 7 });
  });

  it("parada exatamente no limiar de 6h já atualiza; abaixo dele, não", () => {
    assert.equal(decideStuckPrAction(ready({ hoursSinceLastCommit: STALE_HOURS_BEFORE_ACTION })).kind, "refresh_branch");
    assert.equal(decideStuckPrAction(ready({ hoursSinceLastCommit: STALE_HOURS_BEFORE_ACTION - 0.1 })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ hoursSinceLastCommit: null })).kind, "skip");
  });

  it("em dia com o master (ou behind desconhecido) → nada a fazer", () => {
    assert.equal(decideStuckPrAction(ready({ behindBy: 0 })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ behindBy: null })).kind, "skip");
  });

  it("retenções da decisão do editor seguem intocadas: sensível, retido-para-editor, draft, bloqueio-execucao", () => {
    assert.equal(decideStuckPrAction(ready({ sensitive: true })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ retido: true })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ isDraft: true })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ labels: [EXECUTION_BLOCK_LABEL] })).kind, "skip");
  });

  it("sinal desconhecido é fail-closed: approved/retido/sensitive ausentes ou null não atualizam", () => {
    for (const k of ["approved", "retido", "sensitive"] as const) {
      assert.equal(decideStuckPrAction(ready({ [k]: null })).kind, "skip", `${k}: null`);
      assert.equal(decideStuckPrAction(ready({ [k]: undefined })).kind, "skip", `${k}: undefined`);
    }
  });

  it("sem aprovação ou CI não-verde → não atualiza", () => {
    assert.equal(decideStuckPrAction(ready({ approved: false })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ ciVerdict: "pending" })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ ciVerdict: "error" })).kind, "skip");
  });

  it("já conflitando, o fechamento por conflito continua como era", () => {
    assert.equal(decideStuckPrAction(ready({ mergeable: "CONFLICTING" })).kind, "close_conflict");
  });

  it("UNKNOWN transitório (#12950) não impede o refresh", () => {
    assert.equal(decideStuckPrAction(ready({ mergeable: "UNKNOWN" })).kind, "refresh_branch");
  });

  it("superseded e teto de rejects mantêm a precedência", () => {
    assert.equal(decideStuckPrAction(ready({ linkedIssues: [{ number: 100, state: "CLOSED" }] })).kind, "close_superseded");
    assert.equal(decideStuckPrAction(ready({ rejectCount: REJECT_CAP })).kind, "close_reject_cap");
  });

  it("o comentário do refresh leva marcador próprio, que não gasta o update-branch 1x do CI vermelho", () => {
    const c = buildRefreshComment(3);
    assert.ok(c.includes(REFRESH_BRANCH_MARKER));
    assert.ok(!c.includes(UPDATE_BRANCH_MARKER));
    assert.match(c, /3 commit/);
  });
});

describe("#13010 — teto de refreshes por PR", () => {
  const ready = (over: Partial<StuckPrInput> = {}) =>
    pr({ ciVerdict: "pass", approved: true, retido: false, sensitive: false, refreshCount: 0, behindBy: 7, ...over });
  const mergeCommit = { messageHeadline: "Merge branch 'master' into continuo/fix-1" };

  it(`até ${REFRESH_CAP - 1} refresh anterior ainda atualiza; no teto, não`, () => {
    assert.equal(REFRESH_CAP, 2);
    assert.equal(decideStuckPrAction(ready({ refreshCount: 1 })).kind, "refresh_branch");
    assert.equal(decideStuckPrAction(ready({ refreshCount: REFRESH_CAP })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ refreshCount: REFRESH_CAP + 3 })).kind, "skip");
  });

  it("contagem ilegível (null/ausente) não atualiza", () => {
    assert.equal(decideStuckPrAction(ready({ refreshCount: null })).kind, "skip");
    assert.equal(decideStuckPrAction(ready({ refreshCount: undefined })).kind, "skip");
  });

  it("countRefreshes conta marcadores, ou commits de merge da base, o que for maior", () => {
    const marker = buildRefreshComment(3);
    assert.equal(countRefreshes([]), 0);
    assert.equal(countRefreshes([marker, "outro", marker]), 2);
    assert.equal(countRefreshes(["x"], [mergeCommit, { messageHeadline: "fix: algo" }, mergeCommit]), 2);
    assert.equal(countRefreshes([marker], [mergeCommit, mergeCommit, mergeCommit]), 3);
    assert.equal(countRefreshes([marker, marker], [{ messageHeadline: null }]), 2);
  });

  it("comentários ilegíveis → null (sem sinal legível)", () => {
    assert.equal(countRefreshes(null, [mergeCommit]), null);
  });

  it("o resolvedor passa a contagem para a decisão", () => {
    const cli = readFileSync(resolve(ROOT, "scripts/continuo-resolve-stuck-prs.ts"), "utf8");
    assert.match(cli, /refreshCount: countRefreshes\(comments, view\?\.commits \?\? null\)/);
  });
});

describe("#12907 — hasApprovalForHead", () => {
  const review = (verdict: string, head?: string, assoc = "OWNER") => ({
    authorAssociation: assoc,
    body: `<!-- continuo-review: run=1 at=2026-11-13T10:00:00Z verdict=${verdict}${head ? ` head=${head}` : ""} -->`,
  });

  it("approve cobrindo o HEAD atual (SHA completo ou abreviado) conta", () => {
    assert.equal(hasApprovalForHead([review("approve", "abc1234")], "abc1234def"), true);
    assert.equal(hasApprovalForHead([review("approve", "abc1234def")], "abc1234def"), true);
  });

  it("approve de HEAD antigo, sem head= ou HEAD desconhecido não conta", () => {
    assert.equal(hasApprovalForHead([review("approve", "0000000")], "abc1234def"), false);
    assert.equal(hasApprovalForHead([review("approve")], "abc1234def"), false);
    assert.equal(hasApprovalForHead([review("approve", "abc1234")], null), false);
  });

  it("o review mais recente manda: reject depois do approve não conta", () => {
    assert.equal(hasApprovalForHead([review("approve", "abc1234"), review("reject", "abc1234")], "abc1234"), false);
  });

  it("marcador de autor sem vínculo com o repo (#9632) é ignorado", () => {
    assert.equal(hasApprovalForHead([review("approve", "abc1234", "NONE")], "abc1234"), false);
  });

  it("payload ilegível não conta", () => {
    assert.equal(hasApprovalForHead(undefined, "abc1234"), false);
  });
});

describe("#12907 — wiring do refresh no resolvedor", () => {
  const cli = readFileSync(resolve(ROOT, "scripts/continuo-resolve-stuck-prs.ts"), "utf8");
  it("atualiza pelo endpoint update-branch (merge da base) preso ao HEAD aprovado (expected_head_sha)", () => {
    assert.match(cli, /updateBranchApiArgs\(pr\.number, undefined, pr\.headSha\)/);
    assert.doesNotMatch(cli, /"--force"|"rebase"/);
  });
  it("lê retenção e caminho sensível pelas mesmas fontes dos gates de merge", () => {
    assert.match(cli, /evaluatePrRetido\(/);
    assert.match(cli, /classifyChangedPaths\(/);
  });
  it("o resumo do tick conta o refresh junto do update-branch", () => {
    const review = readFileSync(resolve(ROOT, "hermes/scripts/continuo-pr-review.sh"), "utf8");
    assert.match(review, /\.kind == "refresh_branch"/);
  });
});
