/**
 * #13587 (item A da #13463): tomada colapsada resolvida na 1ª passada da
 * decupagem, com retranscrição dirigida. Fixtures sintéticas no formato do
 * `transcript.json`/`retranscribe-*.json`, com os tempos da 261118 (gancho H1,
 * H7 e H12, os três que mais se moveram entre o molde e o `blocks.json`
 * aprovado). O Whisper entra mockado (`transcribeWindows`): nada roda Python.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECUPAGEM_SEGMENTS_FILE,
  collapsedSegmentJobs,
  expandCollapsedSegments,
  freezeListing,
  listingSegments,
  resolveCollapsedListing,
  retranscribeKey,
  subWindowFileName,
  windowFileName,
  type CollapsedListingIO,
} from "../scripts/lib/diaria/video-decupagem-collapsed.ts";
import { blocksFromDecupagem, buildDecupagemDoc, parseDecupagemPlan, segmentListing } from "../scripts/lib/diaria/video-montage-docs.ts";
import { resolveBlocks, type BlocksFile, type Segment, type Transcript, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { TRANSCRIPT_DERIVED } from "../scripts/video-montagem.ts";

/** Palavras com a duração dada, coladas (ou a partir dos inícios dados). */
function words(text: string, start: number, step = 0.3): Word[] {
  return text.split(" ").map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step - 0.02).toFixed(3) }));
}
function seg(ws: Word[]): Segment {
  return { start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.text).join(" "), words: ws };
}

// ── 261118: os três segmentos colapsados, no formato do transcript longo ───

/** Antes do gancho: "De todo modo, neste canal…" (H14), termina em 906,99. */
const BEFORE_GANCHO = seg(words("De todo modo, neste canal, eu te conto daqui a uns meses se eles subiram ou não.", 902.35, 0.25));
/** Gancho H1: "Oito" no começo da 1ª tomada (906,99) e o resto esticado sobre 13 s de tomadas (o Whisper colou). */
const GANCHO = seg([{ text: "Oito", start: 906.99, end: 907.4 }, ...words("dias atrás eu fiz três previsões.", 921.12, 0.3)]);
const AFTER_GANCHO = seg(words("Duas aconteceram.", 924.2, 0.7));
/** A retranscrição da janela do gancho: ouviu só a última tomada (920,6). */
const GANCHO_RETRANSCRIBED: Transcript = {
  segments: [seg([{ text: "Oito", start: 920.6, end: 921.12 }, ...words("dias atrás eu fiz três previsões.", 921.12, 0.3)])],
};

/** H7 no transcript antigo: as 3 tomadas coladas num segmento só, 386,35–434,51. */
const BEFORE_H7 = seg(words("E quatro países da Ásia também.", 384.41, 0.32));
const H7 = seg([
  ...words("A venda de chips", 386.35, 0.3),
  { text: "de", start: 387.6, end: 425.9 }, // a palavra esticada sobre as tomadas
  ...words("IA mais avançados vai precisar de licença dos Estados Unidos quando essa venda for realizada para cá, para o Brasil e para esses outros países.", 426.2, 0.3),
]);
const AFTER_H7 = seg(words("Isso vale a partir do dia 19.", 462.98, 0.25));
/** A retranscrição da janela de H7: as 3 tomadas separadas, a última em 425,58 (como no `retranscribe-385.9-435.0.json`). */
const H7_RETRANSCRIBED: Transcript = {
  segments: [
    seg(words("A venda de chips de IA mais avançados...", 403.64, 0.7)),
    seg(words("A venda de chips de IA mais avançados vai precisar de licença para virem para o...", 414.48, 0.4)),
    seg(words("A venda de chips de IA mais avançados vai precisar de licença dos Estados Unidos", 425.58, 0.33)),
    seg(words("quando essa venda for realizada para cá, para o Brasil e para esses outros países.", 430.78, 0.25)),
  ],
};

/** H12 no transcript antigo: 843,81–873,92, com o vão de 20 s antes de "Essa norma". */
const BEFORE_H12 = seg(words("Tá aí o porquê.", 843.07, 0.18));
const H12 = seg([{ text: "Essa", start: 843.81, end: 844.3 }, ...words("norma criada pelo governo dos Estados Unidos, mesmo que eventualmente não impacte os preços, vai atrasar projetos de IA aqui no Brasil.", 864.88, 0.4)]);
const AFTER_H12 = seg(words("E você acha que os preços vão subir?", 891.37, 0.22));
const H12_RETRANSCRIBED: Transcript = {
  segments: [
    seg(words("Caiu por quê?", 843.3, 0.16)),
    seg(words("Essa norma criada pelo governo dos Estados Unidos, mesmo que eventualmente não impacte os preços,", 864.2, 0.43)),
    seg(words("vai atrasar projetos de IA aqui no Brasil.", 871.5, 0.3)),
  ],
};

