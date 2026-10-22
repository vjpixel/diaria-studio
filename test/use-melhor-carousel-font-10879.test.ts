/**
 * test/use-melhor-carousel-font-10879.test.ts (#10879)
 *
 * A regeração do carrossel do 4º post (#10834) exige a fonte Georgia. No
 * servidor 300 ela não existe: a regeração falhava, saía um warning genérico
 * ("corrigir o motivo") no stderr do upload e o 4º post continuava sendo
 * pulado no LinkedIn/Facebook/Instagram sem nada no gate do Stage 4.
 *
 * Conserto:
 *  - `refreshStaleUseMelhorCarousel` marca a falha de fonte (`cause: "font_missing"`);
 *  - `upload-images-public.ts` transforma isso num aviso que nomeia a Georgia e
 *    dá o conserto (regerar numa máquina com a fonte, ou o escape explícito);
 *  - invariante `use-melhor-carousel-stale` acusa no gate do Stage 4 quando o
 *    carrossel continua defasado depois do pré-render.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeUseMelhorPostState, type UseMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";
import { useMelhorSlideFilename } from "../scripts/lib/use-melhor-carousel.ts";
import {
  genCarouselCards,
  refreshStaleUseMelhorCarousel,
  type RenderUseMelhorSlidesFn,
} from "../scripts/gen-carousel-cards.ts";
import { uploadPublicImages, useMelhorFontMissingWarning } from "../scripts/upload-images-public.ts";
import { STAGE_4_RULES, checkUseMelhorCarouselStaleAtGate } from "../scripts/lib/invariant-checks/stage-4.ts";

const ON: UseMelhorPostConfigState = { enabled: true, time: "07:45" };
const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: "off" };

const P = (s: string) => `${s} **Trecho curto em negrito.** Fim do parágrafo.`;
const TEXTO_D = [P("Primeiro parágrafo do destaque."), P("Segundo parágrafo."), P("Terceiro parágrafo."), "#IA"].join("\n\n");
const TEXTO_UM = [P("Um guia prático para planilhas."), P("Como pedir fórmulas."), "#IA #Planilhas"].join("\n\n");
const TEXTO_UM_EDITADO = [P("Um guia prático para planilhas, revisto."), P("Como pedir fórmulas."), P("E como conferir."), "#IA"].join("\n\n");

const APPROVED = {
  highlights: [{}, {}, {}],
  use_melhor: [{ url: "https://fast.com/b", title: "Guia B", summary: "Resumo B", score: 83 }],
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function socialMd(um: string): string {
  return ["# Social", "", "## d1", "", TEXTO_D, "", "## d2", "", TEXTO_D, "", "## d3", "", TEXTO_D, "", "## um", "", um, ""].join("\n");
}

const fakeRenderD = async (_t: string, outPaths: Record<string, string>) => {
  for (const p of Object.values(outPaths)) writeFileSync(p, "x");
  return outPaths as never;
};

const writingRenderUm: RenderUseMelhorSlidesFn = async (d, slides) =>
  slides.map((s) => {
    const p = join(d, useMelhorSlideFilename(s.slot));
    writeFileSync(p, `render-${s.slot}`);
    return p;
  });

const neverRender: RenderUseMelhorSlidesFn = async () => {
  throw new Error("não deveria renderizar sem a fonte");
};

const fontMissing = async () => {
  throw new Error("[gen-carousel-cards] Georgia não está disponível nesta máquina");
};

/** Edição com o carrossel do 4º post gerado no "Stage 3" e o `## um` editado DEPOIS. */
async function makeStaleEdition(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "diaria-10879-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED));
  writeFileSync(join(dir, "03-social.md"), socialMd(TEXTO_UM), "utf8");
  writeUseMelhorPostState(dir, {
    enabled: true,
    time: "07:45",
    item: { url: "https://fast.com/b", title: "Guia B", summary: "", score: 83 },
    generated_at: "x",
  });
  await genCarouselCards(dir, { render: fakeRenderD, useMelhorConfig: ON, renderUseMelhor: writingRenderUm });
  writeFileSync(join(dir, "03-social.md"), socialMd(TEXTO_UM_EDITADO), "utf8");
  return dir;
}

