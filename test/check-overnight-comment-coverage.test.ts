/**
 * test/check-overnight-comment-coverage.test.ts (#5816)
 *
 * Cobre `scripts/lib/overnight-comment-coverage.ts` — a lógica pura do gate
 * de cobertura de comentário. O I/O (gh CLI) fica no entrypoint
 * `scripts/check-overnight-comment-coverage.ts`, testado aqui só via as
 * funções puras que ele orquestra (mesmo padrão de
 * `test/check-state-changed-pending` para o gate irmão).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCoverage,
  deriveCandidateIssues,
  hasOvernightComment,
  isRefsNotClosesBody,
  type CandidateIssue,
  type PlanIssueLike,
} from "../scripts/lib/overnight-comment-coverage.ts";

// ─── isRefsNotClosesBody ────────────────────────────────────────────────────

describe("isRefsNotClosesBody", () => {
  it("detecta o padrão REFS #N ... NÃO CLOSES", () => {
    assert.equal(
      isRefsNotClosesBody("REFS #5791, NÃO CLOSES (instrumentação aplicada, causa raiz não confirmada)", 5791),
      true,
    );
  });

  it("tolera variação de acentuação (NAO sem til)", () => {
    assert.equal(isRefsNotClosesBody("REFS #123, NAO CLOSES", 123), true);
  });

  it("não casa Closes normal", () => {
    assert.equal(isRefsNotClosesBody("Closes #5791\n\nFix completo.", 5791), false);
  });

  it("não casa REFS de outra issue", () => {
    assert.equal(isRefsNotClosesBody("REFS #999, NÃO CLOSES", 5791), false);
  });

  it("body ausente/vazio nunca lança e retorna false", () => {
    assert.equal(isRefsNotClosesBody(null, 5791), false);
    assert.equal(isRefsNotClosesBody(undefined, 5791), false);
    assert.equal(isRefsNotClosesBody("", 5791), false);
  });
});

// ─── hasOvernightComment ─────────────────────────────────────────────────────

describe("hasOvernightComment", () => {
  it("true quando ao menos 1 comentário contém 'overnight' (case-insensitive)", () => {
    assert.equal(
      hasOvernightComment([{ body: "outro comentário" }, { body: "Rodada Overnight: pulada por bloqueio X" }]),
      true,
    );
  });

  it("false quando nenhum comentário contém 'overnight'", () => {
    assert.equal(hasOvernightComment([{ body: "comentário do editor" }, { body: null }]), false);
  });

  it("array vazio → false", () => {
    assert.equal(hasOvernightComment([]), false);
  });
});

// ─── deriveCandidateIssues ───────────────────────────────────────────────────

describe("deriveCandidateIssues", () => {
  it("issue pulada é candidata direto (sem precisar de PR body)", () => {
    const issues: PlanIssueLike[] = [{ number: 5797, status: "pulada" }];
    const candidates = deriveCandidateIssues(issues, new Map());
    assert.deepEqual(candidates, [{ number: 5797, reason: "pulada-sem-comentario" }]);
  });

  it("issue mergeada com PR usando REFS-NÃO-CLOSES é candidata", () => {
    const issues: PlanIssueLike[] = [{ number: 5791, status: "mergeada", pr: 5820 }];
    const prBodies = new Map([[5820, "REFS #5791, NÃO CLOSES (causa raiz não confirmada)"]]);
    const candidates = deriveCandidateIssues(issues, prBodies);
    assert.deepEqual(candidates, [{ number: 5791, reason: "refs-not-closes-sem-comentario", pr: 5820 }]);
  });

  it("issue mergeada com Closes normal NUNCA é candidata (issues resolvidas dispensam comentário extra)", () => {
    const issues: PlanIssueLike[] = [{ number: 5700, status: "mergeada", pr: 5701 }];
    const prBodies = new Map([[5701, "Closes #5700\n\nfix completo."]]);
    const candidates = deriveCandidateIssues(issues, prBodies);
    assert.deepEqual(candidates, []);
  });

  it("issue mergeada sem pr registrado nunca é candidata (não há como checar o body)", () => {
    const issues: PlanIssueLike[] = [{ number: 5700, status: "mergeada" }];
    const candidates = deriveCandidateIssues(issues, new Map());
    assert.deepEqual(candidates, []);
  });

  it("PR body ausente do mapa (fetch falhou) nunca é candidata forçada", () => {
    const issues: PlanIssueLike[] = [{ number: 5700, status: "mergeada", pr: 5701 }];
    const candidates = deriveCandidateIssues(issues, new Map([[5701, null]]));
    assert.deepEqual(candidates, []);
  });

  it("status elegivel/draft-ci-vermelho/elegivel_especial nunca são candidatas", () => {
    const issues: PlanIssueLike[] = [
      { number: 1, status: "elegivel" },
      { number: 2, status: "draft-ci-vermelho" },
      { number: 3, status: "elegivel_especial" },
    ];
    assert.deepEqual(deriveCandidateIssues(issues, new Map()), []);
  });

  it("mistura pulada + REFS-NÃO-CLOSES + Closes normal no mesmo plano", () => {
    const issues: PlanIssueLike[] = [
      { number: 5797, status: "pulada" },
      { number: 5791, status: "mergeada", pr: 5820 },
      { number: 5700, status: "mergeada", pr: 5701 },
    ];
    const prBodies = new Map([
      [5820, "REFS #5791, NÃO CLOSES"],
      [5701, "Closes #5700"],
    ]);
    const candidates = deriveCandidateIssues(issues, prBodies);
    assert.deepEqual(
      candidates.map((c) => c.number).sort((a, b) => a - b),
      [5791, 5797],
    );
  });
});

// ─── checkCoverage ────────────────────────────────────────────────────────────

describe("checkCoverage", () => {
  it("sem candidatas → not-evaluated (nada pra checar)", () => {
    const verdict = checkCoverage([], new Map());
    assert.equal(verdict.status, "not-evaluated");
    assert.deepEqual(verdict.missing, []);
  });

  it("candidata pulada SEM comentário → falha (cenário #1 da issue)", () => {
    const candidates: CandidateIssue[] = [{ number: 5797, reason: "pulada-sem-comentario" }];
    const verdict = checkCoverage(candidates, new Map([[5797, []]]));
    assert.equal(verdict.status, "missing");
    assert.equal(verdict.missing.length, 1);
    assert.equal(verdict.missing[0].number, 5797);
  });

  it("candidata pulada COM comentário overnight → passa", () => {
    const candidates: CandidateIssue[] = [{ number: 5797, reason: "pulada-sem-comentario" }];
    const verdict = checkCoverage(
      candidates,
      new Map([[5797, [{ body: "Rodada Overnight 260819: pulada, motivo bloqueio-externo." }]]]),
    );
    assert.equal(verdict.status, "ok");
    assert.deepEqual(verdict.missing, []);
  });

  it("candidata REFS-NÃO-CLOSES SEM comentário → falha (cenário #2 da issue)", () => {
    const candidates: CandidateIssue[] = [{ number: 5791, reason: "refs-not-closes-sem-comentario", pr: 5820 }];
    const verdict = checkCoverage(candidates, new Map([[5791, [{ body: "comentário do editor, sem a palavra" }]]]));
    assert.equal(verdict.status, "missing");
    assert.equal(verdict.missing[0].number, 5791);
  });

  it("candidata REFS-NÃO-CLOSES COM comentário overnight → passa", () => {
    const candidates: CandidateIssue[] = [{ number: 5791, reason: "refs-not-closes-sem-comentario", pr: 5820 }];
    const verdict = checkCoverage(
      candidates,
      new Map([[5791, [{ body: "overnight: instrumentação aplicada, causa raiz ainda sob investigação." }]]]),
    );
    assert.equal(verdict.status, "ok");
  });

  it("fetch de comentários falhou (null) → unresolved, NUNCA conta como missing", () => {
    const candidates: CandidateIssue[] = [{ number: 5797, reason: "pulada-sem-comentario" }];
    const verdict = checkCoverage(candidates, new Map([[5797, null]]));
    assert.equal(verdict.status, "ok", "unresolved não deve derrubar o gate por si só");
    assert.deepEqual(verdict.missing, []);
    assert.equal(verdict.unresolved.length, 1);
    assert.equal(verdict.unresolved[0].number, 5797);
  });

  it("issue ausente do mapa de comentários (nunca buscada) também vira unresolved, não missing", () => {
    const candidates: CandidateIssue[] = [{ number: 5797, reason: "pulada-sem-comentario" }];
    const verdict = checkCoverage(candidates, new Map());
    assert.equal(verdict.status, "ok");
    assert.equal(verdict.unresolved.length, 1);
  });

  it("múltiplas candidatas: só as sem comentário entram em missing, resultado ordenado por número", () => {
    const candidates: CandidateIssue[] = [
      { number: 5800, reason: "pulada-sem-comentario" },
      { number: 5791, reason: "refs-not-closes-sem-comentario", pr: 5820 },
      { number: 5795, reason: "pulada-sem-comentario" },
    ];
    const commentsByIssue = new Map([
      [5800, []],
      [5791, [{ body: "overnight comentou aqui" }]],
      [5795, []],
    ]);
    const verdict = checkCoverage(candidates, commentsByIssue);
    assert.equal(verdict.status, "missing");
    assert.deepEqual(
      verdict.missing.map((c) => c.number),
      [5795, 5800],
    );
  });
});