/** Os 3 casos num transcript só, com o segmento antes e depois de cada um. */
const TRANSCRIPT: Segment[] = [BEFORE_H7, H7, AFTER_H7, BEFORE_H12, H12, AFTER_H12, BEFORE_GANCHO, GANCHO, AFTER_GANCHO];
const DURATION = 1185.667;
/** As bordas aprovadas no `blocks.json` final da 261118 (Gate 2). */
const APPROVED = { H7: 424.3, H12: 863.0, gancho: 919.9 };

function jobsAndWindows() {
  const jobs = collapsedSegmentJobs(TRANSCRIPT, [], DURATION);
  const byOriginal = new Map(jobs.map((j) => [j.segment, j]));
  const store = new Map<string, Transcript>();
  store.set(byOriginal.get(1)!.key, H7_RETRANSCRIBED);
  store.set(byOriginal.get(4)!.key, H12_RETRANSCRIBED);
  store.set(byOriginal.get(7)!.key, GANCHO_RETRANSCRIBED);
  return { jobs, store };
}

test("#13587: os 3 segmentos colapsados da 261118 viram pedidos de retranscrição, com a janela do aviso de hoje e o nome do retranscribe", () => {
  const jobs = collapsedSegmentJobs(TRANSCRIPT, [], DURATION);
  assert.deepEqual(jobs.map((j) => j.segment), [1, 4, 7]);
  for (const j of jobs) {
    assert.equal(j.key, retranscribeKey(j.window));
    assert.ok(j.window.start <= TRANSCRIPT[j.segment].start && j.window.end >= TRANSCRIPT[j.segment].end, "a janela cobre o segmento inteiro (menos de 60 s)");
  }
  assert.equal(windowFileName(jobs[2].key), `retranscribe-${jobs[2].key}.json`);
  assert.equal(subWindowFileName("1.0-5.0"), "retranscribe-sub-1.0-5.0.json");
});

test("#13587 aceite: com as retranscrições, o molde de H7, H12 e do gancho H1 começa na tomada aprovada (hoje 12,9 a 37,9 s antes)", () => {
  const { jobs, store } = jobsAndWindows();
  const exp = expandCollapsedSegments(TRANSCRIPT, jobs, (k) => store.get(k) ?? null);
  assert.equal(exp.resolved, 3);
  assert.deepEqual(exp.unresolved, []);
  // H7 virou 4 tomadas, H12 2 (o "Caiu por quê?" é do segmento anterior), o gancho 1 (só a última foi ouvida).
  const fromH7 = exp.origin.map((o, i) => [o, i] as const).filter(([o]) => o.original === 2).map(([, i]) => i);
  const fromH12 = exp.origin.map((o, i) => [o, i] as const).filter(([o]) => o.original === 5).map(([, i]) => i);
  const fromGancho = exp.origin.map((o, i) => [o, i] as const).filter(([o]) => o.original === 8).map(([, i]) => i);
  assert.equal(fromH7.length, 4);
  assert.equal(fromH12.length, 2);
  assert.equal(fromGancho.length, 1);
  for (const i of [...fromH7, ...fromH12, ...fromGancho]) assert.ok(exp.origin[i].retranscribed && /retranscrito/.test(exp.origin[i].note ?? ""));
  // O plano da skill, nos números da listagem expandida: a última tomada de H7 (as duas partes), H12 inteiro, o gancho.
  const n = (i: number) => i + 1;
  const plan = {
    edition: "261118",
    blocks: [
      { key: "gancho", rows: [{ segments: [n(fromGancho[0])], suggestion: "usar", falaId: "H1" }] },
      {
        key: "comentario",
        rows: [
          { segments: [n(fromH7[2]), n(fromH7[3])], suggestion: "usar", falaId: "H7" },
          { segments: [n(fromH7[0])], suggestion: "cortar", reason: "1ª tomada, incompleta" },
          { segments: [n(fromH7[1])], suggestion: "cortar", reason: "2ª tomada, incompleta" },
          { segments: [n(fromH12[0]), n(fromH12[1])], suggestion: "usar", falaId: "H12" },
        ],
      },
    ],
  };
  const parsed = parseDecupagemPlan(plan, exp.segments.length);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
  const tpl = blocksFromDecupagem(buildDecupagemDoc(parsed.plan, exp.segments));
  const start = (id: string) => [...tpl.gancho, ...tpl.comentario].find((it) => it.falaId === id)!.start!;
  // Hoje: o molde herdava o segmento colapsado inteiro.
  assert.ok(APPROVED.gancho - GANCHO.start > 12.9 - 1e-6 && APPROVED.H7 - H7.start > 37.9 - 1e-6 && APPROVED.H12 - H12.start > 19.1);
  // Gancho: 0,6 s do aprovado (a borda da palavra retranscrita, 920,6, com o ar de 0,3 s do roteiro).
  assert.ok(Math.abs(start("H1") - APPROVED.gancho) <= 0.6, `gancho começa em ${start("H1")}`);
  assert.equal(start("H1"), 920.3);
  // H7 e H12: na tomada certa, a menos de 1 s do aprovado. A diferença que sobra é o ar que o editor abriu à mão no Gate 2
  // (424,3 e 863,0, ~1 s antes da 1ª palavra que QUALQUER retranscrição da 261118 ouviu, inclusive as subjanelas: 425,48 e 864,0).
  assert.equal(start("H7"), 425.28);
  assert.equal(start("H12"), 863.9);
  assert.ok(Math.abs(start("H7") - APPROVED.H7) < 1 && Math.abs(start("H12") - APPROVED.H12) < 1);
  // O fim também vem da palavra retranscrita, nunca passando da fala seguinte.
  const h7 = tpl.comentario.find((it) => it.falaId === "H7")!;
  assert.ok(h7.end! <= AFTER_H7.start);
});

