/**
 * test/video-roteiro-batch-13149-13140-13155.test.ts
 *
 * - #13149: `readRoteiroPecas` cai na leitura tolerante (título e capa que são
 *   texto, com aviso), como o `readRoteiroHorizontal`: um corte desatualizado
 *   não derruba a capa dos verticais.
 * - #13155: capa que começa com nome próprio fora de `CAPA_KNOWN_NAMES`
 *   ("Drauzio nunca vendeu essa cura", roteiro da 261117) não gera o aviso de
 *   capa sem sujeito quando o nome aparece no meio de uma frase do roteiro.
 * - #13140: (1) os cortes de reserva do roteiro abrem a sugestão de corte do
 *   `roteiro` da montagem com a vertical acima do alvo; (2) o texto de `tela`
 *   da fala vira marcador da sequência no XML, no tempo da fala.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import {
  avisosGanchoETitulo,
  readRoteiroCortesReserva,
  readRoteiroPecas,
  readRoteiroTelas,
  ROTEIRO_FALAS_FILE,
} from "../scripts/lib/diaria/roteiro-videos.ts";
import { hasRecognizableSubject, scoreCapaHook } from "../scripts/lib/diaria/youtube-capa-hooks.ts";
import { reservaCutLines, roteiroMarkdown, type ReservaDoRoteiro } from "../scripts/lib/diaria/video-montage-docs.ts";
import { buildXmeml, telaMarkersFor, type BlockKey, type PlannedClip, type ResolvedItem, type SequencePlan, type SequenceSpec } from "../scripts/lib/diaria/video-montage.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
const base = (): RoteiroFalas => JSON.parse(readFileSync(FIXTURE, "utf8"));

function comRoteiro<T>(r: unknown, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "roteiro-batch-"));
  try {
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, ROTEIRO_FALAS_FILE), typeof r === "string" ? r : JSON.stringify(r));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#13149: readRoteiroPecas tolera um problema em outro campo", () => {
  it("roteiro com corte desatualizado continua trazendo a capa dos verticais, com aviso", () => {
    const r = base();
    r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "trecho que sumiu da fala" };
    const avisos: string[] = [];
    const pecas = comRoteiro(r, (dir) => readRoteiroPecas(dir, (m) => void avisos.push(m)));
    assert.equal(pecas?.vertical1?.capa, "Sua Busca mudou de IA");
    assert.equal(pecas?.vertical2?.capa, "Google: para de usar palavra-chave");
    assert.equal(pecas?.horizontal?.titulo, "Google te dá Gemini 4 Hydrogen de graça");
    assert.ok(avisos.some((a) => /inválido.*uso título e capa de cada vídeo mesmo assim/.test(a)), avisos.join("\n"));
  });
  it("campo de outro tipo fica fora, sem lançar; nada aproveitável = null com aviso", () => {
    const r = base() as unknown as { falas: unknown; porVideo: Record<string, Record<string, unknown>> };
    r.porVideo.vertical1.capa = 42;
    r.porVideo.vertical2.capa = "   ";
    r.porVideo.vertical2.titulo = "Novo Gemini: 3 dicas";
    r.falas = "quebrado";
    const pecas = comRoteiro(r, (dir) => readRoteiroPecas(dir, () => {}));
    assert.equal(pecas?.vertical1?.capa, undefined);
    assert.equal(pecas?.vertical2?.capa, undefined);
    assert.equal(pecas?.vertical2?.titulo, "Novo Gemini: 3 dicas");
    const avisos: string[] = [];
    assert.equal(comRoteiro({ falas: [] }, (dir) => readRoteiroPecas(dir, (m) => void avisos.push(m))), null);
    assert.ok(avisos.some((a) => /capa do roteiro ignorada/.test(a)));
  });
  it("válido = as peças de sempre; ausente = null em silêncio; ilegível = null com aviso", () => {
    assert.equal(comRoteiro(base(), (dir) => readRoteiroPecas(dir, () => assert.fail("sem aviso")))?.vertical1?.capa, "Sua Busca mudou de IA");
    const dir = mkdtempSync(join(tmpdir(), "roteiro-batch-"));
    try {
      assert.equal(readRoteiroPecas(dir, () => assert.fail("sem aviso")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const avisos: string[] = [];
    assert.equal(comRoteiro("{ não é json", (d) => readRoteiroPecas(d, (m) => void avisos.push(m))), null);
    assert.ok(avisos.some((a) => /ilegível/.test(a)));
  });
});

describe("#13155: nome próprio na 1ª palavra da capa", () => {
  const contexto = "Hoje o assunto é saúde. Quem conta é o Drauzio Varella, que nunca vendeu cura nenhuma.";
  it("caso real da 261117: 'Drauzio nunca vendeu essa cura' tem sujeito quando o roteiro cita o nome no meio da frase", () => {
    assert.equal(hasRecognizableSubject("Drauzio nunca vendeu essa cura"), false, "sem contexto, a 1ª palavra não conta (o de antes)");
    assert.equal(hasRecognizableSubject("Drauzio nunca vendeu essa cura", contexto), true);
  });
  it("verbo na 1ª palavra segue acusado, mesmo com contexto", () => {
    assert.equal(hasRecognizableSubject("Inventa cinco vezes menos?", contexto), false);
    // A palavra só no começo de frase do contexto não prova que é nome.
    assert.equal(hasRecognizableSubject("Inventa cinco vezes menos?", "Inventa demais. Inventa sempre."), false);
    assert.equal(hasRecognizableSubject("Inventa cinco vezes menos?", "Ele disse:\nInventa sempre."), false);
  });
  it("avisosGanchoETitulo: a capa do vertical com o nome citado nas falas não gera o aviso", () => {
    const r = base();
    r.porVideo!.vertical1!.capa = "Drauzio nunca vendeu essa cura";
    r.falas.find((f) => f.id === "H10c")!.texto += " Quem lembrou disso foi o Drauzio Varella.";
    assert.ok(!avisosGanchoETitulo(r).some((a) => /não tem sujeito reconhecível/.test(a)));
    const semNome = base();
    semNome.porVideo!.vertical1!.capa = "Drauzio nunca vendeu essa cura";
    assert.ok(avisosGanchoETitulo(semNome).some((a) => /vertical 1: a capa "Drauzio nunca vendeu essa cura" não tem sujeito/.test(a)));
  });
  it("scoreCapaHook: o D1 que cita o nome tira o aviso do Short", () => {
    const d1 = { title: "Drauzio Varella desmente golpe com IA", body: "Um vídeo falso usava a voz do médico. O Drauzio diz que nunca vendeu cura." };
    assert.equal(scoreCapaHook("Drauzio nunca vendeu cura", d1).short_warning, null);
    assert.match(scoreCapaHook("Inventa cinco vezes menos?", d1).short_warning ?? "", /sem sujeito/);
  });
});

const SPEC_V: SequenceSpec = { target: "outras-redes", name: "Diaria comentada_Vertical_V1", width: 1080, height: 1920, order: ["titulo", "resumo_curto", "comentario", "fecho"], scales: [115, 130] };
const item = (start: number, end: number, text: string, extra: Partial<ResolvedItem> = {}): ResolvedItem => ({ interval: { start, end }, text, words: [], lastWordEnd: null, holdLimit: end, how: "explicit", ...extra }) as ResolvedItem;
const vplan = (seconds: number, clips: PlannedClip[] = [], spec: SequenceSpec = SPEC_V): SequencePlan => ({ spec, clips, durationFrames: Math.round(seconds * 30), script: "", missingBlocks: [], dropped: [] });

const FALA_LONGA = "Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini. Pra pergunta rápida, nem precisa do app: a Busca do Google já resolve.";
const resolved: Partial<Record<BlockKey, ResolvedItem[]>> = {
  titulo: [item(10, 13, "O Google mudou a IA da Busca.")],
  resumo_curto: [item(20, 40, "O Gemini 4 Hydrogen já está liberado pra todo mundo.")],
  comentario: [item(400, 420, "Isso muda a relação com o cliente."), item(430, 460, FALA_LONGA)],
  fecho: [item(900, 903, "Até amanhã.")],
};
const RESERVA: ReservaDoRoteiro = {
  chave: "outras-redes",
  id: "H10f",
  texto: FALA_LONGA,
  trecho: "Pra pergunta rápida, nem precisa do app: a Busca do Google já resolve.",
  segmentos: ["Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini."],
  economiaS: 6,
};

describe("#13140 (1): corte de reserva no topo da sugestão da vertical acima do alvo", () => {
  it("o roteiro.md mostra a reserva primeiro, com o que muda no blocks.json", () => {
    const md = roteiroMarkdown("261116", [vplan(80)], resolved, 30, { cortesReserva: [RESERVA] });
    const iReserva = md.indexOf("**reserva do roteiro** H10f");
    const iAuto = md.indexOf("- Comentário [");
    assert.ok(iReserva > 0, md);
    assert.ok(iAuto > iReserva, "a reserva vem antes da sugestão da montagem");
    assert.match(md, /Primeiro, os cortes de reserva do roteiro \(#13140\), ~6,0 s .* o que cobre o excesso/);
    assert.match(md, /Comentário \[1\] .*`"skip": \["outras-redes"\]` nele e logo depois \{"text": "Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini\.", "targets": \["outras-redes"\]\}/);
  });
  it("dentro do alvo: sem a seção; reserva de outra sequência: fora", () => {
    assert.ok(!roteiroMarkdown("261116", [vplan(60)], resolved, 30, { cortesReserva: [RESERVA] }).includes("reserva do roteiro"));
    assert.deepEqual(reservaCutLines(vplan(80), resolved, [{ ...RESERVA, chave: "guia" }]).lines, []);
  });
  it("item com targets: tira a chave de targets; só desta versão: troca o item; já aplicado: some", () => {
    const comTargets = { ...resolved, comentario: [item(430, 460, FALA_LONGA, { targets: ["youtube", "outras-redes"] })] };
    assert.match(reservaCutLines(vplan(80), comTargets, [RESERVA]).lines[0], /tirar "outras-redes" de `targets` \(fica \["youtube"\]\)/);
    const soEsta = { ...resolved, comentario: [item(430, 460, FALA_LONGA, { targets: ["outras-redes"] })] };
    assert.match(reservaCutLines(vplan(80), soEsta, [RESERVA]).lines[0], /o item é só desta versão: trocá-lo pelos itens/);
    const aplicado = { ...resolved, comentario: [item(430, 445, RESERVA.segmentos[0])] };
    assert.deepEqual(reservaCutLines(vplan(80), aplicado, [RESERVA]).lines, []);
    const sumiu = { ...resolved, comentario: [] };
    assert.match(reservaCutLines(vplan(80), sumiu, [RESERVA]).lines[0], /não foi achada nesta versão/);
  });
  it("readRoteiroCortesReserva lê do roteiro-falas.json (com a fala inteira); inválido = [] com aviso", () => {
    const r = base();
    r.falas.find((f) => f.id === "H10f")!.cortes = { vertical1: { trecho: RESERVA.trecho, reserva: true } };
    const cortes = comRoteiro(r, (dir) => readRoteiroCortesReserva(dir, () => assert.fail("sem aviso")));
    assert.deepEqual(cortes.map((c) => [c.chave, c.id]), [["outras-redes", "H10f"]]);
    assert.equal(cortes[0].texto, r.falas.find((f) => f.id === "H10f")!.texto);
    r.falas.find((f) => f.id === "H4")!.cortes = { vertical1: "trecho que sumiu" };
    const avisos: string[] = [];
    assert.deepEqual(comRoteiro(r, (dir) => readRoteiroCortesReserva(dir, (m) => void avisos.push(m))), []);
    assert.ok(avisos.some((a) => /cortes de reserva do roteiro fora da sugestão/.test(a)));
  });
});

const clip = (block: BlockKey, srcIn: number, srcOut: number, seqStart: number): PlannedClip => ({
  block,
  srcIn,
  srcOut,
  frameIn: Math.round(srcIn * 30),
  frameOut: Math.round(srcOut * 30),
  seqStart,
  seqEnd: seqStart + Math.round((srcOut - srcIn) * 30),
  scale: 115,
});

describe("#13140 (2): texto de tela como marcador do XML", () => {
  const telas = [
    { id: "H4", texto: "O Gemini 4 Hydrogen já está liberado pra todo mundo.", tela: "App do Gemini · Busca do Google" },
    { id: "H10f", texto: FALA_LONGA, tela: "ChatGPT grátis × Gemini" },
    { id: "H99", texto: "Fala que não está nesta versão.", tela: "nunca" },
  ];
  // A fala longa saiu em 2 clipes (um corte de pausa no meio).
  const clips = [clip("titulo", 10, 13, 0), clip("resumo_curto", 20, 40, 90), clip("comentario", 430, 444, 690), clip("comentario", 446, 460, 1110)];
  const SPEC_H: SequenceSpec = { ...SPEC_V, target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080 };
  it("cada fala com tela cai no tempo dela na sequência; fala fora desta versão não entra", () => {
    const ms = telaMarkersFor(vplan(60, clips, SPEC_H), resolved, 30, telas);
    assert.deepEqual(ms, [
      { id: "H4", tela: "App do Gemini · Busca do Google", in: 90, out: 690 },
      { id: "H10f", tela: "ChatGPT grátis × Gemini", in: 690, out: 1530 },
    ]);
  });
  it("o trecho que sobra de um corte parcial (3+ palavras) casa com a fala; item curto não", () => {
    const cortado = { ...resolved, comentario: [item(430, 444, "Se você usa só o plano gratuito do ChatGPT, vale testar o Gemini.")], fecho: [item(900, 903, "Até amanhã.")] };
    const ms = telaMarkersFor(vplan(60, [clip("comentario", 430, 444, 0), clip("fecho", 900, 903, 420)], SPEC_H), cortado, 30, [...telas, { id: "F", texto: "Até amanhã, e obrigado por assistir.", tela: "x" }]);
    assert.deepEqual(ms.map((m) => [m.id, m.in, m.out]), [["H10f", 0, 420]]);
  });
  it("#13186: fala com tela no horizontal e no vertical 1 vira marcador só na sequência horizontal", () => {
    const h = telaMarkersFor(vplan(60, clips, SPEC_H), resolved, 30, telas);
    assert.deepEqual(h.map((m) => m.id), ["H4", "H10f"]);
    assert.deepEqual(telaMarkersFor(vplan(60, clips), resolved, 30, telas), []);
    assert.deepEqual(telaMarkersFor(vplan(60, clips, { ...SPEC_V, target: "instagram" }), resolved, 30, telas), []);
    assert.deepEqual(telaMarkersFor(vplan(60, clips, { ...SPEC_V, corte: "x" }), resolved, 30, telas), []);
  });
  it("buildXmeml põe o marcador no <sequence>, com o texto escapado; sem marcador, o XML de antes", () => {
    const plan = vplan(60, clips);
    const source = { path: "/b/bruto.mp4", fps: 30, durationS: 1000, width: 1920, height: 1080 } as Parameters<typeof buildXmeml>[1];
    const framing = { faceX: 0.48, eyeY: 0.54 };
    const sem = buildXmeml([plan], source, framing);
    assert.ok(!sem.includes("<marker>"));
    const com = buildXmeml([plan], source, framing, { telaMarkers: { "outras-redes": [{ id: "H6", tela: "Hydrogen 51 × Argon 50 <índice>", in: 90, out: 690 }] } });
    assert.match(com, /<sequence id="[^"]+"><name>[^<]+<\/name><duration>\d+<\/duration>\n<rate>.*<\/rate>\n<marker><name>tela H6<\/name><comment>Hydrogen 51 × Argon 50 &lt;índice&gt;<\/comment><in>90<\/in><out>690<\/out><\/marker>\n<media>/);
    assert.equal(com.replace(/<marker>.*<\/marker>\n/, ""), sem);
  });
  it("readRoteiroTelas: tolerante a um problema em outro campo, nunca leva seta", () => {
    const r = base();
    r.falas.find((f) => f.id === "H4")!.tela = "App do Gemini · Busca do Google";
    r.falas.find((f) => f.id === "H6")!.tela = "Hydrogen → Argon";
    r.falas.find((f) => f.id === "H5")!.cortes = { vertical1: "trecho que sumiu" };
    const avisos: string[] = [];
    const t = comRoteiro(r, (dir) => readRoteiroTelas(dir, (m) => void avisos.push(m)));
    assert.deepEqual(t.map((x) => [x.id, x.tela]), [["H4", "App do Gemini · Busca do Google"]]);
    assert.ok(avisos.some((a) => /texto\(s\) de tela válidos seguem para o XML/.test(a)));
    assert.deepEqual(comRoteiro(base(), (dir) => readRoteiroTelas(dir, () => assert.fail("sem aviso"))), []);
  });
});
