/**
 * test/weekly-linkedin-select.test.ts (#4456)
 *
 * Seleção por clique da newsletter semanal do LinkedIn — cobre os 3 pontos
 * exigidos pelo dispatch da issue:
 *   1. Matéria mais clicada (não a manchete) vence quando aplicável.
 *   2. Exclusão de links comerciais/próprios funciona (nunca entram no
 *      ranking, mesmo com clique alto).
 *   3. Desempate por critério editorial quando a diferença está dentro do
 *      ruído de 1 clique (ângulo Brasil > implicação profissional >
 *      diversidade de categoria).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WeeklyRawCandidate } from "../scripts/lib/weekly-linkedin-parse.ts";
import { normalizeUrl } from "../scripts/lib/weekly-linkedin-clicks.ts";
import {
  toRankedCandidate,
  withinClickNoise,
  hasBrazilAngle,
  hasProfessionalImplication,
  editorialTiebreakScore,
  computeHeadlineCap,
  selectHeadlines,
  selectUseMelhor,
  dedupeCandidatesByUrl,
  applyPendingPicks,
  type WeeklyRankedCandidate,
} from "../scripts/lib/weekly-linkedin-select.ts";

function raw(overrides: Partial<WeeklyRawCandidate> = {}): WeeklyRawCandidate {
  return {
    editionDate: "260728",
    url: "https://exemplo.com/artigo",
    title: "Título do artigo",
    body: "Corpo do artigo.",
    why: "",
    kind: "section",
    category: "RADAR",
    section: "radar",
    ...overrides,
  };
}

/** Constrói um candidato ranqueado direto (sem passar por toRankedCandidate) — atalho pros testes de tiebreak/noise. */
function ranked(
  overrides: Partial<WeeklyRawCandidate> & { clicks: number; opens: number; excluded?: boolean; hasClickData?: boolean },
): WeeklyRankedCandidate {
  const { clicks, opens, excluded, hasClickData, ...rawOverrides } = overrides;
  const r = raw(rawOverrides);
  const rc = toRankedCandidate(r, { uniqueVerifiedClicks: clicks, webUniqueClicks: 0 }, opens, hasClickData);
  return excluded !== undefined ? { ...rc, excluded } : rc;
}

describe("toRankedCandidate", () => {
  it("calcula ratePct = cliques totais / aberturas * 100", () => {
    const c = toRankedCandidate(raw(), { uniqueVerifiedClicks: 4, webUniqueClicks: 1 }, 200);
    assert.equal(c.ratePct, 2.5); // 5/200*100
  });

  it("ratePct é 0 quando não há aberturas (evita divisão por zero)", () => {
    const c = toRankedCandidate(raw(), { uniqueVerifiedClicks: 4, webUniqueClicks: 0 }, 0);
    assert.equal(c.ratePct, 0);
  });

  it("marca excluded=true pra link comercial/próprio", () => {
    const c = toRankedCandidate(raw({ url: "https://livros.diar.ia.br" }), { uniqueVerifiedClicks: 100, webUniqueClicks: 0 }, 200);
    assert.equal(c.excluded, true);
  });

  it("hasClickData default é true quando omitido (#4489 finding 1)", () => {
    const c = toRankedCandidate(raw(), { uniqueVerifiedClicks: 4, webUniqueClicks: 0 }, 200);
    assert.equal(c.hasClickData, true);
  });

  it("hasClickData=false quando explicitado (post ausente do cache Beehiiv)", () => {
    const c = toRankedCandidate(raw(), { uniqueVerifiedClicks: 0, webUniqueClicks: 0 }, 0, false);
    assert.equal(c.hasClickData, false);
  });
});

describe("selectHeadlines — matéria mais clicada vence, não a manchete (achado real de julho/2026 do #4456)", () => {
  it("RADAR mais clicado bate o DESTAQUE 1 quando a diferença NÃO está dentro do ruído", () => {
    // Reproduz a edição de 22/07 do comentário do #4456: a manchete do dia
    // (Gemini trio) teve ZERO clique enquanto um item de RADAR teve 6/548.
    const d1 = ranked({
      kind: "destaque",
      section: "destaque",
      category: "🚀 LANÇAMENTO",
      title: "IA no Brasil: mercado de trabalho",
      url: "https://exemplo.com/gemini-trio",
      clicks: 0,
      opens: 200,
    });
    const radarWinner = ranked({
      kind: "section",
      section: "radar",
      category: "RADAR",
      title: "IA responde por 47% das vendas no WhatsApp",
      url: "https://exemplo.com/whatsapp-vendas",
      clicks: 6,
      opens: 200,
    });
    const result = selectHeadlines([d1, radarWinner], 1);
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].url, radarWinner.url);
    assert.equal(result.selected[0].section, "radar");
  });

  it("2 destaques + 1 item de seção — os 2 de maior taxa vencem, ignorando a ORDEM de publicação", () => {
    const d1 = ranked({ kind: "destaque", title: "D1", url: "https://exemplo.com/d1", clicks: 1, opens: 200 }); // 0.5%
    const d2 = ranked({ kind: "destaque", title: "D2", url: "https://exemplo.com/d2", clicks: 8, opens: 200 }); // 4%
    const radar = ranked({ kind: "section", title: "Radar", url: "https://exemplo.com/radar", clicks: 6, opens: 200 }); // 3%
    const result = selectHeadlines([d1, d2, radar], 2);
    assert.deepEqual(result.selected.map((c) => c.url), [d2.url, radar.url]);
  });
});

