/**
 * #11900: N verticais por edição. A 2ª vertical (corte, #11898) tem roteiro
 * próprio: título na tela próprio (antes saía com o título da notícia), rótulo
 * próprio no Doc do Gate 2 (antes "Vertical Instagram") e um plano de
 * publicação em dia útil seguinte, num horário que não colide com a vertical
 * principal daquele dia.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildXmeml, defaultSequences, parseBlocksFile, type PlannedClip, type SequencePlan, type SequenceSpec, type SourceInfo } from "../scripts/lib/diaria/video-montage.ts";
import { targetLabel, versionLabel, versionsDiffParagraph } from "../scripts/lib/diaria/video-montage-docs.ts";
import { titlePngFileName, titlePngXmlPath } from "../scripts/video-montagem.ts";
import {
  extraVerticalHook,
  extraVerticalTime,
  matchCorteExports,
  nthBusinessDayAfter,
  planExtraVerticals,
  shellQuote,
} from "../scripts/lib/diaria/extra-verticals.ts";
import { loadShortScheduleConfig } from "../scripts/lib/diaria/short-video.ts";

const [YT, OUT] = defaultSequences();
const SOBERANA: SequenceSpec = {
  ...OUT,
  target: "instagram",
  name: "Diaria comentada_Vertical_V1-soberana",
  corte: "soberana",
  screenTitle: "O Brasil precisa de IA soberana?",
};
const SCHED = loadShortScheduleConfig({
  publishing: { shorts: { schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" } } },
});

const blocks = {
  resumo_curto: [
    { text: "A OpenAI lançou um modelo novo.", targets: ["outras-redes" as const] },
    { text: "Países querem a própria IA.", targets: ["instagram" as const] },
    { text: "E o Brasil?", targets: ["instagram" as const] },
  ],
  comentario: [{ start: 1, end: 2 }],
};

describe("#11900: blocks.json aceita título e gancho só no corte", () => {
  const file = (sequences: unknown[]) => ({ edition: "261103", sequences, blocks: { comentario: [{ start: 1, end: 2 }] } });
  it("corte com screenTitle e hook passa", () => {
    assert.equal(parseBlocksFile(file([YT, OUT, { ...SOBERANA, hook: "Países querem a própria IA." }])).ok, true);
  });
  it("screenTitle/hook na vertical da edição é erro (ela usa o screenTitle do arquivo e o D1)", () => {
    const r = parseBlocksFile(file([YT, { ...OUT, screenTitle: "x" }]));
    assert.ok(!r.ok && r.errors.some((e) => /screenTitle só vale numa sequência de corte/.test(e)));
  });
  it("hook vazio e tipo errado são recusados", () => {
    const r = parseBlocksFile(file([YT, OUT, { ...SOBERANA, hook: "  " }]));
    assert.ok(!r.ok && r.errors.some((e) => /hook vazio/.test(e)));
    const r2 = parseBlocksFile(file([YT, OUT, { ...SOBERANA, screenTitle: 3 }]));
    assert.ok(!r2.ok && r2.errors.some((e) => /screenTitle precisa ser texto/.test(e)));
  });
});

describe("#11900: título na tela do corte é o dele, não o da notícia", () => {
  const SOURCE: SourceInfo = { path: "G:/Meu Drive/YouTube/261103/bruto.mp4", fps: 30, durationS: 600, width: 3840, height: 2160, mirrored: false };
  const clip = (block: PlannedClip["block"], seqStart: number, len: number, frameIn: number): PlannedClip => ({
    block, srcIn: frameIn / 30, srcOut: (frameIn + len) / 30, frameIn, frameOut: frameIn + len, seqStart, seqEnd: seqStart + len, scale: 115,
  });
  const CLIPS = [clip("titulo", 0, 60, 300), clip("comentario", 60, 300, 900)];
  const plan = (spec: SequenceSpec): SequencePlan => ({ spec, clips: CLIPS, durationFrames: 360, script: "", missingBlocks: [], dropped: [] });
  const titleTexts = (xml: string) => [...xml.matchAll(/<sequence id="seq-\d+-([^"]+)">[\s\S]*?<\/sequence>/g)].map((m) => ({ seq: m[1], title: /<parameterid>str<\/parameterid><name>Text<\/name><value>([^<]*)<\/value>/.exec(m[0])?.[1] ?? null }));

  it("modo text: cada vertical com o seu título; sem o mapa, o corte herda o geral (comportamento antigo)", () => {
    const geral = { text: "Pais acusam ChatGPT", mode: "text" as const };
    const xml = buildXmeml([plan(OUT), plan(SOBERANA)], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { screenTitle: geral, screenTitleByCorte: { soberana: { text: "IA soberana", mode: "text" } } });
    assert.deepEqual(titleTexts(xml), [{ seq: "outras-redes", title: "Pais acusam ChatGPT" }, { seq: "instagram", title: "IA soberana" }]);
    const legado = buildXmeml([plan(OUT), plan(SOBERANA)], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { screenTitle: geral });
    assert.deepEqual(titleTexts(legado).map((t) => t.title), ["Pais acusam ChatGPT", "Pais acusam ChatGPT"]);
  });

  it("corte com título null fica sem faixa de título", () => {
    const xml = buildXmeml([plan(OUT), plan(SOBERANA)], SOURCE, { faceX: 0.5, eyeY: 0.5 }, { screenTitle: { text: "Geral", mode: "text" }, screenTitleByCorte: { soberana: null } });
    assert.deepEqual(titleTexts(xml).map((t) => t.title), ["Geral", null]);
  });

  it("modo png: um <file> por PNG (o geral e o do corte), cada um definido uma vez", () => {
    assert.equal(titlePngFileName("261103", "soberana"), "261103_titulo_vertical-soberana.png");
    const geral = titlePngXmlPath(SOURCE.path, "261103");
    const corte = titlePngXmlPath(SOURCE.path, "261103", "soberana");
    assert.equal(corte, "G:/Meu Drive/YouTube/261103/261103_titulo_vertical-soberana.png");
    const OUT2: SequenceSpec = { ...OUT, target: "youtube", name: "x", width: 1080, height: 1920 };
    const xml = buildXmeml([plan(OUT), plan(SOBERANA), plan(OUT2)], SOURCE, { faceX: 0.5, eyeY: 0.5 }, {
      screenTitle: { text: "Geral", mode: "png", pngPath: geral },
      screenTitleByCorte: { soberana: { text: "IA soberana", mode: "png", pngPath: corte } },
    });
    const defs = [...xml.matchAll(/<file id="(file-titulo[^"]*)"><name>([^<]+)<\/name>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(defs, [["file-titulo", "261103_titulo_vertical.png"], ["file-titulo-2", "261103_titulo_vertical-soberana.png"]]);
    assert.match(xml, /<file id="file-titulo"\/>/);
  });
});

describe("#11900: o Doc do Gate 2 nomeia o corte", () => {
  it("rótulo 'Vertical {slug}', nunca 'Vertical Instagram'", () => {
    assert.equal(targetLabel(SOBERANA), "Vertical soberana");
    assert.equal(versionLabel(SOBERANA), "Vertical soberana 1080x1920");
    assert.equal(targetLabel(OUT), "Vertical");
    // O corte leva o resumo longo, que a vertical da edição não leva: o parágrafo cita o corte pelo nome.
    const p = versionsDiffParagraph([OUT, { ...SOBERANA, order: ["titulo", "resumo", "comentario", "fecho"] }]);
    assert.match(p, /Vertical soberana leva ainda Resumo/);
    assert.doesNotMatch(p, /Vertical Instagram/);
  });
});

describe("#11900: plano de publicação das verticais extras", () => {
  it("dia útil seguinte pula o fim de semana", () => {
    assert.equal(nthBusinessDayAfter("261103", 1), "261104"); // ter → qua
    assert.equal(nthBusinessDayAfter("261106", 1), "261109"); // sex → seg
    assert.equal(nthBusinessDayAfter("261106", 2), "261110");
    assert.equal(nthBusinessDayAfter("261231", 1), "270101");
    assert.throws(() => nthBusinessDayAfter("261103", 0));
    assert.throws(() => nthBusinessDayAfter("261332", 1));
  });

  it("horário: o seguinte ao da principal do dia, nunca o mesmo", () => {
    for (const d of ["261104", "261105", "261106", "261120"]) {
      const t = extraVerticalTime(SCHED, d);
      assert.notEqual(t.hhmm, t.principal, d);
      assert.equal(t.collides, false);
    }
    const one = loadShortScheduleConfig({ publishing: { shorts: { schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-26", rotation_end: null, default_time: "12:00" } } } });
    assert.equal(extraVerticalTime(one, "261104").collides, true);
  });

  it("gancho: hook da sequência, senão o resumo_curto DESTA vertical", () => {
    assert.deepEqual(extraVerticalHook({ blocks }, { ...SOBERANA, order: ["titulo", "resumo_curto", "comentario"] }), { text: "Países querem a própria IA. E o Brasil?", how: "resumo_curto" });
    assert.equal(extraVerticalHook({ blocks }, { ...SOBERANA, hook: "Gancho." })?.how, "hook");
    assert.equal(extraVerticalHook({ blocks: {} }, SOBERANA), null);
  });

  it("plano completo: slug com a edição, dia útil seguinte, comando do modo corte com aspas", () => {
    const spec = { ...SOBERANA, order: ["titulo", "resumo_curto", "comentario"] as SequenceSpec["order"] };
    const [x, ...rest] = planExtraVerticals({ edition: "261103", file: { blocks, sequences: [YT, OUT, spec] }, sched: SCHED, videos: { soberana: "/mnt/Final/Diaria comentada_Vertical_V1-soberana.mp4" } });
    assert.equal(rest.length, 0);
    assert.equal(x.slug, "soberana-261103");
    assert.equal(x.date, "261104");
    assert.deepEqual(x.problems, []);
    assert.equal(
      x.command,
      `npx tsx scripts/publish-shorts.ts --corte soberana-261103 --date 261104 --at ${x.hhmm} --title 'O Brasil precisa de IA soberana?' ` +
        `--hook 'Países querem a própria IA. E o Brasil?' --video '/mnt/Final/Diaria comentada_Vertical_V1-soberana.mp4'`,
    );
  });

  it("2 extras: dias úteis consecutivos; sem título, gancho ou vídeo o comando sai null com o motivo", () => {
    const outro: SequenceSpec = { ...OUT, target: "instagram", name: "Diaria comentada_Vertical_V1-chips", corte: "chips" };
    const plans = planExtraVerticals({ edition: "261106", file: { blocks: {}, sequences: [OUT, { ...SOBERANA, target: "outras-redes" }, outro] }, sched: SCHED });
    assert.deepEqual(plans.map((p) => p.date), ["261109", "261110"]);
    assert.equal(plans[1].command, null);
    assert.ok(plans[1].problems.some((p) => /sem screenTitle/.test(p)));
    assert.ok(plans[1].problems.some((p) => /sem gancho/.test(p)));
    assert.ok(plans[1].problems.some((p) => /export do corte/.test(p)));
  });

  it("edição sem corte: plano vazio", () => {
    assert.deepEqual(planExtraVerticals({ edition: "261103", file: { blocks, sequences: [YT, OUT] }, sched: SCHED }), []);
  });

  it("export: casa pelo sufixo do corte; 2 arquivos = ambíguo", () => {
    const files = ["Diaria comentada_Vertical_V1.mp4", "Diaria comentada_Vertical_V1-soberana.mp4", "Diaria comentada_Vertical_V2-chips.mp4", "Diaria comentada_Vertical_V3-chips.mp4", "x-soberana.jpg"].map((name) => ({ name, path: `/f/${name}` }));
    const m = matchCorteExports(["soberana", "chips", "nada"], files);
    assert.deepEqual(m.videos, { soberana: "/f/Diaria comentada_Vertical_V1-soberana.mp4" });
    assert.deepEqual(Object.keys(m.ambiguous), ["chips"]);
  });

  it("shellQuote escapa aspas simples", () => {
    assert.equal(shellQuote("abc-1"), "abc-1");
    assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  });
});
