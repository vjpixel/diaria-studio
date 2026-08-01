/**
 * test/brevo-dashboard-link-secao-4405.test.ts (#4405)
 *
 * Três pedidos do editor sobre a área "Links mais clicados" do dashboard
 * Clarice (aba Visão Geral):
 *   1. A coluna "Seção" NUNCA exibe "—" (era o comportamento padrão desde o
 *      #4184 — este PR troca o catch-all por "Outros" e adiciona uma camada
 *      de taxonomia não-editorial ANTES dele).
 *   2. Nova tabela "Seções mais clicadas" — agrupa os cliques por seção.
 *   3. "Links mais clicados" passa a cobrir só a ÚLTIMA EDIÇÃO (ciclo de
 *      conteúdo inteiro, todas as ondas), mantendo a tabela histórica.
 *
 * Causas-raiz investigadas ao vivo (260731, ver comentário na issue #4405):
 *   - RC1: nomes reais de campanha (`Diar.ia Mensal {AAMM}`/`Clarice {AAMM}
 *     grupo:`) não eram reconhecidos por `parseClariceCampaignKey` — a chave
 *     `secao:{ciclo}` nunca era buscada pra essas campanhas.
 *   - RC2: o relink (#4048) reescreve os links dos Destaques pra
 *     `diar.ia.br/p/{slug}`, mas o mapa de seção era construído com a URL de
 *     FONTE do `prioritized.md` — Destaques nunca batia.
 *   - RC3: links estruturalmente fora do `prioritized.md` (enquete, Clarice,
 *     produtos, apoio, redes) sempre caíam em "—".
 *   - Achado extra (posterior à abertura da issue): o NOME de uma campanha
 *     pode mentir sobre o ciclo — `Clarice {AAMM} grupo:novos` pode carregar
 *     o conteúdo do ciclo ANTERIOR quando o digest do mês corrente ainda não
 *     estava pronto no momento do envio. Resolver o ciclo só pelo nome erra
 *     nesses casos — a correção é desambiguar pelo CONTEÚDO (cobertura de
 *     URLs de clique contra os mapas já carregados).
 *
 * Segue o mesmo padrão de fixture do #4184/#4198 (test/brevo-dashboard-link-
 * section-4184.test.ts, test/brevo-dashboard-link-titles-4198.test.ts): NUNCA
 * lê `data/` real em tempo de teste — `node --test` roda arquivos em
 * paralelo e um `data/` transitório correria contra `exec-mode.ts` em outro
 * arquivo. Fixtures de `prioritized.md` são strings inline; os caminhos
 * felizes de `buildRelinkedContentAliases`/`loadLinkSectionMapForCycle`
 * (que fazem I/O de verdade) são cobertos indiretamente pelas camadas PURAS
 * (`applyRelinkedContentAliases` etc.) — mesma decisão de design do #4198.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extractMonthlyCycleCandidate,
  resolveCampaignCycle,
  collectMonthlyLinkCycles,
  selectLatestEditionCampaigns,
  deriveLinksSectionTitle,
  renderAggregatedLinksSection,
  renderSectionClicksSection,
  aggregateClicksBySection,
  aggregateLinksAcrossCampaigns,
  lookupLinkSectionCell,
  formatNonEditorialLinkSectionCell,
  LINK_SECTION_FALLBACK_LABEL,
  LINK_SECTION_LABELS,
  NON_EDITORIAL_LINK_SECTION_LABELS,
  renderDashboardHtml,
  type LinkSectionMap,
  type AggregatedLinkRow,
} from "../workers/brevo-dashboard/src/index.ts";
import { classifyNonEditorialLinkSection, classifyLinkContent } from "../workers/brevo-dashboard/src/link-content.ts";
import {
  applyRelinkedContentAliases,
  applyRelinkedTitleAliases,
  buildRelinkedContentAliases,
} from "../scripts/lib/mensal/monthly-link-sections.ts";
import { yymmToCycle } from "../scripts/lib/mensal/monthly-paths.ts";

// ─── Fase 0: extractMonthlyCycleCandidate / resolveCampaignCycle ───────────

describe("extractMonthlyCycleCandidate (#4405)", () => {
  test("Clarice News {AAMM-MM} — {cell} já vem no formato do KV, devolvido direto", () => {
    assert.equal(extractMonthlyCycleCandidate("Clarice News 2606-07 — B · dom"), "2606-07");
  });

  test("Diar.ia Mensal {AAMM} — resolve pra yymmToCycle(AAMM), mesma regra da lib real (paridade)", () => {
    const got = extractMonthlyCycleCandidate("Diar.ia Mensal 2606 — envio 7 (ramp-warm qua 22/07)");
    assert.equal(got, yymmToCycle("2606"));
    assert.equal(got, "2606-07");
  });

  test("Clarice {AAMM} grupo:{key} — resolve pra yymmToCycle(AAMM), mesma regra da lib real (paridade)", () => {
    const got = extractMonthlyCycleCandidate("Clarice 2607 grupo:novos-260731");
    assert.equal(got, yymmToCycle("2607"));
    assert.equal(got, "2607-08");
  });

  test("virada de ano: Diar.ia Mensal 2612 → yymmToCycle('2612') = '2612-01' (dez→jan)", () => {
    assert.equal(extractMonthlyCycleCandidate("Diar.ia Mensal 2612 — envio 3"), yymmToCycle("2612"));
  });

  test("campanha DIÁRIA (Clarice News {AAMM} d{NN}) nunca é candidata mensal → null", () => {
    assert.equal(extractMonthlyCycleCandidate("Clarice News 2605 d03-A (sex)"), null);
  });

  test("nome não reconhecido por nenhum dos 3 formatos → null", () => {
    assert.equal(extractMonthlyCycleCandidate("T1-W1 digest"), null);
    assert.equal(extractMonthlyCycleCandidate(""), null);
  });
});

describe("collectMonthlyLinkCycles (#4405 — reconhece Diar.ia Mensal / Clarice grupo:)", () => {
  test("dedup de candidatos entre os 3 formatos mensais + exclui diária", () => {
    const names = [
      { name: "Clarice News 2606-07 — B · dom" },
      { name: "Diar.ia Mensal 2606 — envio 7 (ramp-warm qua 22/07)" }, // mesmo ciclo, formato diferente
      { name: "Clarice 2606 grupo:envio11" }, // mesmo ciclo, 3º formato
      { name: "Clarice 2607 grupo:novos-260731" }, // ciclo NOMINALMENTE diferente
      { name: "Clarice News 2605 d03-A (sex)" }, // diária — nunca entra
    ];
    const cycles = collectMonthlyLinkCycles(names);
    assert.deepEqual([...cycles].sort(), ["2606-07", "2607-08"]);
  });
});

describe("resolveCampaignCycle (#4405, achado do grupo:novos)", () => {
  // Chaves derivadas via classifyLinkContent (mesma função que resolveCampaignCycle
  // usa internamente) — nunca hand-typed, pra não divergir do cálculo real.
  const URL_A = "https://site.com/artigo-real-do-mes-passado";
  const URL_B = "https://outrosite.com/x";
  const contentA = classifyLinkContent(URL_A).content;
  const contentB = classifyLinkContent(URL_B).content;
  const mapCycleA: LinkSectionMap = { [contentA]: ["destaques"] };
  const mapCycleB: LinkSectionMap = { [contentB]: ["radar"] };

  test("sem candidato de nome (campanha diária) → null, mesmo com mapas disponíveis", () => {
    assert.equal(
      resolveCampaignCycle("Clarice News 2605 d03-A (sex)", { "https://x.com": 1 }, { "2606-07": mapCycleA }),
      null,
    );
  });

  test("candidato de nome sem sectionMapsByCycle/linksStats → devolve o candidato como está", () => {
    assert.equal(resolveCampaignCycle("Diar.ia Mensal 2606 — envio 7", null, null), "2606-07");
    assert.equal(resolveCampaignCycle("Diar.ia Mensal 2606 — envio 7", { "https://x.com": 1 }, null), "2606-07");
  });

  test("achado real: nome aponta pro ciclo errado, conteúdo do clique desambigua pro ciclo certo", () => {
    const linksStats = { [URL_A]: 12 };
    // candidato do nome seria "2607-08" (yymmToCycle('2607')), mas o conteúdo
    // clicado só existe no mapa de "2606-07" — desempate pelo conteúdo vence.
    const resolved = resolveCampaignCycle(
      "Clarice 2607 grupo:novos-260731",
      linksStats,
      { "2606-07": mapCycleA, "2607-08": {} },
    );
    assert.equal(resolved, "2606-07");
  });

  test("empate (0 cobertura em TODOS os ciclos) → fica o candidato do nome, nunca inventa", () => {
    const linksStats = { "https://site-nunca-visto-em-nenhum-mapa.com/x": 5 };
    const resolved = resolveCampaignCycle(
      "Clarice 2607 grupo:novos-260731",
      linksStats,
      { "2606-07": mapCycleA, "2607-08": mapCycleB },
    );
    assert.equal(resolved, "2607-08"); // candidato do nome, não inventado
  });

  test("candidato do nome também está entre os ciclos disponíveis e cobre — usa ele mesmo sem trocar", () => {
    const linksStats = { [URL_B]: 3 };
    const resolved = resolveCampaignCycle(
      "Diar.ia Mensal 2606 — envio 7",
      linksStats,
      { "2606-07": mapCycleB },
    );
    assert.equal(resolved, "2606-07");
  });
});

// ─── Fase 1: alias de relink (RC2) + taxonomia não-editorial (RC3) + "nunca traço" ─

describe("applyRelinkedContentAliases / applyRelinkedTitleAliases (#4405, RC2 — puro, sem I/O)", () => {
  test("URL de fonte com seção conhecida → a URL relinkada ganha a MESMA seção", () => {
    const sourceUrl = "https://exame.com/inteligencia-artificial/materia";
    const relinkedUrl = "https://diar.ia.br/p/materia-relinkada";
    const sourceContent = classifyLinkContent(sourceUrl).content;
    const relinkedContent = classifyLinkContent(relinkedUrl).content;

    const map: LinkSectionMap = { [sourceContent]: ["destaques"] };
    const aliases = new Map([[sourceUrl, relinkedUrl]]);

    const out = applyRelinkedContentAliases(map, aliases);
    assert.deepEqual(out[relinkedContent], ["destaques"]);
    assert.deepEqual(out[sourceContent], ["destaques"], "entrada original preservada");
  });

  test("nunca sobrescreve uma entrada JÁ existente pro conteúdo relinkado", () => {
    const sourceUrl = "https://exame.com/a";
    const relinkedUrl = "https://diar.ia.br/p/b";
    const sourceContent = classifyLinkContent(sourceUrl).content;
    const relinkedContent = classifyLinkContent(relinkedUrl).content;

    const map: LinkSectionMap = { [sourceContent]: ["destaques"], [relinkedContent]: ["radar"] };
    const out = applyRelinkedContentAliases(map, new Map([[sourceUrl, relinkedUrl]]));
    assert.deepEqual(out[relinkedContent], ["radar"], "não pisa em entrada própria já existente");
  });

  test("URL de fonte SEM entrada no mapa → nenhum alias criado (nada a propagar)", () => {
    const out = applyRelinkedContentAliases({}, new Map([["https://x.com/a", "https://diar.ia.br/p/b"]]));
    assert.deepEqual(out, {});
  });

  test("applyRelinkedTitleAliases espelha o mesmo comportamento pro mapa de título (#4198)", () => {
    const sourceUrl = "https://exame.com/materia";
    const relinkedUrl = "https://diar.ia.br/p/materia-relinkada";
    const sourceContent = classifyLinkContent(sourceUrl).content;
    const relinkedContent = classifyLinkContent(relinkedUrl).content;

    const titleMap: Record<string, string> = { [sourceContent]: "Título editorial da matéria" };
    const out = applyRelinkedTitleAliases(titleMap, new Map([[sourceUrl, relinkedUrl]]));
    assert.equal(out[relinkedContent], "Título editorial da matéria");
  });
});

describe("buildRelinkedContentAliases (#4405 — I/O fail-soft, mesmo padrão de loadLinkSectionMapForCycle)", () => {
  test("diretório sem raw-destaques.json/posts index → Map vazio, nunca lança", () => {
    assert.doesNotThrow(() => {
      const aliases = buildRelinkedContentAliases(["https://exame.com/x"], "/caminho/que/nao/existe/9911-12");
      assert.equal(aliases.size, 0);
    });
  });

  test("lista de URLs vazia → Map vazio, nunca lança", () => {
    assert.doesNotThrow(() => {
      const aliases = buildRelinkedContentAliases([], "/qualquer/coisa");
      assert.equal(aliases.size, 0);
    });
  });
});

describe("classifyNonEditorialLinkSection (#4405, RC3)", () => {
  test("enquete É IA?", () => {
    assert.equal(classifyNonEditorialLinkSection("https://eia.diar.ia.br/vote?edition=260731&choice=A"), "eia-poll");
    assert.equal(classifyNonEditorialLinkSection("https://poll.diaria.workers.dev/vote?choice=B"), "eia-poll");
  });

  test("Clarice afiliado", () => {
    assert.equal(classifyNonEditorialLinkSection("https://clarice.ai/?via=diaria"), "clarice-parceiro");
  });

  test("produtos Diar.ia: livros, cursos, home exata, Amazon", () => {
    assert.equal(classifyNonEditorialLinkSection("https://livros.diar.ia.br/algum-livro"), "produtos-diaria");
    assert.equal(classifyNonEditorialLinkSection("https://cursos.diar.ia.br/"), "produtos-diaria");
    assert.equal(classifyNonEditorialLinkSection("https://diar.ia.br/"), "produtos-diaria");
    assert.equal(classifyNonEditorialLinkSection("https://link.amazon/B0249coGp"), "produtos-diaria");
  });

  test("REGRESSÃO: artigo relinkado (diar.ia.br/p/{slug}) NUNCA é 'produtos-diaria' — só a home exata conta", () => {
    // Achado durante a implementação: uma versão inicial checava só o host
    // (diar.ia.br), sem exigir pathname "/" — isso classificava TODO
    // destaque relinkado como "Produtos Diar.ia" em vez de deixar a
    // resolução editorial (mapa de Destaques) vencer, mascarando o RC2.
    assert.equal(classifyNonEditorialLinkSection("https://diar.ia.br/p/algum-destaque-relinkado"), null);
    assert.equal(classifyNonEditorialLinkSection("https://www.diar.ia.br/p/outro?utm_source=clarice"), null);
  });

  test("apoio (apoia.se)", () => {
    assert.equal(classifyNonEditorialLinkSection("https://apoia.se/diaria"), "apoio");
  });

  test("redes sociais (linkedin/facebook/instagram, com e sem www)", () => {
    assert.equal(classifyNonEditorialLinkSection("https://www.linkedin.com/company/diaria"), "redes-sociais");
    assert.equal(classifyNonEditorialLinkSection("https://facebook.com/diaria"), "redes-sociais");
    assert.equal(classifyNonEditorialLinkSection("https://www.instagram.com/diaria"), "redes-sociais");
  });

  test("host desconhecido → null (cai no catch-all 'Outros' no caller)", () => {
    assert.equal(classifyNonEditorialLinkSection("https://exame.com/materia"), null);
    assert.equal(classifyNonEditorialLinkSection("não é uma url"), null);
  });
});

describe('lookupLinkSectionCell nunca retorna "—" (#4405, pedido central da issue)', () => {
  const NEVER_DASH = "—";

  test("bateria: editorial resolvido, não-editorial resolvido, e totalmente desconhecido — nenhum label é traço", () => {
    const editorialMap: LinkSectionMap = { "conteudo x (site.com)": ["destaques"] };
    const cases: Array<[string, LinkSectionMap | null, string]> = [
      ["conteudo x (site.com)", editorialMap, "https://site.com/x"], // editorial
      ["qualquer", null, "https://eia.diar.ia.br/vote?choice=A"], // não-editorial
      ["qualquer", editorialMap, "https://site-nunca-mapeado.com/y"], // catch-all
      ["qualquer", null, "https://site-nunca-mapeado.com/y"], // catch-all, sem mapa nenhum
    ];
    for (const [content, map, url] of cases) {
      const cell = lookupLinkSectionCell(content, map, url);
      assert.notEqual(cell.label, NEVER_DASH, `content=${content} url=${url} não pode virar "—"`);
      assert.ok(cell.label.length > 0, "label nunca vazio");
    }
  });

  test("sem URL (parâmetro omitido) — ainda assim nunca '—', cai direto no catch-all", () => {
    const cell = lookupLinkSectionCell("conteudo-sem-mapa", null);
    assert.equal(cell.label, LINK_SECTION_FALLBACK_LABEL);
    assert.notEqual(cell.label, NEVER_DASH);
  });

  test("LINK_SECTION_FALLBACK_LABEL não é mais o traço", () => {
    assert.equal(LINK_SECTION_FALLBACK_LABEL, "Outros");
  });

  test("render HTML de ponta a ponta (renderAggregatedLinksSection) — nenhuma célula link-section contém '—'", () => {
    const rows: AggregatedLinkRow[] = aggregateLinksAcrossCampaigns([
      {
        id: 1, name: "x", subject: "s", status: "sent",
        sentDate: "2026-07-31T09:00:00Z", scheduledAt: null, createdAt: "2026-07-31T09:00:00Z",
        recipients: { lists: [1] },
        statistics: {
          globalStats: undefined,
          linksStats: {
            "https://site-nunca-mapeado.com/materia": 10,
            "https://eia.diar.ia.br/vote?choice=A": 4,
            "https://apoia.se/diaria": 2,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ], null); // sectionMap NULO — pior caso possível
    const html = renderAggregatedLinksSection(rows, null);
    const dashCells = html.match(/<td class="link-section"[^>]*>([^<]*)</g) ?? [];
    assert.ok(dashCells.length >= 3, "deve ter pelo menos 3 linhas de Seção renderizadas");
    for (const cell of dashCells) {
      assert.ok(!cell.includes(">—<"), `célula não pode conter travessão isolado: ${cell}`);
    }
  });
});

// ─── Fase 2: "Seções mais clicadas" ─────────────────────────────────────────

describe("aggregateClicksBySection (#4405, Fase 2)", () => {
  function row(label: string, totalClicks: number): Pick<AggregatedLinkRow, "totalClicks" | "section"> {
    return { totalClicks, section: { label, tooltip: label } };
  }

  test("soma por seção bate EXATAMENTE com a soma de entrada — sem dupla contagem", () => {
    const rows = [row("Destaques", 30), row("Destaques", 10), row("Radar", 5), row("Outros", 2)];
    const sectionRows = aggregateClicksBySection(rows);
    const totalIn = rows.reduce((s, r) => s + r.totalClicks, 0);
    const totalOut = sectionRows.reduce((s, r) => s + r.totalClicks, 0);
    assert.equal(totalOut, totalIn);
  });

  test("ordenado por cliques DESC", () => {
    const rows = [row("Radar", 5), row("Destaques", 40)];
    const sectionRows = aggregateClicksBySection(rows);
    assert.deepEqual(sectionRows.map((r) => r.label), ["Destaques", "Radar"]);
  });

  test("isEditorial: true pras seções do prioritized.md, false pras demais", () => {
    const rows = [row("Destaques", 10), row("Enquete É IA?", 5), row("Outros", 1)];
    const sectionRows = aggregateClicksBySection(rows);
    const byLabel = Object.fromEntries(sectionRows.map((r) => [r.label, r.isEditorial]));
    assert.equal(byLabel["Destaques"], true);
    assert.ok(Object.values(LINK_SECTION_LABELS).includes("Destaques"));
    assert.equal(byLabel["Enquete É IA?"], false);
    assert.equal(byLabel["Outros"], false);
  });

  test("linha sem section (fixture manual) cai no catch-all, contentCount conta 1 por linha", () => {
    const rows = [{ totalClicks: 7 }, { totalClicks: 3 }];
    const sectionRows = aggregateClicksBySection(rows);
    assert.equal(sectionRows.length, 1);
    assert.equal(sectionRows[0].label, LINK_SECTION_FALLBACK_LABEL);
    assert.equal(sectionRows[0].contentCount, 2);
    assert.equal(sectionRows[0].totalClicks, 10);
    assert.equal(sectionRows[0].avgClicksPerContent, "5.0");
  });

  test("entrada vazia → array vazio", () => {
    assert.deepEqual(aggregateClicksBySection([]), []);
  });
});

describe("renderSectionClicksSection (#4405, Fase 2)", () => {
  test("vazio → stub gracioso, nunca lança", () => {
    assert.doesNotThrow(() => {
      const html = renderSectionClicksSection([], null);
      assert.match(html, /Sem dados de links disponíveis/);
    });
  });

  test("editorial em negrito, não-editorial sem negrito", () => {
    const rows = aggregateClicksBySection([
      { totalClicks: 10, section: { label: "Destaques", tooltip: "x" } },
      { totalClicks: 5, section: { label: "Apoio", tooltip: "x" } },
    ]);
    const html = renderSectionClicksSection(rows, "2606-07");
    assert.match(html, /<strong>Destaques<\/strong>/);
    assert.doesNotMatch(html, /<strong>Apoio<\/strong>/);
    assert.match(html, /Seções mais clicadas — edição 2606-07/);
  });
});

// ─── Fase 3: escopo por edição + fix do bug double-suffix ──────────────────

describe("selectLatestEditionCampaigns (#4405, Fase 3)", () => {
  function campaign(name: string, sentDate: string, urls: string[]) {
    const linksStats: Record<string, number> = {};
    for (const u of urls) linksStats[u] = 1;
    return {
      id: Math.random(), name, subject: "s", status: "sent",
      sentDate, scheduledAt: null, createdAt: sentDate,
      recipients: { lists: [1] },
      statistics: { globalStats: undefined, linksStats },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  test("agrupa TODAS as ondas do MESMO ciclo de conteúdo, não só a campanha mais recente isolada", () => {
    const campaigns = [
      campaign("Clarice News 2606-07 — A · dom", "2026-07-20T09:00:00Z", ["https://a.com/x"]),
      campaign("Diar.ia Mensal 2606 — envio 7 (ramp-warm)", "2026-07-22T09:00:00Z", ["https://a.com/x"]),
      campaign("Clarice News 2605-06 — B · dom", "2026-06-15T09:00:00Z", ["https://a.com/x"]), // ciclo diferente, mais antigo
    ];
    const result = selectLatestEditionCampaigns(campaigns, null);
    assert.ok(result);
    assert.equal(result!.cycle, "2606-07");
    assert.equal(result!.campaigns.length, 2);
  });

  test("desambigua pelo conteúdo (mesmo achado do grupo:novos) ao escolher a edição mais recente", () => {
    const url = "https://site.com/conteudo-real";
    const linkSectionsByCycle: Record<string, LinkSectionMap> = {
      "2606-07": { [classifyLinkContent(url).content]: ["destaques"] },
      "2607-08": {},
    };
    const campaigns = [
      campaign("Clarice News 2606-07 — A · dom", "2026-07-20T09:00:00Z", [url]),
      // sentDate MAIS recente, mas o NOME aponta pro ciclo errado (2607-08);
      // o conteúdo do clique é do 2606-07 de verdade.
      campaign("Clarice 2607 grupo:novos-260731", "2026-07-31T09:00:00Z", [url]),
    ];
    const result = selectLatestEditionCampaigns(campaigns, linkSectionsByCycle);
    assert.ok(result);
    assert.equal(result!.cycle, "2606-07");
    assert.equal(result!.campaigns.length, 2, "as 2 ondas devem ser agrupadas na mesma edição");
  });

  test("nenhuma campanha com ciclo resolvido → null (nunca lança)", () => {
    const campaigns = [campaign("Clarice News 2605 d03-A (sex)", "2026-06-13T09:00:00Z", [])];
    assert.equal(selectLatestEditionCampaigns(campaigns, null), null);
  });

  test("campanha sem sentDate é ignorada na seleção", () => {
    const withoutDate = campaign("Diar.ia Mensal 2606 — envio 1", "2026-07-01T09:00:00Z", []);
    withoutDate.sentDate = null;
    const result = selectLatestEditionCampaigns([withoutDate], null);
    assert.equal(result, null);
  });
});

describe("renderAggregatedLinksSection: idSuffix/envioCount (#4405, Fase 3)", () => {
  test("envioCount presente + campaignCount ausente → título 'da edição X (N envios)'", () => {
    const html = renderAggregatedLinksSection([], "2606-07", null, 3);
    assert.match(html, /Links mais clicados da edição 2606-07 \(3 envios\)/);
  });

  test("envioCount=1 → singular ('1 envio', não '1 envios')", () => {
    const html = renderAggregatedLinksSection([], "2606-07", null, 1);
    assert.match(html, /\(1 envio\)/);
    assert.doesNotMatch(html, /\(1 envios\)/);
  });

  test("campaignCount presente → título antigo prevalece (envioCount é ignorado)", () => {
    const html = renderAggregatedLinksSection([], "2606-07", 42, 3);
    assert.match(html, /janela de 42 campanhas/);
    assert.doesNotMatch(html, /envios\)/);
  });

  test("retrocompat: sem envioCount/idSuffix, comportamento e id idênticos ao anterior ao #4405", () => {
    const html = renderAggregatedLinksSection([], "2606-07");
    assert.match(html, /Links mais clicados da edição 2606-07</);
    assert.match(html, /id="links-agregados"/);
  });

  test("idSuffix evita <section id=> duplicado quando chamada 2× na mesma página", () => {
    const htmlEdicao = renderAggregatedLinksSection([], "2606-07", null, 2, "links-edicao");
    const htmlHistorico = renderAggregatedLinksSection([], "2606-07", 50);
    assert.match(htmlEdicao, /id="links-edicao"/);
    assert.match(htmlHistorico, /id="links-agregados"/);
    assert.notEqual(
      htmlEdicao.match(/id="([^"]+)"/)?.[1],
      htmlHistorico.match(/id="([^"]+)"/)?.[1],
    );
  });
});

describe("deriveLinksSectionTitle (#4405 — regressão do bug double-suffix + nova cobertura)", () => {
  test('REGRESSÃO: nome já no formato "AAMM-MM" não duplica o sufixo de mês (bug real: "2606-07-07")', () => {
    const campaigns = [{ name: "Clarice News 2606-07 — B · dom", sentDate: "2026-07-26T09:00:00Z" }];
    assert.equal(deriveLinksSectionTitle(campaigns), "2606-07");
  });

  test("formato diário (cycle 4 dígitos) continua com o append de mês de envio — comportamento preservado", () => {
    const campaigns = [{ name: "Clarice News 2605 d03-A (sex)", sentDate: "2026-06-13T09:00:00Z" }];
    assert.equal(deriveLinksSectionTitle(campaigns), "2605-06");
  });

  test("cobertura nova: só campanhas Diar.ia Mensal/grupo: (sem nenhuma Clarice News) — antes retornava null", () => {
    const campaigns = [{ name: "Diar.ia Mensal 2606 — envio 7 (ramp-warm)", sentDate: "2026-07-22T09:00:00Z" }];
    assert.equal(deriveLinksSectionTitle(campaigns), "2606-07");
  });

  test("nome não reconhecido por nenhum classificador → null (comportamento preservado)", () => {
    assert.equal(deriveLinksSectionTitle([{ name: "T1-W1 digest", sentDate: "2026-06-10T09:00:00Z" }]), null);
  });
});

// ─── E2E: renderDashboardHtml com os 3 pedidos juntos ───────────────────────

describe("renderDashboardHtml — integração dos 3 pedidos (#4405)", () => {
  function campaignFixture(name: string, sentDate: string, linksStats: Record<string, number>) {
    return {
      id: Math.floor(Math.random() * 1e6), name, subject: "s", status: "sent",
      sentDate, scheduledAt: null, createdAt: sentDate,
      recipients: { lists: [1] },
      statistics: {
        globalStats: { sent: 100, delivered: 98, hardBounces: 1, softBounces: 0, uniqueViews: 20, viewed: 22, trackableViews: 15, uniqueClicks: 5, clickers: 5, unsubscriptions: 0, complaints: 0, appleMppOpens: 3 },
        linksStats,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  test("edição detectada: aparecem as 2 tabelas novas + a histórica preservada, nenhum '—' na coluna Seção", () => {
    const materiaUrl = "https://site.com/materia-do-mes";
    const campaigns = [
      campaignFixture("Clarice News 2606-07 — A · dom", "2026-07-26T09:00:00Z", {
        [materiaUrl]: 20,
        "https://eia.diar.ia.br/vote?choice=A": 4,
      }),
    ];
    const html = renderDashboardHtml(campaigns, [], null, null, null, null, null, null, null, null, null, {
      linkSectionsByCycle: { "2606-07": { [classifyLinkContent(materiaUrl).content]: ["destaques"] } },
    });

    assert.match(html, /Seções mais clicadas — edição 2606-07/);
    assert.match(html, /Links mais clicados da edição 2606-07 \(1 envio\)/);
    assert.match(html, /Links mais clicados \(janela de 1 campanha\)/); // histórica preservada
    const dashCells = (html.match(/<td class="link-section"[^>]*>([^<]*)</g) ?? []).filter((c) => c.includes(">—<"));
    assert.deepEqual(dashCells, [], "nenhuma célula de Seção pode conter '—'");
  });

  test("sem edição detectável (nenhuma campanha com ciclo mensal) → só a tabela histórica, sem stub redundante", () => {
    const campaigns = [campaignFixture("Clarice News 2605 d03-A (sex)", "2026-06-13T09:00:00Z", { "https://x.com/y": 3 })];
    const html = renderDashboardHtml(campaigns);
    assert.doesNotMatch(html, /Seções mais clicadas/, "sem edição, a seção nova deve ficar OMITIDA, não um stub vazio");
    assert.match(html, /Links mais clicados/); // histórica ainda aparece (fallback "do período")
  });
});
