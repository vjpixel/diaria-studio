/**
 * test/use-melhor-dispatch-9568.test.ts (#9568 — Stage 5)
 *
 * Dispatch do 4º post social (item USE MELHOR, `## um`). Cobre:
 *   - horário: `computeScheduledAt({ destaque: "um" })` → `use_melhor_time`
 *     (08:00 BRT no config do repo), mesmo cálculo de data dos destaques;
 *   - contrato com o Worker `linkedin-cron`: `destaque` emitido aceito pelo
 *     regex de POST /queue (sem isso, 400 em LinkedIn/Instagram/Threads);
 *   - UTM: `utm_content=usemelhor` por cima do UTM do canal, só em link do projeto;
 *   - plano (fail-soft, falha FECHADA): desligado / sem item / sem edição
 *     final / item mudou ou sumiu no gate / carrossel defasado (nem a capa vale);
 *   - montagem por rede (LinkedIn página, Facebook, Instagram, Threads, X):
 *     carrossel de N slides variável, fallback pra capa, pulo sem peça;
 *   - idempotência em re-execução e `failed` em erro de agendamento;
 *   - LinkedIn pessoal: `## um` só com plano pronto; legado `## post_pixel`;
 *   - upload só de slots frescos; lints estendidos pro `## um`;
 *   - módulo folha `use-melhor-slide-files.ts` só importa `node:*`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";
import {
  applyUseMelhorUtmToText,
  findExistingUseMelhorEntry,
  freshUseMelhorCarouselSlots,
  planUseMelhorDispatchFrom,
  resolveUseMelhorImages,
  summarizeUseMelhor,
  useMelhorDispatchIds,
  USE_MELHOR_COVER_FILE,
  type UseMelhorReadyPlan,
} from "../scripts/lib/use-melhor-dispatch.ts";
import { USE_MELHOR_POST_ID, writeUseMelhorPostState } from "../scripts/lib/use-melhor-post.ts";
import { buildUseMelhorSlides, hashUseMelhorSlides } from "../scripts/lib/use-melhor-carousel.ts";
import { useMelhorSlideImageKey, useMelhorCarouselHashPath } from "../scripts/lib/use-melhor-slide-files.ts";
import { buildUseMelhorLinkedInPost } from "../scripts/publish-linkedin.ts";
import { buildUseMelhorFacebookPost } from "../scripts/publish-facebook.ts";
import { buildUseMelhorInstagramPost } from "../scripts/publish-instagram.ts";
import { buildUseMelhorThreadsPost } from "../scripts/publish-threads.ts";
import { prepTwitterPosts } from "../scripts/prep-twitter-posts.ts";
import { extractPersonalPostText, personalPostImageFile, resolvePersonalPost } from "../scripts/resolve-post-pixel.ts";
import { imageSpecsFor, useMelhorSlideSpecs } from "../scripts/upload-images-public.ts";
import {
  checkHumanizerSectionCoverage,
  lintCredentialBio,
  lintInstagramEmailCTA,
  lintLinkedinSchema,
  lintPersonalPostNewsletterDeixis,
  lintTrailingQuestion,
} from "../scripts/lib/social-lint-rules.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Lido do FONTE do Worker (não importado: o tsconfig de teste não tem
// @cloudflare/workers-types, e importar o Worker vaza KVNamespace etc. pro
// typecheck de test/**). Mesmo padrão de espelho de WORKER_DESTAQUE_RE (#6123).
const QUEUE_DESTAQUE_RE: RegExp = (() => {
  const src = readFileSync(resolve(ROOT, "workers/linkedin-cron/src/index.ts"), "utf8");
  const m = src.match(/export const QUEUE_DESTAQUE_RE = \/(.+)\/;/);
  if (!m) throw new Error("QUEUE_DESTAQUE_RE não encontrado em workers/linkedin-cron/src/index.ts");
  return new RegExp(m[1]);
})();
const REPO_CONFIG = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
const EDITION_URL = "https://diar.ia.br/p/edicao-teste";

const ITEM = { url: "https://exame.com/guia-planilhas", title: "Guia de planilhas com IA", summary: "Resumo.", score: 88 };
const APPROVED = { use_melhor: [{ url: ITEM.url, title: ITEM.title, summary: ITEM.summary, score: ITEM.score }] };
const REVIEWED = `**USE MELHOR**\n\n[${ITEM.title}](${ITEM.url})\nResumo do guia.\n`;
const P = (s: string) => `${s} **Trecho em negrito.** Fim do parágrafo com algum detalhe a mais.`;
const UM_SOCIAL = [
  P("Um guia prático para planilhas."),
  P("Como pedir fórmulas sem errar."),
  P("Como revisar o resultado."),
  P("Quando não confiar na resposta."),
  "#Planilhas #Produtividade",
].join("\n\n");
const UM_CURTO = `Planilha travada? Este guia mostra como pedir fórmulas certas. Mais em ${EDITION_URL} #Planilhas`;

function socialMd(opts: { um?: boolean | string; curtoUm?: boolean; postPixel?: boolean } = {}): string {
  const parts = ["# Social", "", "## d1", "", "Texto do destaque um.", "", "#Tag", ""];
  if (opts.um !== false) parts.push("## um", "", typeof opts.um === "string" ? opts.um : UM_SOCIAL, "");
  if (opts.postPixel) parts.push("## post_pixel", "", "Post pessoal antigo do D1. linkedin.com/company/diar.ia.br", "");
  parts.push("# Curto", "", "## d1", "", `Curto do d1. Mais em ${EDITION_URL} #Tag`, "");
  if (opts.curtoUm !== false) parts.push("## um", "", UM_CURTO, "");
  return parts.join("\n");
}

const UM_SLIDES = buildUseMelhorSlides(UM_SOCIAL, ITEM.title);
const UM_SLOTS = UM_SLIDES.map((s) => s.slot);
const UM_STAMP = { hash: hashUseMelhorSlides(UM_SLIDES), slots: UM_SLOTS };

function readyPlan(slots: string[] | null = UM_SLOTS, imageWarning?: string): UseMelhorReadyPlan {
  return { status: "ready", time: "08:00", item: ITEM, slots, ...(imageWarning && { imageWarning }) };
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

describe("contrato com o Worker linkedin-cron (#9568, P1 do review)", () => {
  it("o destaque do 4º post é aceito por POST /queue", () => {
    for (const id of useMelhorDispatchIds(readyPlan())) assert.ok(QUEUE_DESTAQUE_RE.test(id), id);
    assert.ok(QUEUE_DESTAQUE_RE.test(USE_MELHOR_POST_ID));
  });

  it("os ids dos destaques diários seguem aceitos e lixo segue recusado", () => {
    for (const d of ["d1", "d2", "d3"]) assert.ok(QUEUE_DESTAQUE_RE.test(d));
    for (const d of ["d4", "umm", "post_pixel", ""]) assert.equal(QUEUE_DESTAQUE_RE.test(d), false, d);
  });

  it("publishers que enfileiram no Worker emitem o destaque 'um' (fonte)", () => {
    // LinkedIn passa o literal; Instagram/Threads iteram `dispatchIds` (d1..d3 + useMelhorDispatchIds).
    const li = readFileSync(resolve(ROOT, "scripts/publish-linkedin.ts"), "utf8");
    assert.match(li, /destaque: "um",\s*\n\s*subtype: "main"/);
    for (const f of ["scripts/publish-instagram.ts", "scripts/publish-threads.ts"]) {
      assert.match(readFileSync(resolve(ROOT, f), "utf8"), /useMelhorDispatchIds\(umPlan\)/, f);
    }
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

  it("página Kit da diária ganha; link de terceiro (inclusive outro *.kit.com) fica intocado", () => {
    assert.match(applyUseMelhorUtmToText("https://diariabr.kit.com/posts/x"), /utm_content=usemelhor/);
    for (const t of ["Fonte: https://exame.com/guia-planilhas", "https://outra.kit.com/p"]) {
      assert.equal(applyUseMelhorUtmToText(t), t);
    }
  });
});

describe("plano do 4º post (fail-soft, falha fechada, #9568)", () => {
  const base = {
    config: CONFIG_ON,
    state: STATE,
    reviewedMd: REVIEWED,
    approved: APPROVED,
    socialUm: UM_SOCIAL,
    stamp: UM_STAMP,
    ctaOverride: null,
  };

  it("mesmo item na edição final → pronto, slot 08:00 + slots do carrossel", () => {
    const plan = planUseMelhorDispatchFrom(base);
    assert.equal(plan.status, "ready", JSON.stringify(plan));
    if (plan.status !== "ready") return;
    assert.equal(plan.time, "08:00");
    assert.deepEqual(plan.slots, UM_SLOTS);
    assert.equal(plan.imageWarning, undefined);
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

  it("sem 02-reviewed.md ou sem JSON aprovado → skip warn (nunca 'ready' sem re-verificar)", () => {
    for (const patch of [{ reviewedMd: null }, { approved: null }]) {
      const plan = planUseMelhorDispatchFrom({ ...base, ...patch });
      assert.equal(plan.status, "skip", JSON.stringify(patch));
      assert.equal(plan.status === "skip" ? plan.level : "x", undefined); // default warn
      assert.match(plan.status === "skip" ? plan.reason : "", /re-verificar/);
    }
  });

  it("USE MELHOR removido no gate (final.item === null) → skip 'na edição final'", () => {
    const plan = planUseMelhorDispatchFrom({ ...base, reviewedMd: "**RADAR**\n\n[x](https://y.com)\nz\n" });
    assert.equal(plan.status, "skip");
    assert.match(plan.status === "skip" ? plan.reason : "", /na edição final/);
  });

  it("item mudou no gate (maior score do 02-reviewed final é outro) → skip", () => {
    const approved = {
      use_melhor: [...APPROVED.use_melhor, { url: "https://exame.com/outro", title: "Outro guia", summary: "", score: 95 }],
    };
    const reviewedMd = "**USE MELHOR**\n\n[Outro guia](https://exame.com/outro)\nResumo.\n";
    const plan = planUseMelhorDispatchFrom({ ...base, approved, reviewedMd });
    assert.equal(plan.status, "skip", JSON.stringify(plan));
    assert.match(plan.status === "skip" ? plan.reason : "", /difere/);
  });

  it("carrossel defasado → pronto, sem slots E com imageWarning (nem a capa vale)", () => {
    const plan = planUseMelhorDispatchFrom({ ...base, stamp: { hash: "outro", slots: UM_SLOTS } });
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;
    assert.equal(plan.slots, null);
    assert.match(plan.imageWarning ?? "", /DEFASADO/);
    const imgs = resolveUseMelhorImages(imagesFor(UM_SLOTS), plan);
    assert.deepEqual(imgs, { carouselUrls: null, coverUrl: null });
  });

  it("summarizeUseMelhor: plano + resultado do builder", () => {
    assert.deepEqual(summarizeUseMelhor({ status: "off", reason: "x" }, null), { status: "off", reason: "x" });
    assert.deepEqual(summarizeUseMelhor(readyPlan(), { ok: false, reason: "sem capa" }), { status: "skip", reason: "sem capa" });
    assert.deepEqual(summarizeUseMelhor(readyPlan(), { ok: true }), { status: "ready" });
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

  it("LinkedIn página: texto do ## um sem markdown + capa", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: md, plan: readyPlan(), images: imagesFor(UM_SLOTS) });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.match(r.text, /Um guia prático para planilhas/);
    assert.doesNotMatch(r.text, /\*\*/);
    assert.equal(r.imageUrl, "https://cdn/um-cover.jpg");
  });

  it("LinkedIn página: sem capa pública ou carimbo defasado → pula (Make exige Image URL)", () => {
    assert.equal(buildUseMelhorLinkedInPost({ socialMd: md, plan: readyPlan(), images: {} }).ok, false);
    const stale = buildUseMelhorLinkedInPost({ socialMd: md, plan: readyPlan(null, "DEFASADO"), images: imagesFor(UM_SLOTS) });
    assert.deepEqual(stale, { ok: false, reason: "DEFASADO" });
  });

  it("LinkedIn página: sem ## um → pula, sem lançar", () => {
    const r = buildUseMelhorLinkedInPost({ socialMd: socialMd({ um: false }), plan: readyPlan(), images: imagesFor(UM_SLOTS) });
    assert.equal(r.ok, false);
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

  it("Facebook: carimbo defasado → nem a capa local vale, pula", () => {
    const r = buildUseMelhorFacebookPost({ socialMd: md, plan: readyPlan(null, "DEFASADO"), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true });
    assert.deepEqual(r, { ok: false, reason: "DEFASADO" });
  });

  it("Facebook/Instagram: ## um vazio → pula (não publica só a linha de CTA)", () => {
    const empty = socialMd({ um: "<!-- char_count: 0 -->" });
    assert.equal(buildUseMelhorFacebookPost({ socialMd: empty, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true }).ok, false);
    assert.equal(buildUseMelhorInstagramPost({ socialMd: empty, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true }).ok, false);
  });

  it("Instagram: carrossel com quantos slides o conteúdo pedir (não 5 fixos)", () => {
    const r = buildUseMelhorInstagramPost({ socialMd: md, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.imageUrls.length, 6);
    assert.match(r.caption, /link da bio/);
  });

  it("Instagram: slide faltando → imagem única (capa); carimbo defasado → pula", () => {
    const r = buildUseMelhorInstagramPost({
      socialMd: md,
      plan: readyPlan(),
      images: imagesFor(UM_SLOTS, { missing: "p2" }),
      editionDir: "x",
      fileExists: () => true,
    });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.imageUrls, ["https://cdn/um-cover.jpg"]);
    const stale = buildUseMelhorInstagramPost({ socialMd: md, plan: readyPlan(null, "DEFASADO"), images: imagesFor(UM_SLOTS), editionDir: "x", fileExists: () => true });
    assert.equal(stale.ok, false);
  });

  it("Threads: texto do # Curto com utm_source=threads + utm_content=usemelhor, carrossel N", () => {
    const r = buildUseMelhorThreadsPost({ socialMd: md, plan: readyPlan(), images: imagesFor(UM_SLOTS), editionUrl: EDITION_URL });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.match(r.text, /utm_source=threads/);
    assert.match(r.text, /utm_content=usemelhor/);
    assert.equal(r.carouselUrls?.length, 6);
  });

  it("Threads: carimbo defasado → só texto; sem ## um em # Curto → pula", () => {
    const stale = buildUseMelhorThreadsPost({ socialMd: md, plan: readyPlan(null, "x"), images: imagesFor(UM_SLOTS), editionUrl: EDITION_URL });
    assert.ok(stale.ok);
    if (stale.ok) assert.equal(stale.carouselUrls, null);
    const r = buildUseMelhorThreadsPost({ socialMd: socialMd({ curtoUm: false }), plan: readyPlan(), images: {}, editionUrl: EDITION_URL });
    assert.equal(r.ok, false);
  });
});

