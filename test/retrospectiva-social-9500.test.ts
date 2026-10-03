/**
 * test/retrospectiva-social-9500.test.ts (#9500, #9508)
 *
 * Regressão da divulgação da Retrospectiva do Mês nas redes
 * (`/diaria-mensal-apoiadores`). Desde o #9508: 3 posts por rede, um por
 * história (D1/D2/D3), no formato dos destaques diários — state/`--skip`/
 * `--force` por (rede × história), regra do texto dos slides (exatamente 3
 * parágrafos, ≤260, sem transbordar o card), CTA (apoia.se, nunca a URL
 * paywalled) com o teto de cada rede, agenda dos 15 posts no mesmo dia sem
 * colidir com a diária, recorte de imagens por rede (X sem o slide de CTA) e
 * o adaptador `publish-retrospectiva-social.ts` (pré-voo tudo-ou-nada, stores
 * por história, cancelamento do post único legado da página LinkedIn,
 * reconciliação, payloads do X).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETROSPECTIVA_DIVULGACAO_CHANNELS,
  RETROSPECTIVA_PUBLIC_CTA,
  parseRetrospectivaSkip,
  readRetrospectivaDivulgacaoState,
  retrospectivaDivulgacaoStatePath,
  writeRetrospectivaDivulgacaoState,
  type RetrospectivaHistoria,
  type RetrospectivaPostKey,
} from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import {
  RETROSPECTIVA_CAROUSEL_CTA,
  RETROSPECTIVA_PUBLIC_CTA_CURTO,
  composeRetrospectivaLongCaption,
  retrospectivaHistoriaBodyProblems,
  retrospectivaPostTextFile,
  retrospectivaSocialPostProblems,
  xWeightedLength,
} from "../scripts/lib/mensal/retrospectiva-social.ts";
import {
  addMinutesIso,
  dailySlotCollisions,
  resolveRetrospectivaBaseDate,
  resolveRetrospectivaPostScheduledAts,
} from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { buildDoneChannelState, withChannelState } from "../scripts/lib/artigo-especial-state.ts";
import {
  LEGACY_LINKEDIN_PUBLISHED_FILENAME,
  LEGACY_SOCIAL_PUBLISHED_FILENAME,
  RETROSPECTIVA_SOCIAL_DESTAQUE,
  imageUrlsFor,
  parseSocialForce,
  retrospectivaSocialPublishedPath,
  runRetrospectivaSocialDispatch,
  type HistoriaImages,
  type RunRetrospectivaSocialOptions,
  type SocialDispatchInput,
} from "../scripts/publish-retrospectiva-social.ts";
import { WORKER_DESTAQUE_RE } from "../scripts/publish-artigo-especial-linkedin.ts";
import { checkRetrospectivaDivulgacaoTexts } from "../scripts/check-retrospectiva-divulgacao.ts";
import { buildCarouselSlideTexts } from "../scripts/lib/daily-carousel-card.ts";
import { renderRetrospectivaCards, retrospectivaCardPaths } from "../scripts/lib/mensal/retrospectiva-cards.ts";
import { readSocialPublished, type PostEntry } from "../scripts/lib/social-published-store.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const CONFIG = {
  publishing: {
    social: {
      timezone: "America/Sao_Paulo",
      fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
    },
  },
};
const NOW = Date.parse("2026-10-02T12:00:00Z");
const H: RetrospectivaHistoria[] = ["d1", "d2", "d3"];

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retro-9508-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const P1 = "Em setembro, pesquisadores acharam mais de 15 mil edições feitas por agentes num site alemão.";
const P2 = "Em parte das mensagens, os próprios bots combinavam como contornar as regras da empresa que os criou.";
const P3 = "A Retrospectiva de Setembro conta o que veio depois e o que esses casos têm em comum.";
const CORPO = `${P1}\n\n${P2}\n\n${P3}\n`;
const CURTO = `Agentes fizeram 15 mil edições num site alemão e combinavam como burlar as regras. A retrospectiva conta o resto.\n\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}\n`;
const TEXTS = Object.fromEntries(H.map((h) => [h, { corpo: CORPO, curto: CURTO }])) as Record<RetrospectivaHistoria, { corpo: string; curto: string }>;
const TITLES = { d1: "Agentes saem do teste e invadem governos", d2: "Modelos mais capazes, com risco e preço menor", d3: "Empresas brasileiras põem agentes para trabalhar" };
const ALL: RetrospectivaPostKey[] = (["linkedin_pagina", "facebook", "instagram", "threads", "x"] as const).flatMap((ch) =>
  H.map((h) => `${ch}:${h}` as RetrospectivaPostKey),
);

const cardsFor = (h: string) => ({
  cover: `https://img/${h}-cover.jpg`,
  p1: `https://img/${h}-p1.jpg`,
  p2: `https://img/${h}-p2.jpg`,
  p3: `https://img/${h}-p3.jpg`,
  cta: `https://img/${h}-cta.jpg`,
});

describe("state e --skip/--force por (rede × história)", () => {
  it("as 15 chaves de post entram no state e fazem round-trip; as legadas continuam legíveis", () => {
    for (const k of ALL) assert.ok(RETROSPECTIVA_DIVULGACAO_CHANNELS.includes(k), k);
    const p = retrospectivaDivulgacaoStatePath(tmp);
    let s = readRetrospectivaDivulgacaoState(p, "2609-10");
    s = withChannelState(s, "instagram:d2", buildDoneChannelState("2026-10-02T00:00:00Z", null));
    s = withChannelState(s, "linkedin_pagina", buildDoneChannelState("2026-10-02T00:00:00Z", null));
    writeRetrospectivaDivulgacaoState(p, s);
    assert.deepEqual(Object.keys(readRetrospectivaDivulgacaoState(p, "2609-10").channels).sort(), ["instagram:d2", "linkedin_pagina"]);
  });
  it("--skip de rede pula as 3 histórias (e a chave legada); {rede}:dN pula 1 post; typo lança", () => {
    assert.deepEqual([...parseRetrospectivaSkip("facebook")].sort(), ["facebook", "facebook:d1", "facebook:d2", "facebook:d3"]);
    assert.deepEqual([...parseRetrospectivaSkip("instagram:d2")], ["instagram:d2"]);
    assert.deepEqual([...parseRetrospectivaSkip("linkedin:d3")], ["linkedin_pagina:d3"]);
    assert.throws(() => parseRetrospectivaSkip("instagram:d4"), /instagram:d4/);
    assert.throws(() => parseRetrospectivaSkip("instagran"), /instagran/);
  });
  it("--force filtra só as chaves de post (mesmos tokens do --skip)", () => {
    assert.deepEqual([...parseSocialForce("linkedin,threads:d2,box")].sort(), [
      "linkedin_pagina:d1",
      "linkedin_pagina:d2",
      "linkedin_pagina:d3",
      "threads:d2",
    ]);
    assert.throws(() => parseSocialForce("thread"), /^Error: --force contém.*thread/);
    assert.throws(() => parseSocialForce("x:d9", "--old-cancelled"), /^Error: --old-cancelled contém/);
  });
  it("destaque do Worker é aceito pelo regex do Worker publicado", () => {
    assert.match(RETROSPECTIVA_SOCIAL_DESTAQUE, WORKER_DESTAQUE_RE);
  });
});

describe("texto dos slides (d{N}.md): exatamente 3 parágrafos, ≤260, sem transbordar", () => {
  it("corpo certo passa; 2 ou 4 parágrafos reprovam", () => {
    assert.deepEqual(retrospectivaHistoriaBodyProblems(CORPO), []);
    assert.match(retrospectivaHistoriaBodyProblems(`${P1}\n\n${P2}`).join(), /2 parágrafo\(s\) — são exatamente 3/);
    assert.match(retrospectivaHistoriaBodyProblems(`${CORPO}\n\n${P1}`).join(), /4 parágrafo/);
  });
  it("parágrafo acima de 260 reprova pedindo REESCRITA; acima do que o card comporta, aponta o slide", () => {
    const longo = `${"palavra ".repeat(33)}fim.`; // 268 chars
    assert.match(retrospectivaHistoriaBodyProblems(`${P1}\n\n${longo}\n\n${P3}`).join(), /parágrafo 2: 268 caracteres — teto 260; REESCREVA/);
    const enorme = `${"palavra ".repeat(60)}fim.`; // ~484 chars: não cabe a 62px
    assert.match(retrospectivaHistoriaBodyProblems(`${P1}\n\n${P2}\n\n${enorme}`).join(), /slide p3 não cabe no card/);
  });
  it("CTA, URL paywalled, markdown e mais de 5 hashtags reprovam; até 5 hashtags passam", () => {
    assert.match(retrospectivaHistoriaBodyProblems(`${CORPO}\n${RETROSPECTIVA_PUBLIC_CTA}`).join(), /não inclua o CTA/);
    assert.match(retrospectivaHistoriaBodyProblems(CORPO.replace("site alemão", "retrospectiva.diar.ia.br/2609")).join(), /paywalled/);
    assert.match(retrospectivaHistoriaBodyProblems(CORPO.replace("site alemão", "**site alemão**")).join(), /markdown/);
    assert.deepEqual(retrospectivaHistoriaBodyProblems(`${CORPO}\n#IA #agentes #setembro #tecnologia #retrospectiva`), []);
    assert.match(retrospectivaHistoriaBodyProblems(`${CORPO}\n#a #b #c #d #e #f`).join(), /6 hashtags/);
  });
  it("o slide de CTA do carrossel diz a linha longa de CTA e a faixa de apoio (nunca o 'Assine grátis' da diária)", () => {
    const slides = buildCarouselSlideTexts(CORPO, RETROSPECTIVA_CAROUSEL_CTA);
    assert.equal(slides.cta.title, RETROSPECTIVA_PUBLIC_CTA);
    assert.equal(slides.cta.kicker, "Exclusivo para apoiadores");
    assert.equal(slides.p1.title.replace(/\n\n/g, " "), P1);
    assert.equal(slides.p3.title.replace(/\n\n/g, " "), P3);
  });
});

describe("CTA e teto de cada rede", () => {
  it("legenda longa = corpo + linha longa de CTA; passa em LinkedIn/Facebook/Instagram", () => {
    const cap = composeRetrospectivaLongCaption(CORPO);
    assert.ok(cap.endsWith(`\n\n${RETROSPECTIVA_PUBLIC_CTA}`));
    for (const ch of ["linkedin_pagina", "facebook", "instagram"] as const) assert.deepEqual(retrospectivaSocialPostProblems(ch, cap), [], ch);
  });
  it("arquivo de cada rede: LinkedIn/Facebook/Instagram leem d{N}.md, Threads/X leem d{N}-curto.md", () => {
    assert.equal(retrospectivaPostTextFile("instagram", "d2"), "d2.md");
    assert.equal(retrospectivaPostTextFile("linkedin_pagina", "d1"), "d1.md");
    assert.equal(retrospectivaPostTextFile("x", "d3"), "d3-curto.md");
    assert.equal(retrospectivaPostTextFile("threads", "d3"), "d3-curto.md");
  });
  it("curto: Threads/X aceitam a curta ou a longa; sem CTA reprova; URL paywalled reprova", () => {
    assert.deepEqual(retrospectivaSocialPostProblems("threads", CURTO), []);
    assert.deepEqual(retrospectivaSocialPostProblems("x", CURTO), []);
    assert.deepEqual(retrospectivaSocialPostProblems("threads", `Curto.\n\n${RETROSPECTIVA_PUBLIC_CTA}`), []);
    assert.match(retrospectivaSocialPostProblems("x", "Curto, sem CTA nenhum.").join(), /falta a linha literal/);
    assert.match(retrospectivaSocialPostProblems("x", `retrospectiva.diar.ia.br/2609\n${CURTO}`).join(), /paywalled/);
    assert.match(retrospectivaSocialPostProblems("instagram", CURTO).join(), /falta a linha literal/);
  });
  it("X e Threads: acima de 280 reprova; X conta apoia.se/diaria como link (23)", () => {
    const corpo = (n: number) => "a".repeat(n);
    const cta = `\n\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}`;
    assert.deepEqual(retrospectivaSocialPostProblems("threads", corpo(280 - cta.length) + cta), []);
    assert.match(retrospectivaSocialPostProblems("threads", corpo(281 - cta.length) + cta).join(), /teto do threads é 280/);
    assert.equal(xWeightedLength(RETROSPECTIVA_PUBLIC_CTA_CURTO), RETROSPECTIVA_PUBLIC_CTA_CURTO.length + 8);
    assert.match(retrospectivaSocialPostProblems("x", corpo(280 - cta.length) + cta).join(), /ponderado/);
    assert.deepEqual(retrospectivaSocialPostProblems("x", corpo(272 - cta.length) + cta), []);
  });
  it("Instagram acima de 2200 reprova (recusa, nunca trunca o CTA); markdown e vazio reprovam", () => {
    assert.match(retrospectivaSocialPostProblems("instagram", `${"b".repeat(2200)}\n\n${RETROSPECTIVA_PUBLIC_CTA}`).join(), /2200/);
    assert.match(retrospectivaSocialPostProblems("facebook", `Um **destaque**.\n\n${RETROSPECTIVA_PUBLIC_CTA}`).join(), /markdown/);
    assert.deepEqual(retrospectivaSocialPostProblems("x", "  \n"), ["texto vazio"]);
  });
});

describe("check-retrospectiva-divulgacao cobre as 3 histórias", () => {
  function setup(over: Partial<Record<string, string>> = {}) {
    mkdirSync(join(tmp, "divulgacao"), { recursive: true });
    writeFileSync(
      join(tmp, "draft.md"),
      H.map((h, i) => `**DESTAQUE ${i + 1} | X**\n\n${TITLES[h as keyof typeof TITLES]}\n\nTexto.\n\n---\n`).join("\n"),
    );
    for (const h of H) {
      writeFileSync(join(tmp, "divulgacao", `${h}.md`), over[`${h}.md`] ?? CORPO);
      writeFileSync(join(tmp, "divulgacao", `${h}-curto.md`), over[`${h}-curto.md`] ?? CURTO);
    }
  }
  it("tudo certo: 6 arquivos sem problema (perfil pulado)", () => {
    setup();
    const r = checkRetrospectivaDivulgacaoTexts(tmp, undefined);
    assert.equal(r.filter((c) => /d\d(-curto)?\.md$/.test(c.file)).length, 6);
    const semPerfil = r.filter((c) => !c.file.endsWith("linkedin-perfil.md"));
    assert.ok(semPerfil.every((c) => c.problems.length === 0), JSON.stringify(semPerfil));
  });
  it("d2 com 2 parágrafos e d3-curto acima de 280 reprovam, nomeando a rede", () => {
    setup({ "d2.md": `${P1}\n\n${P2}`, "d3-curto.md": `${"c".repeat(300)}\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}` });
    const r = checkRetrospectivaDivulgacaoTexts(tmp, undefined);
    const by = (end: string) => r.find((c) => c.file.replace(/\\/g, "/").endsWith(end))!;
    assert.match(by("divulgacao/d2.md").problems.join(), /exatamente 3/);
    assert.match(by("d3-curto.md").problems.join(), /threads: .*280[\s\S]*x: /);
    assert.deepEqual(by("divulgacao/d1.md").problems, []);
  });
  it("--skip de todas as redes de uma história não checa os arquivos dela; título que não cabe na capa reprova", () => {
    setup();
    const r = checkRetrospectivaDivulgacaoTexts(tmp, "linkedin,facebook:d3,instagram:d3,threads:d3,x:d3");
    assert.ok(!r.some((c) => /d3(-curto)?\.md$/.test(c.file)));
    writeFileSync(join(tmp, "draft.md"), `**DESTAQUE 1 | X**\n\n${"Supercalifragilisticoexpialidoso ".repeat(5)}\n`);
    const r2 = checkRetrospectivaDivulgacaoTexts(tmp, "linkedin,facebook:d2,instagram:d2,threads:d2,x:d2,facebook:d3,instagram:d3,threads:d3,x:d3");
    assert.match(r2.find((c) => c.file.includes("DESTAQUE 1"))!.problems.join(), /não cabe na capa/);
  });
});

describe("agenda: 3 histórias no mesmo dia, redes escalonadas, sem colisão com a diária", () => {
  it("D+1: história 1 às 09:00, 2 às 14:30, 3 às 20:00; LinkedIn :00 / Facebook :10 / Instagram :20 / Threads :30 / X :40", () => {
    const s = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-10-10", now: NOW });
    assert.deepEqual(s.d1, {
      linkedin_pagina: "2026-10-11T09:00:00-03:00",
      facebook: "2026-10-11T09:10:00-03:00",
      instagram: "2026-10-11T09:20:00-03:00",
      threads: "2026-10-11T09:30:00-03:00",
      x: "2026-10-11T09:40:00-03:00",
    });
    assert.equal(s.d2.linkedin_pagina, "2026-10-11T14:30:00-03:00");
    assert.equal(s.d2.x, "2026-10-11T15:10:00-03:00");
    assert.equal(s.d3.linkedin_pagina, "2026-10-11T20:00:00-03:00");
    assert.equal(s.d3.x, "2026-10-11T20:40:00-03:00");
    const flat = Object.fromEntries(H.flatMap((h) => Object.entries(s[h]).map(([ch, v]) => [`${ch}:${h}`, v])));
    assert.equal(new Set(Object.values(flat)).size, 15);
    assert.deepEqual(dailySlotCollisions(flat, CONFIG), []);
  });
  it("--at desloca tudo; qualquer um dos 15 colado num slot da diária lança (inclusive pela história 2/3)", () => {
    assert.throws(() => resolveRetrospectivaPostScheduledAts(CONFIG, { at: "2026-10-11T09:55:00-03:00", now: NOW }), /colide com a diária.*d1/);
    // 07:00 → história 2 às 12:30 (em cima do d2 da diária).
    assert.throws(() => resolveRetrospectivaPostScheduledAts(CONFIG, { at: "2026-10-11T07:00:00-03:00", now: NOW }), /:d2=.*d2 \(12:30\)/);
    const ok = resolveRetrospectivaPostScheduledAts(CONFIG, { at: "2026-10-11T12:00:00Z", now: NOW });
    assert.equal(ok.d1.facebook, "2026-10-11T09:10:00-03:00");
  });
  it("data-base no passado continua lançando (herdado do LinkedIn)", () => {
    assert.throws(() => resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-09-01", now: NOW }), /já passaram/);
  });
  it("addMinutesIso preserva o offset e vira o dia; aceita Z/ms; ISO sem fuso lança", () => {
    assert.equal(addMinutesIso("2026-10-11T23:55:00-03:00", 10), "2026-10-12T00:05:00-03:00");
    assert.equal(addMinutesIso("2026-10-11T12:00:00.000Z", 10), "2026-10-11T09:10:00-03:00");
    assert.throws(() => addMinutesIso("2026-10-11T09:00:00", 10), /offset/);
  });
  it("âncora D: explícita > regra do 1º sábado > hoje; --at desliga a regra", () => {
    assert.deepEqual(resolveRetrospectivaBaseDate("2609-10", { baseDate: "2026-10-03" }), { baseDate: "2026-10-03", fromRule: false });
    assert.deepEqual(resolveRetrospectivaBaseDate("2609-10", { at: "2026-10-04T09:00:00-03:00" }), { baseDate: undefined, fromRule: false });
    const viaRegra = resolveRetrospectivaBaseDate("2610-11", { now: new Date("2026-10-20T12:00:00Z") });
    assert.equal(viaRegra.fromRule, true);
    assert.match(viaRegra.baseDate!, /^2026-11-0\d$/);
  });
});

describe("imagens por rede (mesmo recorte da diária)", () => {
  const c = cardsFor("d1");
  it("Instagram e Threads: carrossel de 5, capa primeiro e CTA por último", () => {
    for (const ch of ["instagram", "threads"] as const) assert.deepEqual(imageUrlsFor(ch, c), [c.cover, c.p1, c.p2, c.p3, c.cta]);
  });
  it("X: até 4 — capa + 3 parágrafos, SEM o slide de CTA (#8202)", () => {
    assert.deepEqual(imageUrlsFor("x", c), [c.cover, c.p1, c.p2, c.p3]);
  });
  it("Facebook e LinkedIn: 1 imagem (a capa da história)", () => {
    assert.deepEqual(imageUrlsFor("facebook", c), [c.cover]);
    assert.deepEqual(imageUrlsFor("linkedin_pagina", c), [c.cover]);
  });
});

describe("retrospectiva-cards: as 5 imagens da história (render real)", () => {
  it("gera capa + 4 slides em divulgacao/ com os nomes da diária; sem o 2x1 da história lança", async () => {
    const sharp = (await import("sharp")).default;
    await sharp({ create: { width: 1200, height: 600, channels: 3, background: { r: 40, g: 60, b: 90 } } }).jpeg().toFile(join(tmp, "04-d2-2x1.jpg"));
    const paths = retrospectivaCardPaths(tmp, "d2");
    assert.deepEqual(
      Object.values(paths).map((p) => p.replace(/\\/g, "/").split("/").slice(-2).join("/")),
      ["divulgacao/04-d2-4x5.jpg", "divulgacao/04-d2-carousel-p1-4x5.jpg", "divulgacao/04-d2-carousel-p2-4x5.jpg", "divulgacao/04-d2-carousel-p3-4x5.jpg", "divulgacao/04-d2-carousel-cta-4x5.jpg"],
    );
    const out = await renderRetrospectivaCards({ cycleDir: tmp, historia: "d2", title: TITLES.d2, corpo: CORPO, kicker: "Retrospectiva de Setembro", fontSize: 72 });
    for (const p of Object.values(out)) {
      const m = await sharp(p).metadata();
      assert.deepEqual([m.width, m.height], [1080, 1350], p);
    }
    await assert.rejects(
      renderRetrospectivaCards({ cycleDir: tmp, historia: "d3", title: TITLES.d3, corpo: CORPO, kicker: "k", fontSize: 72 }),
      /04-d3-2x1\.jpg ausente/,
    );
  });
});

describe("adaptador publish-retrospectiva-social", () => {
  const SCHEDULE = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2026-10-10", now: NOW });

  function opts(over: Partial<RunRetrospectivaSocialOptions> = {}) {
    const calls: Array<{ ch: string; input: SocialDispatchInput; publishedPath?: string }> = [];
    const cancels: string[] = [];
    const prepared: RetrospectivaHistoria[][] = [];
    let scheduleCalls = 0;
    const o: RunRetrospectivaSocialOptions = {
      cycle: "2609-10",
      cycleDir: tmp,
      posts: ALL,
      texts: TEXTS,
      titles: TITLES,
      resolveScheduledAts: () => {
        scheduleCalls++;
        return SCHEDULE;
      },
      prepareImages: async (hs) => {
        prepared.push(hs);
        return Object.fromEntries(hs.map((h) => [h, { cards: cardsFor(h), pendingUpload: false } satisfies HistoriaImages]));
      },
      force: new Set(),
      dryRun: false,
      disabled: {},
      xChannelId: "buffer-x",
      missingCredentials: {},
      dispatchers: {
        linkedin: async (input, publishedPath) => {
          calls.push({ ch: "linkedin", input, publishedPath });
          return { platform: "linkedin", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: input.scheduledAt, worker_queue_key: `k-li-${input.historia}` };
        },
        facebook: async (input) => {
          calls.push({ ch: "facebook", input });
          return { platform: "facebook", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: `https://www.facebook.com/p/posts/${input.historia}`, status: "scheduled", scheduled_at: input.scheduledAt, fb_post_id: input.historia };
        },
        worker: async (ch, input) => {
          calls.push({ ch, input });
          return { platform: ch, destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: input.scheduledAt, worker_queue_key: `k-${ch}-${input.historia}` };
        },
        cancelWorker: async (key) => {
          cancels.push(key);
          return { alreadyGone: false };
        },
      },
      verifyWorker: async (p) => ({ updated: p, changes: 0, inQueue: 3 }),
      now: NOW,
      ...over,
    };
    return { o, calls, cancels, prepared, scheduleCalls: () => scheduleCalls };
  }
  const liveStore = (h: RetrospectivaHistoria, platform: string, extra: Record<string, unknown>) => {
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(
      retrospectivaSocialPublishedPath(tmp, h),
      JSON.stringify({ posts: [{ platform, destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: "2026-10-11T09:20:00-03:00", ...extra }] }),
    );
  };
  const legacyStore = () => {
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(
      join(tmp, "_internal", LEGACY_LINKEDIN_PUBLISHED_FILENAME),
      JSON.stringify({
        posts: [
          {
            platform: "linkedin",
            destaque: RETROSPECTIVA_SOCIAL_DESTAQUE,
            subtype: "main",
            url: null,
            status: "scheduled",
            scheduled_at: "2026-10-03T09:00:00-03:00",
            route: "worker_queue",
            worker_queue_key: "queue:legacy",
          },
        ],
      }),
    );
    writeRetrospectivaDivulgacaoState(
      retrospectivaDivulgacaoStatePath(tmp),
      withChannelState({ cycle: "2609-10", channels: {} }, "linkedin_pagina", buildDoneChannelState("2026-10-02T21:15:22Z", null)),
    );
  };
  const state = () => readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels;

  it("15 posts: 12 despachados em ordem cronológica (história 1 → 3), 3 payloads do X, state por post, store por história", async () => {
    const { o, calls } = opts();
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(
      calls.map((c) => `${c.ch}:${c.input.historia}`),
      ["linkedin:d1", "facebook:d1", "instagram:d1", "threads:d1", "linkedin:d2", "facebook:d2", "instagram:d2", "threads:d2", "linkedin:d3", "facebook:d3", "instagram:d3", "threads:d3"],
    );
    const ig2 = calls.find((c) => c.ch === "instagram" && c.input.historia === "d2")!;
    assert.equal(ig2.input.scheduledAt, SCHEDULE.d2.instagram);
    assert.deepEqual(ig2.input.imageUrls, Object.values(cardsFor("d2")));
    assert.ok(ig2.input.text.endsWith(RETROSPECTIVA_PUBLIC_CTA));
    const th3 = calls.find((c) => c.ch === "threads" && c.input.historia === "d3")!;
    assert.equal(th3.input.text, CURTO.trim());
    assert.equal(th3.input.imageUrls.length, 5);
    for (const c of calls.filter((x) => x.ch === "facebook" || x.ch === "linkedin")) assert.deepEqual(c.input.imageUrls, [cardsFor(c.input.historia).cover]);
    assert.equal(calls[0].publishedPath, retrospectivaSocialPublishedPath(tmp, "d1"));

    const xs = r.results.filter((y) => y.action === "x-payload");
    assert.equal(xs.length, 3);
    for (const x of xs) {
      if (x.action !== "x-payload") continue;
      assert.equal(x.payload.dueAt, SCHEDULE[x.historia].x);
      assert.equal(x.payload.images.length, 4);
      assert.ok(!x.payload.images.some((i) => i.url.endsWith("-cta.jpg")), "X nunca leva o slide de CTA");
      assert.match(x.payload.images[0].altText, /^Capa da história/);
      assert.equal(x.payload.publishedPath, retrospectivaSocialPublishedPath(tmp, x.historia));
    }

    const st = state();
    assert.equal(st["facebook:d2"]?.status, "done");
    assert.equal(st["facebook:d2"]?.url, "https://www.facebook.com/p/posts/d2");
    assert.equal(st["instagram:d3"]?.status, "done");
    assert.equal(st["x:d1"], undefined, "x só vira done quando o top-level marca, depois da mutation do Buffer");
    for (const h of H) {
      const posts = readSocialPublished(retrospectivaSocialPublishedPath(tmp, h)).posts;
      assert.deepEqual(posts.map((p) => p.platform).sort(), ["facebook", "instagram", "linkedin", "threads"]);
      assert.ok(posts.every((p) => p.historia === h));
    }
    assert.equal(r.verifyError, null);
    assert.deepEqual(r.legacyLinkedin, { action: "none" });
  });

  it("pré-voo tudo-ou-nada: d2 com 2 parágrafos aborta ANTES de gerar imagem ou despachar qualquer post", async () => {
    const { o, calls, prepared } = opts({ texts: { ...TEXTS, d2: { corpo: `${P1}\n\n${P2}`, curto: CURTO } } });
    await assert.rejects(runRetrospectivaSocialDispatch(o), /ANTES de qualquer dispatch[\s\S]*d2 \(d2\.md\): .*exatamente 3/);
    assert.equal(calls.length, 0);
    assert.equal(prepared.length, 0);
    assert.equal(existsSync(retrospectivaDivulgacaoStatePath(tmp)), false);
  });

  it("curto acima de 280, título ausente e Buffer sem channelId também barram no pré-voo", async () => {
    const a = opts({ texts: { ...TEXTS, d1: { corpo: CORPO, curto: `${"z".repeat(300)}\n${RETROSPECTIVA_PUBLIC_CTA_CURTO}` } } });
    await assert.rejects(runRetrospectivaSocialDispatch(a.o), /threads:d1: .*280/);
    const b = opts({ titles: { ...TITLES, d3: null } });
    await assert.rejects(runRetrospectivaSocialDispatch(b.o), /d3: título da história não encontrado/);
    const c = opts({ xChannelId: null });
    await assert.rejects(runRetrospectivaSocialDispatch(c.o), /x:d1: publishing\.social\.twitter\.buffer_channel_id/);
  });

  it("post único legado da página vivo: os posts da página são recusados sem --replace-linkedin-single", async () => {
    legacyStore();
    const { o, calls } = opts();
    await assert.rejects(runRetrospectivaSocialDispatch(o), /post ÚNICO da página.*queue:legacy[\s\S]*--replace-linkedin-single/);
    assert.equal(calls.length, 0);
    // --skip linkedin: o legado não importa.
    const semLinkedin = opts({ posts: ALL.filter((k) => !k.startsWith("linkedin")) });
    await runRetrospectivaSocialDispatch(semLinkedin.o);
    assert.ok(!semLinkedin.calls.some((c) => c.ch === "linkedin"));
    assert.equal(semLinkedin.cancels.length, 0);
  });

  it("--replace-linkedin-single cancela o legado no Worker ANTES dos 3 novos; store legado vira deleted, canal legado pending", async () => {
    legacyStore();
    const order: string[] = [];
    const { o, cancels } = opts({ replaceLinkedinSingle: true });
    const li = o.dispatchers.linkedin;
    o.dispatchers.linkedin = async (i, p) => {
      order.push(`dispatch:${i.historia}`);
      return li(i, p);
    };
    const cw = o.dispatchers.cancelWorker;
    o.dispatchers.cancelWorker = async (k) => {
      order.push(`cancel:${k}`);
      return cw(k);
    };
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(cancels, ["queue:legacy"]);
    assert.equal(order[0], "cancel:queue:legacy");
    assert.deepEqual(order.slice(1), ["dispatch:d1", "dispatch:d2", "dispatch:d3"]);
    assert.equal(r.legacyLinkedin.action, "cancelled");
    const legacy = readSocialPublished(join(tmp, "_internal", LEGACY_LINKEDIN_PUBLISHED_FILENAME)).posts[0];
    assert.equal(legacy.status, "deleted");
    const st = state();
    assert.equal(st.linkedin_pagina?.status, "pending");
    assert.match(String(st.linkedin_pagina?.reason), /substituído/);
    assert.equal(st["linkedin_pagina:d1"]?.status, "done");
  });

  it("legado já fora da fila: os 3 da página seguem e o resultado avisa; cancelamento que falha segura só a página", async () => {
    legacyStore();
    const gone = opts({ replaceLinkedinSingle: true });
    gone.o.dispatchers.cancelWorker = async () => ({ alreadyGone: true });
    const r = await runRetrospectivaSocialDispatch(gone.o);
    assert.equal(r.legacyLinkedin.action, "already-gone");
    assert.equal(gone.calls.filter((c) => c.ch === "linkedin").length, 3);
    assert.equal(readSocialPublished(join(tmp, "_internal", LEGACY_LINKEDIN_PUBLISHED_FILENAME)).posts[0].status, "published");

    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    legacyStore();
    const fail = opts({ replaceLinkedinSingle: true });
    fail.o.dispatchers.cancelWorker = async () => {
      throw new Error("Worker 503");
    };
    const r2 = await runRetrospectivaSocialDispatch(fail.o);
    assert.equal(r2.legacyLinkedin.action, "failed");
    assert.equal(fail.calls.filter((c) => c.ch === "linkedin").length, 0);
    assert.equal(fail.calls.length, 9, "as outras redes seguem");
    assert.match(String(state()["linkedin_pagina:d2"]?.reason), /sairiam 4/);
  });

  it("dry-run com o legado: avisa 'would-cancel', não cancela, não despacha, não grava; X sem URL de imagem", async () => {
    legacyStore();
    const before = readFileSync(retrospectivaDivulgacaoStatePath(tmp), "utf8");
    const { o, calls, cancels } = opts({
      dryRun: true,
      replaceLinkedinSingle: true,
      missingCredentials: { facebook: "sem token" },
      prepareImages: async (hs) => Object.fromEntries(hs.map((h) => [h, { cards: cardsFor(h), pendingUpload: true }])),
    });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(r.legacyLinkedin.action, "would-cancel");
    assert.equal(calls.length + cancels.length, 0);
    assert.equal(r.results.filter((y) => y.action === "dry-run").length, 12);
    const x = r.results.find((y) => y.action === "x-payload");
    assert.ok(x?.action === "x-payload");
    assert.deepEqual(x.payload.images, []);
    assert.equal(x.payload.imagePendingUpload, true);
    const ig = r.results.find((y) => y.key === "instagram:d1");
    assert.ok(ig?.action === "dry-run");
    assert.equal(ig.images.length, 5);
    assert.equal(readFileSync(retrospectivaDivulgacaoStatePath(tmp), "utf8"), before);
    for (const h of H) assert.equal(existsSync(retrospectivaSocialPublishedPath(tmp, h)), false);
  });

  it("post done pula; --force instagram:d2 reexecuta só ele, cancelando a entry viva no Worker antes", async () => {
    let s = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    for (const k of ALL) s = withChannelState(s, k, buildDoneChannelState("x", null));
    writeRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), s);
    liveStore("d2", "instagram", { worker_queue_key: "old-ig-d2" });
    const { o, calls, cancels, prepared } = opts({ force: new Set(["instagram:d2"]) });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(cancels, ["old-ig-d2"]);
    assert.deepEqual(calls.map((c) => `${c.ch}:${c.input.historia}`), ["instagram:d2"]);
    assert.deepEqual(prepared, [["d2"]], "só a história com trabalho gera/sobe imagem");
    assert.equal(r.results.filter((y) => y.action === "skipped").length, 14);
  });

  it("--force sobre post vivo do Facebook exige --old-cancelled daquele post", async () => {
    liveStore("d1", "facebook", { fb_post_id: "123" });
    const a = opts({ posts: ["facebook:d1"], force: new Set(["facebook:d1"]) });
    await assert.rejects(runRetrospectivaSocialDispatch(a.o), /--old-cancelled facebook:d1/);
    const b = opts({ posts: ["facebook:d1"], force: new Set(["facebook:d1"]), oldCancelled: new Set(["facebook:d1"]) });
    await runRetrospectivaSocialDispatch(b.o);
    assert.deepEqual(b.calls.map((c) => c.ch), ["facebook"]);
  });

  it("post vivo no store da história sem registro no state pula; o mesmo canal de outra história segue", async () => {
    liveStore("d1", "threads", { worker_queue_key: "old" });
    const { o, calls } = opts({ posts: ["threads:d1", "threads:d2"] });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.match(String((r.results.find((y) => y.key === "threads:d1") as { reason?: string }).reason), /store/);
    assert.deepEqual(calls.map((c) => `${c.ch}:${c.input.historia}`), ["threads:d2"]);
  });

  it("com tudo done, a agenda nem é resolvida e nenhuma imagem é gerada", async () => {
    let s = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    for (const k of ALL) s = withChannelState(s, k, buildDoneChannelState("x", null));
    writeRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), s);
    const { o, scheduleCalls, prepared } = opts({ resolveScheduledAts: () => { throw new Error("já passaram"); } });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.ok(r.results.every((y) => y.action === "skipped"));
    assert.equal(scheduleCalls(), 0);
    assert.equal(prepared.length, 0);
  });

  it("credencial/Worker ausente aborta fora do dry-run; rede desligada no config pula as 3 histórias", async () => {
    const semWorker = opts({ missingCredentials: { instagram: "Worker não configurado" } });
    await assert.rejects(runRetrospectivaSocialDispatch(semWorker.o), /instagram:d1: Worker não configurado/);
    assert.equal(semWorker.calls.length, 0);
    const { o, calls } = opts({ disabled: { instagram: "redesenho" } });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.equal(r.results.filter((y) => y.channel === "instagram" && y.action === "skipped").length, 3);
    assert.ok(!calls.some((c) => c.ch === "instagram"));
  });

  it("falha de um post vira failed só nele; DLQ na reconciliação de uma história também", async () => {
    const base = opts({ posts: ["facebook:d1", "facebook:d2", "threads:d2"] });
    base.o.dispatchers.facebook = async (input) => {
      if (input.historia === "d1") throw new Error("Graph 500");
      return { platform: "facebook", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: "u", status: "scheduled", scheduled_at: input.scheduledAt, fb_post_id: "2" };
    };
    base.o.verifyWorker = async (p) => ({
      updated: { posts: p.posts.map((e: PostEntry) => (e.platform === "threads" ? { ...e, status: "failed" as const, failure_reason: "worker_dlq" } : e)) },
      changes: 1,
    });
    const r = await runRetrospectivaSocialDispatch(base.o);
    const st = state();
    assert.equal(st["facebook:d1"]?.status, "failed");
    assert.match(String(st["facebook:d1"]?.reason), /Graph 500/);
    assert.equal(st["facebook:d2"]?.status, "done");
    assert.equal(st["threads:d2"]?.status, "failed");
    assert.deepEqual(r.results.map((y) => `${y.key}:${y.action}`), ["facebook:d1:failed", "facebook:d2:dispatched", "threads:d2:failed"]);
    assert.match(readFileSync(retrospectivaSocialPublishedPath(tmp, "d2"), "utf8"), /worker_dlq/);
  });

  it("reconciliação que não roda: post fica done, mas verifyError sinaliza; FUTURO marcado publicado não grava", async () => {
    const a = opts({ posts: ["instagram:d1"], verifyWorker: async () => { throw new Error("ECONNRESET"); } });
    const r = await runRetrospectivaSocialDispatch(a.o);
    assert.match(String(r.verifyError), /d1: ECONNRESET/);
    assert.equal(state()["instagram:d1"]?.status, "done");

    const b = opts({
      posts: ["threads:d3"],
      verifyWorker: async (p) => ({ updated: { posts: p.posts.map((e: PostEntry) => ({ ...e, status: "published" as const })) }, changes: 1, inQueue: 0 }),
    });
    const r2 = await runRetrospectivaSocialDispatch(b.o);
    assert.match(String(r2.verifyError), /lag do KV/);
    assert.equal(readSocialPublished(retrospectivaSocialPublishedPath(tmp, "d3")).posts[0].status, "scheduled");
  });

  it("horário que vence DURANTE a execução: o post vira failed sem despachar (nunca post imediato)", async () => {
    let t = NOW;
    const { o, calls } = opts({
      posts: ["linkedin_pagina:d1", "facebook:d2"],
      clock: () => t,
      prepareImages: async (hs) => {
        t = Date.parse(SCHEDULE.d1.linkedin_pagina) - 5 * 60_000; // upload lento: faltam 5 min pro d1
        return Object.fromEntries(hs.map((h) => [h, { cards: cardsFor(h), pendingUpload: false }]));
      },
    });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.deepEqual(calls.map((c) => `${c.ch}:${c.input.historia}`), ["facebook:d2"]);
    assert.match(String((r.results.find((y) => y.key === "linkedin_pagina:d1") as { reason?: string }).reason), /<10 min durante a execução/);
    assert.equal(state()["linkedin_pagina:d1"]?.status, "failed");
  });

  it("store que não grava DEPOIS do dispatch: não aborta, grava o state (que segura a reexecução) e sinaliza", async () => {
    const { o } = opts({ posts: ["facebook:d1", "facebook:d2"] });
    const fb = o.dispatchers.facebook;
    o.dispatchers.facebook = async (i) => {
      // Simula lock/EPERM do OneDrive: o store da história vira um diretório.
      if (i.historia === "d1") mkdirSync(retrospectivaSocialPublishedPath(tmp, "d1"), { recursive: true });
      return fb(i);
    };
    const r = await runRetrospectivaSocialDispatch(o);
    assert.match(r.stateWriteErrors.join(), /facebook:d1: store NÃO gravado.*JÁ ESTÁ agendado/);
    assert.equal(state()["facebook:d1"]?.status, "done");
    assert.equal(state()["facebook:d2"]?.status, "done", "os outros posts seguem");
    // Reexecução (o lock passou; store da história SEM o registro): o state segura, nada sai de novo.
    rmSync(retrospectivaSocialPublishedPath(tmp, "d1"), { recursive: true, force: true });
    const again = opts({ posts: ["facebook:d1"] });
    await runRetrospectivaSocialDispatch(again.o);
    assert.equal(again.calls.length, 0);
  });

  it("post único do #9500 vivo numa rede recusa o pré-voo; deleted ou rede pulada não recusa", async () => {
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    const legacy = join(tmp, "_internal", LEGACY_SOCIAL_PUBLISHED_FILENAME);
    writeFileSync(legacy, JSON.stringify({ posts: [{ platform: "instagram", destaque: RETROSPECTIVA_SOCIAL_DESTAQUE, url: null, status: "scheduled", scheduled_at: "2026-10-03T09:20:00-03:00" }] }));
    const a = opts();
    await assert.rejects(runRetrospectivaSocialDispatch(a.o), /instagram: o post ÚNICO do #9500 está vivo/);
    assert.equal(a.calls.length, 0);
    const b = opts({ posts: ALL.filter((k) => !k.startsWith("instagram")) });
    await runRetrospectivaSocialDispatch(b.o);
    assert.equal(b.calls.length, 9);
  });

  it("confirmação na fila compara com TODAS as agendadas do store (uma antiga não mascara uma nova ausente)", async () => {
    liveStore("d1", "linkedin", { worker_queue_key: "k-old-li" });
    let s = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    s = withChannelState(s, "linkedin_pagina:d1", buildDoneChannelState("x", null));
    writeRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), s);
    // Só a antiga está na fila: 1 de 2.
    const { o } = opts({ posts: ["linkedin_pagina:d1", "threads:d1"], verifyWorker: async (p) => ({ updated: p, changes: 0, inQueue: 1 }) });
    const r = await runRetrospectivaSocialDispatch(o);
    assert.match(String(r.verifyError), /d1: só 1 de 2/);
  });

  it("--force num post do Worker cujo cancelamento lança ou já sumiu: não reenvia", async () => {
    let s = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    s = withChannelState(s, "linkedin_pagina:d3", buildDoneChannelState("x", null));
    writeRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), s);
    liveStore("d3", "linkedin", { worker_queue_key: "old-li-d3" });
    const boom = opts({ posts: ["linkedin_pagina:d3"], force: new Set(["linkedin_pagina:d3"]) });
    boom.o.dispatchers.cancelWorker = async () => {
      throw new Error("Worker 500");
    };
    const r = await runRetrospectivaSocialDispatch(boom.o);
    assert.equal(boom.calls.length, 0);
    assert.match(String((r.results[0] as { reason?: string }).reason), /cancelamento do post anterior.*Worker 500/);
    const gone = opts({ posts: ["linkedin_pagina:d3"], force: new Set(["linkedin_pagina:d3"]) });
    gone.o.dispatchers.cancelWorker = async () => ({ alreadyGone: true });
    const r2 = await runRetrospectivaSocialDispatch(gone.o);
    assert.equal(gone.calls.length, 0);
    assert.match(String((r2.results[0] as { reason?: string }).reason), /já saiu da fila/);
  });

  it("payload do X leva o texto como o pré-voo mediu (CRLF normalizado)", async () => {
    const crlf = CURTO.replace(/\n/g, "\r\n");
    const { o } = opts({ posts: ["x:d1"], texts: { ...TEXTS, d1: { corpo: CORPO, curto: crlf } } });
    const r = await runRetrospectivaSocialDispatch(o);
    const x = r.results[0];
    assert.ok(x.action === "x-payload");
    assert.ok(!x.payload.text.includes("\r"));
  });

  it("imagens não subidas (pendingUpload) fora do dry-run: nada despachado", async () => {
    const { o, calls } = opts({ prepareImages: async (hs) => Object.fromEntries(hs.map((h) => [h, { cards: cardsFor(h), pendingUpload: true }])) });
    await assert.rejects(runRetrospectivaSocialDispatch(o), /não subiram pro KV/);
    assert.equal(calls.length, 0);
  });

  it("upload/geração de imagem que falha: nada despachado", async () => {
    const { o, calls } = opts({ prepareImages: async () => { throw new Error("sharp morreu"); } });
    await assert.rejects(runRetrospectivaSocialDispatch(o), /imagens falhou — nada despachado: sharp morreu/);
    assert.equal(calls.length, 0);
  });
});
