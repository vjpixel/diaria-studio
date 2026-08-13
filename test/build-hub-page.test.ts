/**
 * test/build-hub-page.test.ts (#4558 Parte A)
 *
 * Cobre `renderGeneratedModule` (build-hub-page.ts) e `buildAnthropicClaudeFaq`
 * (scripts/lib/hubs/anthropic-claude.ts). Um bloco roda contra o
 * `sources.generated.json` REAL commitado (o bug original de contagem de
 * "lançamentos" caindo pra 0 só aparece com o texto NFD real do cache
 * Beehiiv); outro roda contra um fixture SINTÉTICO — necessário desde que
 * `countMatching` passou a receber `sources` como parâmetro (antes fechava
 * sobre o `SOURCES` do módulo, então um fixture sintético não testaria nada
 * de verdade; achado do fleet review).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderGeneratedModule, HUB_LOADERS, loadHubContent } from "../scripts/build-hub-page.ts";
import {
  renderHubPage,
  sourceEditionLabel,
  validateHubContent,
  hubCoverageDate,
  checkUpdatedDateCeiling,
  HUB_UPDATED_DATE_CEILING_WARN_DAYS,
  type HubContent,
} from "../scripts/lib/shared/hub-page.ts";
import { findParagraphLinks } from "../scripts/lib/shared/markdown-links.ts";
import { buildAnthropicClaudeFaq, getAnthropicClaudeHub } from "../scripts/lib/hubs/anthropic-claude.ts";
import { buildOpenaiChatgptFaq } from "../scripts/lib/hubs/openai-chatgpt.ts";
import { knownUtmSources, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM } from "../scripts/lib/shared/utm-registry.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";
import sourcesRaw from "../scripts/lib/hubs/anthropic-claude-sources.generated.json" with { type: "json" };
import openaiChatgptSourcesRaw from "../scripts/lib/hubs/openai-chatgpt-sources.generated.json" with { type: "json" };

describe("renderGeneratedModule (#4558 Parte A)", () => {
  it("emite um módulo TS válido com a constante esperada", () => {
    const mod = renderGeneratedModule("anthropic-claude", "<html>oi</html>");
    assert.match(mod, /GERADO, NÃO EDITAR À MÃO/);
    assert.match(mod, /export const HUB_HTML_ANTHROPIC_CLAUDE = "<html>oi<\/html>";/);
  });

  it("nome da constante segue slug com hífen → SCREAMING_SNAKE_CASE", () => {
    const mod = renderGeneratedModule("foo-bar-baz", "x");
    assert.match(mod, /export const HUB_HTML_FOO_BAR_BAZ =/);
  });
});

describe("renderHubPage — CTA de assinatura inline (#5167 item 2)", () => {
  const html = renderHubPage(getAnthropicClaudeHub());

  it("tem um FORM inline de assinatura (não link puro pro /subscribe da Beehiiv)", () => {
    // #5167 item 2: mesmo tratamento do item 1 (render-archive.ts) — o
    // CTA-link antigo virou form inline chamando /jogar/subscribe cross-origin.
    assert.doesNotMatch(html, /<a href="https:\/\/diar\.ia\.br\/subscribe">/);
    assert.match(html, /class="cta-subscribe-form" data-source="hub"/);
    assert.match(html, /window\.fetch\("https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
  });

  it("id do form é único por hub (namespaced pelo slug)", () => {
    assert.match(html, /id="hub-anthropic-claude-cta-subscribe"/);
  });
});

describe("buildAnthropicClaudeFaq (#4558 Parte A) — regression do bug NFD/NFC", () => {
  const faq = buildAnthropicClaudeFaq(sourcesRaw as never);

  it("6-10 perguntas (issue #4558 item 3)", () => {
    assert.ok(faq.length >= 6 && faq.length <= 10, `esperado 6-10, veio ${faq.length}`);
  });

  it("conta lançamentos > 0 — regression: regex acentuado contra texto NFD batia 0/12 antes da normalização NFC", () => {
    // Busca pelo conteúdo da resposta, não pelo texto da pergunta — a
    // pergunta foi reformulada (achado do editor 260804: FAQ não pode
    // duplicar o H2 de uma section) e não pode mais ser um prefixo estável.
    // #4899 reescreveu a redação ("A diar.ia.br noticiou N" → "Foram N"):
    // a publicação não pode ser sujeito de verbo de cobertura. O que o teste
    // garante continua sendo o mesmo — a contagem DERIVADA, não a frase.
    const launchFaq = faq.find((f) => /Foram \d+ lançamentos/.test(f.answer));
    assert.ok(launchFaq);
    assert.doesNotMatch(launchFaq.answer, /Foram 0 lançamentos/);
    assert.match(launchFaq.answer, /Foram 12 lançamentos/);
  });

  it("cada resposta do FAQ aparece idêntica no corpo visível da página (paridade com o JSON-LD)", () => {
    const hub = getAnthropicClaudeHub();
    // hub.faq é a MESMA lista usada pelo JSON-LD (renderGeoJsonLd) e pelo
    // bloco visível (renderGeoFaqSection) em hub-page.ts — checar aqui que
    // buildAnthropicClaudeFaq() não diverge do que getAnthropicClaudeHub()
    // efetivamente usa.
    assert.deepEqual(hub.faq, faq);
  });

  it("é genuinamente pura — opera sobre o `sources` recebido, não sobre o SOURCES real do módulo (regression: countMatching fechava sobre o módulo, ignorando o parâmetro)", () => {
    // Fixture SINTÉTICO em NFD, deliberadamente diferente do dado real
    // commitado — decoupla esta proteção do estado de
    // anthropic-claude-sources.generated.json (achado do pr-test-analyzer:
    // testar só contra dado real mascara uma regressão futura se o dado
    // mudar de forma). Antes do fix, `launches` aqui teria vindo do SOURCES
    // real (12), não do fixture (2).
    const synthetic = [
      {
        date: "2026-01-01",
        editionSlug: "edicao-1",
        url: "https://diar.ia.br/p/edicao-1",
        matchedHeadlines: ["Anthropic lança modelo X".normalize("NFD")],
      },
      {
        date: "2026-02-01",
        editionSlug: "edicao-2",
        url: "https://diar.ia.br/p/edicao-2",
        matchedHeadlines: ["Anthropic lança modelo Y".normalize("NFD"), "Claude Mythos causa polêmica"],
      },
    ];
    const syntheticFaq = buildAnthropicClaudeFaq(synthetic);
    const launchFaq = syntheticFaq.find((f) => /Foram \d+ lançamentos/.test(f.answer));
    assert.ok(launchFaq);
    assert.match(launchFaq.answer, /Foram 2 lançamentos/);
    const mythosFaq = syntheticFaq.find((f) => f.question.includes("Mythos"));
    assert.ok(mythosFaq);
    assert.match(mythosFaq.answer, /citado em 1 edições/);
  });
});

describe("consistência FAQ × prosa das sections/INTRO (#4558 Parte A)", () => {
  // Os números do FAQ são COMPUTADOS (buildAnthropicClaudeFaq sobre
  // SOURCES); os mesmos números citados na prosa de `sections`/`INTRO` são
  // TRANSCRITOS À MÃO (ver docstring do módulo) — corretos hoje, mas sem
  // nada automático religando os dois. Este teste é o "nada automático"
  // que falta: se `sources.generated.json` for regenerado com dado novo e
  // a prosa não for atualizada junto, este teste quebra (achado do fleet
  // review — code-reviewer + pr-test-analyzer, independentemente).
  const hub = getAnthropicClaudeHub();
  const faq = buildAnthropicClaudeFaq(sourcesRaw as never);
  const totalEditions = (sourcesRaw as unknown[]).length;
  const totalMentions = (sourcesRaw as { matchedHeadlines: string[] }[]).reduce(
    (n, s) => n + s.matchedHeadlines.length,
    0,
  );

  it("INTRO cita o mesmo total de edições e manchetes que o FAQ computa", () => {
    assert.match(hub.introParagraph, new RegExp(`destaque em ${totalEditions} edições`));
    assert.match(hub.introParagraph, new RegExp(`${totalMentions} manchetes ao todo`));
  });

  it("a seção de cadência de lançamento cita o mesmo número que o FAQ computa", () => {
    const launchFaq = faq.find((f) => /Foram \d+ lançamentos/.test(f.answer));
    const launchMatch = /Foram (\d+) lançamentos/.exec(launchFaq?.answer ?? "");
    assert.ok(launchMatch, "FAQ não tem a contagem de lançamentos no formato esperado");
    const launchSection = hub.sections.find((s) => s.heading.startsWith("Com que frequência"));
    assert.ok(launchSection);
    // A prosa agora diz "A Anthropic lançou N modelos ou ferramentas".
    assert.match(launchSection.paragraphs[0], new RegExp(`lançou ${launchMatch[1]} modelos ou ferramentas`));
  });
});

describe("getAnthropicClaudeHub (#4558 Parte A)", () => {
  const hub = getAnthropicClaudeHub();

  it("sourceEditions não é vazio e está ordenado do mais recente pro mais antigo", () => {
    assert.ok(hub.sourceEditions.length > 0);
    for (let i = 1; i < hub.sourceEditions.length; i++) {
      assert.ok(hub.sourceEditions[i - 1].date >= hub.sourceEditions[i].date);
    }
  });

  it("toda sourceEdition aponta pro domínio de marca diar.ia.br", () => {
    for (const e of hub.sourceEditions) {
      assert.match(e.url, /^https:\/\/diar\.ia\.br\/p\//);
    }
  });

  it("publishedDate e updatedDate são literais estáticos YYYY-MM-DD (não Date.now())", () => {
    assert.match(hub.publishedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(hub.updatedDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  // #4917 item 4 — S3 (valuation), S4 (produtos/parcerias) e S5 (segurança)
  // tinham 9 de 13 parágrafos sem NENHUMA data absoluta (549 palavras). Cada
  // parágrafo de cada seção agora carrega pelo menos um "DD de mês[ de AAAA]"
  // — não trava a prosa exata (#495: edições cirúrgicas, texto muda), só que
  // a lacuna de data não reapareça silenciosamente numa reescrita futura.
  it("#4917 item 4 — S3/S4/S5 têm ≥1 data absoluta em CADA parágrafo", () => {
    const absoluteDateRe = /\d{1,2}º? de (?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i;
    const sectionIndexByHeading: Record<string, number> = {
      "Como a valuation da Anthropic evoluiu no período?": 2,
      "Em quais produtos e parcerias o Claude já apareceu?": 3,
      "O Claude já causou algum incidente de segurança real?": 4,
    };
    for (const [heading, expectedIndex] of Object.entries(sectionIndexByHeading)) {
      const section = hub.sections[expectedIndex];
      assert.equal(section.heading, heading, `seção no índice ${expectedIndex} mudou de heading — atualizar o mapa do teste`);
      for (const [i, paragraph] of section.paragraphs.entries()) {
        assert.match(paragraph, absoluteDateRe, `"${heading}" parágrafo ${i + 1} sem data absoluta`);
      }
    }
  });
});

describe("ItemList do JSON-LD espelha hub.sourceEditions (#4558 Parte B — reforço de estrutura GEO nos hubs)", () => {
  it("todo item de hub.sourceEditions aparece no ItemList, na mesma ordem, com o mesmo nome e URL", () => {
    const hub = getAnthropicClaudeHub();
    const html = renderHubPage(hub);
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "hub sem JSON-LD");
    const jsonLd = JSON.parse(m![1]);
    const listNode = jsonLd["@graph"].find((n: { "@type": string }) => n["@type"] === "ItemList");
    assert.ok(listNode, "hub sem node ItemList — sourceEditions não é vazio, deveria ter um");
    assert.equal(listNode.numberOfItems, hub.sourceEditions.length);
    assert.equal(listNode.itemListElement.length, hub.sourceEditions.length);
    for (let i = 0; i < hub.sourceEditions.length; i++) {
      assert.equal(listNode.itemListElement[i].position, i + 1);
      // #4918: name usa sourceEditionLabel (manchete + título da edição
      // quando presente e distinto), não mais `.title` cru — a paridade real
      // é entre o schema e o rótulo efetivamente composto pelo renderer.
      assert.equal(listNode.itemListElement[i].name, sourceEditionLabel(hub.sourceEditions[i]));
      assert.equal(listNode.itemListElement[i].url, hub.sourceEditions[i].url);
    }
  });
});

describe("UTM do rodapé do hub está catalogado em UTM_EMITTERS (#4558 Parte A, mesmo padrão do #4312)", () => {
  // Regressão da MESMA classe que #4312 fechou pra arquivo/livros/cursos
  // (ver test/arquivo-render.test.ts): um literal solto de UTM no rodapé
  // fica invisível pros testes existentes porque knownUtmSources() DERIVA
  // de UTM_EMITTERS — sem a entrada, nada acusa o furo. Achado do fleet
  // review: esta classe de teste existia pras 3 páginas antigas, mas não
  // para o hub novo.
  it("o link 'diar.ia.br' do rodapé emite o triplo registrado, e o source está catalogado", () => {
    const html = renderHubPage(getAnthropicClaudeHub());
    const m = /href="https:\/\/diar\.ia\.br\/?\?(utm_source=[^"]+)"/.exec(html);
    assert.ok(m, "link 'diar.ia.br' do rodapé não tem UTM na URL");
    const params = new URLSearchParams(m[1].replace(/&amp;/g, "&"));
    const utmSource = params.get("utm_source");
    const utmMedium = params.get("utm_medium");
    assert.equal(utmSource, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM.source);
    assert.equal(utmMedium, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM.medium);
    assert.ok(
      knownUtmSources().includes((utmSource ?? "").toLowerCase()),
      `utm_source="${utmSource}" emitido pelo render mas ausente de UTM_EMITTERS`,
    );
  });
});

// Cobertura genérica pra TODO hub em HUB_LOADERS (#4790 achado 3) — os blocos
// acima protegem só anthropic-claude (fixture sintético + regression NFD/NFC
// específicos daquele hub, mantidos como estão). openai-chatgpt e
// google-gemini (PR #4790) entraram SEM nenhum teste, e foi exatamente essa
// lacuna que deixou passar o achado #1 daquela PR (gpt5x contando uma
// manchete de incidente de segurança como lançamento, sem nada flagrando a
// divergência entre o número computado e a prosa transcrita à mão). Itera
// sobre `HUB_LOADERS` — um hub novo ganha esta cobertura automaticamente.
for (const slug of Object.keys(HUB_LOADERS)) {
  describe(`cobertura mínima do hub — ${slug} (#4790 achado 3)`, () => {
    const hub = HUB_LOADERS[slug]();

    it("FAQ tem entre 6 e 10 itens (issue #4558 item 3)", () => {
      assert.ok(hub.faq.length >= 6 && hub.faq.length <= 10, `esperado 6-10, veio ${hub.faq.length}`);
    });

    it("consistência: total de edições/manchetes que o FAQ #1 computa bate com o que o INTRO afirma", () => {
      // Todo `buildXxxFaq` começa com a mesma pergunta computada
      // ("Em quantas edições..."), respondida no formato "N edições da
      // diar.ia.br, somando M manchetes" — e todo INTRO afirma os mesmos 2
      // números à mão, no formato "N edições da diar.ia.br, M manchetes ao
      // todo". Isto é o "nada automático religando os dois" que faltava:
      // se `{slug}-sources.generated.json` for regenerado e a prosa do
      // INTRO não acompanhar, este teste quebra.
      const faqMatch = /(\d+) edições da diar\.ia\.br, somando (\d+) manchetes/.exec(hub.faq[0]?.answer ?? "");
      assert.ok(faqMatch, `FAQ #1 do hub "${slug}" não tem o formato esperado de contagem`);
      const introMatch = /(\d+) edições da diar\.ia\.br, (\d+) manchetes ao todo/.exec(hub.introParagraph);
      assert.ok(introMatch, `INTRO do hub "${slug}" não tem o formato esperado de contagem`);
      assert.equal(
        faqMatch![1],
        introMatch![1],
        `hub "${slug}": FAQ computa ${faqMatch![1]} edições, INTRO afirma ${introMatch![1]}`,
      );
      assert.equal(
        faqMatch![2],
        introMatch![2],
        `hub "${slug}": FAQ computa ${faqMatch![2]} manchetes, INTRO afirma ${introMatch![2]}`,
      );
    });

    it("o link diar.ia.br do rodapé emite o UTM de hub.footerNavUtm, catalogado em UTM_EMITTERS", () => {
      const html = renderHubPage(hub);
      const m = /href="https:\/\/diar\.ia\.br\/?\?(utm_source=[^"]+)"/.exec(html);
      assert.ok(m, `link 'diar.ia.br' do rodapé sem UTM na URL pro hub "${slug}"`);
      const params = new URLSearchParams(m![1].replace(/&amp;/g, "&"));
      assert.equal(params.get("utm_source"), hub.footerNavUtm.source);
      assert.equal(params.get("utm_medium"), hub.footerNavUtm.medium);
      assert.ok(
        knownUtmSources().includes((params.get("utm_source") ?? "").toLowerCase()),
        `utm_source="${params.get("utm_source")}" emitido pelo render mas ausente de UTM_EMITTERS`,
      );
    });
  });
}

describe("H1 carrega o intervalo coberto pelo hub, derivado — nunca escrito à mão (#4912)", () => {
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": <h1> renderizado contém o ano da fonte mais antiga e da mais recente`, () => {
      const hub = HUB_LOADERS[slug]();
      assert.ok(hub.sourceEditions.length > 0, `hub "${slug}" sem sourceEditions`);
      // sourceEditions é o MESMO dataset de SOURCES, só reordenado
      // mais-recente-primeiro (invariante checado por validateHubContent) —
      // então o índice 0 e o último dão o mesmo par min/max de data que
      // `hubCoverageWindow(SOURCES)` computa dentro de `get{Hub}Hub()`.
      const newestYear = hub.sourceEditions[0].date.slice(0, 4);
      const oldestYear = hub.sourceEditions[hub.sourceEditions.length - 1].date.slice(0, 4);
      const html = renderHubPage(hub);
      const h1Match = /<h1>(.*?)<span class="dot"/s.exec(html);
      assert.ok(h1Match, `hub "${slug}": <h1> não encontrado no HTML renderizado`);
      const h1Text = h1Match![1];
      assert.ok(
        h1Text.includes(oldestYear),
        `H1 do hub "${slug}" não contém o ano mais antigo (${oldestYear}): "${h1Text}"`,
      );
      assert.ok(
        h1Text.includes(newestYear),
        `H1 do hub "${slug}" não contém o ano mais recente (${newestYear}): "${h1Text}"`,
      );
    });
  }
});

describe('tagline não aparece entre <h1> e <h2 class="geo-h2"> (#4912)', () => {
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": tagline vem depois do H2 da intro, não entre ele e o H1`, () => {
      const html = renderHubPage(HUB_LOADERS[slug]());
      const taglineIdx = html.indexOf('class="tagline"');
      const geoH2Idx = html.indexOf("geo-h2");
      assert.ok(taglineIdx > -1, `tagline ausente do hub "${slug}"`);
      assert.ok(geoH2Idx > -1, `geo-h2 ausente do hub "${slug}"`);
      assert.ok(taglineIdx > geoH2Idx, `tagline aparece antes do geo-h2 no hub "${slug}" (esperado: depois)`);
    });
  }
});

describe("consistência FAQ × prosa da S1 de lançamento — generalizado sobre HUB_LOADERS (#4922 item 1)", () => {
  // Generalização do bloco Anthropic-específico acima: nos hubs que citam
  // "Foram N lançamentos" no FAQ (anthropic-claude, google-gemini — os 2
  // que têm um padrão countMatching pra "lançamento"; openai-chatgpt e
  // meta-ai não, ver docstring dos respectivos módulos), a S1 abre com
  // "[Empresa] lançou N modelos/ferramentas" citando o MESMO N. Antes do
  // #4922, os dois números eram independentes (um computado, um
  // transcrito à mão) — agora ambos leem do mesmo objeto derivado, então
  // este teste é a rede que pega se algum dos dois voltar a divergir (ex:
  // edição manual futura que mexa só num dos dois lugares).
  let matched = 0;
  for (const slug of Object.keys(HUB_LOADERS)) {
    const hub = HUB_LOADERS[slug]();
    const launchFaq = hub.faq.find((f) => /Foram \d+ lançamentos/.test(f.answer));
    if (!launchFaq) continue; // hub sem contagem de lançamento computada (openai-chatgpt, meta-ai)
    const launchMatch = /Foram (\d+) lançamentos/.exec(launchFaq.answer);
    const s1Match = hub.sections
      .map((s) => /lançou (\d+) (?:modelos?|produtos?) ou (?:ferramentas?|produtos?)/.exec(s.paragraphs[0]))
      .find((m) => m !== null);
    if (!launchMatch || !s1Match) continue;
    matched++;
    it(`hub "${slug}": S1 cita o mesmo N de lançamentos que o FAQ computa`, () => {
      assert.equal(
        s1Match![1],
        launchMatch![1],
        `hub "${slug}": FAQ computa ${launchMatch![1]} lançamentos, S1 diz ${s1Match![1]}`,
      );
    });
  }
  it("sanity: pelo menos 2 hubs foram cobertos por este bloco (senão a generalização parou de proteger algo)", () => {
    assert.ok(matched >= 2, `só ${matched} hub(s) casaram os 2 padrões — checar se a prosa mudou de formato`);
  });
});

describe("buildOpenaiChatgptFaq (#4790 achado 1) — regression: manchete de incidente não é lançamento", () => {
  it("contra o dataset real: gpt5x bate 6 (os releases enumerados no parêntese), não 7", () => {
    // Antes do fix, `countMatching(sources, /GPT-?5\.\d/i)` também casava
    // "GPT-5.6 Sol apaga arquivos sem permissão" (17/07/2026) — manchete de
    // INCIDENTE DE SEGURANÇA sobre um modelo já lançado, não um release
    // novo — inflando gpt5x pra 7 enquanto a prosa da resposta enumerava só
    // 6 releases entre parênteses. Roda contra o JSON real commitado
    // (mesmo racional do bloco NFD/NFC de anthropic-claude acima): o bug só
    // aparece com a manchete real do incidente presente no dataset.
    const faq = buildOpenaiChatgptFaq(openaiChatgptSourcesRaw as never);
    const gpt5xFaq = faq.find((f) => f.question.includes("Quantas versões do GPT-5"));
    assert.ok(gpt5xFaq, 'FAQ não tem a pergunta "Quantas versões do GPT-5..."');
    assert.match(gpt5xFaq.answer, /Foram 6 manchetes/);
    assert.doesNotMatch(gpt5xFaq.answer, /Foram 7 manchetes/);
  });

  it("com fixture sintético: uma manchete de incidente de segurança não conta como lançamento de versão", () => {
    // Decoupla a proteção do estado do dataset real (mesmo racional do
    // fixture sintético de anthropic-claude acima) — mesmo se
    // `openai-chatgpt-sources.generated.json` mudar de forma, este teste
    // continua flagrando a regressão específica.
    const synthetic = [
      {
        date: "2026-01-01",
        editionSlug: "edicao-1",
        url: "https://diar.ia.br/p/edicao-1",
        matchedHeadlines: ["OpenAI lança GPT-5.9"],
      },
      {
        date: "2026-02-01",
        editionSlug: "edicao-2",
        url: "https://diar.ia.br/p/edicao-2",
        matchedHeadlines: ["GPT-5.9 apaga arquivos sem permissão"],
      },
    ];
    const faq = buildOpenaiChatgptFaq(synthetic);
    const gpt5xFaq = faq.find((f) => f.question.includes("Quantas versões do GPT-5"));
    assert.ok(gpt5xFaq);
    assert.match(gpt5xFaq.answer, /Foram 1 manchetes/);
  });
});

/** Extrai `{dateLabel, titleLabel}` de cada LINHA da tabela de bibliografia
 * (`.hub-sources table`) do HTML renderizado — usado pelas regressões
 * #4911/#4918/#4921 abaixo, que precisam inspecionar o texto efetivamente
 * visível, não só o campo `HubSourceEdition.title` isolado.
 *
 * #4921 Onda 1 trocou `<ul>/<li>` por `<table>`: data e manchete agora vêm de
 * `<td>` DISTINTOS (1º e 2º da linha) — o regex só casa quando essa
 * separação estrutural existe, então uma regressão futura que volte a
 * concatenar os dois num `<td>` único faz `rows.length` cair (linhas
 * esperadas != linhas extraídas), não passar silenciosamente. */
