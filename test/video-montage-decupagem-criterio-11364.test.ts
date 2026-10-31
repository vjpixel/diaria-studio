/**
 * test/video-montage-decupagem-criterio-11364.test.ts (#11364) — a decupagem
 * da `/diaria-video-montagem` decide usar/cortar por critério em vez de
 * empurrar "alternativa" para o editor: (1) a tomada que a direção aprovou,
 * lida dos comentários no transcript; (3) a última tomada completa, fora as
 * recusadas. O comentário da direção é bastidor ("cortar"). O plano que põe
 * duas tomadas da mesma frase como "usar" (o XML com as opções em sequência
 * da 261028) ou "alternativa" onde a direção já decidiu é recusado. Fixture
 * sintética no padrão da 261028: aprovação da direção, tomada repetida e
 * bastidor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideTakes,
  directionKind,
  groupTakes,
  offsetTranscript,
  retranscribeWindow,
  RETRANSCRIBE_MAX_S,
  type Segment,
  type Word,
} from "../scripts/lib/diaria/video-montage.ts";
import {
  buildDecupagemDoc,
  checkDecupagemCriteria,
  decupagemMarkdown,
  segmentListing,
  suggestedDurations,
  SHORTS_MAX_S,
  type DecupagemPlan,
} from "../scripts/lib/diaria/video-montage-docs.ts";

function seg(text: string, start: number): Segment {
  const words: Word[] = text.split(" ").map((t, i) => ({ start: start + i * 0.35, end: start + i * 0.35 + 0.3, text: t }));
  return { start, end: words[words.length - 1].end, text, words };
}

// 1-based:
//  1 bastidor ("Pode gravar?")
//  2, 3 abertura (tomadas 1 e 2), 4 direção prefere a anterior (a 1ª)
//  5, 6, 7 título (3 tomadas), 8 direção: "foi o primeiro do começo" (a 1ª)
//  9 comentário (tomada 1), 10 "Errei, de novo." (recusa), 11 comentário (tomada 2)
// 12 CTA (uma tomada só, sem comentário)
// 13 fecho, 14 direção aprova ("Muito bom.")
const SEGMENTS: Segment[] = [
  seg("Pode gravar?", 0),
  seg("Olá, eu sou o Pixel, editor da diária.", 3),
  seg("Olá, eu sou o Pixel, editor da diária.", 7),
  seg("A anterior tava melhor.", 11),
  seg("Google lança modo IA da Busca no Brasil.", 14),
  seg("Google lança modo IA da Busca no Brasil.", 18),
  seg("Google lança modo IA da Busca no Brasil.", 22),
  seg("Foi o primeiro do começo.", 26),
  seg("O PIB da IA cresce no Brasil.", 29),
  seg("Errei, de novo.", 33),
  seg("O PIB da IA cresce no Brasil.", 35),
  seg("Inscreva-se no canal.", 39),
  seg("Até amanhã!", 42),
  seg("Muito bom.", 44),
];

/** O plano que segue o critério: uma tomada por frase, comentários da direção fora (bastidor). */
const GOOD_PLAN: DecupagemPlan = {
  edition: "261028",
  blocks: [
    { key: "abertura", rows: [{ segments: [2], suggestion: "usar" }, { segments: [3], suggestion: "cortar", reason: "a direção preferiu a anterior" }] },
    {
      key: "titulo",
      rows: [
        { segments: [5], suggestion: "usar", reason: "aprovada pela direção" },
        { segments: [6], suggestion: "cortar", reason: "a direção aprovou a 1ª" },
        { segments: [7], suggestion: "cortar", reason: "a direção aprovou a 1ª" },
      ],
    },
    { key: "comentario", rows: [{ segments: [9], suggestion: "cortar", reason: "errou" }, { segments: [11], suggestion: "usar" }] },
    { key: "cta_yt", rows: [{ segments: [12], suggestion: "usar" }] },
    { key: "fecho", rows: [{ segments: [13], suggestion: "usar" }] },
  ],
};

