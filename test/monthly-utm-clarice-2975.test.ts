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
 *   - wordmark automático (`applyBrandWordmark` via `renderTextInline`) —
 *     granularidade POR SEÇÃO (`wordmark-apresentacao`, `wordmark-radar`, …),
 *     decisão do editor 260726;
 *   - link markdown inline (`renderInline`)     → `inline`
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
      assert.match(out, /utm_campaign=clarice-2606-07-inline/);
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
      assert.match(out, /utm_campaign=clarice-2606-07-inline/);
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
      assert.match(html, /utm_campaign=clarice-2606-07-inline"/);
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
      assert.doesNotMatch(html, /utm_campaign=clarice-2606-07-inline/);
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

  it("wordmark carrega a SEÇÃO corrente no sufixo (granularidade decidida pelo editor 260726)", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      setMonthlyUtmSecao("APRESENTAÇÃO");
      const apre = renderInline("a diar.ia.br publica todo dia");
      assert.match(apre, /utm_campaign=clarice-2606-07-wordmark-apresentacao"/);

      setMonthlyUtmSecao("RADAR");
      const radar = renderInline("a diar.ia.br publica todo dia");
      assert.match(radar, /utm_campaign=clarice-2606-07-wordmark-radar"/);

      // Os dois wordmarks NÃO podem colidir — é justamente o ponto do #4040.
      assert.notEqual(campaigns(apre)[0], campaigns(radar)[0]);
    } finally {
      setMonthlyUtmSecao(null);
      setMonthlyUtmCiclo(null);
    }
  });

  it("sem seção setada o wordmark cai em `wordmark-geral` (nunca campaign quebrado)", () => {
    setMonthlyUtmCiclo("2606-07");
    try {
      const html = renderInline("a diar.ia.br publica todo dia");
      assert.match(html, /utm_campaign=clarice-2606-07-wordmark-geral"/);
    } finally {
      setMonthlyUtmCiclo(null);
    }
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
      "clarice-2606-07-inline", // boilerplate APRESENTAÇÃO
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

    // Wordmark: pelo menos um, e SEMPRE por seção (nunca o slug flat).
    const wordmarks = [...found].filter((c) => c.startsWith("clarice-2606-07-wordmark-"));
    assert.ok(wordmarks.length >= 1, `nenhum wordmark por seção; achei: ${[...found].sort().join(", ")}`);
    assert.ok(!found.has("clarice-2606-07-wordmark"), "wordmark caiu no slug flat (regressão do #4040)");

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

  it("draftToEmail reseta ciclo E seção após terminar (não vazam pra chamada seguinte)", () => {
    draftToEmail("**RADAR**\n\ntexto [aqui](https://diar.ia.br).", "Assunto", "2606");
    assert.equal(normalizeKnownUrl("https://diar.ia.br"), "https://diar.ia.br");
    setMonthlyUtmCiclo("2607-08");
    try {
      // Se a seção "RADAR" tivesse vazado, sairia `wordmark-radar`.
      assert.match(renderInline("a diar.ia.br"), /utm_campaign=clarice-2607-08-wordmark-geral"/);
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
