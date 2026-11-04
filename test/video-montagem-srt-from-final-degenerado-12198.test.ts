/**
 * #12198: na 261030 o export final foi reeditado depois do build (plan.json
 * defasado). O `srt --from-final` (#12078) forçou o roteiro gravado sobre a
 * fala: descartou 12 palavras ouvidas ("A dosagem que ela tomava era 400mg…",
 * 57,18 s em diante) e espremeu o trecho do roteiro que não foi falado em 4
 * legendas entre 00:00:52,760 e 00:00:53,120 (três de até 0,22 s, duas de
 * duração zero), e saiu 0. Agora a legenda imprópria vira `problems` (o CLI sai
 * 1 sem gravar) e `--heard-text` faz a legenda pela fala do export.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Word } from "../scripts/lib/diaria/video-montage.ts";
import { cueTimings, cuesToSrt, segmentCues } from "../scripts/lib/diaria/video-montage.ts";
import { EXPORT_SRT_LIMITS, exportSrtProblems, exportSrtRefusalHint, main, srtFromExport } from "../scripts/video-montagem.ts";

const say = (text: string, t0: number, dur = 0.3): Word[] =>
  text.split(" ").map((w, i) => ({ start: +(t0 + i * dur).toFixed(3), end: +(t0 + (i + 1) * dur).toFixed(3), text: w }));

const youtube = { target: "youtube" as const, width: 1920, height: 1080, name: "Diaria comentada_Youtube_V1", order: [], scales: [100, 110] as [number, number] };

// O roteiro do horizontal gravado no plan.json (antes da reedição no Premiere).
const script =
  "A paciente procurou o pronto-socorro com dor de cabeça forte. " +
  "O remédio que ela tomava era lamotrigina. A dosagem tinha mudado na semana anterior por causa do remédio. " +
  "Os médicos chegaram ao diagnóstico em dois dias.";

describe("#12198: export reeditado (caso 261030)", () => {
  // O export: a 1ª frase até 52,76 s, a última a partir de 53,12 s, e a fala nova que o editor regravou a partir de 57,18 s.
  const heard = [
    ...say("A paciente procurou o pronto-socorro com dor de cabeça forte.", 49.76),
    ...say("Os médicos chegaram ao diagnóstico em dois dias.", 53.12),
    ...say("A dosagem que ela tomava era 400mg por dia, o dobro.", 57.18),
  ];
  const plan = { spec: youtube, script };

  it("regressão: o roteiro forçado sobre o export reeditado é recusado, nomeando o trecho", () => {
    const { problems, srt } = srtFromExport({ heard, plan, rules: [], aliases: [], durationS: 70 });
    assert.ok(problems.length > 0, `legenda imprópria tem de virar problema; SRT: ${srt}`);
    const all = problems.join("\n");
    assert.match(all, /diverge do roteiro/);
    assert.match(all, /lamotrigina/, "nomeia o trecho do roteiro sem fala");
    assert.match(all, /400mg/, "nomeia a fala descartada");
  });

  it("as legendas espremidas (duração até 0,3 s) também viram problema, com tempo e texto", () => {
    const { problems } = srtFromExport({ heard, plan, rules: [], aliases: [], durationS: 70 });
    assert.ok(
      problems.some((p) => /legenda\(s\) com duração de até 0\.3 s/.test(p) && /00:00:5\d,\d{3} --> /.test(p)),
      problems.join("\n"),
    );
  });

  it("--heard-text: a legenda pela fala do export passa, com a fala nova e sem o roteiro velho", () => {
    const { problems, srt, notes } = srtFromExport({ heard, plan, rules: [], aliases: [], durationS: 70, text: "ouvido" });
    assert.deepEqual(problems, []);
    const flat = srt.replace(/\r?\n/g, " ");
    assert.ok(flat.includes("400mg"), "a fala ouvida entra");
    assert.ok(!flat.includes("lamotrigina"), "o trecho do roteiro que não foi falado não entra");
    assert.ok(notes.some((n) => n.startsWith("[premissa]") && n.includes("--heard-text")));
  });

  it("--heard-text: fala depois do fim do export sai e vira aviso", () => {
    const ouvido = srtFromExport({ heard, plan, rules: [], aliases: [], durationS: 57, text: "ouvido" });
    assert.ok(!ouvido.srt.includes("400mg"));
    assert.ok(ouvido.notes.some((n) => n.startsWith("[aviso]") && n.includes("depois do fim")));
  });
});

describe("#12198: export que casa com o roteiro continua passando", () => {
  it("fala igual ao roteiro, com respiros: sem problemas", () => {
    const text = "A paciente procurou o pronto-socorro com dor de cabeça forte. O remédio que ela tomava era lamotrigina.";
    const heard = [...say("A paciente procurou o pronto-socorro com dor de cabeça forte.", 4), ...say("O remédio que ela tomava era lamotrigina.", 8)];
    const { problems } = srtFromExport({ heard, plan: { spec: youtube, script: text }, rules: [], aliases: [], durationS: 20 });
    assert.deepEqual(problems, []);
  });

  it("fala depois do fim do export não conta como divergência", () => {
    const text = "A paciente procurou o pronto-socorro com dor de cabeça forte.";
    const heard = [...say(text, 1), ...say("E aí tchau pessoal", 30)];
    const { problems } = srtFromExport({ heard, plan: { spec: youtube, script: text }, rules: [], aliases: [], durationS: 10 });
    assert.deepEqual(problems, []);
  });
});

describe("#12198: exportSrtProblems (puro)", () => {
  const cue = (start: number, end: number, text = "x") => ({ start, end, text });

  it("legenda de duração zero ou até minCueS recusa no modo roteiro; acima, não", () => {
    assert.equal(exportSrtProblems({ cues: [cue(1, 1)], text: "roteiro" }).length, 1);
    assert.equal(exportSrtProblems({ cues: [cue(1, 1 + EXPORT_SRT_LIMITS.minCueS)], text: "roteiro" }).length, 1);
    assert.deepEqual(exportSrtProblems({ cues: [cue(1, 1.31)], text: "roteiro" }), []);
  });

  it("modo ouvido: só a legenda vazia recusa (os tempos são os da fala real)", () => {
    assert.deepEqual(exportSrtProblems({ cues: [cue(1, 1.2)], text: "ouvido" }), []);
    assert.equal(exportSrtProblems({ cues: [cue(1, 1)], text: "ouvido" }).length, 1);
  });

  it("divergência: acima de maxDivergence recusa; no limite, não", () => {
    const word = (t: number, text: string) => ({ start: t, end: t + 0.3, text });
    const aligned = { interpolated: ["a", "b"], dropped: [{ word: word(57.18, "400mg"), reason: "fora do roteiro" as const }] };
    assert.equal(exportSrtProblems({ cues: [], text: "roteiro", aligned, scriptWords: 20 }).length, 1, "3/20 = 15%");
    assert.deepEqual(exportSrtProblems({ cues: [], text: "roteiro", aligned, scriptWords: 30 }), [], "3/30 = 10%");
    assert.match(exportSrtProblems({ cues: [], text: "roteiro", aligned, scriptWords: 20 })[0], /00:00:57,180/);
  });

  it("cueTimings bate com os tempos do cuesToSrt", () => {
    const cues = segmentCues([...say("Bom dia.", 1), ...say("Tchau.", 1.7)]);
    const t = cueTimings(cues);
    assert.equal(t[0].end, 1.7, "fim = início da próxima quando o rabo de 0,3 s passaria dela");
    assert.match(cuesToSrt(cues), /00:00:01,000 --> 00:00:01,700/);
  });
});

describe("#12198: CLI", () => {
  it("--heard-text sem --from-final é recusado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-12198-"));
    const origErr = console.error;
    console.error = () => {};
    try {
      const base = ["srt", "261030", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir];
      await assert.rejects(main([...base, "--heard-text"]), /--heard-text só vale com --from-final/);
    } finally {
      console.error = origErr;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a mensagem de recusa diz o que fazer e que nada foi gravado", () => {
    const h = exportSrtRefusalHint("261030", "G:/261030/Final/x.mp4", "roteiro");
    assert.match(h, /NÃO gravado/);
    assert.match(h, /--from-final "G:\/261030\/Final\/x\.mp4" --heard-text/);
    assert.match(h, /build --seq youtube/);
    assert.match(h, /--captions-only/);
  });
});
