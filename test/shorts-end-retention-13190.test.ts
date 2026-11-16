/**
 * #13190 — queda de retenção no fim dos Shorts, separada pelo fim do vertical.
 * Só fixtures locais: nenhuma chamada de rede, nenhum dado real de `data/`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analisarFins,
  classificarFim,
  duracaoDoShort,
  elegivelParaGrupo,
  medirShort,
  palavrasPorMinuto,
  pearson,
  renderRelatorio,
  retencaoEm,
  spearman,
  type SequenceTranscript,
  type ShortInput,
} from "../scripts/lib/diaria/shorts-end-retention.ts";
import { indexarFontes, montarInputs } from "../scripts/shorts-end-retention.ts";

function seg(start: number, end: number, text: string) {
  return { start, end, text };
}

/** Curva linear de 1,0 (início) a `fim` (100%), passo 0,01. */
function curvaLinear(fim: number, inicio = 1): Array<[number, number]> {
  return Array.from({ length: 100 }, (_, i) => {
    const x = (i + 1) / 100;
    return [x, inicio + (fim - inicio) * x] as [number, number];
  });
}

describe("classificarFim (#13190)", () => {
  it("chamada para o vídeo completo (#12735), mesmo com a fala anterior no bloco", () => {
    const t: SequenceTranscript = {
      duration: 65.5,
      segments: [seg(52, 58, "E você precisa garantir que ele tenha qualidade."), seg(61, 65.4, "No vídeo completo no YouTube da Diária, eu dou três dicas.")],
    };
    const r = classificarFim(t);
    assert.equal(r.fim, "video-completo");
    assert.equal(r.inicioChamadaS, 61);
  });

  it("like/segue em vários segmentos, descartando a sobra curta da montagem", () => {
    const t: SequenceTranscript = {
      duration: 54.3,
      segments: [
        seg(42, 47.5, "essa palavra de segurança pode ser a chave."),
        seg(47.7, 49.8, "Gostou desse conteúdo? Dá um like."),
        seg(50.1, 54.0, "Segue a Diária para receber um vídeo como esse todos os dias."),
        seg(54.2, 54.3, "Segue a diária para receber um vídeo."),
      ],
    };
    const r = classificarFim(t);
    assert.equal(r.fim, "like-segue");
    assert.equal(r.inicioChamadaS, 47.7);
    assert.match(r.texto, /^Gostou desse conteúdo/);
  });

  it("pergunta ao público: bloco final de perguntas", () => {
    const t: SequenceTranscript = {
      duration: 69.6,
      segments: [seg(60.4, 63.1, "Foi isso que o juiz travou."), seg(63.3, 67.4, "E pra você, quem deve decidir?"), seg(67.5, 69.1, "O veículo ou a plataforma?")],
    };
    const r = classificarFim(t);
    assert.equal(r.fim, "pergunta");
    assert.equal(r.inicioChamadaS, 63.3);
  });

  it("sem chamada: termina no conteúdo, com 'Música'/'Outro.' de sobra", () => {
    const t: SequenceTranscript = {
      duration: 70.1,
      segments: [seg(60.3, 64.9, "Três. Se uma senha vazou, muda ela agora."), seg(65.2, 70, "A responsabilidade é sua."), seg(70, 70.1, "Outro."), seg(70.1, 70.1, "Música")],
    };
    const r = classificarFim(t);
    assert.equal(r.fim, "sem-chamada");
    assert.equal(r.inicioChamadaS, null);
  });

  it("sem transcrição = desconhecido", () => {
    assert.equal(classificarFim(null).fim, "desconhecido");
    assert.equal(classificarFim({ duration: 10, segments: [] }).fim, "desconhecido");
  });
});

