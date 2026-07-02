import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import {
  categorize,
  isVideoUrl,
  isArxivRelevant,
  categorizeArticles,
  isUnresolvableInboxArticle,
  isCustomerStory,
  isNonLaunchPath,
  hasLaunchVerb,
  isThirdPartyBlogAboutOtherCompany,
  isExplainerByTitle,
  isNewsNotTutorial,
  isLaunchSlug,
  isRoundupSlug,
  isCoursePage,
  hasPreExistenceSignal,
  isIncrementalReleaseOnThirdPartyBlog,
  isResearchBySlug,
  isOpenAIFrontiersStory,
  isFirstPartyToolingBlog,
  isDevReleaseNote,
  type Article,
} from "../scripts/categorize.ts";


describe("isRoundupSlug (#2663)", () => {
  it("detecta 'newsletter' no slug (caso real 260630 — langchain)", () => {
    assert.ok(
      isRoundupSlug("https://www.langchain.com/blog/june-2026-langchain-newsletter"),
      "slug 'june-2026-langchain-newsletter' deve ser detectado como roundup",
    );
  });

  it("detecta 'roundup' no slug", () => {
    assert.ok(isRoundupSlug("https://example.com/blog/weekly-ai-roundup-june-2026/"));
  });

  it("detecta 'this-week-in' no slug", () => {
    assert.ok(isRoundupSlug("https://blog.example.com/this-week-in-ai/"));
  });

  it("NÃO detecta 'newsletter' em domínio (não slug)", () => {
    // "newsletter.exemplo.com" — o host não é verificado, só o path
    assert.ok(!isRoundupSlug("https://newsletter.exemplo.com/posts/how-to-build-agents"));
  });

  it("#2691 item 3 FIX: 'how-to-build-a-newsletter' NÃO é mais tratado como roundup", () => {
    // "how-to-build-a-newsletter-with-claude" — o topic é newsletter, mas o artigo É how-to.
    // Antes do #2691 item 3 isRoundupSlug retornava TRUE (FP aceito). Agora
    // ROUNDUP_HOWTO_EXCEPTION_RE (lib/roundup-detect.ts) reconhece o padrão
    // "build/creat/montar/criar (a|an|sua|uma)? newsletter/roundup" como how-to
    // genuíno e desativa o guard.
    assert.ok(!isRoundupSlug("https://example.com/how-to-build-a-newsletter-with-claude"));
  });

  it("#2691 item 3: exceção NÃO enfraquece detecção de roundup real", () => {
    // Regressão de guarda: a exceção é estreita (verbo de criação IMEDIATAMENTE
    // antes de newsletter/roundup) — não deve desativar o guard pra roundups
    // genuínos que só mencionam "newsletter" como substantivo solto.
    assert.ok(isRoundupSlug("https://www.langchain.com/blog/june-2026-langchain-newsletter"));
    assert.ok(isRoundupSlug("https://example.com/blog/weekly-ai-roundup-june-2026/"));
  });

  it("URL inválida retorna false (sem crash)", () => {
    assert.ok(!isRoundupSlug("not-a-url"));
  });

  it("#2691 item 2: detecta sinal de roundup SÓ no título (slug limpo) via 2º argumento", () => {
    // Antes do #2691 item 2, isRoundupSlug(url) só checava o slug — um roundup
    // cujo ÚNICO sinal está no título (ex: URL com slug data-only, título
    // explícito de roundup) escapava o guard.
    assert.ok(
      isRoundupSlug("https://example.com/posts/2026-06-30", "AI Weekly Roundup: Models and Tools"),
      "título com 'roundup' deve ser detectado mesmo com slug limpo",
    );
  });

  it("#2691 item 2: sem 2º argumento continua checando só o slug (compat)", () => {
    assert.ok(!isRoundupSlug("https://example.com/posts/2026-06-30"));
  });
});

// ---------------------------------------------------------------------------
// #2663 — categorize: newsletter/roundup no slug → noticias, não use_melhor
// ---------------------------------------------------------------------------

