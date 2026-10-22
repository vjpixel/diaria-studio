import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNewsletterDiff, stripSectionBoxes, wordSimilarity } from "../scripts/derive-editor-requests.ts";

// #10883: fixtures reduzidas dos snapshots `stage2-post-gate` × `stage4-post-gate`
// de 261014, 261015, 261016 e 261021 (data/ não existe no CI). A estrutura
// (cabeçalhos, `---`, caixas, placeholder, VÍDEO no singular) é a do arquivo real.

const intro = (title: string, subtitle: string, count: number, box0 = "") =>
  [
    "TÍTULO", "", title, "", "SUBTÍTULO", "", subtitle, "", "---",
    "Olá! Eu sou o Pixel, editor desta newsletter.", "",
    `Nesta edição, a IA analisou 359 conteúdos e selecionei os ${count} mais relevantes.`, "", "---", "",
    ...(box0 ? [box0, "", "---", ""] : []),
  ].join("\n");

const destaque = (n: number, cat: string, title: string, slug: string, body: string, box = "") =>
  [
    `**DESTAQUE ${n} | ${cat}**`, "",
    `**[${title}](https://example.com/${slug})**  `, "",
    body, "",
    "Por que isso importa:", "",
    "Porque sim, com um fato concreto.", "", "---", "",
    ...(box ? [box, "", "---", ""] : []),
  ].join("\n");

const CORPO_OAB = "A OAB-SP quer medir quanto tempo um advogado gasta de fato sobre o que a máquina escreveu.";
const CORPO_ARGON = "O Argon chegou para quem assina o Gemini Pro, com contexto maior e preço igual.";
const CORPO_TVBOX = "Quinze TV boxes genéricas de cerca de US$ 55 cada bastaram para a Anthropic rodar o modelo.";

const CAIXA_ANTIGA = "Você gosta dos conteúdos da diar.ia.br? Vem aprender a usar IA para criar conteúdo!\n\n[Saiba mais](https://diar.ia.br/evento/agente-ia)";
const CAIXA_NOVA =
  "Produza um mês de conteúdo com sua identidade em uma hora\n\nSábado, 17/10, das 14h às 18h, ao vivo no Zoom: você monta um assistente que cria posts para cada rede, com texto e imagem, e testa com uma pauta sua. Sem programar.\n\n[Garantir meu ingresso](https://diar.ia.br/evento/agente-ia)";

const erro = (narrativa: string) =>
  ["**ERRO INTENCIONAL**", "", "Na última edição, escrevi Fotoshop onde o correto é Photoshop.", "", `Nessa edição, ${narrativa}.`, "", "---", ""].join("\n");

const eia = (videoDesc: string) =>
  [
    "**É IA?**", "",
    "[Calçadão](https://pt.wikipedia.org/wiki/Pedonal) à beira-mar de Norderney, Baixa Saxônia, Alemanha.", "",
    "Resultado da última edição: 80% das pessoas acertaram.", "", "---", "",
    "**📺 VÍDEO**", "",
    "**[LGTM (Looks Good to Me), videoclipe do Claude Opus 5.5](https://youtu.be/3TNpOD6bov8)**",
    videoDesc, "", "---", "",
  ].join("\n");

const types = (out: ReturnType<typeof classifyNewsletterDiff>) => out.map((r) => `${r.request_type}:${r.context?.section}`);

