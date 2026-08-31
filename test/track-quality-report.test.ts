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
  computeCostByModel,
  maxActivityDate,
  computeCostPerNonReworkedContinuoIssue,
  fetchOpenRouterActivity,
  type MergedPrRecord,
  type ClosedPrRecord,
  type OpenRouterActivityRow,
  type ReworkMetric,
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

  it("AMBOS os sinais resolvíveis simultaneamente -> trailer de revert (a) vence sobre marcador de issue (b), conforme a ordem documentada (pr-test-analyzer, PR #6855: precedência nunca exercitada com os dois presentes ao mesmo tempo)", () => {
    const ctx = {
      revertedShaToTrail: new Map([["abc1234", "continuo" as const]]),
      issueOrigemByNumber: new Map([[6255, { pr: 6214, trilha: "overnight" as const, commit: "sha" }]]),
    };
    const trail = resolveMasterRedCommitTrail(
      { subject: "Revert \"hotfix(#6255): algo\"", body: "This reverts commit abc1234." },
      ctx,
    );
    assert.equal(trail, "continuo", "trailer de revert (a) deve vencer sobre o marcador de issue (b), mesmo os dois sendo resolvíveis");
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
    const metrics = computeMasterRedAttribution(commits, ctx, true);
    assert.equal(metrics.find((m) => m.trail === "continuo")!.count, 1);
    assert.equal(metrics.find((m) => m.trail === "desconhecida")!.count, 1);
    // total de commits classificados como master-red deve ser 2 (o "feat normal" não conta)
    assert.equal(metrics.reduce((s, m) => s + (m.count ?? 0), 0), 2);
  });

  it("commitsFetchOk: false -> TODAS as trilhas voltam count null, nunca 0 (review PR #6855, P1: git log falhou não pode virar 'checamos, deu zero')", () => {
    const ctx = { revertedShaToTrail: new Map(), issueOrigemByNumber: new Map() };
    const commits = [{ subject: "Revert algo", body: "This reverts commit abc." }];
    const metrics = computeMasterRedAttribution(commits, ctx, false);
    for (const m of metrics) assert.equal(m.count, null, `trilha ${m.trail} deveria ser null quando a fonte falhou`);
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
    const metrics = computeFindingDensity(bodies, merged, true);
    const continuo = metrics.find((m) => m.trail === "continuo")!;
    assert.equal(continuo.findings, 2);
    assert.equal(continuo.density, 0.2);
    const develop = metrics.find((m) => m.trail === "develop")!;
    assert.equal(develop.merged_prs, 0);
    assert.equal(develop.density, null, "sem PR mergeada na janela, density é null (não divisão por zero)");
  });

  it("issuesFetchOk: false -> findings/density viram null pra TODA trilha, mesmo com merged_prs disponível (review PR #6855, P1 — o achado mais perigoso: density:0.00 lê como 'trilha limpa')", () => {
    const merged = { continuo: 10, overnight: 5, develop: 3, other: 1 };
    const metrics = computeFindingDensity(["<!-- origem: pr=1 trilha=continuo commit=a -->"], merged, false);
    for (const m of metrics) {
      assert.equal(m.findings, null, `trilha ${m.trail}: findings deveria ser null`);
      assert.equal(m.density, null, `trilha ${m.trail}: density deveria ser null`);
    }
    // merged_prs continua vindo da fonte independente (não zera junto)
    assert.equal(metrics.find((m) => m.trail === "continuo")!.merged_prs, 10);
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
      dailyReviewIssuesFetchOk: true,
      masterRedCommits: [{ subject: "hotfix(#1) urgente", body: "" }],
      masterRedCommitsFetchOk: true,
      masterRedResolutionCtx: { revertedShaToTrail: new Map(), issueOrigemByNumber: new Map() },
      warnings: ["aviso de teste"],
    };
    const report = buildTrackQualityReport(raw, "30d", { rows: [], ok: false, warning: "chave ausente" }, null);
    assert.equal(report.since, "30d");
    assert.equal(report.warnings.length, 2);
    assert.equal(report.rework.length, 4);
    assert.equal(report.master_red.length, 5); // 4 trilhas + desconhecida
    assert.equal(report.finding_density.length, 4);
    assert.equal(report.closed_without_merge.length, 4);
    assert.equal(report.cost.available, false);

    const table = renderTrackQualityTable(report);
    assert.match(table, /track-quality-report/);
    assert.match(table, /Avisos \(seções degradadas\)/);
    assert.match(table, /aviso de teste/);
  });

  it("fontes indisponíveis (git log E [daily-review] falharam) -> master_red.count e finding_density.density viram null, NUNCA 0, e a tabela imprime 'n/a' (não '0')", () => {
    const raw = {
      mergedPrs: [pr({ number: 1, headRefName: "continuo/fix-1", body: "Closes #1" })],
      closedPrs: [] as ClosedPrRecord[],
      dailyReviewIssueBodies: [],
      dailyReviewIssuesFetchOk: false,
      masterRedCommits: [],
      masterRedCommitsFetchOk: false,
      masterRedResolutionCtx: { revertedShaToTrail: new Map(), issueOrigemByNumber: new Map() },
      warnings: ["git log falhou", "[daily-review] issues falhou"],
    };
    const report = buildTrackQualityReport(raw, null, { rows: [], ok: false, warning: "chave ausente" }, null);
    for (const m of report.master_red) assert.equal(m.count, null);
    for (const f of report.finding_density) {
      assert.equal(f.findings, null);
      assert.equal(f.density, null);
    }
    const table = renderTrackQualityTable(report);
    assert.doesNotMatch(table, /\tcontinuo\t0\n/, "count null não pode imprimir como 0 na tabela");
    assert.match(table, /n\/a/);
  });

  it("retrospectivo: reconstrução aproximada do achado real do #6752 (retrabalho continuo >> overnight) — âncora contra regressão silenciosa da métrica 1", () => {
    // Não são os números exatos da auditoria de 29/08 (73/286 PRs reais não
    // cabem num fixture de teste) — é uma reconstrução PROPORCIONAL: mesma
    // ORDEM DE GRANDEZA de retrabalho (continuo bem mais alto que
    // overnight), suficiente pra travar que um refactor futuro não inverta
    // silenciosamente a atribuição "trilha da 1ª PR" ou a contagem de
    // retrabalho (test-analyzer, PR #6855, P2).
    const mergedPrs: MergedPrRecord[] = [];
    // continuo: 10 issues, 3 com retrabalho (~30%, mesma ordem do 23,3% real)
    for (let i = 1; i <= 10; i++) {
      mergedPrs.push(pr({ number: 1000 + i, headRefName: "continuo/fix-a", mergedAt: `2026-08-0${(i % 9) + 1}T00:00:00Z`, body: `Closes #${i}` }));
      if (i <= 3) mergedPrs.push(pr({ number: 2000 + i, headRefName: "continuo/fix-b", mergedAt: `2026-08-1${(i % 9) + 1}T00:00:00Z`, body: `Closes #${i}` }));
    }
    // overnight: 10 issues, 1 com retrabalho (~10%, mesma ordem do 9,8% real)
    for (let i = 101; i <= 110; i++) {
      mergedPrs.push(pr({ number: 3000 + i, headRefName: "overnight/fix-a", mergedAt: `2026-08-0${(i % 9) + 1}T00:00:00Z`, body: `Closes #${i}` }));
      if (i === 101) mergedPrs.push(pr({ number: 4000 + i, headRefName: "overnight/fix-b", mergedAt: `2026-08-1${(i % 9) + 1}T00:00:00Z`, body: `Closes #${i}` }));
    }
    const rework = computeReworkRate(mergedPrs);
    const continuo = rework.find((r) => r.trail === "continuo")!;
    const overnight = rework.find((r) => r.trail === "overnight")!;
    assert.equal(continuo.issues_total, 10);
    assert.equal(continuo.issues_reworked, 3);
    assert.equal(overnight.issues_total, 10);
    assert.equal(overnight.issues_reworked, 1);
    assert.ok(continuo.rate! > overnight.rate!, "continuo deve ter taxa de retrabalho MAIOR que overnight, mesma direção medida em 29/08/2026 (#6752)");
  });
});

