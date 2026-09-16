/**
 * test/dashboard-audience-ctr-regex-8149.test.ts (#8149)
 *
 * Regressão: `buildAudienceSummary` (`build-diaria-dashboard-data.ts`) faz
 * o parse das linhas de CTR por categoria via regex. Desde o #4840
 * (shrinkage empírico-Bayes), `update-audience.ts` emite cada linha com um
 * sufixo `(encolhida)` entre o valor de CTR e o `|` — o regex antigo não
 * tolerava esse sufixo e `ctr_by_category` vinha vazio em silêncio (fail-
 * soft, sem erro nem log) em TODA regeneração pós-#4840.
 *
 * As linhas de fixture aqui não são copiadas à mão: são produzidas por
 * `formatCtrCategoryLine`, a mesma função que `scripts/update-audience.ts`
 * usa pra montar `context/audience-profile.md` (#8149, "preferir um teste
 * que gere a linha a partir do próprio gerador"). Isso trava o parser
 * contra o formato REAL, não contra uma cópia que pode divergir de novo se
 * o gerador mudar sem que ninguém lembre de atualizar um fixture solto.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudienceSummary } from "../scripts/build-diaria-dashboard-data.ts";
import { formatCtrCategoryLine, shrinkCtr, type CtrAgg } from "../scripts/update-audience.ts";

function writeProfileFixture(dir: string, categoryLines: string[]): string {
  const path = join(dir, "audience-profile.md");
  writeFileSync(
    path,
    [
      "# Perfil de Audiência — diar.ia.br",
      "",
      "**updated_at:** 2026-09-15",
      "**subscribers ativos:** 626",
      "",
      "## 1. Engajamento real (CTR por categoria)",
      "",
      "Fonte primária: comportamento de 626 subscribers em 243 edições.",
      "CTR médio geral: 1.20%",
      "",
      "**Acima da média (IC95 exclui a média — sinal):**",
      "",
      ...categoryLines,
      "",
      "### Destaques por categoria + origem",
      "",
      "- **Impacto INT** — CTR 3.02% (encolhida) | 14 links",
    ].join("\n"),
    "utf8",
  );
  return path;
}

describe("buildAudienceSummary — regex tolera sufixo (encolhida) (#8149)", () => {
  it("casa uma linha real emitida por formatCtrCategoryLine (com sufixo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-audience-8149-"));
    try {
      const agg: CtrAgg = { count: 105, clicks: 42.7, opens: 4747 };
      const shrunk = shrinkCtr(agg.clicks, agg.opens, 0.012);
      const line = formatCtrCategoryLine("Impacto", agg, shrunk);

      assert.match(line, /\(encolhida\)/, "sanity: a linha gerada carrega o sufixo (senão o teste não testa nada)");

      const mdPath = writeProfileFixture(dir, [line]);
      const result = buildAudienceSummary(mdPath);

      assert.ok(result, "buildAudienceSummary não deve devolver null");
      assert.equal(result!.ctr_by_category.length, 1, "deve casar exatamente 1 categoria");
      assert.equal(result!.ctr_by_category[0].category, "Impacto");
      assert.equal(result!.ctr_by_category[0].link_count, 105);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("casa múltiplas categorias reais, sem vazar a subseção 'Destaques por categoria + origem'", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-audience-8149-"));
    try {
      const catA: CtrAgg = { count: 20, clicks: 8, opens: 500 };
      const catB: CtrAgg = { count: 41, clicks: 12, opens: 900 };
      const lineA = formatCtrCategoryLine("Treinamento", catA, shrinkCtr(catA.clicks, catA.opens, 0.012));
      const lineB = formatCtrCategoryLine("Lançamento", catB, shrinkCtr(catB.clicks, catB.opens, 0.012));

      const mdPath = writeProfileFixture(dir, [lineA, lineB]);
      const result = buildAudienceSummary(mdPath);

      assert.ok(result);
      assert.equal(result!.ctr_by_category.length, 2, "deve casar as 2 categorias diretas, nunca o combo da subseção seguinte");
      const cats = result!.ctr_by_category.map((r) => r.category);
      assert.ok(cats.includes("Treinamento"));
      assert.ok(cats.includes("Lançamento"));
      assert.ok(!cats.includes("Impacto INT"), "não deve vazar a linha da subseção 'Destaques por categoria + origem'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regressão de forma: sem o fix, o regex antigo (sem grupo opcional) não casaria nenhuma linha real", () => {
    // Reproduz o bug histórico como asserção negativa direta — o regex ANTIGO
    // (copiado aqui, não reimportado) nunca deve voltar a ser o comportamento.
    const oldRegex = /^-\s+\*\*([^*]+)\*\*\s+(?:—|-{1,2})\s+CTR\s+([\d.,]+)%\s+\|\s+(\d+)\s+links/i;
    const agg: CtrAgg = { count: 105, clicks: 42.7, opens: 4747 };
    const line = formatCtrCategoryLine("Impacto", agg, shrinkCtr(agg.clicks, agg.opens, 0.012));
    assert.equal(oldRegex.test(line), false, "sanity: confirma que o regex pré-#8149 de fato não casava a linha real (é esse o bug)");
  });
});
