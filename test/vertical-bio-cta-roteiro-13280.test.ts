/**
 * test/vertical-bio-cta-roteiro-13280.test.ts (#13280)
 *
 * Decisão do editor no briefing do overnight 261116b (opção c): o roteiro
 * marca se o vertical 1 pertence ao horizontal
 * (`porVideo.vertical1.pertenceAoHorizontal`), e a chamada ao vídeo completo
 * na legenda do vertical entra por essa marcação. Regressão: com o título do
 * horizontal vindo do roteiro (diferente do D1), a comparação de títulos do
 * #13209 tirava a linha de toda edição com roteiro.
 * Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERTICAL_COMMENT_CTA_LINE, resolveVerticalBioCta } from "../scripts/lib/diaria/short-video.ts";
import { validarRoteiroFalas } from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { planShortsPublish, readHorizontalVideoForShort, readVerticalCta, verticalBioCtaFromHorizontal } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const D1 = {
  title: "Você já viu IA mentir. Já viu roubar?",
  body: "Um modelo da **OpenAI** gastou o saldo de uma carteira de terceiros. O caso foi descoberto depois.",
};
/** O título do horizontal que veio do roteiro (`title_source: "roteiro"`), diferente do D1. */
const TITULO_ROTEIRO = "IA rouba carteira: o caso que ninguém viu";
const URL_H = "https://youtu.be/AbCdEfGhIjK";
// #13709: a chamada ao vídeo completo deixou de dizer "link na bio": Instagram aponta o 1º comentário, Threads a resposta.
const BIO = /Vídeo completo: link (?:no primeiro comentário|na resposta)/;
const NO_BIO_CTA = /Vídeo completo no canal diar\.ia\.br do YouTube/;

const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[${D1.title}](https://alignment.openai.com/x)

${D1.body}

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null };
}

const shortsCfg = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  tiktok: true,
  tiktok_buffer_channel_id: "tiktokchan01",
  facebook_profile: false,
  schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" },
};

function plan(opts: { recordTitle: string | null; pertenceAoHorizontal?: boolean; ctaVertical?: boolean; noVideo?: boolean; only?: string[]; writer?: string }) {
  return planShortsPublish({
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: { publishing: { shorts: shortsCfg } },
    pages: [page("diaria")],
    instagramReady: true,
    linkedinPersonal: { ready: true } as const,
    threadsPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    now: new Date("2026-10-22T03:00:00Z"),
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.writer ? { writer: opts.writer } : {}),
    horizontalVideo: {
      recordTitle: opts.recordTitle,
      noVideo: opts.noVideo ?? false,
      url: opts.noVideo ? null : URL_H,
      ctaVertical: opts.ctaVertical ?? true,
      ...(opts.pertenceAoHorizontal === undefined ? {} : { pertenceAoHorizontal: opts.pertenceAoHorizontal }),
    },
  } as Parameters<typeof planShortsPublish>[0]);
}

const textOf = (p: ReturnType<typeof planShortsPublish>, id: string): string => {
  const it = p.items.find((i) => i.destination === id) as { caption?: string; text?: string } | undefined;
  assert.ok(it, `destino ${id} ausente`);
  return String(it.caption ?? it.text ?? "");
};