function activityRow(overrides: Partial<OpenRouterActivityRow>): OpenRouterActivityRow {
  return { date: "2026-08-20 00:00:00", model: "z-ai/glm-5.3-flash", usage: 0.1, requests: 5, prompt_tokens: 1000, completion_tokens: 100, ...overrides };
}

describe("computeCostByModel — métrica 5 (#6755)", () => {
  it("agrega por modelo, soma usage/requests/tokens, ordena por custo desc", () => {
    const rows = [
      activityRow({ date: "2026-08-20 00:00:00", model: "z-ai/glm-5.3-flash", usage: 0.1, requests: 5 }),
      activityRow({ date: "2026-08-21 00:00:00", model: "z-ai/glm-5.3-flash", usage: 0.2, requests: 3 }),
      activityRow({ date: "2026-08-20 00:00:00", model: "anthropic/claude-sonnet-5", usage: 5.0, requests: 1 }),
    ];
    const result = computeCostByModel(rows, null);
    assert.equal(result.length, 2);
    assert.equal(result[0].model, "anthropic/claude-sonnet-5", "modelo mais caro vem primeiro");
    assert.equal(result[1].model, "z-ai/glm-5.3-flash");
    assert.equal(result[1].usage_usd, 0.3);
    assert.equal(result[1].requests, 8);
  });

  it("filtra por sinceDate — linhas de dias ANTERIORES ao filtro são excluídas", () => {
    const rows = [
      activityRow({ date: "2026-08-01 00:00:00", usage: 100 }), // fora da janela
      activityRow({ date: "2026-08-25 00:00:00", usage: 1 }), // dentro
    ];
    const result = computeCostByModel(rows, new Date("2026-08-20T00:00:00Z"));
    assert.equal(result.length, 1);
    assert.equal(result[0].usage_usd, 1);
  });

  it("sinceDate no MESMO dia da linha (fronteira) inclui a linha — comparação por dia, não por instante", () => {
    const rows = [activityRow({ date: "2026-08-20 00:00:00", usage: 1 })];
    const result = computeCostByModel(rows, new Date("2026-08-20T18:00:00Z"));
    assert.equal(result.length, 1, "mesmo dia (18h > 00h) não deve excluir a linha — comparação é por YYYY-MM-DD, não por timestamp");
  });

  it("lista vazia -> lista vazia, nunca lança", () => {
    assert.deepEqual(computeCostByModel([], null), []);
  });
});