describe("comentários da direção (#11364)", () => {
  it("lê aprovação, preferência pela anterior, 'o primeiro' e recusa", () => {
    assert.equal(directionKind("Beleza, é este take."), "aprova");
    assert.equal(directionKind("Muito bom."), "aprova");
    assert.equal(directionKind("Ficou ótimo!"), "aprova");
    assert.equal(directionKind("A anterior tava melhor."), "prefere-anterior");
    assert.equal(directionKind("Foi o primeiro do começo."), "aprova-primeira");
    assert.equal(directionKind("Errei, de novo."), "rejeita");
    // Recusa vence a aprovação contida nela.
    assert.equal(directionKind("Não ficou bom."), "rejeita");
  });

  it("fala do roteiro não é comentário (sem padrão, ou longa demais)", () => {
    assert.equal(directionKind("O PIB da IA cresce no Brasil."), null);
    assert.equal(directionKind("O modelo novo ficou muito bom em matemática segundo o relatório publicado ontem pela empresa."), null);
    assert.equal(directionKind(""), null);
  });

  it("regressão (self-review da PR #11373): fala do roteiro com palavra de comentário nunca vira comentário", () => {
    for (const line of [
      "É a primeira vez que a OpenAI lança isso.",
      "Foi o primeiro modelo a passar no teste.",
      "O modelo não é perfeito.",
      "Não é perfeito.",
      "A OpenAI subiu de novo o preço.",
      "O Gemini ficou muito bom em código.",
      "O resultado ficou muito bom.",
      "Mais uma vez, o Google atrasou.",
    ]) {
      assert.equal(directionKind(line), null, line);
    }
  });

  it("regressão: fala do roteiro no meio das tomadas não sai como bastidor nem decide a tomada anterior", () => {
    const segs = [
      seg("Google lança modo IA da Busca no Brasil.", 0),
      seg("Google lança modo IA da Busca no Brasil.", 4),
      seg("É a primeira vez que a busca tem agente.", 8),
    ];
    const d = decideTakes(segs);
    assert.deepEqual(d.cues, []);
    assert.equal(d.bySegment.get(2), undefined);
    // Sem a leitura errada como "aprova-primeira", vale a última completa (a 2ª), não a 1ª.
    assert.equal(d.bySegment.get(1)?.suggestion, "usar");
    assert.equal(d.bySegment.get(0)?.suggestion, "cortar");
    assert.doesNotMatch(segmentListing(segs), /bastidor/);
  });

  it("comentário com muleta na frente continua lido", () => {
    assert.equal(directionKind("Beleza, muito bom."), "aprova");
    assert.equal(directionKind("Espera, de novo."), "rejeita");
    assert.equal(directionKind("Ok, foi a primeira."), "aprova-primeira");
    assert.equal(directionKind("Esse take tá bom, é este take."), "aprova");
  });

  it("comentário entre as tomadas não quebra o grupo da frase", () => {
    const groups = groupTakes(SEGMENTS, { skip: new Set([3, 7, 9, 13]) });
    const comentario = groups.find((g) => g.segments.includes(8))!;
    assert.deepEqual(comentario.segments, [8, 10]);
    // Sem o skip, o "Errei, de novo." separava as duas tomadas (era o caso da 261028).
    assert.deepEqual(groupTakes(SEGMENTS).find((g) => g.segments.includes(8))!.segments, [8]);
  });
});

