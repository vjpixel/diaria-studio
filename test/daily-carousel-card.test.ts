/**
 * daily-carousel-card.test.ts (#6005 Parte B)
 *
 * Cobre o miolo PURE de `scripts/lib/daily-carousel-card.ts`:
 *   - splitIntoParagraphCards: 1:1 no caso comum, resiliente a desvio.
 *   - buildCarouselSlideTexts: 3 parágrafos + CTA, kicker de posição.
 *   - resolveCarouselImageUrls: tudo-ou-nada (qualquer slide ausente -> null).
 *
 * `renderCarouselSlides` (chama sharp de verdade via `renderFlatCard`) não é
 * exercitado aqui — mesma disciplina de `weekly-flat-card.test.ts`, que só
 * testa o SVG puro (`buildFlatCardSvg`) e o cache, nunca o render real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitIntoParagraphCards,
  buildCarouselSlideTexts,
  carouselSlideFilename,
  carouselImageKeys,
  resolveCarouselImageUrls,
  CAROUSEL_SLIDE_SLOTS,
  findOverflowingCarouselSlides,
  DAILY_CAROUSEL_LAYOUT,
  DAILY_CAROUSEL_BODY_SIZE,
  DAILY_CAROUSEL_HANDLE,
  DAILY_CAROUSEL_MICRO_CTA,
  hashCarouselSlideTexts,
} from "../scripts/lib/daily-carousel-card.ts";
import { measureFlatCardBody, buildFlatCardSvg } from "../scripts/lib/weekly-flat-card.ts";
import { createHash } from "node:crypto";
import { INSTAGRAM_CTA_LINE } from "../scripts/lib/social-cta-lines.ts";

describe("splitIntoParagraphCards (pure)", () => {
  it("caso comum: exatamente 3 parágrafos (separados por linha em branco) -> passthrough 1:1", () => {
    const body = "Primeiro parágrafo aqui.\n\nSegundo parágrafo aqui.\n\nTerceiro parágrafo aqui.";
    const result = splitIntoParagraphCards(body, 3);
    assert.deepEqual(result, ["Primeiro parágrafo aqui.", "Segundo parágrafo aqui.", "Terceiro parágrafo aqui."]);
  });

  it("normaliza espaços internos (quebras de linha simples dentro de um parágrafo viram espaço)", () => {
    const body = "Linha 1\nLinha 2 do mesmo parágrafo.\n\nSegundo.\n\nTerceiro.";
    const result = splitIntoParagraphCards(body, 3);
    assert.equal(result[0], "Linha 1 Linha 2 do mesmo parágrafo.");
  });

  it("MAIS parágrafos que o alvo: mantém os primeiros N-1, funde o resto no último (nunca descarta conteúdo)", () => {
    const body = "Um.\n\nDois.\n\nTrês.\n\nQuatro.";
    const result = splitIntoParagraphCards(body, 3);
    assert.equal(result.length, 3);
    assert.deepEqual(result.slice(0, 2), ["Um.", "Dois."]);
    assert.equal(result[2], "Três. Quatro.");
  });

  it("MENOS parágrafos que o alvo: divide o mais longo em sentenças até atingir o alvo", () => {
    const body = "Curto.\n\nEste é um parágrafo bem mais longo. Tem duas frases claras. Devia dar pra dividir.";
    const result = splitIntoParagraphCards(body, 3);
    assert.equal(result.length, 3);
    assert.equal(result[0], "Curto.");
  });

  it("texto de 1 frase só (não dá pra dividir mais): retorna menos que o alvo, nunca lança", () => {
    const body = "Uma frase única sem mais nada.";
    const result = splitIntoParagraphCards(body, 3);
    assert.ok(result.length >= 1 && result.length < 3);
  });

  it("corpo vazio -> array vazio", () => {
    assert.deepEqual(splitIntoParagraphCards("", 3), []);
  });
});

describe("buildCarouselSlideTexts (pure)", () => {
  it("produz p1/p2/p3 (kicker de posição) + cta (INSTAGRAM_CTA_LINE)", () => {
    const genericText = "Um.\n\nDois.\n\nTrês.\n\n#InteligenciaArtificial #Agentes";
    const texts = buildCarouselSlideTexts(genericText);
    assert.equal(texts.p1.title, "Um.");
    assert.equal(texts.p2.title, "Dois.");
    assert.equal(texts.p3.title, "Três.");
    assert.equal(texts.p1.kicker, "01 / 03");
    assert.equal(texts.p3.kicker, "03 / 03");
    assert.equal(texts.cta.title, INSTAGRAM_CTA_LINE);
    for (const slot of CAROUSEL_SLIDE_SLOTS) assert.equal(texts[slot].footer, "diar.ia.br");
  });

  it("#6086 item a/b: p1/p2/p3 carregam handle + micro-CTA; o CTA final NÃO (seria redundante lá)", () => {
    const genericText = "Um.\n\nDois.\n\nTrês.\n\n#InteligenciaArtificial";
    const texts = buildCarouselSlideTexts(genericText);
    for (const slot of ["p1", "p2", "p3"] as const) {
      assert.equal(texts[slot].handle, DAILY_CAROUSEL_HANDLE);
      assert.equal(texts[slot].microCta, DAILY_CAROUSEL_MICRO_CTA);
    }
    assert.equal(texts.cta.handle, undefined);
    assert.equal(texts.cta.microCta, undefined);
  });

  it("remove o bloco de hashtags antes de dividir em parágrafos (splitBodyAndTags)", () => {
    const genericText = "Um.\n\nDois.\n\nTrês.\n\n#Tag1 #Tag2 #Tag3";
    const texts = buildCarouselSlideTexts(genericText);
    for (const slot of ["p1", "p2", "p3"] as const) {
      assert.doesNotMatch(texts[slot].title, /#Tag/);
    }
  });
});

describe("carouselSlideFilename / carouselImageKeys (pure)", () => {
  it("nomes de arquivo seguem a convenção 04-{destaque}-carousel-{slot}-4x5.jpg", () => {
    assert.equal(carouselSlideFilename("d1", "p1"), "04-d1-carousel-p1-4x5.jpg");
    assert.equal(carouselSlideFilename("d2", "cta"), "04-d2-carousel-cta-4x5.jpg");
  });

  it("chaves de 06-public-images.json seguem {destaque}_carousel_{slot}, capa reusa {destaque}_4x5", () => {
    const { cover, slides } = carouselImageKeys("d3");
    assert.equal(cover, "d3_4x5");
    assert.equal(slides.p1, "d3_carousel_p1");
    assert.equal(slides.cta, "d3_carousel_cta");
  });
});

describe("resolveCarouselImageUrls (pure) — tudo-ou-nada", () => {
  const fullImages = {
    d1_4x5: { url: "https://x/cover" },
    d1_carousel_p1: { url: "https://x/p1" },
    d1_carousel_p2: { url: "https://x/p2" },
    d1_carousel_p3: { url: "https://x/p3" },
    d1_carousel_cta: { url: "https://x/cta" },
  };

  it("todos os 5 presentes -> array ordenado [capa, p1, p2, p3, cta]", () => {
    const urls = resolveCarouselImageUrls(fullImages, "d1");
    assert.deepEqual(urls, ["https://x/cover", "https://x/p1", "https://x/p2", "https://x/p3", "https://x/cta"]);
  });

  it("capa ausente -> null (fallback pro single-image)", () => {
    const { d1_4x5, ...rest } = fullImages;
    assert.equal(resolveCarouselImageUrls(rest, "d1"), null);
  });

  it("1 slide de parágrafo ausente -> null (nunca publica carrossel incompleto)", () => {
    const { d1_carousel_p2, ...rest } = fullImages;
    assert.equal(resolveCarouselImageUrls(rest, "d1"), null);
  });

  it("CTA ausente -> null", () => {
    const { d1_carousel_cta, ...rest } = fullImages;
    assert.equal(resolveCarouselImageUrls(rest, "d1"), null);
  });

  it("images undefined -> null", () => {
    assert.equal(resolveCarouselImageUrls(undefined, "d1"), null);
  });

  it("destaque sem nenhuma entry (edição sem carrossel) -> null", () => {
    assert.equal(resolveCarouselImageUrls(fullImages, "d2"), null);
  });
});

/**
 * (#6078 item 2) Tamanho FIXO nos slides de texto do carrossel diário e a
 * política de overflow que ele obriga: parágrafo que não cabe é REESCRITO,
 * nunca encolhido nem cortado — então alguém precisa FICAR SABENDO.
 */
