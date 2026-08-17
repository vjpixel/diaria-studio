/**
 * test/check-campaign-docs-sync.test.ts (#5559)
 *
 * Regressão pura pra `scripts/check-campaign-docs-sync.ts` — nenhum teste
 * aqui chama `gh` de verdade nem toca disco; `evaluateDocSync`/`reportForDoc`/
 * `exitCodeForReports` recebem conteúdo/decisão já resolvidos, no mesmo
 * padrão de `test/issue-decisions.test.ts`.
 *
 * Cobre a lista pedida pela issue #5559 (item 3 da unidade):
 *   - marcador em dia -> exit 0
 *   - marcador desatualizado -> exit 1 + mensagem clara
 *   - marcador ausente -> aviso, não trava (exit 0)
 *   - decisão sem marcador formal -> fail-soft com aviso (exit 0)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSyncMarker,
  evaluateDocSync,
  reportForDoc,
  exitCodeForReports,
  CAMPAIGN_DOCS,
  type DocSyncResult,
} from "../scripts/check-campaign-docs-sync.ts";
import type { IssueDecision } from "../scripts/lib/issue-decisions.ts";

function decision(overrides: Partial<IssueDecision> = {}): IssueDecision {
  return {
    decided_at: "2026-08-17T15:42:02Z",
    pergunta: "Qual orçamento/dia do teste de 3 canais?",
    resposta: "R$ 100/dia × 15 dias (R$ 1.500/braço)",
    sessao: "develop",
    ...overrides,
  };
}

const marker = (issue: number, revisedAt: string) =>
  `<!-- sincronizado-com: #${issue} (revisão de ${revisedAt}) -->\n\n# Doc\n\nconteúdo qualquer.`;

describe("CAMPAIGN_DOCS", () => {
  it("lista os 4 docs operacionais do teste de 3 canais 2608", () => {
    assert.equal(CAMPAIGN_DOCS.length, 4);
    for (const p of CAMPAIGN_DOCS) {
      assert.match(p, /^data\/aquisicao\/campanhas-260816\//);
    }
  });
});

describe("parseSyncMarker", () => {
  it("extrai issue + timestamp de um marcador bem formado", () => {
    assert.deepEqual(parseSyncMarker(marker(5524, "2026-08-17T15:42:02Z")), {
      issue: 5524,
      revisedAt: "2026-08-17T15:42:02Z",
    });
  });

  it("retorna null quando não há marcador", () => {
    assert.equal(parseSyncMarker("# Doc sem marcador\n\nconteúdo."), null);
  });

  it("retorna null quando o timestamp está vazio", () => {
    assert.equal(parseSyncMarker("<!-- sincronizado-com: #5524 (revisão de ) -->"), null);
  });

  it("aceita acento em 'revisão' (grafia sem acento também casa)", () => {
    assert.deepEqual(
      parseSyncMarker("<!-- sincronizado-com: #5524 (revisao de 2026-08-17T15:42:02Z) -->"),
      { issue: 5524, revisedAt: "2026-08-17T15:42:02Z" },
    );
  });
});

describe("evaluateDocSync", () => {
  it("marcador em dia (mesmo timestamp da decisão) -> ok", () => {
    const content = marker(5524, "2026-08-17T15:42:02Z");
    const result = evaluateDocSync(content, decision({ decided_at: "2026-08-17T15:42:02Z" }));
    assert.equal(result.status, "ok");
  });

  it("marcador MAIS RECENTE que a decisão -> ok", () => {
    const content = marker(5524, "2026-08-17T16:00:00Z");
    const result = evaluateDocSync(content, decision({ decided_at: "2026-08-17T15:42:02Z" }));
    assert.equal(result.status, "ok");
  });

  it("marcador desatualizado (mais antigo que a revisão mais recente) -> stale", () => {
    const content = marker(5524, "2026-08-16T10:00:00Z");
    const result = evaluateDocSync(content, decision({ decided_at: "2026-08-17T15:42:02Z" }));
    assert.deepEqual(result, {
      status: "stale",
      issue: 5524,
      markerRevisedAt: "2026-08-16T10:00:00Z",
      decidedAt: "2026-08-17T15:42:02Z",
    });
  });

  it("marcador ausente -> no-marker (não lança)", () => {
    const result = evaluateDocSync("# Doc sem marcador", decision());
    assert.deepEqual(result, { status: "no-marker" });
  });

  it("decisão sem marcador formal (null) -> no-formal-decision, fail-soft", () => {
    const content = marker(5524, "2026-08-17T10:00:00Z");
    const result = evaluateDocSync(content, null);
    assert.deepEqual(result, {
      status: "no-formal-decision",
      issue: 5524,
      markerRevisedAt: "2026-08-17T10:00:00Z",
    });
  });
});

describe("reportForDoc", () => {
  it("ok -> level ok, mensagem menciona a issue", () => {
    const result: DocSyncResult = {
      status: "ok",
      issue: 5524,
      markerRevisedAt: "2026-08-17T15:42:02Z",
      decidedAt: "2026-08-17T15:42:02Z",
    };
    const report = reportForDoc("data/aquisicao/campanhas-260816/00-PROTOCOLO.md", result);
    assert.equal(report.level, "ok");
    assert.match(report.message, /#5524/);
  });

  it("stale -> level error, mensagem tem ALTO e pede repropagação", () => {
    const result: DocSyncResult = {
      status: "stale",
      issue: 5524,
      markerRevisedAt: "2026-08-16T10:00:00Z",
      decidedAt: "2026-08-17T15:42:02Z",
    };
    const report = reportForDoc("data/aquisicao/campanhas-260816/10-google.md", result);
    assert.equal(report.level, "error");
    assert.match(report.message, /ALTO/);
    assert.match(report.message, /[Rr]epropague/);
  });

  it("no-marker -> level warn, não error", () => {
    const report = reportForDoc("data/aquisicao/campanhas-260816/20-microsoft.md", {
      status: "no-marker",
    });
    assert.equal(report.level, "warn");
  });

  it("no-formal-decision -> level warn, não error (fail-soft)", () => {
    const report = reportForDoc("data/aquisicao/campanhas-260816/30-meta.md", {
      status: "no-formal-decision",
      issue: 5524,
      markerRevisedAt: "2026-08-17T10:00:00Z",
    });
    assert.equal(report.level, "warn");
  });
});

describe("exitCodeForReports", () => {
  it("todos ok -> exit 0", () => {
    const reports = [
      reportForDoc("a.md", { status: "ok", issue: 1, markerRevisedAt: "x", decidedAt: "x" }),
      reportForDoc("b.md", { status: "ok", issue: 1, markerRevisedAt: "x", decidedAt: "x" }),
    ];
    assert.equal(exitCodeForReports(reports), 0);
  });

  it("1+ stale entre outros ok -> exit 1", () => {
    const reports = [
      reportForDoc("a.md", { status: "ok", issue: 1, markerRevisedAt: "x", decidedAt: "x" }),
      reportForDoc("b.md", {
        status: "stale",
        issue: 1,
        markerRevisedAt: "2026-08-16T00:00:00Z",
        decidedAt: "2026-08-17T00:00:00Z",
      }),
    ];
    assert.equal(exitCodeForReports(reports), 1);
  });

  it("só avisos (no-marker / no-formal-decision) -> exit 0, não trava", () => {
    const reports = [
      reportForDoc("a.md", { status: "no-marker" }),
      reportForDoc("b.md", { status: "no-formal-decision", issue: 1, markerRevisedAt: "x" }),
    ];
    assert.equal(exitCodeForReports(reports), 0);
  });

  it("lista vazia -> exit 0", () => {
    assert.equal(exitCodeForReports([]), 0);
  });
});
