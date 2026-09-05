import { test } from "node:test";
import * as assert from "node:assert";
import {
  stripDuplicateHeroImage,
  findHeroLayout,
  removeHero,
  srcOf,
} from "../scripts/lib/strip-duplicate-hero.ts";

const ID_A = "6d1c1f0e-e9a7-4421-ab47-8ea1001a2ccf";
const ID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const img = (id: string, style = 'style="margin:0 auto;"') =>
  `<img ${style} src="https://media.beehiiv.com/cdn-cgi/image/fit=scale-down/uploads/asset/file/${id}/x.png?t=1">`;

/** Página com a estrutura real do acervo importado. */
const page = (opts: { heroId?: string; bodyId?: string; wrapper?: boolean } = {}) => {
  const { heroId = ID_A, bodyId = ID_A, wrapper = true } = opts;
  const hero = heroId
    ? wrapper
      ? `<div style='padding-bottom:2rem;'>${img(heroId)}</div>`
      : `<section>${img(heroId)}</section>`
    : "";
  return (
    `<html><body><div class="header"><a href="/">logo</a></div>${hero}` +
    `<div id='content-blocks'><h1>Titulo</h1>${bodyId ? img(bodyId) : ""}<p>texto</p></div></body></html>`
  );
};

test("remove o hero duplicado junto com seu wrapper", () => {
  const r = stripDuplicateHeroImage(page());
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.assetId, ID_A);
  assert.equal(r.removedWrapper, true);
  // sobrou exatamente UMA ocorrência do asset — a do corpo
  assert.equal(r.html.split(ID_A).length - 1, 1);
  // e a que sobrou está DENTRO de content-blocks
  assert.ok(r.html.indexOf(ID_A) > r.html.indexOf("id='content-blocks'"));
  assert.ok(!r.html.includes("padding-bottom:2rem"), "wrapper vazio não pode sobrar");
});

test("NÃO remove imagem do topo que não se repete no corpo", () => {
  const r = stripDuplicateHeroImage(page({ heroId: ID_A, bodyId: ID_B }));
  assert.equal(r.changed, false);
  if (r.changed) return;
  assert.match(r.reason, /nao e duplicata/);
  // ambas as imagens preservadas
  assert.ok(r.html.includes(ID_A) && r.html.includes(ID_B));
});

test("é idempotente — segunda passada não muda nada", () => {
  const first = stripDuplicateHeroImage(page());
  assert.equal(first.changed, true);
  if (!first.changed) return;
  const second = stripDuplicateHeroImage(first.html);
  assert.equal(second.changed, false, "página já corrigida não pode ser alterada de novo");
  assert.equal(second.html, first.html);
});

test("nunca toca na imagem do corpo", () => {
  const original = page();
  const r = stripDuplicateHeroImage(original);
  assert.equal(r.changed, true);
  if (!r.changed) return;
  const bodyImg = img(ID_A);
  assert.ok(r.html.includes(bodyImg), "a <img> do corpo deve sobreviver intacta");
  // o conteúdo depois do marcador não pode ter mudado
  const cut = (h: string) => h.slice(h.indexOf("id='content-blocks'"));
  assert.equal(cut(r.html), cut(original));
});

test("sem marcador content-blocks, não age", () => {
  const r = stripDuplicateHeroImage(`<html>${img(ID_A)}${img(ID_A)}</html>`);
  assert.equal(r.changed, false);
  if (r.changed) return;
  assert.match(r.reason, /sem marcador/);
});

test("mais de uma imagem antes do marcador é estrutura inesperada — não age", () => {
  const html =
    `<div>${img(ID_A)}${img(ID_B)}</div><div id='content-blocks'>${img(ID_A)}</div>`;
  const r = stripDuplicateHeroImage(html);
  assert.equal(r.changed, false);
  if (r.changed) return;
  assert.match(r.reason, /estrutura inesperada/);
  assert.equal(r.html, html);
});

test("página sem imagem alguma antes do marcador", () => {
  const r = stripDuplicateHeroImage(`<div id='content-blocks'>${img(ID_A)}</div>`);
  assert.equal(r.changed, false);
  if (r.changed) return;
  assert.match(r.reason, /nenhuma <img>/);
});