function extractSourceTableRows(html: string): { dateLabel: string; titleLabel: string }[] {
  const items: { dateLabel: string; titleLabel: string }[] = [];
  const re = /<tr><td>([^<]*)<\/td><td>([^<]*)<\/td><td><a[^>]*>[^<]*<\/a><\/td><\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    items.push({ dateLabel: m[1], titleLabel: m[2] });
  }
  return items;
}

describe("bibliografia dos hubs — <table> com 1 linha por manchete (#4921)", () => {
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": exatamente 1 <table> na seção de fontes, <thead> presente, corpo com 1 linha por manchete`, () => {
      const hub = HUB_LOADERS[slug]();
      const html = renderHubPage(hub);
      const sourcesSectionMatch = /<section class="hub-sources"[\s\S]*?<\/section>/.exec(html);
      assert.ok(sourcesSectionMatch, `hub "${slug}": seção .hub-sources não encontrada`);
      const sourcesHtml = sourcesSectionMatch![0];
      const tableCount = (sourcesHtml.match(/<table>/g) ?? []).length;
      assert.equal(tableCount, 1, `hub "${slug}": esperado 1 <table> na seção de fontes, achou ${tableCount}`);
      assert.match(sourcesHtml, /<thead>/, `hub "${slug}": <table> sem <thead>`);
      // Esperado DERIVADO do próprio dataset (nunca literal — as contagens
      // mudam a cada regen, ver docstring da issue #4921): `title` é
      // `matchedHeadlines.join(" · ")`, então a soma dos splits por " · "
      // sobre `hub.sourceEditions` é o total de manchetes casadas.
      const expectedRows = hub.sourceEditions.reduce((n, e) => n + e.title.split(" · ").length, 0);
      const rows = extractSourceTableRows(html);
      assert.equal(
        rows.length,
        expectedRows,
        `hub "${slug}": linhas da tabela (${rows.length}) != manchetes esperadas (${expectedRows})`,
      );
    });
  }
});

