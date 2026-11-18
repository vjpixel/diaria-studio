/**
 * #13372 — OpenTimelineIO como 2º leitor independente do XML no verify-xml.
 *
 * O lado "próprio" é o XML que o `buildXmeml` gera de verdade (vinheta com o
 * clipe partido #13249, faixa tratada, card de CTA, marcador de tela), lido
 * por `parseXmlAudio`. O lado OTIO é a saída REAL do `otio_read_xml.py`
 * (OpenTimelineIO 0.18.1 + otio-fcp-adapter 1.0.0) para esse mesmo XML,
 * capturada em 17/11/2026 (só as faixas de áudio). O teste ao vivo no fim
 * roda o adapter de verdade quando DIARIA_OTIO_PYTHON aponta um Python com ele.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSequencePlan, buildXmeml, type ResolvedItem, type SequenceSpec, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { parseXmlAudio } from "../scripts/lib/diaria/video-xml-verify.ts";
import {
  compareOtioWithOwn,
  otioCheckLines,
  otioCrossCheck,
  otioSpeechClips,
  parseOtioReaderOutput,
  pickOtioTimeline,
  resolveOtioPython,
  type OtioSpawn,
  type OtioTimeline,
} from "../scripts/lib/diaria/video-xml-otio.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "video", "otio_read_xml.py");

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (interval: { start: number; end: number }, text: string, words: Word[]): ResolvedItem =>
  ({ interval, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: interval.end + 2, how: "explicit" }) as ResolvedItem;
const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [100, 115] };
const single: SourceInfo = { path: "G:/x/bruto.mp4", fps: 30, durationS: 30, width: 3840, height: 2160, mirrored: false };
const resolved = {
  titulo: [item({ start: 1, end: 3 }, "titulo", [w("titulo", 1.2, 2.6)])],
  comentario: [item({ start: 10, end: 14 }, "um dois", [w("um", 10.2, 11), w("dois", 11.1, 13.6)]), item({ start: 18, end: 22 }, "tres", [w("tres", 18.2, 21.6)])],
};
const plan = buildSequencePlan(spec, resolved, [], single, {});
const CARD_FRAMES = 90;
const xml = buildXmeml([plan], single, { faceX: 0.5, eyeY: 0.5 }, {
  audioPath: "G:/x/tratado.wav",
  vinheta: { path: "G:/x/vinheta.mov", durationS: 2, width: 1920, height: 1080, hasAudio: true },
  ctaCard: { youtube: { path: "/o/card.mp4", xmlPath: "G:/x/card.mp4", width: 1920, height: 1080, fps: 30, frames: CARD_FRAMES, share: "x" } },
  telaMarkers: { youtube: [{ id: "f1", tela: "Texto & <tela>", in: 70, out: 120 }] },
});
const own = parseXmlAudio(xml);

/** Saída real do adapter para `xml` acima (faixas de vídeo omitidas). */
const otioReal = (): OtioTimeline => ({
  name: "Diaria comentada_Youtube_V1",
  durationFrames: 390,
  rate: 30,
  tracks: [
    {
      kind: "Audio",
      name: "",
      items: [
        { recStart: 0, recEnd: 57, type: "clip", name: "titulo", srcStart: 30, srcEnd: 87, url: "file://localhost/G:/x/tratado.wav" },
        { recStart: 57, recEnd: 60, type: "clip", name: "titulo", srcStart: 87, srcEnd: 90, url: "file://localhost/G:/x/tratado.wav" },
        { recStart: 60, recEnd: 180, type: "clip", name: "comentario", srcStart: 300, srcEnd: 420, url: "file://localhost/G:/x/tratado.wav" },
        { recStart: 180, recEnd: 300, type: "clip", name: "comentario", srcStart: 540, srcEnd: 660, url: "file://localhost/G:/x/tratado.wav" },
      ],
    },
    {
      kind: "Audio",
      name: "",
      items: [
        { recStart: 0, recEnd: 57, type: "gap" },
        { recStart: 57, recEnd: 117, type: "clip", name: "vinheta-logo", srcStart: 0, srcEnd: 60, url: "file://localhost/G:/x/vinheta.mov" },
      ],
    },
  ],
});
const expectedTotal = plan.durationFrames + CARD_FRAMES;