describe("retencaoEm / duração / ritmo", () => {
  it("interpola entre os pontos da curva e satura nas pontas", () => {
    const pts: Array<[number, number]> = [
      [0.01, 1],
      [0.5, 0.6],
      [1, 0.2],
    ];
    assert.equal(retencaoEm(pts, 0), 1);
    assert.equal(retencaoEm(pts, 0.75), 0.4);
    assert.equal(retencaoEm(pts, 1), 0.2);
    assert.equal(retencaoEm([], 0.5), null);
  });

  it("duração vem da API (duração média / % média); sem métricas, da montagem", () => {
    const t: SequenceTranscript = { duration: 70, segments: [seg(0, 1, "oi")] };
    assert.deepEqual(duracaoDoShort({ transcript: t, averageViewDuration: 28, averageViewPercentage: 44 }), { duracaoS: 28 / 0.44, fonte: "api" });
    assert.deepEqual(duracaoDoShort({ transcript: t, averageViewDuration: 0, averageViewPercentage: 0 }), { duracaoS: 70, fonte: "montagem" });
    assert.deepEqual(duracaoDoShort({ transcript: null, averageViewDuration: 0, averageViewPercentage: 0 }), { duracaoS: null, fonte: null });
  });

  it("palavras por minuto de fala", () => {
    assert.equal(palavrasPorMinuto({ duration: 30, segments: [seg(0, 30, Array(60).fill("x").join(" "))] }), 120);
    assert.equal(palavrasPorMinuto(null), null);
  });
});

function short(over: Partial<ShortInput> = {}): ShortInput {
  return {
    videoId: "v1",
    title: "T",
    edition: "261111",
    peca: "vertical1",
    views: 500,
    averageViewPercentage: 50,
    averageViewDuration: 30,
    points: curvaLinear(0.4),
    transcript: { duration: 60, segments: [seg(0, 54, "conteúdo"), seg(54.5, 59.5, "Gostou desse vídeo? Dá um like.")] },
    ...over,
  };
}

describe("medirShort", () => {
  it("mede a cauda, a razão cauda/corpo e a queda durante a chamada", () => {
    const m = medirShort(short(), 3);
    // Duração da API: 30 / 0,5 = 60 s. Cauda de 3 s começa em 95%.
    assert.equal(m.duracaoS, 60);
    assert.equal(m.montagemConfere, true);
    assert.equal(m.rInicioCauda, 0.43);
    assert.equal(m.r100, 0.4);
    assert.equal(m.quedaCauda, 0.03);
    // Curva linear: a cauda cai na mesma velocidade do corpo.
    assert.equal(m.razaoCaudaCorpo, 1);
    assert.equal(m.fim, "like-segue");
    assert.equal(m.chamadaS, 5.5);
  });

  it("montagem que não confere com o publicado (> 15%) fica fora dos grupos e não posiciona a chamada", () => {
    const m = medirShort(short({ transcript: { duration: 211, segments: [seg(0, 200, "x"), seg(206, 210.9, "dá um like e segue a diária")] } }));
    assert.equal(m.montagemConfere, false);
    assert.equal(m.fim, "like-segue");
    assert.equal(m.quedaChamadaRel, null);
    assert.equal(m.palavrasPorMin, null);
    assert.equal(elegivelParaGrupo(m, 100), false);
  });
});