describe("bibliografia dos hubs — data e manchete em <td> distintos, nunca concatenados (#4921, resolve por construção o #4918 Conserto 1)", () => {
  // Regression: no formato <li> anterior, `<span class="li-date">06/08/2026</span>`
  // sem separador textual virava "06/08/2026Modelo da Anthropic finge ser
  // humano em teste" pra quem extraía o texto (assistente, leitor de tela,
  // colagem). Com `<td>` distintos a concatenação deixa de ser possível por
  // construção — este teste garante isso diretamente: o texto bruto de
  // `${dateLabel}${titleLabel}` (a forma colada) nunca aparece no HTML.
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": nenhuma linha da bibliografia concatena data e manchete no mesmo texto`, () => {
      const html = renderHubPage(HUB_LOADERS[slug]());
      const rows = extractSourceTableRows(html);
      assert.ok(rows.length > 0, `hub "${slug}" sem linhas de bibliografia extraídas — regex de teste desatualizada?`);
      for (const row of rows) {
        assert.ok(
          !html.includes(`${row.dateLabel}${row.titleLabel}`),
          `linha "${row.dateLabel}" / "${row.titleLabel}" do hub "${slug}" concatena data e manchete sem separação estrutural`,
        );
      }
    });
  }
});

describe("bibliografia dos hubs — data com ano (#4911 item 4)", () => {
  // Regression: rótulo saía truncado em DD/MM (sem ano) — ambíguo num
  // intervalo que cruza virada de ano e cresce a cada regeneração.
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": todo rótulo de data da bibliografia é DD/MM/AAAA`, () => {
      const html = renderHubPage(HUB_LOADERS[slug]());
      const items = extractSourceTableRows(html);
      assert.ok(items.length > 0);
      for (const item of items) {
        assert.match(
          item.dateLabel,
          /^\d{2}\/\d{2}\/\d{4}$/,
          `rótulo de data "${item.dateLabel}" do hub "${slug}" não é DD/MM/AAAA`,
        );
      }
    });
  }
});

