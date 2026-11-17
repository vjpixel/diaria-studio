/**
 * #13390: o ator da descrição do YouTube (prefixo "Ator:" na 1ª linha e a
 * hashtag) só vale quando é o sujeito do D1, no título ou na 1ª frase do
 * corpo. Ator citado só mais adiante no corpo não entra.
 *
 * Caso real 261117: D1 sobre o deepfake de Drauzio Varella, Meta citada só no
 * 3º parágrafo. A descrição abriu com "Meta: Das 764 alegações…" e as hashtags
 * saíram `#IA #Meta #Saúde`; o editor mandou tirar os dois.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildYouTubeDescription,
  buildYouTubeHashtags,
  detectYouTubeD1Actor,
  youtubeD1Themes,
} from "../scripts/lib/diaria/youtube-video.ts";

// Fixture mínima do D1 da 261117 (02-reviewed.md), copiada para não depender de data/.
const D1_261117 = {
  title: "Deepfake de Drauzio Varella anuncia remédio milagroso",
  body: [
    "Das 764 alegações sobre saúde checadas pela Lupa entre 2017 e junho de 2026, 87,3% eram falsas. A tática mais usada é a falsa autoridade médica (21,6% dos casos), e golpistas usam deepfakes de médicos conhecidos para vender suplementos sem evidência científica.",
    "O diabetes é o alvo preferido. A Sociedade Brasileira de Diabetes respondeu a pacientes que recebiam vídeos manipulados com a voz de Drauzio Varella recomendando um remédio \"maravilhoso\".",
    "A Meta diz não permitir desinformação prejudicial sobre saúde. Pirozzi denuncia conteúdos no Instagram e costuma ouvir que nada de errado foi encontrado.",
  ].join("\n\n"),
  url: "https://mittechreview.com.br/x",
  category: "🩺 SAÚDE",
};

const desc = (d1: typeof D1_261117) =>
  buildYouTubeDescription({ aammdd: "261117", episode: 1, editionUrl: "https://diar.ia.br/p/x", d1 });

describe("#13390 ator só quando é o sujeito do D1", () => {
  it("261117: Meta só no 3º parágrafo não é o ator", () => {
    assert.equal(detectYouTubeD1Actor(D1_261117), null);
  });

  it("261117: 1ª linha sem prefixo 'Meta:'", () => {
    assert.equal(desc(D1_261117).split("\n")[0].slice(0, 30), "Das 764 alegações sobre saúde ");
    assert.doesNotMatch(desc(D1_261117).split("\n")[0], /^Meta:/);
  });

  it("261117: hashtags sem #Meta", () => {
    assert.deepEqual(buildYouTubeHashtags(D1_261117), ["#IA", "#InteligênciaArtificial", "#Saúde"]);
    assert.equal(desc(D1_261117).split("\n").at(-1), "#IA #InteligênciaArtificial #Saúde");
  });

  it("ator só depois da 1ª frase (mesmo parágrafo) também não conta", () => {
    const d1 = { ...D1_261117, title: "Golpe usa voz clonada", body: "Criminosos clonam vozes. O Google removeu os vídeos." };
    assert.equal(detectYouTubeD1Actor(d1), null);
    assert.deepEqual(youtubeD1Themes(d1), ["seguranca"], "sem playlist do Google");
  });

  it("título cita o ator: prefixo e hashtag mantidos", () => {
    const d1 = { ...D1_261117, title: "Meta remove deepfake de Drauzio Varella" };
    assert.equal(detectYouTubeD1Actor(d1)?.key, "meta");
    assert.match(desc(d1).split("\n")[0], /^Meta: Das 764 alegações/);
    assert.deepEqual(buildYouTubeHashtags(d1), ["#IA", "#Meta", "#Saúde"]);
  });

  it("1ª frase cita o ator: hashtag mantida, sem prefixo (a frase já o nomeia)", () => {
    const d1 = { ...D1_261117, title: "Remédio milagroso em vídeo falso", body: `A Meta removeu vídeos falsos de médicos.\n\n${D1_261117.body}` };
    assert.equal(detectYouTubeD1Actor(d1)?.key, "meta");
    assert.equal(desc(d1).split("\n")[0], "A Meta removeu vídeos falsos de médicos.");
    assert.deepEqual(buildYouTubeHashtags(d1), ["#IA", "#Meta", "#Saúde"]);
  });
});
