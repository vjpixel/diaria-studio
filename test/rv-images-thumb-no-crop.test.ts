/**
 * test/rv-images-thumb-no-crop.test.ts (#7261)
 *
 * `.rv-img-thumb` no painel Imagens da Revisão do Studio recebe arquivos em
 * proporções bem diferentes (2:1 destaque, 1:1 feed legado, 4:5 card de feed
 * com título / carrossel do Instagram). Antes do #7261, a regra fixava
 * `height: 110px` + `object-fit: cover`: qualquer imagem mais alta que larga
 * era escalada pela largura e tinha o excesso RECORTADO — um card 4:5
 * perdia ~45% da altura, cortado igualmente de topo e rodapé, exatamente
 * onde ficam o fim do parágrafo e o rodapé de marca. O painel é a superfície
 * onde o editor aprova o gate 4 (inclusive no celular); um card cortado é
 * conteúdo não revisado (ver #7253, quebra de parágrafo que ficava
 * escondida na metade de baixo do card cortado).
 *
 * Este teste trava que `.rv-img-thumb` nunca mais combine altura fixa com
 * `object-fit: cover` — a combinação que corta. `height: auto` +
 * `object-fit: contain` (a correção) preserva a proporção real do arquivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripCssComments } from "./helpers/css.ts";

const CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "studio-ui",
  "public",
  "rv-images.css",
);

/** Corpo da 1ª regra cujo(s) seletor(es) casam exatamente `.rv-img-thumb`. */
function corpoDoSeletor(css: string, seletorAlvo: string): string | null {
  const ANY_RULE = /([^{}]+)\{([^}]*)\}/g;
  for (const m of css.matchAll(ANY_RULE)) {
    const seletores = m[1].split(",").map((s) => s.trim());
    if (seletores.includes(seletorAlvo)) return m[2];
  }
  return null;
}

function declaracao(corpo: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(corpo);
  return m ? m[1].trim() : null;
}

describe(".rv-img-thumb nunca corta imagem em proporção não-16:11 (#7261)", () => {
  const css = stripCssComments(readFileSync(CSS_PATH, "utf8"));
  const corpo = corpoDoSeletor(css, ".rv-img-thumb");

  it("a regra existe (guarda contra o teste virar no-op)", () => {
    assert.ok(corpo, ".rv-img-thumb não encontrado em rv-images.css — o seletor mudou de nome?");
  });

  it("object-fit não é 'cover' com height fixa — a combinação que recorta", () => {
    const objectFit = declaracao(corpo!, "object-fit");
    const height = declaracao(corpo!, "height");
    const alturaFixa = !!height && height !== "auto";

    assert.ok(
      objectFit !== "cover" || !alturaFixa,
      `object-fit: ${objectFit} com height: ${height} recorta qualquer imagem mais alta que ` +
        `larga (ex: card 4:5 numa caixa 16:11) — foi exatamente o defeito da #7261. Use ` +
        `height: auto (ou object-fit: contain).`,
    );
  });

  it("object-fit: contain preserva a proporção real do arquivo (correção do #7261)", () => {
    assert.equal(declaracao(corpo!, "object-fit"), "contain");
    assert.equal(declaracao(corpo!, "height"), "auto");
  });
});