describe("editionTitle na bibliografia (#4918 Conserto 2)", () => {
  it("sourceEditionLabel: sem editionTitle cai no rótulo antigo (só a manchete casada)", () => {
    const e = { date: "2026-01-01", title: "Manchete casada", url: "https://diar.ia.br/p/edicao-1" };
    assert.equal(sourceEditionLabel(e), "Manchete casada");
  });

  it("sourceEditionLabel: editionTitle igual à manchete não duplica", () => {
    const e = {
      date: "2026-01-01",
      title: "Mesmo texto",
      editionTitle: "Mesmo texto",
      url: "https://diar.ia.br/p/edicao-1",
    };
    assert.equal(sourceEditionLabel(e), "Mesmo texto");
  });

  it("sourceEditionLabel: editionTitle igual a UMA das manchetes do join \" · \" (2+ manchetes casadas na mesma edição) não duplica — regression do self-review: comparar só contra a string inteira deixava passar \"A · B (edição: A)\"", () => {
    const e = {
      date: "2026-01-01",
      title: "Claude Mythos: o modelo mais perigoso do mundo · Anthropic vence o Pentágono na Justiça",
      editionTitle: "Claude Mythos: o modelo mais perigoso do mundo",
      url: "https://diar.ia.br/p/claude-mythos-o-modelo-mais-perigoso-do-mundo",
    };
    assert.equal(
      sourceEditionLabel(e),
      "Claude Mythos: o modelo mais perigoso do mundo · Anthropic vence o Pentágono na Justiça",
    );
  });

  it("sourceEditionLabel: editionTitle presente e distinto aparece junto da manchete — regression do achado #4918 (\"Anthropic triplica valuation\" apontando pra uma edição sobre outro assunto)", () => {
    const e = {
      date: "2026-01-01",
      title: "Anthropic triplica valuation",
      editionTitle: "Brasil pretende investir R$ 23 bi em IA",
      url: "https://diar.ia.br/p/brasil-pretende-investir-r-23-bilh-es-em-ia",
    };
    const label = sourceEditionLabel(e);
    assert.match(label, /Anthropic triplica valuation/);
    assert.match(label, /Brasil pretende investir R\$ 23 bi em IA/);
  });

  it("contra o dataset real: pelo menos 1 hub tem editionTitle populado divergindo da manchete casada (prova que o backfill via titles-cache.json rodou, não só o fallback sintético)", () => {
    let foundDivergent = false;
    for (const slug of Object.keys(HUB_LOADERS)) {
      const hub = HUB_LOADERS[slug]();
      for (const e of hub.sourceEditions) {
        if (e.editionTitle && e.editionTitle !== e.title) foundDivergent = true;
      }
    }
    assert.ok(foundDivergent, "nenhum hub tem sourceEdition com editionTitle divergente da manchete — backfill não rodou?");
  });
});

