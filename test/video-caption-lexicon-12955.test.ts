/**
 * #12955: no `srt --from-final --no-plan` (#12429), o léxico dos nomes próprios
 * do 02-reviewed.md trocava palavra comum por nome. Os dois casos reais do
 * backfill:
 *   - 261022: "Negócio em dIA" no texto → "notícia do dia" saiu "notícia do dIA";
 *   - 261029: `Lula disse …: "Eu quero criar uma brasileira".` → "nesse canal eu
 *     comento" saiu "nesse canal Eu comento" (6x no vídeo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";
import { applyProperNounLexicon, properNounLexicon, summarizeLexiconChanges } from "../scripts/lib/diaria/video-caption-lexicon.ts";

const say = (text: string, t0 = 0, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));
const texts = (ws: Word[]) => ws.map((w) => w.text).join(" ");

// Trechos reais do 02-reviewed.md das duas edições.
const R261022 =
  "O Gogle lançou um painel no Gemini que reúne finanças, clientes e marca de pequenos negócios e transforma planilhas e recibos em dashboards. " +
  "Junto, Google, Tera, Itaú e Sebrae lançaram o Negócio em dIA, programa gratuito para capacitar até um milhão de empreendedores brasileiros.";
const R261029 =
  "Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor desta newsletter.\n\n" +
  'Reeleito para um quarto mandato, Lula disse na Avenida Paulista que não quer depender de inteligência artificial chinesa ou americana: "Eu quero criar uma brasileira".';

describe("#12955 léxico: palavra comum não vira nome", () => {
  it("261022: 'dIA' do nome do programa não entra; 'notícia do dia' fica", () => {
    const lex = properNounLexicon(R261022);
    assert.equal(lex.has("dia"), false);
    assert.equal(lex.get("sebrae"), "Sebrae");
    const { words, changes } = applyProperNounLexicon(say("a principal notícia do dia é do sebrae"), lex);
    assert.equal(texts(words), "a principal notícia do dia é do Sebrae");
    assert.deepEqual(changes.map((c) => c.written), ["Sebrae"]);
  });

  it("261029: 'Eu' de citação depois de dois-pontos não entra; 'nesse canal eu comento' fica", () => {
    const lex = properNounLexicon(R261029);
    assert.equal(lex.has("eu"), false);
    const { words, changes } = applyProperNounLexicon(say("nesse canal eu comento a notícia"), lex);
    assert.equal(texts(words), "nesse canal eu comento a notícia");
    assert.deepEqual(changes, []);
  });

  it("abertura de citação é início de frase mesmo sem a palavra comum na lista", () => {
    const lex = properNounLexicon('O ministro disse: "Vamos regular agora". E a Anthropic respondeu.');
    assert.equal(lex.has("vamos"), false);
    assert.equal(lex.get("anthropic"), "Anthropic");
  });

  it("'Eu' ouvido no meio da frase vira 'eu'; no início de frase, depois de dois-pontos ou com aspas, fica", () => {
    const { words, changes } = applyProperNounLexicon(say("nesse canal Eu comento. Eu sou o Pixel e ele disse: Eu quero"), new Map());
    assert.equal(texts(words), "nesse canal eu comento. Eu sou o Pixel e ele disse: Eu quero");
    assert.deepEqual(summarizeLexiconChanges(changes), ['"Eu" → "eu" (pronome no meio da frase)']);
    assert.equal(texts(applyProperNounLexicon(say('falou "Eu quero"'), new Map()).words), 'falou "Eu quero"');
  });

  it("nome de verdade com sigla segue corrigido ('openai' → 'OpenAI')", () => {
    const lex = properNounLexicon("A OpenAI lançou o modelo. A Meta respondeu.");
    assert.equal(texts(applyProperNounLexicon(say("a openai lançou"), lex).words), "a OpenAI lançou");
  });
});