test("wrapper diferente do esperado: remove só a tag, sinaliza", () => {
  const r = stripDuplicateHeroImage(page({ wrapper: false }));
  assert.equal(r.changed, true);
  if (!r.changed) return;
  assert.equal(r.removedWrapper, false, "sinaliza que o wrapper não foi reconhecido");
  assert.equal(r.html.split(ID_A).length - 1, 1);
  assert.ok(r.html.includes("<section></section>"), "o container alheio fica intacto");
});

test("logo/ícones sem asset id não confundem a detecção", () => {
  const html =
    `<div><img src="/static/logo.svg"></div><div style='padding-bottom:2rem;'>${img(ID_A)}</div>` +
    `<div id='content-blocks'>${img(ID_A)}</div>`;
  const r = stripDuplicateHeroImage(html);
  assert.equal(r.changed, true, "<img> sem asset id deve ser ignorada na contagem");
  if (!r.changed) return;
  assert.ok(r.html.includes("/static/logo.svg"), "a logo não pode ser removida");
});

// ------------------------------------------------- detecção por conteúdo
//
// A comparação por asset id não basta: o mesmo arquivo reenviado ao Beehiiv
// ganha id novo. `findHeroLayout` + `removeHero` existem para que o chamador
// possa decidir por HASH do conteúdo (I/O fica fora da função pura).

test("findHeroLayout: devolve o hero e os srcs do corpo", () => {
  const l = findHeroLayout(page({ heroId: ID_A, bodyId: ID_B }));
  assert.ok(l);
  assert.match(l!.heroTag, new RegExp(ID_A));
  assert.equal(l!.bodySrcs.length, 1);
  assert.match(l!.bodySrcs[0], new RegExp(ID_B), "src do corpo, não o do hero");
});

test("findHeroLayout: null sem marcador, ou com nº de imagens inesperado", () => {
  assert.equal(findHeroLayout(`<html>${img(ID_A)}</html>`), null, "sem marcador");
  assert.equal(
    findHeroLayout(`<div>${img(ID_A)}${img(ID_B)}</div><div id='content-blocks'></div>`),
    null,
    "2 imagens antes do marcador",
  );
  assert.equal(
    findHeroLayout(`<div id='content-blocks'>${img(ID_A)}</div>`),
    null,
    "nenhuma imagem antes do marcador",
  );
});

test("findHeroLayout: enxerga TODAS as imagens do corpo, não só a primeira", () => {
  const html =
    `<div style='padding-bottom:2rem;'>${img(ID_A)}</div><div id='content-blocks'>` +
    `${img(ID_B)}<p>x</p>${img(ID_A)}</div>`;
  const l = findHeroLayout(html);
  assert.equal(l!.bodySrcs.length, 2, "a cópia pode estar numa imagem posterior");
});

test("removeHero: leva o wrapper quando ele envolve só a imagem", () => {
  const html = page({ heroId: ID_A, bodyId: ID_B });
  const l = findHeroLayout(html)!;
  const out = removeHero(html, l);
  assert.equal(out.removedWrapper, true);
  assert.ok(!out.html.includes("padding-bottom:2rem"));
  assert.ok(!out.html.includes(ID_A), "hero saiu");
  assert.ok(out.html.includes(ID_B), "corpo intacto");
});

test("removeHero: com wrapper atípico, remove só a tag e sinaliza", () => {
  const html = page({ heroId: ID_A, bodyId: ID_B, wrapper: false });
  const out = removeHero(html, findHeroLayout(html)!);
  assert.equal(out.removedWrapper, false);
  assert.ok(out.html.includes("<section></section>"), "container alheio fica");
  assert.ok(out.html.includes(ID_B));
});

test("removeHero não decide nada — remove mesmo se o corpo tiver outra imagem", () => {
  // É o chamador que decide (por hash). Esta função só executa o recorte.
  const html = page({ heroId: ID_A, bodyId: ID_B });
  const out = removeHero(html, findHeroLayout(html)!);
  assert.ok(!out.html.includes(ID_A));
});

test("srcOf extrai o src da tag", () => {
  assert.match(srcOf(img(ID_A))!, /^https:\/\/media\.beehiiv\.com\//);
  assert.equal(srcOf("<img>"), null);
});