describe("tamanho fixo do carrossel diário (#6078)", () => {
  const p = (n: number, word = "palavra") => {
    // texto realista (palavras de tamanho médio) com ~n caracteres
    let s = "";
    while (s.length < n) s += (s ? " " : "") + word;
    return s.slice(0, n).trim();
  };
  const textoCom = (paras: string[]) => paras.join("\n\n");

  it("os 4 slides saem com a MESMA métrica, independente do tamanho do texto", () => {
    const texts = buildCarouselSlideTexts(textoCom([p(60), p(300), p(120)]));
    const sizes = CAROUSEL_SLIDE_SLOTS.map(
      (slot) => measureFlatCardBody(texts[slot].title, DAILY_CAROUSEL_LAYOUT).size,
    );
    assert.deepEqual(
      sizes,
      [DAILY_CAROUSEL_BODY_SIZE, DAILY_CAROUSEL_BODY_SIZE, DAILY_CAROUSEL_BODY_SIZE, DAILY_CAROUSEL_BODY_SIZE],
      "tamanho fixo: nenhum slide pode ser dimensionado em função do próprio texto",
    );
  });

  it("o layout default (semanal) continua auto-size — o fixo é só do diário", () => {
    const curto = measureFlatCardBody("Título curto");
    const longo = measureFlatCardBody(p(400));
    assert.ok(curto.size > longo.size, "fill: texto curto cresce, texto longo encolhe (comportamento do #5330)");
    assert.equal(curto.overflows, false);
    assert.equal(longo.overflows, false, "fill encolhe pra caber enquanto houver tamanho disponível");
  });

  it("fill transborda quando nem o tamanho mínimo cabe (comportamento pré-existente, agora visível)", () => {
    const gigante = measureFlatCardBody(p(3000));
    assert.equal(gigante.overflows, true, "documenta o limite real do auto-size — não é 'nunca transborda'");
  });

  it("parágrafo dentro do limite não acusa overflow", () => {
    assert.deepEqual(findOverflowingCarouselSlides(textoCom([p(150), p(200), p(120)])), []);
  });

  it("parágrafo acima do limite é REPORTADO, com slot e tamanho", () => {
    const overflowing = findOverflowingCarouselSlides(textoCom([p(150), p(700), p(120)]));
    assert.equal(overflowing.length, 1, "só o parágrafo grande estoura");
    assert.equal(overflowing[0].slot, "p2");
    assert.ok(overflowing[0].excessPx > 0, "reporta quanto passou, pra estimar o corte");
    assert.ok(overflowing[0].chars >= 600, "reporta o tamanho do parágrafo, que é o que o editor manipula");
  });

  it("o CTA fixo cabe com folga — não é ele que vai acusar overflow", () => {
    const overflowing = findOverflowingCarouselSlides(textoCom([p(100), p(100), p(100)]));
    assert.equal(overflowing.find((o) => o.slot === "cta"), undefined);
  });
});

