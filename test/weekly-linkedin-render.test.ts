/**
 * test/weekly-linkedin-render.test.ts (#4456)
 *
 * Renderização do artefato colável da newsletter semanal do LinkedIn —
 * cobre os pontos exigidos pelo dispatch:
 *   - título literal + numeração (única transformação permitida).
 *   - sem link por destaque (nenhum <a href> dentro do bloco da manchete).
 *   - UTMs corretas (source=linkedin, medium=newsletter, campaign=ln-{cycle},
 *     content=lista|cta-usemelhor|cta-fim — item-01/02/03 NÃO existem mais).
 *   - bloco USE MELHOR renderiza sempre que há candidato (com ou sem
 *     comentário do editor, #5970 — comentário virou opcional de verdade,
 *     não condição de existência do bloco).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderLinkedinWeeklyHtml,
  numberedTitle,
  buildLinkedinWeeklyUrl,
  linkedinWeeklyCampaign,
  endsInBareDomainLabel,
  headlineOriginLabel,
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
  weeklyEditions: [
    { editionDate: "260729", url: "https://diar.ia.br/p/titulo-da-edicao-de-terca", destaques: ["Título da edição de terça", "D2 de terça", "D3 de terça"] },
    { editionDate: "260730", url: "https://diar.ia.br/p/titulo-da-edicao-de-quarta", destaques: ["Título da edição de quarta"] },
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
    // A fatia começa na 1ª MANCHETE, não no índice 0: a abertura tem CTA de
    // assinatura próprio desde 260803, e ele não é "link por destaque" — medir a
    // partir do 0 transformaria esse invariante num falso positivo.
    const firstHeadline = result.html.indexOf("<h2>");
    const lastHeadlineEnd = result.html.indexOf("<hr/>", result.html.indexOf("<hr/>") + 1) + "<hr/>".length;
    assert.ok(firstHeadline >= 0 && lastHeadlineEnd > firstHeadline, "fatia de manchetes deve existir");
    const headlinesSegment = result.html.slice(firstHeadline, lastHeadlineEnd);
    assert.ok(!/<a\s/i.test(headlinesSegment), headlinesSegment);
  });
});

describe("headlineOriginLabel (#5109)", () => {
  it("formata AAMMDD como 'da edição de DD/MM'", () => {
    assert.equal(headlineOriginLabel("260803"), "da edição de 03/08");
    assert.equal(headlineOriginLabel("260112"), "da edição de 12/01");
  });
});

describe("renderLinkedinWeeklyHtml — linha 'da edição de DD/MM' sob cada manchete (#5109)", () => {
  it("com editionDate presente, a linha aparece logo abaixo do título, antes do corpo", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      headlines: [{ title: "Título com origem", body: "Corpo.", why: "", editionDate: "260803" }],
    };
    const html = renderLinkedinWeeklyHtml(input).html;
    const idxTitle = html.indexOf("<h2>1. Título com origem</h2>");
    const idxOrigin = html.indexOf("da edição de 03/08");
    const idxBody = html.indexOf("<p>Corpo.</p>");
    assert.ok(idxTitle >= 0 && idxOrigin >= 0 && idxBody >= 0);
    assert.ok(idxTitle < idxOrigin && idxOrigin < idxBody, "ordem esperada: título, origem, corpo");
  });

  it("sem editionDate (fixture antiga/omitido), a linha de proveniência não aparece — sem regressão pro caso sem o campo", () => {
    // Busca o fragmento HTML exato da linha (não texto solto "da edição de"
    // — "Edições da semana" lista destaques cujo título literal pode
    // conter esse texto por coincidência, ex: "Título da edição de terça"
    // em BASE_INPUT, sem relação com esta feature).
    const result = renderLinkedinWeeklyHtml(BASE_INPUT);
    assert.ok(!/<em>da edição de \d{2}\/\d{2}<\/em>/.test(result.html));
  });
});

describe("renderLinkedinWeeklyHtml — bloco USE MELHOR renderiza com OU sem comentário do editor (#5970)", () => {
  it("SEM comentário do editor (string vazia) — bloco renderiza mesmo assim, só sem o parágrafo de comentário", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: { title: "Tutorial X", url: "https://exemplo.com/tutorial", description: "Descrição.", editorComment: "" },
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.equal(result.useMelhorRendered, true);
    assert.match(result.html, /Use melhor/);
    assert.match(result.html, /Tutorial X/);
    assert.match(result.html, /Descrição\./);
    // banner de default aplicado (#5321) — nunca silencioso.
    assert.ok(result.warnings.some((w) => /comentário do editor ausente/i.test(w) && /#5970/.test(w)), result.warnings.join(" | "));
  });

  it("comentário só com espaços em branco também renderiza o bloco sem o parágrafo de comentário", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: { title: "Tutorial X", url: "https://exemplo.com/tutorial", description: "Descrição.", editorComment: "   \n  " },
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.equal(result.useMelhorRendered, true);
    assert.match(result.html, /Use melhor/);
    assert.ok(result.warnings.some((w) => /comentário do editor ausente/i.test(w)));
  });

  it("useMelhor ausente (nenhum candidato elegível) — bloco não renderiza, sem warning de comentário", () => {
    const input: WeeklyLinkedinRenderInput = { ...BASE_INPUT, useMelhor: undefined };
    const result = renderLinkedinWeeklyHtml(input);
    assert.equal(result.useMelhorRendered, false);
    assert.ok(!/Use melhor/.test(result.html));
    assert.ok(!result.warnings.some((w) => /comentário do editor ausente/i.test(w)));
  });

  it("COM comentário do editor — bloco renderiza com título/descrição/comentário + CTA de assinatura, sem warning de ausência", () => {
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
    assert.match(result.html, /Quero receber a edição diária/);
    assert.ok(!result.warnings.some((w) => /comentário do editor ausente/i.test(w)));
  });

  it("o CTA do Use Melhor é uma CHAMADA (frase + âncora), não um link solto (decisão do editor 260803)", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      useMelhor: {
        title: "Effort level no Claude Code",
        url: "https://exemplo.com/effort-level",
        description: "Tutorial de 5 minutos.",
        editorComment: "Testei essa semana e cortei uns 30% do tempo de setup.",
      },
    };
    const html = renderLinkedinWeeklyHtml(input).html;
    // A frase de contexto precede a âncora clicável — sem ela o leitor não sabe
    // o que ganha assinando, que é o ponto do bloco ser o 1º convite da edição.
    const lead = html.indexOf("Links para tutoriais e dicas saem em toda edição diária");
    const anchor = html.indexOf("Quero receber a edição diária");
    assert.ok(lead >= 0, "chamada de contexto deve existir antes da âncora");
    assert.ok(anchor > lead, "âncora clicável deve vir DEPOIS da frase de chamada");
    // A seção Use Melhor da diária leva de 1 a 3 itens, então a chamada fala no
    // PLURAL: "um desses" subvenderia o que o assinante recebe (decisão 260803).
    assert.ok(!/[Uu]m desses/.test(html), "chamada não pode voltar ao singular");
    // Aprendizado do CTA-01 (docs/experiments/cta-ab-mensal-2606-07.md): a âncora
    // do 1º CTA não empilha imperativo + "grátis" + seta.
    const useMelhorAnchor = [...html.matchAll(/<a[^>]*utm_content=cta-usemelhor[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    assert.equal(useMelhorAnchor.length, 1);
    assert.ok(!/grátis|gratis/i.test(useMelhorAnchor[0]), `âncora do Use Melhor não deve carregar "grátis": ${useMelhorAnchor[0]}`);
  });
});

describe("renderLinkedinWeeklyHtml — ordem de montagem restaurada ao template original (#4489, decisão do editor)", () => {
  const THREE_HEADLINES_INPUT: WeeklyLinkedinRenderInput = {
    ...BASE_INPUT,
    headlines: [
      { title: "Headline 1", body: "Corpo 1.", why: "" },
      { title: "Headline 2", body: "Corpo 2.", why: "" },
      { title: "Headline 3", body: "Corpo 3.", why: "" },
    ],
    useMelhor: {
      title: "Tutorial Y",
      url: "https://exemplo.com/tutorial-y",
      description: "Descrição do tutorial.",
      editorComment: "Comentário do editor sobre o tutorial.",
    },
  };

  it("com 3 manchetes (caso normal): opening → h1 → h2 → USE MELHOR → h3 → resto da semana → closing", () => {
    const result = renderLinkedinWeeklyHtml(THREE_HEADLINES_INPUT);
    const idxOpening = result.html.indexOf(BASE_INPUT.opening);
    const idxH1 = result.html.indexOf("<h2>1. Headline 1</h2>");
    const idxH2 = result.html.indexOf("<h2>2. Headline 2</h2>");
    const idxUseMelhor = result.html.indexOf("Use melhor");
    const idxH3 = result.html.indexOf("<h2>3. Headline 3</h2>");
    const idxEdicoes = result.html.indexOf("Edições da semana");
    const idxClosing = result.html.indexOf(BASE_INPUT.closing);

    for (const idx of [idxOpening, idxH1, idxH2, idxUseMelhor, idxH3, idxEdicoes, idxClosing]) {
      assert.ok(idx >= 0, "todos os blocos devem estar presentes no HTML");
    }
    assert.ok(idxOpening < idxH1, "opening antes de h1");
    assert.ok(idxH1 < idxH2, "h1 antes de h2");
    assert.ok(idxH2 < idxUseMelhor, "h2 antes do USE MELHOR — CTA do meio alcança quem lê parcial");
    assert.ok(idxUseMelhor < idxH3, "USE MELHOR antes de h3");
    assert.ok(idxH3 < idxEdicoes, "h3 antes de Edições da semana");
    assert.ok(idxEdicoes < idxClosing, "Edições da semana antes do closing");
  });

  it("semana reduzida com 2 manchetes: USE MELHOR entra depois da 2ª (mesma regra — não sobra 3ª manchete)", () => {
    const input: WeeklyLinkedinRenderInput = { ...THREE_HEADLINES_INPUT, headlines: THREE_HEADLINES_INPUT.headlines.slice(0, 2) };
    const result = renderLinkedinWeeklyHtml(input);
    const idxH2 = result.html.indexOf("<h2>2. Headline 2</h2>");
    const idxUseMelhor = result.html.indexOf("Use melhor");
    assert.ok(idxH2 >= 0 && idxUseMelhor >= 0);
    assert.ok(idxH2 < idxUseMelhor);
  });

  it("semana reduzida com 1 manchete: USE MELHOR entra logo depois dela (equivalente a 'no fim')", () => {
    const input: WeeklyLinkedinRenderInput = { ...THREE_HEADLINES_INPUT, headlines: THREE_HEADLINES_INPUT.headlines.slice(0, 1) };
    const result = renderLinkedinWeeklyHtml(input);
    const idxH1 = result.html.indexOf("<h2>1. Headline 1</h2>");
    const idxUseMelhor = result.html.indexOf("Use melhor");
    assert.ok(idxH1 >= 0 && idxUseMelhor >= 0);
    assert.ok(idxH1 < idxUseMelhor);
  });
});

describe("renderLinkedinWeeklyHtml — Edições da semana (#4456, 260802 — era 'Resto da semana')", () => {
  it("cada edição vira 1 item com link pra edição + seus destaques listados", () => {
    const result = renderLinkedinWeeklyHtml(BASE_INPUT);
    assert.match(result.html, /Edição de 29\/07/);
    assert.match(result.html, /Título da edição de terça/);
    assert.match(result.html, /D2 de terça/);
    assert.match(result.html, /D3 de terça/);
    assert.match(result.html, /Edição de 30\/07/);
    assert.match(result.html, /Título da edição de quarta/);
    assert.match(result.html, /utm_content=lista/);
  });

  it("a lista é PLANA, com separador de texto entre os destaques (achado ao vivo 260803)", () => {
    const html = renderLinkedinWeeklyHtml(BASE_INPUT).html;
    const secao = html.slice(html.indexOf("Edições da semana"));
    const listaFim = secao.indexOf("</ul>") + "</ul>".length;
    const lista = secao.slice(0, listaFim);
    // O editor do LinkedIn achata <ul> aninhada e cola os destaques num bloco
    // corrido, sem separador — por isso a estrutura tem que ser plana na origem.
    assert.equal((lista.match(/<ul>/g) ?? []).length, 1, `só pode haver 1 <ul>, sem aninhamento: ${lista}`);
    assert.ok(lista.includes(" · "), "destaques precisam de separador em TEXTO, que sobrevive ao achatamento");
    // e os títulos continuam todos presentes, na ordem
    const item = lista.slice(lista.indexOf("Edição de 29/07"));
    const d2 = item.indexOf("D2 de terça");
    const d3 = item.indexOf("D3 de terça");
    assert.ok(d2 > 0 && d3 > d2, "destaques preservados e em ordem dentro do item");
  });

  it("edição sem destaque parseável não deixa ': ' órfão depois do link", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      weeklyEditions: [{ editionDate: "260729", url: "https://diar.ia.br/p/x", destaques: [] }],
    };
    const html = renderLinkedinWeeklyHtml(input).html;
    assert.ok(!/<\/a>:\s*<\/li>/.test(html), "sem destaques, não pode sobrar dois-pontos solto");
  });

  it("lista vazia não renderiza a seção 'Edições da semana'", () => {
    const input: WeeklyLinkedinRenderInput = { ...BASE_INPUT, weeklyEditions: [] };
    const result = renderLinkedinWeeklyHtml(input);
    assert.ok(!/Edições da semana/.test(result.html));
  });

  it("destaque terminando em domínio nu gera warning (#4489 finding 2 — mesmo guard do Use Melhor, faltava aqui)", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      weeklyEditions: [{ editionDate: "260729", url: "https://diar.ia.br/p/confira", destaques: ["Confira em exemplo.com.br"] }],
    };
    const result = renderLinkedinWeeklyHtml(input);
    assert.ok(result.warnings.some((w) => /Edições da semana.*domínio nu/i.test(w)), result.warnings.join(" | "));
    // literal — não reescreve o título mesmo com o warning (mesma regra do Use Melhor).
    assert.match(result.html, /Confira em exemplo\.com\.br/);
  });

  it("item com destaques normais não gera warning de domínio nu", () => {
    const result = renderLinkedinWeeklyHtml(BASE_INPUT);
    assert.ok(!result.warnings.some((w) => /domínio nu/i.test(w)));
  });
});

describe("renderLinkedinWeeklyHtml — opening/closing vazios geram warning (#4489 finding 3)", () => {
  it("opening vazio omite o parágrafo E gera warning (diferente do Use Melhor, opening é sempre obrigatório)", () => {
    const input: WeeklyLinkedinRenderInput = { ...BASE_INPUT, opening: "" };
    const result = renderLinkedinWeeklyHtml(input);
    assert.ok(result.warnings.some((w) => /abertura ausente\/vazia/i.test(w)), result.warnings.join(" | "));
  });

  it("closing vazio omite o parágrafo E gera warning", () => {
    const input: WeeklyLinkedinRenderInput = { ...BASE_INPUT, closing: "   " };
    const result = renderLinkedinWeeklyHtml(input);
    assert.ok(result.warnings.some((w) => /fecho ausente\/vazio/i.test(w)), result.warnings.join(" | "));
  });

  it("opening/closing presentes não geram warning nenhum sobre ausência", () => {
    const result = renderLinkedinWeeklyHtml(BASE_INPUT);
    assert.ok(!result.warnings.some((w) => /ausente\/vazi[ao]/i.test(w)));
  });
});

describe("renderLinkedinWeeklyHtml — abertura e fecho quebram em parágrafos (decisão do editor 260803)", () => {
  it("linha em branco dupla vira <p> separado, igual ao corpo das manchetes", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      opening: "Primeiro parágrafo da abertura.\n\nSegundo parágrafo da abertura.\n\nTerceiro parágrafo da abertura.",
      closing: "Primeiro parágrafo do fecho.\n\nSegundo parágrafo do fecho.",
    };
    const html = renderLinkedinWeeklyHtml(input).html;
    assert.match(html, /<p>Primeiro parágrafo da abertura\.<\/p>/);
    assert.match(html, /<p>Segundo parágrafo da abertura\.<\/p>/);
    assert.match(html, /<p>Terceiro parágrafo da abertura\.<\/p>/);
    assert.match(html, /<p>Primeiro parágrafo do fecho\.<\/p>/);
    assert.match(html, /<p>Segundo parágrafo do fecho\.<\/p>/);
    // regressão: antes do 260803 os 3 parágrafos saíam colados num <p> único,
    // com os "\n\n" literais preservados dentro dele.
    assert.ok(!/abertura\.\n\nSegundo/.test(html), "parágrafos não podem sair colados num <p> só");
  });

  it("a abertura leva um CTA de assinatura logo depois dos parágrafos (decisão do editor 260803)", () => {
    const html = renderLinkedinWeeklyHtml(BASE_INPUT).html;
    const idxCtaAbertura = html.indexOf("utm_content=cta-abertura");
    const idxPrimeiraManchete = html.indexOf("<h2>1.");
    assert.ok(idxCtaAbertura >= 0, "CTA da abertura deve existir");
    assert.ok(idxCtaAbertura < idxPrimeiraManchete, "CTA da abertura deve vir ANTES da 1ª manchete");
    // Aprendizado do CTA-01: acima da dobra a âncora é a mais sóbria das três
    // (infinitivo, sem "grátis", sem seta). Os empurrões pesados ficam no meio/fim.
    const anchor = html.match(/<a[^>]*utm_content=cta-abertura[^>]*>([^<]+)<\/a>/)?.[1] ?? "";
    assert.ok(!/grátis|gratis|→/.test(anchor), `âncora acima da dobra deve ser sóbria: ${anchor}`);
  });

  it("a 1ª menção ao wordmark vira link com UTM, com âncora ESTENDIDA além do domínio (testado ao vivo 260803)", () => {
    const input: WeeklyLinkedinRenderInput = {
      ...BASE_INPUT,
      opening: "Escrevo a diar.ia.br, newsletter de IA que sai por e-mail.\n\nOutra menção a diar.ia.br aqui.",
    };
    const html = renderLinkedinWeeklyHtml(input).html;
    const anchor = html.match(/<a[^>]*utm_content=mencao-abertura[^>]*>([^<]+)<\/a>/)?.[1] ?? "";
    assert.ok(anchor.startsWith("diar.ia.br"), `âncora deve começar no wordmark: ${anchor}`);
    // O ponto do achado: âncora que TERMINA no domínio tem o href sequestrado
    // pelo auto-linkificador do LinkedIn e perde a UTM. Estendida, sobrevive.
    assert.ok(!endsInBareDomainLabel(anchor), `âncora não pode terminar em domínio nu: ${anchor}`);
    assert.equal((html.match(/utm_content=mencao-abertura/g) ?? []).length, 1, "só a PRIMEIRA menção é linkada");
  });

  it("wordmark no fim do parágrafo NÃO é linkado, E gera warning (achados do review do #4501)", () => {
    // Sem o warning isso degradava em silêncio, contra a convenção do módulo: a
    // publicação é manual, e `warnings` é o único canal pro editor descobrir
    // antes de colar que aquele clique vai sair sem atribuição.
    for (const opening of [
      "A newsletter se chama diar.ia.br",
      "A newsletter se chama diar.ia.br.", // com pontuação: o caso que acontece em prosa real
      "A newsletter se chama diar.ia.br!",
      "A newsletter se chama diar.ia.br,",
    ]) {
      const r = renderLinkedinWeeklyHtml({ ...BASE_INPUT, opening });
      assert.ok(!/utm_content=mencao-abertura/.test(r.html), `não pode linkar: ${opening}`);
      assert.ok(
        r.warnings.some((w) => /menção a diar\.ia\.br não pôde virar link/i.test(w)),
        `faltou warning para: ${opening} | ${r.warnings.join(" | ")}`,
      );
    }
  });

  it("a âncora NÃO atravessa fronteira de frase (achado do review do #4501)", () => {
    // Antes o charset da extensão só parava em `<`, então a âncora engolia a
    // frase seguinte inteira e virava área clicável sobre texto alheio à marca.
    const r = renderLinkedinWeeklyHtml({ ...BASE_INPUT, opening: "Escrevo a diar.ia.br. Confira quando puder." });
    assert.ok(!/Confira quando puder[^<]*<\/a>/.test(r.html), `âncora vazou pra frase seguinte: ${r.html.slice(0, 300)}`);
    // e como o wordmark fecha a frase, o caso vira o warning do teste acima
    assert.ok(r.warnings.some((w) => /não pôde virar link/i.test(w)));
  });

  it("wordmark dentro de uma URL colada não é sequestrado (achado do review do #4501)", () => {
    // `indexOf` cru casava no meio de https://diar.ia.br/p/artigo, gerando HTML
    // quebrado e um href apontando pra HOME em vez do artigo específico.
    const opening = "Leia em https://diar.ia.br/p/algum-artigo sobre isso.";
    const html = renderLinkedinWeeklyHtml({ ...BASE_INPUT, opening }).html;
    assert.ok(!/utm_content=mencao-abertura/.test(html), "não pode linkar dentro de uma URL");
    assert.ok(html.includes("https://diar.ia.br/p/algum-artigo"), "a URL original tem que sair intacta");
  });

  it("abertura sem menção ao wordmark não inventa link", () => {
    const html = renderLinkedinWeeklyHtml({ ...BASE_INPUT, opening: "Abertura sem citar a marca." }).html;
    assert.ok(!/utm_content=mencao-abertura/.test(html));
  });

  it("abertura vazia não emite CTA órfão (o link some junto com o parágrafo)", () => {
    const html = renderLinkedinWeeklyHtml({ ...BASE_INPUT, opening: "" }).html;
    assert.ok(!/utm_content=cta-abertura/.test(html), "sem abertura não pode sobrar link solto no topo");
  });

  it("texto de 1 parágrafo continua saindo em 1 <p> (sem regressão pro caso simples)", () => {
    const input: WeeklyLinkedinRenderInput = { ...BASE_INPUT, opening: "Abertura de um parágrafo só.", closing: "Fecho de um parágrafo só." };
    const html = renderLinkedinWeeklyHtml(input).html;
    assert.match(html, /<p>Abertura de um parágrafo só\.<\/p>/);
    assert.match(html, /<p>Fecho de um parágrafo só\.<\/p>/);
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
    assert.match(result.html, /utm_content=cta-abertura/);
    assert.match(result.html, /utm_content=cta-usemelhor/);
    assert.match(result.html, /utm_content=cta-fim/);
    assert.match(result.html, /utm_content=lista/);
    assert.ok(!/item-0[123]/.test(result.html), "item-01/02/03 não deve mais existir (#4456)");
    // Os 3 CTAs de assinatura precisam de utm_content DISTINTO — sem isso não dá
    // pra saber qual posição converte (decisão do editor 260803).
    const ctaContents = [...result.html.matchAll(/utm_content=(cta-[a-z]+)/g)].map((m) => m[1]);
    assert.equal(new Set(ctaContents).size, 3, `CTAs devem ter utm_content distintos: ${ctaContents.join(", ")}`);
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
