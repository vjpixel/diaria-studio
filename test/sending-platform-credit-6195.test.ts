/**
 * test/sending-platform-credit-6195.test.ts (#6195)
 *
 * O que estes testes impedem: uma edição **enviada pelo Kit** afirmar que foi
 * enviada pela Beehiiv — e, pior, carregar o **link de afiliado da
 * concorrente** dentro da edição que a nova plataforma entregou.
 *
 * A degradação segura aqui é o texto NEUTRO ("enviei por e-mail"), nunca o
 * crédito errado: se o link de afiliado do Kit não estiver configurado, a
 * edição sai sem link nenhum — jamais com o link da Beehiiv.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aplicarCreditoKit,
  buildCreditoKit,
  contemResiduoBeehiiv,
  CREDITO_NEUTRO,
} from "../scripts/lib/shared/sending-platform-credit.ts";
import { buildKitHtml } from "../scripts/publish-newsletter-kit.ts";
import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CREDITO_ORIGINAL =
  "enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria))";
const ENCERRAR = `Nesta edição da **diar.ia.br**, usei Claude Code (...), dei o toque final e ${CREDITO_ORIGINAL}.`;

describe("#6195 buildCreditoKit — sem link configurado degrada pra neutro", () => {
  it("url vazia ⇒ texto neutro, SEM link", () => {
    for (const url of [undefined, "", "   "]) {
      const c = buildCreditoKit({ kitAffiliateUrl: url });
      assert.equal(c, CREDITO_NEUTRO);
      assert.doesNotMatch(c, /\]\(http/, "neutro não pode carregar link nenhum");
    }
  });

  it("url configurada ⇒ crédito do Kit com o link", () => {
    const c = buildCreditoKit({ kitAffiliateUrl: "https://partnerstack.example/kit", kitOfferText: "ganhe 50%" });
    assert.equal(c, "enviei via Kit ([ganhe 50%](https://partnerstack.example/kit))");
  });

  it("url sem copy de oferta usa um default, não string vazia", () => {
    const c = buildCreditoKit({ kitAffiliateUrl: "https://x.example" });
    assert.match(c, /\[.+\]\(https:\/\/x\.example\)/, "o rótulo do link não pode ficar vazio");
  });

  it("NUNCA menciona Beehiiv, em nenhuma configuração", () => {
    for (const opts of [{}, { kitAffiliateUrl: "https://x.example" }, { kitAffiliateUrl: "  " }]) {
      assert.doesNotMatch(buildCreditoKit(opts), /beehiiv/i);
    }
  });
});

describe("#6195 aplicarCreditoKit — a troca no markdown do 'Para encerrar'", () => {
  it("sem link: o crédito da Beehiiv SOME e vira neutro", () => {
    const r = aplicarCreditoKit(ENCERRAR);
    assert.equal(r.substituido, true);
    assert.doesNotMatch(r.markdown, /beehiiv/i, "nenhum vestígio da Beehiiv, nem o link de afiliado");
    assert.match(r.markdown, /enviei por e-mail/);
  });

  it("com link: vira crédito do Kit, e o link da Beehiiv some junto", () => {
    const r = aplicarCreditoKit(ENCERRAR, { kitAffiliateUrl: "https://k.example", kitOfferText: "oferta" });
    assert.equal(r.substituido, true);
    assert.doesNotMatch(r.markdown, /beehiiv\.com/);
    assert.match(r.markdown, /enviei via Kit \(\[oferta\]\(https:\/\/k\.example\)\)/);
  });

  it("preserva o resto do parágrafo — não é reescrita de copy", () => {
    const r = aplicarCreditoKit(ENCERRAR);
    assert.match(r.markdown, /Nesta edição da \*\*diar\.ia\.br\*\*/);
    assert.match(r.markdown, /dei o toque final e/);
    assert.match(r.markdown, /\.$/, "a pontuação final continua no lugar");
  });

  it("copy sem o trecho da Beehiiv ⇒ substituido:false, markdown INTOCADO", () => {
    // O caller loga isso. Não lançamos: crédito impreciso não justifica
    // derrubar a edição inteira.
    const outro = "Texto totalmente diferente, sem crédito de plataforma.";
    const r = aplicarCreditoKit(outro);
    assert.equal(r.substituido, false);
    assert.equal(r.markdown, outro);
  });

  it("IDEMPOTENTE: aplicar 2× não duplica nem corrompe", () => {
    const um = aplicarCreditoKit(ENCERRAR);
    const dois = aplicarCreditoKit(um.markdown);
    assert.equal(dois.substituido, false);
    assert.equal(dois.markdown, um.markdown);
    assert.equal((um.markdown.match(/enviei por e-mail/g) ?? []).length, 1);
  });

  it("REGRESSÃO: o link de afiliado nunca fica órfão", () => {
    const r = aplicarCreditoKit(ENCERRAR);
    assert.doesNotMatch(r.markdown, /via=Diaria/, "o parâmetro de afiliado não pode sobreviver");
    assert.doesNotMatch(r.markdown, /beehiiv/i);
  });
});