describe("validateHubContent — publishedDate/updatedDate (#4911)", () => {
  const base: HubContent = {
    slug: "teste-datas",
    title: "Teste",
    metaDescription: "Descrição.",
    introHeading: "Pergunta?",
    introParagraph: "Intro.",
    sections: [{ heading: "Seção", paragraphs: ["Parágrafo em 1 de agosto de 2026."] }],
    faq: Array.from({ length: 6 }, (_, i) => ({ question: `P${i}?`, answer: `R${i}.` })),
    sourceEditions: [{ date: "2026-08-01", title: "Edição", url: "https://diar.ia.br/p/edicao-teste" }],
    publishedDate: "2026-08-01",
    updatedDate: "2026-08-01",
    footerNavUtm: { source: "test", medium: "footer-nav" },
    methodologyNote: "O levantamento vem de 1 edição publicada em agosto de 2026; os números saem do arquivo da diar.ia.br, não de verificação independente junto às empresas.",
  };

  it("aceita publishedDate === updatedDate", () => {
    assert.deepEqual(validateHubContent(base), []);
  });

  it("rejeita updatedDate < publishedDate — regression: campo único não conseguia expressar essa violação", () => {
    const hub: HubContent = { ...base, publishedDate: "2026-08-05", updatedDate: "2026-08-01" };
    const errors = validateHubContent(hub);
    assert.ok(errors.some((e) => /updatedDate .* anterior a publishedDate/.test(e)), errors.join("; "));
  });

  it("rejeita updatedDate anterior à edição mais recente citada em sourceEditions", () => {
    const hub: HubContent = {
      ...base,
      updatedDate: "2026-07-01",
      sourceEditions: [{ date: "2026-08-01", title: "Edição", url: "https://diar.ia.br/p/edicao-teste" }],
    };
    const errors = validateHubContent(hub);
    assert.ok(errors.some((e) => /anterior à edição mais recente citada/.test(e)), errors.join("; "));
  });

  it("aceita updatedDate posterior a publishedDate e à fonte mais recente", () => {
    const hub: HubContent = { ...base, publishedDate: "2026-08-01", updatedDate: "2026-08-10" };
    assert.deepEqual(validateHubContent(hub), []);
  });

  // #5124 item 3: teto é SEPARADO de validateHubContent (nunca bloqueia) —
  // ver checkUpdatedDateCeiling abaixo.
  it("updatedDate MUITO à frente da fonte mais recente NÃO é erro de validateHubContent (é warning separado, #5124)", () => {
    const hub: HubContent = { ...base, publishedDate: "2026-08-01", updatedDate: "2026-08-01" };
    assert.deepEqual(validateHubContent({ ...hub, sourceEditions: [{ date: "2026-06-01", title: "Antiga", url: "https://diar.ia.br/p/antiga" }], updatedDate: "2026-08-01" }), []);
  });
});

describe("checkUpdatedDateCeiling (#5124 item 3) — heurístico, nunca bloqueia", () => {
  const baseCeiling: Pick<HubContent, "updatedDate" | "sourceEditions"> = {
    sourceEditions: [{ date: "2026-06-25", title: "Edição", url: "https://diar.ia.br/p/edicao-teste" }],
    updatedDate: "2026-06-25",
  };

  it("gap 0 (updatedDate === coverageDate) -> sem warning", () => {
    assert.deepEqual(checkUpdatedDateCeiling(baseCeiling), []);
  });

  it(`gap abaixo do limiar (${HUB_UPDATED_DATE_CEILING_WARN_DAYS - 1} dias) -> sem warning`, () => {
    const hub = { ...baseCeiling, updatedDate: "2026-07-14" }; // 19 dias após 06-25
    assert.deepEqual(checkUpdatedDateCeiling(hub), []);
  });

  it("gap NO limiar exato -> warning (>=, não >)", () => {
    const hub = { ...baseCeiling, updatedDate: "2026-07-16" }; // exatamente 21 dias após 06-25
    const warnings = checkUpdatedDateCeiling(hub);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /21 dias/);
  });

  it("gap 48 dias (caso real brasil-regulacao) -> warning nomeando updatedDate e coverageDate", () => {
    const hub = { ...baseCeiling, updatedDate: "2026-08-12" };
    const warnings = checkUpdatedDateCeiling(hub);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2026-08-12/);
    assert.match(warnings[0], /2026-06-25/);
    assert.match(warnings[0], /48 dias/);
  });

  it("sourceEditions vazio -> sem warning (defensivo, coberto por validateHubContent separadamente)", () => {
    assert.deepEqual(checkUpdatedDateCeiling({ sourceEditions: [], updatedDate: "2026-08-12" }), []);
  });

  it("updatedDate malformado -> sem warning (defensivo, coberto por validateHubContent separadamente)", () => {
    assert.deepEqual(checkUpdatedDateCeiling({ ...baseCeiling, updatedDate: "não-é-data" }), []);
  });

  it("os 6 hubs reais de HUB_LOADERS: só brasil-regulacao dispara warning hoje (48 dias medidos em 12/08/2026, #5124) — os outros 5 ficam dentro do limiar", () => {
    // #5124 item 5 (decisão do editor, fora de escopo desta issue): o gap do
    // brasil-regulacao É real — o #5071 genuinamente revisou a prosa
    // (removeu 6 de 11 links) em 12/08, só que sem fonte nova pra citar. O
    // warning aqui é o comportamento CORRETO (torna a defasagem visível),
    // não um bug — não "consertar" mudando updatedDate pra silenciar.
    for (const slug of Object.keys(HUB_LOADERS)) {
      const hub = HUB_LOADERS[slug]();
      const warnings = checkUpdatedDateCeiling(hub);
      if (slug === "brasil-regulacao") {
        assert.ok(warnings.length > 0, "brasil-regulacao deveria disparar o warning de teto (gap conhecido, #5124)");
      } else {
        assert.deepEqual(warnings, [], `hub "${slug}" tem warning de teto inesperado: ${warnings.join("; ")}`);
      }
    }
  });
});

describe("datePublished/dateModified do JSON-LD (#4911, dateModified redirecionado pra coverageDate no #5124)", () => {
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": datePublished bate com publishedDate; dateModified bate com hubCoverageDate(sourceEditions), NÃO com updatedDate`, () => {
      const hub = HUB_LOADERS[slug]();
      const html = renderHubPage(hub);
      const m = /"datePublished":"([^"]*)","dateModified":"([^"]*)"/.exec(html);
      assert.ok(m, `hub "${slug}" sem datePublished/dateModified no JSON-LD`);
      assert.equal(m![1], hub.publishedDate);
      assert.equal(m![2], hubCoverageDate(hub.sourceEditions));
    });
  }
});