describe("#10883 — lead-rewrite só para reescrita real", () => {
  it("261014: caixa trocada abaixo do D1 não é lead-rewrite do d1", () => {
    const before = destaque(1, "🇧🇷 BRASIL", "OAB-SP vai à Justiça contra a startup Enter", "oab", CORPO_OAB, CAIXA_ANTIGA);
    const after = destaque(1, "🇧🇷 BRASIL", "OAB-SP vai à Justiça contra a startup Enter", "oab", CORPO_OAB, CAIXA_NOVA);
    assert.deepEqual(classifyNewsletterDiff(before, after), []);
  });

  it("261014: a edição inteira (caixa + reordenação D2/D3 + intro derivada) não emite lead-rewrite", () => {
    const before =
      intro("OAB-SP vai à Justiça contra a startup Enter", "Assina o Gemini Pro? | Anthropic roda modelo em TV boxes", 12) +
      destaque(1, "🇧🇷 BRASIL", "OAB-SP vai à Justiça contra a startup Enter", "oab", CORPO_OAB, CAIXA_ANTIGA) +
      destaque(2, "🚀 LANÇAMENTO", "Assina o Gemini Pro? O Argon já chegou", "argon", CORPO_ARGON) +
      destaque(3, "🔬 PESQUISA", "Anthropic roda modelo em 15 TV boxes", "tvbox", CORPO_TVBOX);
    const after =
      intro("OAB-SP vai à Justiça contra a startup Enter", "Anthropic roda modelo em TV boxes | Assina o Gemini Pro?", 10) +
      destaque(1, "🇧🇷 BRASIL", "OAB-SP vai à Justiça contra a startup Enter", "oab", CORPO_OAB, CAIXA_NOVA) +
      destaque(2, "🔬 PESQUISA", "Anthropic roda modelo em 15 TV boxes", "tvbox", CORPO_TVBOX) +
      destaque(3, "🚀 LANÇAMENTO", "Assina o Gemini Pro? O Argon já chegou", "argon", CORPO_ARGON);
    assert.deepEqual(types(classifyNewsletterDiff(before, after)), ["section-order:destaque-2", "section-order:destaque-3"]);
  });

  it("261015: preencher {PREENCHER_NARRATIVA_DO_ERRO} vira other, não lead-rewrite", () => {
    const out = classifyNewsletterDiff(
      erro("{PREENCHER_NARRATIVA_DO_ERRO}"),
      erro("o nome de um banco foi escrito errado numa descrição do USE MELHOR. Qual é o erro?"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].request_type, "other");
    assert.equal(out[0].context?.change_kind, "placeholder-preenchido");
  });

  it("261016: VÍDEO editado logo abaixo do É IA? não é mudança no É IA?", () => {
    const out = classifyNewsletterDiff(
      eia("Videoclipe musical sobre o Claude Opus 5.5, publicado pelo canal Degenerative Pixels."),
      eia("Clipe sobre engenheiros que aprovam código sem ler porque os prazos foram cortados em nome da IA. A música foi feita no Suno e a animação, programada pelo Claude Opus 5.5 em TypeScript e three.js."),
    );
    assert.ok(out.every((r) => r.context?.section !== "e-ia"), JSON.stringify(out));
    assert.ok(out.every((r) => r.request_type !== "lead-rewrite"));
    assert.deepEqual(types(out), ["pool-text-edit:video"]);
  });

  it("261021: intro com caixa nova e título derivado de destaques reordenados não emite evento", () => {
    const corpoA = "A Cloudflare lançou o Clairic, um modelo que extrai valores de textos e imagens.";
    const corpoB = "O curso de IA da UFG teve nota de corte maior que a de medicina.";
    const corpoC = "Um modelo de pesquisa da OpenAI gastou o saldo de uma carteira de criptomoedas de terceiros.";
    const before =
      intro("Cloudflare lança modelo que lê sem gerar texto", "Curso de IA supera medicina | Modelo da OpenAI gastou cripto", 13) +
      destaque(1, "🚀 LANÇAMENTO", "Cloudflare lança modelo que lê sem gerar texto", "cloudflare", corpoA) +
      destaque(2, "🇧🇷 BRASIL", "Curso de IA supera medicina na UFG", "ufg", corpoB) +
      destaque(3, "🔐 SEGURANÇA", "Modelo da OpenAI gastou cripto alheia", "openai", corpoC);
    const after =
      intro(
        "Você já viu IA mentir. Já viu roubar?",
        "Cloudflare lança modelo que lê sem gerar texto | Curso de IA supera medicina",
        10,
        "<!-- box0-sem-rotulo -->\n<!-- box0 -->\n**Agora também em vídeo**\n\nA partir de hoje, vou comentar o principal destaque da diar.ia.br no YouTube, todos os dias, com contexto extra.\n\n[Confira o primeiro vídeo no canal](https://www.youtube.com/@diariabr)",
      ) +
      destaque(1, "🔐 SEGURANÇA", "Você já viu IA mentir. Já viu roubar?", "openai", corpoC) +
      destaque(2, "🚀 LANÇAMENTO", "Cloudflare lança modelo que lê sem gerar texto", "cloudflare", corpoA) +
      destaque(3, "🇧🇷 BRASIL", "Curso de IA supera medicina na UFG", "ufg", corpoB);
    const out = classifyNewsletterDiff(before, after);
    assert.ok(out.every((r) => r.context?.section !== "intro"), JSON.stringify(types(out)));
    assert.ok(out.every((r) => r.request_type !== "lead-rewrite"));
  });

  it("261016 D3: reordenação com o corpo reescrito emite lead-rewrite além do section-order", () => {
    const corpoRiachuelo = "O RH da Riachuelo criou um sistema interno em 12 dias, sem escrever código.";
    const corpoEditoras = "Editoras não conseguem provar que um livro foi escrito por um humano.";
    const corpoSms = "Recebeu SMS suspeito? O Circle to Search agora diz se a mensagem é golpe.";
    const writer =
      "Oito estados americanos processaram a OpenAI acusando o ChatGPT de expor crianças a conteúdo nocivo, com pedidos de indenização e de mudanças no produto.";
    const editor =
      "O ChatGPT que crianças usam no Brasil é o mesmo que oito estados dos EUA acusam na Justiça de ter feito mal a menores. Para quem deixa os filhos usar, a ação lista conversas sobre automutilação.";
    const before =
      destaque(1, "JUSTIÇA", "Seu filho usa ChatGPT? 8 estados acusam a OpenAI", "guardian-chatgpt", writer) +
      destaque(2, "SEGURANÇA", "Recebeu SMS suspeito? Circule antes de clicar", "sms", corpoSms) +
      destaque(3, "BRASIL", "RH da Riachuelo cria sistema em 12 dias sem código", "riachuelo", corpoRiachuelo);
    const after =
      destaque(1, "BRASIL", "RH da Riachuelo cria sistema em 12 dias sem código", "riachuelo", corpoRiachuelo) +
      destaque(2, "CULTURA", "Editoras não conseguem provar que livro é humano", "editoras", corpoEditoras) +
      destaque(3, "JUSTIÇA", "ChatGPT fez mal a crianças, acusam 8 estados dos EUA", "guardian-chatgpt", editor);
    const out = classifyNewsletterDiff(before, after);
    assert.deepEqual(types(out), [
      "section-order:destaque-1",
      "destaque-swap:destaque-2",
      "section-order:destaque-3",
      "lead-rewrite:destaque-3",
    ]);
    const rewrite = out.find((r) => r.request_type === "lead-rewrite")!;
    assert.equal(rewrite.target, "d3");
    assert.equal(rewrite.context?.from_section, "destaque-1");
    assert.equal(rewrite.context?.change_kind, "reordenado-reescrito");
    assert.equal(rewrite.context?.url, "https://example.com/guardian-chatgpt");
    // O D1 reordenado sem edição não ganha lead-rewrite.
    assert.equal(out.filter((r) => r.request_type === "lead-rewrite").length, 1);
  });

  it("reescrita no mesmo slot continua lead-rewrite (sem regressão)", () => {
    const before = destaque(2, "NOTÍCIAS", "Título", "x", "Texto curto do writer.");
    const after = destaque(2, "NOTÍCIAS", "Título", "x", "Texto bem mais longo que o editor escreveu, acrescentando contexto, números e o nome do pesquisador citado.");
    assert.deepEqual(types(classifyNewsletterDiff(before, after)), ["lead-rewrite:destaque-2"]);
  });
});