describe("analisarFins", () => {
  it("agrupa por fim e no binário com x sem chamada, respeitando min-views", () => {
    const semChamada: SequenceTranscript = { duration: 60, segments: [seg(0, 59, "conteúdo até o fim.")] };
    const a = analisarFins(
      [
        short({ videoId: "a", views: 1000 }),
        short({ videoId: "b", views: 800, transcript: semChamada, points: curvaLinear(0.2) }),
        short({ videoId: "c", views: 50, transcript: semChamada }),
        short({ videoId: "d", views: 900, transcript: null }),
      ],
      { minViews: 100 },
    );
    assert.deepEqual(
      a.porFim.map((g) => [g.grupo, g.n]),
      [
        ["chamada like/segue", 1],
        ["sem chamada", 1],
      ],
    );
    assert.deepEqual(
      a.binario.map((g) => [g.grupo, g.n]),
      [
        ["com chamada final", 1],
        ["sem chamada final", 1],
      ],
    );
    assert.equal(a.shorts.length, 4);
    const md = renderRelatorio(a, { snapshotDate: "2026-11-16", janela: "x" });
    assert.match(md, /## Com x sem chamada final/);
    assert.match(md, /sem transcrição/);
  });

  it("correlações: Pearson e Spearman", () => {
    assert.equal(pearson([1, 2, 3], [2, 4, 6]), 1);
    assert.equal(spearman([1, 2, 3, 4], [10, 9, 8, 1]), -1);
    assert.equal(pearson([1, 2], [1, 2]), null);
  });
});

describe("CLI: montarInputs liga videoId à peça e à transcrição (#13190)", () => {
  it("vertical da edição = vertical1 (seq-outras-redes); corte {nome}-{AAMMDD} = corte (seq-{nome})", () => {
    const root = mkdtempSync(join(tmpdir(), "shorts-end-13190-"));
    const ed = join(root, "editions", "2611", "261111", "_internal");
    mkdirSync(join(ed, "video-montagem"), { recursive: true });
    writeFileSync(
      join(ed, "06-shorts-published.json"),
      JSON.stringify({ aammdd: "261111", entries: [{ destination: "youtube_shorts", id: "EDI1aaaaaaa", url: "https://youtube.com/shorts/EDI1aaaaaaa", at: "2026-11-10T22:00:00Z", status: "published" }] }),
    );
    writeFileSync(join(ed, "video-montagem", "seq-outras-redes.transcript.json"), JSON.stringify({ duration: 60, segments: [seg(0, 59, "fim sem chamada.")] }));
    writeFileSync(join(ed, "video-montagem", "seq-automacao.transcript.json"), JSON.stringify({ duration: 60, segments: [seg(0, 54, "x"), seg(55, 59, "dá um like")] }));
    const corte = join(root, "cortes", "automacao-261111");
    mkdirSync(join(corte, "_internal"), { recursive: true });
    writeFileSync(join(corte, "corte.json"), JSON.stringify({ slug: "automacao-261111", date: "261113" }));
    writeFileSync(
      join(corte, "_internal", "06-shorts-published.json"),
      JSON.stringify({ aammdd: "261113", entries: [{ destination: "youtube_shorts", id: "COR1bbbbbbb", at: "2026-11-12T22:00:00Z", status: "scheduled" }] }),
    );
    writeFileSync(join(root, "cortes", ".heartbeat.json"), "{}");

    const fontes = indexarFontes(root, () => {});
    assert.equal(fontes.get("EDI1aaaaaaa")?.peca, "vertical1");
    assert.equal(fontes.get("COR1bbbbbbb")?.peca, "corte");
    assert.equal(fontes.get("COR1bbbbbbb")?.edition, "261111");

    const yt = join(root, "youtube-analytics");
    mkdirSync(yt, { recursive: true });
    const v = (videoId: string, date: string) => ({
      capturedAt: `${date}T12:00:00Z`,
      date,
      videoId,
      title: videoId,
      kind: "short",
      edition: null,
      startDate: "2026-10-21",
      endDate: "2026-11-15",
      views: 300,
      estimatedMinutesWatched: 1,
      averageViewDuration: 30,
      averageViewPercentage: 50,
      subscribersGained: 0,
      subscribersLost: 0,
    });
    writeFileSync(join(yt, "videos.jsonl"), [v("EDI1aaaaaaa", "2026-11-15"), v("EDI1aaaaaaa", "2026-11-16"), v("COR1bbbbbbb", "2026-11-16")].map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(
      join(yt, "retention.jsonl"),
      [
        { capturedAt: "2026-11-16T12:00:00Z", date: "2026-11-16", videoId: "EDI1aaaaaaa", points: curvaLinear(0.3) },
        { capturedAt: "2026-11-16T12:00:00Z", date: "2026-11-16", videoId: "COR1bbbbbbb", points: curvaLinear(0.5) },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );

    const m = montarInputs(root, null, () => {});
    assert.ok(m);
    assert.equal(m.snapshotDate, "2026-11-16");
    const fins = analisarFins(m.inputs, { minViews: 100 }).shorts.map((s) => [s.videoId, s.peca, s.fim]);
    assert.deepEqual(fins.sort(), [
      ["COR1bbbbbbb", "corte", "like-segue"],
      ["EDI1aaaaaaa", "vertical1", "sem-chamada"],
    ]);
    assert.equal(montarInputs(root, "2026-01-01", () => {}), null);
  });
});