/**
 * (#6078) O carimbo de frescor precisa cobrir o LAYOUT, não só o texto —
 * senão uma edição já rasterizada com o auto-size antigo é PULADA por
 * `shouldRenderCarouselSlides` e nunca recebe a tipografia nova.
 */
describe("hashCarouselSlideTexts cobre o layout (#6078)", () => {
  const texto = ["Um parágrafo.", "Outro parágrafo.", "O fecho."].join("\n\n");

  it("mudar o tamanho fixo muda o hash (invalida arte gerada com o layout antigo)", () => {
    const atual = hashCarouselSlideTexts(texto);
    // simula o hash que o layout ANTIGO (auto-size) produziria pro mesmo texto
    const canonical = CAROUSEL_SLIDE_SLOTS.map((slot) => {
      const t = buildCarouselSlideTexts(texto)[slot];
      return `${t.kicker} || ${t.title}`;
    }).join(" ~~ ");
    const semLayout = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    assert.notEqual(atual, semLayout, "carimbo do layout novo não pode colidir com o do formato antigo");
  });

  it("mesmo texto + mesmo layout continua estável (idempotência preservada)", () => {
    assert.equal(hashCarouselSlideTexts(texto), hashCarouselSlideTexts(texto));
  });
});

describe("#6086 item c: hash sensível à marcação de negrito", () => {
  it("mudar SÓ o negrito (mesmo texto visível) muda o hash — arte regenera", () => {
    const semBold = "Primeiro parágrafo com uma frase importante.\n\nSegundo parágrafo.\n\nFecho.";
    const comBold = "Primeiro parágrafo com **uma frase importante**.\n\nSegundo parágrafo.\n\nFecho.";
    assert.notEqual(hashCarouselSlideTexts(semBold), hashCarouselSlideTexts(comBold));
  });

  it("a marcação sobrevive intacta ao split/normalize (splitIntoParagraphCards não come os `**`)", () => {
    const texts = buildCarouselSlideTexts(
      "Parágrafo um **com destaque** no meio.\n\nParágrafo dois.\n\nParágrafo três.",
    );
    assert.match(texts.p1.title, /\*\*com destaque\*\*/);
  });

  it("overflow reporta chars do texto VISÍVEL, sem os delimitadores `**`", () => {
    // Parágrafo que estoura as 12 linhas do teto em fixed 62px (~330+ chars).
    const longo = ("palavra ".repeat(60) + "**trecho marcado**").trim();
    const overflowing = findOverflowingCarouselSlides(`${longo}\n\np2.\n\np3.`);
    assert.ok(overflowing.length > 0, "esperava overflow");
    const p1 = overflowing.find((o) => o.slot === "p1")!;
    const semMarcacao = findOverflowingCarouselSlides(`${longo.replace(/\*\*/g, "")}\n\np2.\n\np3.`).find((o) => o.slot === "p1")!;
    assert.equal(p1.chars, semMarcacao.chars, "chars deve ser o texto visível — `**` não conta");
  });
});

