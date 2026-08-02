/**
 * test/weekly-linkedin-render.test.ts (#4456)
 *
 * Renderização do artefato colável da newsletter semanal do LinkedIn —
 * cobre os pontos exigidos pelo dispatch:
 *   - título literal + numeração (única transformação permitida).
 *   - sem link por destaque (nenhum <a href> dentro do bloco da manchete).
 *   - UTMs corretas (source=linkedin, medium=newsletter, campaign=ln-{cycle},
 *     content=lista|cta-usemelhor|cta-fim — item-01/02/03 NÃO existem mais).
 *   - bloco USE MELHOR só renderiza com comentário do editor; ausente = bloco
 *     inteiro omitido.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderLinkedinWeeklyHtml,
  numberedTitle,
  buildLinkedinWeeklyUrl,
  linkedinWeeklyCampaign,
  endsInBareDomainLabel,
  LINKEDIN_WEEKLY_UTM_SOURCE,
  LINKEDIN_WEEKLY_UTM_MEDIUM,
  type WeeklyLinkedinRenderInput,
} from "../scripts/lib/weekly-linkedin-render.ts";

const BASE_INPUT: WeeklyLinkedinRenderInput = {
  cycle: "26w31",
  headlines: [
    { title: "Itaú corta 500 vagas com automação", body: "Corpo do D1, parágrafo único.", why: "Impacto no mercado brasileiro." },
    { title: "Professor flagra 90% da turma colando com IA", body: "Corpo do D2.", why: "" },
  ],
  useMelhor: undefined,
  restOfWeek: [
    { editionDate: "260729", title: "Título da edição de terça" },
    { editionDate: "260730", title: "Título da edição de quarta" },
  ],
  opening: "Essa semana teve empregos, educação e um flagrante de cola com IA.",
  closing: "É isso que a diar.ia.br cobre todo dia, sem enrolação.",
};

describe("numberedTitle", () => {
  it("prefixa o número — única transformação permitida sobre o título literal", () => {
    assert.equal(numberedTitle(1, "Título original"), "1. Título original");
    assert.equal(numberedTitle(3, "Outro título"), "3. Outro título");
  });
});

describe("renderLinkedinWeeklyHtml — título literal + numeração, sem link por destaque", () => {
  const result = renderLinkedinWeeklyHtml(BASE_INPUT);

  it("cada manchete aparece numerada e literal (sem reescrita)", () => {
    assert.match(result.html, /<h2>1\. Itaú corta 500 vagas com automação<\/h2>/);
    assert.match(result.html, /<h2>2\. Professor flagra 90% da turma colando com IA<\/h2>/);
  });

  it("corpo e 'por que importa' aparecem literais", () => {
    assert.match(result.html, /Corpo do D1, parágrafo único\./);
    assert.match(result.html, /Impacto no mercado brasileiro\./);
  });

  it("destaque SEM why (candidato de seção) não emite o rótulo 'Por que isso importa'", () => {
    const idx2 = result.html.indexOf("Professor flagra");
    const nextHr = result.html.indexOf("<hr/>", idx2);
    const segment = result.html.slice(idx2, nextHr);
    assert.ok(!/Por que isso importa/.test(segment));
  });

  it("nenhum bloco de manchete contém <a href> (link por destaque foi removido, #4456)", () => {
    const lastHeadlineEnd = result.html.indexOf("<hr/>", result.html.indexOf("<hr/>") + 1) + "<hr/>".length;
    const headlinesSegment = result.html.slice(0, lastHeadlineEnd);
    assert.ok(!/<a\s/i.test(headlinesSegment), headlinesSegment);
  });
});

describe("renderLinkedinWeeklyHtml — bloco USE MELHOR exige comentário do editor", () => {
  it("SEM comentário do editor (string vazia) — bloco inteiro omitido, mesmo com useMelhor presente", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: { title: "Tutorial X", url: "https://exemplo.com/tutorial", description: "Descrição.", editorComment: "" },
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.equal(result.useMelhorRendered, false);
    assert.ok(!/Use melhor/.test(result.html));
    assert.ok(result.warnings.some((w) => /comentário do editor ausente/i.test(w)));
  });

  it("comentário só com espaços em branco também omite o bloco", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: { title: "Tutorial X", url: "https://exemplo.com/tutorial", description: "Descrição.", editorComment: "   \n  " },
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.equal(result.useMelhorRendered, false);
  });

  it("COM comentário do editor — bloco renderiza com título/descrição/comentário + CTA de assinatura", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: {
        title: "Effort level no Claude Code",
        url: "https://exemplo.com/effort-level",
        description: "Tutorial de 5 minutos.",
        editorComment: "Testei essa semana e cortei uns 30% do tempo de setup.",
      },
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.equal(result.useMelhorRendered, true);
    assert.match(result.html, /Use melhor/);
    assert.match(result.html, /Effort level no Claude Code/);
    assert.match(result.html, /Testei essa semana e cortei uns 30% do tempo de setup\./);
    assert.match(result.html, /Receba todo dia, é grátis/);
  });
});

describe("renderLinkedinWeeklyHtml — lista do resto da semana", () => {
  it("cada edição não-manchete vira 1 item da lista com link pra edição", () => {
    const result = renderLinkedinWeeklyHtml(BASE_INPUT);
    assert.match(result.html, /Título da edição de terça/);
    assert.match(result.html, /Título da edição de quarta/);
    assert.match(result.html, /utm_content=lista/);
  });

  it("lista vazia não renderiza a seção 'Resto da semana'", () => {
    const input: WeeklyLinkedinRenderInput = { ...BASE_INPUT, restOfWeek: [] };
    const result = renderLinkedinWeeklyHtml(input);
    assert.ok(!/Resto da semana/.test(result.html));
  });
});

describe("UTM — contrato do #4456 (item-01/02/03 SAÍRAM)", () => {
  it("linkedinWeeklyCampaign monta ln-{cycle}", () => {
    assert.equal(linkedinWeeklyCampaign("26w31"), "ln-26w31");
  });

  it("buildLinkedinWeeklyUrl emite os 4 params exigidos, sem item-01/02/03", () => {
    const url = new URL(buildLinkedinWeeklyUrl("https://diar.ia.br", "26w31", "cta-fim"));
    assert.equal(url.searchParams.get("utm_source"), "linkedin");
    assert.equal(url.searchParams.get("utm_medium"), "newsletter");
    assert.equal(url.searchParams.get("utm_campaign"), "ln-26w31");
    assert.equal(url.searchParams.get("utm_content"), "cta-fim");
    assert.equal(LINKEDIN_WEEKLY_UTM_SOURCE, "linkedin");
    assert.equal(LINKEDIN_WEEKLY_UTM_MEDIUM, "newsletter");
  });

  it("CTAs do meio e do fim + lista usam utm_content correto no HTML final", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: {
        title: "Tutorial",
        url: "https://exemplo.com/tutorial",
        description: "Desc.",
        editorComment: "Comentário do editor.",
      },
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.match(result.html, /utm_content=cta-usemelhor/);
    assert.match(result.html, /utm_content=cta-fim/);
    assert.match(result.html, /utm_content=lista/);
    assert.ok(!/item-0[123]/.test(result.html), "item-01/02/03 não deve mais existir (#4456)");
  });
});

describe("endsInBareDomainLabel — texto de link nunca termina em domínio nu (achado operacional #4456)", () => {
  it("detecta rótulo terminando em domínio nu", () => {
    assert.ok(endsInBareDomainLabel("Assine em diar.ia.br"));
    assert.ok(endsInBareDomainLabel("diar.ia.br"));
  });

  it("não marca rótulo de ação (não termina em domínio)", () => {
    assert.ok(!endsInBareDomainLabel("Assine grátis →"));
    assert.ok(!endsInBareDomainLabel("Receba todo dia, é grátis →"));
  });

  it("os 2 CTAs fixos usados pelo render NUNCA terminam em domínio nu", () => {
    const result = renderLinkedinWeeklyHtml(BASE_INPUT);
    // Extrai os textos de link do HTML final e garante que nenhum termina em domínio nu.
    const linkTexts = [...result.html.matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    for (const text of linkTexts) {
      assert.ok(!endsInBareDomainLabel(text), `rótulo de link termina em domínio nu: "${text}"`);
    }
  });
});
