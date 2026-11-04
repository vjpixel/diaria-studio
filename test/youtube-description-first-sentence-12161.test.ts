/**
 * #12161 — a descrição do YouTube cortava o resumo original pelo comprimento da 1ª
 * frase NORMALIZADA (espaços colapsados + trim). Com espaço duplo, quebra de linha
 * ou espaço no início antes do 1º ponto, o resto da descrição perdia ou repetia
 * caracteres; com 1º parágrafo sem ponto, a frase entrava no parágrafo seguinte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildYouTubeDescription, splitFirstSentence } from "../scripts/lib/diaria/youtube-video.ts";

const desc = (body: string) =>
  buildYouTubeDescription({
    aammdd: "261104",
    episode: 15,
    editionUrl: "https://diar.ia.br/p/x",
    d1: { title: "ChatGPT ganha memória", body, url: "https://openai.com/x", category: "LANÇAMENTO" },
  });

/** O trecho entre a linha do link da edição e o CTA: o "resto" do resumo. */
function restOf(d: string): string {
  const parts = d.split("\n\n");
  return parts[1];
}

describe("#12161 1ª frase da descrição do YouTube", () => {
  it("espaço duplo antes do ponto: o resto começa inteiro", () => {
    const d = desc("A OpenAI  liberou   a memória do ChatGPT.\n\nA função lembra preferências.");
    assert.equal(d.split("\n")[0], "A OpenAI liberou a memória do ChatGPT.");
    assert.equal(restOf(d), "A função lembra preferências.");
  });

  it("quebra de linha e espaço no início: o resto não repete o fim da frase", () => {
    const d = desc("  A OpenAI liberou\na memória do ChatGPT. Ela lembra preferências.");
    assert.equal(d.split("\n")[0], "A OpenAI liberou a memória do ChatGPT.");
    assert.equal(restOf(d), "Ela lembra preferências.");
  });

  it("1º parágrafo sem ponto final: a frase para no parágrafo", () => {
    const d = desc("A OpenAI liberou a memória do ChatGPT\n\nA função lembra preferências. Vale para todos.");
    assert.equal(d.split("\n")[0], "A OpenAI liberou a memória do ChatGPT");
    assert.equal(restOf(d), "A função lembra preferências. Vale para todos.");
  });

  it("splitFirstSentence corta pela posição no texto original", () => {
    assert.deepEqual(splitFirstSentence("Um  dois.  Três quatro."), { sentence: "Um dois.", rest: "Três quatro." });
    assert.deepEqual(splitFirstSentence("Sem ponto nenhum"), { sentence: "Sem ponto nenhum", rest: "" });
    assert.deepEqual(splitFirstSentence("v1.5 saiu. Fim."), { sentence: "v1.5 saiu.", rest: "Fim." });
  });
});