describe("#13372 compareOtioWithOwn", () => {
  it("o fixture próprio é o que o OTIO leu: 3 clipes, vinheta partindo o 1º, card no fim", () => {
    assert.equal(own.clips.length, 3);
    assert.equal(plan.durationFrames, 300);
    assert.equal(own.clips[own.clips.length - 1].end, 300);
  });

  it("XML real do build: os dois leitores concordam (o clipe partido sob a vinheta volta a ser um, a vinheta fica de fora)", () => {
    const speech = otioSpeechClips(otioReal());
    assert.deepEqual(speech?.map((c) => [c.start, c.end, c.in, c.out]), own.clips.map((c) => [c.start, c.end, c.in, c.out]));
    assert.deepEqual(compareOtioWithOwn(own, otioReal(), expectedTotal), []);
  });

  it("in/out divergente: acusa o clipe com os dois lados", () => {
    const tl = otioReal();
    tl.tracks[0].items[2] = { ...tl.tracks[0].items[2], srcStart: 301, srcEnd: 421 };
    const d = compareOtioWithOwn(own, tl, expectedTotal);
    assert.equal(d.length, 1);
    assert.match(d[0], /clipe 2: OTIO lê sequência 60–180, mídia 301–421; leitor próprio 60–180, 300–420/);
  });

  it("contagem e fim do áudio divergentes (um clipe a menos pelo OTIO)", () => {
    const tl = otioReal();
    tl.tracks[0].items.pop();
    const d = compareOtioWithOwn(own, tl, expectedTotal);
    assert.ok(d.some((x) => /^2 clipes de áudio pelo OTIO, 3 pelo leitor próprio$/.test(x)), d.join("\n"));
    assert.ok(d.some((x) => /termina no quadro 180 pelo OTIO, 300 pelo leitor próprio/.test(x)), d.join("\n"));
  });

  it("pedaço que não emenda na mídia não é remontado (corte de verdade conta como clipe)", () => {
    const tl = otioReal();
    tl.tracks[0].items[1] = { ...tl.tracks[0].items[1], srcStart: 88, srcEnd: 91 };
    assert.equal(otioSpeechClips(tl)?.length, 4);
    assert.ok(compareOtioWithOwn(own, tl).some((x) => /4 clipes de áudio pelo OTIO, 3/.test(x)));
  });

  it("duração total e taxa: card de CTA esquecido e NTSC lido diferente", () => {
    const tl = { ...otioReal(), durationFrames: 300, rate: 29.97 };
    const d = compareOtioWithOwn(own, tl, expectedTotal);
    assert.ok(d.some((x) => /sequência com 300 quadros pelo OTIO, 390 esperados/.test(x)), d.join("\n"));
    assert.ok(d.some((x) => /taxa 29\.970 fps pelo OTIO, 30\.000/.test(x)), d.join("\n"));
    // Sem o esperado, o total não é comparado.
    assert.ok(!compareOtioWithOwn(own, { ...otioReal(), durationFrames: 1 }).some((x) => /quadros pelo OTIO/.test(x)));
  });

  it("sem faixa de áudio: divergência explícita, nunca 'concorda'", () => {
    const tl = { ...otioReal(), tracks: [{ kind: "Video", items: [] }] };
    assert.deepEqual(compareOtioWithOwn(own, tl), ["o OTIO não achou faixa de áudio na sequência"]);
  });

  it("muitas divergências de clipe: lista 5 e resume o resto", () => {
    const base: OtioTimeline = { name: "x", durationFrames: 100, rate: 30, tracks: [{ kind: "Audio", items: [] }] };
    const ownMany = { ...own, clips: Array.from({ length: 8 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, in: i * 100, out: i * 100 + 10, fileId: "file-1" })) };
    base.tracks[0].items = ownMany.clips.map((c) => ({ type: "clip", recStart: c.start, recEnd: c.end, srcStart: c.in + 1000 + c.start, srcEnd: c.out + 1000 + c.start, url: "u" }));
    const d = compareOtioWithOwn(ownMany, base);
    assert.equal(d.filter((x) => /^clipe \d+:/.test(x)).length, 5);
    assert.ok(d.includes("e mais 3 clipe(s) com in/out divergente"));
  });
});

describe("#13372 parse/pick/python", () => {
  it("parseOtioReaderOutput: ok, falha declarada, módulo ausente e saída ilegível", () => {
    const ok = parseOtioReaderOutput(0, `aviso qualquer\n${JSON.stringify({ ok: true, version: "0.18.1", timelines: [otioReal()] })}\n`, "");
    assert.ok(ok.ok && ok.timelines.length === 1 && ok.version === "0.18.1");
    assert.deepEqual(parseOtioReaderOutput(3, '{"ok": false, "reason": "sem otio", "missingModule": true}', ""), { ok: false, reason: "sem otio", missingModule: true });
    assert.deepEqual(parseOtioReaderOutput(4, '{"ok": false, "reason": "ParseError"}', ""), { ok: false, reason: "ParseError", missingModule: false });
    const junk = parseOtioReaderOutput(1, "", "Traceback ... boom");
    assert.ok(!junk.ok && /ilegível \(exit 1\): Traceback \.\.\. boom/.test(junk.reason) && !junk.missingModule);
  });

  it("pickOtioTimeline: a de mesmo nome, senão a 1ª; vazio = null", () => {
    const a = { ...otioReal(), name: "A" };
    const b = { ...otioReal(), name: "B" };
    assert.equal(pickOtioTimeline([a, b], "B")?.name, "B");
    assert.equal(pickOtioTimeline([a, b], "C")?.name, "A");
    assert.equal(pickOtioTimeline([], "A"), null);
  });

  it("resolveOtioPython: DIARIA_OTIO_PYTHON vence, vazio cai no da montagem", () => {
    assert.equal(resolveOtioPython("/v/otio/bin/python", "/v/mont/bin/python"), "/v/otio/bin/python");
    assert.equal(resolveOtioPython("  ", "/v/mont/bin/python"), "/v/mont/bin/python");
    assert.equal(resolveOtioPython(undefined, "py"), "py");
  });
});