describe("selectHeadlines — Use Melhor nunca vira manchete (#4492)", () => {
  it("candidato use_melhor com a MAIOR taxa da semana NÃO é selecionado como manchete, mesmo batendo destaque/radar", () => {
    const d1 = ranked({ kind: "destaque", section: "destaque", title: "D1", url: "https://exemplo.com/d1", clicks: 1, opens: 200 }); // 0.5%
    const radar = ranked({ kind: "section", section: "radar", title: "Radar", url: "https://exemplo.com/radar", clicks: 3, opens: 200 }); // 1.5%
    const useMelhorWinner = ranked({
      kind: "section",
      section: "use_melhor",
      category: "USE MELHOR",
      title: "Tutorial imbatível de clique",
      url: "https://exemplo.com/tutorial-imbativel",
      clicks: 50,
      opens: 200,
    }); // 25% — maior taxa da semana, de longe
    const result = selectHeadlines([d1, radar, useMelhorWinner], 2);
    assert.deepEqual(
      result.selected.map((c) => c.url),
      [radar.url, d1.url],
    );
    assert.ok(!result.selected.some((c) => c.url === useMelhorWinner.url));
  });

  it("candidato use_melhor excluído do pool de manchete continua elegível pro bloco Use Melhor dedicado", () => {
    const radar = ranked({ kind: "section", section: "radar", title: "Radar", url: "https://exemplo.com/radar", clicks: 3, opens: 200 });
    const useMelhorWinner = ranked({
      kind: "section",
      section: "use_melhor",
      title: "Tutorial imbatível de clique",
      url: "https://exemplo.com/tutorial-imbativel",
      clicks: 50,
      opens: 200,
    });
    const headlineResult = selectHeadlines([radar, useMelhorWinner], 1);
    const headlineUrls = new Set(headlineResult.selected.map((c) => normalizeUrl(c.url)));
    const useMelhorPick = selectUseMelhor([radar, useMelhorWinner], headlineUrls);
    assert.equal(useMelhorPick?.url, useMelhorWinner.url);
  });

  it("use_melhor não aparece em `headlineEligible` (auditoria do pool de manchete) nem em `selected`", () => {
    const useMelhorOnly = ranked({ kind: "section", section: "use_melhor", url: "https://exemplo.com/tutorial", clicks: 10, opens: 100 });
    const result = selectHeadlines([useMelhorOnly], 3);
    assert.equal(result.selected.length, 0);
    assert.ok(!result.headlineEligible.some((c) => c.url === useMelhorOnly.url));
  });

  it("shortfall de manchetes conta separadamente use_melhor reservado vs. exclusão comercial (achado #4507)", () => {
    const useMelhorOnly = ranked({ kind: "section", section: "use_melhor", url: "https://exemplo.com/tutorial", clicks: 10, opens: 100 });
    const commercial = ranked({ kind: "section", url: "https://apoia.se/diaria", clicks: 10, opens: 100 });
    const result = selectHeadlines([useMelhorOnly, commercial], 2);
    assert.equal(result.selected.length, 0);
    const shortfallWarning = result.warnings.find((w) => /^Só \d+\/\d+ candidatos elegíveis/.test(w));
    assert.ok(shortfallWarning, result.warnings.join(" | "));
    assert.match(shortfallWarning!, /1 exclu[ií]do\(s\) por comercial\/própria/);
    assert.match(shortfallWarning!, /1 reservado\(s\) pro bloco Use Melhor/);
  });
});

