/**
 * #13219 — XML leve: o XML do Premiere aponta trechos curtos do bruto em
 * H.264 + PCM, não o bruto inteiro (HEVC 4K + AAC, que o Premiere converte
 * inteiro e não toca pelo Drive). Cobre o planejamento dos trechos, o XML que
 * o `buildXmeml` grava com eles, a volta ao tempo do bruto no `verify-xml` e o
 * render com o ffmpeg real numa mídia sintética pequena. O que só o Premiere
 * do Mac confirma (playback, cor 8 bits) fica fora daqui.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSequencePlan, buildXmeml, type ResolvedItem, type SequenceSpec, type SourceInfo, type Word } from "../scripts/lib/diaria/video-montage.ts";
import { combineSourceFiles, sourceFiles } from "../scripts/lib/diaria/video-multi-source.ts";
import { parseXmlAudio, toTimeline, xmlPlanIssues, xmlStructureIssues } from "../scripts/lib/diaria/video-xml-verify.ts";
import {
  findTrecho,
  parseTrechoFileId,
  parseTrechoName,
  parseTrechosFolgaArg,
  pickTrechoEncoder,
  planTrechos,
  trechoEncodeArgs,
  trechoName,
  TRECHOS,
  type TrechoXml,
} from "../scripts/lib/diaria/video-xml-trechos.ts";
import { main, renderTrechos, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const item = (interval: { start: number; end: number }, text: string, words: Word[], extra: Partial<ResolvedItem> = {}): ResolvedItem =>
  ({ interval, text, words, lastWordEnd: words[words.length - 1].end, holdLimit: interval.end + 2, how: "explicit", ...extra }) as ResolvedItem;
const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada_Youtube_V1", width: 1920, height: 1080, order: ["titulo", "comentario"], scales: [100, 115] };
const single: SourceInfo = { path: "I:/v/261116/20261115_184519.mp4", fps: 30, durationS: 120, width: 3840, height: 2160, mirrored: false };
const resolved = {
  titulo: [item({ start: 1, end: 3 }, "titulo", [w("titulo", 1.2, 2.6)])],
  comentario: [item({ start: 60, end: 64 }, "um dois", [w("um", 60.2, 61), w("dois", 61.1, 63.6)])],
};
const framing = { faceX: 0.5, eyeY: 0.5 };
const asXml = (ts: ReturnType<typeof planTrechos>, files: readonly { width: number; height: number }[], dir = "I:/v/261116/trechos/"): TrechoXml[] =>
  ts.map((t) => ({ ...t, xmlPath: `${dir}${t.name}`, width: files[t.fileIndex].width, height: files[t.fileIndex].height }));

describe("#13219 planTrechos", () => {
  const files = [{ path: "I:/v/A.mp4", frames: 3000 }];

  it("folga de 1 s, limites para fora em segundos inteiros, clamp no começo e no fim do arquivo", () => {
    const ts = planTrechos([{ fileIndex: 0, in: 15, out: 75 }, { fileIndex: 0, in: 2940, out: 2990 }], files, 30);
    assert.deepEqual(ts.map((t) => [t.start, t.end]), [[0, 120], [2910, 3000]]);
    assert.equal(ts[0].name, "A_q000000-000120.mov");
    assert.equal(ts[0].id, "file-1-t0");
  });

  it("trechos a menos de 3 s um do outro viram um só; a 3 s ou mais ficam separados", () => {
    // 300–360 → 270–390; 450–480 → 420–510 (gap 30 quadros < 90): um só.
    assert.deepEqual(planTrechos([{ fileIndex: 0, in: 300, out: 360 }, { fileIndex: 0, in: 450, out: 480 }], files, 30).map((t) => [t.start, t.end]), [[270, 510]]);
    // 300–360 → 270–390; 570–600 → 540–630 (gap 150 ≥ 90): dois.
    assert.equal(planTrechos([{ fileIndex: 0, in: 300, out: 360 }, { fileIndex: 0, in: 570, out: 600 }], files, 30).length, 2);
    // Ordem dos usos não importa (horizontal e vertical usam o bruto em ordens diferentes).
    assert.deepEqual(
      planTrechos([{ fileIndex: 0, in: 450, out: 480 }, { fileIndex: 0, in: 300, out: 360 }], files, 30).map((t) => t.name),
      planTrechos([{ fileIndex: 0, in: 300, out: 360 }, { fileIndex: 0, in: 450, out: 480 }], files, 30).map((t) => t.name),
    );
  });

  it("nome estável: um corte que mexe poucos quadros cai no mesmo trecho (reaproveitado no rebuild)", () => {
    const a = planTrechos([{ fileIndex: 0, in: 305, out: 355 }], files, 30);
    const b = planTrechos([{ fileIndex: 0, in: 312, out: 349 }], files, 30);
    assert.deepEqual(a.map((t) => t.name), b.map((t) => t.name));
    // Esticar o fim para além do segundo muda o nome: nunca reaproveita um trecho curto demais.
    const c = planTrechos([{ fileIndex: 0, in: 305, out: 395 }], files, 30);
    assert.notEqual(c[0].name, a[0].name);
  });

  it("vários arquivos: um trecho por arquivo, nunca juntando arquivos diferentes", () => {
    const two = [{ path: "I:/v/A.mp4", frames: 900 }, { path: "I:/v/B.MOV", frames: 900 }];
    const ts = planTrechos([{ fileIndex: 1, in: 30, out: 60 }, { fileIndex: 0, in: 840, out: 870 }], two, 30);
    assert.deepEqual(ts.map((t) => [t.fileIndex, t.start, t.end, t.id]), [[0, 810, 900, "file-1-t810"], [1, 0, 90, "file-2-t0"]]);
    assert.equal(ts[1].name, "B_q000000-000090.mov");
  });

  it("clipe fora do arquivo (ou vazio) é erro: plano de outro bruto", () => {
    assert.throws(() => planTrechos([{ fileIndex: 0, in: 2990, out: 3010 }], files, 30), /fora de A/);
    assert.throws(() => planTrechos([{ fileIndex: 0, in: 10, out: 10 }], files, 30), /fora de A/);
    assert.throws(() => planTrechos([{ fileIndex: 1, in: 0, out: 10 }], files, 30), /arquivo 1/);
  });

  it("folga 0 ainda arredonda para o segundo; folga pela CLI vai de 0 a 10 s", () => {
    assert.deepEqual(planTrechos([{ fileIndex: 0, in: 45, out: 75 }], files, 30, { folgaS: 0 }).map((t) => [t.start, t.end]), [[30, 90]]);
    assert.equal(parseTrechosFolgaArg(undefined), TRECHOS.folgaS);
    assert.equal(parseTrechosFolgaArg("2.5"), 2.5);
    assert.throws(() => parseTrechosFolgaArg(""), /--trechos-folga/);
    assert.throws(() => parseTrechosFolgaArg("-1"), /--trechos-folga/);
    assert.throws(() => parseTrechosFolgaArg("abc"), /--trechos-folga/);
  });

  it("id do trecho volta ao arquivo e ao início; o nome do arquivo comum não é trecho", () => {
    assert.deepEqual(parseTrechoFileId("file-3-t1200"), { fileIndex: 2, start: 1200 });
    assert.equal(parseTrechoFileId("file-1"), null);
    assert.equal(parseTrechoFileId("file-audio"), null);
    assert.equal(trechoName("C:\\x\\20261115_184519.mp4", 5, 95), "20261115_184519_q000005-000095.mov");
  });
});

describe("#13219 encoder e argumentos do ffmpeg", () => {
  it("NVENC só quando o ffmpeg lista; senão libx264", () => {
    assert.equal(pickTrechoEncoder(" V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n V....D libx264 x"), "h264_nvenc");
    assert.equal(pickTrechoEncoder(" V....D libx264              libx264 H.264"), "libx264");
    assert.equal(pickTrechoEncoder(""), "libx264");
  });

  it("H.264 GOP 15 sem B-frames, CFR no fps do projeto, PCM 48 kHz, MOV, sem redimensionar", () => {
    const a = trechoEncodeArgs({ src: "in.mp4", out: "o.mov.part", start: 30, end: 90, fps: 30, encoder: "h264_nvenc" });
    const at = (k: string) => a[a.indexOf(k) + 1];
    assert.equal(at("-ss"), "1.000000");
    assert.equal(at("-t"), "2.000000");
    assert.equal(at("-c:v"), "h264_nvenc");
    assert.equal(at("-cq"), "19");
    assert.equal(at("-g"), "15");
    assert.equal(at("-bf"), "0");
    assert.equal(at("-r"), "30");
    assert.equal(at("-c:a"), "pcm_s16le");
    assert.equal(at("-ar"), "48000");
    assert.equal(at("-f"), "mov");
    assert.ok(a.indexOf("-ss") < a.indexOf("-i"), "seek no input");
    assert.ok(!a.includes("-vf") && !a.some((x) => x.startsWith("scale")), "4K fica 4K");
    const x = trechoEncodeArgs({ src: "in.mp4", out: "o", start: 0, end: 30, fps: 30, encoder: "libx264" });
    assert.equal(x[x.indexOf("-c:v") + 1], "libx264");
    assert.equal(x[x.indexOf("-crf") + 1], "19");
  });
});

describe("#13219 buildXmeml com trechos", () => {
  it("bruto único: nenhum <file> aponta o bruto; in/out no tempo do trecho; o verify volta ao tempo do bruto", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    const files = sourceFiles(single);
    const ts = asXml(planTrechos(plan.clips.map((c) => ({ fileIndex: 0, in: c.frameIn, out: c.frameOut })), files, 30), files);
    assert.equal(ts.length, 2, "título e comentário a ~1 min um do outro: 2 trechos");
    const xml = buildXmeml([plan], single, framing, { trechos: ts, mediaPath: single.path });
    assert.ok(!xml.includes("20261115_184519.mp4"), "o bruto não aparece no XML leve");
    assert.ok(!/<file id="file-1">/.test(xml));
    for (const t of ts) {
      assert.equal((xml.match(new RegExp(`<file id="${t.id}"><name>`, "g")) ?? []).length, 1, `${t.id} definido uma vez`);
      assert.ok(xml.includes(`<pathurl>file://localhost/I:/v/261116/trechos/${t.name}</pathurl>`));
    }
    const parsed = parseXmlAudio(xml);
    assert.deepEqual(parsed.clips.map((c) => c.fileId), plan.clips.map((c) => findTrecho(ts, 0, c.frameIn, c.frameOut)!.id));
    parsed.clips.forEach((c, i) => {
      const t = findTrecho(ts, 0, plan.clips[i].frameIn, plan.clips[i].frameOut)!;
      assert.equal(c.in, plan.clips[i].frameIn - t.start);
      assert.equal(parsed.fileDurations[c.fileId], t.end - t.start);
    });
    const { clips, errors } = toTimeline(parsed, files.map((f) => f.offsetFrames));
    assert.deepEqual(errors, []);
    assert.deepEqual(clips.map((c) => [c.gIn, c.gOut]), plan.clips.map((c) => [c.frameIn, c.frameOut]));
    assert.deepEqual(xmlStructureIssues(parsed.clips), []);
    assert.deepEqual(xmlPlanIssues(parsed, { clips: plan.clips.length, durationFrames: plan.durationFrames }), []);
    // O vídeo usa o mesmo trecho (e o mesmo in/out) do áudio linkado.
    const v = [...xml.matchAll(/<clipitem id="v\d+">[\s\S]*?<in>(\d+)<\/in><out>(\d+)<\/out>\n<file id="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), m[3]]);
    assert.deepEqual(v, parsed.clips.map((c) => [c.in, c.out, c.fileId]));
  });

  it("com a faixa tratada o áudio segue no file-audio (tempo global); só o vídeo vai para o trecho", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    const files = sourceFiles(single);
    const ts = asXml(planTrechos(plan.clips.map((c) => ({ fileIndex: 0, in: c.frameIn, out: c.frameOut })), files, 30), files);
    const xml = buildXmeml([plan], single, framing, { trechos: ts, audioPath: "I:/v/261116/261116_audio_tratado-x.wav" });
    const parsed = parseXmlAudio(xml);
    assert.ok(parsed.clips.every((c) => c.fileId === "file-audio"));
    assert.deepEqual(parsed.clips.map((c) => c.in), plan.clips.map((c) => c.frameIn));
    assert.deepEqual(xmlPlanIssues(parsed, { clips: plan.clips.length, durationFrames: plan.durationFrames }), []);
    assert.ok(ts.every((t) => xml.includes(`<file id="${t.id}"><name>`)), "o vídeo define os trechos");
    assert.ok(!xml.includes("20261115_184519.mp4"));
  });

  it("vários arquivos: cada clipe aponta o trecho do arquivo dele, com o tamanho daquele arquivo", () => {
    const c = combineSourceFiles([
      { path: "I:/v/261116/A.MP4", durationS: 30, fps: 30, width: 3840, height: 2160, creationTime: "2026-11-15T10:00:00Z" },
      { path: "I:/v/261116/B.MOV", durationS: 30, fps: 30, width: 2160, height: 3840, creationTime: "2026-11-15T10:10:00Z" },
    ]);
    assert.ok(c.ok);
    const source: SourceInfo = { ...c.source, mirrored: false };
    const r = { comentario: [item({ start: 10, end: 14 }, "um", [w("um", 10.2, 13.6)]), item({ start: 41, end: 45 }, "vertical", [w("vertical", 41.2, 44.6)], { source: "B" })] };
    const plan = buildSequencePlan({ ...spec, order: ["comentario"] }, r, [], source, {});
    const files = sourceFiles(source);
    const uses = plan.clips.map((x) => ({ fileIndex: x.file ?? 0, in: x.frameIn - files[x.file ?? 0].offsetFrames, out: x.frameOut - files[x.file ?? 0].offsetFrames }));
    const ts = asXml(planTrechos(uses, files, 30), files);
    const xml = buildXmeml([plan], source, framing, { trechos: ts });
    const parsed = parseXmlAudio(xml);
    assert.deepEqual(parsed.clips.map((x) => parseTrechoFileId(x.fileId)?.fileIndex), [0, 1]);
    assert.ok(xml.includes("<width>2160</width><height>3840</height>"), "o trecho do B leva o tamanho do B");
    const { clips, errors } = toTimeline(parsed, files.map((f) => f.offsetFrames));
    assert.deepEqual(errors, []);
    assert.deepEqual(clips.map((x) => [x.gIn, x.gOut]), plan.clips.map((x) => [x.frameIn, x.frameOut]));
  });

  it("clipe fora de todos os trechos é erro (nunca aponta o bruto em silêncio)", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    const only = asXml([{ fileIndex: 0, start: 0, end: 150, name: "x.mov", id: "file-1-t0" }], sourceFiles(single));
    assert.throws(() => buildXmeml([plan], single, framing, { trechos: only }), /fora de todos os trechos/);
  });

  it("sem trechos o XML é o do bruto, igual ao de antes", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    assert.equal(buildXmeml([plan], single, framing, { trechos: null }), buildXmeml([plan], single, framing));
    assert.ok(buildXmeml([plan], single, framing).includes('<file id="file-1"><name>20261115_184519.mp4</name>'));
  });

  it("a versão do XML muda entre XML leve e bruto, e com a folga", () => {
    const plan = buildSequencePlan(spec, resolved, [], single, {});
    const opts: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    const base = xmlVersionHashOf("h", plan, opts);
    assert.equal(xmlVersionHashOf("h", plan, { ...opts, trechosFolgaS: null }), base);
    const leve = xmlVersionHashOf("h", plan, { ...opts, trechosFolgaS: 1 });
    assert.notEqual(leve, base);
    assert.notEqual(xmlVersionHashOf("h", plan, { ...opts, trechosFolgaS: 2 }), leve);
  });
});

describe("#13219 build: XML leve por padrão, --xml-bruto e --trechos-folga", () => {
  const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
  const buildBody = src.slice(src.indexOf("async function cmdBuild("), src.indexOf("\n}\n", src.indexOf("async function cmdBuild(")));

  it("o build passa os trechos ao buildXmeml e a folga à versão", () => {
    assert.match(buildBody, /const trechos = buildTrechosOrNull\(ctx, picked, source, mediaPath, trechosOpt\)/);
    assert.match(buildBody, /trechosFolgaS: trechos \? trechosOpt\.folgaS : null/);
    assert.match(buildBody, /buildXmeml\(\[p\], source, framing, \{[^}]*\btrechos \}\)/);
    assert.ok(buildBody.indexOf("buildTrechosOrNull(") < buildBody.indexOf("versionPickedSequences("), "trechos antes da versão");
  });

  it("--trechos-folga inválida para o build antes de qualquer leitura do bruto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-cli-13219-"));
    try {
      await assert.rejects(
        main(["build", "261116", "--trechos-folga", "abc", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir]),
        /--trechos-folga espera segundos de 0 a 10/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--xml-bruto desliga os trechos (opção do main para o cmdBuild)", () => {
    assert.match(src, /enabled: !flags\.has\("xml-bruto"\)/);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
// #13488: o encode falso grava arquivo vazio; os quadros saem do nome (o que o trecho promete).
const framesFromName = (p: string): number | null => {
  const m = parseTrechoName(p.replace(/\.part$/, ""));
  return m ? m.end - m.start : null;
};
const probe = (path: string, entries: string, stream: string): string =>
  spawnSync("ffprobe", ["-v", "error", "-select_streams", stream, "-count_frames", "-show_entries", entries, "-of", "default=nw=1:nk=1", path], { encoding: "utf8" }).stdout.replace(/\r\n/g, "\n").trim(); // #13276: ffprobe no Windows devolve \r\n

describe("#13219 renderTrechos com ffmpeg real (mídia sintética)", { skip: !hasFfmpeg && "ffmpeg ausente" }, () => {
  it("corta só os trechos usados, em H.264 + PCM 48 kHz, com os quadros planejados; o rebuild reaproveita", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13219-"));
    try {
      // 12 s, 320x240, 30 fps, AAC 44,1 kHz (o bruto do celular é AAC; o trecho sai PCM 48 kHz).
      const src = join(dir, "20261115_184519.mp4");
      const gen = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
      assert.equal(gen.status, 0, String(gen.stderr));
      const source: SourceInfo = { path: src, fps: 30, durationS: 12, width: 320, height: 240, mirrored: false };
      const plans = [{ clips: [{ frameIn: 45, frameOut: 75 }, { frameIn: 270, frameOut: 300 }] as never }];
      const outDir = join(dir, "out");
      const lines: string[] = [];
      const r = renderTrechos({ plans, source, outDir, mediaPath: "I:/v/261116/20261115_184519.mp4", folgaS: 1, listEncoders: () => "", log: (m) => lines.push(m) });
      assert.equal(r.encoder, "libx264");
      assert.equal(r.made, 2);
      assert.deepEqual(r.trechos.map((t) => [t.start, t.end]), [[0, 120], [240, 330]]);
      assert.deepEqual(r.trechos.map((t) => t.xmlPath), ["I:/v/261116/trechos/20261115_184519_q000000-000120.mov", "I:/v/261116/trechos/20261115_184519_q000240-000330.mov"]);
      assert.deepEqual(readdirSync(join(outDir, TRECHOS.dirName)).sort(), r.trechos.map((t) => t.name).sort(), "sem .part sobrando");
      for (const t of r.trechos) {
        const p = join(outDir, TRECHOS.dirName, t.name);
        assert.equal(probe(p, "stream=codec_name", "v:0"), "h264");
        assert.equal(probe(p, "stream=width,height", "v:0"), "320\n240");
        assert.equal(Number(probe(p, "stream=nb_read_frames", "v:0")), t.end - t.start, `${t.name}: quadros = os do XML`);
        assert.equal(probe(p, "stream=codec_name,sample_rate", "a:0"), "pcm_s16le\n48000");
      }
      // Rebuild com cortes quase iguais: mesmos nomes, nada recodificado.
      const again = renderTrechos({ plans: [{ clips: [{ frameIn: 48, frameOut: 72 }, { frameIn: 272, frameOut: 298 }] as never }], source, outDir, mediaPath: "I:/v/261116/20261115_184519.mp4", folgaS: 1, listEncoders: () => "", encode: () => assert.fail("não devia recodificar") });
      assert.equal(again.made, 0);
      assert.equal(again.reused, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NVENC que falha cai para libx264 com [aviso]; libx264 que falha lança e não deixa o nome final", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13219-"));
    try {
      const source: SourceInfo = { path: join(dir, "b.mp4"), fps: 30, durationS: 10, width: 3840, height: 2160, mirrored: false };
      const plans = [{ clips: [{ frameIn: 30, frameOut: 60 }] as never }];
      const used: string[] = [];
      const lines: string[] = [];
      const encode = (args: string[]) => {
        const enc = args[args.indexOf("-c:v") + 1];
        used.push(enc);
        if (enc === "h264_nvenc") throw new Error("ffmpeg saiu 1: No capable devices found");
        spawnSync("touch", [args[args.length - 1]]);
      };
      const nv = " V....D h264_nvenc NVIDIA NVENC H.264 encoder";
      const r = renderTrechos({ plans, source, outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => nv, encode, probeFrames: framesFromName, log: (m) => lines.push(m) });
      assert.deepEqual(used, ["h264_nvenc", "libx264"]);
      assert.equal(r.encoder, "libx264");
      assert.match(lines.join("\n"), /\[aviso\] h264_nvenc falhou/);
      const bad = () => renderTrechos({ plans: [{ clips: [{ frameIn: 200, frameOut: 240 }] as never }], source, outDir: dir, mediaPath: "I:/v/b.mp4", folgaS: 1, listEncoders: () => "", encode: () => { throw new Error("ffmpeg saiu 1"); } });
      assert.throws(bad, /ffmpeg saiu 1/);
      assert.ok(!existsSync(join(dir, TRECHOS.dirName, "b_q000150-000270.mov")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