describe("categorize() — #2663: newsletter/roundup bloqueado de use_melhor", () => {
  it("LangChain blog com slug 'newsletter' → noticias (não use_melhor) — caso real 260630", () => {
    // URL real da edição 260630: LangChain Monthly Newsletter entrou em use_melhor.
    // O slug termina em 'langchain-newsletter' → isRoundupSlug=true → isNewsNotTutorial=true
    // → isTutorialByKeyword bloqueado → langchain.com/blog pattern não classifica como tutorial.
    const art: Article = {
      url: "https://www.langchain.com/blog/june-2026-langchain-newsletter",
      title: "June 2026: LangChain Newsletter, Fleet On-Call Copilot, Deep Agents Rubrics, and More",
    };
    assert.equal(categorize(art), "noticias", "newsletter slug deve ir para RADAR, não USE MELHOR");
    assert.ok(isRoundupSlug(art.url), "isRoundupSlug deve detectar o slug 'newsletter'");
  });

  it("#2663: roundup slug vence type_hint implícito (não derruba use_melhor seed indevidamente)", () => {
    // langchain.com/blog está no TUTORIAL_PATTERNS, mas isRoundupSlug deve bloquear.
    const art: Article = {
      url: "https://www.langchain.com/blog/ai-weekly-roundup/",
      title: "AI Weekly Roundup: LangGraph, RAG, and Agents",
    };
    assert.notEqual(categorize(art), "tutorial", "roundup no slug deve bloquear classificação como tutorial");
  });

  it("#2663: tutorial legítimo de langchain.com/blog SEM slug de roundup ainda é tutorial", () => {
    // Caso de não-regressão: how-to real do LangChain não deve ser bloqueado.
    const art: Article = {
      url: "https://www.langchain.com/blog/how-to-build-agents-with-langgraph",
      title: "How to Build Agents with LangGraph",
    };
    assert.equal(categorize(art), "tutorial", "how-to real não deve ser bloqueado pelo guard de roundup");
    assert.ok(!isRoundupSlug(art.url), "URL de how-to não deve ser detectada como roundup");
  });
});

// ---------------------------------------------------------------------------
// #2666 — categorize: how-to disfarçado de manchete → tutorial (não noticias)
// ---------------------------------------------------------------------------

