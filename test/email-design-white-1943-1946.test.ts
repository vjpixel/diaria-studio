/**
 * test/email-design-white-1943-1946.test.ts
 *
 * Trava os ajustes de design do e-mail diário pedidos pelo editor:
 *   #1943 — fundo do e-mail BRANCO (era paper #FBFAF6)
 *   #1945 — sem faixas bege laterais (wrapper externo branco) + sem trilhos
 *           border-left/right no container + texto mais largo via padding
 *           lateral 48 → 32px (container fica em 600px, email-safe — Outlook
 *           corta acima disso, cf. checkWideTables)
 *   #1946 — crédito da Clarice no encerramento usa cupons NEWS25/NEWS50
 *           (era cupom DIARIA) + URL /precos-planos?via=diaria
 *
 * Overrides são EMAIL-ONLY: o token canônico --paper (#FBFAF6) segue em
 * design-tokens.ts pra web/mensal/É IA? (ver design-tokens.test.ts, que
 * checa o branco NÃO no diário). Os painéis de contraste (callouts/É IA?)
 * seguem bege #EBE5D0 — só o fundo/laterais ficaram brancos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHTML } from "../scripts/render-newsletter-html.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dailyFixture = {
  title: "Edição teste",
  subtitle: "Teste",
  coverImage: "04-d1-2x1.jpg",
  destaques: [
    {
      n: 1 as const,
      category: "RISCO",
      title: "Modelos se replicam sozinhos",
      body: "Parágrafo 1.\nParágrafo 2.",
      why: "Por que importa.",
      url: "https://example.com/d1",
      emoji: "⚠️",
      imageFile: "04-d1-2x1.jpg",
    },
  ],
  eia: { credit: "Foto: x.", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260999" },
  sections: [],
};

describe("e-mail diário — fundo branco + laterais sem bege + largura (#1943/#1945)", () => {
  const html = renderHTML(dailyFixture);

  it("#1943: container do corpo é BRANCO (#FFFFFF), não paper #FBFAF6", () => {
    assert.match(html, /class="container"[^>]*background:#FFFFFF;">/);
    assert.doesNotMatch(html, /class="container"[^>]*#FBFAF6/);
  });

  it("#1945/#260629: container responsivo (width 100% + max-width 600) + wrapper MSO, padding lateral 32px", () => {
    // #260629: base responsiva (preenche no mobile, cap 600 no desktop) —
    // não mais width:600px fixo (que ficava estreito/escalado no Gmail mobile
    // porque o Beehiiv remove a media query do htmlSnippet).
    assert.match(html, /class="container" width="100%"/);
    assert.match(html, /width:100%;max-width:600px/);
    // wrapper MSO embrulha em 600 SÓ no Outlook (ignora max-width).
    assert.match(html, /<!--\[if mso\]><table role="presentation" align="center" width="600"/);
    // texto mais largo vem do padding lateral reduzido (48 → 32px), não de
    // container > 600 (que o checkWideTables flaga / Outlook corta).
    assert.match(html, /class="pad" style="padding:[0-9]+px 32px/);
    assert.doesNotMatch(html, /class="pad" style="padding:[0-9]+px 48px/);
  });

  it("#1945: sem trilhos bege laterais (border-left/right) no container", () => {
    assert.doesNotMatch(html, /class="container"[^>]*border-left/);
    assert.doesNotMatch(html, /class="container"[^>]*border-right/);
  });

  it("#1945: wrapper externo é BRANCO — sem faixas bege ao redor", () => {
    assert.match(html, /style="background:#FFFFFF;"><tr><td align="center"/);
    assert.doesNotMatch(html, /style="background:#EBE5D0;"><tr><td align="center"/);
  });

  it("painéis de contraste seguem bege #EBE5D0 (É IA?/callouts preservados)", () => {
    // o É IA? do fixture é painel bege — confirma que NÃO zeramos o SURFACE dos boxes.
    assert.match(html, /background:#EBE5D0/);
  });

  it("box contorno 'Por que isso importa' mantém a borda bege (#1945: fora de escopo)", () => {
    assert.match(html, /border:1px solid #EBE5D0/);
  });

  it("documento completo (preview/Worker) também tem shell branco", () => {
    const full = renderHTML(dailyFixture, { fullDocument: true });
    assert.match(full, /<body style="margin:0; padding:0; background:#FFFFFF;">/);
    assert.doesNotMatch(full, /background:#EBE5D0;"><tr><td align="center"/);
  });

  it("#1952: fragmento (Beehiiv/Worker) seta body branco no <style> — sem canvas cinza", () => {
    // O fragmento (sem fullDocument) é o que o Worker hospeda E o que é colado
    // no Beehiiv. Sem <body> próprio, o preview dependia do default do browser e
    // o Beehiiv pintava o canvas cinza. A regra body{background:#FFFFFF} no
    // <style> compartilhado fixa o preview e — se o Beehiiv honrar o snippet —
    // sobrepõe o canvas.
    const frag = renderHTML(dailyFixture); // fullDocument: false (default)
    assert.match(frag, /body\s*\{[^}]*background:#FFFFFF;[^}]*\}/);
  });
});

describe("encerramento — crédito da Clarice usa NEWS25/NEWS50 (#1946)", () => {
  const sources = [
    "scripts/stitch-newsletter.ts",
    "context/templates/newsletter.md",
  ];

  for (const rel of sources) {
    const content = readFileSync(join(ROOT, rel), "utf8");
    it(`${rel}: usa cupons NEWS25 e NEWS50 + URL /precos-planos`, () => {
      assert.match(content, /ganhe descontos com os cupons NEWS25 e NEWS50/);
      assert.match(content, /https:\/\/clarice\.ai\/precos-planos\?via=diaria/);
    });
    it(`${rel}: não traz mais o cupom antigo DIARIA / "25% de desconto"`, () => {
      assert.doesNotMatch(content, /cupom DIARIA/);
      assert.doesNotMatch(content, /ganhe 25% de desconto com o cupom/);
    });
  }
});