test("#13587: a borda da tomada separada nunca invade a palavra do segmento vizinho", () => {
  // Retranscrição que ouviu a 1ª palavra encostada no fim do segmento anterior.
  const before = seg(words("Fala anterior termina aqui.", 10, 0.3));
  const collapsed = seg([{ text: "Começa", start: 11.3, end: 11.6 }, ...words("a frase de novo.", 20, 0.3)]);
  const jobs = collapsedSegmentJobs([before, collapsed], [], 100);
  assert.equal(jobs.length, 1);
  const patch: Transcript = { segments: [seg(words("Começa a", 11.25, 0.3)), seg(words("Começa a frase de novo.", 19.7, 0.3))] };
  const exp = expandCollapsedSegments([before, collapsed], jobs, () => patch);
  assert.equal(exp.segments.length, 3);
  assert.ok(exp.segments[1].start >= before.end, `${exp.segments[1].start} >= ${before.end}`);
});

test("#13587: janela que achou uma tomada só e não fecha a frase, ou que não cobre o segmento, deixa o segmento como estava", () => {
  const { jobs } = jobsAndWindows();
  const partial: Transcript = { segments: [seg(words("A venda de chips", 403.64, 0.7))] };
  const exp = expandCollapsedSegments(TRANSCRIPT, jobs, (k) => (k === jobs[0].key ? partial : null));
  assert.equal(exp.resolved, 0);
  assert.deepEqual(exp.unresolved.map((u) => u.reason), ["uma-tomada", "sem-retranscricao", "sem-retranscricao"]);
  assert.equal(exp.segments.length, TRANSCRIPT.length);
  assert.match(exp.origin[1].note ?? "", /achou uma tomada só/);
  // Segmento de mais de 60 s: a janela do aviso (60 s) não cobre tudo.
  const long = seg([...words("Começo da fala", 100, 0.3), { text: "longa", start: 101, end: 170 }, ...words("fim.", 170.2, 0.3)]);
  const j2 = collapsedSegmentJobs([long], [], 500);
  const e2 = expandCollapsedSegments([long], j2, () => ({ segments: [seg(words("Começo", 100, 0.3)), seg(words("fim.", 170.2, 0.3))] }));
  assert.deepEqual(e2.unresolved.map((u) => u.reason), ["janela-parcial"]);
});

