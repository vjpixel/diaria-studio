/**
 * test/track-quality-report.test.ts (#6755)
 *
 * Cobertura das funções puras de `scripts/track-quality-report.ts` — as 4
 * métricas de qualidade por trilha (retrabalho, atribuição de quebra de
 * master, densidade de finding do daily-review, PRs fechadas sem merge),
 * mais os parsers determinísticos (`deriveTrail`, `extractClosesIssueRefs`,
 * `parseOrigemMarker`, `extractRevertedSha`, `resolveMasterRedCommitTrail`)
 * e `parseSince`. Nenhum teste aqui chama `gh`/`git` — só `fetchRawInput`
 * (não coberto, é I/O puro) faz isso; tudo abaixo é fixture -> função pura.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveTrail,
  extractClosesIssueRefs,
  parseOrigemMarker,
  extractRevertedSha,
  extractFirstIssueRef,
  isMasterRedCommit,
  resolveMasterRedCommitTrail,
  computeReworkRate,
  computeMasterRedAttribution,
  computeFindingDensity,
  computeClosedWithoutMerge,
  parseSince,
  buildTrackQualityReport,
  renderTrackQualityTable,
  type MergedPrRecord,
  type ClosedPrRecord,
} from "../scripts/track-quality-report.ts";

describe("deriveTrail", () => {
  it("reconhece os 3 prefixos conhecidos", () => {
    assert.equal(deriveTrail("continuo/fix-6716-slug"), "continuo");
    assert.equal(deriveTrail("overnight/batch-slug"), "overnight");
    assert.equal(deriveTrail("develop/fix-1234"), "develop");
  });

  it("qualquer outro prefixo, ou ausente, vira other", () => {
    assert.equal(deriveTrail("feature/minha-branch"), "other");
    assert.equal(deriveTrail(""), "other");
    assert.equal(deriveTrail(null), "other");
    assert.equal(deriveTrail(undefined), "other");
  });
});

describe("extractClosesIssueRefs", () => {
  it("extrai Closes #N (case-insensitive)", () => {
    assert.deepEqual(extractClosesIssueRefs("Closes #6716"), [6716]);
    assert.deepEqual(extractClosesIssueRefs("closes #100"), [100]);
    assert.deepEqual(extractClosesIssueRefs("CLOSES #5"), [5]);
  });

  it("extrai múltiplos issues num único body, sem duplicar", () => {
    assert.deepEqual(
      extractClosesIssueRefs("Closes #6716\n\nCloses #6752\nFixes #6716").sort(),
      [6716, 6752],
    );
  });

  it("reconhece fixes/resolves", () => {
    assert.deepEqual(extractClosesIssueRefs("Fixes #10"), [10]);
    assert.deepEqual(extractClosesIssueRefs("Resolves #20"), [20]);
  });

  it("NÃO casa REFS #N, NÃO CLOSES — issue referenciada mas não fechada não conta", () => {
    assert.deepEqual(extractClosesIssueRefs("REFS #6755, NÃO CLOSES (escopo parcial)"), []);
  });

  it("body vazio/nulo -> array vazio", () => {
    assert.deepEqual(extractClosesIssueRefs(""), []);
    assert.deepEqual(extractClosesIssueRefs(null), []);
    assert.deepEqual(extractClosesIssueRefs(undefined), []);
  });
});

describe("parseOrigemMarker (#6756)", () => {
  it("parseia o marcador completo", () => {
    const body = "texto\n<!-- origem: pr=6679 trilha=continuo commit=f107aa08 -->\nmais texto";
    assert.deepEqual(parseOrigemMarker(body), { pr: 6679, trilha: "continuo", commit: "f107aa08" });
  });

  it("trata pr/trilha literalmente 'desconhecida' do próprio review", () => {
    const body = "<!-- origem: pr=desconhecida trilha=desconhecida commit=desconhecida -->";
    assert.deepEqual(parseOrigemMarker(body), { pr: null, trilha: "desconhecida", commit: null });
  });

  it("trilha fora do vocabulário conhecido vira 'desconhecida'", () => {
    const body = "<!-- origem: pr=1 trilha=algumacoisa commit=abc -->";
    const marker = parseOrigemMarker(body);
    assert.equal(marker!.trilha, "desconhecida");
  });

  it("ausência do marcador -> null", () => {
    assert.equal(parseOrigemMarker("corpo qualquer sem marcador"), null);
    assert.equal(parseOrigemMarker(null), null);
  });
});

describe("extractRevertedSha", () => {
  it("reconhece o trailer padrão do git revert", () => {
    assert.equal(
      extractRevertedSha("Revert \"fix: algo\"\n\nThis reverts commit abc1234567890abcdef1234567890abcdef1234.\n"),
      "abc1234567890abcdef1234567890abcdef1234",
    );
  });

  it("sha curto também casa", () => {
    assert.equal(extractRevertedSha("This reverts commit abc1234."), "abc1234");
  });

  it("sem o trailer -> null (nunca adivinha a partir de prosa livre)", () => {
    assert.equal(extractRevertedSha("revertendo o PR #123 manualmente"), null);
    assert.equal(extractRevertedSha(null), null);
  });
});

describe("extractFirstIssueRef", () => {
  it("pega o primeiro número referenciado no assunto", () => {
    assert.equal(extractFirstIssueRef("fix(#6255): corrige X"), 6255);
    assert.equal(extractFirstIssueRef("hotfix #10 e depois #20"), 10);
  });

  it("sem referência -> null", () => {
    assert.equal(extractFirstIssueRef("commit sem número"), null);
    assert.equal(extractFirstIssueRef(null), null);
  });
});

describe("isMasterRedCommit", () => {
  it("casa revert/hotfix/master vermelho, case-insensitive", () => {
    assert.ok(isMasterRedCommit("Revert \"fix: algo\""));
    assert.ok(isMasterRedCommit("hotfix(#6255): conserta geração do acervo"));
    assert.ok(isMasterRedCommit("HOTFIX urgente"));
    assert.ok(isMasterRedCommit("master vermelho: reverte PR quebrado"));
  });

  it("commit comum não casa", () => {
    assert.equal(isMasterRedCommit("feat(#100): adiciona funcionalidade nova"), false);
  });
});

describe("resolveMasterRedCommitTrail", () => {
  it("resolve via trailer de revert quando o sha revertido está mapeado", () => {
    const ctx = {
      revertedShaToTrail: new Map([["abc1234", "continuo" as const]]),
      issueOrigemByNumber: new Map(),
    };
    const trail = resolveMasterRedCommitTrail(
      { subject: "Revert algo", body: "This reverts commit abc1234." },
      ctx,
    );
    assert.equal(trail, "continuo");
  });

  it("cai para o marcador de origem da issue referenciada quando não é revert real", () => {
    const ctx = {
      revertedShaToTrail: new Map(),
      issueOrigemByNumber: new Map([[6255, { pr: 6214, trilha: "continuo" as const, commit: "sha" }]]),
    };
    const trail = resolveMasterRedCommitTrail(
      { subject: "hotfix(#6255): conserta geração do acervo", body: "" },
      ctx,
    );
    assert.equal(trail, "continuo");
  });

  it("issue referenciada sem marcador de origem resolvido -> desconhecida", () => {
    const ctx = {
      revertedShaToTrail: new Map(),
      issueOrigemByNumber: new Map([[100, undefined]]),
    };
    const trail = resolveMasterRedCommitTrail({ subject: "hotfix(#100)", body: "" }, ctx);
    assert.equal(trail, "desconhecida");
  });

  it("issue referenciada com marcador mas trilha desconhecida -> desconhecida (nunca herda 'desconhecida' como se fosse um valor válido de trail)", () => {
    const ctx = {
      revertedShaToTrail: new Map(),
      issueOrigemByNumber: new Map([[100, { pr: null, trilha: "desconhecida" as const, commit: null }]]),
    };
    const trail = resolveMasterRedCommitTrail({ subject: "hotfix(#100)", body: "" }, ctx);
    assert.equal(trail, "desconhecida");
  });

  it("nenhum trailer, nenhuma referência de issue -> desconhecida", () => {
    const ctx = { revertedShaToTrail: new Map(), issueOrigemByNumber: new Map() };
    const trail = resolveMasterRedCommitTrail({ subject: "hotfix urgente sem número", body: "" }, ctx);
    assert.equal(trail, "desconhecida");
  });
});

function pr(overrides: Partial<MergedPrRecord> & { number: number }): MergedPrRecord {
  return {
    headRefName: "overnight/fix-1-slug",
    mergedAt: "2026-08-01T00:00:00.000Z",
    body: "",
    ...overrides,
  };
}

describe("computeReworkRate (métrica 1)", () => {
  it("issue com 1 única PR mergeada não é retrabalho", () => {
    const prs = [pr({ number: 1, headRefName: "overnight/fix-100", body: "Closes #100" })];
    const metrics = computeReworkRate(prs);
    const overnight = metrics.find((m) => m.trail === "overnight")!;
    assert.equal(overnight.issues_total, 1);
    assert.equal(overnight.issues_reworked, 0);
    assert.equal(overnight.rate, 0);
  });

  it("issue com 2 PRs mergeadas é retrabalho, atribuído à trilha da 1ª (por data de merge)", () => {
    const prs = [
      pr({ number: 2, headRefName: "develop/fix-200", body: "REFS #200, NÃO CLOSES (parcial)" }),
      pr({ number: 1, headRefName: "continuo/fix-200-slug", mergedAt: "2026-08-01T00:00:00.000Z", body: "Closes #200" }),
      pr({ number: 3, headRefName: "overnight/fix-200-take2", mergedAt: "2026-08-02T00:00:00.000Z", body: "Closes #200" }),
    ];
    const metrics = computeReworkRate(prs);
    const continuo = metrics.find((m) => m.trail === "continuo")!;
    assert.equal(continuo.issues_total, 1, "a 1ª PR mergeada (continuo) é dona da issue");
    assert.equal(continuo.issues_reworked, 1);
    const overnight = metrics.find((m) => m.trail === "overnight")!;
    assert.equal(overnight.issues_total, 0, "overnight não é dona — só mergeou a 2ª PR da mesma issue");
  });

  it("PR sem Closes/Fixes/Resolves não entra na base de nenhuma trilha", () => {
    const prs = [pr({ number: 1, headRefName: "continuo/fix-x", body: "sem referência de issue" })];
    const metrics = computeReworkRate(prs);
    for (const m of metrics) assert.equal(m.issues_total, 0);
  });

  it("trilha sem nenhuma issue tem rate null (não 0 — 0 sugeriria dado, null é ausência de base)", () => {
    const metrics = computeReworkRate([]);
    for (const m of metrics) {
      assert.equal(m.issues_total, 0);
      assert.equal(m.rate, null);
    }
  });
});

describe("computeMasterRedAttribution (métrica 2)", () => {
  it("agrega por trilha resolvida, incluindo desconhecida", () => {
    const ctx = {
      revertedShaToTrail: new Map([["abc1234", "continuo" as const]]),
      issueOrigemByNumber: new Map(),
    };
    const commits = [
      { subject: "Revert algo ruim", body: "This reverts commit abc1234." },
      { subject: "hotfix urgente sem referência", body: "" },
      { subject: "feat normal, não é quebra", body: "" },
    ];
    const metrics = computeMasterRedAttribution(commits, ctx);
    assert.equal(metrics.find((m) => m.trail === "continuo")!.count, 1);
    assert.equal(metrics.find((m) => m.trail === "desconhecida")!.count, 1);
    // total de commits classificados como master-red deve ser 2 (o "feat normal" não conta)
    assert.equal(metrics.reduce((s, m) => s + m.count, 0), 2);
  });
});

describe("computeFindingDensity (métrica 3)", () => {
  it("conta findings por trilha e normaliza por PRs mergeadas da mesma trilha", () => {
    const bodies = [
      "<!-- origem: pr=1 trilha=continuo commit=a -->",
      "<!-- origem: pr=2 trilha=continuo commit=b -->",
      "<!-- origem: pr=3 trilha=overnight commit=c -->",
      "<!-- origem: pr=4 trilha=desconhecida commit=d -->", // não conta pra nenhuma trilha
      "sem marcador nenhum",
    ];
    const merged = { continuo: 10, overnight: 5, develop: 0, other: 0 };
    const metrics = computeFindingDensity(bodies, merged);
    const continuo = metrics.find((m) => m.trail === "continuo")!;
    assert.equal(continuo.findings, 2);
    assert.equal(continuo.density, 0.2);
    const develop = metrics.find((m) => m.trail === "develop")!;
    assert.equal(develop.merged_prs, 0);
    assert.equal(develop.density, null, "sem PR mergeada na janela, density é null (não divisão por zero)");
  });
});

describe("computeClosedWithoutMerge (métrica 4)", () => {
  it("conta fechadas sem merge por trilha", () => {
    const closed: ClosedPrRecord[] = [
      { headRefName: "continuo/fix-1", merged: true },
      { headRefName: "continuo/fix-2", merged: false },
      { headRefName: "overnight/fix-3", merged: false },
    ];
    const metrics = computeClosedWithoutMerge(closed);
    const continuo = metrics.find((m) => m.trail === "continuo")!;
    assert.equal(continuo.closed_total, 2);
    assert.equal(continuo.closed_without_merge, 1);
    assert.equal(continuo.rate, 0.5);
  });

  it("array vazio -> todas as trilhas com rate null", () => {
    const metrics = computeClosedWithoutMerge([]);
    for (const m of metrics) assert.equal(m.rate, null);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");

  it("aceita Nd (dias relativos)", () => {
    const result = parseSince("30d", now);
    assert.equal(result.toISOString(), "2026-07-31T12:00:00.000Z");
  });

  it("aceita data ISO absoluta", () => {
    const result = parseSince("2026-08-01", now);
    assert.equal(result.toISOString(), "2026-08-01T00:00:00.000Z");
  });

  it("lança em formato inválido, nunca degrada para 'sem filtro' em silêncio", () => {
    assert.throws(() => parseSince("trinta dias", now), /--since inválido/);
  });
});

describe("buildTrackQualityReport / renderTrackQualityTable — integração das 4 métricas", () => {
  it("monta o relatório completo a partir de um RawInput fixture e renderiza tabela sem lançar", () => {
    const raw = {
      mergedPrs: [pr({ number: 1, headRefName: "continuo/fix-6716-a", body: "Closes #6716" })],
      closedPrs: [{ headRefName: "continuo/fix-x", merged: false }] as ClosedPrRecord[],
      dailyReviewIssueBodies: ["<!-- origem: pr=1 trilha=continuo commit=a -->"],
      masterRedCommits: [{ subject: "hotfix(#1) urgente", body: "" }],
      masterRedResolutionCtx: { revertedShaToTrail: new Map(), issueOrigemByNumber: new Map() },
      warnings: ["aviso de teste"],
    };
    const report = buildTrackQualityReport(raw, "30d");
    assert.equal(report.since, "30d");
    assert.equal(report.warnings.length, 1);
    assert.equal(report.rework.length, 4);
    assert.equal(report.master_red.length, 5); // 4 trilhas + desconhecida
    assert.equal(report.finding_density.length, 4);
    assert.equal(report.closed_without_merge.length, 4);

    const table = renderTrackQualityTable(report);
    assert.match(table, /track-quality-report/);
    assert.match(table, /Avisos \(seções degradadas\)/);
    assert.match(table, /aviso de teste/);
  });
});