describe("#6207 review P0 — a âncora sobrevive à reescrita da Clarice/humanizador", () => {
  // O review REPRODUZIU a falha da 1ª versão: match de copy exata quebra
  // porque `content.encerrar` atravessa humanizador + Clarice, ambos
  // reescrevendo o markdown inteiro. Precedente #1982: a Clarice já alterou
  // o link dos cupons NEWS25/NEWS50 NESTE MESMO parágrafo.
  const VARIANTES = [
    "enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto nos primeiros 3 meses](https://www.beehiiv.com?via=Diaria))",
    "enviei via Beehiiv ([um mês grátis e 20% off por 3 meses](https://www.beehiiv.com?via=Diaria))",
    "enviada pela Beehiiv ([oferta](https://beehiiv.com?via=Diaria))",
    "enviei via Beehiiv ([ganhe desconto](https://www.beehiiv.com/?via=Diaria&utm_source=x))",
    "enviei pela Beehiiv ( [ espaçado ](https://www.beehiiv.com?via=Diaria) )",
  ];

  for (const [i, variante] of VARIANTES.entries()) {
    it(`variante ${i + 1} reescrita ainda é trocada — sem resíduo da concorrente`, () => {
      const md = `Nesta edição, dei o toque final e ${variante}.`;
      const r = aplicarCreditoKit(md);
      assert.equal(r.substituido, true, `não casou: ${variante}`);
      assert.equal(contemResiduoBeehiiv(r.markdown), false, "sobrou menção à Beehiiv");
      assert.match(r.markdown, /dei o toque final e/, "o prefixo do parágrafo não pode ser comido");
    });
  }
});

describe("#6207 review P0 — contemResiduoBeehiiv é o guard real", () => {
  it("pega a concorrente sobrando MESMO quando a substituição falhou", () => {
    // O ponto: o guard não pergunta "achei meu padrão?", pergunta "sobrou a
    // concorrente?". Copy exótica demais pra âncora ainda é pega aqui.
    const exotico = "o envio ficou por conta da plataforma beehiiv.com dessa vez";
    const r = aplicarCreditoKit(exotico);
    assert.equal(r.substituido, false, "a âncora não casa este texto — esperado");
    assert.equal(contemResiduoBeehiiv(r.markdown), true, "mas o guard TEM de pegar");
  });

  it("HTML limpo passa — o invariante não gera falso positivo", () => {
    assert.equal(contemResiduoBeehiiv("<p>enviei por e-mail</p>"), false);
  });

  it("é case-insensitive", () => {
    for (const v of ["BEEHIIV", "Beehiiv", "beehiiv"]) assert.equal(contemResiduoBeehiiv(v), true);
  });
});

describe("#6207 review P3 — URL de afiliado inválida cai no neutro", () => {
  it("valores não-http não viram link", () => {
    for (const bad of ["javascript:alert(1)", "não é url", "ftp://x.com", "/relativo"]) {
      assert.equal(buildCreditoKit({ kitAffiliateUrl: bad }), CREDITO_NEUTRO, `aceitou: ${bad}`);
    }
  });

  it("http e https são aceitos", () => {
    for (const ok of ["http://x.example", "https://x.example/a?b=1"]) {
      assert.match(buildCreditoKit({ kitAffiliateUrl: ok }), /enviei via Kit/);
    }
  });
});

