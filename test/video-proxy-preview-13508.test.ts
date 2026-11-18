/**
 * #13508 (resíduo de código depois da PR #13530): a prévia lê o proxy 1440p
 * (o mesmo recorte, em px do proxy) e a banda alta de 48 kHz sai na MESMA
 * leitura do bruto que o `transcribe` já faz. Sem GPU: só a parte pura.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cropOnProxy, PROXY, proxySize } from "../scripts/lib/diaria/video-proxy.ts";
import { HIGH_BAND, highBandKey, highBandOutputArgs, transcribeExtractArgs } from "../scripts/video-montagem.ts";

describe("#13508 prévia pelo proxy", () => {
  it("tamanho do proxy: lado menor em 1440, o outro par na proporção (o scale=-2 do ffmpeg)", () => {
    assert.deepEqual(proxySize(3840, 2160), { width: 2560, height: 1440 });
    assert.deepEqual(proxySize(2160, 3840), { width: 1440, height: 2560 });
    assert.equal(proxySize(1920, 1080), null, "bruto que já cabe: sem proxy");
  });

  it("o recorte do 4K vira a MESMA fração do quadro no proxy, par e dentro dele", () => {
    const src = { width: 3840, height: 2160 };
    const proxy = proxySize(3840, 2160)!;
    // recorte vertical típico (9:16, zoom 1,2) centrado no rosto
    const c = cropOnProxy({ x: 1414, y: 104, w: 1012, h: 1800 }, src, proxy);
    assert.deepEqual(c, { x: 943, y: 69, w: 674, h: 1200 });
    for (const v of [c.w, c.h]) assert.equal(v % 2, 0);
    assert.ok(c.x / proxy.width - 1414 / 3840 < 0.001);
    // recorte encostado no canto de baixo/direita nunca sai do proxy
    const edge = cropOnProxy({ x: 2828, y: 360, w: 1012, h: 1800 }, src, proxy);
    assert.ok(edge.x + edge.w <= proxy.width && edge.y + edge.h <= proxy.height, JSON.stringify(edge));
    // o quadro inteiro (horizontal, sem zoom) é o proxy inteiro
    assert.deepEqual(cropOnProxy({ x: 0, y: 0, w: 3840, h: 2160 }, src, proxy), { x: 0, y: 0, w: 2560, h: PROXY.shortSide });
  });
});

describe("#13508 banda alta de 48 kHz na leitura do transcribe", () => {
  it("um ffmpeg só: WAV 16 kHz, banda alta 48 kHz e loudness, todos da mesma entrada", () => {
    const args = transcribeExtractArgs({ input: "/b/bruto.mp4", audio: "/w/audio.wav", highBand: `/w/${HIGH_BAND.file}` });
    assert.equal(args.filter((a) => a === "-i").length, 1, "uma entrada só: o bruto é lido uma vez");
    assert.equal(args[args.indexOf("-i") + 1], "/b/bruto.mp4");
    assert.ok(args.includes("/w/audio.wav"));
    const hb = highBandOutputArgs(`/w/${HIGH_BAND.file}`);
    const at = args.indexOf(hb[0], args.indexOf("/w/audio.wav"));
    assert.deepEqual(args.slice(at, at + hb.length), hb, "a saída da banda alta é a mesma do highBandEnvelope");
    assert.ok(hb.includes("48000") && hb.some((a) => a.startsWith("highpass=")));
    assert.ok(args.some((a) => a.includes("print_format=json")), "o loudness segue medido na mesma leitura");
    assert.deepEqual(args.slice(-3), ["-f", "null", "-"], "o proxy (quando há) é pendurado depois, como antes");
  });

  it("a meta da banda alta é a mesma chave que o highBandEnvelope confere (sem 2ª leitura)", () => {
    const k = highBandKey("/w/audio-multi.wav", { size: 10, mtimeMs: 5 });
    assert.equal(JSON.parse(k).path, "/w/audio-multi.wav");
    assert.equal(k, highBandKey("/w/audio-multi.wav", { size: 10, mtimeMs: 5 }));
    assert.notEqual(k, highBandKey("/w/audio-multi.wav", { size: 11, mtimeMs: 5 }), "entrada trocada: a banda alta é refeita");
  });
});