describe("#10883 — helpers", () => {
  it("stripSectionBoxes corta destaque e É IA? no 1º ---", () => {
    assert.equal(stripSectionBoxes("destaque-1", "**DESTAQUE 1 | X**\n\ncorpo\n\n---\n\ncaixa\n\n---\n"), "**DESTAQUE 1 | X**\n\ncorpo\n");
    assert.equal(stripSectionBoxes("e-ia", "**É IA?**\n\nfoto\n\n---\n\n**📺 VÍDEO**\n"), "**É IA?**\n\nfoto\n");
  });

  it("stripSectionBoxes tira da intro só o bloco marcado como caixa", () => {
    const text = "TÍTULO\n\nT\n\n---\nOlá!\n\n---\n\n<!-- box0 -->\n**Caixa**\n\n---\n";
    const out = stripSectionBoxes("intro", text);
    assert.ok(!out.includes("Caixa"));
    assert.ok(out.includes("Olá!") && out.includes("TÍTULO"));
    assert.equal(stripSectionBoxes("intro", "TÍTULO\n\n---\nOlá!\n"), "TÍTULO\n\n---\nOlá!\n");
  });

  it("wordSimilarity", () => {
    assert.equal(wordSimilarity("a b c", "a b c"), 1);
    assert.equal(wordSimilarity("", ""), 1);
    assert.equal(wordSimilarity("a b", "c d"), 0);
    assert.equal(wordSimilarity("Um, dois! três", "um dois tres quatro"), (2 * 2) / 7);
  });
});