function makeEdition(opts: { state?: boolean; curtoUm?: boolean; stamp?: object | null; reviewed?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "um-dispatch-"));
  const ed = join(dir, "301015");
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeFileSync(join(ed, "03-social.md"), socialMd({ curtoUm: opts.curtoUm }), "utf8");
  writeFileSync(join(ed, "02-reviewed.md"), opts.reviewed ?? REVIEWED, "utf8");
  writeFileSync(join(ed, "_internal", "01-approved-capped.json"), JSON.stringify(APPROVED), "utf8");
  writeFileSync(join(ed, "_internal", "05-edition-url.txt"), EDITION_URL, "utf8");
  writeFileSync(join(ed, "06-public-images.json"), JSON.stringify({ images: imagesFor(UM_SLOTS) }), "utf8");
  writeFileSync(join(ed, USE_MELHOR_COVER_FILE), "jpg", "utf8");
  if (opts.stamp !== null) writeFileSync(useMelhorCarouselHashPath(ed), JSON.stringify(opts.stamp ?? UM_STAMP), "utf8");
  if (opts.state !== false) writeUseMelhorPostState(ed, STATE);
  return ed;
}

const X_CONFIG = {
  publishing: {
    social: {
      twitter: { enabled: true },
      fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
      use_melhor_time: "08:00",
      timezone: "America/Sao_Paulo",
    },
  },
};
const X_NOW = Date.parse("2030-10-14T12:00:00-03:00");

