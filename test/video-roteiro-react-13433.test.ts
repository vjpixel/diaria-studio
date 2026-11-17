// #13433: formato react do /diaria-video-roteiro (o editor reage a trechos de
// um vídeo anterior). Fixtures reais da 261118: a v7, em que o vertical 1 dizia
// "Essa ainda não dá pra cravar" sem o trecho que só o horizontal leva, e a v9,
// a versão que o editor gravou. SRT: trecho do vídeo de 10/11 (261110).
// #13434: aviso de 02-reviewed.md mais novo que o roteiro / fact-check do roteiro.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  avisosFactCheckRoteiroDefasado,
  avisosFormatoReact,
  avisosReacaoPergunta,
  avisosReactVertical,
  avisosTrechoContraSrt,
  intervaloDaOrigem,
  srtDoVideoPublicado,
  videoIdDaOrigem,
} from "../scripts/lib/diaria/roteiro-react.ts";
import { parseRoteiroFalas } from "../scripts/lib/diaria/roteiro-videos.ts";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { main as blocosMain } from "../scripts/video-roteiro-blocos.ts";

const fixture = (nome: string): RoteiroFalas => JSON.parse(readFileSync(new URL(`./fixtures/roteiro-video/${nome}`, import.meta.url), "utf8"));
const V7 = fixture("roteiro-falas-261118-v7.json");
const V9 = fixture("roteiro-falas-261118-v9.json");
const SRT_261110 = readFileSync(new URL("./fixtures/roteiro-video/diaria-comentada-261110-trechos.srt", import.meta.url), "utf8");
const VIDEO_ID = "lyh6IZux4FE";
const srtSo = (id: string) => (id === VIDEO_ID ? SRT_261110 : null);

const TRECHO_CARGO = { origem: "Vídeo de 10/11 (youtu.be/lyh6IZux4FE), de 3:42 a 3:46", texto: "E ele pode chegar a perder o cargo atual dele." };
const roteiro = (falas: RoteiroFalas["falas"]): RoteiroFalas => ({ falas }) as RoteiroFalas;

describe("fixtures reais da 261118", () => {
  it("as duas versões são roteiros válidos", () => {
    assert.equal(parseRoteiroFalas(V7).ok, true);
    assert.equal(parseRoteiroFalas(V9).ok, true);
  });

  it("v7: avisa a fala do vertical 1 que diz 'Essa' logo depois do trecho", () => {
    const avisos = avisosReactVertical(V7);
    assert.equal(avisos.length, 1, avisos.join("\n"));
    assert.match(avisos[0], /^H10: vem logo depois do trecho inserido em H9b e está no vertical 1/);
    assert.match(avisos[0], /"Essa ainda não dá pra cravar\."/);
  });

  it("v9 (a gravada) não avisa nada do formato react, inclusive contra o SRT", () => {
    assert.deepEqual(avisosReactVertical(V9), []);
    assert.deepEqual(avisosReacaoPergunta(V9), []);
    assert.deepEqual(avisosTrechoContraSrt(V9, srtSo), []);
  });
});

describe("avisosReactVertical", () => {
  const depoisDoTrecho = (texto: string, videos: RoteiroFalas["falas"][number]["videos"] = ["horizontal", "vertical1"]) =>
    roteiro([
      { id: "H3", bloco: "resumo", texto: "A primeira:", videos: ["horizontal"], trechoInserido: TRECHO_CARGO },
      { id: "H4", bloco: "resumo", texto, videos },
    ]);

  it("pronome, veredito solto e tempo relativo sem nome avisam", () => {
    for (const t of ["Isso aconteceu dois dias depois.", "Acertei.", "E essa eu acertei.", "Dois dias depois, ele saiu."]) {
      assert.equal(avisosReactVertical(depoisDoTrecho(t)).length, 1, t);
    }
  });

  it("fala que diz o fato sozinha não avisa", () => {
    for (const t of ["Dois dias depois, o Jensen Huang saiu mesmo do comando da Nvidia.", "O Jensen Huang saiu mesmo. Essa eu acertei.", "Esperava mais."]) {
      assert.deepEqual(avisosReactVertical(depoisDoTrecho(t)), [], t);
    }
  });

  it("fala só do horizontal não avisa: ali o trecho está logo antes", () => {
    assert.deepEqual(avisosReactVertical(depoisDoTrecho("Essa eu acertei.", ["horizontal"])), []);
  });

  it("vale para o vertical 2 também", () => {
    assert.match(avisosReactVertical(depoisDoTrecho("Essa eu acertei.", ["horizontal", "vertical2"]))[0], /está no vertical 2/);
  });
});