describe("maxActivityDate", () => {
  it("retorna o maior dia entre as linhas", () => {
    const rows = [activityRow({ date: "2026-08-10 00:00:00" }), activityRow({ date: "2026-08-25 00:00:00" }), activityRow({ date: "2026-08-15 00:00:00" })];
    assert.equal(maxActivityDate(rows), "2026-08-25");
  });

  it("lista vazia -> null", () => {
    assert.equal(maxActivityDate([]), null);
  });
});

describe("computeCostPerNonReworkedContinuoIssue", () => {
  const rework = (total: number, reworked: number): ReworkMetric => ({ trail: "continuo", issues_total: total, issues_reworked: reworked, rate: total > 0 ? reworked / total : null });

  it("custo total dividido por issues não-retrabalhadas (arredondado a 4 casas)", () => {
    assert.equal(computeCostPerNonReworkedContinuoIssue(100, rework(10, 3)), 14.2857);
  });

  it("totalUsd null -> null (custo indisponível)", () => {
    assert.equal(computeCostPerNonReworkedContinuoIssue(null, rework(10, 3)), null);
  });

  it("rework de continuo ausente -> null (nunca adivinha)", () => {
    assert.equal(computeCostPerNonReworkedContinuoIssue(100, undefined), null);
  });

  it("todas as issues foram retrabalhadas (denominador 0) -> null, nunca divisão por zero", () => {
    assert.equal(computeCostPerNonReworkedContinuoIssue(100, rework(3, 3)), null);
  });

  it("issues_total 0 (denominador 0 pelo outro lado) -> null", () => {
    assert.equal(computeCostPerNonReworkedContinuoIssue(100, rework(0, 0)), null);
  });
});