describe("selectHeadlines — exclusão comercial/própria", () => {
  it("link comercial com clique altíssimo NUNCA aparece selecionado, mesmo sendo o mais clicado bruto", () => {
    // prepara.com.br (Divulgação, 6 cliques, o MAIS clicado de julho) do comentário do #4456.
    const divulgacao = ranked({
      kind: "section",
      title: "Prepara IA — curso parceiro",
      url: "https://apoia.se/diaria",
      clicks: 100,
      opens: 200,
    });
    const materia = ranked({
      kind: "section",
      title: "Matéria real",
      url: "https://exemplo.com/materia-real",
      clicks: 3,
      opens: 200,
    });
    const result = selectHeadlines([divulgacao, materia], 2);
    assert.deepEqual(result.selected.map((c) => c.url), [materia.url]);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].url, divulgacao.url);
  });
});

describe("withinClickNoise", () => {
  it("diferença menor que 1 clique equivalente é ruído (dentro da banda)", () => {
    // 13/07 do comentário do #4456: 120 aberturas → 1 clique = 0,83pp.
    const a = ranked({ url: "https://exemplo.com/a", clicks: 5, opens: 120 }); // 4.1666%
    const b = ranked({ url: "https://exemplo.com/b", clicks: 4, opens: 120 }); // 3.3333%
    assert.ok(withinClickNoise(a, b)); // diff = 0.8333pp < 0.8333...pp (1/120*100) — dentro
  });

  it("diferença maior que 1 clique equivalente NÃO é ruído", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 10, opens: 120 }); // 8.333%
    const b = ranked({ url: "https://exemplo.com/b", clicks: 4, opens: 120 }); // 3.333%
    assert.ok(!withinClickNoise(a, b));
  });

  it("opens=0 em qualquer lado desativa a banda de ruído (comparação estrita)", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 0, opens: 0 });
    const b = ranked({ url: "https://exemplo.com/b", clicks: 0, opens: 200 });
    assert.ok(withinClickNoise(a, b)); // ambos ratePct=0 → iguais
    const c = ranked({ url: "https://exemplo.com/c", clicks: 5, opens: 200 });
    assert.ok(!withinClickNoise(a, c));
  });
});

describe("selectHeadlines — empate genuíno vs. ausência de dado (#4489 finding 1 item 3, #5109: banda maior que as vagas vira pendingGroup)", () => {
  it("2 candidatos ratePct=0 por AUSÊNCIA de dado (hasClickData=false) — banda > vaga vira pendingGroup, warning NÃO fala em 'empate genuíno'", () => {
    const gapA = ranked({
      title: "Matéria da edição sem post no cache A",
      url: "https://exemplo.com/gap-a",
      editionDate: "260728",
      clicks: 0,
      opens: 0,
      hasClickData: false,
    });
    const gapB = ranked({
      title: "Matéria da edição sem post no cache B",
      url: "https://exemplo.com/gap-b",
      editionDate: "260729",
      clicks: 0,
      opens: 0,
      hasClickData: false,
    });
    const result = selectHeadlines([gapA, gapB], 1);
    assert.equal(result.selected.length, 0);
    assert.equal(result.pendingGroup?.length, 2);
    assert.equal(result.pendingSlots, 1);
    assert.ok(result.warnings.some((w) => /ausência de dado real|não é empate genuíno|NÃO é empate genuíno/i.test(w)), result.warnings.join(" | "));
    assert.ok(!result.warnings.some((w) => /^\d+ candidatos empatados/.test(w) && !/NÃO é empate genuíno/.test(w)), result.warnings.join(" | "));
    // a mensagem cita a(s) edição(ões) sem dado — não deixa a causa implícita.
    assert.ok(result.warnings.some((w) => w.includes("260728") || w.includes("260729")));
  });

  it("2 candidatos com ratePct=0 genuíno (hasClickData=true — post existe mas 0 abertura de verdade) — banda > vaga vira pendingGroup com o texto de empate genuíno", () => {
    const realZeroA = ranked({
      title: "Post real com zero abertura A",
      url: "https://exemplo.com/real-zero-a",
      clicks: 0,
      opens: 0,
      hasClickData: true,
    });
    const realZeroB = ranked({
      title: "Post real com zero abertura B",
      url: "https://exemplo.com/real-zero-b",
      clicks: 0,
      opens: 0,
      hasClickData: true,
    });
    const result = selectHeadlines([realZeroA, realZeroB], 1);
    assert.equal(result.selected.length, 0);
    assert.equal(result.pendingGroup?.length, 2);
    assert.ok(result.warnings.some((w) => /candidatos empatados/.test(w) && /escolha manual/.test(w)), result.warnings.join(" | "));
    assert.ok(!result.warnings.some((w) => /não é empate genuíno/i.test(w)));
  });

  it("empate dentro do ruído com dado real (opens>0 nos dois lados) — banda > vaga vira pendingGroup", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 5, opens: 120, hasClickData: true }); // 4.1666%
    const b = ranked({ url: "https://exemplo.com/b", clicks: 4, opens: 120, hasClickData: true }); // 3.3333%
    const result = selectHeadlines([a, b], 1);
    assert.equal(result.selected.length, 0);
    assert.deepEqual(result.pendingGroup?.map((c) => c.url).sort(), [a.url, b.url].sort());
    assert.ok(result.warnings.some((w) => /candidatos empatados/.test(w) && /escolha manual/.test(w)));
    assert.ok(!result.warnings.some((w) => /não é empate genuíno/i.test(w)));
  });

  it("banda empatada que CABE nas vagas restantes é incluída inteira, SEM pendingGroup (não há escolha real a fazer)", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 5, opens: 120, hasClickData: true }); // 4.1666%
    const b = ranked({ url: "https://exemplo.com/b", clicks: 4, opens: 120, hasClickData: true }); // 3.3333% — dentro do ruído de a
    const result = selectHeadlines([a, b], 2);
    assert.equal(result.pendingGroup, null);
    assert.equal(result.pendingSlots, 0);
    assert.deepEqual(result.selected.map((c) => c.url).sort(), [a.url, b.url].sort());
    assert.ok(result.warnings.some((w) => /cabem todos nas vagas restantes/.test(w)));
  });
});