/**
 * (#6078, review da #6085) A âncora no TOPO é a mudança visual central do
 * layout `fixed`, e nenhum teste a exercitava no nível do SVG — só o cálculo
 * numérico. Um refactor que revertesse o ternário de `blockTop` passaria
 * despercebido.
 */
describe("buildFlatCardSvg com layout fixed ancora o texto no TOPO (#6078)", () => {
  const KICKER_Y = 168, BAR_Y = KICKER_Y + 30, FOOTER_Y = 1350 - 62;
  const TITLE_TOP = BAR_Y + 90, TITLE_BOTTOM = FOOTER_Y - 90;
  const firstBodyY = (svg: string): number => {
    // 1º <text> depois do kicker é a 1ª linha de corpo
    const ys = [...svg.matchAll(/<text x="72" y="([\d.]+)"/g)].map((m) => Number(m[1]));
    return ys.filter((y) => y !== KICKER_Y && y !== FOOTER_Y)[0];
  };

  it("fixed: 1ª linha começa em TITLE_TOP, independente do tamanho do texto", () => {
    const esperado = TITLE_TOP + DAILY_CAROUSEL_BODY_SIZE * 0.85;
    for (const titulo of ["Curto.", "Um parágrafo bem mais longo, com várias palavras, que ocupa mais linhas do card."]) {
      const svg = buildFlatCardSvg({ kicker: "01 / 03", title: titulo, footer: "diar.ia.br" }, DAILY_CAROUSEL_LAYOUT);
      assert.equal(firstBodyY(svg), esperado, `"${titulo.slice(0, 20)}..." deveria começar no topo`);
    }
  });

  it("fill (default): bloco é CENTRALIZADO — texto curto começa BEM abaixo do topo", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "Curto.", footer: "diar.ia.br" });
    const y = firstBodyY(svg);
    assert.ok(y > TITLE_TOP + 50, `centralizado deveria começar abaixo de TITLE_TOP; veio ${y}`);
    assert.ok(y < TITLE_BOTTOM, "e ainda dentro do espaço disponível");
  });

  it("fixed usa o tamanho configurado no SVG, não um calculado", () => {
    const svg = buildFlatCardSvg({ kicker: "x", title: "Curto.", footer: "y" }, DAILY_CAROUSEL_LAYOUT);
    assert.match(svg, new RegExp(`font-size="${DAILY_CAROUSEL_BODY_SIZE}"`));
  });
});

/**
 * (#6086) Handle + micro-CTA no SVG rasterizado: presentes nos 3 slides de
 * parágrafo, ausentes no slide de CTA (redundante lá) e ausentes por default
 * em qualquer `FlatCardText` que não os declare (capa/CTA do carrossel
 * SEMANAL, layout `fill` — nunca tocado por este item da issue).
 */
