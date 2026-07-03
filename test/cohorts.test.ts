import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TIER_TO_COHORT,
  COHORT_ASSINANTES_ATIVOS,
  COHORT_EX_ASSINANTES,
  COHORT_LEADS_CAUDAO,
  cohortFromTier,
  cohortFromSafra,
  cohortSendRank,
  cohortDisplayLabel,
  isKnownCohortSlug,
  isTestAccount,
} from "../scripts/lib/cohorts.ts";

// Oráculo LOCAL de `tierRank` (#2857 fase C — a função viveu exportada em
// clarice-segment.ts até a fase B, removida no cutover; o único consumidor de
// produção que ainda precisava dela, scripts/cohort-order-dryrun.ts, ganhou a
// própria cópia inline). Réplica idêntica só pra provar a propriedade de
// equivalência abaixo — não reimporta nada de produção.
function tierRank(t: number | null): number {
  return t == null ? Number.POSITIVE_INFINITY : t;
}

// ---------------------------------------------------------------------------
// cohortFromTier / TIER_TO_COHORT (#2857 fase A)
// ---------------------------------------------------------------------------

describe("cohortFromTier / TIER_TO_COHORT", () => {
  it("mapeia os 10 tiers pros slugs canônicos congelados", () => {
    assert.equal(cohortFromTier(1), COHORT_ASSINANTES_ATIVOS);
    assert.equal(cohortFromTier(2), COHORT_EX_ASSINANTES);
    assert.equal(cohortFromTier(3), "leads-2026-jan-abr");
    assert.equal(cohortFromTier(4), "leads-2025h2");
    assert.equal(cohortFromTier(5), "leads-2025h1");
    assert.equal(cohortFromTier(6), "leads-2024h2");
    assert.equal(cohortFromTier(7), "leads-2024h1");
    assert.equal(cohortFromTier(8), "leads-2023h2");
    assert.equal(cohortFromTier(9), "leads-2023h1");
    assert.equal(cohortFromTier(10), COHORT_LEADS_CAUDAO);
  });

  it("TIER_TO_COHORT tem exatamente as 10 chaves 1..10", () => {
    const keys = Object.keys(TIER_TO_COHORT).map(Number).sort((a, b) => a - b);
    assert.deepEqual(keys, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("tier null/undefined/desconhecido vira null", () => {
    assert.equal(cohortFromTier(null), null);
    assert.equal(cohortFromTier(undefined), null);
    assert.equal(cohortFromTier(99), null);
    assert.equal(cohortFromTier(0), null);
  });
});

// ---------------------------------------------------------------------------
// cohortFromSafra
// ---------------------------------------------------------------------------

describe("cohortFromSafra", () => {
  it("prefixa 'leads-' na safra canônica 'YYYY-MM'", () => {
    assert.equal(cohortFromSafra("2026-05"), "leads-2026-05");
    assert.equal(cohortFromSafra("2026-06"), "leads-2026-06");
    assert.equal(cohortFromSafra("2027-01"), "leads-2027-01");
  });
});

// ---------------------------------------------------------------------------
// cohortSendRank — ordem de 1º envio (#2857)
// ---------------------------------------------------------------------------

describe("cohortSendRank", () => {
  it("assinantes-ativos < ex-assinantes", () => {
    assert.ok(cohortSendRank(COHORT_ASSINANTES_ATIVOS) < cohortSendRank(COHORT_EX_ASSINANTES));
  });

  it("ex-assinantes < qualquer cohort de lead (safra mensal ou legado)", () => {
    assert.ok(cohortSendRank(COHORT_EX_ASSINANTES) < cohortSendRank("leads-2026-06"));
    assert.ok(cohortSendRank(COHORT_EX_ASSINANTES) < cohortSendRank("leads-2026-jan-abr"));
    assert.ok(cohortSendRank(COHORT_EX_ASSINANTES) < cohortSendRank("leads-2023h1"));
  });

  it("leads-caudao é o último cohort de lead nomeado (depois de qualquer leads-* reconhecido)", () => {
    assert.ok(cohortSendRank("leads-2026-06") < cohortSendRank(COHORT_LEADS_CAUDAO));
    assert.ok(cohortSendRank("leads-2023h1") < cohortSendRank(COHORT_LEADS_CAUDAO));
  });

  it("desconhecido/null fica depois de leads-caudao (fim absoluto da fila)", () => {
    assert.ok(cohortSendRank(COHORT_LEADS_CAUDAO) < cohortSendRank(null));
    assert.ok(cohortSendRank(COHORT_LEADS_CAUDAO) < cohortSendRank(undefined));
    assert.ok(cohortSendRank(COHORT_LEADS_CAUDAO) < cohortSendRank("cohort-que-nao-existe"));
  });

  it("intercalação: leads-2026-06 (safra) > leads-2026-jan-abr > leads-2025h2, por recência do início do período", () => {
    const r2606 = cohortSendRank("leads-2026-06");
    const rJanAbr = cohortSendRank("leads-2026-jan-abr");
    const r2025h2 = cohortSendRank("leads-2025h2");
    assert.ok(r2606 < rJanAbr, "safra jun/2026 é mais quente que o range jan-abr/2026");
    assert.ok(rJanAbr < r2025h2, "range jan-abr/2026 é mais quente que o semestre 2025-H2");
  });

  it("safras mensais futuras (sem lista hardcoded) ordenam por recência entre si", () => {
    assert.ok(cohortSendRank("leads-2027-01") < cohortSendRank("leads-2026-12"));
    assert.ok(cohortSendRank("leads-2026-08") < cohortSendRank("leads-2026-07"));
  });

  it("propriedade: pros 10 cohorts derivados de tier, a ordem relativa é IDÊNTICA a tierRank", () => {
    for (let i = 1; i <= 10; i++) {
      for (let j = 1; j <= 10; j++) {
        const tierSign = Math.sign(tierRank(i) - tierRank(j));
        const cohortSign = Math.sign(
          cohortSendRank(cohortFromTier(i)) - cohortSendRank(cohortFromTier(j)),
        );
        assert.equal(
          cohortSign,
          tierSign,
          `tier ${i} vs tier ${j}: tierRank diz ${tierSign}, cohortSendRank diz ${cohortSign}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// cohortDisplayLabel — rótulo pt-BR
// ---------------------------------------------------------------------------

describe("cohortDisplayLabel", () => {
  it("assinantes-ativos / ex-assinantes / leads-caudao têm rótulo fixo (#2880: sem 'Leads')", () => {
    assert.equal(cohortDisplayLabel(COHORT_ASSINANTES_ATIVOS), "Assinantes ativos");
    assert.equal(cohortDisplayLabel(COHORT_EX_ASSINANTES), "Ex-assinantes");
    assert.equal(cohortDisplayLabel(COHORT_LEADS_CAUDAO), "Caudão");
  });

  it("safra mensal 'leads-YYYY-MM' vira '{mês-abrev}/{ano}' (#2880: sem prefixo 'Leads')", () => {
    assert.equal(cohortDisplayLabel("leads-2026-06"), "jun/2026");
    assert.equal(cohortDisplayLabel("leads-2026-01"), "jan/2026");
    assert.equal(cohortDisplayLabel("leads-2026-12"), "dez/2026");
  });

  it("semestre legado 'leads-YYYYhN' vira 'YYYY-HN' (#2880: sem 'Leads')", () => {
    assert.equal(cohortDisplayLabel("leads-2025h2"), "2025-H2");
    assert.equal(cohortDisplayLabel("leads-2023h1"), "2023-H1");
  });

  it("range legado 'leads-YYYY-mon-mon' vira 'mon-mon/YYYY' (#2880: sem 'Leads')", () => {
    assert.equal(cohortDisplayLabel("leads-2026-jan-abr"), "jan-abr/2026");
  });

  it("null/undefined vira 'sem cohort'", () => {
    assert.equal(cohortDisplayLabel(null), "sem cohort");
    assert.equal(cohortDisplayLabel(undefined), "sem cohort");
  });

  it("forma corrompida/desconhecida devolve a chave crua (nunca lança)", () => {
    assert.equal(cohortDisplayLabel("lixo"), "lixo");
    assert.equal(cohortDisplayLabel("leads-2026-13"), "leads-2026-13"); // mês inválido
  });

  it("aceita defensivamente a safra crua legada 'YYYY-MM' (sem prefixo leads-)", () => {
    assert.equal(cohortDisplayLabel("2026-06"), "jun/2026");
  });

  it("todos os 10 cohorts derivados de tier têm rótulo pt-BR (nunca passthrough acidental)", () => {
    for (let t = 1; t <= 10; t++) {
      const slug = cohortFromTier(t)!;
      const label = cohortDisplayLabel(slug);
      assert.notEqual(label, slug, `tier ${t} (${slug}) deveria ter rótulo != slug cru`);
    }
  });
});

// ---------------------------------------------------------------------------
// isKnownCohortSlug — #2857 fase B (resolveCohortArg em clarice-segment.ts
// consome isto pra aceitar o slug canônico direto em --cohort)
// ---------------------------------------------------------------------------

describe("isKnownCohortSlug", () => {
  it("os 10 slugs derivados de tier são reconhecidos", () => {
    for (let t = 1; t <= 10; t++) {
      assert.ok(isKnownCohortSlug(cohortFromTier(t)!), `tier ${t} deveria ser reconhecido`);
    }
  });

  it("qualquer safra mensal 'leads-YYYY-MM' (passada ou futura, sem lista hardcoded) é reconhecida", () => {
    assert.ok(isKnownCohortSlug("leads-2026-06"));
    assert.ok(isKnownCohortSlug("leads-2030-01"));
    assert.ok(isKnownCohortSlug(cohortFromSafra("2027-12")));
  });

  it("slug inventado ou forma crua (sem prefixo leads-) NÃO é reconhecido", () => {
    assert.equal(isKnownCohortSlug("cohort-que-nao-existe"), false);
    assert.equal(isKnownCohortSlug("2026-06"), false, "safra crua pré-#2857 não é o slug canônico");
    assert.equal(isKnownCohortSlug(""), false);
  });
});

// ---------------------------------------------------------------------------
// isTestAccount (#2895) — exclusão PERMANENTE de contas de teste do editor
// (plus-addressing `vjpixel+test*@gmail.com`), distinta de INTERNAL_EMAILS
// (que MANTÉM no store, só exclui de agregações).
// ---------------------------------------------------------------------------

describe("isTestAccount", () => {
  it("casa vjpixel+test2@gmail.com (achado real do incidente 260703)", () => {
    assert.equal(isTestAccount("vjpixel+test2@gmail.com"), true);
  });

  it("casa vjpixel+teste4@gmail.com (variante 'teste', não só 'test')", () => {
    assert.equal(isTestAccount("vjpixel+teste4@gmail.com"), true);
  });

  it("casa test3/test5 (demais achados do incidente) e é case-insensitive", () => {
    assert.equal(isTestAccount("vjpixel+test3@gmail.com"), true);
    assert.equal(isTestAccount("vjpixel+test5@gmail.com"), true);
    assert.equal(isTestAccount("VJPixel+Test99@Gmail.com"), true);
    assert.equal(isTestAccount("  vjpixel+test2@gmail.com  "), true, "trim");
  });

  it("NÃO casa vjpixel@gmail.com — é o interno REAL (INTERNAL_EMAILS), não uma conta de teste", () => {
    assert.equal(isTestAccount("vjpixel@gmail.com"), false);
  });

  it("NÃO casa email normal nem outro plus-suffix do mesmo dono", () => {
    assert.equal(isTestAccount("leitor@example.com"), false);
    assert.equal(isTestAccount("vjpixel+newsletter@gmail.com"), false);
    assert.equal(isTestAccount("naotem+test@gmail.com"), false, "prefixo local diferente de vjpixel");
  });
});