/** IO mockado: o "Whisper" grava o que `answers` tem para a chave e conta as chamadas. */
function mockIO(answers: Map<string, Transcript>, opts: { audio?: boolean; preset?: Map<string, Transcript> } = {}) {
  const files = new Map<string, Transcript>(opts.preset ?? []);
  const calls: Array<{ kind: string; keys: string[] }> = [];
  const io: CollapsedListingIO = {
    readWindow: (k) => files.get(windowFileName(k)) ?? null,
    readSub: (k) => files.get(subWindowFileName(k)) ?? null,
    transcribeWindows: (wins, kind) => {
      if (opts.audio === false) return false;
      calls.push({ kind, keys: wins.map((w) => w.key) });
      for (const w of wins) {
        const t = answers.get(w.key) ?? { segments: [] };
        files.set(kind === "sub" ? subWindowFileName(w.key) : windowFileName(w.key), kind === "sub" ? { ...t, sub: { window: { start: w.start, end: w.end } } } : t);
      }
      return true;
    },
  };
  return { io, calls, files };
}

test("#13587: a 1ª passada retranscreve todas as janelas que faltam numa chamada só e expande a listagem", () => {
  const { store } = jobsAndWindows();
  const { io, calls } = mockIO(store);
  const res = resolveCollapsedListing(TRANSCRIPT, [], DURATION, io);
  assert.equal(calls.length, 1, "uma chamada do Whisper para as 3 janelas");
  assert.equal(calls[0].kind, "janela");
  assert.equal(calls[0].keys.length, 3);
  assert.deepEqual(res.transcribed, { windows: 3, subs: 0 });
  assert.equal(res.resolved, 3);
  assert.equal(res.segments.length, TRANSCRIPT.length - 3 + 4 + 2 + 1);
  // A listagem numerada traz a nota da tomada separada.
  const listing = segmentListing(res.segments, undefined, res.origin.map((o) => o.note));
  assert.match(listing, /retranscrito: parte 3 de 4 do segmento 2 do transcript/);
  assert.match(listing, /retranscrito: a tomada separada do segmento 8 do transcript/);
});

test("#13587: retranscrição já gravada (o retranscribe à mão) é reaproveitada, sem chamar o Whisper", () => {
  const { store } = jobsAndWindows();
  const preset = new Map([...store].map(([k, v]) => [windowFileName(k), v]));
  const { io, calls } = mockIO(new Map(), { preset });
  const res = resolveCollapsedListing(TRANSCRIPT, [], DURATION, io);
  assert.equal(calls.length, 0);
  assert.equal(res.resolved, 3);
});

test("#13587: onde a janela achou uma tomada só, as subjanelas (--sub) rodam numa 2ª chamada só e o falso começo vai na linha", () => {
  // "duas… dois… duas linhas" (#11958): uma palavra esticada, e a janela ouve uma tomada só.
  const s = seg([...words("O modelo tem", 50, 0.3), { text: "duas", start: 51, end: 54.5 }, ...words("linhas de código.", 54.6, 0.3)]);
  const jobs = collapsedSegmentJobs([s], [], 200);
  assert.equal(jobs.length, 1);
  // A janela inteira também esticou o "duas" sobre o falso começo (#11958): uma tomada só, com o vão.
  const answers = new Map<string, Transcript>([[jobs[0].key, { segments: [seg([...words("O modelo tem", 50, 0.3), { text: "duas", start: 51, end: 54.4 }, ...words("linhas de código.", 54.6, 0.3)])] }]]);
  // As subjanelas ouvem o falso começo: "duas" em 51, "dois" em 52, e a repetição final "duas linhas" em 54.
  const subWords = [...words("O modelo tem", 50, 0.3), { text: "duas", start: 51, end: 51.4 }, { text: "dois", start: 52, end: 52.4 }, { text: "duas", start: 54.0, end: 54.4 }, ...words("linhas de código.", 54.6, 0.3)];
  const { io, calls } = mockIO(answers);
  const wrapped: CollapsedListingIO = {
    ...io,
    transcribeWindows: (wins, kind) => {
      if (kind === "sub") for (const w of wins) answers.set(w.key, { segments: [{ start: w.start, end: w.end, text: "", words: subWords.filter((x) => x.start >= w.start && x.end <= w.end) }] });
      return io.transcribeWindows(wins, kind);
    },
  };
  const res = resolveCollapsedListing([s], [], 200, wrapped);
  assert.deepEqual(calls.map((c) => c.kind), ["janela", "sub"]);
  assert.ok(calls[1].keys.length >= 2);
  assert.deepEqual(res.unresolved.map((u) => u.reason), ["uma-tomada"]);
  assert.equal(res.segments.length, 1, "o segmento segue inteiro: o corte do falso começo é do roteiro");
  assert.match(res.origin[0].note ?? "", /falso começo "duas dois" em 50\.88–54\.00 s \(subjanelas\)/);
});

