/**
 * test/use-melhor-carousel-refresh-10834.test.ts (#10834)
 *
 * Caso real 261022: o `## um` foi editado depois do Stage 3, o carimbo do
 * carrossel do 4º post (`04-um-carousel-*`) ficou defasado e os publicadores
 * pularam o 4º post no LinkedIn, Facebook e Instagram (X saiu só com texto).
 * Conserto: `upload-images-public.ts` (modo social, Stage 4 pré-render e
 * Stage 5) regera o carrossel defasado ANTES de decidir quais slides subir.
 *
 * Também cobre o banner do `03-social.md` (#10833): o LinkedIn pessoal é
 * automático desde #9568, o banner não pode dizer "manualmente".
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { writeUseMelhorPostState, type UseMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";
import { useMelhorSlideFilename } from "../scripts/lib/use-melhor-carousel.ts";
import { freshUseMelhorCarouselSlots, planUseMelhorDispatchFrom } from "../scripts/lib/use-melhor-dispatch.ts";
import {
  genCarouselCards,
  refreshStaleUseMelhorCarousel,
  type RenderUseMelhorSlidesFn,
} from "../scripts/gen-carousel-cards.ts";
import { uploadPublicImages } from "../scripts/upload-images-public.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ON: UseMelhorPostConfigState = { enabled: true, time: "07:45" };

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

function writingRenderUm(calls: string[][]): RenderUseMelhorSlidesFn {
  return async (d, slides) => {
    calls.push(slides.map((s) => s.slot));
    return slides.map((s) => {
      const p = join(d, useMelhorSlideFilename(s.slot));
      writeFileSync(p, `render-${calls.length}-${s.slot}`);
      return p;
    });
  };
}

/** Edição com o carrossel do 4º post gerado no "Stage 3" e o `## um` editado DEPOIS. */
async function makeStaleEdition(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "diaria-10834-261022-"));
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
  await genCarouselCards(dir, { render: fakeRenderD, useMelhorConfig: ON, renderUseMelhor: writingRenderUm([]) });
  // Editor mexe no `## um` depois do Stage 3 (gate 4 / Studio).
  writeFileSync(join(dir, "03-social.md"), socialMd(TEXTO_UM_EDITADO), "utf8");
  return dir;
}

const noFont = async () => {};

describe("refreshStaleUseMelhorCarousel (#10834)", () => {
  it("REGRESSÃO 261022: `## um` editado depois do Stage 3 → regera e o carimbo volta a valer", async () => {
    const dir = await makeStaleEdition();
    assert.deepEqual(freshUseMelhorCarouselSlots(dir), [], "pré-condição: carimbo defasado → nenhum slide vale");
    const calls: string[][] = [];
    const r = await refreshStaleUseMelhorCarousel(dir, { useMelhorConfig: ON, render: writingRenderUm(calls), assertFont: noFont });
    assert.equal(r.status, "regenerated");
    assert.deepEqual(calls, [["cover", "p1", "p2", "p3", "cta"]]);
    assert.deepEqual(freshUseMelhorCarouselSlots(dir), ["cover", "p1", "p2", "p3", "cta"]);
  });

  it("carimbo em dia → `fresh`, sem render", async () => {
    const dir = await makeStaleEdition();
    writeFileSync(join(dir, "03-social.md"), socialMd(TEXTO_UM), "utf8");
    const r = await refreshStaleUseMelhorCarousel(dir, {
      useMelhorConfig: ON,
      render: async () => {
        throw new Error("não deveria renderizar");
      },
      assertFont: noFont,
    });
    assert.equal(r.status, "fresh");
    assert.deepEqual(r.slots, ["cover", "p1", "p2", "cta"]);
  });

  it("sem carimbo (carrossel nunca gerado) → `noop`, sem render", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-10834-nostamp-"));
    dirs.push(dir);
    const r = await refreshStaleUseMelhorCarousel(dir, { useMelhorConfig: ON, assertFont: noFont });
    assert.equal(r.status, "noop");
  });

  it("feature desligada → `noop` mesmo com carimbo defasado", async () => {
    const dir = await makeStaleEdition();
    const r = await refreshStaleUseMelhorCarousel(dir, {
      useMelhorConfig: { enabled: false, time: null, reason: "off" },
      assertFont: noFont,
    });
    assert.equal(r.status, "noop");
  });

  it("fonte de marca ausente → `failed` com motivo, nunca lança", async () => {
    const dir = await makeStaleEdition();
    const r = await refreshStaleUseMelhorCarousel(dir, {
      useMelhorConfig: ON,
      render: async () => {
        throw new Error("não deveria renderizar");
      },
      assertFont: async () => {
        throw new Error("Georgia não está disponível");
      },
    });
    assert.equal(r.status, "failed");
    assert.match(r.reason ?? "", /Georgia/);
  });

  it("`## um` novo não cabe no card → `skipped`, carimbo continua defasado", async () => {
    const dir = await makeStaleEdition();
    const enorme = "palavra ".repeat(400).trim();
    writeFileSync(join(dir, "03-social.md"), socialMd(`${enorme}\n\n${P("ok")}`), "utf8");
    const r = await refreshStaleUseMelhorCarousel(dir, {
      useMelhorConfig: ON,
      render: async () => {
        throw new Error("não deveria renderizar");
      },
      assertFont: noFont,
    });
    assert.equal(r.status, "skipped");
    assert.match(r.reason ?? "", /não cabem/);
  });
});