describe("categorize() — #2666: how-to em manchete PT-BR detectado como tutorial", () => {
  it("canaltech.com.br 'veja como' → tutorial (caso real 260630)", () => {
    // URL real da edição 260630: categorizado como noticias/RADAR por falta de
    // sinal how-to. 'veja como' no título agora dispara isTutorialByKeyword.
    const art: Article = {
      url: "https://canaltech.com.br/inteligencia-artificial/chatgpt-consegue-fazer-check-up-do-seu-pc-sem-abrir-nenhum-arquivo-veja-como/",
      title: "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como",
    };
    assert.equal(categorize(art), "tutorial", "'veja como' no título → use_melhor, não radar");
  });

  it("#2666: 'veja o prompt' no título → tutorial", () => {
    const art: Article = {
      url: "https://tecnoblog.net/ia/como-usar-chatgpt-veja-o-prompt/",
      title: "ChatGPT para currículo: veja o prompt exato que usamos",
    };
    assert.equal(categorize(art), "tutorial", "'veja o prompt' deve sinalizar how-to");
  });

  it("#2666: 'aprenda a usar' no título → tutorial", () => {
    const art: Article = {
      url: "https://canaltech.com.br/ia/aprenda-a-usar-gemini-no-trabalho/",
      title: "Aprenda a usar Gemini para produtividade no trabalho",
    };
    assert.equal(categorize(art), "tutorial", "'aprenda a usar' deve sinalizar how-to");
  });

  it("#2691 item 5: 'saiba como' terminal no título → tutorial", () => {
    const art: Article = {
      url: "https://canaltech.com.br/ia/chatgpt-ganha-novo-recurso-saiba-como/",
      title: "ChatGPT ganha novo recurso de memória; saiba como",
    };
    assert.equal(categorize(art), "tutorial", "'saiba como' terminal deve sinalizar how-to (#2691 item 5)");
  });

  it("#2691 item 5: 'descubra como' terminal no título → tutorial", () => {
    const art: Article = {
      url: "https://canaltech.com.br/ia/gemini-ganha-integracao-descubra-como/",
      title: "Gemini ganha nova integração com o Workspace; descubra como",
    };
    assert.equal(categorize(art), "tutorial", "'descubra como' terminal deve sinalizar how-to (#2691 item 5)");
  });

  it("#2691 item 5: 'saiba como' PREDITIVO (não-terminal) NÃO vira tutorial", () => {
    // Mesmo gate terminal de "veja como" (#2666 gate HIGH 1) se aplica.
    const art: Article = {
      url: "https://canaltech.com.br/ia/saiba-como-a-ia-vai-mudar-o-mercado/",
      title: "Saiba como a IA vai mudar o mercado de trabalho nos próximos anos",
    };
    assert.notEqual(categorize(art), "tutorial", "'saiba como' preditivo não deve virar tutorial");
  });

  it("#2666: notícia sobre ChatGPT SEM 'veja como' continua em noticias", () => {
    // Manchete de notícia pura sem sinal how-to → deve permanecer em RADAR
    const art: Article = {
      url: "https://canaltech.com.br/inteligencia-artificial/openai-anuncia-novo-modelo-gpt-6/",
      title: "OpenAI anuncia novo modelo GPT-6 com capacidades inéditas",
    };
    assert.notEqual(categorize(art), "tutorial", "anúncio sem sinal how-to não deve virar tutorial");
  });

  it("#2666 (gate HIGH 1): 'veja como' PREDITIVO (não-terminal) NÃO vira tutorial", () => {
    // Idioma jornalístico "veja como vai mudar / como funciona" é análise, não how-to.
    // O gate terminal impede o falso-positivo: "veja como" só conta no fim do título.
    const art: Article = {
      url: "https://canaltech.com.br/inteligencia-artificial/openai-nova-funcao/",
      title: "OpenAI anuncia nova função; veja como vai mudar o mercado de trabalho",
    };
    assert.equal(categorize(art), "noticias", "'veja como vai mudar...' é notícia analítica, não tutorial");
  });

  it("#2666 (gate HIGH 1): 'veja como funciona' no summary NÃO vira tutorial", () => {
    // hay = título + summary; "veja como funciona" preditivo no summary não deve disparar.
    const art: Article = {
      url: "https://canaltech.com.br/inteligencia-artificial/anthropic-api-voz/",
      title: "Anthropic lança API de voz",
      summary: "A nova API chegou esta semana; veja como funciona para desenvolvedores.",
    };
    assert.equal(categorize(art), "noticias", "'veja como funciona' (preditivo) no summary não é tutorial");
  });

  it("#2666 (HIGH 2): LANÇAMENTO com 'veja como' terminal NÃO é atropelado para tutorial", () => {
    // type_hint=lancamento (researcher leu a página) tem precedência sobre o sinal
    // de how-to: um anúncio cujo título termina em "veja como" segue para LANÇAMENTO (#160),
    // nunca para USE MELHOR. Sem o guard, isTutorialByKeyword roubaria a classificação.
    const art: Article = {
      url: "https://openai.com/index/gpt-5-disponivel/",
      title: "OpenAI lança GPT-5; veja como",
      type_hint: "lancamento",
    };
    assert.equal(categorize(art), "lancamento", "type_hint=lancamento vence how-to terminal (#160)");
  });
});

// ---------------------------------------------------------------------------
// #2663 + #2666 — Conflito: roundup com 'veja como' → noticias (roundup vence)
// ---------------------------------------------------------------------------

describe("categorize() — #2663+#2666: precedência roundup > how-to", () => {
  it("roundup com 'veja como' no título → noticias (roundup vence — caso de conflito documentado)", () => {
    // Caso de conflito explicitado na issue: um roundup que contém "veja como" no título
    // NÃO deve ser classificado como tutorial. O sinal de roundup (isRoundupSlug via
    // isNewsNotTutorial) é avaliado ANTES de isTutorialByKeyword na cadeia de decisão.
    const art: Article = {
      url: "https://www.langchain.com/blog/june-2026-langchain-newsletter",
      title: "Newsletter de Junho: veja como usar as novas ferramentas do LangChain, e mais",
    };
    assert.notEqual(
      categorize(art),
      "tutorial",
      "roundup com 'veja como' no título deve ir para RADAR (roundup > how-to)",
    );
  });

  it("URL com slug 'newsletter' + título com 'aprenda a' → noticias (roundup no slug vence)", () => {
    const art: Article = {
      url: "https://blog.langchain.dev/july-2026-langchain-newsletter",
      title: "Julho 2026: aprenda a usar LangGraph com os destaques do mês",
    };
    // #633: afirma o bucket CORRETO (noticias), não apenas "≠ tutorial" — assim
    // uma regressão que rotear para outro bucket errado também é pega.
    assert.equal(
      categorize(art),
      "noticias",
      "slug 'newsletter' bloqueia o 'aprenda a' no título → RADAR/noticias (roundup > how-to)",
    );
  });
});
