/**
 * test/email-dark-mode-13525.test.ts
 *
 * #13525 — a Clarice News mensal ficou ilegível no Mail do iOS em modo escuro:
 * o card escureceu e o texto continuou escuro. Causa no código: o e-mail
 * declara `color-scheme: light dark` mas o único CSS de dark mode era o do
 * canvas (`darkCanvasMediaRule`, #2645/#3104) — card, texto e boxes ficavam
 * sem regra nenhuma para o escuro.
 *
 * Regressão: o HTML emite regras de dark mode para o card e para o texto, não
 * só para o canvas, e cada elemento com cor inline do DS leva a classe que essas
 * regras miram. Vale para a mensal (Brevo Clarice), a mensal dos apoiadores
 * (Kit) e o documento completo da diária (Brevo diária + preview).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyDarkModeClasses,
  darkModeMediaRules,
  darkModeClassesForStyle,
  DARK_MODE_MAP,
  INK_ICON_CLASS,
} from "../scripts/lib/shared/email-dark-mode.ts";
import { draftToEmail } from "../scripts/lib/mensal/monthly-render.ts";
import { draftToEmailApoiadoresKit } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import { injectPendingIntro } from "../scripts/lib/brevo-diaria-intro.ts";
import type { NewsletterContent } from "../scripts/lib/newsletter-parse.ts";

const DIR = resolve(import.meta.dirname, "fixtures/retrospectiva-web-9872");
const DRAFT = readFileSync(resolve(DIR, "draft.md"), "utf8");
const IMGS = { 1: "https://img/d1.jpg", 2: "https://img/d2.jpg", 3: "https://img/d3.jpg" };

function mensal(): string {
  return draftToEmail(DRAFT, null, "2609", "https://img/a.jpg", "https://img/b.jpg", "Crédito.", IMGS, "Criada com ChatGPT", "https://img/livros.jpg").html;
}

/** Bloco `@media (prefers-color-scheme: dark)` que contém a regra da classe. */
function darkRuleFor(html: string, cls: string): string | null {
  for (const m of html.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n  \}/g)) {
    const rule = m[1].split("\n").find((l) => l.includes(`.${cls} {`));
    if (rule) return rule.trim();
  }
  return null;
}

/** Toda tag com `color:`/`background:` inline num hex do DS precisa da classe. */
function unmarkedInlineColors(html: string): string[] {
  const body = html.replace(/<head[\s\S]*?<\/head>/i, "");
  const misses: string[] = [];
  for (const m of body.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    if (/^(body)$/i.test(m[1])) continue;
    const attrs = m[2];
    if (/class="[^"]*ds-canvas/.test(attrs)) continue;
    const style = /style="([^"]*)"/.exec(attrs)?.[1] ?? "";
    for (const cls of darkModeClassesForStyle(style)) {
      if (!new RegExp(`class="[^"]*\\b${cls}\\b`).test(attrs)) misses.push(`${cls} em <${m[1]}${attrs.slice(0, 80)}>`);
    }
  }
  return misses;
}

describe("#13525 — applyDarkModeClasses", () => {
  it("marca texto, fundo e borda com a classe do papel e da cor", () => {
    const out = applyDarkModeClasses(`<td style="color:#171411;background:#FFFFFF;border:1px solid #EBE5D0;">x</td>`);
    assert.match(out, /class="dm-c-171411 dm-bg-ffffff dm-bd-ebe5d0"/);
  });

  it("aceita hex minúsculo, curto e espaço depois dos dois-pontos", () => {
    assert.deepEqual(darkModeClassesForStyle("color: #171411; background-color:#fff"), ["dm-c-171411", "dm-bg-ffffff"]);
  });

  it("junta com a classe que já existe e é idempotente", () => {
    const once = applyDarkModeClasses(`<p class="pad" style="color:#00A0A0">x</p>`);
    assert.equal(once, `<p class="pad dm-c-00a0a0" style="color:#00A0A0">x</p>`);
    assert.equal(applyDarkModeClasses(once), once);
  });

  it("não marca o body nem o canvas (.ds-canvas): a regra do canvas cuida deles", () => {
    const html = `<body style="background:#FFFFFF;"><table class="ds-canvas" style="background:#FFFFFF;"></table></body>`;
    assert.equal(applyDarkModeClasses(html), html);
  });

  it("cor fora do mapa fica sem classe (aparece com a cor original, nunca some)", () => {
    const html = `<span style="color:#123456">x</span>`;
    assert.equal(applyDarkModeClasses(html), html);
  });

  it("border-radius não é confundido com cor de borda", () => {
    assert.deepEqual(darkModeClassesForStyle("border-radius:12px;color:#171411"), ["dm-c-171411"]);
  });

  it("ícone de rede (PNG de tinta transparente) ganha a plaqueta clara", () => {
    const out = applyDarkModeClasses(`<img src="https://diar.ia.br/icons/social/x.png" width="28" style="display:block;border:0;">`);
    assert.match(out, new RegExp(`class="${INK_ICON_CLASS}"`));
  });
});