describe("upload-images-public regera o carrossel defasado antes de subir (#10834)", () => {
  it("REGRESSÃO 261022: slides do 4º post sobem e o plano do Stage 5 volta a ter a capa", async () => {
    const dir = await makeStaleEdition();
    const uploaded: string[] = [];
    const out = await uploadPublicImages({
      editionDir: dir,
      mode: "social",
      target: "cloudflare",
      uploaders: {
        uploadToCloudflare: async (_p, key) => {
          uploaded.push(key);
          return `https://kv.test/${key}`;
        },
      },
      refreshUseMelhorCarousel: (d) =>
        refreshStaleUseMelhorCarousel(d, { useMelhorConfig: ON, render: writingRenderUm([]), assertFont: noFont }),
    });
    assert.equal(out.use_melhor_carousel?.status, "regenerated");
    for (const slot of ["cover", "p1", "p2", "p3", "cta"]) {
      assert.ok(out.images[`um_carousel_${slot}`]?.url, `um_carousel_${slot} subiu`);
    }
    // O plano do Stage 5 (o que os publicadores leem) agora tem slots — sem
    // isso LinkedIn/Instagram/Facebook pulavam o 4º post.
    const plan = planUseMelhorDispatchFrom({
      config: { publishing: { social: { use_melhor_time: "07:45" } } },
      state: JSON.parse(readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8")),
      reviewedMd: "**USE MELHOR**\n\n[Guia B](https://fast.com/b)\nResumo B.\n",
      approved: APPROVED,
      socialUm: TEXTO_UM_EDITADO,
      stamp: JSON.parse(readFileSync(join(dir, "_internal", ".use-melhor-carousel-hash.json"), "utf8")),
      ctaOverride: null,
    });
    assert.equal(plan.status, "ready", JSON.stringify(plan));
    if (plan.status === "ready") {
      assert.deepEqual(plan.slots, ["cover", "p1", "p2", "p3", "cta"]);
      assert.equal(plan.imageWarning, undefined);
    }
  });

  it("regeração que falha vira WARNING auditável (nunca silencioso) e D1/D2/D3 sobem igual", async () => {
    const dir = await makeStaleEdition();
    writeFileSync(join(dir, "04-d1-4x5.jpg"), "d1");
    const out = await uploadPublicImages({
      editionDir: dir,
      mode: "social",
      target: "cloudflare",
      uploaders: { uploadToCloudflare: async (_p, key) => `https://kv.test/${key}` },
      refreshUseMelhorCarousel: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(out.use_melhor_carousel?.status, "failed");
    assert.ok(out.warnings.some((w) => /4º post DEFASADO/.test(w) && /boom/.test(w)), out.warnings.join("\n"));
    assert.ok(out.images.d1_4x5?.url, "d1 sobe mesmo com o 4º post falhando");
    assert.equal(out.images.um_carousel_cover, undefined, "arte defasada nunca sobe");
  });

  it("modo newsletter não confere o 4º post", async () => {
    const dir = await makeStaleEdition();
    let called = false;
    const out = await uploadPublicImages({
      editionDir: dir,
      mode: "newsletter",
      target: "cloudflare",
      uploaders: { uploadToCloudflare: async (_p, key) => `https://kv.test/${key}` },
      refreshUseMelhorCarousel: async () => {
        called = true;
        return { status: "noop" };
      },
    }).catch(() => null); // newsletter exige cover/eia — o que importa é o seam não ser chamado
    void out;
    assert.equal(called, false);
  });
});

describe("banner do 03-social.md (#10833)", () => {
  it("diz que o 4º post não sai no LinkedIn pessoal (#11398), nunca 'manualmente' nem 'automaticamente'", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-10833-"));
    dirs.push(dir);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "03-social.tmp.md"), "## d1\n\nTexto d1\n\n#ia\n\n## um\n\nTexto um\n");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "merge-social-md.ts"), "--edition-dir", dir], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = readFileSync(join(dir, "03-social.md"), "utf8");
    const banner = out.split("\n").find((l) => l.startsWith("> **Texto único")) ?? "";
    assert.ok(banner, "banner presente");
    assert.doesNotMatch(banner, /manualmente no LinkedIn pessoal/);
    assert.doesNotMatch(banner, /automaticamente no LinkedIn pessoal/);
    assert.doesNotMatch(banner, /publish-linkedin-personal\.ts/);
    assert.match(banner, /Não sai no LinkedIn pessoal/);
    assert.equal(existsSync(join(dir, "_internal", "03-social.tmp.md")), false);
  });
});