describe("avisosReacaoPergunta (decisão 3, v6 da 261118)", () => {
  it("'Perder o cargo?' depois do trecho do cargo avisa", () => {
    const r = roteiro([
      { id: "H3", bloco: "resumo", texto: "A primeira:", videos: ["horizontal"], trechoInserido: TRECHO_CARGO },
      { id: "H4", bloco: "resumo", texto: "Perder o cargo? Dois dias depois, o Jensen Huang renunciou.", videos: ["horizontal", "vertical1"] },
    ]);
    assert.deepEqual(avisosReacaoPergunta(r), ['H4: a reação ao trecho de H3 abre repetindo a previsão em pergunta ("Perder o cargo?"); o trecho acabou de dizer, comentar direto (#13433).']);
  });

  it("pergunta sem palavra do trecho e afirmação não avisam", () => {
    for (const t of ["E aí, aconteceu? Aconteceu.", "Dois dias depois, o Jensen Huang saiu do cargo."]) {
      const r = roteiro([
        { id: "H3", bloco: "resumo", texto: "A primeira:", videos: ["horizontal"], trechoInserido: TRECHO_CARGO },
        { id: "H4", bloco: "resumo", texto: t, videos: ["horizontal"] },
      ]);
      assert.deepEqual(avisosReacaoPergunta(r), [], t);
    }
  });
});

describe("origem do trecho", () => {
  it("lê o id do vídeo e o intervalo", () => {
    assert.equal(videoIdDaOrigem("Vídeo de 10/11 (youtu.be/lyh6IZux4FE), de 3:42 a 3:46"), VIDEO_ID);
    assert.equal(videoIdDaOrigem("https://www.youtube.com/watch?v=lyh6IZux4FE&t=222"), VIDEO_ID);
    assert.equal(videoIdDaOrigem("Vídeo de 10/11, sem link"), null);
    assert.deepEqual(intervaloDaOrigem("de 3:42 a 3:46"), { inicio: 222, fim: 226 });
    assert.deepEqual(intervaloDaOrigem("3:54,88 a 4:27"), { inicio: 234.88, fim: 267 });
    assert.deepEqual(intervaloDaOrigem("1:03:42-1:03:46"), { inicio: 3822, fim: 3826 });
    assert.equal(intervaloDaOrigem("de 4:00 a 3:00"), null);
  });
});

describe("avisosTrechoContraSrt (decisão 2)", () => {
  const comTrecho = (trechoInserido: { origem: string; texto: string }) =>
    roteiro([{ id: "H9b", bloco: "comentario", texto: "E a terceira:", videos: ["horizontal"], trechoInserido }]);
  const PRECO = "E isso pode causar um aumento do preço desses componentes fora dos Estados Unidos.";

  it("início depois da legenda com a 1ª palavra avisa (3:55 contra 3:54,88, na 261118)", () => {
    const avisos = avisosTrechoContraSrt(comTrecho({ origem: "youtu.be/lyh6IZux4FE, de 3:55 a 4:00", texto: PRECO }), srtSo);
    assert.deepEqual(avisos, ["H9b: a origem começa em 3:55, mas a legenda com a primeira palavra do trecho começa em 3:54,88; o corte come o começo da fala (#13433)."]);
  });

  it("início antes da 1ª palavra não avisa", () => {
    assert.deepEqual(avisosTrechoContraSrt(comTrecho({ origem: "youtu.be/lyh6IZux4FE, de 3:54 a 4:00", texto: PRECO }), srtSo), []);
  });

  it("texto de memória avisa", () => {
    const avisos = avisosTrechoContraSrt(comTrecho({ origem: "youtu.be/lyh6IZux4FE, de 3:42 a 3:46", texto: "Ele pode perder o cargo." }), srtSo);
    assert.match(avisos[0], /^H9b: trechoInserido\.texto não bate com o SRT do vídeo lyh6IZux4FE entre 3:42 e 3:46/);
  });

  it("texto certo em intervalo errado avisa o tempo", () => {
    const avisos = avisosTrechoContraSrt(comTrecho({ origem: "youtu.be/lyh6IZux4FE, de 3:42 a 3:46", texto: PRECO }), srtSo);
    assert.match(avisos[0], /está no SRT do vídeo lyh6IZux4FE, mas fora do intervalo da origem/);
  });

  it("sem SRT ou sem id na origem, nada a conferir", () => {
    assert.deepEqual(avisosTrechoContraSrt(comTrecho({ origem: "youtu.be/AAAAAAAAAAA, 3:42 a 3:46", texto: "qualquer coisa" }), srtSo), []);
    assert.deepEqual(avisosTrechoContraSrt(comTrecho({ origem: "Vídeo de 10/11, 3:42 a 3:46", texto: "qualquer coisa" }), srtSo), []);
  });
});

