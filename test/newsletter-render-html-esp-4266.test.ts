/**
 * test/newsletter-render-html-esp-4266.test.ts (#4266)
 *
 * Cobre a merge tag do link de voto do É IA? por ESP de destino: Beehiiv usa
 * o e-mail CRU `{{email}}` (#4581 reverteu o token opaco do #4487 neste ramo —
 * o É IA? não dá prêmio, então votar no lugar de outra pessoa não causa dano,
 * e o token cobrava um custo operacional real: dependia de um custom field
 * populado por assinante que nunca rodou ao vivo); Brevo segue com o token via
 * `{{ contact.POLL_TOKEN }}@vote.eia.diaria.local` (#4517 — era
 * `{{ contact.EMAIL }}` cru até então, paridade com o #4487) com `&`
 * escapado como `&amp;` (mesma sintaxe de merge tag Brevo já usada pelo
 * mensal em `lib/mensal/monthly-render.ts`, que segue com `{{ contact.EMAIL }}`
 * cru por estar fora do escopo do #4487/#4517). Sem `esp`/`esp: "beehiiv"`
 * o comportamento é idêntico entre si — regressão coberta abaixo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderEIA, renderHTML, renderEiaStandalone, type EIA } from "../scripts/lib/newsletter-render-html.ts";

const baseEia: EIA = {
  credit: "Foto: Author / CC BY-SA 4.0.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
};

describe("renderEIA(eia, esp) — #4266", () => {
  it("sem esp (default): merge tag Beehiiv com e-mail cru {{email}}, & cru (#4581)", () => {
    const html = renderEIA(baseEia);
    assert.match(html, /email=\{\{email\}\}&edition=260999&choice=A/);
    assert.match(html, /email=\{\{email\}\}&edition=260999&choice=B/);
    assert.ok(
      !html.includes("{{poll_token}}"),
      "token opaco não deve mais aparecer no ramo Beehiiv (#4581 reverteu o #4487)",
    );
    assert.ok(
      !html.includes("@vote.eia.diaria.local"),
      "sem o token, o domínio do pseudo-e-mail não pode sobrar — produziria fulano@x.com@vote.eia.diaria.local",
    );
    assert.ok(!html.includes("{{ contact.EMAIL }}"), "não deve conter merge tag Brevo");
  });

  it('esp: "beehiiv" explícito — idêntico ao default (regressão byte-a-byte)', () => {
    assert.equal(renderEIA(baseEia), renderEIA(baseEia, "beehiiv"));
  });

  it('esp: "brevo" — merge tag {{ contact.POLL_TOKEN }}@vote.eia.diaria.local (token opaco, #4517), & escapado como &amp;', () => {
    const html = renderEIA(baseEia, "brevo");
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}@vote\.eia\.diaria\.local/);
    assert.match(html, /&amp;edition=260999&amp;choice=A/);
    assert.match(html, /&amp;edition=260999&amp;choice=B/);
    assert.ok(!html.includes("{{email}}"), "não deve conter merge tag Beehiiv");
    assert.ok(!html.includes("{{ contact.EMAIL }}"), "e-mail cru não deve mais aparecer na URL de voto (#4517)");
    assert.ok(!html.includes("&edition=260999&choice="), "& não pode aparecer cru (sem escape) na variante Brevo");
  });

  it('esp: "brevo" — resto do painel (crédito, imagens, leaderboard) inalterado', () => {
    const beehiivHtml = renderEIA(baseEia);
    const brevoHtml = renderEIA(baseEia, "brevo");
    assert.match(brevoHtml, /Foto: Author/);
    assert.match(brevoHtml, /\{\{IMG:01-eia-A\.jpg\}\}/);
    assert.match(brevoHtml, /\{\{IMG:01-eia-B\.jpg\}\}/);
    assert.match(brevoHtml, /\/leaderboard"/);
    // Mesmo tamanho de diferença esperado: só a URL de voto muda.
    assert.notEqual(beehiivHtml, brevoHtml);
  });
});

describe("renderHTML(content, { esp }) — threading pelos 3 call sites internos (#4266)", () => {
  const baseDestaque = {
    n: 1 as const,
    category: "RISCO",
    title: "Modelos se replicam sozinhos",
    body: "Parágrafo 1.\nParágrafo 2.",
    why: "Por que importa.",
    url: "https://example.com/d1",
    emoji: "⚠️",
    imageFile: "04-d1-2x1.jpg",
  };
  const fixtureComEia = {
    title: "Edição teste",
    subtitle: "Teste com È IA?",
    coverImage: "04-d1-2x1.jpg",
    destaques: [baseDestaque],
    eia: {
      credit: "Foto: Author / CC BY-SA 4.0.",
      imageA: "01-eia-A.jpg",
      imageB: "01-eia-B.jpg",
      edition: "260999",
    },
    sections: [],
  };

  it("sem opts.esp: merge tag Beehiiv com e-mail cru (#4581)", () => {
    const html = renderHTML(fixtureComEia);
    assert.match(html, /email=\{\{email\}\}&edition=/);
    assert.ok(!html.includes("{{poll_token}}"), "#4581: token opaco saiu do ramo Beehiiv");
    assert.ok(!html.includes("{{ contact.EMAIL }}"));
  });

  it('opts.esp: "brevo": merge tag Brevo (token opaco, #4517) no HTML completo', () => {
    const html = renderHTML(fixtureComEia, { esp: "brevo" });
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}@vote\.eia\.diaria\.local/);
    assert.ok(!html.includes("{{email}}"), "não deve sobrar merge tag Beehiiv");
    assert.ok(!html.includes("{{ contact.EMAIL }}"), "e-mail cru não deve mais aparecer (#4517)");
    // Regressão: resto do corpo (destaque) intacto.
    assert.match(html, /Modelos se replicam/);
  });

  it('opts.esp: "brevo" + fullDocument: true — combinação que `publish-daily-brevo.ts` (#4266 item 2, #4517) consome', () => {
    const html = renderHTML(fixtureComEia, { esp: "brevo", fullDocument: true });
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}@vote\.eia\.diaria\.local/);
  });

  it("USE MELHOR presente: É IA? renderiza DEPOIS da seção — esp ainda propaga nesse ramo", () => {
    const fixtureComUseMelhor = {
      ...fixtureComEia,
      sections: [
        {
          name: "USE MELHOR",
          emoji: "🛠️",
          items: [{ title: "X", description: "Descrição X.", url: "https://example.com/x" }],
        },
      ],
    };
    const html = renderHTML(fixtureComUseMelhor, { esp: "brevo" });
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}@vote\.eia\.diaria\.local/);
    const useMelhorIdx = html.indexOf("USE MELHOR");
    const eiaIdx = html.indexOf("{{ contact.POLL_TOKEN }}");
    assert.ok(useMelhorIdx > -1 && eiaIdx > useMelhorIdx, "É IA? deve vir depois de USE MELHOR");
  });

  it("renderEiaStandalone permanece sempre Beehiiv — sem parâmetro esp (paste híbrido é Beehiiv-only)", () => {
    const html = renderEiaStandalone(fixtureComEia);
    assert.ok(html);
    assert.match(html!, /email=\{\{email\}\}&edition=/);
    assert.ok(!html!.includes("{{poll_token}}"), "#4581: token opaco saiu do ramo Beehiiv");
    assert.ok(!html!.includes("{{ contact.EMAIL }}"));
  });
});
