/**
 * #11957: o `srt` gera também a legenda do horizontal (o upload do YouTube
 * espera `diaria-comentada-{AAMMDD}.srt` na pasta da edição).
 * #11960: a legenda é o texto do roteiro alinhado aos tempos da fala ouvida,
 * não o texto do Whisper (casos reais da vertical da 261103).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { forceAlignToScript, forcedAlignmentNotes, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { isYoutubeSpec, srtPlans, youtubeSrtCopyDecision } from "../scripts/video-montagem.ts";

/** Palavras de 0,3 s, coladas, a partir de `t0`. */
const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));
const texts = (ws: Word[]) => ws.map((w) => w.text).join(" ");

describe("#11960: alinhamento forçado do roteiro aos tempos da fala", () => {
  it("cauda de tomada perto de corte ('Tá,' antes de 'E o que é relevante') sai, com aviso", () => {
    // Corte em 3,0 s; o Whisper ouve "Tá," (o fim de "atrás") logo depois dele.
    const heard = [...say("ficou para trás.", 0), { start: 3.0, end: 3.2, text: "Tá," }, ...say("E o que é relevante", 3.3)];
    const a = forceAlignToScript(heard, "ficou para trás. E o que é relevante", { cuts: [3.0] });
    assert.equal(texts(a.words), "ficou para trás. E o que é relevante");
    assert.deepEqual(a.dropped.map((d) => [d.word.text, d.reason]), [["Tá,", "perto de corte"]]);
  });

  it("'E aí E aí' depois do fim do roteiro sai da legenda", () => {
    const heard = [...say("até amanhã.", 0), ...say("E aí E aí", 1.5)];
    const a = forceAlignToScript(heard, "até amanhã.", { endS: 5 });
    assert.equal(texts(a.words), "até amanhã.");
    assert.equal(a.dropped.length, 4);
    assert.ok(a.dropped.every((d) => d.reason === "depois do fim"));
  });

  it("ouvida que começa depois do fim da sequência sai antes do casamento; o roteiro não passa do fim", () => {
    const a = forceAlignToScript([...say("até", 0), { start: 0.6, end: 0.8, text: "amanhã" }], "até amanhã", { endS: 0.5 });
    assert.equal(texts(a.words), "até amanhã");
    assert.deepEqual(a.dropped.map((d) => [d.word.text, d.reason]), [["amanhã", "depois do fim"]]);
    assert.ok(a.words.every((w) => w.end <= 0.5), "a palavra do roteiro interpolada fica dentro da sequência");
    assert.deepEqual(a.interpolated, ["amanhã"]);
  });

  it("'ele' pulado pelo Whisper entra com o tempo interpolado entre as vizinhas", () => {
    const heard = [...say("para que", 0), ...say("passe a ter", 0.8)];
    const a = forceAlignToScript(heard, "para que ele passe a ter");
    assert.equal(texts(a.words), "para que ele passe a ter");
    const ele = a.words[2];
    assert.equal(ele.start, 0.6, "começa no fim de 'que'");
    assert.equal(ele.end, 0.8, "termina no começo de 'passe'");
    assert.deepEqual(a.interpolated, ["ele"]);
  });

  it("'tem o modelo' ouvido vira 'tem um modelo' do roteiro, no tempo do ouvido", () => {
    const heard = say("tem o modelo", 0);
    const a = forceAlignToScript(heard, "tem um modelo");
    assert.equal(texts(a.words), "tem um modelo");
    assert.deepEqual([a.words[1].start, a.words[1].end], [0.3, 0.6]);
    assert.deepEqual(a.substituted, [{ heard: "o", script: "um" }]);
  });

  it("antes do #11960 (texto ouvido) os 4 erros iam para a legenda: o caminho novo não os repete", () => {
    const heard = [
      ...say("ficou para trás.", 0),
      { start: 0.95, end: 1.1, text: "Tá," },
      ...say("E ele", 1.2),
      ...say("tem o modelo.", 1.9),
      ...say("E aí E aí", 3.5),
    ];
    const a = forceAlignToScript(heard, "ficou para trás. E ele passe tem um modelo.", { cuts: [0.95], endS: 4 });
    assert.equal(texts(a.words), "ficou para trás. E ele passe tem um modelo.");
    assert.ok(!texts(a.words).includes("Tá"));
    assert.ok(!texts(a.words).includes("aí"));
  });

  it("ouvida fora do roteiro em plena fala, longe de corte, fica e é listada para conferir", () => {
    const heard = say("a Mistral também lançou", 10);
    const a = forceAlignToScript(heard, "a Mistral lançou", { cuts: [2], endS: 30 });
    assert.equal(texts(a.words), "a Mistral também lançou");
    assert.deepEqual(a.kept.map((w) => w.text), ["também"]);
    assert.ok(forcedAlignmentNotes("V", a).some((n) => n.includes("também") && n.startsWith("[aviso]")));
  });

  it("ouvida isolada por silêncio sai como 'em silêncio'", () => {
    const heard = [...say("a Mistral", 10), { start: 11.5, end: 11.7, text: "hã" }, ...say("lançou", 12.2)];
    const a = forceAlignToScript(heard, "a Mistral lançou", { endS: 30 });
    assert.equal(texts(a.words), "a Mistral lançou");
    assert.deepEqual(a.dropped.map((d) => [d.word.text, d.reason]), [["hã", "em silêncio"]]);
  });

  it("roteiro vazio devolve o ouvido como veio", () => {
    const heard = say("qualquer coisa", 0);
    assert.equal(texts(forceAlignToScript(heard, "").words), "qualquer coisa");
  });

  it("notas: descartes viram [aviso] com o motivo, interpolação e troca viram [premissa]", () => {
    const a = forceAlignToScript([...say("tem o", 0), ...say("modelo", 1)], "tem um novo modelo");
    const notes = forcedAlignmentNotes("Diaria comentada_Vertical_V1", a);
    assert.ok(notes.every((n) => n.startsWith("[premissa]") || n.startsWith("[aviso]")));
    assert.ok(notes.some((n) => n.includes('ouvido "o", legenda com o roteiro "um novo"')));
  });
});

