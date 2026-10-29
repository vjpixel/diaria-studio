/**
 * test/video-montage-docs-11361.test.ts (#11361) — formato dos Docs de
 * decupagem e roteiro final da `/diaria-video-montagem`, o dos Docs feitos à
 * mão na 261027: tabela por bloco, curada (bastidor agrupado), sugestão com
 * motivo, texto limpo, "Montagem sugerida" por versão e roteiro com uma tabela
 * por versão e opções A/B. Fixture de transcript com bastidor, tomada repetida
 * e opção.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSequencePlan,
  defaultSequences,
  resolveBlocks,
  type BlocksFile,
  type Segment,
  type VocabRule,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import {
  alternativesFromDecupagem,
  blocksFromDecupagem,
  buildDecupagemDoc,
  decupagemMarkdown,
  decupagemPlanTemplate,
  parseDecupagemPlan,
  roteiroMarkdown,
  segmentListing,
  versionsDiffParagraph,
  type DecupagemPlan,
} from "../scripts/lib/diaria/video-montage-docs.ts";

/** Segmento com palavras de 0,3 s espaçadas 0,05 s, a partir de `start`. */
function seg(text: string, start: number): Segment {
  const words: Word[] = text.split(" ").map((t, i) => ({ start: start + i * 0.35, end: start + i * 0.35 + 0.3, text: t }));
  return { start, end: words[words.length - 1].end, text, words };
}

// 1-based: 1 bastidor, 2 bastidor, 3 abertura, 4 falso começo, 5 título (2ª tomada),
// 6 título antigo, 7 comentário, 8 bastidor, 9 comentário alternativo, 10 CTA, 11 fecho.
const SEGMENTS: Segment[] = [
  seg("Pode gravar?", 0),
  seg("Tá rodando, vai.", 2),
  seg("Olá, eu sou o Pixel, editor da diária.", 5),
  seg("Uma atualização de", 9),
  seg("Uma atualização de privacidade do Google.", 11),
  seg("O Gemini agora lê seu Gmail.", 15),
  seg("O PNI da IA cresce no Brasil.", 19),
  seg("Espera, de novo.", 23),
  seg("O PNI da IA cresceu no Brasil.", 25),
  seg("Inscreva-se no canal.", 29),
  seg("Até amanhã!", 32),
];

const PLAN: DecupagemPlan = {
  edition: "261028",
  blocks: [
    { key: "abertura", rows: [{ segments: [3], suggestion: "usar" }] },
    {
      key: "titulo",
      rows: [
        { segments: [5], suggestion: "usar" },
        { segments: [6], suggestion: "cortar", reason: "título antigo" },
      ],
    },
    {
      key: "comentario",
      rows: [
        { segments: [7], suggestion: "usar", reason: "tomada mais limpa" },
        { segments: [9], suggestion: "alternativa", reason: "verbo no passado" },
      ],
    },
    { key: "cta_yt", rows: [{ segments: [10], suggestion: "usar" }] },
    { key: "fecho", rows: [{ segments: [11], suggestion: "usar" }] },
  ],
  vocabulary: [{ pattern: "\\bPNI\\b", replacement: "PIB" }],
};

const BASE_RULES: VocabRule[] = [{ pattern: "\\bdiária\\b", replacement: "diar.ia.br" }];