describe("hubCoverageDate (#5124) — teto: updatedDate pode divergir de dateModified sem que isso vaze pro schema", () => {
  it("hub sintético com updatedDate MUITO à frente da fonte mais recente (caso brasil-regulacao) — dateModified segue a fonte, não updatedDate", () => {
    const hub: HubContent = {
      slug: "teste-coverage-date",
      title: "Teste",
      metaDescription: "Descrição.",
      introHeading: "Pergunta?",
      introParagraph: "Intro.",
      sections: [{ heading: "Seção", paragraphs: ["Parágrafo em 25 de junho de 2026."] }],
      faq: Array.from({ length: 6 }, (_, i) => ({ question: `P${i}?`, answer: `R${i}.` })),
      sourceEditions: [{ date: "2026-06-25", title: "Edição", url: "https://diar.ia.br/p/edicao-teste" }],
      publishedDate: "2026-06-25",
      // Bump cosmético (remove conteúdo, não adiciona fonte) — cenário real
      // medido em 12/08/2026 no hub brasil-regulacao (#5124), 48 dias à frente.
      updatedDate: "2026-08-12",
      footerNavUtm: { source: "test", medium: "footer-nav" },
      methodologyNote: "O levantamento vem de 1 edição publicada em junho de 2026; os números saem do arquivo da diar.ia.br, não de verificação independente junto às empresas.",
    };
    assert.equal(hubCoverageDate(hub.sourceEditions), "2026-06-25");
    const html = renderHubPage(hub);
    const m = /"datePublished":"([^"]*)","dateModified":"([^"]*)"/.exec(html);
    assert.ok(m);
    assert.equal(m![2], "2026-06-25", "dateModified deveria refletir a cobertura real (06-25), não o bump cosmético (08-12)");
  });

  it("commit que REMOVE a fonte mais recente (item que sumiu de sourceEditions) não avança coverageDate — nunca avança sozinho, só regride ou fica igual", () => {
    const before = [
      { date: "2026-06-25", title: "Mais recente", url: "https://diar.ia.br/p/a" },
      { date: "2026-05-01", title: "Mais antiga", url: "https://diar.ia.br/p/b" },
    ];
    const coverageBefore = hubCoverageDate(before);
    // "commit" que remove o item mais recente (ex: #5071, "reduz densidade
    // de fonte primária" removeu itens sem adicionar nada novo).
    const after = before.filter((e) => e.date !== "2026-06-25");
    const coverageAfter = hubCoverageDate(after);
    assert.equal(coverageBefore, "2026-06-25");
    assert.equal(coverageAfter, "2026-05-01");
    assert.ok(coverageAfter <= coverageBefore, "remover uma fonte nunca pode fazer coverageDate AVANÇAR");
  });
});

/** Fixture mínima reusada pelos testes de metaDescription/nav abaixo (#4913)
 * — cópia deliberada da `base` local de "validateHubContent —
 * publishedDate/updatedDate (#4911)" acima: aquele `const base` é escopado
 * DENTRO do describe, não exportado pro módulo, então cada bloco novo que
 * precisa de um `HubContent` sintético mínimo declara o próprio (mesmo
 * padrão já usado pelo arquivo — nenhum describe reusa a `base` de outro). */
const HUB_4913_TEST_BASE: HubContent = {
  slug: "teste-4913",
  title: "Teste",
  metaDescription: "Descrição.",
  introHeading: "Pergunta?",
  introParagraph: "Intro.",
  sections: [{ heading: "Seção", paragraphs: ["Parágrafo em 1 de agosto de 2026."] }],
  faq: Array.from({ length: 6 }, (_, i) => ({ question: `P${i}?`, answer: `R${i}.` })),
  sourceEditions: [{ date: "2026-08-01", title: "Edição", url: "https://diar.ia.br/p/edicao-teste" }],
  publishedDate: "2026-08-01",
  updatedDate: "2026-08-01",
  footerNavUtm: { source: "hub-teste-4913", medium: "footer-nav" },
  methodologyNote:
    "O levantamento vem de 1 edição publicada em agosto de 2026; os números saem do arquivo da diar.ia.br, não de verificação independente junto às empresas.",
};

describe("validateHubContent — metaDescription ≤160 chars (#4913 item 2)", () => {
  it("aceita metaDescription com exatamente 160 caracteres", () => {
    const hub: HubContent = { ...HUB_4913_TEST_BASE, metaDescription: "x".repeat(160) };
    assert.deepEqual(validateHubContent(hub), []);
  });

  it("rejeita metaDescription com 161 caracteres — mensagem nomeia o campo e o comprimento medido", () => {
    const hub: HubContent = { ...HUB_4913_TEST_BASE, metaDescription: "x".repeat(161) };
    const errors = validateHubContent(hub);
    assert.ok(
      errors.some((e) => e.includes("metaDescription") && e.includes("161") && /máximo 160/.test(e)),
      errors.join("; "),
    );
  });
});

describe("metaDescription dos 4 hubs reais está dentro do limite de 160 chars (#4913) — guard sobre HUB_LOADERS", () => {
  // Sem este guard, a validação só protegeria hub FUTURO — os 4 hubs de hoje
  // (175/200/211 chars medidos na issue #4913, antes do encurtamento do
  // item 1) passariam despercebidos até alguém tentar regenerar o build.
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": metaDescription ≤ 160 caracteres`, () => {
      const hub = HUB_LOADERS[slug]();
      assert.ok(
        hub.metaDescription.length <= 160,
        `hub "${slug}": metaDescription tem ${hub.metaDescription.length} caracteres — "${hub.metaDescription}"`,
      );
    });
  }
});

describe('nav "Outros temas" no rodapé do hub (#4913 itens 1/3/4)', () => {
  it("com N irmãos: HTML contém o href /temas/ de cada irmão, NÃO contém o próprio slug na nav, e cross-linka de volta pro índice reusando footerNavUtm", () => {
    const hub: HubContent = {
      ...HUB_4913_TEST_BASE,
      slug: "propria-pagina",
      footerNavUtm: { source: "hub-propria-pagina", medium: "footer-nav" },
      relatedHubs: [
        { slug: "irmao-a", label: "Irmão A" },
        { slug: "irmao-b", label: "Irmão B" },
      ],
    };
    const html = renderHubPage(hub);
    const navMatch = /<nav class="hub-related-nav"[\s\S]*?<\/nav>/.exec(html);
    assert.ok(navMatch, 'nav "hub-related-nav" ausente do HTML renderizado');
    const navHtml = navMatch![0];
    assert.match(navHtml, /href="https:\/\/arquivo\.diar\.ia\.br\/temas\/irmao-a"/);
    assert.match(navHtml, /href="https:\/\/arquivo\.diar\.ia\.br\/temas\/irmao-b"/);
    // `propria-pagina` é o próprio slug do hub — não pode aparecer como link
    // DENTRO da nav (a página tem outros hrefs legítimos pro próprio slug
    // fora dela, ex: <link rel="canonical">/og:url — checar o HTML inteiro
    // daria falso positivo, por isso o escopo é só `navHtml`).
    assert.doesNotMatch(navHtml, /href="https:\/\/arquivo\.diar\.ia\.br\/temas\/propria-pagina"/);
    // item 4: cross-link de volta pro índice do arquivo, reusando o MESMO
    // footerNavUtm já usado pelo link "diar.ia.br" (nenhuma entrada nova no
    // registry de UTM).
    assert.match(
      navHtml,
      /href="https:\/\/arquivo\.diar\.ia\.br\/\?utm_source=hub-propria-pagina&amp;utm_medium=footer-nav"/,
    );
  });

  it("com 0 irmãos (hub único): a seção inteira não é emitida", () => {
    const hub: HubContent = { ...HUB_4913_TEST_BASE, relatedHubs: [] };
    const html = renderHubPage(hub);
    assert.doesNotMatch(html, /class="hub-related-nav"/);
  });

  it("relatedHubs ausente (campo opcional não preenchido): a seção não é emitida", () => {
    const html = renderHubPage(HUB_4913_TEST_BASE);
    assert.doesNotMatch(html, /class="hub-related-nav"/);
  });

});