describe("decisão por critério: usar na tomada decidida, cortar nas outras (#11364)", () => {
  const { bySegment } = decideTakes(SEGMENTS);
  const at = (n1: number) => bySegment.get(n1 - 1);

  it("critério 1: a direção decide, mesmo contra a última tomada completa", () => {
    // Abertura: "a anterior tava melhor" depois da 2ª tomada = usar a 1ª.
    assert.equal(at(2)?.suggestion, "usar");
    assert.equal(at(2)?.criterion, "direcao");
    assert.equal(at(3)?.suggestion, "cortar");
    // Título: "foi o primeiro do começo" = a 1ª de 3.
    assert.equal(at(5)?.suggestion, "usar");
    assert.match(at(5)!.reason, /aprovada pela direção: "Foi o primeiro do começo\."/);
    assert.equal(at(6)?.suggestion, "cortar");
    assert.equal(at(7)?.suggestion, "cortar");
    assert.match(at(7)!.reason, /a direção aprovou a 1ª tomada/);
  });

  it("critério 3: a última completa, fora a recusada pela direção", () => {
    assert.equal(at(9)?.suggestion, "cortar");
    assert.match(at(9)!.reason, /a direção pediu outra/);
    assert.equal(at(11)?.suggestion, "usar");
    assert.equal(at(11)?.criterion, "ultima-completa");
  });

  it("tomada única aprovada sai 'usar' com o motivo; tomada única sem comentário fica para a skill", () => {
    assert.equal(at(13)?.suggestion, "usar");
    assert.match(at(13)!.reason, /aprovada pela direção: "Muito bom\."/);
    assert.equal(at(12), undefined);
  });

  it("comentário da direção é bastidor: cortar", () => {
    for (const n of [4, 8, 10, 14]) {
      assert.equal(at(n)?.suggestion, "cortar", `segmento ${n}`);
      assert.equal(at(n)?.criterion, "bastidor", `segmento ${n}`);
    }
  });

  it("nenhuma 'alternativa' sai da decisão: cada frase tem exatamente uma tomada 'usar'", () => {
    const usar = [...bySegment.values()].filter((d) => d.suggestion === "usar").map((d) => d.segment + 1).sort((a, b) => a - b);
    assert.deepEqual(usar, [2, 5, 11, 13]);
  });

  it("direção recusou todas as tomadas: sem critério (a dúvida real, retranscrever antes)", () => {
    const segs = [seg("O PIB da IA cresce no Brasil.", 0), seg("De novo.", 3), seg("O PIB da IA cresce no Brasil.", 5), seg("Errei.", 8)];
    const d = decideTakes(segs).bySegment;
    assert.equal(d.get(0)?.criterion, "sem-criterio");
    assert.equal(d.get(2)?.criterion, "sem-criterio");
    assert.match(segmentListing(segs), /conferir, nenhum critério decide .* retranscrever o trecho/);
  });

  it("listagem traz a decisão de cada tomada, com o critério", () => {
    const list = segmentListing(SEGMENTS);
    assert.match(list, /^5\. .*\(tomada 1 de 3: usar \(aprovada pela direção: "Foi o primeiro do começo\."\)\)$/m);
    assert.match(list, /^6\. .*\(tomada 2 de 3: cortar \(a direção aprovou a 1ª tomada\)\)$/m);
    assert.match(list, /^8\. .*\(direção: cortar \(bastidor: comentário da direção/m);
    assert.match(list, /^11\. .*\(tomada 2 de 2: usar \(2ª tomada, a última completa\)\)$/m);
  });
});

describe("plano conferido contra o critério (#11364)", () => {
  it("o plano que segue o critério passa sem erro nem aviso", () => {
    assert.deepEqual(checkDecupagemCriteria(GOOD_PLAN, SEGMENTS), { errors: [], warnings: [] });
  });

  it("regressão 261028: tomadas da mesma frase como 'usar' em sequência é erro (o XML sai com UMA montagem)", () => {
    const plan: DecupagemPlan = {
      edition: "261028",
      blocks: [{ key: "comentario", rows: [{ segments: [9], suggestion: "usar" }, { segments: [11], suggestion: "usar" }] }],
    };
    const { errors } = checkDecupagemCriteria(plan, SEGMENTS);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /segmentos 9 .* e 11 .* tomadas da mesma frase, as duas "usar"/);
  });

  it("regressão 261028: 'alternativa' onde a direção aprovou uma tomada é erro", () => {
    const plan: DecupagemPlan = {
      edition: "261028",
      blocks: [
        {
          key: "titulo",
          rows: [
            { segments: [7], suggestion: "usar" },
            { segments: [5], suggestion: "alternativa", reason: "dúvida" },
            { segments: [6], suggestion: "alternativa", reason: "dúvida" },
          ],
        },
      ],
    };
    const { errors, warnings } = checkDecupagemCriteria(plan, SEGMENTS);
    assert.equal(errors.filter((e) => /a direção aprovou o segmento 5/.test(e)).length, 2);
    // E o "usar" na 3ª contraria a direção: aviso.
    assert.ok(warnings.some((w) => /"usar" no segmento 7, mas a direção aprovou o segmento 5/.test(w)), warnings.join(" | "));
  });

  it("comentário da direção numa linha 'usar' é aviso (a conversa com a direção não vai para o vídeo)", () => {
    const plan: DecupagemPlan = { edition: "261028", blocks: [{ key: "fecho", rows: [{ segments: [13, 14], suggestion: "usar" }] }] };
    const { errors, warnings } = checkDecupagemCriteria(plan, SEGMENTS);
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => /segmento 14 é comentário da direção/.test(w)));
  });

  it("frases diferentes que só começam igual não viram erro de tomada duplicada", () => {
    const segs = [seg("O Google lançou o Gemini para todos.", 0), seg("O Google lançou também um navegador novo com agente.", 4)];
    const plan: DecupagemPlan = { edition: "261028", blocks: [{ key: "resumo", rows: [{ segments: [1], suggestion: "usar" }, { segments: [2], suggestion: "usar" }] }] };
    assert.deepEqual(checkDecupagemCriteria(plan, segs).errors, []);
  });

  it("regressão (self-review da PR #11373): frases curtas distintas com a mesma abertura não são tomada duplicada", () => {
    const segs = [seg("O Google lançou o Gemini.", 0), seg("O Google lançou o Veo.", 3)];
    const plan: DecupagemPlan = { edition: "261028", blocks: [{ key: "resumo", rows: [{ segments: [1], suggestion: "usar" }, { segments: [2], suggestion: "usar" }] }] };
    assert.deepEqual(checkDecupagemCriteria(plan, segs).errors, []);
  });

  it("o falso começo (prefixo inteiro da tomada) junto da tomada continua erro", () => {
    const segs = [seg("Uma atualização de", 0), seg("Uma atualização de privacidade do Google.", 2)];
    const plan: DecupagemPlan = { edition: "261028", blocks: [{ key: "titulo", rows: [{ segments: [1, 2], suggestion: "usar" }] }] };
    assert.equal(checkDecupagemCriteria(plan, segs).errors.length, 1);
  });

  it("bastidor fora do plano vira 'cortar (bastidor)' no Doc", () => {
    const doc = buildDecupagemDoc(GOOD_PLAN, SEGMENTS);
    const bast = doc.blocks.flatMap((b) => b.rows).filter((r) => r.bastidor);
    assert.deepEqual(bast.map((r) => r.segments), [[1], [4], [8], [10], [14]]);
    assert.ok(bast.every((r) => r.sugestao === "cortar (bastidor)"));
  });
});