describe("#11957: SRT do horizontal", () => {
  const plans = [
    { spec: { target: "youtube" as const, width: 1920, height: 1080, name: "Diaria comentada_Youtube_V1" } },
    { spec: { target: "outras-redes" as const, width: 1080, height: 1920, name: "Diaria comentada_Vertical_V1" } },
    { spec: { target: "instagram" as const, corte: "soberana", width: 1080, height: 1920, name: "Diaria comentada_Vertical_V1-soberana" } },
  ];

  it("srt sem --seq gera todas as sequências, o horizontal também", () => {
    assert.deepEqual(srtPlans(plans, undefined).map((p) => p.spec.name), plans.map((p) => p.spec.name));
  });

  it("srt --seq youtube escolhe o horizontal (antes recusava: só verticais)", () => {
    assert.deepEqual(srtPlans(plans, "youtube").map((p) => p.spec.name), ["Diaria comentada_Youtube_V1"]);
    assert.deepEqual(srtPlans(plans, "soberana").map((p) => p.spec.name), ["Diaria comentada_Vertical_V1-soberana"]);
  });

  it("só o horizontal sem corte vai para diaria-comentada-{AAMMDD}.srt", () => {
    assert.deepEqual(plans.filter((p) => isYoutubeSpec(p.spec)).map((p) => p.spec.name), ["Diaria comentada_Youtube_V1"]);
  });

  it("a cópia da pasta da edição editada à mão não é sobrescrita sem --force", () => {
    const written = "1\n00:00:00,000 --> 00:00:01,000\nOlá\n";
    const sha = createHash("sha256").update(written).digest("hex");
    assert.equal(youtubeSrtCopyDecision({ existing: null, recordedSha256: null, force: false }), "write");
    assert.equal(youtubeSrtCopyDecision({ existing: written, recordedSha256: sha, force: false }), "write");
    assert.equal(youtubeSrtCopyDecision({ existing: written + "corrigido\n", recordedSha256: sha, force: false }), "keep-edited");
    assert.equal(youtubeSrtCopyDecision({ existing: written, recordedSha256: null, force: false }), "keep-edited", "arquivo sem registro do srt: veio de fora");
    assert.equal(youtubeSrtCopyDecision({ existing: written + "x", recordedSha256: sha, force: true }), "write");
  });
});