describe("#13525 — darkModeMediaRules", () => {
  const rules = darkModeMediaRules();

  it("card, texto e boxes têm regra dentro do prefers-color-scheme: dark", () => {
    const wrapped = `<style>\n  ${rules}\n</style>`;
    assert.match(darkRuleFor(wrapped, "dm-bg-ffffff") ?? "", /background-color:#211D19 !important/);
    assert.match(darkRuleFor(wrapped, "dm-c-171411") ?? "", /color:#EDE7DC !important/);
    assert.match(darkRuleFor(wrapped, "dm-bg-ebe5d0") ?? "", /background-color:#35302A !important/);
  });

  it("Outlook: [data-ogsc] para texto e [data-ogsb] para fundo", () => {
    assert.match(rules, /\[data-ogsc\] \.dm-c-171411 \{ color:#EDE7DC !important; \}/);
    assert.match(rules, /\[data-ogsb\] \.dm-bg-ffffff \{ background-color:#211D19 !important; \}/);
  });

  it("nenhum texto do mapa fica escuro sobre fundo escuro (contraste AA ≥ 4,5)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    // Fundos escuros de conteúdo (o 171411 mapeado vira claro, é o botão de tinta).
    const darkBgs = ["#171411", DARK_MODE_MAP.background["#FFFFFF"], DARK_MODE_MAP.background["#FBFAF6"], DARK_MODE_MAP.background["#EBE5D0"]];
    for (const fg of [DARK_MODE_MAP.color["#171411"], DARK_MODE_MAP.color["#00A0A0"]]) {
      for (const bg of darkBgs) assert.ok(ratio(fg, bg) >= 4.5, `${fg} sobre ${bg}: ${ratio(fg, bg).toFixed(2)}`);
    }
  });
});

describe("#13525 — mensal (Clarice/Brevo) ganha modo escuro no conteúdo", () => {
  const html = mensal();

  it("o <style> tem regra de dark mode para o card e para o texto, não só para o canvas", () => {
    assert.ok(darkRuleFor(html, "dm-bg-ffffff"), "sem regra escura para o card");
    assert.ok(darkRuleFor(html, "dm-c-171411"), "sem regra escura para o texto");
    assert.match(html, /body, \.ds-canvas \{ background:#171411 !important; \}/, "a regra do canvas continua");
  });

  it("o card (tabela de 600px) leva a classe de fundo escuro", () => {
    assert.match(html, /<table [^>]*width="600"[^>]*class="dm-bg-ffffff"/);
  });

  it("toda cor inline do DS no corpo carrega a classe que a regra escura mira", () => {
    assert.deepEqual(unmarkedInlineColors(html), []);
    assert.ok((html.match(/dm-c-171411/g) ?? []).length > 20, "esperado texto marcado ao longo do e-mail");
  });

  it("os ícones do convite social ganham a plaqueta clara", () => {
    if (/icons\/social\//.test(html)) assert.match(html, new RegExp(INK_ICON_CLASS));
  });
});

describe("#13525 — mensal dos apoiadores (Kit) herda o mesmo modo escuro", () => {
  it("regras e classes presentes", () => {
    const html = draftToEmailApoiadoresKit(DRAFT, null, "2609", "https://img/a.jpg", "https://img/b.jpg", "Crédito.", IMGS, "Criada com ChatGPT", "https://img/livros.jpg").html;
    assert.ok(darkRuleFor(html, "dm-c-171411"));
    assert.deepEqual(unmarkedInlineColors(html), []);
  });
});

const DAILY: NewsletterContent = {
  title: "Edição teste",
  subtitle: "Teste",
  coverImage: "04-d1-2x1.jpg",
  destaques: [
    {
      n: 1,
      category: "RISCO",
      title: "Modelos se replicam sozinhos",
      body: "Parágrafo 1.\nParágrafo 2.",
      why: "Por que importa.",
      url: "https://example.com/d1",
      emoji: "⚠️",
    },
  ],
  eia: { credit: "Foto: x.", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260999" },
  sections: [],
};

describe("#13525 — diária, documento completo (Brevo diária + preview)", () => {
  it("fullDocument: regras do conteúdo e cores marcadas", () => {
    const full = renderHTML(DAILY, { fullDocument: true });
    assert.ok(darkRuleFor(full, "dm-c-171411"), "sem regra escura para o texto");
    assert.ok(darkRuleFor(full, "dm-bg-ffffff"), "sem regra escura para o fundo do container");
    assert.deepEqual(unmarkedInlineColors(full), []);
  });

  it("fragmento (Kit/Beehiiv) fica como estava: sem classes nem regras de dark mode", () => {
    const frag = renderHTML(DAILY);
    assert.doesNotMatch(frag, /dm-(c|bg|bd)-/);
    assert.doesNotMatch(frag, /prefers-color-scheme/);
  });

  it("a intro injetada da Brevo diária também é marcada", () => {
    const full = renderHTML(DAILY, { fullDocument: true });
    const out = injectPendingIntro(full, `<table style="background:#FFFFFF;"><tr><td style="color:#171411;">Oi</td></tr></table>`);
    assert.match(out, /<table style="background:#FFFFFF;" class="dm-bg-ffffff">/);
    assert.match(out, /<td style="color:#171411;" class="dm-c-171411">Oi<\/td>/);
  });
});