describe("renderHubPage — coverImage (#5131) e feed RSS (#5127) no <head>", () => {
  it("sem coverImage: og:image não é emitido (comportamento idêntico a antes)", () => {
    const html = renderHubPage(HUB_4913_TEST_BASE);
    assert.doesNotMatch(html, /property="og:image"/);
  });

  it("com coverImage: emite og:image/twitter:image + width/height, twitter:card=summary_large_image", () => {
    const hub: HubContent = {
      ...HUB_4913_TEST_BASE,
      coverImage: { url: "https://media.beehiiv.com/capa-hub.jpg", width: 1600, height: 800 },
    };
    const html = renderHubPage(hub);
    assert.match(html, /<meta property="og:image" content="https:\/\/media\.beehiiv\.com\/capa-hub\.jpg">/);
    assert.match(html, /<meta property="og:image:width" content="1600">/);
    assert.match(html, /<meta property="og:image:height" content="800">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  });

  it("todo hub declara <link rel=alternate> pro MESMO feed do arquivo (#5127 item 3)", () => {
    const html = renderHubPage(HUB_4913_TEST_BASE);
    assert.match(
      html,
      /<link rel="alternate" type="application\/rss\+xml"[^>]*href="https:\/\/arquivo\.diar\.ia\.br\/feed\.xml">/,
    );
  });
});

describe("loadHubContent — coverImage via titles-cache.json (#5131)", () => {
  it("todo hub real: coverImage é undefined OU um objeto {url,width:1600,height:800} válido — nunca lança, nunca URL vazia", () => {
    // titles-cache.json committado hoje não tem nenhum coverImageUrl (#5131
    // precisou de uma sessão local pra regenerar o cache com esse campo —
    // ver docstring de generate-arquivo-titles.ts); este teste não assume
    // qual dos dois casos vale HOJE — só que, seja qual for, o mecanismo
    // nunca produz um valor inválido, e continua válido depois que o cache
    // for regenerado localmente com dados reais.
    for (const slug of Object.keys(HUB_LOADERS)) {
      const hub = loadHubContent(slug);
      if (hub.coverImage !== undefined) {
        assert.ok(hub.coverImage.url.length > 0, `hub "${slug}": coverImage.url vazia`);
        assert.equal(hub.coverImage.width, 1600);
        assert.equal(hub.coverImage.height, 800);
      }
    }
  });
});

describe("scripts/build-hub-page.ts preenche relatedHubs com os hubs IRMÃOS reais de HUB_META (#4913 item 3)", () => {
  // `HUB_LOADERS[slug]()` sozinho NUNCA popula `relatedHubs` — é
  // `scripts/build-hub-page.ts` (`buildOne`) quem faz `HUB_META.filter((m) =>
  // m.slug !== slug)` antes de renderizar (ver docstring do campo em
  // `hub-page.ts`). Este teste replica exatamente esse cálculo pra garantir
  // que, pra CADA um dos 4 hubs reais, a nav lista os outros e nunca o
  // próprio slug — sem isso a cobertura acima só provaria o mecanismo
  // genérico, não que os 4 hubs de hoje o exercitam corretamente.
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": nav lista todo HUB_META exceto o próprio slug`, () => {
      const relatedHubs = HUB_META.filter((m) => m.slug !== slug);
      assert.ok(relatedHubs.length > 0, "HUB_META tem 1 único hub — nada pra testar aqui");
      const hub: HubContent = { ...HUB_LOADERS[slug](), relatedHubs };
      const html = renderHubPage(hub);
      const navMatch = /<nav class="hub-related-nav"[\s\S]*?<\/nav>/.exec(html);
      assert.ok(navMatch, `hub "${slug}" sem nav "Outros temas" no HTML renderizado`);
      const navHtml = navMatch![0];
      for (const sibling of relatedHubs) {
        assert.match(
          navHtml,
          new RegExp(`href="https://arquivo\\.diar\\.ia\\.br/temas/${sibling.slug}"`),
          `nav do hub "${slug}" não linka o irmão "${sibling.slug}"`,
        );
      }
      assert.doesNotMatch(
        navHtml,
        new RegExp(`href="https://arquivo\\.diar\\.ia\\.br/temas/${slug}"`),
        `nav do hub "${slug}" linka o próprio slug`,
      );
    });
  }
});

describe("links de fonte primária na prosa das 5 seções (#4919 item 8, Fase C)", () => {
  // Cada `[texto](url)` de `sections[].paragraphs` cujo destino NÃO é
  // `diar.ia.br` (o domínio de marca usado pelos links internos existentes,
  // ver `toSourceEditions`) é, por construção, um link de FONTE PRIMÁRIA —
  // adicionado por esta fase a partir de `primarySourceUrls`
  // (`generate-hub-sources.ts`, Fase A/B). O rótulo fixo `fonte primária`
  // (não um label narrativo) é o marcador usado pra anexar a citação
  // imediatamente após o link interno da manchete correspondente, sem
  // remover/substituir esse link interno — ver docstring do #4919 item 8 no
  // dispatch da rodada 260811b (branch `overnight/fix-4919-primary-source-prose`).
  function externalLinksInSections(hub: HubContent): { url: string; label: string }[] {
    const out: { url: string; label: string }[] = [];
    for (const section of hub.sections) {
      for (const paragraph of section.paragraphs) {
        for (const link of findParagraphLinks(paragraph)) {
          if (!link.url.startsWith("https://diar.ia.br/")) out.push({ url: link.url, label: link.label });
        }
      }
    }
    return out;
  }

  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": todo link de fonte primária nas seções aponta pra um domínio externo (nunca diar.ia.br)`, () => {
      const hub = HUB_LOADERS[slug]();
      const external = externalLinksInSections(hub);
      for (const { url } of external) {
        const host = new URL(url).host;
        assert.notEqual(host, "diar.ia.br", `link "${url}" deveria ser fonte primária externa, não o domínio de marca`);
        assert.equal(new URL(url).protocol, "https:", `link "${url}" não é https:`);
      }
    });
  }

  it('hub "anthropic-claude": tem pelo menos 1 link de fonte primária externo nas 5 seções', () => {
    const external = externalLinksInSections(HUB_LOADERS["anthropic-claude"]());
    assert.ok(external.length > 0, "esperava >0 links de fonte primária em anthropic-claude — o hub com maior cobertura medida (54/84)");
  });

  it('hub "openai-chatgpt": tem pelo menos 1 link de fonte primária externo nas 5 seções', () => {
    const external = externalLinksInSections(HUB_LOADERS["openai-chatgpt"]());
    assert.ok(external.length > 0, "esperava >0 links de fonte primária em openai-chatgpt — 2º hub com maior cobertura medida (55/104)");
  });

  it("nenhum link de fonte primária tem rótulo com verbo de atribuição, aspas ou nome de executivo (decisão registrada na issue #4919 — 'Fora de escopo')", () => {
    // Guard leve, não semântico: o rótulo usado por ESTA fase é sempre o
    // marcador fixo "fonte primária" — nunca prosa livre gerada por
    // heurística. Se algum link externo aparecer com outro rótulo, ou é
    // uma citação pré-existente (ok, não é desta fase) ou um jeito
    // acidental de reintroduzir atribuição narrativa (não ok) — o teste
    // não distingue os dois casos automaticamente, então só documenta o
    // marcador fixo esperado pra `fonte primária` especificamente.
    for (const slug of Object.keys(HUB_LOADERS)) {
      const hub = HUB_LOADERS[slug]();
      for (const section of hub.sections) {
        for (const paragraph of section.paragraphs) {
          for (const link of findParagraphLinks(paragraph)) {
            if (link.url.startsWith("https://diar.ia.br/")) continue;
            if (link.label !== "fonte primária") continue; // rótulo de OUTRA fase/origem — fora do escopo deste guard
            assert.doesNotMatch(link.label, /disse|afirmou|declarou|segundo|de acordo com/i);
          }
        }
      }
    }
  });
});

