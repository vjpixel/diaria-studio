/**
 * test/use-melhor-dispatch-9568.test.ts (#9568 — Stage 5)
 *
 * Dispatch do 4º post social (item USE MELHOR, `## um`). Cobre:
 *   - horário: `computeScheduledAt({ destaque: "um" })` → `use_melhor_time`
 *     (08:00 BRT no config do repo), mesmo cálculo de data dos destaques;
 *   - UTM: `utm_content=usemelhor` por cima do UTM do canal, só em link do projeto;
 *   - plano (fail-soft): desligado / sem item / item mudou no gate / carrossel
 *     defasado → nunca publica texto do item errado;
 *   - montagem por rede (LinkedIn página, Facebook, Instagram, Threads, X):
 *     carrossel de N slides variável, fallback pra capa, pulo sem peça;
 *   - LinkedIn pessoal recebe o texto do `## um` (não mais o `## post_pixel`),
 *     com edição antiga ainda lendo o `## post_pixel` legado;
 *   - upload dos slides com N variável; lints estendidos pro `## um`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";
import {
  applyUseMelhorUtmToText,
  planUseMelhorDispatchFrom,
  resolveUseMelhorImages,
  useMelhorDispatchIds,
  USE_MELHOR_COVER_FILE,
  type UseMelhorDispatchPlan,
} from "../scripts/lib/use-melhor-dispatch.ts";
import { USE_MELHOR_POST_ID, writeUseMelhorPostState } from "../scripts/lib/use-melhor-post.ts";
import { buildUseMelhorSlides, hashUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey, useMelhorCarouselHashPath } from "../scripts/lib/use-melhor-slide-files.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorInstagramPost } from "../scripts/publish-instagram.ts";
import { buildUseMelhorThreadsPost } from "../scripts/publish-threads.ts";
import { prepTwitterPosts } from "../scripts/prep-twitter-posts.ts";
import { extractPersonalPostText, personalPostImageFile } from "../scripts/resolve-post-pixel.ts";
import { useMelhorSlideSpecs } from "../scripts/upload-images-public.ts";
import {
  checkHumanizerSectionCoverage,
  lintInstagramEmailCTA,
  lintLinkedinSchema,
  lintTrailingQuestion,
} from "../scripts/lib/social-lint-rules.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_CONFIG = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
const EDITION_URL = "https://diar.ia.br/p/edicao-teste";

const ITEM = { url: "https://exame.com/guia-planilhas", title: "Guia de planilhas com IA", summary: "Resumo.", score: 88 };
const P = (s: string) => `${s} **Trecho em negrito.** Fim do parágrafo com algum detalhe a mais.`;
const UM_SOCIAL = [
  P("Um guia prático para planilhas."),
  P("Como pedir fórmulas sem errar."),
  P("Como revisar o resultado."),
  P("Quando não confiar na resposta."),
  "#Planilhas #Produtividade",
].join("\n\n");
const UM_CURTO = `Planilha travada? Este guia mostra como pedir fórmulas certas. Mais em ${EDITION_URL} #Planilhas`;

function socialMd(opts: { um?: boolean; curtoUm?: boolean; postPixel?: boolean } = {}): string {
  const parts = ["# Social", "", "## d1", "", "Texto do destaque um.", "", "#Tag", ""];
  if (opts.um !== false) parts.push("## um", "", UM_SOCIAL, "");
  if (opts.postPixel) parts.push("## post_pixel", "", "Post pessoal antigo do D1. linkedin.com/company/diar.ia.br", "");
  parts.push("# Curto", "", "## d1", "", `Curto do d1. Mais em ${EDITION_URL} #Tag`, "");
  if (opts.curtoUm !== false) parts.push("## um", "", UM_CURTO, "");
  return parts.join("\n");
}

const UM_SLIDES = buildUseMelhorSlides(UM_SOCIAL, ITEM.title);
const UM_SLOTS = UM_SLIDES.map((s) => s.slot);
const UM_STAMP = { hash: hashUseMelhorSlides(UM_SLIDES), slots: UM_SLOTS };

function readyPlan(slots: string[] | null = UM_SLOTS): UseMelhorDispatchPlan {
  return { status: "ready", time: "08:00", item: ITEM, slots };
}

function imagesFor(slots: string[], opts: { missing?: string } = {}): Record<string, { url?: string }> {
  const out: Record<string, { url?: string }> = { d1_4x5: { url: "https://cdn/d1.jpg" } };
  for (const slot of slots) {
    if (slot === opts.missing) continue;
    out[useMelhorSlideImageKey(slot)] = { url: `https://cdn/um-${slot}.jpg` };
  }
  return out;
}

const STATE = { enabled: true, time: "08:00", item: ITEM, generated_at: "x" };
const CONFIG_ON = { publishing: { social: { use_melhor_time: "08:00", fallback_schedule: { d1_time: "10:00" } } } };

describe("horário do 4º post (#9568)", () => {
  it("config do repo: use_melhor_time = 08:00 (decisão do editor, 04/10/2026)", () => {
    assert.equal(REPO_CONFIG.publishing.social.use_melhor_time, "08:00");
  });

  it("destaque 'um' agenda às 08:00 BRT na data da edição, em todas as plataformas", () => {
    const now = Date.parse("2030-10-14T12:00:00-03:00");
    for (const platform of ["linkedin", "facebook", "instagram", "threads", "twitter"] as const) {
      const iso = computeScheduledAt({ config: REPO_CONFIG, editionDate: "301015", destaque: "um", platform, now });
      assert.equal(iso, "2030-10-15T08:00:00-03:00", platform);
    }
  });

  it("d1 continua no fallback_schedule (não é afetado)", () => {
    const now = Date.parse("2030-10-14T12:00:00-03:00");
    const iso = computeScheduledAt({ config: REPO_CONFIG, editionDate: "301015", destaque: "d1", platform: "linkedin", now });
    assert.equal(iso, "2030-10-15T10:00:00-03:00");
  });

  it("use_melhor_time ausente → lança (o plano já pula antes; nunca agenda no horário errado)", () => {
    const cfg = { publishing: { social: { timezone: "America/Sao_Paulo", fallback_schedule: { d1_time: "10:00" } } } };
    assert.throws(() => computeScheduledAt({ config: cfg, editionDate: "301015", destaque: "um", platform: "linkedin" }), /use_melhor_time/);
  });
});

describe("UTM do 4º post: utm_content=usemelhor (#9568)", () => {
  it("adiciona utm_content preservando o UTM do canal", () => {
    const out = applyUseMelhorUtmToText(`Mais em ${EDITION_URL}?utm_source=threads&utm_medium=social #Tag`);
    assert.match(out, /utm_source=threads/);
    assert.match(out, /utm_content=usemelhor/);
  });

  it("ponto final do CTA fica fora da URL", () => {
    const out = applyUseMelhorUtmToText("assine grátis em https://diar.ia.br/?utm_source=facebook.");
    assert.ok(out.endsWith("utm_content=usemelhor."), out);
  });

  it("link de terceiro fica intocado", () => {
    const t = "Fonte: https://exame.com/guia-planilhas";
    assert.equal(applyUseMelhorUtmToText(t), t);
  });
});

describe("plano do 4º post (fail-soft, #9568)", () => {
  const base = {
    config: CONFIG_ON,
    state: STATE,
    reviewedMd: null,
    approved: null,
    socialUm: UM_SOCIAL,
    stamp: UM_STAMP,
    ctaOverride: null,
  };

  it("pronto → slot 08:00 + slots do carrossel", () => {
    const plan = planUseMelhorDispatchFrom(base);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;
    assert.equal(plan.time, "08:00");
    assert.deepEqual(plan.slots, UM_SLOTS);
    assert.deepEqual(useMelhorDispatchIds(plan), [USE_MELHOR_POST_ID]);
  });

  it("desligado → off, nenhum id extra", () => {
    const plan = planUseMelhorDispatchFrom({ ...base, config: { publishing: { social: { use_melhor_time: null } } } });
    assert.equal(plan.status, "off");
    assert.deepEqual(useMelhorDispatchIds(plan), []);
  });

  it("sem estado do Stage 2 → skip nível info (o gate já avisou)", () => {
    const plan = planUseMelhorDispatchFrom({ ...base, state: null });
    assert.equal(plan.status, "skip");
    assert.equal(plan.status === "skip" && plan.level, "info");
  });

  it("item mudou no gate (maior score do 02-reviewed final é outro) → skip", () => {
    const approved = {
      use_melhor: [
        { url: ITEM.url, title: ITEM.title, summary: "", score: 88 },
        { url: "https://exame.com/outro", title: "Outro guia", summary: "", score: 95 },
      ],
    };
    const reviewedMd = "**USE MELHOR**\n\n[Outro guia](https://exame.com/outro)\nResumo.\n";
    const plan = planUseMelhorDispatchFrom({ ...base, approved, reviewedMd });
    assert.equal(plan.status, "skip", JSON.stringify(plan));
    assert.match(plan.status === "skip" ? plan.reason : "", /difere/);
  });

  it("carrossel defasado (texto mudou depois do Stage 3) → pronto, mas sem slots", () => {
    const plan = planUseMelhorDispatchFrom({ ...base, stamp: { hash: "outro", slots: UM_SLOTS } });
    assert.equal(plan.status, "ready");
    assert.equal(plan.status === "ready" && plan.slots, null);
  });
});

describe("imagens do 4º post: carrossel com N slides variável (#9568)", () => {
  it(`${UM_SLOTS.length} slides (capa + ${UM_SLOTS.length - 2} parágrafos + CTA), ordem preservada`, () => {
    assert.equal(UM_SLOTS.length, 6);
    const r = resolveUseMelhorImages(imagesFor(UM_SLOTS), readyPlan());
    assert.deepEqual(r.carouselUrls, UM_SLOTS.map((s) => `https://cdn/um-${s}.jpg`));
    assert.equal(r.coverUrl, "https://cdn/um-cover.jpg");
  });

  it("um slide faltando → sem carrossel (tudo-ou-nada), capa continua", () => {
    const r = resolveUseMelhorImages(imagesFor(UM_SLOTS, { missing: "p3" }), readyPlan());
    assert.equal(r.carouselUrls, null);
    assert.equal(r.coverUrl, "https://cdn/um-cover.jpg");
  });
});

describe("payload por rede (#9568)", () => {
  const md = socialMd();

  it("LinkedIn página: texto do ## um sem markdown, capa, 08:00", () => {
    const r = buildUseMelhorLinkedInPost({
      socialMd: md,
      plan: readyPlan(),
      images: imagesFor(UM_SLOTS),
      computeAt: () => "2030-10-15T08:00:00-03:00",
    });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.match(r.text, /Um guia prático para planilhas/);
    assert.doesNotMatch(r.text, /\*\*/);
    assert.equal(r.imageUrl, "https://cdn/um-cover.jpg");
    assert.equal(r.scheduledAt, "2030-10-15T08:00:00-03:00");
  });

  it("LinkedIn página: sem capa pública → pula (Make exige Image URL)", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: md, plan: readyPlan(), images: {}, computeAt: null });
    assert.equal(r.ok, false);
  });

  it("LinkedIn página: sem ## um → pula, sem lançar", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: socialMd({ um: false }), plan: readyPlan(), images: imagesFor(UM_SLOTS), computeAt: null });
    assert.equal(r.ok, false);
  });

  it("plano não-pronto → nenhuma rede monta o post", () => {
    const skip: UseMelhorDispatchPlan = { status: "skip", reason: "x" };
    assert.equal(buildUseMelhorLinkedInPost({ socialMd: md, plan: skip, images: imagesFor(UM_SLOTS), computeAt: null }).ok, false);
    assert.equal(buildUseMelhorFacebookPost({ socialMd: md, plan: skip, images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true }).ok, false);
    assert.equal(buildUseMelhorInstagramPost({ socialMd: md, plan: skip, images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true }).ok, false);
    assert.equal(buildUseMelhorThreadsPost({ socialMd: md, plan: skip, images: imagesFor(UM_SLOTS), editionUrl: EDITION_URL }).ok, false);
  });

  it("Facebook: carrossel de N slides + CTA com utm_content=usemelhor", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: md, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => false });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.carouselUrls?.length, UM_SLOTS.length);
    assert.match(r.caption, /utm_source=facebook/);
    assert.match(r.caption, /utm_content=usemelhor/);
  });

  it("Facebook: carrossel incompleto → foto única com a capa local", () => {
    const r = buildUseMelhorFacebookPost({
      socialMd: md,
      plan: readyPlan(),
      images: imagesFor(UM_SLOTS, { missing: "cta" }),
      editionDir: "x",
      fileExists: () => true,
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.carouselUrls, null);
    assert.equal(r.imageFile, USE_MELHOR_COVER_FILE);
  });

  it("Facebook: nem carrossel nem capa local → pula", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: md, plan: readyPlan(), images: {}, editionDir: "x", fileExists: () => false });
    assert.equal(r.ok, false);
  });

  it("Instagram: carrossel com quantos slides o conteúdo pedir (não 5 fixos)", () => {
    const r = buildUseMelhorInstagramPost({ socialMd: md, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.imageUrls.length, 6);
    assert.notEqual(r.imageUrls.length, 5);
    assert.match(r.caption, /link da bio/);
  });

  it("Instagram: slide faltando → imagem única (capa)", () => {
    const r = buildUseMelhorInstagramPost({
      socialMd: md,
      plan: readyPlan(),
      images: imagesFor(UM_SLOTS, { missing: "p2" }),
      editionDir: "x",
      fileExists: () => true,
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.imageUrls, ["https://cdn/um-cover.jpg"]);
  });

  it("Threads: texto do # Curto com utm_source=threads + utm_content=usemelhor, carrossel N", () => {
    const r = buildUseMelhorThreadsPost({ socialMd: md, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionUrl: EDITION_URL });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.match(r.text, /utm_source=threads/);
    assert.match(r.text, /utm_content=usemelhor/);
    assert.equal(r.carouselUrls?.length, 6);
  });

  it("Threads: sem ## um em # Curto → pula", () => {
    const r = buildUseMelhorThreadsPost({ socialMd: socialMd({ curtoUm: false }), plan: readyPlan(), images: {}, editionUrl: EDITION_URL });
    assert.equal(r.ok, false);
  });
});