describe("hasBrazilAngle / hasProfessionalImplication", () => {
  it("detecta ângulo Brasil por palavra-chave/domínio .br", () => {
    const br = ranked({ title: "Empregos no Brasil somem com automação", url: "https://g1.globo.com/x", clicks: 1, opens: 100 });
    const intl = ranked({ title: "OpenAI launches new model", url: "https://openai.com/blog/x", clicks: 1, opens: 100 });
    assert.ok(hasBrazilAngle(br));
    assert.ok(!hasBrazilAngle(intl));
  });

  it("detecta implicação profissional por palavra-chave", () => {
    const job = ranked({ title: "Vaga de emprego exige certificação em IA", clicks: 1, opens: 100 });
    const other = ranked({ title: "Novo modelo de imagem lançado", clicks: 1, opens: 100 });
    assert.ok(hasProfessionalImplication(job));
    assert.ok(!hasProfessionalImplication(other));
  });
});

describe("editorialTiebreakScore — ordem lexicográfica (Brasil > profissional > diversidade)", () => {
  it("ângulo Brasil sozinho supera implicação profissional + diversidade combinados", () => {
    const brOnly = ranked({ title: "Notícia no Brasil, sem termo de carreira", category: "X", clicks: 1, opens: 100 });
    const profDiversityOnly = ranked({ title: "Vaga de emprego internacional", category: "Y", clicks: 1, opens: 100 });
    const scoreBr = editorialTiebreakScore(brOnly, new Set());
    const scoreProfDiv = editorialTiebreakScore(profDiversityOnly, new Set());
    assert.ok(scoreBr > scoreProfDiv);
  });
});

describe("selectHeadlines — dentro do ruído de 1 clique, CTOR não decide sozinho (#5109: escolha vai pro gate, editorialTiebreakScore vira só dica exibida)", () => {
  it("dentro do ruído, nenhum dos dois vence automaticamente — os 2 vão pro pendingGroup pro editor escolher", () => {
    const intlSlightlyHigher = ranked({
      title: "OpenAI ships new safety report",
      url: "https://openai.com/safety",
      category: "PESQUISA",
      clicks: 5,
      opens: 120, // 4.1666%
    });
    const brSlightlyLower = ranked({
      title: "Empresa brasileira usa IA para prever safra no Brasil",
      url: "https://exemplo.com.br/safra",
      category: "AGRO",
      clicks: 4,
      opens: 120, // 3.3333% — diff 0.8333pp < 1-click band (0.8333...pp) → ruído
    });
    const result = selectHeadlines([intlSlightlyHigher, brSlightlyLower], 1);
    assert.equal(result.selected.length, 0);
    assert.equal(result.pendingGroup?.length, 2);
    assert.equal(result.pendingSlots, 1);
    assert.ok(result.warnings.some((w) => /empat/i.test(w)));
    // editorialTiebreakScore segue disponível como DICA (não decide mais
    // automaticamente) — quem quiser mostrar "ângulo Brasil favorece X" no
    // gate calcula isto por fora, sobre o pendingGroup.
    const scoreBr = editorialTiebreakScore(brSlightlyLower, new Set());
    const scoreIntl = editorialTiebreakScore(intlSlightlyHigher, new Set());
    assert.ok(scoreBr > scoreIntl);
  });
});