test("#13587: sem o áudio nesta máquina, nada é retranscrito e as suspeitas ficam como aviso", () => {
  const { io, calls } = mockIO(new Map(), { audio: false });
  const res = resolveCollapsedListing(TRANSCRIPT, [], DURATION, io);
  assert.equal(calls.length, 0);
  assert.equal(res.audioMissing, true);
  assert.equal(res.resolved, 0);
  assert.equal(res.segments.length, TRANSCRIPT.length);
  assert.ok(res.origin.filter((o) => o.note).every((o) => /sem retranscrição/.test(o.note!)));
});

test("#13587: --no-retranscribe não chama o Whisper, mas usa o que já está gravado", () => {
  const { store } = jobsAndWindows();
  const first = [...store][0];
  const { io, calls } = mockIO(new Map(), { preset: new Map([[windowFileName(first[0]), first[1]]]) });
  const res = resolveCollapsedListing(TRANSCRIPT, [], DURATION, io, { retranscribe: false });
  assert.equal(calls.length, 0);
  assert.equal(res.resolved, 1);
});

test("#13587: a listagem congelada numera a 2ª passada; de outro transcript é erro, ausente cai no transcript", () => {
  const { store } = jobsAndWindows();
  const { io } = mockIO(store);
  const res = resolveCollapsedListing(TRANSCRIPT, [], DURATION, io);
  const frozen = JSON.parse(JSON.stringify(freezeListing("261118", TRANSCRIPT, res)));
  assert.deepEqual(listingSegments(TRANSCRIPT, frozen, "261118").segments, res.segments);
  assert.deepEqual(listingSegments(TRANSCRIPT, null, "261118"), { segments: TRANSCRIPT, origin: null });
  const changed = TRANSCRIPT.map((s, i) => (i === 0 ? { ...s, text: s.text + " " } : s));
  assert.throws(() => listingSegments(changed, frozen, "261118"), /outro transcript\.json/);
  assert.throws(() => listingSegments(TRANSCRIPT, frozen, "261119"), /edição 261118/);
  assert.throws(() => listingSegments(TRANSCRIPT, { segments: 1 }, "261118"), /ilegível/);
  // Transcript novo põe a listagem de lado junto com o plano (#11603).
  assert.ok((TRANSCRIPT_DERIVED as readonly string[]).includes(DECUPAGEM_SEGMENTS_FILE));
});

test("#13587: no roteiro, o intervalo do molde que já é a tomada separada não volta a avisar tomada colapsada", () => {
  const { jobs, store } = jobsAndWindows();
  const exp = expandCollapsedSegments(TRANSCRIPT, jobs, (k) => store.get(k) ?? null);
  const gancho = exp.segments[exp.origin.findIndex((o) => o.original === 8)];
  const file: BlocksFile = { edition: "261118", blocks: { gancho: [{ start: gancho.start, end: gancho.end, text: "Oito dias atrás eu fiz três previsões." }] } } as unknown as BlocksFile;
  const rawWords = TRANSCRIPT.flatMap((s) => s.words ?? []);
  const retranscribed = [store.get(jobs[2].key)!];
  const r = resolveBlocks(file, rawWords, { durationS: DURATION, retranscribed });
  assert.deepEqual(r.errors, []);
  assert.equal(r.blocks.gancho![0].interval.start, 920.3);
  assert.equal(r.blocks.gancho![0].collapsed, undefined);
  assert.ok(!r.warnings.some((w) => /tomada colapsada/.test(w)), r.warnings.join("\n"));
  // O molde antigo (o segmento colapsado inteiro) continua avisando e segue inteiro: a retranscrição achou uma tomada só ali.
  const old: BlocksFile = { edition: "261118", blocks: { gancho: [{ start: GANCHO.start, end: GANCHO.end, text: "Oito dias atrás eu fiz três previsões." }] } } as unknown as BlocksFile;
  const r2 = resolveBlocks(old, rawWords, { durationS: DURATION, retranscribed });
  assert.ok(r2.warnings.some((w) => /tomada colapsada/.test(w)));
});
