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
  checkLabelCoverage,
  deriveCandidateIssues,
  deriveLabelCandidates,
  hasOvernightComment,
  isRefsNotClosesBody,
  requiredLabelForMotivo,
  type CandidateIssue,
  type LabelCandidateIssue,
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

  // #5909 — `deixado-para-o-helios` é isento de comentário por desenho:
  // a skill documenta que este motivo não leva comentário (ruído em massa)
  // e o roteamento label-driven já recoloca a issue no track develop/Neo.
  it("issue pulada com motivo deixado-para-o-helios NUNCA é candidata (#5909)", () => {
    const issues: PlanIssueLike[] = [
      { number: 5878, status: "pulada", motivo: "deixado-para-o-helios" },
      { number: 5869, status: "pulada", motivo: "deixado-para-o-helios" },
    ];
    assert.deepEqual(deriveCandidateIssues(issues, new Map()), []);
  });

  it("isenção de deixado-para-o-helios não vaza pra outros motivos nem pra pulada sem motivo", () => {
    const issues: PlanIssueLike[] = [
      { number: 1, status: "pulada", motivo: "bloqueio-externo" },
      { number: 2, status: "pulada", motivo: "decisao-adiada" },
      { number: 3, status: "pulada" },
    ];
    const candidates = deriveCandidateIssues(issues, new Map());
    assert.deepEqual(
      candidates.map((c) => c.number),
      [1, 2, 3],
    );
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

// ─── #5844 — cobertura de LABEL (motivo → label esperada) ──────────────────

describe("requiredLabelForMotivo (#5844)", () => {
  it("mapeia os 3 motivos com label única", () => {
    assert.equal(requiredLabelForMotivo("not-this-week"), "not-this-week");
    assert.equal(requiredLabelForMotivo("bloqueio-externo"), "external-blocker");
    assert.equal(requiredLabelForMotivo("ambigua"), "trade-off-real");
  });

  it("requer-sessao-local não tem label única — deliberadamente fora do mapa", () => {
    assert.equal(requiredLabelForMotivo("requer-sessao-local"), null);
  });

  it("motivo desconhecido/ausente → null, nunca lança", () => {
    assert.equal(requiredLabelForMotivo("sem-resposta"), null);
    assert.equal(requiredLabelForMotivo(undefined), null);
    assert.equal(requiredLabelForMotivo(null), null);
    assert.equal(requiredLabelForMotivo(""), null);
  });
});

describe("deriveLabelCandidates (#5844)", () => {
  it("só issues pulada com motivo mapeado viram candidata de label", () => {
    const issues: PlanIssueLike[] = [
      { number: 5757, status: "pulada", motivo: "not-this-week" },
      { number: 5750, status: "pulada", motivo: "requer-sessao-local" },
      { number: 5749, status: "mergeada", motivo: "not-this-week" },
      { number: 5748, status: "pulada" },
    ];
    const candidates = deriveLabelCandidates(issues);
    assert.deepEqual(
      candidates.map((c) => c.number),
      [5757],
    );
    assert.equal(candidates[0].requiredLabel, "not-this-week");
    assert.equal(candidates[0].motivo, "not-this-week");
  });
});

describe("checkLabelCoverage (#5844) — o cenário que motivou a issue", () => {
  it("comentário presente, label ausente → gate detecta (o achado real de #5757/#5750/#5749/#5748)", () => {
    // Cenário exato da issue: a rodada comentou explicando a classificação
    // not-this-week duas vezes, mas nunca aplicou a label correspondente.
    const candidates: LabelCandidateIssue[] = [{ number: 5757, motivo: "not-this-week", requiredLabel: "not-this-week" }];
    const labelsByIssue = new Map<number, string[]>([[5757, ["bug", "P2"]]]); // sem "not-this-week"
    const verdict = checkLabelCoverage(candidates, labelsByIssue);
    assert.equal(verdict.status, "missing");
    assert.equal(verdict.missing.length, 1);
    assert.equal(verdict.missing[0].number, 5757);
    assert.equal(verdict.missing[0].requiredLabel, "not-this-week");
  });

  it("label presente → ok", () => {
    const candidates: LabelCandidateIssue[] = [{ number: 5757, motivo: "not-this-week", requiredLabel: "not-this-week" }];
    const labelsByIssue = new Map<number, string[]>([[5757, ["not-this-week", "P2"]]]);
    const verdict = checkLabelCoverage(candidates, labelsByIssue);
    assert.equal(verdict.status, "ok");
    assert.deepEqual(verdict.missing, []);
  });

  it("issue ausente do mapa de labels (fetch nunca populou) → tratada como sem labels → missing", () => {
    const candidates: LabelCandidateIssue[] = [{ number: 5757, motivo: "bloqueio-externo", requiredLabel: "external-blocker" }];
    const verdict = checkLabelCoverage(candidates, new Map());
    assert.equal(verdict.status, "missing");
  });

  it("sem candidatas → not-evaluated", () => {
    const verdict = checkLabelCoverage([], new Map());
    assert.equal(verdict.status, "not-evaluated");
    assert.deepEqual(verdict.missing, []);
  });

  it("múltiplas candidatas: só as sem label entram em missing, ordenado por número", () => {
    const candidates: LabelCandidateIssue[] = [
      { number: 5800, motivo: "ambigua", requiredLabel: "trade-off-real" },
      { number: 5791, motivo: "bloqueio-externo", requiredLabel: "external-blocker" },
      { number: 5795, motivo: "not-this-week", requiredLabel: "not-this-week" },
    ];
    const labelsByIssue = new Map<number, string[]>([
      [5800, []],
      [5791, ["external-blocker"]],
      [5795, []],
    ]);
    const verdict = checkLabelCoverage(candidates, labelsByIssue);
    assert.equal(verdict.status, "missing");
    assert.deepEqual(
      verdict.missing.map((c) => c.number),
      [5795, 5800],
    );
  });
});
