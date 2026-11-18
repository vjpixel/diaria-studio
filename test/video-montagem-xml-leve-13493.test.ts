/**
 * #13493 — o XML leve (#13219) deixou a montagem da 261118 mais lenta:
 * 3 rodadas de recodificação (o nome do trecho levava o segundo inteiro do
 * corte, e um ajuste de borda invalidava o arquivo), trechos truncados e
 * `.part` no Drive (o Premiere importou o XML sem fazer nada e sem erro).
 * Decisão do editor (opções 4 + 5 da issue): limites ancorados no bloco de
 * silêncio, XML só dado por pronto com os trechos na nuvem, e XML leve só
 * acima de um limiar configurável.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  decideXmlLeve,
  esperarTrechosNaNuvem,
  parseEsperarNuvemArg,
  parseTrechoName,
  parseXmlLeveChoice,
  planTrechos,
  silencesPerFile,
  trechoEndFor,
  trechosPendentesNaNuvem,
  trechoStartFor,
  XML_LEVE_LIMIAR_DEFAULT,
  xmlLeveLimiarFrom,
} from "../scripts/lib/diaria/video-xml-trechos.ts";
import { brutoTotalBytes, main, renderTrechos, reportTrechosNaNuvem } from "../scripts/video-montagem.ts";

const GIB = 1024 ** 3;
const limiar = { minGb: 15, maxArquivos: 8 };

describe("#13493 limiar do XML leve (opção 5)", () => {
  it("abaixo do limiar o XML aponta o bruto; acima por tamanho OU por número de arquivos, XML leve", () => {
    // 261118: 11,9 GB, o bruto servia.
    assert.equal(decideXmlLeve({ choice: "auto", totalBytes: 11.9 * GIB, files: 3, limiar }).enabled, false);
    // 261116: ~20 GB em 8 arquivos, o Premiere travava.
    assert.equal(decideXmlLeve({ choice: "auto", totalBytes: 20 * GIB, files: 8, limiar }).enabled, true);
    assert.equal(decideXmlLeve({ choice: "auto", totalBytes: 2 * GIB, files: 9, limiar }).enabled, true);
    // No limiar exato, ainda o bruto ("mais de").
    assert.equal(decideXmlLeve({ choice: "auto", totalBytes: 15 * GIB, files: 8, limiar }).enabled, false);
  });

  it("forçado pela CLI, o limiar não conta; --xml-leve e --xml-bruto juntos é erro", () => {
    assert.equal(decideXmlLeve({ choice: "leve", totalBytes: 1 * GIB, files: 1, limiar }).enabled, true);
    assert.equal(decideXmlLeve({ choice: "bruto", totalBytes: 50 * GIB, files: 20, limiar }).enabled, false);
    assert.equal(parseXmlLeveChoice({ leve: false, bruto: false }), "auto");
    assert.equal(parseXmlLeveChoice({ leve: true, bruto: false }), "leve");
    assert.equal(parseXmlLeveChoice({ leve: false, bruto: true }), "bruto");
    assert.throws(() => parseXmlLeveChoice({ leve: true, bruto: true }), /juntos/);
  });

  it("tamanho não lido: decide só pelo número de arquivos e diz isso", () => {
    const d = decideXmlLeve({ choice: "auto", totalBytes: null, files: 2, limiar });
    assert.equal(d.enabled, false);
    assert.match(d.reason, /só o número de arquivos/);
    assert.equal(brutoTotalBytes(["a", "b"], (p) => ({ size: p === "a" ? 10 : 5 })), 15);
    assert.equal(brutoTotalBytes(["a", "b"], (p) => { if (p === "b") throw new Error("ENOENT"); return { size: 10 }; }), null);
  });

  it("config: publishing.video.xml_leve do platform.config.json; inválido vale o default com aviso", () => {
    const real = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    assert.deepEqual(xmlLeveLimiarFrom(real), { minGb: 15, maxArquivos: 8 });
    assert.deepEqual(xmlLeveLimiarFrom({}), { ...XML_LEVE_LIMIAR_DEFAULT });
    assert.deepEqual(xmlLeveLimiarFrom({ publishing: { video: { xml_leve: { min_gb: 5, max_arquivos: 3 } } } }), { minGb: 5, maxArquivos: 3 });
    const warns: string[] = [];
    assert.deepEqual(xmlLeveLimiarFrom({ publishing: { video: { xml_leve: { min_gb: -1, max_arquivos: 2.5 } } } }, (m) => warns.push(m)), { ...XML_LEVE_LIMIAR_DEFAULT });
    assert.equal(warns.length, 2);
    assert.deepEqual(xmlLeveLimiarFrom({ publishing: { video: { xml_leve: "x" } } }, (m) => warns.push(m)), { ...XML_LEVE_LIMIAR_DEFAULT });
    assert.equal(warns.length, 3);
  });

  it("o build decide pelo limiar antes do modo API e registra os trechos só depois do render conferido", () => {
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function buildTrechosOrNull("), src.indexOf("\n}\n", src.indexOf("function buildTrechosOrNull(")));
    assert.ok(body.indexOf("decideXmlLeve(") < body.indexOf('ctx.mode === "api"'), "limiar antes do modo API");
    assert.ok(body.indexOf("renderTrechos(") < body.indexOf("ctx.buildTrechos = r.trechos"), "trechos registrados só depois do render (quadros conferidos, #13488)");
    assert.match(body, /ctx\.buildTrechos = undefined/);
  });
});

describe("#13493 nome estável: limites no bloco de silêncio (opção 4)", () => {
  const fps = 30;
  const files = [{ path: "I:/v/A.mp4", frames: 3000 }];
  // Silêncio de 9 a 11 s antes da fala, e de 20 a 21,33 s depois dela.
  const sil = [[{ start: 270, end: 330 }, { start: 600, end: 640 }]];

  it("ajuste de borda que cruza o segundo inteiro: sem silences o nome muda (o bug da 261118); com silences, o mesmo trecho", () => {
    const a = [{ fileIndex: 0, in: 295, out: 605 }];
    const b = [{ fileIndex: 0, in: 305, out: 631 }];
    assert.notDeepEqual(planTrechos(a, files, fps).map((t) => t.name), planTrechos(b, files, fps).map((t) => t.name));
    const ta = planTrechos(a, files, fps, { silences: sil });
    const tb = planTrechos(b, files, fps, { silences: sil });
    assert.deepEqual(ta.map((t) => t.name), tb.map((t) => t.name));
    assert.deepEqual(ta.map((t) => [t.start, t.end]), [[270, 640]]);
    // O trecho contém os clipes, com o silêncio inteiro (≥ a folga) de cada lado.
    for (const u of [...a, ...b]) assert.ok(ta[0].start <= u.in && u.out <= ta[0].end);
  });

  it("silêncio longo: o limite fica a silenceMaxS da fala, não no começo do silêncio; corte fundo no silêncio volta ao segundo", () => {
    const c = { fps, folgaS: 1, frames: 3000, silences: [{ start: 0, end: 600 }] };
    assert.deepEqual(trechoStartFor(590, c), { frame: 510, anchor: "silencio" });
    assert.deepEqual(trechoStartFor(585, c), { frame: 510, anchor: "silencio" });
    assert.deepEqual(trechoStartFor(400, c), { frame: 360, anchor: "segundo" });
    const e = { fps, folgaS: 1, frames: 3000, silences: [{ start: 900, end: 1500 }] };
    assert.deepEqual(trechoEndFor(905, e), { frame: 990, anchor: "silencio" });
    assert.deepEqual(trechoEndFor(1200, e), { frame: 1230, anchor: "segundo" });
  });

  it("silêncio mais curto que a folga: recua até a borda do bloco anterior (fim da fala de antes), estável dentro do silêncio", () => {
    const c = { fps, folgaS: 1, frames: 3000, silences: [{ start: 100, end: 300 }, { start: 400, end: 410 }] };
    assert.deepEqual(trechoStartFor(405, c), { frame: 300, anchor: "silencio" });
    assert.deepEqual(trechoStartFor(408, c), { frame: 300, anchor: "silencio" });
    // Corte no meio da fala (fora de silêncio): o segundo inteiro, como antes.
    assert.deepEqual(trechoStartFor(365, c), { frame: 330, anchor: "segundo" });
  });

  it("clamp no começo e no fim do arquivo; o fim do arquivo também é borda de bloco", () => {
    const c = { fps, folgaS: 1, frames: 1000, silences: [{ start: 0, end: 20 }, { start: 990, end: 1000 }] };
    assert.equal(trechoStartFor(10, c).frame, 0);
    assert.equal(trechoEndFor(995, c).frame, 1000);
  });

  it("silencesPerFile: tempo global em segundos → quadros locais de cada arquivo, cortados na borda", () => {
    const perFile = silencesPerFile([{ start: 29, end: 31 }, { start: 40, end: 41 }], [{ offsetFrames: 0, frames: 900 }, { offsetFrames: 900, frames: 900 }], 30);
    assert.deepEqual(perFile, [[{ start: 870, end: 900 }], [{ start: 0, end: 30 }, { start: 300, end: 330 }]]);
  });

  it("renderTrechos com silences: o trecho reaproveitado por nome no rebuild que mexeu na borda (sem recodificar)", () => {
    const dir = mkdtempSync(join(tmpdir(), "trechos-13493-"));
    try {
      const src = join(dir, "A.mp4");
      writeFileSync(src, "");
      const source = { path: src, fps: 30, durationS: 100, width: 3840, height: 2160, mirrored: false };
      const probeFrames = (p: string) => {
        const m = parseTrechoName(p.replace(/\.part$/, "").split(/[\\/]/).pop()!);
        return m ? m.end - m.start : null;
      };
      let encodes = 0;
      const encode = (args: string[]) => {
        encodes++;
        writeFileSync(args[args.length - 1], "x");
      };
      const silences = [{ start: 9, end: 11 }, { start: 20, end: 21.34 }];
      const first = renderTrechos({ plans: [{ clips: [{ frameIn: 295, frameOut: 605 }] as never }], source, outDir: dir, mediaPath: "I:/v/A.mp4", folgaS: 1, listEncoders: () => "", encode, probeFrames, silences, log: () => {} });
      assert.equal(encodes, 1);
      const again = renderTrechos({ plans: [{ clips: [{ frameIn: 305, frameOut: 631 }] as never }], source, outDir: dir, mediaPath: "I:/v/A.mp4", folgaS: 1, listEncoders: () => "", encode, probeFrames, silences, log: () => {} });
      assert.equal(encodes, 1, "o ajuste de borda não recodificou");
      assert.equal(again.reused, 1);
      assert.deepEqual(again.trechos.map((t) => t.name), first.trechos.map((t) => t.name));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13493 XML pronto só com os trechos na nuvem (opção 4)", () => {
  const local = [{ name: "A_q000270-000640.mov", size: 100 }, { name: "A_q000900-001200.mov", size: 200 }, { name: "A_q001500-001800.mov", size: 300 }];

  it("ausente, só como .part e com outro tamanho ficam pendentes; com o mesmo tamanho, pronto", () => {
    const pend = trechosPendentesNaNuvem(local, [
      { name: "A_q000270-000640.mov", size: "100" },
      { name: "A_q000900-001200.mov.part", size: "0" },
      { name: "A_q001500-001800.mov", size: "150" },
    ]);
    assert.deepEqual(pend, [{ name: "A_q000900-001200.mov", why: "part" }, { name: "A_q001500-001800.mov", why: "tamanho" }]);
    assert.deepEqual(trechosPendentesNaNuvem(local, local.map((l) => ({ name: l.name, size: String(l.size) }))), []);
    assert.deepEqual(trechosPendentesNaNuvem(local.slice(0, 1), []), [{ name: "A_q000270-000640.mov", why: "ausente" }]);
  });

  it("espera relendo a listagem até tudo chegar; listagem que falha nunca vira pronto", async () => {
    let t = 0;
    const listings = [[], local.slice(0, 2).map((l) => ({ name: l.name, size: l.size })), local.map((l) => ({ name: l.name, size: l.size }))];
    let i = 0;
    const r = await esperarTrechosNaNuvem({ local, list: async () => listings[Math.min(i++, 2)], timeoutS: 600, pollS: 20, sleep: async (ms) => { t += ms; }, now: () => t });
    assert.deepEqual(r, { pending: [], error: null, waitedS: 40 });
    t = 0;
    const fail = await esperarTrechosNaNuvem({ local, list: async () => { throw new Error("401"); }, timeoutS: 60, pollS: 20, sleep: async (ms) => { t += ms; }, now: () => t });
    assert.equal(fail.error, "401");
    assert.ok(fail.waitedS <= 60);
    t = 0;
    const timeout = await esperarTrechosNaNuvem({ local, list: async () => [], timeoutS: 0, pollS: 20, sleep: async () => assert.fail("timeout 0 = uma leitura"), now: () => t });
    assert.equal(timeout.pending.length, 3);
  });

  it("o relato: [ok] XML leve pronto, [aviso] AINDA NÃO pronto com o motivo, ou não conferido sem sessão do Drive", async () => {
    const lines: string[] = [];
    const log = (m: string) => lines.push(m);
    assert.equal(await reportTrechosNaNuvem(null, local, 600, "--no-drive-api", { log }), null);
    assert.match(lines.pop()!, /NÃO foi conferida \(--no-drive-api\).*nenhum \.part/);
    assert.deepEqual(await reportTrechosNaNuvem(null, local, 0, "x", { log, list: async () => local.map((l) => ({ name: l.name, size: l.size })) }), []);
    assert.match(lines.pop()!, /^\[ok\] XML leve pronto: os 3 trecho\(s\)/);
    assert.deepEqual(await reportTrechosNaNuvem(null, local, 0, "x", { log, list: async () => [{ name: `${local[0].name}.part` }] }), local.map((l) => l.name));
    assert.match(lines.pop()!, /^\[aviso\] XML leve AINDA NÃO pronto: 3 de 3.*só como \.part: A_q000270-000640\.mov/);
  });

  it("main: --esperar-nuvem inválido e --xml-leve com --xml-bruto param antes de ler o bruto", async () => {
    assert.equal(parseEsperarNuvemArg(undefined, 600), 600);
    assert.equal(parseEsperarNuvemArg("0", 600), 0);
    assert.throws(() => parseEsperarNuvemArg("", 600), /--esperar-nuvem/);
    assert.throws(() => parseEsperarNuvemArg("5000", 600), /--esperar-nuvem/);
    const dir = mkdtempSync(join(tmpdir(), "trechos-cli-13493-"));
    try {
      const base = ["build", "261118", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir];
      await assert.rejects(main([...base, "--esperar-nuvem", "abc"]), /--esperar-nuvem espera segundos/);
      await assert.rejects(main([...base, "--xml-leve", "--xml-bruto"]), /--xml-leve e --xml-bruto juntos/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main confere a nuvem só no build sem upload pela API (Drive for desktop), depois do comando", () => {
    const src = readFileSync(new URL("../scripts/video-montagem.ts", import.meta.url), "utf8");
    const m = src.slice(src.indexOf("const code = await runCommand(ctx, cmd, values, flags, seq, d);"));
    assert.match(m.slice(0, 800), /cmd === "build" && code === 0 && !uploads && ctx\.buildTrechos\?\.length/);
    assert.match(m.slice(0, 800), /reportTrechosNaNuvem\(/);
  });
});