describe("handle + micro-CTA no SVG do carrossel diário (#6086 itens a/b)", () => {
  it("slide de parágrafo (p1) renderiza handle e micro-CTA no SVG", () => {
    const genericText = "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.";
    const texts = buildCarouselSlideTexts(genericText);
    const svg = buildFlatCardSvg(texts.p1, DAILY_CAROUSEL_LAYOUT);
    assert.match(svg, /· @diar\.ia\.br/, "handle deveria aparecer no rodapé, junto do wordmark");
    assert.match(svg, new RegExp(DAILY_CAROUSEL_MICRO_CTA));
  });

  it("slide de CTA NÃO renderiza handle nem micro-CTA (redundante — o slide já é o convite)", () => {
    const genericText = "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.";
    const texts = buildCarouselSlideTexts(genericText);
    // #6086: nada de FlatCardText.handle/microCta setado pro CTA — confirma
    // a fonte (buildCarouselSlideTexts), não só o SVG (o corpo do CTA, via
    // INSTAGRAM_CTA_LINE, já menciona "@diar.ia.br" em texto corrido — não
    // confundir com o handle do RODAPÉ, que é o que este item cobre).
    assert.equal(texts.cta.handle, undefined);
    assert.equal(texts.cta.microCta, undefined);
    const svg = buildFlatCardSvg(texts.cta, DAILY_CAROUSEL_LAYOUT);
    assert.doesNotMatch(svg, /· @diar\.ia\.br/, "sem tspan de handle no rodapé");
    assert.doesNotMatch(svg, new RegExp(DAILY_CAROUSEL_MICRO_CTA));
  });

  it("FlatCardText sem handle/microCta (ex: capa/CTA do carrossel SEMANAL) não renderiza nada a mais — default inalterado", () => {
    const svg = buildFlatCardSvg({ kicker: "Resumo semanal", title: "Título qualquer", footer: "diar.ia.br" });
    assert.doesNotMatch(svg, /@diar\.ia\.br/, "handle nunca aparece sem opt-in explícito no FlatCardText");
    assert.doesNotMatch(svg, new RegExp(DAILY_CAROUSEL_MICRO_CTA));
  });
});

/**
 * (#6086) Geometria: handle/microCta foram desenhados pra caber na MESMA
 * linha do rodapé existente (tspan + `text-anchor="end"`), sem reservar
 * altura nova — de propósito, pra não mexer no teto de 12 linhas que o #6078
 * calibrou (62px -> 7,3% de reescrita, ver `DAILY_CAROUSEL_BODY_SIZE`).
 * Trava aqui o teto EFETIVO pós-#6086: uma mudança futura de rodapé que volte
 * a crescer verticalmente derruba este teste antes de derrubar a taxa de
 * reescrita em produção.
 */
describe("teto de linhas do corpo do carrossel diário — inalterado pelo #6086 (geometria)", () => {
  it("availableHeight/teto de linhas do layout fixo do diário continua o mesmo do #6078 (910px / 12 linhas)", () => {
    const semFooterExtra = measureFlatCardBody("Texto qualquer.", DAILY_CAROUSEL_LAYOUT);
    assert.equal(semFooterExtra.availableHeight, 910, "#6086 não deveria reduzir o espaço vertical do corpo");

    const lineGap = Math.round(DAILY_CAROUSEL_BODY_SIZE * 1.18);
    const maxLinesQueCabem = Math.floor(semFooterExtra.availableHeight / lineGap);
    assert.equal(maxLinesQueCabem, 12, "teto de 12 linhas (#6078) preservado após handle + micro-CTA (#6086)");
  });

  it("um parágrafo real que cabia antes do #6086 continua cabendo (handle/micro-CTA não roubam espaço do corpo)", () => {
    // ~300 chars, teto informado ao social-writer (DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET).
    const paragrafo =
      "Um parágrafo de tamanho representativo do que o social-writer produz normalmente, " +
      "com várias frases encadeadas pra chegar perto do teto de caracteres orientado no prompt, " +
      "sem no entanto estourar o limite real medido pela função de overflow.";
    const texts = buildCarouselSlideTexts(`${paragrafo}\n\nOutro.\n\nTerceiro.`);
    const overflowing = findOverflowingCarouselSlides(`${paragrafo}\n\nOutro.\n\nTerceiro.`);
    assert.deepEqual(overflowing, [], "parágrafo dentro do teto histórico não deveria estourar após #6086");
    // Confere também que o slide de fato carrega handle+microCta (não é um
    // falso-negativo por eles terem sido omitidos do texto testado).
    assert.equal(texts.p1.handle, DAILY_CAROUSEL_HANDLE);
  });
});