describe("decupagem por bloco (#11361)", () => {
  const doc = buildDecupagemDoc(PLAN, SEGMENTS, BASE_RULES);
  const md = decupagemMarkdown("261028", doc);

  it("uma tabela por bloco, na ordem do plano, com Tempo | Fala | Sugestão | Decisão", () => {
    const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, ["Abertura", "Título", "Comentário", "CTA YouTube", "Encerramento", "Montagem sugerida"]);
    assert.equal(md.match(/\| Tempo \| Fala \| Sugestão \| Decisão \|/g)?.length, 5);
    assert.match(md, /^# Transcrição vídeo 261028 \(decupagem\)$/m);
  });

  it("curada: bastidores e falsos começos viram 'cortar (bastidor)', agrupados por sequência contígua", () => {
    const abertura = doc.blocks.find((b) => b.key === "abertura")!;
    // 1 e 2 (antes da 1ª fala) agrupados numa linha só, no bloco da fala seguinte.
    assert.equal(abertura.rows[0].sugestao, "cortar (bastidor)");
    assert.deepEqual(abertura.rows[0].segments, [1, 2]);
    assert.match(abertura.rows[0].fala, /\(2 trechos\)$/);
    // 4 (falso começo do título) entra no título, 8 ("Espera, de novo.") no comentário.
    const titulo = doc.blocks.find((b) => b.key === "titulo")!;
    assert.deepEqual(titulo.rows.map((r) => r.sugestao), ["cortar (bastidor)", "usar (2ª tomada)", "cortar (título antigo)"]);
    const comentario = doc.blocks.find((b) => b.key === "comentario")!;
    assert.deepEqual(comentario.rows.map((r) => r.sugestao), ["usar (tomada mais limpa)", "cortar (bastidor)", "alternativa (verbo no passado)"]);
    // Nenhum segmento fica fora do Doc.
    const all = doc.blocks.flatMap((b) => b.rows.flatMap((r) => r.segments)).sort((a, b) => a - b);
    assert.deepEqual(all, SEGMENTS.map((_, i) => i + 1));
  });

  it("texto limpo: vocabulário da base e da edição aplicado; Decisão em branco", () => {
    assert.match(md, /\| 00:05\.0–00:07\.7 \| Olá, eu sou o Pixel, editor da diar\.ia\.br\. \| usar \|  \|/);
    assert.match(md, /O PIB da IA cresce no Brasil\./);
    assert.doesNotMatch(md, /PNI/);
    for (const line of md.split("\n").filter((l) => /^\| \d\d:/.test(l) && l.split("|").length === 6)) {
      assert.match(line, /\|  \|$/, `Decisão deveria vir vazia: ${line}`);
    }
  });

  it("text do plano substitui a fala do Whisper", () => {
    const plan: DecupagemPlan = { ...PLAN, blocks: [{ key: "fecho", rows: [{ segments: [11], suggestion: "usar", text: "Até amanhã, pessoal!" }] }] };
    const d = buildDecupagemDoc(plan, SEGMENTS);
    assert.equal(d.blocks[0].rows.at(-1)!.fala, "Até amanhã, pessoal!");
  });

  it("Montagem sugerida por versão, com os timecodes das linhas 'usar'", () => {
    const tail = md.slice(md.indexOf("## Montagem sugerida"));
    assert.match(tail, /### Horizontal YouTube 1920x1080: Diaria comentada_Youtube_V1/);
    assert.match(tail, /\| Título \| 00:11\.0–00:13\.1 \|/);
    assert.match(tail, /\| Abertura \| 00:05\.0–00:07\.7 \|/);
    // A vertical não leva abertura nem resumo; a falta de CTA vertical aparece.
    const ig = tail.slice(tail.indexOf("Vertical"));
    assert.doesNotMatch(ig, /Abertura/);
    assert.match(ig, /\| CTA vertical \| \(nenhuma tomada com "usar"\) \|/);
    // A alternativa e o corte não entram na montagem.
    assert.doesNotMatch(tail, /00:25\.0/);
    assert.doesNotMatch(tail, /00:15\.0/);
  });

  it("molde do blocks.json: cada fala 'usar' vira o intervalo dela no bruto, com o texto limpo", () => {
    const b = blocksFromDecupagem(doc);
    assert.deepEqual(b.titulo, [{ start: 11, end: SEGMENTS[4].end, text: "Uma atualização de privacidade do Google." }]);
    assert.deepEqual(b.comentario, [{ start: 19, end: SEGMENTS[6].end, text: "O PIB da IA cresce no Brasil." }]);
    assert.deepEqual(b.cta_ig, []);
  });

  it("regressão: o molde não deixa o roteiro casar a última tomada (a alternativa) no lugar da 'usar'", () => {
    const words = SEGMENTS.flatMap((s) => s.words ?? []);
    const file: BlocksFile = { edition: "261028", blocks: blocksFromDecupagem(doc), vocabulary: PLAN.vocabulary };
    const { blocks, errors } = resolveBlocks(file, words, { durationS: 40 });
    assert.deepEqual(errors, []);
    // Frase solta casaria a 2ª tomada (00:25, "cresceu"); o intervalo prende a escolhida (00:19).
    assert.equal(blocks.comentario![0].interval.start, 19);
    assert.equal(blocks.titulo![0].interval.start, 11);
  });

  it("sem seta em nada que o Doc mostra", () => {
    assert.doesNotMatch(md, /[→←]/);
  });
});

describe("plano da decupagem: validação (#11361)", () => {
  it("aceita o plano da fixture", () => {
    assert.equal(parseDecupagemPlan(PLAN, SEGMENTS.length).ok, true);
  });

  it("junta todos os erros: bloco desconhecido, segmento repetido/fora do intervalo, sugestão sem motivo", () => {
    const r = parseDecupagemPlan(
      {
        edition: "261028",
        blocks: [
          { key: "intro", rows: [] },
          { key: "titulo", rows: [{ segments: [5, 99], suggestion: "usar" }, { segments: [5], suggestion: "cortar" }] },
          { key: "titulo", rows: [{ segments: [6], suggestion: "talvez" }] },
        ],
        vocabulary: [{ pattern: "(", replacement: "x" }],
      },
      SEGMENTS.length,
    );
    assert.equal(r.ok, false);
    const errs = r.ok ? [] : r.errors;
    for (const re of [/intro.*desconhecida/, /segmento 99 fora de 1\.\.11/, /segmento 5 já está/, /cortar precisa de reason/, /titulo repetido/, /suggestion precisa ser/, /regex inválida/]) {
      assert.ok(errs.some((e) => re.test(e)), `faltou erro ${re}: ${errs.join(" | ")}`);
    }
  });

  it("plano sem nenhuma linha é erro (nada para curar)", () => {
    const r = parseDecupagemPlan({ edition: "261028", blocks: [{ key: "titulo", rows: [] }] }, SEGMENTS.length);
    assert.equal(r.ok, false);
  });

  it("molde e listagem numeram os segmentos e apontam as tomadas repetidas", () => {
    const list = segmentListing(SEGMENTS);
    // Desde a #11364 a listagem traz a decisão por critério de cada tomada.
    assert.match(list, /^4\. \[00:09\.0–00:10\.0\] Uma atualização de {2}\(tomada 1 de 2: cortar \(tomada incompleta\)\)$/m);
    assert.match(list, /^5\. .*\(tomada 2 de 2: usar \(2ª tomada, a última completa\)\)$/m);
    const tpl = decupagemPlanTemplate("261028", SEGMENTS) as { blocks: Array<{ key: string; rows: unknown[] }>; _segmentos: string[] };
    assert.equal(tpl._segmentos.length, SEGMENTS.length);
    assert.equal(tpl.blocks.length, 8);
    // O molde preenchido com uma linha passa na validação (as notas `_` são ignoradas).
    tpl.blocks[0].rows.push({ segments: [5], suggestion: "usar" });
    assert.equal(parseDecupagemPlan(tpl, SEGMENTS.length).ok, true);
  });
});

describe("roteiro final por versão (#11361)", () => {
  const words = SEGMENTS.flatMap((s) => s.words ?? []);
  const file: BlocksFile = {
    edition: "261028",
    blocks: {
      titulo: [{ text: "Uma atualização de privacidade do Google." }],
      abertura: [{ start: 5, end: 7.8 }],
      resumo: [{ text: "O Gemini agora lê seu Gmail." }],
      resumo_curto: [{ text: "O Gemini agora lê seu Gmail." }],
      comentario: [{ start: 19, end: 21.4, text: "O PIB da IA cresce no Brasil." }],
      cta_yt: [{ text: "Inscreva-se no canal." }],
      fecho: [{ text: "Até amanhã!" }],
    },
  };
  const { blocks, errors } = resolveBlocks(file, words, { durationS: 40 });
  const specs = defaultSequences();
  const plans = specs.map((s) => buildSequencePlan(s, blocks, [], { fps: 30, durationS: 40 }));
  const doc = buildDecupagemDoc(PLAN, SEGMENTS, BASE_RULES);
  const md = roteiroMarkdown("261028", plans, blocks, 30, { alternatives: alternativesFromDecupagem(doc) });

  it("resolve a fixture sem erro", () => {
    assert.deepEqual(errors, []);
  });

  it("uma tabela Bloco | Fala | Bruto por versão, com a duração no título", () => {
    assert.equal(md.match(/\| Bloco \| Fala \| Bruto \|/g)?.length, 2);
    assert.match(md, /^## Horizontal YouTube 1920x1080: Diaria comentada_Youtube_V1 \(\d\d:\d\d\.\d\)$/m);
    assert.match(md, /^## Vertical 1080x1920: Diaria comentada_Vertical_V1 \(\d\d:\d\d\.\d\)$/m);
  });

  it("parágrafo inicial diz o que muda entre as versões", () => {
    assert.match(md, /Comum às 2 versões: Título, Comentário, Encerramento\./);
    assert.match(md, /Horizontal YouTube leva ainda Abertura, Resumo, CTA YouTube\./);
    assert.match(md, /Vertical leva ainda Resumo curto, CTA vertical\./);
    assert.equal(versionsDiffParagraph(specs.slice(0, 1)), "");
  });

  it("texto integral com o timecode e a tomada do bruto", () => {
    assert.match(md, /\| Título \([\d.]+ s\) \| Uma atualização de privacidade do Google\. \| 00:10\.8–00:13\.3 \(tomada 1 de 1\) \|/);
    assert.match(md, /\| Abertura \([\d.]+ s\) \| Olá, eu sou o Pixel, editor da diária\. \| 00:05\.0–00:07\.8 \|/);
  });

  it("tomadas para escolher entram como linhas opção A/B no bloco, não como prosa", () => {
    assert.match(md, /\| Comentário, opção A \([\d.]+ s\) \| O PIB da IA cresce no Brasil\. \| 00:19\.0–00:21\.4 \|/);
    assert.match(md, /\| Comentário, opção B \| O PIB da IA cresceu no Brasil\. \| 00:25\.0–00:27\.4 \|/);
    // Em todas as versões que levam o comentário.
    assert.equal(md.match(/Comentário, opção B/g)?.length, 2);
  });

  it("bloco que falta aparece na tabela e no rodapé da versão", () => {
    assert.match(md, /\| CTA vertical \| \(falta no blocks\.json\) \|  \|/);
    assert.match(md, /Faltam no blocks\.json: CTA vertical\./);
  });
});
