/**
 * #5995 (rodada 05/10/2026) — guard por fixture dos padrões novos do resíduo.
 *
 * Cada caso positivo é um item REAL que o editor moveu de seção no gate do
 * Stage 1 (`01-categorized.json` × `01-approved.json`) e que o categorizador
 * de master (1654319b4) ainda classificava errado quando reaplicado. Título,
 * URL, summary e `type_hint` vêm do corpus. Os negativos fixam o LIMITE de
 * escopo de cada regra (o que ela deliberadamente não pega) — não são
 * veredito editorial sobre esses itens.
 *
 * Medição de corpus completo (4.121 pares categorizador × editor, reaplicando
 * `categorizeWithRule()`): 3800 → 3810 de acordo, 11 melhorias, 1 regressão
 * justificada (ver PR).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorize, categorizeWithRule, categoryToBucket } from "../scripts/lib/launch-heuristics.ts";

const bucketOf = (a: Parameters<typeof categorize>[0]) => categoryToBucket(categorize(a));

describe("#5995 261005 — slug com 'como <verbo>' vira USE MELHOR", () => {
  it("CASO REAL 261005: 'Claude Code ganha suporte a mods' (how-to só no slug, type_hint=noticia) → use_melhor", () => {
    const a = {
      url: "https://canaltech.com.br/inteligencia-artificial/claude-code-ganha-suporte-a-mods-veja-como-personalizar-terminal-e-mais/",
      title: "Claude Code ganha suporte a mods",
      summary:
        "A Anthropic anunciou os mods do Claude Code, um novo recurso que permite personalizar o funcionamento e a aparência da ferramenta de inteligência artificial.",
      type_hint: "noticia",
    };
    assert.equal(bucketOf(a), "use_melhor");
    assert.equal(categorizeWithRule(a).rule, "tutorial-keyword");
  });

  it("CASO REAL 260825: 'O que é o Canvas do ChatGPT e como ele funciona?' (slug '…-e-como-usar') → use_melhor", () => {
    assert.equal(
      bucketOf({
        url: "https://canaltech.com.br/inteligencia-artificial/o-que-e-chatgpt-canvas-e-como-usar/",
        title: "O que é o Canvas do ChatGPT e como ele funciona?",
        summary:
          "O Canvas do ChatGPT é um espaço de trabalho criado para projetos de escrita e programação que precisam de mais do que uma sequência de perguntas e respostas.",
      }),
      "use_melhor",
    );
  });

  it("limite: slug 'veja-como-sera' (verbo fora da lista fechada) continua RADAR", () => {
    assert.equal(
      bucketOf({
        url: "https://canaltech.com.br/inteligencia-artificial/samsung-notes-passa-a-avisar-quando-texto-e-criado-por-ia-veja-como-sera/",
        title: "Samsung Notes passa a avisar quando texto é criado por IA; veja como será",
        summary:
          "A Samsung disponibilizou uma atualização para o aplicativo Samsung Notes que adiciona um aviso quando as ferramentas do Galaxy AI são usadas para gerar ou editar conteúdo.",
      }),
      "radar",
    );
  });
});

describe("#5995 261005 — guia de uso pelo título (USAGE_GUIDE_TITLE_RE)", () => {
  it("CASO REAL 260909: contagem por extenso 'Três prompts que…' (type_hint=noticia) → use_melhor", () => {
    assert.equal(
      bucketOf({
        url: "https://exame.com/carreira/tres-prompts-que-ajudam-em-processos-seletivos-principalmente-se-for-seu-primeiro-emprego/",
        title: "Três prompts que ajudam em processos seletivos — principalmente se for seu primeiro emprego",
        summary:
          "O primeiro passo recomendado é utilizar a própria IA generativa — como ChatGPT ou Gemini — para mapear as formas como a tecnologia já está sendo usada em funções semelhantes àquela que você busca.",
        type_hint: "noticia",
      }),
      "use_melhor",
    );
  });

  it("CASO REAL 261005: 'Prompt para foto de perfil do Instagram: 10 ideias para usar no ChatGPT' → use_melhor", () => {
    assert.equal(
      bucketOf({
        url: "https://www.techtudo.com.br/listas/2026/10/prompt-para-foto-de-perfil-do-instagram-10-ideias-para-usar-no-chatgpt-edsoftwares.ghtml",
        title: "Prompt para foto de perfil do Instagram: 10 ideias para usar no ChatGPT",
        summary:
          "A inteligência artificial consegue gerar e transformar imagens a partir de comandos que descrevem detalhes como iluminação, cenário, roupa, enquadramento e estilo da foto.",
        type_hint: "noticia",
      }),
      "use_melhor",
    );
  });

  it("CASO REAL 260924: 'Getting the most out of Opus 5.5…' → use_melhor", () => {
    assert.equal(
      bucketOf({
        url: "https://claude.dev/blog/getting-the-most-out-of-opus-5-5/",
        title: "Getting the most out of Opus 5.5 in Claude and Claude Code / claude.dev",
        summary: "How to prompt Opus 5.5, steer a long run, and check your results in Claude apps and Claude Code.",
      }),
      "use_melhor",
    );
  });

  it("CASO REAL 260831: '7 ways to kick-start back to school using Gemini in Workspace' (blog.google) → use_melhor, nunca LANÇAMENTO", () => {
    assert.equal(
      bucketOf({
        url: "https://blog.google/products-and-platforms/products/workspace/gemini-google-workspace-back-to-school/",
        title: "7 ways to kick-start back to school using Gemini in Workspace",
        summary:
          "Get a jump on this semester by using Gemini in Google Workspace to organize your notes, track deadlines, prep for projects, and more.",
      }),
      "use_melhor",
    );
  });

  it("limite: 'N ways {sujeito} {verbo}' (sem 'to') não dispara a regra", () => {
    const r = categorizeWithRule({
      url: "https://blog.google/products-and-platforms/products/gemini/ai-navigate-bureaucracy/",
      title: "4 ways Gemini makes administrative chores quick and easy",
      summary:
        "People are turning to Gemini for help with complex government tasks, like filing taxes, preparing fines, and accessing social services.",
    });
    assert.notEqual(r.rule, "tutorial-keyword");
  });

  it("limite: só o TÍTULO conta — contagem de dicas no summary não vira tutorial", () => {
    assert.equal(
      bucketOf({
        url: "https://example.com/noticia/empresa-anuncia-resultados",
        title: "Empresa de IA anuncia resultados do trimestre",
        summary: "No evento, a diretora deu cinco dicas para usar a plataforma e citou três prompts que a equipe adotou.",
      }),
      "radar",
    );
  });

  it("limite: 'N dicas para <verbo que não é usar>' fica fora da regra", () => {
    const r = categorizeWithRule({
      url: "https://exame.com/tecnologia/examelab/busca-com-ia-5-dicas-para-pesquisar-melhor-na-nova-era-do-google/",
      title: "Busca com IA: 5 dicas para pesquisar melhor na nova era do Google",
    });
    assert.notEqual(r.rule, "tutorial-keyword");
  });
});

describe("#5995 261005 — 'escondido' singular não é listicle de descoberta", () => {
  it("CASO REAL 260915: 'Comando escondido em laudo para influenciar IA…' (g1, type_hint=noticia) → radar", () => {
    assert.equal(
      bucketOf({
        url: "https://g1.globo.com/rn/rio-grande-do-norte/noticia/2026/09/12/comando-escondido-em-laudo-pericial-para-influenciar-ia-e-descoberto-em-processo-no-tjrn.ghtml",
        title: "Comando escondido em laudo para influenciar IA é encontrado no TJRN",
        summary:
          "O especialista Victor Ferreira explicou que a inteligência artificial consegue ler o comando invisível ao olho humano.",
        type_hint: "noticia",
      }),
      "radar",
    );
  });

  it("plural continua sendo listicle de descoberta ('ferramentas de IA escondidas') → use_melhor", () => {
    assert.equal(
      bucketOf({
        url: "https://example.com/ferramentas-ia-escondidas",
        title: "8 ferramentas de IA escondidas que facilitam o trabalho",
      }),
      "use_melhor",
    );
  });
});

describe("#5995 261005 — Apple Machine Learning Research é pesquisa", () => {
  it("CASO REAL 261005: 'Limits of Confidence in Diffusion' ('choosing which' no abstract) → pesquisa/RADAR", () => {
    const a = {
      url: "https://machinelearning.apple.com/research/limits-confidence-diffusion",
      title: "Limits of Confidence in Diffusion",
      summary:
        "Discrete diffusion, including remasking and uniform-state samplers, generate a sequence by writing multiple token positions per step, drawing each from a per-position distribution and choosing which positions to write from those same distributions.",
    };
    assert.equal(categorize(a), "pesquisa");
    assert.equal(bucketOf(a), "radar");
  });
});