describe("validateHubContent — table.rows aridade (#4921 Onda 2 item 9)", () => {
  const base: HubContent = {
    ...HUB_4913_TEST_BASE,
    slug: "teste-4921-table",
    sections: [
      {
        heading: "Seção com tabela",
        paragraphs: ["Parágrafo em 1 de agosto de 2026."],
        table: {
          caption: "Tabela de teste",
          methodology: "Nota de metodologia.",
          headers: ["A", "B"],
          rows: [["1", "2"]],
        },
      },
    ],
  };

  it("aceita rows com aridade igual a headers", () => {
    assert.deepEqual(validateHubContent(base), []);
  });

  it("rejeita table.rows vazio — mensagem nomeia hub e seção", () => {
    const hub: HubContent = {
      ...base,
      sections: [{ ...base.sections[0], table: { ...base.sections[0].table!, rows: [] } }],
    };
    const errors = validateHubContent(hub);
    assert.ok(
      errors.some(
        (e) => e.includes('hub "teste-4921-table"') && e.includes('"Seção com tabela"') && /rows está vazio/.test(e),
      ),
      errors.join("; "),
    );
  });

  it("rejeita linha com aridade diferente do header — mensagem nomeia hub, seção e o índice da linha", () => {
    const hub: HubContent = {
      ...base,
      sections: [
        {
          ...base.sections[0],
          table: { ...base.sections[0].table!, rows: [["1", "2"], ["só uma célula"]] },
        },
      ],
    };
    const errors = validateHubContent(hub);
    assert.ok(
      errors.some(
        (e) =>
          e.includes('hub "teste-4921-table"') &&
          e.includes('"Seção com tabela"') &&
          /rows\[1\] tem 1 célula/.test(e) &&
          /headers tem 2/.test(e),
      ),
      errors.join("; "),
    );
  });

  it("seção sem table (campo opcional ausente) não é validada — regression: opcional não pode virar obrigatório por acidente", () => {
    const hub: HubContent = { ...base, sections: [{ heading: "Sem tabela", paragraphs: ["Parágrafo em 1 de agosto de 2026."] }] };
    assert.deepEqual(validateHubContent(hub), []);
  });
});

describe("cronologia de lançamento (S1.table) do hub anthropic-claude — derivada de SOURCES, nunca transcrita (#4921 Onda 2)", () => {
  // Molde do bloco "consistência FAQ × prosa" já existente no arquivo
  // (linha ~99 e ~314): não reimplementa o cálculo de dentro de
  // anthropic-claude.ts (LAUNCH_PATTERN é privado do módulo, de propósito —
  // não exportado só pra um teste ler), e sim cruza DOIS números que já são
  // computados de formas independentes dentro do próprio hub — a contagem/
  // hiato que o FAQ deriva (`buildAnthropicClaudeFaq`) contra as linhas da
  // tabela que `getAnthropicClaudeHub` monta (`buildLaunchChronologyTable`).
  // Se os dois algum dia divergirem — regen que atualiza um sem o outro,
  // edição manual futura — este teste quebra.
  const hub = getAnthropicClaudeHub();
  const faq = buildAnthropicClaudeFaq(sourcesRaw as never);
  const launchFaqAnswer = faq.find((f) => /Foram \d+ lançamentos/.test(f.answer))?.answer ?? "";
  const launchSection = hub.sections.find((s) => s.heading.startsWith("Com que frequência"));

  it("S1 carrega uma table (#4921 Onda 2 aplicada)", () => {
    assert.ok(launchSection, "seção S1 não encontrada");
    assert.ok(launchSection!.table, "S1 sem table — #4921 Onda 2 não aplicada");
  });

  it("1 linha por lançamento — mesmo N que o FAQ computa (\"Foram N lançamentos\")", () => {
    const launchMatch = /Foram (\d+) lançamentos/.exec(launchFaqAnswer);
    assert.ok(launchMatch, 'FAQ não tem a contagem de lançamentos no formato "Foram N lançamentos"');
    assert.equal(launchSection!.table!.rows.length, Number(launchMatch![1]));
  });

  it("headers e cada row têm a mesma aridade (4 colunas: Lançamento, Data, Dias desde o anterior, Edição)", () => {
    const { headers, rows } = launchSection!.table!;
    assert.equal(headers.length, 4);
    for (const row of rows) assert.equal(row.length, headers.length);
  });

  it("linhas em ordem cronológica ASCENDENTE por data (coluna 2, DD/MM/AAAA)", () => {
    const rows = launchSection!.table!.rows;
    const toIso = (label: string) => {
      const [d, m, y] = label.split("/");
      return `${y}-${m}-${d}`;
    };
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        toIso(rows[i][1]) >= toIso(rows[i - 1][1]),
        `linha ${i} ("${rows[i][1]}") vem antes da linha ${i - 1} ("${rows[i - 1][1]}") — deveria ser ascendente`,
      );
    }
  });

  it('primeira linha não tem "dias desde o anterior" (sem lançamento anterior pra comparar) — usa "—"', () => {
    assert.equal(launchSection!.table!.rows[0][2], "—");
  });

  it(
    "o MAIOR valor de \"dias desde o anterior\" bate com o hiato que o FAQ cita em prosa — resolve por construção " +
      "a divergência hiato/dias que a auditoria #4921 catalogou (achado M-07: INTRO dizia meses, S1/FAQ diziam dias, " +
      "sem nada religando os dois; a tabela deriva do MESMO array de datas ordenadas que alimenta o hiato do FAQ, " +
      "então não há como um número mudar sem o outro acompanhar)",
    () => {
      const gapMatch = /hiato de (\d+) dias/.exec(launchFaqAnswer);
      assert.ok(gapMatch, 'FAQ não cita "hiato de N dias" no formato esperado');
      const rows = launchSection!.table!.rows;
      const gaps = rows.slice(1).map((r) => Number(r[2]));
      assert.ok(gaps.length > 0, "tabela com <2 linhas — não há gap pra comparar");
      assert.equal(Math.max(...gaps), Number(gapMatch![1]));
    },
  );

  it("coluna 'Edição' é sempre um link markdown pra diar.ia.br (nunca prosa solta)", () => {
    for (const row of launchSection!.table!.rows) {
      assert.match(row[3], /^\[Ver edição\]\(https:\/\/diar\.ia\.br\/p\/[^)]+\)$/);
    }
  });

  it("methodology cita o total REAL de edições e manchetes de sourcesRaw (nunca literal — muda a cada regen)", () => {
    const totalEditions = (sourcesRaw as unknown[]).length;
    const totalMentions = (sourcesRaw as { matchedHeadlines: string[] }[]).reduce(
      (n, s) => n + s.matchedHeadlines.length,
      0,
    );
    assert.match(launchSection!.table!.methodology, new RegExp(`${totalEditions} edições`));
    assert.match(launchSection!.table!.methodology, new RegExp(`${totalMentions} manchetes`));
  });

  it("a tabela renderiza no HTML final dentro de .hub-section, com <caption>/<thead>/1 <tr> por linha", () => {
    const html = renderHubPage(hub);
    const sectionMatch = /<article class="hub-section">\s*<h2>Com que frequência[\s\S]*?<\/article>/.exec(html);
    assert.ok(sectionMatch, "seção S1 não encontrada no HTML renderizado");
    const sectionHtml = sectionMatch![0];
    assert.match(sectionHtml, /<div class="hub-section-table-wrap">/);
    assert.match(sectionHtml, /<caption>Cronologia de lançamento/);
    assert.match(sectionHtml, /<thead>/);
    const trCount = (sectionHtml.match(/<tbody>[\s\S]*?<\/tbody>/)![0].match(/<tr>/g) ?? []).length;
    assert.equal(trCount, launchSection!.table!.rows.length);
  });
});