describe("fetchOpenRouterActivity — fail-soft (#6755)", () => {
  it("chave ausente -> ok:false, aviso explícito, nunca lança", async () => {
    const result = await fetchOpenRouterActivity(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.rows.length, 0);
    assert.match(result.warning!, /ausente/);
  });

  it("status != 200 (ex: 403 de chave de inferência) -> ok:false com dica sobre management key", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({}), { status: 403 })) as typeof fetch;
    const result = await fetchOpenRouterActivity("some-key", fakeFetch);
    assert.equal(result.ok, false);
    assert.match(result.warning!, /403/);
    assert.match(result.warning!, /management/i);
  });

  it("corpo sem campo data array -> ok:false, nunca lança sobre shape inesperado", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ oops: true }), { status: 200 })) as typeof fetch;
    const result = await fetchOpenRouterActivity("some-key", fakeFetch);
    assert.equal(result.ok, false);
  });

  it("200 com data válido -> ok:true, rows populado", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ data: [activityRow({})] }), { status: 200 })) as typeof fetch;
    const result = await fetchOpenRouterActivity("some-key", fakeFetch);
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);
  });

  it("fetch lança (rede fora do ar) -> ok:false, nunca propaga a exceção", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await fetchOpenRouterActivity("some-key", fakeFetch);
    assert.equal(result.ok, false);
    assert.match(result.warning!, /network down/);
  });
});

describe("buildTrackQualityReport — integração da métrica 5 (custo)", () => {
  const emptyRaw = {
    mergedPrs: [] as MergedPrRecord[],
    closedPrs: [] as ClosedPrRecord[],
    dailyReviewIssueBodies: [] as string[],
    dailyReviewIssuesFetchOk: true,
    masterRedCommits: [] as { subject: string; body: string }[],
    masterRedCommitsFetchOk: true,
    masterRedResolutionCtx: { revertedShaToTrail: new Map(), issueOrigemByNumber: new Map() },
    warnings: [] as string[],
  };

  it("custo indisponível (costFetch.ok=false) -> cost.available=false, sem total_usd fabricado, aviso propagado", () => {
    const report = buildTrackQualityReport(emptyRaw, null, { rows: [], ok: false, warning: "chave ausente" }, null);
    assert.equal(report.cost.available, false);
    assert.equal(report.cost.total_usd, null);
    assert.ok(report.warnings.includes("chave ausente"));
    const table = renderTrackQualityTable(report);
    assert.match(table, /indisponível nesta rodada/);
  });

  it("custo disponível -> total_usd somado, continuo_cost_per_nonreworked_issue calculado a partir da métrica 1", () => {
    const raw = {
      ...emptyRaw,
      mergedPrs: [
        { number: 1, headRefName: "continuo/fix-a", mergedAt: "2026-08-01T00:00:00Z", body: "Closes #1" },
        { number: 2, headRefName: "continuo/fix-b", mergedAt: "2026-08-02T00:00:00Z", body: "Closes #2" },
      ] as MergedPrRecord[],
    };
    const costFetch = { rows: [activityRow({ date: "2026-08-20 00:00:00", usage: 10 })], ok: true as const };
    const report = buildTrackQualityReport(raw, null, costFetch, null);
    assert.equal(report.cost.available, true);
    assert.equal(report.cost.total_usd, 10);
    // 2 issues continuo, 0 retrabalhadas -> denominador 2
    assert.equal(report.cost.continuo_cost_per_nonreworked_issue, 5);
  });

  it("max_date = hoje -> aviso de consolidação parcial aparece nos warnings", () => {
    const today = new Date().toISOString().slice(0, 10);
    const costFetch = { rows: [activityRow({ date: `${today} 00:00:00`, usage: 1 })], ok: true as const };
    const report = buildTrackQualityReport(emptyRaw, null, costFetch, null);
    assert.ok(report.warnings.some((w) => w.includes("parcialmente consolidado")));
  });
});
