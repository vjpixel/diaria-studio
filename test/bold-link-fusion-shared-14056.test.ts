/**
 * #14056: a decisão de fusão de negrito com link (`**[label](url)**`) mora
 * em `scripts/lib/shared/markdown-primitives.ts` (`decideBoldLinkFusion` +
 * `nextValidLinkStart`) e os dois renderers (diária `tokenizeInline`, mensal
 * `renderInline`) só a chamam. Teste de caracterização: a matriz abaixo foi
 * gravada com as cópias antigas (antes da extração) e comparada byte a byte
 * com a saída nova, junto das linhas de 4 edições diárias e 2 mensais reais.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideBoldLinkFusion, nextValidLinkStart } from "../scripts/lib/shared/markdown-primitives.ts";
import { processInlineLinks } from "../scripts/lib/newsletter-render-html.ts";
import { renderInline } from "../scripts/lib/mensal/monthly-render.ts";

/** Tira os atributos de estilo de cada superfície para comparar só a estrutura. */
const bare = (html: string) => html.replace(/ (style|target|rel)="[^"]*"/g, "");

// [entrada, saída da diária, saída da mensal] (estrutura, sem estilo) —
// gravadas com as implementações anteriores ao #14056.
const MATRIX: Array<[string, string, string]> = [
  ["", "", ""],
  ["texto sem link", "texto sem link", "texto sem link"],
  ["**[a](https://x.com)**", '<strong><a href="https://x.com">a</a></strong>', '<strong><a href="https://x.com">a</a></strong>'],
  ["[**a**](https://x.com)", '<a href="https://x.com"><strong>a</strong></a>', '<a href="https://x.com"><strong>a</strong></a>'],
  // #3302: só a diária omite o wrap externo quando o label já é todo negrito
  // (`isLabelFullyBold`, fora da decisão compartilhada, de propósito).
  ["**[**a**](https://x.com)**", '<a href="https://x.com"><strong>a</strong></a>', '<strong><a href="https://x.com"><strong>a</strong></a></strong>'],
  [
    "**[a](https://x.com)** e **[b](https://y.com)**",
    '<strong><a href="https://x.com">a</a></strong> e <strong><a href="https://y.com">b</a></strong>',
    '<strong><a href="https://x.com">a</a></strong> e <strong><a href="https://y.com">b</a></strong>',
  ],
  [
    "**[a](https://x.com)****[b](https://y.com)**",
    '<strong><a href="https://x.com">a</a></strong><strong><a href="https://y.com">b</a></strong>',
    '<strong><a href="https://x.com">a</a></strong><strong><a href="https://y.com">b</a></strong>',
  ],
  [
    "**Atenção:**[a](https://x.com)**hoje** foi",
    '<strong>Atenção:</strong><a href="https://x.com">a</a><strong>hoje</strong> foi',
    '<strong>Atenção:</strong><a href="https://x.com">a</a><strong>hoje</strong> foi',
  ],
  ["**[a](https://x.com)", '**<a href="https://x.com">a</a>', '**<a href="https://x.com">a</a>'],
  ["[a](https://x.com)**", '<a href="https://x.com">a</a>**', '<a href="https://x.com">a</a>**'],
  [
    "**x **[a](https://x.com)** y**",
    '<strong>x </strong><a href="https://x.com">a</a><strong> y</strong>',
    '<strong>x </strong><a href="https://x.com">a</a><strong> y</strong>',
  ],
  [
    "**[a](https://x.com)** **word** **[b](https://y.com)**",
    '<strong><a href="https://x.com">a</a></strong> <strong>word</strong> <strong><a href="https://y.com">b</a></strong>',
    '<strong><a href="https://x.com">a</a></strong> <strong>word</strong> <strong><a href="https://y.com">b</a></strong>',
  ],
  ["**[a](https://x.com/(1).pdf)**", '<strong><a href="https://x.com/(1).pdf">a</a></strong>', '<strong><a href="https://x.com/(1).pdf">a</a></strong>'],
  ["[a]()", "[a]()", "[a]()"],
  ["**[a]()**", "<strong>[a]()</strong>", "<strong>[a]()</strong>"],
  [
    "pre **[a](u)** meio [b](v) **[c](w)** fim",
    'pre <strong><a href="u">a</a></strong> meio <a href="v">b</a> <strong><a href="w">c</a></strong> fim',
    'pre <strong><a href="u">a</a></strong> meio <a href="v">b</a> <strong><a href="w">c</a></strong> fim',
  ],
  ["***[a](https://x.com)***", '*<strong><a href="https://x.com">a</a></strong>*', '*<strong><a href="https://x.com">a</a></strong>*'],
  ["****[a](https://x.com)****", '****<a href="https://x.com">a</a>****', '****<a href="https://x.com">a</a>****'],
  // Divergência acidental preservada (`trimUrl`): destino só de espaços conta
  // como boundary na mensal e não na diária.
  [
    "**[a](https://x.com)**x**[b](  )**z**",
    '**<a href="https://x.com">a</a><strong>x</strong><a href="  ">b</a><strong>z</strong>',
    '<strong><a href="https://x.com">a</a></strong>x**<a href="  ">b</a><strong>z</strong>',
  ],
];