describe("X via Buffer: prepTwitterPosts inclui o 4º post (#9568)", () => {
  const prep = (ed: string, config: unknown = X_CONFIG) =>
    prepTwitterPosts(ed, { config, now: X_NOW, editionDate: "301015", logRootDir: dirname(ed) });

  it("post 'um' às 08:00 BRT, UTM do X + usemelhor, capa + 3 parágrafos (sem CTA)", () => {
    const ed = makeEdition();
    try {
      const r = prep(ed);
      const um = r.posts.find((p) => p.destaque === "um");
      assert.ok(um, JSON.stringify(r));
      assert.equal(um!.dueAt, "2030-10-15T08:00:00-03:00");
      assert.match(um!.text, /utm_source=twitter/);
      assert.match(um!.text, /utm_content=usemelhor/);
      assert.deepEqual(um!.images.map((i) => i.url), ["cover", "p1", "p2", "p3"].map((s) => `https://cdn/um-${s}.jpg`));
      assert.deepEqual(r.use_melhor, { status: "ready" });
      assert.ok(r.posts.some((p) => p.destaque === "d1"), "d1 não pode ser afetado");
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("sem estado do Stage 2 → sem post 'um', motivo em use_melhor, d1 intacto", () => {
    const ed = makeEdition({ state: false });
    try {
      const r = prep(ed);
      assert.equal(r.posts.some((p) => p.destaque === "um"), false);
      assert.equal(r.use_melhor?.status, "skip");
      assert.ok(r.posts.some((p) => p.destaque === "d1"));
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("sem ## um em # Curto → 'um' em skipped com motivo + warn no run-log, d1 intacto", () => {
    const ed = makeEdition({ curtoUm: false });
    try {
      const r = prep(ed);
      assert.equal(r.posts.some((p) => p.destaque === "um"), false);
      assert.ok(r.skipped.some((s) => s.destaque === "um"));
      assert.ok(r.posts.some((p) => p.destaque === "d1"));
      // warn persistido no run-log da raiz injetada (nunca no data/ real, #3311)
      const log = readFileSync(join(dirname(ed), "data", "run-log.jsonl"), "utf8");
      assert.match(log, /4º post \(USE MELHOR\) pulado em twitter/);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("re-execução: 'um' já agendado no store → não sai de novo (idempotente)", () => {
    const ed = makeEdition();
    try {
      writeFileSync(
        join(ed, "_internal", "06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "twitter", destaque: "um", url: null, status: "scheduled", scheduled_at: "x" }] }),
        "utf8",
      );
      const r = prep(ed);
      assert.equal(r.posts.some((p) => p.destaque === "um"), false);
      assert.ok(r.skipped.some((s) => s.destaque === "um" && /already scheduled/.test(s.reason)));
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("schedule_error do 'um' grava entry failed no store (mesmo peso dos destaques)", () => {
    const ed = makeEdition();
    try {
      // Hora fora de HH:MM só no `um` passa pelo plano? Não — o plano desliga.
      // Simula com slot override inválido só pro 'um' (lança em readSlotOverride).
      const slots = join(dirname(ed), "slots.json");
      writeFileSync(slots, JSON.stringify({ edition: "301015", slots: { um: "lixo" } }), "utf8");
      const prev = process.env.DIARIA_SOCIAL_SLOTS_FILE;
      process.env.DIARIA_SOCIAL_SLOTS_FILE = slots;
      let r;
      try {
        r = prep(ed);
      } finally {
        if (prev === undefined) delete process.env.DIARIA_SOCIAL_SLOTS_FILE;
        else process.env.DIARIA_SOCIAL_SLOTS_FILE = prev;
      }
      assert.ok(r.skipped.some((s) => s.destaque === "um" && /schedule_error/.test(s.reason)));
      const store = JSON.parse(readFileSync(join(ed, "_internal", "06-social-published.json"), "utf8"));
      assert.ok(store.posts.some((p: { destaque: string; status: string }) => p.destaque === "um" && p.status === "failed"));
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
});

describe("idempotência (LinkedIn/qualquer canal): findExistingUseMelhorEntry (#9568)", () => {
  const posts = [
    { platform: "linkedin", destaque: "d1", status: "scheduled" },
    { platform: "linkedin", destaque: "um", status: "failed" },
    { platform: "facebook", destaque: "um", status: "scheduled" },
  ];
  it("failed é retentado; outra plataforma não conta", () => {
    assert.equal(findExistingUseMelhorEntry(posts, "linkedin"), undefined);
    assert.ok(findExistingUseMelhorEntry(posts, "facebook"));
  });
  it("entry agendada sem subtype (=main) bloqueia; subtype comment não", () => {
    assert.ok(findExistingUseMelhorEntry([{ platform: "linkedin", destaque: "um", status: "scheduled" }], "linkedin"));
    assert.equal(
      findExistingUseMelhorEntry([{ platform: "linkedin", destaque: "um", status: "scheduled", subtype: "comment_pixel" }], "linkedin"),
      undefined,
    );
  });
});

const RPP = resolve(ROOT, "scripts/resolve-post-pixel.ts");
function runRpp(ed: string, args: string[] = [], config: unknown = CONFIG_ON) {
  const cfg = join(dirname(ed), "cfg.json");
  writeFileSync(cfg, JSON.stringify(config), "utf8");
  const r = spawnSync(process.execPath, ["--import", "tsx", RPP, "--edition-dir", ed, "--config", cfg, ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
  return { stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "", code: r.status };
}

describe("LinkedIn pessoal recebe o ## um, não o ## post_pixel (#9568)", () => {
  it("extração: edição nova = ## um sem markdown; legado = ## post_pixel; nenhum = null", () => {
    const novo = extractPersonalPostText(socialMd({ postPixel: true }));
    assert.equal(novo?.source, "um");
    assert.match(novo!.text, /Um guia prático para planilhas/);
    assert.doesNotMatch(novo!.text, /\*\*|Post pessoal antigo/);
    const legado = extractPersonalPostText(socialMd({ um: false, postPixel: true }));
    assert.equal(legado?.source, "post_pixel");
    assert.equal(extractPersonalPostText(socialMd({ um: false })), null);
    assert.equal(personalPostImageFile("um"), "04-um-carousel-cover-4x5.jpg");
    assert.equal(personalPostImageFile("post_pixel"), "04-d1-1x1.jpg");
  });

  it("resolvePersonalPost: ## um só com plano ready; capa só com carimbo em dia", () => {
    const personal = extractPersonalPostText(socialMd());
    const skip = resolvePersonalPost({ personal, plan: { status: "skip", reason: "mudou" }, fileExists: () => true, scheduledAt: null });
    assert.deepEqual(skip, { ok: false, reason: "4º post (USE MELHOR) não sai nesta edição — mudou" });
    const stale = resolvePersonalPost({ personal, plan: readyPlan(null, "x"), fileExists: () => true, scheduledAt: "t" });
    assert.ok(stale.ok);
    if (stale.ok) assert.equal(stale.image, null);
  });

  it("CLI modo um: texto do ## um, exit 0", () => {
    const ed = makeEdition();
    try {
      const r = runRpp(ed);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Um guia prático para planilhas/);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("CLI --image: capa existente → nome do arquivo; carimbo ausente → (nao encontrado) exit 1", () => {
    const ed = makeEdition();
    try {
      const r = runRpp(ed, ["--image"]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, USE_MELHOR_COVER_FILE);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
    const ed2 = makeEdition({ stamp: null });
    try {
      const r = runRpp(ed2, ["--image"]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "(nao encontrado)");
    } finally {
      rmSync(dirname(ed2), { recursive: true, force: true });
    }
  });

  it("CLI --json: scheduled_at vem da entry linkedin/um do store", () => {
    const ed = makeEdition();
    try {
      writeFileSync(
        join(ed, "_internal", "06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "linkedin", destaque: "um", url: null, status: "scheduled", scheduled_at: "2030-10-15T08:05:00-03:00" }] }),
        "utf8",
      );
      const r = runRpp(ed, ["--json"]);
      assert.equal(r.code, 0, r.stderr);
      const j = JSON.parse(r.stdout);
      assert.equal(j.source, "um");
      assert.equal(j.scheduled_at, "2030-10-15T08:05:00-03:00");
      assert.equal(j.image, USE_MELHOR_COVER_FILE);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });

  it("CLI plano pulado (item sumiu no gate) → (nao encontrado) + motivo, exit 1", () => {
    const ed = makeEdition({ reviewed: "**RADAR**\n\n[x](https://y.com)\nz\n" });
    try {
      const r = runRpp(ed);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "(nao encontrado)");
      assert.match(r.stderr, /na edição final/);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
  });
});

describe("upload dos slides do 4º post (#9568)", () => {
  it("só slots de carimbo EM DIA com o texto; carimbo defasado/ausente → nenhum", () => {
    const ed = makeEdition();
    try {
      assert.deepEqual(freshUseMelhorCarouselSlots(ed), UM_SLOTS);
    } finally {
      rmSync(dirname(ed), { recursive: true, force: true });
    }
    for (const stamp of [{ hash: "velho", slots: UM_SLOTS }, null]) {
      const e2 = makeEdition({ stamp });
      try {
        assert.deepEqual(freshUseMelhorCarouselSlots(e2), []);
      } finally {
        rmSync(dirname(e2), { recursive: true, force: true });
      }
    }
  });

  it("specs com N variável, optional, na ordem; imageSpecsFor sem slots não inclui nada do 4º post", () => {
    const specs = useMelhorSlideSpecs(UM_SLOTS);
    assert.deepEqual(specs.map((s) => s.key), UM_SLOTS.map(useMelhorSlideImageKey));
    assert.ok(specs.every((s) => s.optional === true));
    assert.equal(specs[0].filename, USE_MELHOR_COVER_FILE);
    assert.equal(imageSpecsFor("social").some((s) => s.key.startsWith("um_")), false);
    assert.equal(imageSpecsFor("social", undefined, { useMelhorSlots: UM_SLOTS }).filter((s) => s.key.startsWith("um_")).length, 6);
  });
});

describe("lints cobrem o ## um (#9568)", () => {
  it("no-email-cta-instagram pega CTA de e-mail no ## um", () => {
    const md = `# Social\n\n## d1\n\nTexto d1.\n\n## um\n\nTexto. Receba por e-mail toda manhã.\n`;
    assert.ok(lintInstagramEmailCTA(md).errors.some((e) => e.section === "um"));
  });

  it("no-trailing-question pega pergunta no fim do ## um", () => {
    const md = `# Social\n\n## d1\n\nTexto d1 afirmativo.\n\n## um\n\nVocê já testou isso no seu trabalho?\n`;
    assert.ok(lintTrailingQuestion(md).matches.some((m) => m.destaque === "um"));
  });

  it("linkedin-schema: faixa própria do ## um (≈1400 chars ok, < 300 erro); d1 com 1400 seguiria erro", () => {
    const long = Array.from({ length: 6 }, (_, i) => `Parágrafo ${i + 1} ${"x".repeat(220)}.`).join("\n\n");
    assert.ok(long.length > 1300 && long.length < 1600, String(long.length));
    const okUm = lintLinkedinSchema(`# Social\n\n## d1\n\n${"y".repeat(700)}\n\n## um\n\n${long}\n`);
    assert.equal(okUm.errors.some((e) => e.destaque === "um"), false, JSON.stringify(okUm.errors));
    const longD1 = lintLinkedinSchema(`# Social\n\n## d1\n\n${long}\n`);
    assert.ok(longD1.errors.some((e) => e.destaque === "d1" && e.rule === "main_chars_out_of_range"));
    const shortUm = lintLinkedinSchema(`# Social\n\n## d1\n\n${"y".repeat(700)}\n\n## um\n\nCurto demais.\n`);
    assert.ok(shortUm.errors.some((e) => e.destaque === "um" && e.rule === "main_chars_out_of_range"));
  });

  it("humanizer-section-coverage acusa ## um não tocado", () => {
    const pre = socialMd();
    const post = pre.replace("Texto do destaque um.", "Texto do destaque um, reescrito.");
    assert.ok(checkHumanizerSectionCoverage(pre, post).untouched.includes("main_um"));
  });

  it("personal-post-no-newsletter-deixis e no-credential-bio cobrem ## um (post pessoal) e mantêm ## post_pixel", () => {
    const bad = `# Social\n\n## d1\n\nTexto d1.\n\n## um\n\nNesta edição, esta newsletter traz um guia. Faço uma newsletter sobre isso.\n`;
    assert.ok(lintPersonalPostNewsletterDeixis(bad).matches.some((m) => m.section === "um"));
    assert.ok(lintCredentialBio(bad).matches.some((m) => m.section === "um"));
    const legacy = `# Social\n\n## d1\n\nTexto d1.\n\n## post_pixel\n\nEsta newsletter é minha. Faço uma newsletter.\n`;
    assert.ok(lintPersonalPostNewsletterDeixis(legacy).matches.some((m) => m.section === "post_pixel"));
    assert.ok(lintCredentialBio(legacy).matches.some((m) => m.section === "post_pixel"));
  });

  it("negativos: ## um limpo e d{N} com 'esta newsletter' não são flagados", () => {
    const ok = `# Social\n\n## d1\n\nEsta newsletter no d1 não é post pessoal.\n\n## um\n\nUm guia prático, direto ao ponto.\n`;
    assert.deepEqual(lintPersonalPostNewsletterDeixis(ok).matches, []);
    assert.deepEqual(lintCredentialBio(ok).matches, []);
  });
});

describe("módulo folha use-melhor-slide-files (#9568)", () => {
  it("só importa node:* (importável por upload-images-public sem ciclo)", () => {
    const src = readFileSync(resolve(ROOT, "scripts/lib/use-melhor-slide-files.ts"), "utf8");
    const specs = [...src.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    for (const s of specs) assert.match(s, /^node:/, s);
  });

  it("USE_MELHOR_POST_ID é o mesmo nos dois módulos e bate com as chaves", () => {
    assert.equal(USE_MELHOR_POST_ID, "um");
    assert.equal(useMelhorSlideImageKey("cover"), `${USE_MELHOR_POST_ID}_carousel_cover`);
  });
});