/** Raiz falsa com `data/editions/2611/261110` (vídeo publicado + SRT) e a pasta da 261118. */
function raizComVideo(): string {
  const root = mkdtempSync(join(tmpdir(), "roteiro-react-13433-"));
  const ed = join(root, "data", "editions", "2611", "261110");
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeFileSync(join(ed, "_internal", "05-youtube-published.json"), JSON.stringify({ videoId: VIDEO_ID }));
  writeFileSync(join(ed, "diaria-comentada-261110.srt"), SRT_261110);
  mkdirSync(join(root, "data", "editions", "2611", "261118", "_internal"), { recursive: true });
  return root;
}

describe("SRT do vídeo publicado", () => {
  it("acha o SRT pela edição que publicou o vídeo", () => {
    const root = raizComVideo();
    assert.equal(srtDoVideoPublicado(join(root, "data", "editions"), VIDEO_ID), SRT_261110);
    assert.equal(srtDoVideoPublicado(join(root, "data", "editions"), "BBBBBBBBBBB"), null);
    assert.equal(srtDoVideoPublicado(join(root, "nao-existe"), VIDEO_ID), null);
  });

  it("avisosFormatoReact junta os três e lê o SRT do disco", () => {
    const root = raizComVideo();
    assert.deepEqual(avisosFormatoReact(V9, join(root, "data", "editions")), []);
    const avisos = avisosFormatoReact(V7, join(root, "data", "editions"));
    assert.ok(avisos.some((a) => a.startsWith("H10: vem logo depois do trecho")), avisos.join("\n"));
  });

  it("o video-roteiro-blocos.ts imprime os avisos do formato react", () => {
    const root = raizComVideo();
    const falas = join(root, "data", "editions", "2611", "261118", "_internal", "roteiro-falas.json");
    writeFileSync(falas, JSON.stringify(V7));
    const err: string[] = [];
    blocosMain(["261118", "--falas", falas], { out: () => {}, err: (s) => err.push(s) }, root);
    assert.ok(err.some((l) => l.startsWith("[aviso] H10: vem logo depois do trecho inserido em H9b")), err.join("\n"));
  });
});

describe("avisosFactCheckRoteiroDefasado (#13434)", () => {
  const montar = () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-fc-13434-"));
    mkdirSync(join(dir, "_internal"));
    const falas = join(dir, "_internal", "roteiro-falas.json");
    const fc = join(dir, "_internal", "fact-check-roteiro.md");
    const d1 = join(dir, "02-reviewed.md");
    for (const p of [falas, fc, d1]) writeFileSync(p, "x");
    const em = (p: string, s: number) => utimesSync(p, s, s);
    return { dir, falas, fc, d1, em };
  };

  it("02-reviewed.md mais velho que os dois: nada", () => {
    const { dir, falas, fc, d1, em } = montar();
    em(d1, 1_000);
    em(falas, 2_000);
    em(fc, 3_000);
    assert.deepEqual(avisosFactCheckRoteiroDefasado(dir, falas), []);
  });

  it("D1 mudou depois do roteiro e do fact-check: avisa os dois", () => {
    const { dir, falas, fc, d1, em } = montar();
    em(falas, 1_000);
    em(fc, 2_000);
    em(d1, 3_000);
    const avisos = avisosFactCheckRoteiroDefasado(dir, falas);
    assert.equal(avisos.length, 2);
    assert.match(avisos[0], /02-reviewed\.md mudou depois do roteiro-falas\.json/);
    assert.match(avisos[1], /fact-check-roteiro\.md: refazer o fact-check/);
  });

  it("sem 02-reviewed.md ou sem fact-check, só o que existe conta", () => {
    const dir = mkdtempSync(join(tmpdir(), "roteiro-fc-13434-"));
    assert.deepEqual(avisosFactCheckRoteiroDefasado(dir, join(dir, "nada.json")), []);
  });
});