describe("computeHeadlineCap — semana curta (feriado) reduz o número de manchetes", () => {
  it("5 edições → cap 3 (normal)", () => assert.equal(computeHeadlineCap(5), 3));
  it("4 edições → cap 3 (ainda o teto)", () => assert.equal(computeHeadlineCap(4), 3));
  it("2 edições (feriado) → cap 2, nunca puxa da semana anterior", () => assert.equal(computeHeadlineCap(2), 2));
  it("0 edições → cap 0", () => assert.equal(computeHeadlineCap(0), 0));
});

describe("selectUseMelhor", () => {
  it("escolhe o candidato use_melhor de maior taxa, excluindo URLs já usadas como manchete", () => {
    const um1 = ranked({ section: "use_melhor", title: "Tutorial A", url: "https://exemplo.com/tutorial-a", clicks: 8, opens: 200 });
    const um2 = ranked({ section: "use_melhor", title: "Tutorial B", url: "https://exemplo.com/tutorial-b", clicks: 3, opens: 200 });
    const excludeSet = new Set([normalizeUrl(um1.url)]);
    const winner = selectUseMelhor([um1, um2], excludeSet);
    assert.equal(winner?.url, um2.url);
  });

  it("retorna undefined quando não há candidato use_melhor elegível", () => {
    const radar = ranked({ section: "radar", url: "https://exemplo.com/radar", clicks: 5, opens: 100 });
    assert.equal(selectUseMelhor([radar], new Set()), undefined);
  });
});

describe("applyPendingPicks (#5109)", () => {
  it("resolve o pendingGroup com as escolhas do editor, na ordem informada", () => {
    const a = ranked({ title: "A", url: "https://exemplo.com/a", clicks: 1, opens: 100 });
    const b = ranked({ title: "B", url: "https://exemplo.com/b", clicks: 1, opens: 100 });
    const c = ranked({ title: "C", url: "https://exemplo.com/c", clicks: 1, opens: 100 });
    const already = [ranked({ title: "Já decidido", url: "https://exemplo.com/x", clicks: 10, opens: 100 })];
    const result = applyPendingPicks(already, [a, b, c], 2, [b.url, a.url]);
    assert.equal(result.error, null);
    assert.deepEqual(result.selected.map((s) => s.url), [already[0].url, b.url, a.url]);
  });

  it("erro explícito quando a contagem de --picks não bate com pendingSlots", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 1, opens: 100 });
    const b = ranked({ url: "https://exemplo.com/b", clicks: 1, opens: 100 });
    const result = applyPendingPicks([], [a, b], 1, [a.url, b.url]);
    assert.ok(result.error);
    assert.match(result.error!, /exatamente 1/);
  });

  it("erro explícito quando uma URL não pertence ao pendingGroup", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 1, opens: 100 });
    const b = ranked({ url: "https://exemplo.com/b", clicks: 1, opens: 100 });
    const result = applyPendingPicks([], [a, b], 1, ["https://exemplo.com/fora-do-grupo"]);
    assert.ok(result.error);
    assert.match(result.error!, /fora do grupo empatado/);
  });

  it("erro explícito quando --picks repete a mesma URL", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 1, opens: 100 });
    const b = ranked({ url: "https://exemplo.com/b", clicks: 1, opens: 100 });
    const result = applyPendingPicks([], [a, b], 2, [a.url, a.url]);
    assert.ok(result.error);
    assert.match(result.error!, /repetida/);
  });

  it("compara URLs por normalização (mesma URL com barra final/maiúscula ainda resolve)", () => {
    const a = ranked({ url: "https://exemplo.com/a", clicks: 1, opens: 100 });
    const result = applyPendingPicks([], [a], 1, ["https://exemplo.com/a/"]);
    assert.equal(result.error, null);
    assert.equal(result.selected[0]?.url, a.url);
  });
});

describe("dedupeCandidatesByUrl", () => {
  it("mantém a versão 'destaque' (corpo completo) quando a mesma URL aparece também como item de seção", () => {
    const asSection = ranked({ kind: "section", url: "https://exemplo.com/dup", body: "Descrição curta.", clicks: 3, opens: 100 });
    const asDestaque = ranked({ kind: "destaque", url: "https://exemplo.com/dup", body: "Corpo completo do destaque.", clicks: 3, opens: 100 });
    const out = dedupeCandidatesByUrl([asSection, asDestaque]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "destaque");
  });
});
