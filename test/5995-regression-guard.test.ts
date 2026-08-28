/**
 * #5995 — Permanent anti-regress guard (items 4-5).
 *
 * Verifica que as regras do modo 1 (isNonProductOfficialPost) e modo 2
 * (isTutorialByKeyword / TUTORIAL_KEYWORDS_RE / techtudo /guia/) não regrediram
 * com fixtures REAIS do corpus citados na issue. Também fornece a moldura
 * O critério QUANTITATIVO do #5995 (71 → ≤35 movimentos) **não é verificado
 * aqui, e não pode ser**: ele se mede sobre `data/editions/`, que é gitignored
 * e não existe no CI. Um teste que finge medi-lo daria falsa sensação de
 * fechamento — foi o que a versão anterior deste arquivo fazia (o caso
 * "quantitativo" só checava `typeof === "function"` enquanto a docstring
 * afirmava falhar acima de 35; uma regressão fabricada de 999999 movimentos
 * passava verde). A medição é OPERACIONAL, rodada à mão:
 *
 *     npx tsx scripts/analyze-bucket-overrides.ts --editions-dir data/editions
 *
 * Última medição (24/08/2026, 93 edições): **73 movimentos** — acima do alvo.
 * Esperado: o detector dos itens 1-2 (#5995) mergeou ~21h antes dessa medição
 * e o do item 3 (#6028) ~11h30 antes, então quase nenhuma edição do corpus foi
 * produzida com ele. O critério só pode ser reavaliado depois de N edições novas. Enquanto
 * isso, o #5995 continua ABERTO — este arquivo entrega o item 4 (guard
 * qualitativo por fixture), não o item 5.
 *
 * Item 5 (25/08/2026): o critério de fechamento foi REDEFINIDO de contagem
 * cumulativa ("TOTAL ≤35" — inalcançável, o corpus só cresce) para TAXA EM
 * JANELA (`computeWindowedRate`, `--window N`, default 20). A janela é
 * verificável aqui sobre fixtures sintéticas; a medição operacional real
 * continua sendo:
 *
 *     npx tsx scripts/analyze-bucket-overrides.ts --editions-dir data/editions [--window 20]
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  categorize,
  isNonProductOfficialPost,
  isHowCollectiveReportTitle,
  categoryToBucket,
} from "../scripts/lib/launch-heuristics.ts";

describe("#5995 anti-regress guard — fixtures do corpus real", () => {
  // Modo 1 — amostra dos casos reais de lancamento→radar (domínio oficial +
  // não-produto). A contagem total deriva com o corpus: 34 quando a issue foi
  // escrita, 35 na medição de 24/08 — por isso não é asserção, é referência.
  it("cada fixture real do modo 1 bate em noticias, NÃO em lancamento", () => {
    const fixtures = [
      { title: "Expanding Daybreak as the Cyber Defense Window Narrows", url: "https://openai.com/index/expanding-daybreak-as-the-cyber-defense-window-narrows/" },
      { title: "NVIDIA AI Factory Compute Is Becoming an Investable Asset Class", url: "https://blogs.nvidia.com/blog/nvidia-ai-factory-compute-investable-asset-class/" },
      { title: "State of Open Models: Summer 2026 Observations", url: "https://huggingface.co/blog/state-of-open-models/" },
      { title: "Omni experts share what excites them most about the model", url: "https://blog.google/technology/google-deepmind/omni-experts-share/" },
      { title: "Offering Zero Data Retention for frontier models", url: "https://openai.com/index/zero-data-retention/" },
      { title: "Start the semester with one year of Gemini, on us", url: "https://blog.google/products/gemini/start-the-semester-gemini-on-us/" },
      { title: "Inside the Gemmaverse: Celebrating one billion Gemma downloads", url: "https://blog.google/technology/developers/inside-the-gemmaverse-one-billion-downloads/" },
    ];
    for (const f of fixtures) {
      assert.equal(isNonProductOfficialPost({ url: f.url, title: f.title } as any), true, `modo1: ${f.title}`);
      assert.equal(categorize({ url: f.url, title: f.title } as any), "noticias", `modo1-categorize: ${f.title}`);
    }
  });

  // Modo 1 — anti-falso-positivo: anúncio explícito NUNCA é demovido
  it("guard anti-falso-positivo: verbo de anúncio explícito preserva lancamento", () => {
    const keep = [
      { title: "Introducing Gemma 4: celebrating 100 million downloads", url: "https://openai.com/index/introducing-gemma-4/" },
      { title: "Announcing the State of AI Report launch event", url: "https://openai.com/index/state-of-ai-launch/" },
      { title: "Launching Gemini for Education — start the semester right", url: "https://blog.google/technology/developers/launching-gemini-education/" },
      { title: "Now available: Claude for Excel", url: "https://openai.com/index/claude-for-excel/" },
      { title: "Unveiling Omni, our most capable model", url: "https://openai.com/index/unveiling-omni/" },
    ];
    for (const f of keep) {
      assert.equal(isNonProductOfficialPost({ url: f.url, title: f.title } as any), false, `anti-fp: ${f.title}`);
      // Não afirma o bucket final — outras regras (update/news) podem classificar. O guard é apenas: NÃO é demovido por NON_PRODUCT_OFFICIAL_PATTERNS.
    }
  });

  // Modo 2 — amostra dos casos de radar→use_melhor (21 na issue, 22 em 24/08) (pt-BR how-to / listicle tutorial)
  it("modo 2: fixtures pt-BR de tutorial são detectados e viram USE MELHOR", () => {
    const fixtures = [
      { title: "Como treinar oratória com ChatGPT: 15 prompts para falar melhor", url: "https://techtudo.com.br/guia/como-treinar-oratoria" },
      { title: "9 aplicações práticas do ChatGPT Work", url: "https://canaltech.com.br/ia/9-aplicacoes-praticas-do-chatgpt-work/" },
      { title: "6 formas de assinar o Claude mais barato e pagar menos pelo Pro", url: "https://canaltech.com.br/ia/6-formas-de-assinar-o-claude-mais-barato/" },
      { title: "Como transformar uma planilha bagunçada em gráficos com ChatGPT", url: "https://techtudo.com.br/guia/como-transformar-planilha-em-graficos/" },
      { title: "11 prompts para foto profissional no ChatGPT e outras IAs", url: "https://remessaonline.com.br/ia/11-prompts-foto-profissional/" },
    ];
    for (const f of fixtures) {
      assert.equal(categorize({ url: f.url, title: f.title, summary: "" } as any), "tutorial", `modo2-categorize: ${f.title}`);
    }
  });

  // Modo 2 — guard anti-falso-positivo: informativo NÃO vira tutorial
  it("guard anti-falso-positivo pt-BR: informativo sem verbo acionável NÃO é rebaixado", () => {
    const negative = "Como a IA está mudando a educação no Brasil";
    assert.notEqual(categorize({ url: "https://blog.google/technology/ai/como-ia-esta-mudando-educacao/", title: negative, summary: "" } as any), "tutorial", `anti-fp-categorize: NÃO é tutorial`);
  });

  // Modo 2 — guard do path /guia/ (techtudo): só dispara dentro do path específico
  it("guard de path: techtudo /guia/ dispara; techtudo sem /guia/ não", () => {
    const guia = { url: "https://techtudo.com.br/guia/como-usar-ia/", title: "Como usar a IA para estudar" };
    const comum = { url: "https://techtudo.com.br/noticias/como-funciona/", title: "Como funciona a nova versão do ChatGPT" };
    // /guia/ → tutorial (por TUTORIAL_PATTERNS ou keyword)
    assert.equal(categorize({ url: guia.url, title: guia.title, summary: "" } as any), "tutorial", `/guia/ dispara`);
    assert.equal(categorize({ url: comum.url, title: comum.title, summary: "" } as any), "noticias", `/guia/ não dispara`);
  });

  // O framework de MEDIÇÃO (o script que o editor roda à mão contra
  // `data/editions/`) precisa continuar funcionando — mas isto NÃO é o
  // critério quantitativo do #5995, que não é verificável no CI. Ver a
  // docstring no topo. Aqui exercitamos o cálculo de verdade sobre uma entrada
  // sintética: `typeof === "function"` sozinho passaria mesmo com o miolo
  // trocado por uma constante inventada.
  it("framework de medição: diffBucketOverrides + summarize computam sobre entrada sintética", async () => {
    const { diffBucketOverrides, summarize } = await import("../scripts/analyze-bucket-overrides.ts");

    const categorized = { lancamento: [{ url: "https://exemplo.test/a" }], radar: [] };
    const approved = { lancamento: [], radar: [{ url: "https://exemplo.test/a" }] };

    const moves = diffBucketOverrides(categorized as never, approved as never);
    assert.equal(moves.length, 1, "1 URL trocou de bucket → 1 movimento");
    assert.equal(moves[0].direction, "lancamento->radar");

    const resumo = summarize([{ edition: "260824", moves }] as never, 1);
    assert.equal(resumo.totalMoves, 1, "summarize conta o movimento — não devolve constante");
    assert.equal(resumo.editionsWithMoves, 1);
    const direcao = resumo.directions.find((d) => d.direction === "lancamento->radar");
    assert.ok(direcao && direcao.count === 1, "a direção do movimento aparece no resumo");
  });
});

describe("#5995 item 5 — taxa em janela (critério de fechamento)", () => {
  // Fixture sintética: 30 edições. As 10 primeiras (histórico antigo) têm 2
  // movimentos cada; as 20 últimas têm exatamente 1 movimento a cada 4 edições.
  function fixture(n: number): Array<{ edition: string; moves: Array<{ direction: string }> }> {
    return Array.from({ length: n }, (_, i) => ({
      edition: String(260001 + i),
      moves: i < 10 ? [{ direction: "radar->use_melhor" }, { direction: "lancamento->radar" }] : i % 4 === 0 ? [{ direction: "radar->use_melhor" }] : [],
    })) as never;
  }

  it("computeWindowedRate mede só a janela, nunca o acumulado histórico", async () => {
    const { computeWindowedRate } = await import("../scripts/analyze-bucket-overrides.ts");
    const rate = computeWindowedRate(fixture(30), 20);

    assert.equal(rate.requested, 20);
    assert.equal(rate.editionsInWindow, 20);
    assert.equal(rate.clamped, false);
    // Janela: edições 10..29 → movimentos nas edições 12,16,20,24,28 = 5.
    assert.equal(rate.totalMoves, 5, "só os movimentos DENTRO da janela contam (o histórico de 20 é ignorado)");
    assert.equal(rate.editionsWithMoves, 5);
    assert.equal(rate.movesPerEdition, 0.25);
    assert.ok(Math.abs(rate.pctEditionsWithMoves - 25) < 1e-9);
  });

  it("janela maior que o corpus é ajustada (clamped) sem inventar edições", async () => {
    const { computeWindowedRate } = await import("../scripts/analyze-bucket-overrides.ts");
    const rate = computeWindowedRate(fixture(6), 20);

    assert.equal(rate.editionsInWindow, 6);
    assert.equal(rate.clamped, true);
    assert.equal(rate.totalMoves, 12); // todas as 6 edições do fixture têm 2
  });

  it("corpus vazio → taxa zerada, sem NaN/divisão por zero", async () => {
    const { computeWindowedRate } = await import("../scripts/analyze-bucket-overrides.ts");
    const rate = computeWindowedRate([], 20);

    assert.equal(rate.editionsInWindow, 0);
    assert.equal(rate.totalMoves, 0);
    assert.equal(rate.movesPerEdition, 0);
    assert.equal(rate.pctEditionsWithMoves, 0);
  });

  it("summarize expõe a taxa em janela no summary (--window default 20)", async () => {
    const { summarize, DEFAULT_WINDOW } = await import("../scripts/analyze-bucket-overrides.ts");

    assert.equal(DEFAULT_WINDOW, 20);

    const data = fixture(30);
    const resumo = summarize(data as never, 0);
    assert.ok(resumo.windowed, "summary carrega a taxa em janela quando há edições");
    assert.equal(resumo.windowed!.editionsInWindow, DEFAULT_WINDOW);
    assert.equal(resumo.windowed!.totalMoves, 5);
    assert.equal(resumo.windowed!.movesPerEdition.toFixed(2), "0.25");

    const custom = summarize(data as never, 0, 5);
    assert.equal(custom.windowed!.editionsInWindow, 5);
    assert.equal(custom.windowed!.totalMoves, 1, "janela de 5 pega só a edição 28 (1 movimento)");

    const vazio = summarize([] as never, 0);
    assert.equal(vazio.windowed, null, "sem corpus, windowed é null");
  });

  it("a taxa em janela NÃO cresce com o corpus — propriedade que mata o critério cumulativo antigo", async () => {
    const { computeWindowedRate } = await import("../scripts/analyze-bucket-overrides.ts");
    // Corpus A: 30 edições (as 10 primeiras com 2 movimentos cada).
    // Corpus B: as MESMAS 30 edições precedidas de 50 edições antigas vazias.
    const corpusA = fixture(30);
    const corpusB = [
      ...Array.from({ length: 50 }, (_, i) => ({ edition: `1${String(260000 + i)}`, moves: [] })),
      ...corpusA,
    ];
    const antes = computeWindowedRate(corpusA as never, 20);
    const depois = computeWindowedRate(corpusB as never, 20);

    assert.equal(antes.totalMoves, depois.totalMoves, "mesma janela final → mesma contagem, independente do histórico anterior");
    assert.equal(depois.movesPerEdition, antes.movesPerEdition);
    // Enquanto isso, o TOTAL cumulativo quase dobra — é exatamente ele que nunca fecharia.
    assert.ok(depois.totalMoves < 40, "janela permanece pequena mesmo com corpus grande");
  });
});

// -----------------------------------------------------------------------
// #5995 (rodada 260828) — resíduo real medido ao vivo contra o corpus de
// 96 edições em `data/editions/` (`--live` recompute: reaplica `categorize()`
// ATUAL sobre os artigos de `01-categorized.json` e diffa contra o bucket que
// o editor de fato aprovou em `01-approved.json` — diferente da medição
// oficial de `analyze-bucket-overrides.ts`, que compara contra o bucket
// GRAVADO no momento em que a edição rodou, e por isso não reflete regras
// mergeadas depois). Achado ao vivo: 38 de 77 exemplos reais das 5 direções
// (extraídos dos comentários da issue) ainda divergiam do veredito do editor
// com o código de antes desta rodada; 6 classes de padrão generalizável
// (não singleton) cobrem 14 desses casos sem piorar nenhuma direção — medido
// como: baseline 140 divergências / 2306 pares comparáveis (93.93% de
// acordo) → 130 divergências (94.36%) após as regras abaixo, ZERO URLs que
// concordavam antes passaram a divergir (checado por diff de URL antes/
// depois sobre o corpus inteiro, não só as fixtures aqui).
//
// Duas classes tentadas e REVERTIDAS por regredir casos reais (guard
// anti-overfit em ação, não só descrito): "guia (para|de)" no
// TUTORIAL_KEYWORDS_RE parecia cobrir "Lovable na prática: o guia para
// profissionais..." mas capturava falso-positivo em "Guia de conformidade"
// (artigo sobre PL 2338, não tutorial de IA) e em "guia para empresas" de um
// artigo de SEO/visibilidade (não tutorial de uso de IA) — os dois últimos
// testes negativos abaixo travam essa reversão.
describe("#5995 (260828) — resíduo real: lancamento→radar (título não-produto, classes novas)", () => {
  it("cada fixture real bate em noticias via isNonProductOfficialPost", () => {
    const fixtures = [
      // "Ask an AI expert: X" — série Q&A explicativa
      { title: "Ask an AI expert: What exactly is the full stack?", url: "https://blog.google/innovation-and-ai/technology/ai/full-stack-ai-explainer/" },
      // "the next era of X" — framing de visão/relatório
      { title: "Advancing the next era of national science", url: "https://openai.com/index/advancing-the-next-era-of-national-science" },
      // "How {coletivo} ..." — relatório/análise, distinto de "how to" tutorial
    ];
    for (const f of fixtures) {
      assert.equal(isNonProductOfficialPost({ url: f.url, title: f.title } as any), true, `nao-produto: ${f.title}`);
      assert.equal(categorize({ url: f.url, title: f.title } as any), "noticias", `categorize: ${f.title}`);
    }
  });

  it("'How {coletivo} ...' cai em noticias via isHowCollectiveReportTitle (função dedicada, roda pós type_hint)", () => {
    const fixtures = [
      { title: "How Nations Are Deploying AI for Strategic Priorities", url: "https://blogs.nvidia.com/blog/nations-deploy-ai-strategic-priorities/" },
      { title: "From assistance to execution: How enterprises put AI to work", url: "https://openai.com/index/how-enterprises-put-ai-to-work" },
      { title: "From asking to doing: How the world is putting ChatGPT to work", url: "https://openai.com/index/how-the-world-is-putting-chatgpt-to-work" },
    ];
    for (const f of fixtures) {
      assert.equal(isHowCollectiveReportTitle({ url: f.url, title: f.title } as any), true, `how-collective: ${f.title}`);
      assert.equal(categorize({ url: f.url, title: f.title } as any), "noticias", `categorize: ${f.title}`);
    }
  });

  // #5995 (achado do review independente do PR #6556): "How {coletivo}"
  // roda DEPOIS do short-circuit type_hint==="lancamento" — diferente das
  // outras classes de isNonProductOfficialPost, que rodam ANTES por serem
  // de alta especificidade lexical. Sem essa precedência, um lançamento
  // CONFIRMADO pelo agent (type_hint="lancamento") seria demovido
  // indevidamente por uma manchete genérica "How Enterprises Are Already
  // Using the New Gemini 4" — trava a precedência correta.
  it("guard de precedência: type_hint=lancamento vence 'How {coletivo}...' mesmo sem verbo de anúncio", () => {
    const f = {
      title: "How Enterprises Are Already Using the New GPT-6",
      url: "https://openai.com/index/how-enterprises-use-gpt-6",
      type_hint: "lancamento",
    };
    // O padrão lexical em si dispara (é genérico o bastante)...
    assert.equal(isHowCollectiveReportTitle(f as any), true, "o padrão lexical dispara nesta manchete");
    // ...mas categorize() preserva o lançamento confirmado pelo agent.
    assert.equal(categorize(f as any), "lancamento", "type_hint=lancamento vence o padrão genérico 'how collective'");
  });

  it("'X: Major Updates' cai em noticias via isUpdate, não lancamento", () => {
    const f = { title: "🤗 Kernels: Major Updates", url: "https://huggingface.co/blog/revamped-kernels" };
    assert.equal(categorize(f as any), "noticias", f.title);
  });

  it("'Now Run(s) on' (parceria de infra cross-empresa) cai em noticias via isBusinessDeal", () => {
    const f = {
      title: "Claude Meets Blackwell Ultra: Anthropic's Models Now Run on NVIDIA GB300 in Azure",
      url: "https://blogs.nvidia.com/blog/anthropic-nvidia-gb300-blackwell-ultra-microsoft-azure/",
    };
    assert.equal(categorize(f as any), "noticias", f.title);
  });

  it("'Reaches N% on {benchmark}' cai em pesquisa via isLikelyResearchResult", () => {
    const f = {
      title: "NVIDIA AVO Reaches 100% on ARC-AGI-3, Demonstrating a Frontier-Level General-Purpose Architecture",
      url: "https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/",
    };
    assert.equal(categorize(f as any), "pesquisa", f.title);
  });

  it("'Working with {entidade} on {tema}' cai em noticias via isCustomerStory", () => {
    const f = {
      title: "Working with the American Psychological Association on youth mental health and AI",
      url: "https://openai.com/index/openai-and-apa-partner-to-advance-responsible-ai",
    };
    assert.equal(categorize(f as any), "noticias", f.title);
  });

  // #5995 (achado do review independente do PR #6556, confidence média/P3):
  // "Now Run(s) on"/"Working with...on"/"Major Updates" rodam DEPOIS do
  // short-circuit type_hint==="lancamento" em categorize() (posição correta
  // — mesma de isBusinessDeal/isCustomerStory/isUpdate) — mas isso só
  // protege lançamento confirmado pelo agent se o teste de fato exercitar
  // esse caminho. Sem type_hint, os testes acima já provam que os 3 padrões
  // disparam; estes travam que type_hint=lancamento continua vencendo.
  it("guard de precedência: type_hint=lancamento vence 'Now Run(s) on'/'Working with...on'/'Major Updates'", () => {
    const fixtures = [
      { title: "Anthropic's Models Now Run on NVIDIA GB300", url: "https://blogs.nvidia.com/blog/anthropic-nvidia-gb300/" },
      { title: "Working with Figma on a New Design Plugin for Claude", url: "https://www.anthropic.com/news/figma-design-plugin" },
      { title: "Llama 5: Major Updates to Vision and Reasoning", url: "https://huggingface.co/blog/llama-5-major-updates" },
    ];
    for (const f of fixtures) {
      assert.equal(categorize({ ...f, type_hint: "lancamento" } as any), "lancamento", `type_hint=lancamento vence: ${f.title}`);
    }
  });
});

describe("#5995 (260828) — resíduo real: radar→use_melhor (tutorial pt-BR, classes novas)", () => {
  it("'N formas/maneiras/jeitos ADJETIVO de <verbo>' — adjetivo entre o número e 'de'", () => {
    const f = {
      title: "7 formas inteligentes de usar IA na liderança sem ser especialista em tecnologia",
      url: "https://www.administradores.com.br/noticias/7-formas-inteligentes-de-usar-ia-na-lideranca-sem-ser-especialista-em-tecnologia",
    };
    assert.equal(categoryToBucket(categorize({ ...f, summary: "" } as any)), "use_melhor", f.title);
  });

  // #5995 (achado do review independente do PR #6556, confidence média/P3):
  // o alargamento de "0 palavras" pra "até 2 palavras" entre o substantivo e
  // "de" só tinha 1 fixture positiva, sem guard negativo travando o LIMITE do
  // alargamento. Título jornalístico com 4+ palavras entre "formas" e "de"
  // (fora do {0,2}) NÃO deve virar tutorial — trava o limite superior.
  it("guard de limite: 4+ palavras entre 'formas/maneiras' e 'de' NÃO dispara o alargamento", () => {
    const f = {
      title: "Pesquisadores descobrem 5 novas formas completamente diferentes e preocupantes de IA enganar usuários",
      url: "https://g1.globo.com/tecnologia/noticia/pesquisadores-formas-ia-enganar.ghtml",
    };
    assert.notEqual(categoryToBucket(categorize({ ...f, summary: "" } as any)), "use_melhor", f.title);
  });

  it("'Try these N X to Y' — listicle acionável em inglês sem 'N' logo após o substantivo", () => {
    const f = {
      title: "Try these 3 Google AI tools to help find your next job.",
      url: "https://blog.google/products-and-platforms/products/gemini/find-job-with-google-ai-tools",
    };
    assert.equal(categoryToBucket(categorize({ ...f, summary: "" } as any)), "use_melhor", f.title);
  });

  it("'veja como' com sufixo de veículo ('...; veja como - Canaltech') ainda dispara", () => {
    const f = {
      title: "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como - Canaltech",
      url: "https://canaltech.com.br/inteligencia-artificial/chatgpt-consegue-fazer-check-up-do-seu-pc-sem-abrir-nenhum-arquivo-veja-como",
    };
    assert.equal(categoryToBucket(categorize({ ...f, summary: "" } as any)), "use_melhor", f.title);
  });

  it("'Como explorar' — verbo 'explorar' adicionado à lista de ações do tutorial pt-BR", () => {
    const f = {
      title: "Como explorar o máximo potencial do Gemini no trabalho, nos estudos e no dia a dia",
      url: "https://exame.com/inteligencia-artificial/como-explorar-o-maximo-potencial-do-gemini-no-trabalho-nos-estudos-e-no-dia-a-dia",
    };
    assert.equal(categoryToBucket(categorize({ ...f, summary: "" } as any)), "use_melhor", f.title);
  });
});

describe("#5995 (260828) — guard anti-overfit: regra tentada e REVERTIDA por regredir casos reais", () => {
  // "guia (para|de)" no TUTORIAL_KEYWORDS_RE foi tentado pra cobrir "Lovable
  // na prática: o guia para profissionais criarem apps com IA" (1 caso), mas
  // capturava 2 falso-positivos reais medidos no corpus — revertido. Estes
  // dois testes travam a reversão: se "guia (para|de)" reaparecer no
  // TUTORIAL_KEYWORDS_RE, os dois passam a falhar.
  it("'Guia de conformidade' num artigo de regulação NÃO vira tutorial", () => {
    const f = {
      title: "Brazil AI Act 2026: What Foreign Brands Should Say Before PL 2338 Passes",
      url: "https://sherlockcomms.com/brazil-ai-act-2026-communications-compliance",
      summary: "Guia de conformidade de comunicação para marcas estrangeiras em face da lei de IA brasileira pendente (PL 2338/2023).",
    };
    assert.notEqual(categoryToBucket(categorize(f as any)), "use_melhor", f.title);
  });

  it("'o guia para empresas' num artigo de SEO/visibilidade NÃO vira tutorial", () => {
    const f = {
      title: "Como aparecer no ChatGPT: o guia para empresas",
      url: "https://www.cloudmarket.com.br/marketing-digital/blog/como-aparecer-no-chatgpt/",
      summary: "Aprenda como aparecer no ChatGPT: robôs para liberar, autoridade de tópico, fontes que a IA consulta e como medir se sua empresa já é citada nas respostas.",
    };
    assert.notEqual(categoryToBucket(categorize(f as any)), "use_melhor", f.title);
  });
});
