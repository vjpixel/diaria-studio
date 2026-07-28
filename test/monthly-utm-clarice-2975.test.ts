/**
 * test/monthly-utm-clarice-2975.test.ts (#2975, regressão #633)
 * Estendido no #4040 (UTM por POSIÇÃO) e no #4059 (host de marca canônico).
 *
 * #2975 — assinantes vindos da Clarice News mensal apareciam no Beehiiv como
 * `utm_source=sendinblue` (auto-tag do Brevo), impossível medir a conversão da
 * migração Clarice→Diar.ia. Fix: todo link de marca do render mensal carrega
 * `utm_source=clarice&utm_medium=email&utm_campaign=clarice-{ciclo}`.
 *
 * #4059 — o host desses links passou de `diaria.beehiiv.com` pra `diar.ia.br`
 * (o redirect no Cloudflare preserva a query string desde 260723, então a
 * premissa do #2613 caiu). Links legados escritos pelo `writer-monthly` com o
 * host antigo são NORMALIZADOS pelo render e ainda assim ganham UTM.
 *
 * #4040 — o `utm_campaign` ganhou SUFIXO DE POSIÇÃO
 * (`clarice-{ciclo}-{posicao}`), porque o Beehiiv não persiste `utm_content`
 * na subscription: sem o sufixo dava pra saber que o assinante veio da mensal
 * do ciclo X, mas não POR QUAL LINK ele converteu. As 5 origens são:
 *   - wordmark automático: NÃO é mais link (decisão do editor 260727) — não
 *     convertia, e 4 âncoras por edição pro mesmo destino só somavam densidade
 *     promocional. O sufixo `wordmark-{seção}` do #4040 foi aposentado junto;
 *   - link markdown inline (`renderInline`)     → `inline-{seção}` (a edição
 *     tem dois CTAs "aqui", apresentação e encerramento; com o slug flat os
 *     dois saíam com href idêntico e o linksStats somava)
 *   - botão CTA (`renderCtaButton`)             → `cta`
 *   - título de destaque linkado                → `titulo`
 *   - pill link do encerramento                 → `pill-{rótulo}` (cursos e
 *     livros saem no mesmo encerramento; com o slug flat eram indistinguíveis)
 *   - "Ver ranking" do É IA?                     → `leaderboard`
 *
 * Host: `diar.ia.br` E seus subdomínios (`cursos.`, `livros.`, `eia.`) — antes
 * era só o host exato, e as curadorias saíam sem UTM nenhum. URL com merge tag
 * (`{{ contact.EMAIL }}` nos links de voto) NUNCA é tocada: `new URL().toString()`
 * percent-encodaria as chaves e a Brevo não substituiria.
 * Cada origem tem que emitir um `utm_campaign` DISTINTO, e nenhuma pode
 * regredir pra `sendinblue`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  draftToEmail,
  normalizeKnownUrl,
  renderCtaButton,
  renderInline,
  renderEia,
  renderEncerramento,
  renderLinkListSection,
  setMonthlyUtmCiclo,
  setMonthlyUtmSecao,
} from "../scripts/lib/mensal/monthly-render.ts";
import {
  buildMensalCampaign,
  slugifySecao,
} from "../scripts/lib/shared/utm-registry.ts";

/** Extrai todos os `utm_campaign=` de um HTML (des-escapando `&amp;`). */
function campaigns(html: string): string[] {
  const plain = html.replace(/&amp;/g, "&");
  const out: string[] = [];
  const re = /utm_campaign=([a-z0-9-]+)/gi;
  for (let m = re.exec(plain); m; m = re.exec(plain)) out.push(m[1]);
  return out;
}