describe("#13280: a marcação do roteiro decide a chamada ao vídeo completo", () => {
  it("resolveVerticalBioCta: marcação true liga mesmo com títulos diferentes; false desliga mesmo com o mesmo título", () => {
    assert.deepEqual(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: TITULO_ROTEIRO, pertenceAoHorizontal: true }), {
      ctaVertical: true,
      reason: null,
      criterio: "roteiro",
    });
    assert.deepEqual(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: D1.title, pertenceAoHorizontal: false }), {
      ctaVertical: false,
      reason: "roteiro-nao-pertence",
      criterio: "roteiro",
    });
    // Sem marcação, segue a comparação de títulos do #13209.
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: TITULO_ROTEIRO }).reason, "titulo-diferente");
  });

  it("a marcação não dispensa a fala cta_vertical nem o horizontal publicado", () => {
    assert.equal(resolveVerticalBioCta({ ctaFala: false, d1Title: D1.title, recordTitle: TITULO_ROTEIRO, pertenceAoHorizontal: true }).reason, "sem-fala");
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: null, pertenceAoHorizontal: true }).reason, "sem-horizontal-publicado");
    assert.equal(resolveVerticalBioCta({ ctaFala: true, d1Title: D1.title, recordTitle: TITULO_ROTEIRO, noVideo: true, pertenceAoHorizontal: true }).reason, "sem-horizontal-publicado");
  });

  it("plano (regressão): horizontal com título do roteiro + marcação leva a linha no Instagram e no Threads e a chamada pelo @ no TikTok", () => {
    const p = plan({ recordTitle: TITULO_ROTEIRO, pertenceAoHorizontal: true });
    assert.match(textOf(p, "threads_profile"), BIO);
    assert.match(textOf(p, "tiktok"), NO_BIO_CTA);
    assert.ok(p.premises.some((x) => x.includes("pertenceAoHorizontal") && x.includes("#13280")), p.premises.join("\n"));
    const ig = plan({ recordTitle: TITULO_ROTEIRO, pertenceAoHorizontal: true, only: ["instagram"], writer: "instagram-timer" });
    assert.match(textOf(ig, "instagram"), BIO);
  });

  it("plano: sem marcação e títulos diferentes, a premissa aponta a marcação do roteiro", () => {
    const p = plan({ recordTitle: TITULO_ROTEIRO });
    assert.doesNotMatch(textOf(p, "threads_profile"), BIO);
    assert.ok(p.premises.some((x) => x.includes(VERTICAL_COMMENT_CTA_LINE) && x.includes("título do vertical difere") && x.includes("pertenceAoHorizontal")), p.premises.join("\n"));
  });

  it("plano: marcação false tira a linha e diz por quê", () => {
    const p = plan({ recordTitle: D1.title, pertenceAoHorizontal: false });
    assert.doesNotMatch(textOf(p, "threads_profile"), BIO);
    assert.doesNotMatch(textOf(p, "tiktok"), NO_BIO_CTA);
    assert.ok(p.premises.some((x) => x.includes("pertenceAoHorizontal: false")), p.premises.join("\n"));
  });

  it("rotas de troca de texto usam a mesma marcação", () => {
    assert.equal(verticalBioCtaFromHorizontal({ recordTitle: TITULO_ROTEIRO, noVideo: false, ctaVertical: true, pertenceAoHorizontal: true }, D1.title), true);
    assert.equal(verticalBioCtaFromHorizontal({ recordTitle: D1.title, noVideo: false, ctaVertical: true, pertenceAoHorizontal: false }, D1.title), false);
    assert.equal(verticalBioCtaFromHorizontal({ recordTitle: TITULO_ROTEIRO, noVideo: false, ctaVertical: true }, D1.title), false);
  });
});

describe("#13280: leitura e validação do campo no roteiro", () => {
  const roteiro = (porVideo: unknown) => ({
    falas: [
      { id: "H1", bloco: "gancho", texto: "Você já viu IA roubar?", videos: ["horizontal", "vertical1"] },
      { id: "H9", bloco: "cta_yt", texto: "O vídeo completo está no YouTube.", videos: ["horizontal", "vertical1"] },
    ],
    porVideo,
  });

  it("readVerticalCta/readHorizontalVideoForShort leem a marcação do vertical 1; outro tipo é ignorado", () => {
    const dir = mkdtempSync(join(tmpdir(), "bio-cta-13280-"));
    try {
      mkdirSync(join(dir, "_internal"));
      const write = (pv: unknown) => writeFileSync(join(dir, "_internal", "roteiro-falas.json"), JSON.stringify(roteiro(pv)));
      write({ vertical1: { pertenceAoHorizontal: true } });
      assert.deepEqual(readVerticalCta(dir), { ctaVertical: true, pertenceAoHorizontal: true });
      writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ title: TITULO_ROTEIRO }));
      const h = readHorizontalVideoForShort(dir);
      assert.equal(h.pertenceAoHorizontal, true);
      assert.equal(verticalBioCtaFromHorizontal(h, D1.title), true);
      write({ vertical1: { pertenceAoHorizontal: false } });
      assert.equal(readVerticalCta(dir).pertenceAoHorizontal, false);
      write({ vertical1: { pertenceAoHorizontal: "sim" } });
      assert.equal("pertenceAoHorizontal" in readVerticalCta(dir), false);
      write({ vertical1: { capa: "IA rouba?" } });
      assert.equal("pertenceAoHorizontal" in readVerticalCta(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validarRoteiroFalas: aceita boolean no vertical 1; recusa outro tipo e o campo no horizontal ou no vertical 2", () => {
    assert.deepEqual(validarRoteiroFalas(roteiro({ vertical1: { pertenceAoHorizontal: true } })), []);
    assert.deepEqual(validarRoteiroFalas(roteiro({ vertical1: { pertenceAoHorizontal: false } })), []);
    assert.ok(validarRoteiroFalas(roteiro({ vertical1: { pertenceAoHorizontal: "sim" } })).some((p) => p.includes("pertenceAoHorizontal deve ser true ou false")));
    assert.ok(validarRoteiroFalas(roteiro({ vertical2: { pertenceAoHorizontal: true } })).some((p) => p.includes("porVideo.vertical2.pertenceAoHorizontal: só vale no vertical 1")));
    assert.ok(validarRoteiroFalas(roteiro({ horizontal: { pertenceAoHorizontal: true } })).some((p) => p.includes("porVideo.horizontal.pertenceAoHorizontal: só vale no vertical 1")));
  });
});