function makeEdition(opts: { state?: boolean; curtoUm?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "um-dispatch-"));
  const ed = join(dir, "301015");
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeFileSync(join(ed, "03-social.md"), socialMd({ curtoUm: opts.curtoUm }), "utf8");
  writeFileSync(join(ed, "_internal", "05-edition-url.txt"), EDITION_URL, "utf8");
  writeFileSync(join(ed, "06-public-images.json"), JSON.stringify({ images: imagesFor(UM_SLOTS) }), "utf8");
  writeFileSync(useMelhorCarouselHashPath(ed), JSON.stringify(UM_STAMP), "utf8");
  if (opts.state !== false) writeUseMelhorPostState(ed, STATE);
  return ed;
}

describe("X via Buffer: prepTwitterPosts inclui o 4º post (#9568)", () => {
  const config = {
    publishing: {
      social: {
        twitter: { enabled: true },
        fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
        use_melhor_time: "08:00",
        timezone: "America/Sao_Paulo",
      },
    },
  };
  const now = Date.parse("2030-10-14T12:00:00-03:00");

  it("post 'um' às 08:00 BRT, UTM do X + usemelhor, capa + 3 parágrafos (sem CTA)", () => {
    const ed = makeEdition();
    try {
      const r = prepTwitterPosts(ed, { config, now, editionDate: "301015", logRootDir: dirname(ed) });
      const um = r.posts.find((p) => p.destaque === "um");
      assert.ok(um, JSON.stringify(r));
      assert.equal(um!.dueAt, "2030-10-15T08:00:00-03:00");
      assert.match(um!.text, /utm_source=twitter/);
      assert.match(um!.text, /utm_content=usemelhor/);
      assert.deepEqual(
        um!.images.map((i) => i.url),
        ["cover", "p1", "p2", "p3"].map((s) => `https://cdn/um-${s}.jpg`),
      );
      assert.ok(r.posts.some((p) => p.destaque === "d1"), "d1 não pode ser afetado");
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("sem estado do Stage 2 → sem post 'um', d1 intacto", () => {
    const ed = makeEdition({ state: false });
    try {
      const r = prepTwitterPosts(ed, { config, now, editionDate: "301015", logRootDir: dirname(ed) });
      assert.equal(r.posts.some((p) => p.destaque === "um"), false);
      assert.ok(r.posts.some((p) => p.destaque === "d1"));
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("sem ## um em # Curto → 'um' em skipped com motivo, d1 intacto", () => {
    const ed = makeEdition({ curtoUm: false });
    try {
      const r = prepTwitterPosts(ed, { config, now, editionDate: "301015", logRootDir: dirname(ed) });
      assert.equal(r.posts.some((p) => p.destaque === "um"), false);
      assert.ok(r.skipped.some((s) => s.destaque === "um"));
      // warn persistido no run-log da raiz injetada (nunca no data/ real, #3311)
      const log = readFileSync(join(dirname(ed), "data", "run-log.jsonl"), "utf8");
      assert.match(log, /4º post \(USE MELHOR\) pulado em twitter/);
      assert.ok(r.posts.some((p) => p.destaque === "d1"));
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
});

describe("LinkedIn pessoal recebe o ## um, não o ## post_pixel (#9568)", () => {
  it("edição nova: texto do ## um (mesmo da página), capa tipográfica", () => {
    const r = extractPersonalPostText(socialMd({ postPixel: true }));
    assert.equal(r?.source, "um");
    assert.match(r!.text, /Um guia prático para planilhas/);
    assert.doesNotMatch(r!.text, /Post pessoal antigo/);
    assert.doesNotMatch(r!.text, /\*\*/);
    assert.equal(personalPostImageFile("um"), "04-um-carousel-cover-4x5.jpg");
  });

  it("edição antiga (sem ## um): cai no ## post_pixel legado sem quebrar", () => {
    const r = extractPersonalPostText(socialMd({ um: false, postPixel: true }));
    assert.equal(r?.source, "post_pixel");
    assert.match(r!.text, /Post pessoal antigo/);
    assert.equal(personalPostImageFile("post_pixel"), "04-d1-1x1.jpg");
  });

  it("nem ## um nem ## post_pixel → null", () => {
    assert.equal(extractPersonalPostText(socialMd({ um: false })), null);
  });
});

describe("upload dos slides do 4º post (#9568)", () => {
  it("specs saem do carimbo do Stage 3, N variável", () => {
    const ed = makeEdition();
    try {
      const specs = useMelhorSlideSpecs(ed);
      assert.deepEqual(specs.map((s) => s.key), UM_SLOTS.map(useMelhorSlideImageKey));
      assert.ok(specs.every((s) => s.optional === true));
      assert.equal(specs[0].filename, USE_MELHOR_COVER_FILE);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("sem carimbo / sem editionDir → nenhuma spec", () => {
    assert.deepEqual(useMelhorSlideSpecs(undefined), []);
    const dir = mkdtempSync(join(tmpdir(), "um-nostamp-"));
    try {
      assert.deepEqual(useMelhorSlideSpecs(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lints cobrem o ## um (#9568)", () => {
  it("no-email-cta-instagram pega CTA de e-mail no ## um", () => {
    const md = `# Social\n\n## d1\n\nTexto d1.\n\n## um\n\nTexto. Receba por e-mail toda manhã.\n`;
    const r = lintInstagramEmailCTA(md);
    assert.ok(r.errors.some((e) => e.section === "um"), JSON.stringify(r));
  });

  it("no-trailing-question pega pergunta no fim do ## um", () => {
    const md = `# Social\n\n## d1\n\nTexto d1 afirmativo.\n\n## um\n\nVocê já testou isso no seu trabalho?\n`;
    const r = lintTrailingQuestion(md);
    assert.ok(r.matches.some((m) => m.destaque === "um"), JSON.stringify(r));
  });

  it("linkedin-schema valida o ## um com faixa própria (texto longo de carrossel não é erro)", () => {
    const r = lintLinkedinSchema(socialMd());
    const um = r.destaques.find((d) => d.destaque === "um");
    assert.ok(um, JSON.stringify(r.destaques));
    assert.equal(r.errors.some((e) => e.destaque === "um" && e.rule === "main_chars_out_of_range"), false);
  });

  it("humanizer-section-coverage acusa ## um não tocado", () => {
    const pre = socialMd();
    const post = pre.replace("Texto do destaque um.", "Texto do destaque um, reescrito.");
    const r = checkHumanizerSectionCoverage(pre, post);
    assert.ok(r.untouched.includes("main_um"), JSON.stringify(r));
  });
});

describe("paridade do id do 4º post (#9568)", () => {
  it("use-melhor-slide-files usa o mesmo id de use-melhor-post", () => {
    assert.equal(USE_MELHOR_POST_ID, "um");
    assert.equal(useMelhorSlideImageKey("cover"), `${USE_MELHOR_POST_ID}_carousel_cover`);
  });
});
