/**
 * review-use-melhor.test.ts (#1798)
 *
 * Regressão: em 260604 dois posts da latent.space (newsletter/podcast) caíram
 * no bucket use_melhor. O guard deve flagá-los (warn) sem flagar tutoriais reais.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reviewUseMelhor,
  isNewsletterLike,
  hasTutorialSignal,
  isCorporateBlog,
  reviewUseMelhorComposition,
  isNewsletterRoundup,
  formatCriticalCompositionMessage,
} from "../scripts/review-use-melhor.ts";

describe("reviewUseMelhor — flag de não-tutorial (#1798)", () => {
  it("flaga os 2 itens latent.space de 260604 (newsletter mal-bucketada)", () => {
    const items = [
      { url: "https://www.latent.space/p/2025-ai-engineering", title: "The State of AI Engineering 2025" },
      { url: "https://www.latent.space/p/agents", title: "The Rise of Agents" },
    ];
    const { suspicious, total } = reviewUseMelhor(items);
    assert.equal(total, 2);
    assert.equal(suspicious.length, 2, "ambos latent.space devem ser flagados");
    assert.match(suspicious[0].reasons.join(" "), /newsletter\/agregador/);
  });

  it("NÃO flaga tutorial real de domínio de tutorial (cookbook.openai.com)", () => {
    const items = [
      { url: "https://cookbook.openai.com/examples/structured_outputs_intro", title: "Structured Outputs" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "cookbook.openai.com é tutorial domain → não flaga");
  });

  it("NÃO flaga artigo com sinal de tutorial no título (guia/how-to)", () => {
    const items = [
      { url: "https://blog.exemplo.com/post-123", title: "Guia prático: como usar NotebookLM no trabalho" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "título com 'guia'/'como usar' = tutorial");
  });

  it("flaga substack/beehiiv (newsletter) sem sinal de tutorial", () => {
    const items = [
      { url: "https://alguem.substack.com/p/analise", title: "Análise da semana em IA" },
      { url: "https://x.beehiiv.com/p/roundup", title: "Weekly roundup" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 2);
  });

  it("NÃO flaga newsletter COM sinal de tutorial (tutorial real de newsletter)", () => {
    // AND-logic: latent.space pode ter tutorial de verdade — não flagar nesse caso.
    const items = [
      { url: "https://www.latent.space/p/how-to-build-rag", title: "How to build a RAG pipeline" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0);
  });

  it("NÃO flaga tutorial de blog pessoal (não-newsletter) com título não-imperativo", () => {
    // Regressão do ruído da lógica OR (review do PR #1816): OR flagava todo
    // tutorial legítimo de domínio neutro sem verbo no título.
    const items = [
      { url: "https://eugeneyan.com/writing/llm-patterns", title: "LLM Patterns" },
      { url: "https://hamel.dev/blog/posts/evals", title: "Your AI Product Needs Evals" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "AND-logic: domínio neutro não é flagado");
  });

  it("ignora itens sem url; conta total corretamente", () => {
    const items = [{ title: "sem url" }, { url: "https://cookbook.openai.com/x", title: "Tutorial" }];
    const { suspicious, total } = reviewUseMelhor(items);
    assert.equal(total, 2);
    assert.equal(suspicious.length, 0);
  });

  // #2368: integração isOpinionOrStudy → reviewUseMelhor (warn-only)
  it("flaga estudo de pesquisa (research study, domínio neutro) como suspeito (#2368)", () => {
    // Domínio neutro (não newsletter, não corporate-blog) → cai no branch isOpinionOrStudy
    const items = [
      {
        url: "https://example.org/reports/llm-adoption",
        title: "Research Study: State of LLM Adoption in 2025",
      },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "research study deve ser flagado");
    assert.match(suspicious[0].reasons.join(" "), /ensaio de opinião ou estudo/);
  });

  it("flaga ensaio de opinião (hamel.dev my-take) como suspeito (#2368)", () => {
    const items = [
      { url: "https://hamel.dev/blog/posts/evals", title: "My Take on AI Evals: What Actually Works" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "ensaio de opinião deve ser flagado");
    assert.match(suspicious[0].reasons.join(" "), /#2368/);
  });

  it("NÃO flaga tutorial how-to mesmo com palavra de estudo no título (#2368)", () => {
    const items = [
      { url: "https://blog.exemplo.com/p", title: "How to Benchmark Your AI Models step by step" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "how-to vence sinal de estudo");
  });

  // #3027 CASO REAL 260707: handit.com.br "IA para Finanças: Como a IA
  // transforma FP&A e Controladoria" caiu em USE MELHOR. Causa raiz: o bare
  // "como" em TUTORIAL_SIGNAL_RE (hasTutorialSignal) casava QUALQUER título
  // contendo "como", inclusive análise de negócio — o que derrubava hasTutorial
  // para true e mascarava (via `&& !hasTutorial`) o guard isOpinionOrStudy que
  // corretamente identificaria o título como análise/tendência, não tutorial.
  it("#3027 CASO REAL: flaga 'Como a IA transforma FP&A e Controladoria' (handit.com.br) como suspeito", () => {
    const items = [
      {
        url: "https://handit.com.br/blog/ia-para-financas-como-a-ia-transforma-fpa-e-controladoria",
        title: "IA para Finanças: Como a IA transforma FP&A e Controladoria",
      },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "análise de negócio com 'como' solto deve ser flagada");
    assert.match(suspicious[0].reasons.join(" "), /ensaio de opinião ou estudo/);
  });

  it("#3027: 'como' sozinho (sem verbo acionável) NÃO conta mais como sinal de tutorial", () => {
    // hasTutorialSignal não deve mais retornar true só por causa de "como" —
    // precisa de "como usar/fazer/criar/..." (verbo acionável).
    assert.equal(
      hasTutorialSignal(
        "https://handit.com.br/blog/x",
        "Como a IA transforma FP&A e Controladoria",
      ),
      false,
      "'como' sem verbo acionável não deve mais ser sinal de tutorial",
    );
  });

  it("#3027: 'como usar/fazer/criar' (com verbo) CONTINUA sendo sinal de tutorial (sem regressão)", () => {
    assert.equal(hasTutorialSignal("https://x.com/y", "Como usar o ChatGPT no trabalho"), true);
    assert.equal(hasTutorialSignal("https://x.com/y", "Como criar um agente de IA"), true);
    assert.equal(hasTutorialSignal("https://x.com/y", "Como fazer um chatbot do zero"), true);
  });
});

describe("helpers puros (#1798)", () => {
  it("isNewsletterLike: latent.space, substack, aggregator", () => {
    assert.ok(isNewsletterLike("https://www.latent.space/p/x"));
    assert.ok(isNewsletterLike("https://y.substack.com/p/x"));
    assert.ok(!isNewsletterLike("https://cookbook.openai.com/x"));
  });

  it("hasTutorialSignal: título com verbo, slug com verbo, tutorial host", () => {
    assert.ok(hasTutorialSignal("https://x.com/y", "Como criar um agente"));
    assert.ok(hasTutorialSignal("https://x.com/how-to-build-rag", "RAG"));
    assert.ok(hasTutorialSignal("https://huggingface.co/learn/x", "NLP"));
    assert.ok(!hasTutorialSignal("https://x.com/news-item", "OpenAI lança modelo"));
  });

  it("hasTutorialSignal: formas no gerúndio (fix #2321 finding 2)", () => {
    // AWS tutorials com gerúndio no título não devem ser falso-flagados
    assert.ok(hasTutorialSignal("https://aws.amazon.com/blogs/ml/x", "Deploying Gemma 4 on SageMaker Studio"));
    assert.ok(hasTutorialSignal("https://aws.amazon.com/blogs/ml/x", "Building a RAG pipeline with Bedrock"));
    assert.ok(hasTutorialSignal("https://aws.amazon.com/blogs/ml/x", "Creating a serverless API with Lambda"));
  });
});

describe("isCorporateBlog + reviewUseMelhor — guarda corporativo (#2313 / #2321)", () => {
  it("isCorporateBlog: aws.amazon.com e blog.langchain.dev são corporativos", () => {
    assert.ok(isCorporateBlog("https://aws.amazon.com/blogs/machine-learning/x"), "aws.amazon.com deve ser corporativo");
    assert.ok(isCorporateBlog("https://blog.langchain.dev/how-langchain-made-x/"), "blog.langchain.dev deve ser corporativo (fix #2321 finding 1)");
    assert.ok(isCorporateBlog("https://cloud.google.com/blog/topics/ai/x"), "cloud.google.com deve ser corporativo");
    assert.ok(!isCorporateBlog("https://huggingface.co/blog/x"), "huggingface.co NÃO é corporativo neste sentido");
  });

  it("flaga aws.amazon.com SEM sinal de tutorial (true positive — evita case study no use_melhor)", () => {
    const items = [
      { url: "https://aws.amazon.com/blogs/machine-learning/introducing-bedrock-enterprise/", title: "Introducing Amazon Bedrock Enterprise" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "AWS case study/anúncio sem how-to deve ser flagado");
    assert.match(suspicious[0].reasons.join(" "), /corporativo/);
  });

  it("NÃO flaga aws.amazon.com COM sinal de tutorial (false positive evitado)", () => {
    const items = [
      { url: "https://aws.amazon.com/blogs/machine-learning/deploy-gemma-4-on-sagemaker/", title: "Deploying Gemma 4 on SageMaker Studio" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "AWS tutorial com gerúndio não deve ser flagado");
  });

  it("flaga blog.langchain.dev SEM sinal de tutorial (true positive)", () => {
    const items = [
      { url: "https://blog.langchain.dev/how-langchain-made-x-predictable/", title: "How LangChain Made X Predictable" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "LangChain case study sem how-to deve ser flagado");
  });

  it("NÃO flaga blog.langchain.dev COM sinal de tutorial", () => {
    const items = [
      { url: "https://blog.langchain.dev/how-to-build-agents/", title: "Como construir agentes com LangChain" },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 0, "LangChain com how-to = tutorial real, não deve ser flagado");
  });
});

// ---------------------------------------------------------------------------
// #2339 — reviewUseMelhorComposition: guard casual/iniciante
// ---------------------------------------------------------------------------

describe("reviewUseMelhorComposition (#2339) — guard de composição casual/iniciante", () => {
  it("lista vazia: sem warnings, tudo zerado", () => {
    const result = reviewUseMelhorComposition([]);
    assert.equal(result.casualCount, 0);
    assert.equal(result.beginnerCount, 0);
    assert.equal(result.advancedCount, 0);
    assert.equal(result.missingCasual, true, "0 itens = 0 casual = missingCasual");
    assert.equal(result.missingBeginner, true, "0 itens = 0 iniciante = missingBeginner");
    assert.deepEqual(result.breakdown, []);
  });

  it("somente itens dev-avancado: missingCasual=true AND missingBeginner=true (caso 260617)", () => {
    // Replica o caso real de 260617: 4 itens todos avançados
    const items = [
      {
        url: "https://blog.langchain.dev/building-end-to-end-sentiment-analysis/",
        title: "Building an End-to-End Sentiment Analysis Pipeline with Scikit-LLM",
      },
      {
        url: "https://blog.langchain.dev/designing-efficient-verifiers/",
        title: "Designing Efficient Verifiers for Legal Agents",
      },
      {
        url: "https://developers.googleblog.com/gemma4-visual-guide",
        title: "A Visual Guide to Gemma 4 12B",
      },
      {
        url: "https://cloud.google.com/blog/topics/tpu-stack",
        title: "Unlocking the Power of the TPU Stack",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.missingCasual, true, "caso 260617: zero casual itens");
    assert.equal(result.missingBeginner, true, "caso 260617: zero dev-iniciante itens");
    assert.equal(result.advancedCount, items.length);
  });

  it("missingCasual=false quando há item casual (howto_br:true no matched)", () => {
    const items = [
      {
        url: "https://canaltech.com.br/ia/como-usar-chatgpt-curriculo",
        title: "Como usar ChatGPT para criar currículo passo a passo",
        audience_affinity: { matched: ["howto_br:true", "howto_br_source:true"] },
      },
      {
        url: "https://blog.langchain.dev/rag-pipeline",
        title: "Building RAG Pipeline with LangGraph",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.casualCount, 1, "item com howto_br:true deve ser casual");
    assert.equal(result.missingCasual, false, "tem item casual → missingCasual=false");
    assert.equal(result.missingBeginner, true, "ainda sem dev-iniciante");
  });

  it("missingBeginner=false quando há item dev-iniciante (academy:true no matched)", () => {
    const items = [
      {
        url: "https://learn.deeplearning.ai/courses/prompt-engineering",
        title: "Prompt Engineering for Developers",
        audience_affinity: { matched: ["academy:true"] },
      },
      {
        url: "https://blog.langchain.dev/rag-pipeline",
        title: "Building RAG Pipeline with LangGraph",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.beginnerCount, 1, "academy:true = dev-iniciante");
    assert.equal(result.missingBeginner, false, "tem dev-iniciante → missingBeginner=false");
    assert.equal(result.missingCasual, true, "ainda sem casual");
  });

  it("2+2 perfeito: missingCasual=false AND missingBeginner=false", () => {
    const items = [
      {
        url: "https://canaltech.com.br/ia/chatgpt-produtividade",
        title: "ChatGPT para produtividade no trabalho passo a passo",
        audience_affinity: { matched: ["howto_br:true"] },
      },
      {
        url: "https://exame.com/ia/como-usar-ia-financas",
        title: "Como usar IA para finanças pessoais guia pratico",
        audience_affinity: { matched: ["howto_br_source:true"] },
      },
      {
        url: "https://learn.deeplearning.ai/courses/chatgpt-api",
        title: "ChatGPT API for Developers",
        audience_affinity: { matched: ["academy:true"] },
      },
      {
        url: "https://huggingface.co/learn/nlp-course",
        title: "Getting Started with NLP and Transformers",
        audience_affinity: { matched: ["academy:true"] },
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.casualCount, 2);
    assert.equal(result.beginnerCount, 2);
    assert.equal(result.missingCasual, false, "2 casuais → missingCasual=false");
    assert.equal(result.missingBeginner, false, "2 iniciantes → missingBeginner=false");
  });

  it("breakdown contém todos os itens com classe atribuída", () => {
    const items = [
      { url: "https://canaltech.com.br/ia/x", title: "ChatGPT passo a passo", audience_affinity: { matched: ["howto_br:true"] } },
      { url: "https://blog.langchain.dev/rag", title: "RAG Pipeline LangGraph" },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.breakdown.length, 2);
    const casual = result.breakdown.find((b) => b.url.includes("canaltech"));
    assert.ok(casual, "item canaltech deve estar no breakdown");
    assert.equal(casual?.class, "casual");
  });

  it("missingCasual=false quando item tem sinal casual no título (sem audience_affinity)", () => {
    // classifyAudienceClass usa o texto mesmo sem audience_affinity anotado
    const items = [
      {
        url: "https://example.com/chatgpt-para-trabalho",
        title: "ChatGPT para produtividade no trabalho passo a passo para iniciantes",
      },
    ];
    const result = reviewUseMelhorComposition(items);
    assert.equal(result.casualCount, 1, "sinal casual no título sem anotação = casual");
    assert.equal(result.missingCasual, false);
  });

  // #3027 item 3: severity endurece o sinal — distingue gap PARCIAL (falta só
  // uma cota) de gap TOTAL (faltam as duas, caso real 260707: 5/5 dev-avançado).
  describe("severity (#3027) — endurece missingCasual/missingBeginner", () => {
    it("CASO REAL 260707: 5/5 itens dev-avançado → severity='critical'", () => {
      const items = [
        { url: "https://blog.langchain.dev/x1", title: "Building an End-to-End Sentiment Analysis Pipeline with Scikit-LLM" },
        { url: "https://blog.langchain.dev/x2", title: "Designing Efficient Verifiers for Legal Agents" },
        { url: "https://developers.googleblog.com/x3", title: "A Visual Guide to Gemma 4 12B fine-tuning deployment pipeline" },
        { url: "https://cloud.google.com/blog/x4", title: "Unlocking the Power of the TPU Stack" },
        { url: "https://blog.langchain.dev/x5", title: "Multi-agent RAG pipeline architecture deep dive" },
      ];
      const result = reviewUseMelhorComposition(items);
      assert.equal(result.advancedCount, 5);
      assert.equal(result.missingCasual, true);
      assert.equal(result.missingBeginner, true);
      assert.equal(result.severity, "critical", "gap total (0 casual E 0 iniciante) deve ser 'critical'");
    });

    it("gap parcial (só falta 1 cota) → severity='partial'", () => {
      const items = [
        {
          url: "https://canaltech.com.br/ia/como-usar-chatgpt-curriculo",
          title: "Como usar ChatGPT para criar currículo passo a passo",
          audience_affinity: { matched: ["howto_br:true"] },
        },
        { url: "https://blog.langchain.dev/rag-pipeline", title: "Building RAG Pipeline with LangGraph" },
      ];
      const result = reviewUseMelhorComposition(items);
      assert.equal(result.missingCasual, false);
      assert.equal(result.missingBeginner, true);
      assert.equal(result.severity, "partial", "falta só dev-iniciante deve ser 'partial', não 'critical'");
    });

    it("2 casual + 2 dev-iniciante preenchidos → severity='ok'", () => {
      const items = [
        {
          url: "https://canaltech.com.br/ia/chatgpt-produtividade",
          title: "ChatGPT para produtividade no trabalho passo a passo",
          audience_affinity: { matched: ["howto_br:true"] },
        },
        {
          url: "https://exame.com/ia/como-usar-ia-financas",
          title: "Como usar IA para finanças pessoais guia pratico",
          audience_affinity: { matched: ["howto_br_source:true"] },
        },
        {
          url: "https://learn.deeplearning.ai/courses/chatgpt-api",
          title: "ChatGPT API for Developers",
          audience_affinity: { matched: ["academy:true"] },
        },
        {
          url: "https://huggingface.co/learn/nlp-course",
          title: "Getting Started with NLP and Transformers",
          audience_affinity: { matched: ["academy:true"] },
        },
      ];
      const result = reviewUseMelhorComposition(items);
      assert.equal(result.severity, "ok");
    });

    it("lista vazia → severity='critical' (0 casual E 0 iniciante, tecnicamente gap total)", () => {
      const result = reviewUseMelhorComposition([]);
      assert.equal(result.severity, "critical");
    });
  });

  // #3059: severity='critical' cobre DOIS cenários distintos (bucket vazio vs.
  // bucket enviesado) — a mensagem não pode alegar "100% dev-avançado" quando
  // não há NENHUM item. formatCriticalCompositionMessage separa o texto sem
  // mexer em severity (que continua 'critical' nos dois, por design do #3027).
  describe("formatCriticalCompositionMessage (#3059) — distingue bucket VAZIO de bucket ENVIESADO", () => {
    it("bucket genuinamente VAZIO (0 itens) → mensagem NÃO alega '100% dev-avançado'", () => {
      const composition = reviewUseMelhorComposition([]);
      assert.equal(composition.severity, "critical");
      const { header, detail } = formatCriticalCompositionMessage(composition);
      assert.doesNotMatch(header, /dev-avan[çc]ado/i, "não pode alegar dev-avançado quando não há item nenhum");
      assert.match(header, /VAZIO/i);
      assert.match(detail, /não encontrou NENHUM item para o bucket/i);
    });

    it("bucket ENVIESADO (5/5 dev-avançado, caso real 260707) → mensagem alega '100% dev-avançado'", () => {
      const items = [
        { url: "https://blog.langchain.dev/x1", title: "Building an End-to-End Sentiment Analysis Pipeline with Scikit-LLM" },
        { url: "https://blog.langchain.dev/x2", title: "Designing Efficient Verifiers for Legal Agents" },
        { url: "https://developers.googleblog.com/x3", title: "A Visual Guide to Gemma 4 12B fine-tuning deployment pipeline" },
        { url: "https://cloud.google.com/blog/x4", title: "Unlocking the Power of the TPU Stack" },
        { url: "https://blog.langchain.dev/x5", title: "Multi-agent RAG pipeline architecture deep dive" },
      ];
      const composition = reviewUseMelhorComposition(items);
      assert.equal(composition.severity, "critical");
      assert.equal(composition.advancedCount, 5);
      const { header, detail } = formatCriticalCompositionMessage(composition);
      assert.match(header, /100% dev-avan[çc]ado/i);
      assert.match(detail, /acess[íi]vel a leigos ou iniciantes/i);
    });

    it("as duas mensagens (vazio vs. enviesado) têm texto DIFERENTE", () => {
      const emptyMsg = formatCriticalCompositionMessage(reviewUseMelhorComposition([]));
      const biasedMsg = formatCriticalCompositionMessage(
        reviewUseMelhorComposition([
          { url: "https://blog.langchain.dev/x1", title: "Building an End-to-End Sentiment Analysis Pipeline" },
        ]),
      );
      assert.notEqual(emptyMsg.header, biasedMsg.header);
      assert.notEqual(emptyMsg.detail, biasedMsg.detail);
    });
  });
});

// ---------------------------------------------------------------------------
// #2663 — isNewsletterRoundup + reviewUseMelhor: guard de newsletter/roundup
// ---------------------------------------------------------------------------

describe("isNewsletterRoundup (#2663)", () => {
  it("detecta 'newsletter' no slug (caso real 260630 — LangChain)", () => {
    assert.ok(
      isNewsletterRoundup(
        "https://www.langchain.com/blog/june-2026-langchain-newsletter",
        "June 2026: LangChain Newsletter, Fleet On-Call Copilot, Deep Agents Rubrics, and More",
      ),
      "slug e título com 'newsletter' devem ser detectados",
    );
  });

  it("detecta 'newsletter' só no título (sem slug)", () => {
    assert.ok(
      isNewsletterRoundup(
        "https://www.langchain.com/blog/june-2026",
        "June 2026: LangChain Newsletter, and More",
      ),
      "título com 'newsletter' e 'and more' deve ser detectado",
    );
  });

  it("detecta 'roundup' no slug", () => {
    assert.ok(
      isNewsletterRoundup("https://blog.example.com/weekly-ai-roundup/", "AI Weekly Roundup"),
    );
  });

  it("detecta 'and more' no título (sinal de roundup)", () => {
    assert.ok(
      isNewsletterRoundup(
        "https://langchain.com/blog/june-2026",
        "June 2026: Deep Agents, RAG Updates, and More",
      ),
      "'and more' no título é sinal de roundup",
    );
  });

  it("#2666 follow-up: 'and more' MID-título (não-terminal) NÃO dispara (reduz FP)", () => {
    // "and more efficient architectures" é adjetivo, não enumeração de roundup.
    assert.ok(
      !isNewsletterRoundup(
        "https://example.com/posts/transformers-deep-dive",
        "Understanding Transformers and More Efficient Architectures",
      ),
      "'and more' no meio do título não é sinal de roundup",
    );
  });

  it("detecta 'this week in' no título", () => {
    assert.ok(
      isNewsletterRoundup("https://example.com/posts/123", "This Week in AI: Models, Tools, and More"),
    );
  });

  it("detecta 'weekly digest' no título", () => {
    assert.ok(
      isNewsletterRoundup("https://example.com/blog/2026-06-30", "Weekly Digest: Top AI Stories"),
    );
  });

  it("#2691 item 3 FIX: NÃO detecta tutorial genuíno sobre newsletters (how-to sobre construir newsletter)", () => {
    // "how-to-build-a-newsletter" — o artigo FALA SOBRE newsletter como tópico
    // E é how-to real. Antes do #2691 item 3, isNewsletterRoundup retornava
    // true (FP aceito — "newsletter" no slug/título disparava o guard mesmo
    // em how-to genuíno). Agora ROUNDUP_HOWTO_EXCEPTION_RE (lib/roundup-detect.ts)
    // reconhece "build/creat/montar/criar (a|an|sua|uma)? newsletter" como
    // how-to e desativa o guard — aplicado tanto ao slug quanto ao título.
    const result = isNewsletterRoundup(
      "https://example.com/how-to-build-a-newsletter-with-claude",
      "How to Build a Newsletter with Claude",
    );
    assert.ok(!result, "how-to genuíno sobre newsletter não deve mais ser flagado como roundup (#2691 item 3)");
  });

  it("#2691 item 3: exceção não enfraquece detecção de roundup real (título)", () => {
    assert.ok(
      isNewsletterRoundup("https://example.com/posts/123", "This Week in AI: Models, Tools, and More"),
    );
  });

  it("URL inválida retorna false sem crash", () => {
    assert.ok(!isNewsletterRoundup("not-a-url", "título qualquer de notícia comum"));
  });
});

describe("reviewUseMelhor — guard de newsletter/roundup (#2663)", () => {
  it("flaga LangChain newsletter como suspeito (caso real 260630)", () => {
    const items = [
      {
        url: "https://www.langchain.com/blog/june-2026-langchain-newsletter",
        title: "June 2026: LangChain Newsletter, Fleet On-Call Copilot, Deep Agents Rubrics, and More",
      },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(suspicious.length, 1, "newsletter LangChain deve ser flagado");
    assert.match(
      suspicious[0].reasons.join(" "),
      /newsletter\/roundup/,
      "motivo deve mencionar newsletter/roundup",
    );
  });

  it("flaga roundup com 'veja como' no título — roundup vence how-to (caso de conflito)", () => {
    // Caso de conflito: o título tem 'veja como' (sinal de how-to) E o slug tem 'newsletter'.
    // O guard de roundup DEVE vencer o sinal de how-to (precedência documentada: roundup > how-to).
    // Nota: hasTutorialSignal retorna true aqui, mas isNewsletterRoundup tem prioridade.
    const items = [
      {
        url: "https://www.langchain.com/blog/june-2026-langchain-newsletter",
        title: "Newsletter de Junho: veja como usar as novas ferramentas do LangChain, e mais",
      },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(
      suspicious.length,
      1,
      "roundup com 'veja como' deve ser flagado (roundup > how-to)",
    );
    assert.match(suspicious[0].reasons.join(" "), /newsletter\/roundup/);
  });

  it("NÃO flaga tutorial legítimo de domínio tutorial sem roundup (não-regressão)", () => {
    const items = [
      {
        url: "https://www.langchain.com/blog/how-to-build-agents-with-langgraph",
        title: "How to Build Agents with LangGraph",
      },
    ];
    const { suspicious } = reviewUseMelhor(items);
    assert.equal(
      suspicious.length,
      0,
      "tutorial legítimo sem sinal de roundup não deve ser flagado",
    );
  });

  it("NÃO flaga tutorial cookbook.openai.com mesmo que 'newsletter' apareça em contexto de título", () => {
    // "newsletter" como parte de domínio de curso não é roundup — tutorial domain vence.
    // Na prática, isNewsletterRoundup verificaria o slug, mas cookbook.openai.com é
    // TUTORIAL_HOSTS e hasTutorialSignal retornaria true mesmo sem sinal no título.
    // Aqui testamos que um tutorial host com URL limpa (sem 'newsletter' no slug) não é flagado.
    const items = [
      {
        url: "https://cookbook.openai.com/examples/newsletter-generation",
        title: "Generating Newsletters with OpenAI API",
      },
    ];
    // NOTA: esta URL TEM 'newsletter' no slug, então isNewsletterRoundup retorna true.
    // Isso é FP: o artigo é um tutorial SOBRE newsletter, não uma newsletter em si.
    // O guard é warn-only; o editor descarta. FP documentado como limite aceitável.
    const { suspicious } = reviewUseMelhor(items);
    // #633: afirma o comportamento ATUAL — a URL TEM 'newsletter' no slug, então É
    // flagada (warn-only, FP aceito). Pinar o número evita que uma regressão passe
    // silenciosamente; se a heurística passar a excluir esse caso, troque para 0.
    assert.equal(suspicious.length, 1, "FP aceito: 'newsletter' no slug flaga mesmo tutorial sobre newsletter");
  });
});
