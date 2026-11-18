/**
 * test/video-trecho-inserido-xml-13437.test.ts — #13437, PR 2: o trecho de
 * outro vídeo (formato react) entra no XML do horizontal.
 *
 * Cobre a lógica pura: o deslocamento da sequência (`trechoRipple`,
 * `splitClipsAt`, `planComTrechos`), as faixas do trecho no `buildXmeml`, a
 * volta ao plano no `verify-xml` (`unrippleXmlClips`), a procura da fonte (o
 * export do vídeo de origem, nunca o YouTube), o aviso de fonte ausente, os
 * argumentos do corte e a seção do `roteiro.md`. Nenhum vídeo real: o ffmpeg
 * é injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildXmeml, type PlannedClip, type SequencePlan, type SequenceSpec, type SourceInfo, type VinhetaAsset } from "../scripts/lib/diaria/video-montage.ts";
import {
  planComTrechos,
  splitClipsAt,
  trechoClipFrames,
  trechoInseridoLine,
  trechoRipple,
  trechosInseridosSection,
  unrippleXmlClips,
  type TrechoInseridoClip,
} from "../scripts/lib/diaria/video-trecho-inserido.ts";
import {
  avisosTrechosNaMontagem,
  fonteNoDrive,
  parseTrechoFonteArg,
  resolverFonteTrecho,
  trechoInseridoEncodeArgs,
  trechoInseridoFileName,
  type FonteFs,
} from "../scripts/lib/diaria/video-trecho-fonte.ts";
import { lerTrechoInserido, type TrechoInseridoLido } from "../scripts/lib/diaria/trecho-inserido-formato.ts";
import { parseXmlAudio, xmlPlanIssues, xmlStructureIssues } from "../scripts/lib/diaria/video-xml-verify.ts";
import { edicaoDoVideoPublicado, srtDoVideoPublicado } from "../scripts/lib/diaria/roteiro-react.ts";
import { cutTrechoInserido, xmlVersionHashOf, type XmlBuildOptions } from "../scripts/video-montagem.ts";

const FPS = 30;
const clip = (srcIn: number, srcOut: number, seqStart: number): PlannedClip => ({
  block: "comentario",
  srcIn,
  srcOut,
  frameIn: Math.round(srcIn * FPS),
  frameOut: Math.round(srcOut * FPS),
  seqStart,
  seqEnd: seqStart + Math.round((srcOut - srcIn) * FPS),
  scale: 100,
});
const spec: SequenceSpec = { target: "youtube", name: "Diaria comentada horizontal_V1", width: 1920, height: 1080, order: ["comentario"], scales: [100, 115] };
const planOf = (clips: PlannedClip[]): SequencePlan =>
  ({ spec, clips, durationFrames: clips[clips.length - 1].seqEnd, script: "", missingBlocks: [], dropped: [] }) as unknown as SequencePlan;
const source = { path: "/b/bruto.mp4", fps: FPS, durationS: 1000, width: 1920, height: 1080 } as SourceInfo;
const framing = { faceX: 0.5, eyeY: 0.5 };
const lido = (raw: unknown): TrechoInseridoLido => {
  const r = lerTrechoInserido(raw);
  assert.ok(r.ok, JSON.stringify(r));
  return r.trecho;
};
const tc = (id: string, at: number, frames: number): TrechoInseridoClip => ({
  id,
  at,
  frames,
  path: `/out/261118_trecho_${id}-abc.mov`,
  xmlPath: `I:/Meu Drive/diaria-studio-video/261118/261118_trecho_${id}-abc.mov`,
  width: 1920,
  height: 1080,
  video: "youtu.be/lyh6IZux4FE",
  inicioS: 222,
  fimS: 222 + frames / FPS,
  fonte: "I:/Meu Drive/diaria-studio-video/261110/Editados/x_Youtube_V3.mp4",
});

describe("#13437 PR 2: deslocamento da sequência", () => {
  it("trechoRipple: início no ponto de inserção anda, fim fica; dois trechos somam em ordem", () => {
    const r = trechoRipple([tc("H9", 600, 30), tc("H5", 300, 90)]);
    assert.deepEqual(r.placed.map((p) => [p.clip.id, p.pos]), [["H5", 300], ["H9", 690]]);
    assert.equal(r.total, 120);
    assert.equal(r.end(300), 300, "a fala que termina no ponto fica");
    assert.equal(r.start(300), 390, "o que começa no ponto anda");
    assert.equal(r.start(600), 720);
    assert.equal(r.end(600), 690);
    assert.equal(r.start(10), 10);
    assert.equal(trechoRipple([tc("H5", 300, 0)]).placed.length, 0, "trecho de 0 quadro fica fora");
  });

  it("trechoClipFrames conta quadros da sequência", () => {
    assert.equal(trechoClipFrames(222, 240, 30), 540);
    assert.equal(trechoClipFrames(234.88, 267, 30), 964);
  });

  it("splitClipsAt parte o clipe com a mídia emendada; ponto na borda não parte", () => {
    const parts = splitClipsAt([clip(10, 20, 0)], [120, 0, 300], FPS);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map((c) => [c.seqStart, c.seqEnd, c.frameIn, c.frameOut]), [[0, 120, 300, 420], [120, 300, 420, 600]]);
    assert.deepEqual(parts.map((c) => [c.srcIn, c.srcOut]), [[10, 14], [14, 20]]);
  });

  it("planComTrechos: sem trecho, o mesmo plano; com trecho, a duração soma e o resto anda", () => {
    const plan = planOf([clip(10, 20, 0), clip(30, 38, 300)]);
    assert.equal(planComTrechos(plan, [], FPS).plan, plan);
    const { plan: p } = planComTrechos(plan, [tc("H5", 300, 90)], FPS);
    assert.equal(p.durationFrames, 630);
    assert.deepEqual(p.clips.map((c) => [c.seqStart, c.seqEnd]), [[0, 300], [390, 630]]);
  });
});

describe("#13437 PR 2: o trecho no XML", () => {
  const plan = planOf([clip(10, 20, 0), clip(30, 38, 300)]);

  it("sem trechoClips, o XML de antes", () => {
    const sem = buildXmeml([plan], source, framing);
    assert.equal(buildXmeml([plan], source, framing, { trechoClips: {} }), sem);
    assert.equal(buildXmeml([plan], source, framing, { trechoClips: { "outras-redes": [tc("H5", 300, 90)] } }), sem, "só a sequência da chave");
  });

  it("faixa própria de vídeo e áudio, linkadas, com label e marcador cobrindo o clipe; o resto anda", () => {
    const m = { id: "H5", trecho: lido({ video: "youtu.be/lyh6IZux4FE", inicio: "3:42", fim: "3:45", texto: "perder o cargo" }), at: 300 };
    const tela = { id: "H7", tela: "depois", in: 300, out: 540 };
    const xml = buildXmeml([plan], source, framing, { trechoClips: { youtube: [tc("H5", 300, 90)] }, trechoMarkers: { youtube: [m] }, telaMarkers: { youtube: [tela] } });
    assert.match(xml, /<sequence id="[^"]+"><name>Diaria comentada horizontal_V1<\/name><duration>630<\/duration>/);
    assert.match(xml, /<clipitem id="trecho-1-v1"><name>trecho H5<\/name>[\s\S]*?<start>300<\/start><end>390<\/end><in>0<\/in><out>90<\/out>[\s\S]*?<pathurl>file:\/\/localhost\/I:\/Meu%20Drive\/diaria-studio-video\/261118\/261118_trecho_H5-abc\.mov<\/pathurl>[\s\S]*?<label2>Mango<\/label2>/);
    assert.match(xml, /<clipitem id="trecho-1-a1"><name>trecho H5<\/name>[\s\S]*?<start>300<\/start><end>390<\/end>[\s\S]*?<file id="file-trecho-1-1"\/>/);
    assert.match(xml, /<linkclipref>trecho-1-a1<\/linkclipref><mediatype>audio<\/mediatype><trackindex>2<\/trackindex>/, "a faixa do trecho é a 2ª de áudio (sem vinheta)");
    assert.match(xml, /<marker><name>trecho H5<\/name><comment>[^<]*<\/comment><in>300<\/in><out>390<\/out><\/marker>/);
    assert.match(xml, /<marker><name>tela H7<\/name><comment>depois<\/comment><in>390<\/in><out>630<\/out><\/marker>/, "o marcador de tela da fala seguinte anda");
    // A faixa principal: o 2º clipe anda 90 quadros.
    const main = parseXmlAudio(xml);
    assert.deepEqual(main.clips.map((c) => [c.start, c.end]), [[0, 300], [390, 630]], "o trecho-a1 não entra na faixa principal");
  });

  it("verify-xml: desfaz o deslocamento e junta o clipe partido; o XML bate com o plano", () => {
    // Clipe único (itens contíguos fundidos) com a fala terminando no meio, quadro 120.
    const one = planOf([clip(10, 20, 0)]);
    const xml = buildXmeml([one], source, framing, { trechoClips: { youtube: [tc("H5", 120, 60)] } });
    const raw = parseXmlAudio(xml);
    assert.deepEqual(raw.clips.map((c) => [c.start, c.end, c.in, c.out]), [[0, 120, 300, 420], [180, 360, 420, 600]]);
    assert.ok(xmlStructureIssues(raw.clips).some((x) => /buraco/.test(x)), "sem desfazer, é buraco");
    const back = { ...raw, clips: unrippleXmlClips(raw.clips, [tc("H5", 120, 60)], one.clips) };
    assert.deepEqual(back.clips.map((c) => [c.start, c.end, c.in, c.out]), [[0, 300, 300, 600]]);
    assert.deepEqual(xmlStructureIssues(back.clips), []);
    assert.deepEqual(xmlPlanIssues(back, { clips: one.clips.length, durationFrames: one.durationFrames }), []);
    assert.deepEqual(unrippleXmlClips(raw.clips, [], one.clips), raw.clips, "sem trecho, os mesmos clipes");
  });

  it("dois trechos: o 2º fica depois do 1º somado; verify volta ao plano", () => {
    const p3 = planOf([clip(10, 20, 0), clip(30, 38, 300), clip(50, 52, 540)]);
    const ins = [tc("H5", 300, 90), tc("H9", 540, 30)];
    const xml = buildXmeml([p3], source, framing, { trechoClips: { youtube: ins } });
    const raw = parseXmlAudio(xml);
    assert.deepEqual(raw.clips.map((c) => [c.start, c.end]), [[0, 300], [390, 630], [660, 720]]);
    assert.match(xml, /<clipitem id="trecho-1-v2"><name>trecho H9<\/name>[\s\S]*?<start>630<\/start><end>660<\/end>/);
    const back = { ...raw, clips: unrippleXmlClips(raw.clips, ins, p3.clips) };
    assert.deepEqual(xmlStructureIssues(back.clips), []);
    assert.deepEqual(xmlPlanIssues(back, { clips: 3, durationFrames: 600 }), []);
  });

  it("xmlVersionHashOf: o trecho muda a versão; sem ele, o hash de antes; o caminho local fica fora", () => {
    const base: XmlBuildOptions = { speechDetect: true, audioRefine: true, audioGain: true, titleMode: "png" };
    const h0 = xmlVersionHashOf("x", plan, base);
    assert.equal(xmlVersionHashOf("x", plan, { ...base, trechoClips: {} }), h0);
    const h1 = xmlVersionHashOf("x", plan, { ...base, trechoClips: { youtube: [tc("H5", 300, 90)] } });
    assert.notEqual(h1, h0);
    assert.equal(xmlVersionHashOf("x", plan, { ...base, trechoClips: { youtube: [{ ...tc("H5", 300, 90), path: "/outro/lugar.mov", fonte: "/outra/fonte.mp4" }] } }), h1);
  });

  it("trechoInseridoLine com clipe diz a faixa e que a prévia segue sem o trecho; sem clipe, à mão", () => {
    const m = { id: "H5", trecho: lido({ video: "youtu.be/lyh6IZux4FE", inicio: "3:42", fim: "3:45", texto: "x" }), at: 300 };
    assert.match(trechoInseridoLine(m, 30, tc("H5", 300, 90)).text, /soma 3\.0 s ao horizontal no XML: clipe 261118_trecho_H5-abc\.mov .*faixa própria .*a prévia e o plan\.json seguem sem o trecho/);
    assert.match(trechoInseridoLine(m, 30, null).text, /inserir o clipe à mão no Premiere/);
  });
});

describe("#13437 PR 2: fonte do trecho (export do vídeo de origem, nunca o YouTube)", () => {
  const ytTrecho = lido({ video: "youtu.be/lyh6IZux4FE", inicio: "3:42", fim: "4:00", texto: "perder o cargo" });
  const edTrecho = lido({ video: "261110", inicio: "3:42", fim: "4:00", texto: "x" });
  const fakeFs = (files: Record<string, number>, dirs: string[]): FonteFs => {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const all = Object.keys(files).map(norm);
    const ds = dirs.map(norm);
    return {
      exists: (p) => all.includes(norm(p)) || ds.includes(norm(p)),
      list: (dir) => {
        const d = norm(dir).replace(/\/$/, "");
        const kids = new Map<string, { dir: boolean; mtimeMs: number }>();
        for (const f of all) if (f.startsWith(`${d}/`) && !f.slice(d.length + 1).includes("/")) kids.set(f.slice(d.length + 1), { dir: false, mtimeMs: files[Object.keys(files).find((k) => norm(k) === f)!] });
        for (const x of ds) if (x.startsWith(`${d}/`) && !x.slice(d.length + 1).includes("/")) kids.set(x.slice(d.length + 1), { dir: true, mtimeMs: 0 });
        return [...kids].map(([name, v]) => ({ name, dir: v.dir, mtimeMs: v.mtimeMs, size: 1 }));
      },
    };
  };
  const editionsWithRegistry = (videoPath: string | null): string => {
    const root = mkdtempSync(join(tmpdir(), "trecho-fonte-13437-"));
    mkdirSync(join(root, "2611", "261110", "_internal"), { recursive: true });
    writeFileSync(join(root, "2611", "261110", "_internal", "05-youtube-published.json"), JSON.stringify({ videoId: "lyh6IZux4FE", ...(videoPath ? { video_path: videoPath } : {}) }));
    writeFileSync(join(root, "2611", "261110", "diaria-comentada-261110.srt"), "1\n00:03:42,000 --> 00:03:45,000\nperder o cargo\n");
    return root;
  };

  it("parseTrechoFonteArg: CHAVE=caminho separados por ;; entrada sem = lança", () => {
    assert.deepEqual(parseTrechoFonteArg(undefined), {});
    assert.deepEqual(parseTrechoFonteArg("H5=I:/a b/x.mp4; 261110=C:\\y.mp4;"), { H5: "I:/a b/x.mp4", "261110": "C:\\y.mp4" });
    assert.throws(() => parseTrechoFonteArg("H5"), /CHAVE=caminho/);
    assert.throws(() => parseTrechoFonteArg("=x"), /CHAVE=caminho/);
  });

  it("edicaoDoVideoPublicado acha a edição pelo videoId; srtDoVideoPublicado segue igual", () => {
    const root = editionsWithRegistry("C:/x/diaria-comentada-261110.mp4");
    assert.deepEqual(edicaoDoVideoPublicado(root, "lyh6IZux4FE"), { edicao: "261110", dir: join(root, "2611", "261110"), videoPath: "C:/x/diaria-comentada-261110.mp4" });
    assert.equal(edicaoDoVideoPublicado(root, "outroIdXXXX"), null);
    assert.match(srtDoVideoPublicado(root, "lyh6IZux4FE") ?? "", /perder o cargo/);
  });

  it("--trecho-fonte vence (pela fala, pelo id ou pela edição); caminho ausente é dito e a procura PARA ali", () => {
    const root = editionsWithRegistry(null);
    const fs = fakeFs({ "/m/x.mp4": 1 }, []);
    const base = { trecho: ytTrecho, editionsRootDir: root, driveRoot: null, fs };
    assert.equal(resolverFonteTrecho({ ...base, id: "H5", fontes: { H5: "/m/x.mp4" } }).fonte, "/m/x.mp4");
    assert.equal(resolverFonteTrecho({ ...base, id: "H5", fontes: { lyh6IZux4FE: "/m/x.mp4" } }).fonte, "/m/x.mp4");
    assert.equal(resolverFonteTrecho({ ...base, id: "H5", trecho: edTrecho, fontes: { "261110": "/m/x.mp4" } }).fonte, "/m/x.mp4");
    const r = resolverFonteTrecho({ ...base, id: "H5", fontes: { H5: "/nao/existe.mp4" } });
    assert.equal(r.fonte, null);
    assert.equal(r.explicitoAusente, true);
    assert.ok(r.procurado[0].includes("--trecho-fonte H5=/nao/existe.mp4 (não existe"), r.procurado.join("\n"));
    assert.equal(r.procurado.length, 1, "nada da busca automática depois do caminho explícito");
  });

  it("video_path do registro, depois diaria-comentada-{AAMMDD}.mp4 da edição de origem", () => {
    const root = editionsWithRegistry("C:/videos/diaria-comentada-261110.mp4");
    const base = { id: "H5", trecho: ytTrecho, fontes: {}, editionsRootDir: root, driveRoot: null };
    assert.equal(resolverFonteTrecho({ ...base, fs: fakeFs({ "C:/videos/diaria-comentada-261110.mp4": 1 }, []) }).fonte, "C:/videos/diaria-comentada-261110.mp4");
    const local = join(root, "2611", "261110", "diaria-comentada-261110.mp4");
    const r = resolverFonteTrecho({ ...base, fs: fakeFs({ [local]: 1 }, []) });
    assert.equal(r.fonte, local);
    assert.ok(r.procurado[0].includes("video_path do 05-youtube-published.json de 261110, ausente"), r.procurado.join("\n"));
  });

  it("vídeo sem registro: avisa que a edição não foi achada, sem chutar", () => {
    const root = mkdtempSync(join(tmpdir(), "trecho-fonte-vazio-13437-"));
    const r = resolverFonteTrecho({ id: "H5", trecho: ytTrecho, fontes: {}, editionsRootDir: root, driveRoot: "/drive", fs: fakeFs({}, []) });
    assert.equal(r.fonte, null);
    assert.equal(r.edicao, null);
    assert.match(r.procurado.join(" "), /nenhum _internal\/05-youtube-published\.json com esse videoId/);
  });

  it("Drive: Final/ com o horizontal; sem .mp4 em Final/, Editados/ pela versão mais alta (como na 261110)", () => {
    const root = editionsWithRegistry(null);
    const ed = "/drive/261110";
    const final = fakeFs({ [`${ed}/Final/Diaria comentada horizontal_V4.mp4`]: 5, [`${ed}/Final/Diaria comentada_Vertical_V4.mp4`]: 5 }, [ed, `${ed}/Final`]);
    assert.equal(resolverFonteTrecho({ id: "H5", trecho: ytTrecho, fontes: {}, editionsRootDir: root, driveRoot: "/drive", fs: final }).fonte?.replace(/\\/g, "/"), `${ed}/Final/Diaria comentada horizontal_V4.mp4`);
    const editados = fakeFs(
      {
        [`${ed}/Editados/Diaria comentada_Edição 11_Youtube_V1.mp4`]: 1,
        [`${ed}/Editados/Diaria comentada_Edição 11_Youtube_V3.mp4`]: 3,
        [`${ed}/Editados/Diaria comentada_Edição 11_Youtube_V2.mp4`]: 2,
        [`${ed}/Editados/Diaria comentada_Edição 11_Vertical_V1.mp4`]: 4,
      },
      [ed, `${ed}/Editados`, `${ed}/_superadas`],
    );
    const r = resolverFonteTrecho({ id: "H5", trecho: ytTrecho, fontes: {}, editionsRootDir: root, driveRoot: "/drive", fs: editados });
    assert.equal(r.fonte?.replace(/\\/g, "/"), `${ed}/Editados/Diaria comentada_Edição 11_Youtube_V3.mp4`);
    assert.ok(r.premissa, "a escolha da versão mais alta vira premissa");
  });

  it("Drive: dois horizontais em Final/ é ambíguo (não chuta); pasta sem .mp4 diz onde olhou", () => {
    const ed = "/drive/261110";
    const amb = fonteNoDrive(ed, fakeFs({ [`${ed}/Final/Diaria comentada horizontal_V3.mp4`]: 1, [`${ed}/Final/Diaria comentada horizontal_V4.mp4`]: 2 }, [ed, `${ed}/Final`]), new Date());
    assert.equal(amb.fonte, null);
    assert.match(amb.motivo, /ambíguo .*--trecho-fonte/);
    assert.match(fonteNoDrive(ed, fakeFs({}, [ed]), new Date()).motivo, /Final\/ e Editado\/ \(nenhum \.mp4\)/);
    assert.match(fonteNoDrive("/drive/999999", fakeFs({}, []), new Date()).motivo, /pasta da edição ausente/);
  });

  it("corte: seek, duração em quadros, tamanho e fps da sequência, PCM; nome com fala e hash", () => {
    const a = trechoInseridoEncodeArgs({ src: "/s.mp4", out: "/o.mov.part", inicioS: 234.88, frames: 964, fps: 30, width: 1920, height: 1080, encoder: "libx264" });
    const at = (k: string) => a[a.indexOf(k) + 1];
    assert.equal(at("-ss"), "234.880000");
    assert.equal(at("-t"), (964 / 30).toFixed(6));
    assert.match(at("-vf"), /^scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080/);
    assert.equal(at("-r"), "30");
    assert.equal(at("-c:a"), "pcm_s16le");
    assert.equal(a[a.length - 1], "/o.mov.part");
    assert.equal(trechoInseridoFileName("261118", "H5/b", "abc123"), "261118_trecho_H5_b-abc123.mov");
  });

  it("cutTrechoInserido: sem fonte, null com aviso e caminho esperado; com fonte, corta pelo ffmpeg injetado", () => {
    const out = mkdtempSync(join(tmpdir(), "trecho-cut-13437-"));
    const src = join(out, "fonte.mp4");
    writeFileSync(src, "x");
    const ctx = { edition: "261118", outDir: out, stateDir: out, mode: "local", trechoFontes: {}, trechoDriveRoot: null } as unknown as Parameters<typeof cutTrechoInserido>[0];
    const t = { id: "H5", texto: "Olha", trecho: ytTrecho };
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errs.push(String(m));
    try {
      assert.equal(cutTrechoInserido(ctx, t, 300, spec, 30, "I:/v/261118/bruto.mp4", { encode: () => assert.fail("sem fonte não corta") }), null);
      assert.ok(errs.some((e) => /\[aviso\] .*trecho depois da fala H5 .*NÃO inserido: o export do vídeo de origem não foi achado \(procurado: .*--trecho-fonte "H5=caminho"/.test(e)), errs.join("\n"));
      errs.length = 0;
      const withSrc = { ...ctx, trechoFontes: { H5: src } } as typeof ctx;
      assert.equal(cutTrechoInserido(withSrc, t, 300, spec, 30, "I:/v/261118/bruto.mp4", { probeDurationS: () => 100 }), null, "fim depois do fim do vídeo");
      assert.ok(errs.some((e) => /passa do fim de/.test(e)), errs.join("\n"));
      let args: string[] = [];
      const c = cutTrechoInserido(withSrc, t, 300, spec, 30, "I:/v/261118/bruto.mp4", {
        probeDurationS: () => 600,
        listEncoders: () => "",
        encode: (a) => {
          args = a;
          writeFileSync(a[a.length - 1], "mov");
        },
      });
      assert.ok(c);
      assert.equal(c.frames, 540);
      assert.equal(c.at, 300);
      assert.match(c.xmlPath, /^I:\/v\/261118\/261118_trecho_H5-[0-9a-f]{12}\.mov$/);
      assert.ok(existsSync(c.path));
      assert.equal(args[args.indexOf("-ss") + 1], "222.000000");
      assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
      const again = cutTrechoInserido(withSrc, t, 300, spec, 30, "I:/v/261118/bruto.mp4", { probeDurationS: () => 600, encode: () => assert.fail("reaproveita o corte") });
      assert.equal(again?.path, c.path);
      const fail = cutTrechoInserido({ ...withSrc, outDir: mkdtempSync(join(tmpdir(), "trecho-cut-f-13437-")) } as typeof ctx, t, 300, spec, 30, "I:/v/b.mp4", {
        probeDurationS: () => null,
        listEncoders: () => "",
        encode: () => {
          throw new Error("ffmpeg saiu 1: Invalid data");
        },
      });
      assert.equal(fail, null, "ffmpeg falho não para o build");
      assert.ok(errs.some((e) => /o corte de .* falhou \(ffmpeg saiu 1/.test(e)), errs.join("\n"));
    } finally {
      console.error = orig;
    }
  });

  it("texto contra o SRT: divergência e SRT ausente viram aviso, nunca mudam o tempo", () => {
    const t = (texto: string) => ({ id: "H5", trecho: lido({ video: "261110", inicio: "3:42", fim: "3:45", texto }) });
    const srt = "1\n00:03:42,000 --> 00:03:45,000\nE ele pode perder o cargo.\n";
    assert.deepEqual(avisosTrechosNaMontagem([t("ele pode perder o cargo")], "/x", () => srt), []);
    assert.match(avisosTrechosNaMontagem([t("ganhar o prêmio")], "/x", () => srt).join("\n"), /H5: trechoInserido\.texto não bate com o SRT/);
    assert.match(avisosTrechosNaMontagem([t("x")], "/x", () => null).join("\n"), /H5: sem o SRT do vídeo 261110 .*não conferido/);
  });

  it("roteiro.md: a seção lista cada trecho, a duração somada e a fonte (ou onde foi procurada)", () => {
    const lines = trechosInseridosSection([
      { id: "H5", trecho: lido({ video: "261110", inicio: "3:42", fim: "4:00", texto: "perder o cargo" }), fonte: "I:/d/261110/Final/x.mp4", procurado: [] },
      { id: "H9", trecho: lido({ video: "261110", inicio: "5:00", fim: "5:02", texto: "y" }), fonte: null, procurado: ["/a (ausente)"] },
    ]);
    assert.equal(lines[0], "## Trechos inseridos (horizontal)");
    assert.match(lines.join("\n"), /2 trecho\(s\) de outro vídeo, 18\.0 s somados ao horizontal no XML \(até 20\.0 s com o trecho sem fonte inserido à mão\)/);
    assert.match(lines.join("\n"), /depois da fala H5: Vídeo de 10\/11 \(261110\), 3:42 a 4:00 \(18\.0 s\), "perder o cargo"; fonte: I:\/d\/261110\/Final\/x\.mp4/);
    assert.match(lines.join("\n"), /depois da fala H9: .*\*\*\[aviso\] fonte não encontrada\*\* \(procurado: \/a \(ausente\)\).*--trecho-fonte "H9=caminho"/);
    assert.deepEqual(trechosInseridosSection([]), []);
  });

  it("roteiro.md: todos com fonte, a soma é a de todos, sem o 'até' (fix 7)", () => {
    const lines = trechosInseridosSection([{ id: "H5", trecho: lido({ video: "261110", inicio: "3:42", fim: "4:00", texto: "x" }), fonte: "/f.mp4", procurado: [] }]);
    assert.match(lines.join("\n"), /1 trecho\(s\) de outro vídeo, 18\.0 s somados ao horizontal, fora/);
    const nenhum = trechosInseridosSection([
      { id: "H5", trecho: lido({ video: "261110", inicio: "3:42", fim: "4:00", texto: "x" }), fonte: null, procurado: [] },
      { id: "H9", trecho: lido({ video: "261110", inicio: "5:00", fim: "5:02", texto: "y" }), fonte: null, procurado: [] },
    ]);
    assert.match(nenhum.join("\n"), /0\.0 s somados ao horizontal no XML \(até 20\.0 s com os 2 trechos sem fonte inseridos à mão\)/);
  });

  it("trecho que cita a edição AAMMDD lê o video_path do registro dela; registro ausente ou sem video_path entra no procurado (fix 1)", () => {
    const root = editionsWithRegistry("C:/videos/diaria-comentada-261110.mp4");
    const base = { id: "H5", trecho: edTrecho, fontes: {}, editionsRootDir: root, driveRoot: null };
    assert.equal(resolverFonteTrecho({ ...base, fs: fakeFs({ "C:/videos/diaria-comentada-261110.mp4": 1 }, []) }).fonte, "C:/videos/diaria-comentada-261110.mp4");
    const ausente = resolverFonteTrecho({ ...base, fs: fakeFs({}, []) });
    assert.equal(ausente.fonte, null);
    assert.ok(ausente.procurado.some((p) => p.includes("C:/videos/diaria-comentada-261110.mp4 (video_path do 05-youtube-published.json de 261110, ausente")), ausente.procurado.join("\n"));
    const vazio = mkdtempSync(join(tmpdir(), "trecho-fonte-sem-reg-13437-"));
    const semReg = resolverFonteTrecho({ ...base, editionsRootDir: vazio, fs: fakeFs({}, []) });
    assert.ok(semReg.procurado[0].includes("05-youtube-published.json (registro de publicação ausente ou ilegível)"), semReg.procurado.join("\n"));
    const semPath = resolverFonteTrecho({ ...base, editionsRootDir: editionsWithRegistry(null), fs: fakeFs({}, []) });
    assert.ok(semPath.procurado[0].includes("(registro sem video_path)"), semPath.procurado.join("\n"));
  });

  it("--trecho-fonte explícito ausente não cai na busca automática, mesmo com o export local presente (fix 2)", () => {
    const root = editionsWithRegistry("C:/videos/v.mp4");
    const local = join(root, "2611", "261110", "diaria-comentada-261110.mp4");
    const fs = fakeFs({ [local]: 1, "C:/videos/v.mp4": 1 }, []);
    const r = resolverFonteTrecho({ id: "H5", trecho: edTrecho, fontes: { "261110": "/errado.mp4" }, editionsRootDir: root, driveRoot: "/drive", fs });
    assert.equal(r.fonte, null);
    assert.equal(r.edicao, "261110");
    assert.equal(r.explicitoAusente, true);
    // O mesmo pela chave AAMMDD de um trecho youtu.be (a edição sai do registro).
    const yt = resolverFonteTrecho({ id: "H5", trecho: ytTrecho, fontes: { "261110": "/errado.mp4" }, editionsRootDir: root, driveRoot: "/drive", fs });
    assert.equal(yt.fonte, null);
    assert.equal(yt.explicitoAusente, true);
    // No build, o aviso diz que o caminho explícito não existe.
    const out = mkdtempSync(join(tmpdir(), "trecho-cut-expl-13437-"));
    const ctx = { edition: "261118", outDir: out, stateDir: out, mode: "local", trechoFontes: { H5: "/nao/existe.mp4" }, trechoDriveRoot: null } as unknown as Parameters<typeof cutTrechoInserido>[0];
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errs.push(String(m));
    try {
      assert.equal(cutTrechoInserido(ctx, { id: "H5", texto: "x", trecho: ytTrecho }, 300, spec, 30, "I:/v/261118/b.mp4", { encode: () => assert.fail("não corta") }), null);
    } finally {
      console.error = orig;
    }
    assert.ok(errs.some((e) => /\[aviso\] .*NÃO inserido: o --trecho-fonte aponta um arquivo que não existe nesta máquina/.test(e)), errs.join("\n"));
  });

  it("a chave AAMMDD de --trecho-fonte casa com trecho youtu.be, e vence o video_path do registro (fix 3)", () => {
    const root = editionsWithRegistry("C:/videos/v.mp4");
    const r = resolverFonteTrecho({ id: "H5", trecho: ytTrecho, fontes: { "261110": "/m/x.mp4" }, editionsRootDir: root, driveRoot: null, fs: fakeFs({ "/m/x.mp4": 1, "C:/videos/v.mp4": 1 }, []) });
    assert.equal(r.fonte, "/m/x.mp4");
    assert.equal(r.edicao, "261110");
  });

  it("cutTrechoInserido: ffprobe falho avisa; clipe bem mais curto que o intervalo é recusado; menos de 1 quadro é null (fix 4)", () => {
    const mk = () => mkdtempSync(join(tmpdir(), "trecho-cut4-13437-"));
    const dir = mk();
    const src = join(dir, "fonte.mp4");
    writeFileSync(src, "x");
    const ctx = { edition: "261118", outDir: dir, stateDir: dir, mode: "local", trechoFontes: { H5: src }, trechoDriveRoot: null } as unknown as Parameters<typeof cutTrechoInserido>[0];
    const t = { id: "H5", texto: "Olha", trecho: ytTrecho };
    const write = (a: string[]) => writeFileSync(a[a.length - 1], "mov");
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errs.push(String(m));
    try {
      const semProbe = cutTrechoInserido(ctx, t, 300, spec, 30, "I:/v/261118/b.mp4", { probeDurationS: () => null, listEncoders: () => "", encode: write });
      assert.ok(semProbe, "sem probe, o clipe entra com aviso");
      assert.ok(errs.some((e) => /\[aviso\] .*não foi medida \(ffprobe falhou\); o fim do trecho não foi conferido/.test(e)), errs.join("\n"));
      assert.ok(errs.some((e) => /\[aviso\] .*a duração do clipe cortado não foi medida/.test(e)), errs.join("\n"));
      errs.length = 0;
      const curtoDir = mk();
      const curto = cutTrechoInserido({ ...ctx, outDir: curtoDir } as typeof ctx, t, 300, spec, 30, "I:/v/b.mp4", {
        probeDurationS: (p) => (p.endsWith(".part") ? 5 : null),
        listEncoders: () => "",
        encode: write,
      });
      assert.equal(curto, null);
      assert.ok(errs.some((e) => /NÃO inserido: o corte de .* falhou \(o clipe saiu com 5\.00 s, e o intervalo pede 18\.00 s/.test(e)), errs.join("\n"));
      assert.deepEqual(readdirSync(curtoDir), [], "nem o .part nem o .mov ficam");
      const quase = cutTrechoInserido({ ...ctx, outDir: mk() } as typeof ctx, t, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: (p) => (p.endsWith(".part") ? 17.6 : 600), listEncoders: () => "", encode: write });
      assert.ok(quase, "dentro da folga (0,5 s), o clipe entra");
      errs.length = 0;
      const tiny = { ...t, trecho: { ...ytTrecho, fimS: ytTrecho.inicioS + 0.01 } };
      assert.equal(cutTrechoInserido(ctx, tiny, 300, spec, 30, "I:/v/b.mp4", { probeDurationS: () => assert.fail("nem mede"), encode: () => assert.fail("nem corta") }), null);
      assert.ok(errs.some((e) => /NÃO inserido: o intervalo do roteiro .* não chega a 1 quadro a 30 fps/.test(e)), errs.join("\n"));
    } finally {
      console.error = orig;
    }
  });

  it("SRT presente mas sem nenhuma legenda: o mesmo aviso de texto não conferido (fix 5)", () => {
    const t = { id: "H5", trecho: lido({ video: "261110", inicio: "3:42", fim: "3:45", texto: "x" }) };
    assert.match(avisosTrechosNaMontagem([t], "/x", () => "").join("\n"), /H5: o SRT do vídeo 261110 não tem legenda legível .*não conferido contra a legenda/);
    assert.match(avisosTrechosNaMontagem([t], "/x", () => "lixo sem tempo nenhum\n").join("\n"), /não tem legenda legível/);
  });
});

describe("#13437 PR 2: faixas, vinheta e boxes de tela com o trecho", () => {
  const plan = planOf([clip(10, 20, 0), clip(30, 38, 300)]);
  const audioTracks = (xml: string): string[] => {
    const audio = xml.slice(xml.indexOf("<audio><numOutputChannels>"), xml.indexOf("</audio></media></sequence>"));
    return [...audio.matchAll(/<track>([\s\S]*?)<\/track>/g)].map((m) => m[1]);
  };
  const trechoLinkIndex = (xml: string): number => Number(/<linkclipref>trecho-1-a1<\/linkclipref><mediatype>audio<\/mediatype><trackindex>(\d+)<\/trackindex>/.exec(xml)?.[1]);
  const vinheta = (hasAudio: boolean, sfx: boolean): VinhetaAsset => ({
    path: "I:/m/vinheta.mov",
    durationS: 2,
    width: 1920,
    height: 1080,
    hasAudio,
    ...(sfx ? { sfx: { path: "I:/m/tecla.wav", durationS: 0.2, atS: [0.5] } } : {}),
  });

  for (const [nome, vin, faixa] of [
    ["sem vinheta", null, 2],
    ["vinheta sem áudio nem efeito", vinheta(false, false), 2],
    ["vinheta com áudio, sem efeito", vinheta(true, false), 3],
    ["vinheta sem áudio, com efeito", vinheta(false, true), 3],
    ["vinheta com áudio e efeito", vinheta(true, true), 4],
  ] as const) {
    it(`trackindex do áudio do trecho = a posição real da faixa dele em <audio> (${nome})`, () => {
      const xml = buildXmeml([plan], source, framing, { trechoClips: { youtube: [tc("H5", 300, 90)] }, vinheta: vin });
      const tracks = audioTracks(xml);
      const real = tracks.findIndex((x) => x.includes('<clipitem id="trecho-1-a1">')) + 1;
      assert.equal(real, faixa, tracks.map((x) => x.slice(0, 40)).join(" | "));
      assert.equal(trechoLinkIndex(xml), real);
      if (vin?.hasAudio) assert.ok(tracks[1].includes('<clipitem id="vinheta-a1">'), "o link da vinheta (faixa 2) segue apontando a faixa dela");
    });
  }

  it("boxes de tela: o que começa no ponto de inserção anda; o que termina nele fica", () => {
    const box = (id: string, a: number, b: number) => ({ id, tela: id, path: `/o/${id}.png`, xmlPath: `I:/x/${id}.png`, width: 1920, height: 1080, in: a, out: b });
    const xml = buildXmeml([plan], source, framing, { trechoClips: { youtube: [tc("H5", 300, 90)] }, telaOverlays: { youtube: [box("H4", 0, 300), box("H7", 300, 540)] } });
    assert.match(xml, /<clipitem id="tela-1-1"><name>tela H4<\/name>[\s\S]*?<start>0<\/start><end>300<\/end>/);
    assert.match(xml, /<clipitem id="tela-1-2"><name>tela H7<\/name>[\s\S]*?<start>390<\/start><end>630<\/end>/);
    const sem = buildXmeml([plan], source, framing, { telaOverlays: { youtube: [box("H4", 0, 300), box("H7", 300, 540)] } });
    assert.match(sem, /<clipitem id="tela-1-2"><name>tela H7<\/name>[\s\S]*?<start>300<\/start><end>540<\/end>/, "sem trecho, o box de antes");
  });

  it("verify-xml: dois clipes do plano já contíguos no ponto de inserção seguem dois (fix 6)", () => {
    const two = planOf([clip(10, 14, 0), clip(14, 20, 120)]);
    const ins = [tc("H5", 120, 60)];
    const raw = parseXmlAudio(buildXmeml([two], source, framing, { trechoClips: { youtube: ins } }));
    assert.deepEqual(raw.clips.map((c) => [c.start, c.end]), [[0, 120], [180, 360]]);
    const back = unrippleXmlClips(raw.clips, ins, two.clips);
    assert.deepEqual(back.map((c) => [c.start, c.end, c.in, c.out]), [[0, 120, 300, 420], [120, 300, 420, 600]]);
    assert.deepEqual(xmlPlanIssues({ ...raw, clips: back }, { clips: 2, durationFrames: two.durationFrames }), []);
  });
});