describe("#13372 otioCrossCheck fail-soft (nunca lança, nunca bloqueia)", () => {
  const fake = (r: ReturnType<OtioSpawn>): OtioSpawn => () => r;

  it("Python inexistente = indisponível", () => {
    const c = otioCrossCheck(own, "/x.xml", { python: "nao-existe", script: SCRIPT, spawn: fake({ status: null, stdout: "", stderr: "", error: new Error("spawnSync nao-existe ENOENT") }) });
    assert.equal(c.status, "indisponivel");
    assert.match(otioCheckLines(c)[0].text, /indisponível: Python nao-existe não rodou .*otio-requirements\.txt/);
    assert.equal(otioCheckLines(c)[0].level, "aviso");
  });

  it("OTIO/adapter ausente (exit 3) = indisponível; XML que o adapter não entende (exit 4) = erro, também só aviso", () => {
    const miss = otioCrossCheck(own, "/x.xml", { python: "py", script: SCRIPT, spawn: fake({ status: 3, stdout: '{"ok": false, "reason": "adapter fcp_xml ausente", "missingModule": true}', stderr: "" }) });
    assert.equal(miss.status, "indisponivel");
    const bad = otioCrossCheck(own, "/x.xml", { python: "py", script: SCRIPT, spawn: fake({ status: 4, stdout: '{"ok": false, "reason": "ParseError: x"}', stderr: "" }) });
    assert.equal(bad.status, "erro");
    assert.deepEqual(otioCheckLines(bad).map((x) => x.level), ["aviso"]);
    assert.match(otioCheckLines(bad)[0].text, /não leu o XML: ParseError: x; não bloqueia/);
  });

  it("leitura ok: concorda vira linha informativa; divergência vira aviso por item", () => {
    const out = JSON.stringify({ ok: true, version: "0.18.1", timelines: [otioReal()] });
    let args: string[] = [];
    const c = otioCrossCheck(own, "/x.xml", { python: "py", script: SCRIPT, sequenceName: spec.name, expectedTotalFrames: expectedTotal, spawn: (_p, a) => ((args = a), { status: 0, stdout: out, stderr: "" }) });
    assert.deepEqual(args, ["-P", SCRIPT, "/x.xml"]);
    assert.equal(c.status, "ok");
    assert.equal(c.clips, 3);
    assert.deepEqual(otioCheckLines(c), [{ level: "info", text: "2º leitor (OpenTimelineIO 0.18.1) concorda: 3 clipe(s) de áudio, in/out e duração (#13372)" }]);
    const diverge = otioCrossCheck(own, "/x.xml", { python: "py", script: SCRIPT, expectedTotalFrames: expectedTotal + 30, spawn: fake({ status: 0, stdout: out, stderr: "" }) });
    assert.equal(diverge.divergences.length, 1);
    assert.deepEqual(otioCheckLines(diverge).map((x) => x.level), ["aviso"]);
  });

  it("JSON sem sequência = erro", () => {
    const c = otioCrossCheck(own, "/x.xml", { python: "py", script: SCRIPT, spawn: fake({ status: 0, stdout: '{"ok": true, "version": "0.18.1", "timelines": []}', stderr: "" }) });
    assert.equal(c.status, "erro");
  });
});

describe("#13372 otio_read_xml.py de verdade", () => {
  const hasOtio = (py: string) => spawnSync(py, ["-c", "import opentimelineio"], { encoding: "utf8" }).status === 0;
  const pyNoOtio = spawnSync("python3", ["--version"]).status === 0 && !hasOtio("python3") ? "python3" : null;

  it("Python sem OpenTimelineIO: o script sai 3 com missingModule e o verify-xml avisa (indisponível)", { skip: pyNoOtio ? false : "sem python3, ou python3 já tem opentimelineio" }, () => {
    const c = otioCrossCheck(own, "/nao/importa.xml", { python: pyNoOtio!, script: SCRIPT });
    assert.equal(c.status, "indisponivel");
    assert.match(c.reason ?? "", /opentimelineio ausente/);
  });

  const livePy = process.env.DIARIA_OTIO_PYTHON;
  it("ao vivo (DIARIA_OTIO_PYTHON com OTIO + otio-fcp-adapter): concorda com o leitor próprio no XML do build", { skip: livePy && hasOtio(livePy) ? false : "DIARIA_OTIO_PYTHON sem OpenTimelineIO" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "otio-13372-"));
    try {
      const p = join(dir, "seq.xml");
      writeFileSync(p, xml);
      const c = otioCrossCheck(own, p, { python: livePy!, script: SCRIPT, sequenceName: spec.name, expectedTotalFrames: expectedTotal });
      assert.equal(c.status, "ok", c.reason);
      assert.deepEqual(c.divergences, []);
      // XML quebrado: erro, nunca lança.
      writeFileSync(p, "<x");
      assert.equal(otioCrossCheck(own, p, { python: livePy!, script: SCRIPT }).status, "erro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
