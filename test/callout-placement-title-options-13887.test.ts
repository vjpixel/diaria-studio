/**
 * #13887 — edição 261124 (§4d.1b): depois de promover um item a D1, o
 * `02-reviewed.md` ficou com as 3 opções de título do `writer-destaque`, uma
 * sob a outra. `orphan-box-in-gap` apontava as opções 2 e 3 como "callout
 * colado dentro de seção de destaque" e mandava o editor procurar uma caixa.
 * Agora elas saem em `titleOptions`, com a dica de podar para 1 título.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintCalloutPlacement, formatTitleOptionErrors } from "../scripts/lib/lint-checks/callout-placement.ts";

const URL = "https://example.com/d1";

function md(d1Titles: string[], extraD1Para = ""): string {
  return [
    "Para esta edição, selecionamos 15 itens.",
    "",
    "---",
    "",
    "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
    "",
    ...d1Titles.flatMap((t) => [t, ""]),
    ...(extraD1Para ? [extraD1Para, ""] : []),
    "Corpo do destaque 1, com fatos.",
    "",
    "Por que isso importa:",
    "",
    "Algo importante.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | 🚀 LANÇAMENTO**",
    "",
    "**[Título D2](https://example.com/d2)**",
    "",
    "Corpo do destaque 2.",
    "",
  ].join("\n");
}

const THREE_OPTIONS = [`**[Opção um do D1](${URL})**`, `**[Opção dois do D1](${URL})**`, `**[Opção três do D1](${URL})**`];

describe("#13887 — opções de título do writer não são callout colado", () => {
  it("bloco de 3 opções: 2 opções extras, nenhum callout", () => {
    const r = lintCalloutPlacement(md(THREE_OPTIONS));
    assert.equal(r.ok, false, "o gate segue barrando: o Stage 4 exige 1 título");
    assert.deepEqual(r.matches, [], "nenhuma opção vira 'callout colado'");
    assert.equal(r.titleOptions.length, 2);
    assert.deepEqual(
      r.titleOptions.map((t) => t.destaque),
      [1, 1],
    );
    assert.match(r.titleOptions[0].context, /Opção dois/);
    assert.match(r.titleOptions[0].hint, /podar para 1 título/);
  });

  it("mensagem do CLI fala em podar título, não em caixa", () => {
    const text = formatTitleOptionErrors(lintCalloutPlacement(md(THREE_OPTIONS)).titleOptions).join("\n");
    assert.match(text, /opção\(ões\) extra\(s\) de título/);
    assert.match(text, /podar para 1 título/);
    assert.doesNotMatch(text, /colado DENTRO/);
  });

  it("1 título só: ok", () => {
    const r = lintCalloutPlacement(md([THREE_OPTIONS[0]]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.titleOptions, []);
  });

  it("bold-link com OUTRA url logo depois do título continua sendo callout colado", () => {
    const r = lintCalloutPlacement(md([THREE_OPTIONS[0]], "**[Apoie a diar.ia.br](https://apoia.se/diaria)**"));
    assert.equal(r.titleOptions.length, 0);
    assert.equal(r.matches.length, 1);
  });

  it("bold-link com a mesma url depois do corpo não é opção de título", () => {
    const text = md([THREE_OPTIONS[0]]).replace(
      "Corpo do destaque 1, com fatos.",
      `Corpo do destaque 1, com fatos.\n\n**[Opção dois do D1](${URL})**`,
    );
    const r = lintCalloutPlacement(text);
    assert.equal(r.titleOptions.length, 0);
    assert.equal(r.matches.length, 1, "fora da posição de título segue como callout");
  });
});