describe("UTM clarice em links do host de marca (#2975)", () => {
  it("normalizeKnownUrl injeta utm_source/medium/campaign quando ciclo setado", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://diar.ia.br");
      assert.match(out, /utm_source=clarice/);
      assert.match(out, /utm_medium=email/);
      assert.match(out, /utm_campaign=clarice-2606-07-inline-geral/);
      assert.doesNotMatch(out, /sendinblue/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("#4059: link legado diaria.beehiiv.com é normalizado pro host de marca E ganha o UTM", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://diaria.beehiiv.com");
      assert.match(out, /^https:\/\/diar\.ia\.br\//);
      assert.doesNotMatch(out, /diaria\.beehiiv\.com/);
      assert.match(out, /utm_campaign=clarice-2606-07-inline-geral/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("#4059: normalização de host acontece mesmo sem ciclo (é branding, não medição)", () => {
    const out = normalizeKnownUrl("https://diaria.beehiiv.com/p/edicao-x");
    assert.match(out, /^https:\/\/diar\.ia\.br\/p\/edicao-x/);
    assert.doesNotMatch(out, /utm_campaign/);
  });

  // Curadorias (cursos/livros) e o "Ver ranking" do É IA? moram em SUBDOMÍNIO
  // do host de marca. Com o match de host exato saíam sem UTM nenhum — não dava
  // pra saber nem que o clique veio da mensal.
  it("subdomínio nosso (cursos/livros/eia) também recebe UTM", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      for (const u of ["https://cursos.diar.ia.br", "https://livros.diar.ia.br", "https://eia.diar.ia.br/leaderboard/2026?brand=clarice"]) {
        const out = normalizeKnownUrl(u, "pill");
        assert.match(out, /utm_source=clarice/, u);
        assert.match(out, /utm_campaign=clarice-2606-07-pill/, u);
      }
      // sufixo colado NÃO é subdomínio nosso
      assert.equal(normalizeKnownUrl("https://naodiar.ia.br/x"), "https://naodiar.ia.br/x");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  // Se o merge tag for percent-encodado, a Brevo não substitui e TODO voto do
  // É IA? sai com e-mail literal quebrado. O guard é o que segura o poll.
  it("URL com merge tag nunca é tocada, mesmo em host nosso", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const voto = "https://eia.diar.ia.br/vote?email={{ contact.EMAIL }}&edition=2606-07&choice=A&brand=clarice";
      assert.equal(normalizeKnownUrl(voto, "pill"), voto);
      assert.equal(normalizeKnownUrl("{{ unsubscribe }}"), "{{ unsubscribe }}");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  // Com o `pill` genérico as duas curadorias caíam no MESMO utm_campaign e eram
  // indistinguíveis — que é justamente o que se quer medir aqui.
  it("pills de curadoria têm posição por RÓTULO (cursos != livros)", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderEncerramento(
        [
          "Até o mês que vem.",
          "",
          "- [Cursos de IA](https://cursos.diar.ia.br)",
          "- [Livros sobre IA](https://livros.diar.ia.br)",
        ].join("\n"),
      );
      assert.match(html, /utm_campaign=clarice-2606-07-pill-cursos-de-ia/);
      assert.match(html, /utm_campaign=clarice-2606-07-pill-livros-sobre-ia/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });
  // Lacuna apontada na review da PR #4194: `renderEia` só era exercitado SEM
  // ciclo UTM setado, e nesse caso `withClariceUtm` retorna cedo — a URL nunca
  // ganhava `&`, então o `escHtml` em volta nunca era testado sobre uma string
  // com query param. Uma regressão que escapasse ANTES de montar a URL
  // (`&amp;amp;`) passaria pela suíte inteira.
  it("link do leaderboard: posição `leaderboard` + `&` escapado UMA vez só", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderEia("É IA? — DESTAQUE DO MÊS\n[placeholder]", "2606");
      const href = (html.match(/href="([^"]*leaderboard[^"]*)"/) ?? [])[1] ?? "";
      assert.ok(href, "link do leaderboard ausente");
      assert.match(href, /utm_campaign=clarice-2606-07-leaderboard/);
      assert.match(href, /brand=clarice/, "brand não pode se perder na re-montagem da URL");
      assert.match(href, /&amp;/, "separador de query tem que sair escapado no HTML");
      assert.doesNotMatch(href, /&amp;amp;/, "duplo-escape: escapou antes de montar a URL");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  // A 2606-07 tinha DOIS CTAs "aqui" — apresentação e encerramento — com href
  // IDÊNTICO. O linksStats da Brevo agrega por URL exata, então os cliques dos
  // dois chegavam somados. Mesma classe do que motivou o #4040 pros wordmarks.
  it("dois links inline em seções diferentes não colidem", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      setMonthlyUtmSecao("APRESENTAÇÃO");
      const apre = renderInline("cadastre-se [aqui](https://diar.ia.br).");
      setMonthlyUtmSecao("PARA ENCERRAR");
      const fim = renderInline("cadastre-se [aqui](https://diar.ia.br).");
      assert.match(apre, /utm_campaign=clarice-2606-07-inline-apresentacao/);
      assert.match(fim, /utm_campaign=clarice-2606-07-inline-para-encerrar/);
      assert.notEqual(campaigns(apre)[0], campaigns(fim)[0], "os dois \"aqui\" voltaram a colidir");
    } finally {
      setMonthlyUtmSecao(null);
      setMonthlyUtmCiclo(null);
    }
  });

  // Guard de ponta a ponta: nenhum href pode aparecer 2x na MESMA edicao.
  it("draftToEmail: nenhum href de marca se repete na edição", () => {
    const draft = [
      "**APRESENTAÇÃO**",
      "",
      "se cadastre gratuitamente [aqui](https://diar.ia.br).",
      "",
      "**PARA ENCERRAR**",
      "",
      "cadastre-se gratuitamente [aqui](https://diar.ia.br).",
    ].join("\n");
    const { html } = draftToEmail(draft, "Assunto", "2606");
    const hrefs = [...html.matchAll(/href="([^"]*diar\.ia\.br[^"]*)"/g)].map((m) => m[1]);
    assert.equal(
      new Set(hrefs).size,
      hrefs.length,
      `href de marca repetido na edição: ${hrefs.join(" | ")}`,
    );
  });

  it("normalizeKnownUrl não mexe em hosts de terceiros", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const out = normalizeKnownUrl("https://clarice.ai/?via=diaria");
      assert.equal(out, "https://clarice.ai/?via=diaria");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("normalizeKnownUrl é no-op de UTM sem ciclo setado (default)", () => {
    const out = normalizeKnownUrl("https://diar.ia.br");
    assert.equal(out, "https://diar.ia.br");
  });
});

describe("#4040 — utm_campaign distinto por POSIÇÃO do link", () => {
  it("renderCtaButton emite a posição `cta`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderCtaButton("→ [Assine grátis](https://diar.ia.br)");
      assert.match(html, /utm_campaign=clarice-2606-07-cta"/);
      assert.doesNotMatch(html, /utm_campaign=clarice-2606-07"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("renderInline (link markdown) emite a posição `inline`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderInline("cadastre-se [aqui](https://diar.ia.br).");
      assert.match(html, /utm_campaign=clarice-2606-07-inline-geral"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  // O CTA de seção não pode herdar `inline`: na 2606-07 o link raiz apareceu 7×
  // (4 wordmarks + 2 "aqui" + 1 botão) com o MESMO utm_campaign, e os cliques
  // chegaram somados, sem dar pra saber de onde vieram.
  it("CTA de seção do Use Melhor emite a posição da SEÇÃO, não `inline`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderLinkListSection(
        "**USE MELHOR**\n\n" +
          "Dicas como essas saem todos os dias na edição diária. Para receber, [cadastre-se gratuitamente](https://diar.ia.br/?utm_source=clarice).\n\n" +
          "[Tutorial](https://exemplo.com/t)\n\nO que ensina.",
        "Use Melhor", // título de exibição real em produção (#1919), sem "do Mês"
      );
      assert.match(html, /utm_campaign=clarice-2606-07-use-melhor"/);
      assert.doesNotMatch(html, /utm_campaign=clarice-2606-07-inline-geral/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("título de item de lista (Radar / Use Melhor) emite a posição `titulo`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderLinkListSection(
        "**RADAR**\n\n[Assine a diária](https://diar.ia.br)\n\nDescrição do item.",
        "Radar",
      );
      assert.match(html, /utm_campaign=clarice-2606-07-titulo"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("pill link do encerramento emite a posição `pill-{rótulo}`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderEncerramento("Até o mês que vem.\n\n- [Assine a diária](https://diar.ia.br)");
      assert.match(html, /utm_campaign=clarice-2606-07-pill-assine-a-diaria"/);
      // Nunca o slug flat: dois pills no mesmo e-mail seriam indistinguíveis.
      assert.doesNotMatch(html, /utm_campaign=clarice-2606-07-pill"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  // Decisão do editor 260727: o wordmark deixou de ser link na mensal. Aparecia
  // 4× por edição, todas pra raiz do site, e o editor conferiu que não
  // convertem — somadas ao "aqui" (2×) e ao botão davam 7 âncoras pro mesmo
  // destino. Isto reverte o #template-branding de 260703 e aposenta junto o
  // sufixo `wordmark-{seção}` do #4040, que existia só pra medir esse link.
  it("wordmark NÃO é link na mensal (nem com ciclo UTM ativo)", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderInline("a diar.ia.br publica todo dia");
      assert.doesNotMatch(html, /<a\s/, "wordmark voltou a ser clicável");
      assert.doesNotMatch(html, /utm_campaign=/, "wordmark sem link não pode emitir UTM");
      // O wordmark em si (pontos teal da marca) continua — é branding, não CTA.
      assert.match(html, /diar/, "o texto da marca sumiu junto com o link");
      assert.match(html, /#00A0A0|color:/, "estilo do wordmark perdido");
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("a mensal agora se comporta como a diária: applyBrandWordmark sem href", () => {
    // A diária nunca linkou o wordmark. Um `<a>` aqui significaria que alguém
    // voltou a passar o 2º argumento em renderTextInline.
    const html = renderInline("leia mais em diar.ia.br hoje");
    assert.doesNotMatch(html, /<a\s/);
  });

  it("draftToEmail: as 5 origens emitem campanhas DISTINTAS e nenhuma vira sendinblue", () => {
    const draft = [
      "**APRESENTAÇÃO**",
      "",
      "Esta é a Clarice News em parceria com diar.ia.br. Se quiser notícias de IA todos os dias, se cadastre gratuitamente [aqui](https://diar.ia.br).",
      "",
      "**DIVULGAÇÃO**",
      "",
      "Conheça a edição diária.",
      "",
      "→ [Assine grátis](https://diar.ia.br)",
      "",
      "**RADAR**",
      "",
      "[Assine a diária](https://diar.ia.br)",
      "",
      "Descrição do item do radar.",
      "",
      "**PARA ENCERRAR**",
      "",
      "Até o mês que vem, com a diar.ia.br.",
      "",
      "- [Assine a diária](https://diaria.beehiiv.com/?utm_source=clarice)",
    ].join("\n");

    const { html } = draftToEmail(draft, "Assunto de teste", "2606");
    const found = new Set(campaigns(html));

    // Nenhuma origem pode ficar no bucket achatado sem sufixo (bug pré-#4040).
    assert.ok(
      !found.has("clarice-2606-07"),
      `campanha sem sufixo de posição vazou: ${[...found].sort().join(", ")}`,
    );

    for (const esperada of [
      "clarice-2606-07-inline-apresentacao", // boilerplate APRESENTAÇÃO
      "clarice-2606-07-cta",    // botão CTA "→ [..](..)" do box de divulgação
      "clarice-2606-07-titulo", // título de item do Radar
    ]) {
      assert.ok(found.has(esperada), `faltou ${esperada}; achei: ${[...found].sort().join(", ")}`);
    }

    // Pill: pelo menos um, e SEMPRE por rótulo (nunca o slug flat) — cursos e
    // livros saem no mesmo encerramento e precisam ser distinguíveis.
    const pills = [...found].filter((c) => c.startsWith("clarice-2606-07-pill-"));
    assert.ok(pills.length >= 1, `nenhum pill por rótulo; achei: ${[...found].sort().join(", ")}`);
    assert.ok(!found.has("clarice-2606-07-pill"), "pill flat não deve mais existir");

    // Wordmark: NENHUM. Deixou de ser link em 260727 — se voltar a aparecer um
    // campaign `wordmark-*`, alguém re-linkou o wordmark sem querer.
    const wordmarks = [...found].filter((c) => c.includes("wordmark"));
    assert.equal(wordmarks.length, 0, `wordmark voltou a ser link: ${wordmarks.join(", ")}`);

    // #2975 + #4059: nada de sendinblue, nada de host antigo (o link legado do
    // encerramento foi normalizado).
    assert.doesNotMatch(html, /sendinblue/);
    assert.doesNotMatch(html, /diaria\.beehiiv\.com/);
  });

  it("título de destaque linkado emite a posição `titulo`", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      // `renderDestaque` é o caller real; o título linkado sai como
      // `## [Texto](url)` dentro do chunk.
      const html = renderInline("ver [Título](https://exemplo.com)");
      assert.ok(html.includes("exemplo.com")); // sanity do helper
      const titulo = normalizeKnownUrl("https://diar.ia.br", "titulo");
      assert.match(titulo, /utm_campaign=clarice-2606-07-titulo/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });

  it("draftToEmail reseta o ciclo após terminar (não vaza pra chamada seguinte)", () => {
    draftToEmail("**RADAR**\n\ntexto [aqui](https://diar.ia.br).", "Assunto", "2606");
    assert.equal(normalizeKnownUrl("https://diar.ia.br"), "https://diar.ia.br");
    setMonthlyUtmCiclo("2607-08");
    try {
      assert.match(normalizeKnownUrl("https://diar.ia.br"), /utm_campaign=clarice-2607-08-inline-geral/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
  });
});

describe("#4040 — helpers do registry compartilhado", () => {
  it("slugifySecao tira acento/pontuação e é estável", () => {
    assert.equal(slugifySecao("APRESENTAÇÃO"), "apresentacao");
    assert.equal(slugifySecao("USE MELHOR DO MÊS"), "use-melhor-do-mes");
    assert.equal(slugifySecao("É IA?"), "e-ia");
    assert.equal(slugifySecao(""), "geral");
    assert.equal(slugifySecao(null), "geral");
  });

  it("buildMensalCampaign compõe clarice-{ciclo}-{posicao}", () => {
    assert.equal(buildMensalCampaign("2606-07", "cta"), "clarice-2606-07-cta");
    assert.equal(buildMensalCampaign("2606-07", "wordmark-RADAR"), "clarice-2606-07-wordmark-radar");
  });
});
