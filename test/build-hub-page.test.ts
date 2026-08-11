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

import { renderGeneratedModule, HUB_LOADERS } from "../scripts/build-hub-page.ts";
import { renderHubPage, sourceEditionLabel, validateHubContent, type HubContent } from "../scripts/lib/shared/hub-page.ts";
import { buildAnthropicClaudeFaq, getAnthropicClaudeHub } from "../scripts/lib/hubs/anthropic-claude.ts";
import { buildOpenaiChatgptFaq } from "../scripts/lib/hubs/openai-chatgpt.ts";
import { knownUtmSources, HUB_ANTHROPIC_CLAUDE_FOOTER_NAV_UTM } from "../scripts/lib/shared/utm-registry.ts";
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

/** Extrai `{dateLabel, titleLabel}` de cada `<li>` da bibliografia
 * (`.hub-sources`) do HTML renderizado — usado pelas regressões #4918/#4911
 * abaixo, que precisam inspecionar o texto efetivamente visível, não só o
 * campo `HubSourceEdition.title` isolado. */
function extractSourceListItems(html: string): { dateLabel: string; sep: string; titleLabel: string }[] {
  const items: { dateLabel: string; sep: string; titleLabel: string }[] = [];
  const re = /<li><a href="[^"]*"><span class="li-date">([^<]*)<\/span>(.*?)<\/a><\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const dateLabel = m[1];
    const rest = m[2];
    const sepMatch = /^(\s*—\s*|\s+)/.exec(rest);
    const sep = sepMatch ? sepMatch[0] : "";
    items.push({ dateLabel, sep, titleLabel: rest.slice(sep.length) });
  }
  return items;
}

describe("bibliografia dos hubs — separador data/título (#4918 Conserto 1)", () => {
  // Regression: antes do fix, `<span class="li-date">06/08/2026</span>` era
  // seguido IMEDIATAMENTE do título, sem nenhum caractere entre os dois — a
  // separação era só visual (margin-right no CSS). Quem extrai o texto do
  // HTML (assistente, leitor de tela, colagem) recebia os dois colados.
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": todo item da bibliografia tem separador textual entre data e título`, () => {
      const html = renderHubPage(HUB_LOADERS[slug]());
      const items = extractSourceListItems(html);
      assert.ok(items.length > 0, `hub "${slug}" sem itens de bibliografia extraídos — regex de teste desatualizada?`);
      for (const item of items) {
        assert.ok(
          item.sep.length > 0,
          `item "${item.dateLabel}${item.titleLabel}" do hub "${slug}" não tem separador entre data e título`,
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
      const items = extractSourceListItems(html);
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
    sections: [{ heading: "Seção", paragraphs: ["Parágrafo."] }],
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
});

describe("datePublished/dateModified do JSON-LD divergem quando publishedDate ≠ updatedDate (#4911) — regression ao vivo do dateModified falso", () => {
  for (const slug of Object.keys(HUB_LOADERS)) {
    it(`hub "${slug}": datePublished/dateModified do schema batem com publishedDate/updatedDate do HubContent`, () => {
      const hub = HUB_LOADERS[slug]();
      const html = renderHubPage(hub);
      const m = /"datePublished":"([^"]*)","dateModified":"([^"]*)"/.exec(html);
      assert.ok(m, `hub "${slug}" sem datePublished/dateModified no JSON-LD`);
      assert.equal(m![1], hub.publishedDate);
      assert.equal(m![2], hub.updatedDate);
    });
  }
});