describe("#6207 review P2 — integração real via buildKitHtml", () => {
  // Achado do review: nenhum teste exercitava o caminho de produção. O
  // fixture de `publish-newsletter-kit.test.ts` não tem bloco PARA ENCERRAR,
  // então `content.encerrar` era sempre null e o código novo nunca rodava;
  // os testes do dispatch mockam `buildPayload` inteiro. Aqui o content vem
  // de `extractContent` sobre markdown real, como em produção.
  const REVIEWED = [
    "TÍTULO",
    "",
    "Modelos se replicam sozinhos",
    "",
    "SUBTÍTULO",
    "",
    "Segundo destaque | Terceiro destaque",
    "",
    "---",
    "",
    "**DESTAQUE 1 | LANÇAMENTO**",
    "",
    "**[Modelos se replicam sozinhos](https://example.com/1)**",
    "",
    "Corpo do destaque um com contexto suficiente pra render.",
    "",
    "Por que isso importa: razão um.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | RADAR**",
    "",
    "**[Segundo destaque](https://example.com/2)**",
    "",
    "Corpo dois.",
    "",
    "Por que isso importa: razão dois.",
    "",
  ];

  function edicaoCom(encerrar: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "credito-6195-"));
    const dir = join(root, "data/editions/260826");
    mkdirSync(dir, { recursive: true });
    const linhas = [...REVIEWED];
    if (encerrar !== null) {
      linhas.push("---", "", "🙋🏼‍♀️ PARA ENCERRAR", "", encerrar, "");
    }
    writeFileSync(join(dir, "02-reviewed.md"), linhas.join("\n"), "utf8");
    writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
    return dir;
  }

  it("SEM link configurado: HTML sai neutro e SEM resíduo da concorrente", () => {
    const dir = edicaoCom(`Nesta edição, dei o toque final e ${CREDITO_ORIGINAL}.`);
    const r = buildKitHtml(extractContent(dir), {}, {});
    assert.equal(r.creditoSubstituido, true);
    assert.equal(r.residuoBeehiiv, false, "o guard tem de confirmar HTML limpo");
    assert.match(r.html, /enviei por e-mail/);
    assert.doesNotMatch(r.html, /via=Diaria/);
  });

  it("COM link configurado: HTML credita o Kit", () => {
    const dir = edicaoCom(`Nesta edição, dei o toque final e ${CREDITO_ORIGINAL}.`);
    const r = buildKitHtml(extractContent(dir), {}, {
      kitAffiliateUrl: "https://k.example",
      kitOfferText: "oferta",
    });
    assert.equal(r.residuoBeehiiv, false);
    assert.match(r.html, /enviei via Kit/);
    assert.doesNotMatch(r.html, /beehiiv/i);
  });

  it("REGRESSÃO: copy irreconhecível ⇒ residuoBeehiiv TRUE (o guard dispara)", () => {
    // O caso que o review reproduziu contra a 1ª versão, e que passava
    // silenciosamente. Agora a substituição falha E o guard acusa.
    const dir = edicaoCom("O disparo saiu pela beehiiv.com como sempre.");
    const r = buildKitHtml(extractContent(dir), {}, {});
    assert.equal(r.creditoSubstituido, false);
    assert.equal(r.residuoBeehiiv, true, "o HTML ainda menciona a concorrente — precisa acusar");
  });

  it("edição sem bloco 'Para encerrar' ⇒ sem resíduo, sem quebrar", () => {
    const r = buildKitHtml(extractContent(edicaoCom(null)), {}, {});
    assert.equal(r.residuoBeehiiv, false);
  });

  it("não muta o `content` recebido", () => {
    const content = extractContent(edicaoCom(`Dei o toque final e ${CREDITO_ORIGINAL}.`));
    const original = content.encerrar;
    buildKitHtml(content, {}, {});
    assert.equal(content.encerrar, original, "shallow copy, nunca mutação do caller");
  });
});