describe("restrição de duração resolvida na decupagem (#11364)", () => {
  // Um comentário longo: 3:20 de bruto numa linha só.
  const long: Segment[] = [
    { start: 0, end: 4, text: "Google lança modo IA da Busca." },
    { start: 5, end: 205, text: "Comentário longo sobre o modo IA." },
    { start: 206, end: 209, text: "Até amanhã!" },
  ];
  const plan: DecupagemPlan = {
    edition: "261028",
    blocks: [
      { key: "titulo", rows: [{ segments: [1], suggestion: "usar" }] },
      { key: "comentario", rows: [{ segments: [2], suggestion: "usar" }] },
      { key: "fecho", rows: [{ segments: [3], suggestion: "usar" }] },
    ],
  };
  const doc = buildDecupagemDoc(plan, long);

  it("vertical acima de 3:00 aponta quanto passa; horizontal não tem teto", () => {
    const d = suggestedDurations(doc);
    const yt = d.find((x) => x.spec.target === "youtube")!;
    const ig = d.find((x) => x.spec.target === "outras-redes")!;
    assert.equal(yt.overS, 0);
    assert.equal(ig.totalS, 207);
    assert.equal(ig.overS, 207 - SHORTS_MAX_S);
  });

  it("a Montagem sugerida pede a proposta de corte, não repassa a restrição", () => {
    const md = decupagemMarkdown("261028", doc);
    const ig = md.slice(md.indexOf("### Vertical"));
    assert.match(ig, /\*\*Passa de 3:00 \(Shorts\) em ~27\.0 s\*\*.*propõe o corte/);
    const yt = md.slice(md.indexOf("### Horizontal YouTube"), md.indexOf("### Vertical"));
    assert.doesNotMatch(yt, /Passa de/);
  });
});

describe("retranscrição de trecho (#11364)", () => {
  it("janela curta, dentro do bruto", () => {
    assert.deepEqual(retranscribeWindow("120", "135", 600), { ok: true, window: { start: 120, end: 135 } });
    assert.deepEqual(retranscribeWindow("590", "610", 600), { ok: true, window: { start: 590, end: 600 } });
    assert.equal(retranscribeWindow(undefined, "10").ok, false);
    assert.equal(retranscribeWindow("10", "5").ok, false);
    assert.equal(retranscribeWindow("0", String(RETRANSCRIBE_MAX_S + 1)).ok, false);
    assert.equal(retranscribeWindow("700", "710", 600).ok, false);
  });

  it("os tempos da janela voltam para o tempo do bruto", () => {
    const t = offsetTranscript({ segments: [{ start: 0.5, end: 1.2, text: "foi o primeiro", words: [{ start: 0.5, end: 0.7, text: "foi" }] }] }, 120);
    assert.equal(t.segments[0].start, 120.5);
    assert.equal(t.segments[0].end, 121.2);
    assert.equal(t.segments[0].words![0].end, 120.7);
  });
});