describe("refreshStaleUseMelhorCarousel marca a fonte ausente (#10879)", () => {
  it("Georgia ausente → failed com cause font_missing, sem render", async () => {
    const dir = await makeStaleEdition();
    const r = await refreshStaleUseMelhorCarousel(dir, { useMelhorConfig: ON, render: neverRender, assertFont: fontMissing });
    assert.equal(r.status, "failed");
    assert.equal(r.cause, "font_missing");
    assert.match(r.reason ?? "", /Georgia/);
  });

  it("falha de render (não de fonte) → failed SEM cause", async () => {
    const dir = await makeStaleEdition();
    const r = await refreshStaleUseMelhorCarousel(dir, {
      useMelhorConfig: ON,
      render: async () => {
        throw new Error("sharp quebrou");
      },
      assertFont: async () => {},
    });
    assert.equal(r.status, "failed");
    assert.equal(r.cause, undefined);
  });

  it("carimbo em dia → nem consulta a fonte (o 300 não paga o guard à toa)", async () => {
    const dir = await makeStaleEdition();
    writeFileSync(join(dir, "03-social.md"), socialMd(TEXTO_UM), "utf8");
    const r = await refreshStaleUseMelhorCarousel(dir, { useMelhorConfig: ON, render: neverRender, assertFont: fontMissing });
    assert.equal(r.status, "fresh");
  });
});

describe("upload-images-public avisa a fonte ausente com o conserto (#10879)", () => {
  it("REGRESSÃO: Stage 5 no 300 com carrossel defasado → aviso nomeia Georgia e o conserto; D1 sobe", async () => {
    const dir = await makeStaleEdition();
    writeFileSync(join(dir, "04-d1-4x5.jpg"), "d1");
    const out = await uploadPublicImages({
      editionDir: dir,
      mode: "social",
      target: "cloudflare",
      uploaders: { uploadToCloudflare: async (_p, key) => `https://kv.test/${key}` },
      refreshUseMelhorCarousel: (d) =>
        refreshStaleUseMelhorCarousel(d, { useMelhorConfig: ON, render: neverRender, assertFont: fontMissing }),
    });
    assert.equal(out.use_melhor_carousel?.cause, "font_missing");
    const w = out.warnings.find((x) => /4º post DEFASADO/.test(x));
    assert.ok(w, out.warnings.join("\n"));
    assert.match(w!, /Georgia não existe nesta máquina/);
    assert.match(w!, /gen-carousel-cards\.ts --edition-dir/);
    assert.match(w!, /DIARIA_ALLOW_FONT_FALLBACK=1/);
    assert.doesNotMatch(w!, /corrigir o motivo/, "o aviso genérico não diz qual é o motivo");
    assert.ok(out.images.d1_4x5?.url, "D1 sobe mesmo com o 4º post falhando");
    assert.equal(out.images.um_carousel_cover, undefined, "arte defasada nunca sobe");
  });

  it("aviso cita o diretório da edição nos dois comandos", () => {
    const w = useMelhorFontMissingWarning("data/editions/2610/261022");
    assert.equal(w.match(/data\/editions\/2610\/261022/g)?.length, 2);
  });
});

describe("invariante use-melhor-carousel-stale no gate do Stage 4 (#10879)", () => {
  it("REGRESSÃO: carrossel defasado no gate → warning com o conserto", async () => {
    const dir = await makeStaleEdition();
    const v = checkUseMelhorCarouselStaleAtGate(dir, ON);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "use-melhor-carousel-stale");
    assert.equal(v[0].severity, "warning", "o 4º post é fail-soft (#9568) — nunca bloqueia o gate");
    assert.match(v[0].message, /Georgia/);
    assert.match(v[0].message, /gen-carousel-cards\.ts --edition-dir/);
  });

  it("carrossel em dia → sem violação", async () => {
    const dir = await makeStaleEdition();
    writeFileSync(join(dir, "03-social.md"), socialMd(TEXTO_UM), "utf8");
    assert.deepEqual(checkUseMelhorCarouselStaleAtGate(dir, ON), []);
  });

  it("feature desligada → sem violação", async () => {
    const dir = await makeStaleEdition();
    assert.deepEqual(checkUseMelhorCarouselStaleAtGate(dir, OFF), []);
  });

  it("sem carimbo (carrossel nunca gerado) → sem violação (já é aviso do gate)", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-10879-nostamp-"));
    dirs.push(dir);
    assert.deepEqual(checkUseMelhorCarouselStaleAtGate(dir, ON), []);
  });

  it("regra registrada no Stage 4", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "use-melhor-carousel-stale");
    assert.ok(rule);
    assert.equal(rule!.stage, 4);
    assert.equal(rule!.source_issue, "#10879");
  });
});