for (const [input, daily, monthly] of MATRIX) {
  test(`#14056 caracterização: ${JSON.stringify(input)}`, () => {
    assert.equal(bare(processInlineLinks(input)), daily, "diária");
    assert.equal(bare(renderInline(input, "p")), monthly, "mensal");
  });
}

test("#14056 nextValidLinkStart: pula link sem fechamento e destino vazio", () => {
  assert.equal(nextValidLinkStart("x [a]( sem fim", 0), "x [a]( sem fim".length);
  assert.equal(nextValidLinkStart("[a]() [b](u)", 0), 6);
  assert.equal(nextValidLinkStart("[a](u) [b](v)", 1), 7);
  assert.equal(nextValidLinkStart("", 0), 0);
});

test("#14056 nextValidLinkStart: trimUrl decide se destino só de espaços é boundary", () => {
  assert.equal(nextValidLinkStart("[a]( ) [b](u)", 0, false), 0);
  assert.equal(nextValidLinkStart("[a]( ) [b](u)", 0, true), 7);
});

test("#14056 decideBoldLinkFusion: funde e consome os dois `**`", () => {
  const s = "x **[a](u)** y";
  const close = s.indexOf(")");
  assert.deepEqual(decideBoldLinkFusion(s, 0, s.indexOf("["), close), {
    fuse: true,
    textBefore: "x ",
    resumeAt: close + 3,
  });
});

test("#14056 decideBoldLinkFusion: `**` auto-pareado ao lado não funde (#3280)", () => {
  const s = "**Atenção:**[a](u)**hoje**";
  const close = s.indexOf(")");
  assert.deepEqual(decideBoldLinkFusion(s, 0, s.indexOf("["), close), {
    fuse: false,
    textBefore: "**Atenção:**",
    resumeAt: close + 1,
  });
});

test("#14056 decideBoldLinkFusion: só um lado com `**` não funde", () => {
  const s = "**[a](u) fim";
  assert.equal(decideBoldLinkFusion(s, 0, 2, s.indexOf(")")).fuse, false);
  const t = "[a](u)** fim";
  assert.equal(decideBoldLinkFusion(t, 0, 0, t.indexOf(")")).fuse, false);
});

test("#14056 os dois renderers usam a decisão compartilhada, sem cópia local", () => {
  for (const f of ["scripts/lib/newsletter-render-html.ts", "scripts/lib/mensal/monthly-render.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /decideBoldLinkFusion\(input, lastIdx, m\.index, j/, f);
    assert.doesNotMatch(src, /function nextLinkStartIndex/, f);
    assert.doesNotMatch(src, /hasCloseBold/, f);
  }
});
