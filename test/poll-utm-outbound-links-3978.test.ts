/**
 * test/poll-utm-outbound-links-3978.test.ts (#3978)
 *
 * UTM em todos os links de saída pra diar.ia.br — cobre os 3 grupos de gaps
 * achados na investigação da issue (23/07):
 *
 *   Grupo 1 — `renderBrandFooter` (lib.ts) não carregava UTM nenhum. 1 fix
 *   cobre 9 call sites (jogar.ts×4, leaderboard-routes.ts×3, share.ts×2).
 *
 *   Grupo 2 — links inline hardcoded sem UTM: CTA "Conhecer a Diar.ia"
 *   (jogar.ts, `renderSubscribeCtaBlock`), rodapé "← Voltar para a Diar.ia"
 *   (jogar.ts×3), rodapé de `/vote` (index.ts, `votePageHtml`), sub-copy do
 *   leaderboard (leaderboard-routes.ts — o link "diar.ia.br" hardcoded pra
 *   `https://diaria.beehiiv.com` não tinha PARÂMETRO NENHUM).
 *
 *   Grupo 3 — cadeia de share (share.ts) com UTM parcial: botões
 *   share/WhatsApp/copiar e CTAs de `/share` + `/quiz-share` só carregavam
 *   utm_medium (ou, no CTA, um `utm_source=share` hardcoded desalinhado da
 *   convenção `eia-standalone` usada em todo o resto do funil).
 *
 * Também cobre a migração de `SUBSCRIBE_UTM_SOURCE` (fonte única de verdade)
 * de jogar.ts pra lib.ts, com back-compat de import via reexport.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBrandSiteUrl,
  renderBrandFooter,
  SUBSCRIBE_UTM_SOURCE as LIB_SUBSCRIBE_UTM_SOURCE,
  BRAND_INFO,
} from "../workers/poll/src/lib.ts";
import {
  renderSubscribeCtaBlock,
  renderJogarPageHtml,
  renderJogarSequencePageHtml,
  renderJogarQuizPageHtml,
  SUBSCRIBE_UTM_SOURCE as JOGAR_SUBSCRIBE_UTM_SOURCE,
} from "../workers/poll/src/jogar.ts";
import {
  renderShareCardBlock,
  renderSharePageHtml,
  renderQuizShareCardBlock,
  renderQuizSharePageHtml,
} from "../workers/poll/src/share.ts";
import workerDefault, { votePageHtml, type Env } from "../workers/poll/src/index.ts";

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data: Record<string, string> = { ...seed };
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
    getWithMetadata: async () => ({ value: null, metadata: null }),
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = Object.keys(data).filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  } as unknown as KVNamespace;
}

function makeEnv(seed: Record<string, string> = {}): Env {
  return {
    POLL: makeKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  };
}

async function fetchHtml(path: string, env: Env = makeEnv()): Promise<string> {
  const req = new Request(`https://poll.diaria.workers.dev${path}`);
  const res = await workerDefault.fetch(req, env, {} as ExecutionContext);
  assert.equal(res.status, 200, `esperava 200 para ${path}, recebeu ${res.status}`);
  return res.text();
}

describe("SUBSCRIBE_UTM_SOURCE — fonte única de verdade movida pra lib.ts (#3978)", () => {
  it("lib.ts e jogar.ts (reexport, back-compat de import de subscribe.ts) apontam pro MESMO valor", () => {
    assert.equal(LIB_SUBSCRIBE_UTM_SOURCE, "eia-standalone");
    assert.equal(JOGAR_SUBSCRIBE_UTM_SOURCE, LIB_SUBSCRIBE_UTM_SOURCE);
  });

  it("subscribeToBeehiiv (subscribe.ts, cadastro inline #3580) usa o mesmo valor no payload — import direto de lib.ts desde o #3978 (antes: de ./jogar)", async () => {
    const { subscribeToBeehiiv } = await import("../workers/poll/src/subscribe.ts");
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const env = { BEEHIIV_API_KEY: "k", BEEHIIV_PUBLICATION_ID: "p" } as any;
    await subscribeToBeehiiv(env, { name: "", email: "a@b.com" }, fakeFetch);
    assert.equal((capturedBody as unknown as Record<string, unknown>)?.utm_source, LIB_SUBSCRIBE_UTM_SOURCE);
  });
});

describe("buildBrandSiteUrl (lib.ts, #3978) — helper único de href com UTM pro site", () => {
  it("monta utm_source/utm_medium/utm_campaign via URLSearchParams (nunca concatenação manual)", () => {
    const url = buildBrandSiteUrl("diaria", "footer", "eia-footer");
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://diar.ia.br");
    assert.equal(parsed.searchParams.get("utm_source"), "eia-standalone");
    assert.equal(parsed.searchParams.get("utm_medium"), "footer");
    assert.equal(parsed.searchParams.get("utm_campaign"), "eia-footer");
  });

  it("preserva query string EXISTENTE do brand (clarice.siteUrl já tem ?via=diaria) — não quebra o tracking de afiliado Rewardful", () => {
    const url = buildBrandSiteUrl("clarice", "footer", "eia-footer");
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://clarice.ai");
    assert.equal(parsed.searchParams.get("via"), "diaria", "via=diaria (Rewardful) deve sobreviver à adição do UTM");
    assert.equal(parsed.searchParams.get("utm_source"), "eia-standalone");
  });

  it("utm_source é sempre SUBSCRIBE_UTM_SOURCE, independente do medium/campaign passado", () => {
    const url = buildBrandSiteUrl("web", "posvoto-cta", "eia-jogar-conhecer");
    assert.equal(new URL(url).searchParams.get("utm_source"), LIB_SUBSCRIBE_UTM_SOURCE);
  });
});

describe("Grupo 1 — renderBrandFooter (lib.ts) ganha UTM, 1 fix cobre 9 call sites (#3978)", () => {
  it("renderBrandFooter(diaria/clarice/web) sempre carrega utm_source/medium=footer/campaign=eia-footer", () => {
    for (const brand of ["diaria", "clarice", "web"] as const) {
      const html = renderBrandFooter(brand);
      assert.match(html, /utm_source=eia-standalone/, `brand ${brand} sem utm_source`);
      assert.match(html, /utm_medium=footer/, `brand ${brand} sem utm_medium=footer`);
      assert.match(html, /utm_campaign=eia-footer/, `brand ${brand} sem utm_campaign=eia-footer`);
    }
  });

  it("href gerado é exatamente buildBrandSiteUrl(brand, 'footer', 'eia-footer') escapado", () => {
    const html = renderBrandFooter("clarice");
    const expectedHref = buildBrandSiteUrl("clarice", "footer", "eia-footer").replace(/&/g, "&amp;");
    assert.ok(html.includes(`href="${expectedHref}"`), html);
  });

  it("GET /leaderboard (brand diaria default): rodapé de marca com UTM", async () => {
    const html = await fetchHtml("/leaderboard");
    assert.match(html, /<footer class="brand-footer">[\s\S]*?utm_source=eia-standalone[\s\S]*?<\/footer>/);
  });

  it("GET /leaderboard/2026?brand=clarice: rodapé usa clarice.ai preservando via=diaria + UTM", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    assert.match(html, /href="https:\/\/clarice\.ai\/\?via=diaria&amp;utm_source=eia-standalone&amp;utm_medium=footer&amp;utm_campaign=eia-footer"/);
  });
});

describe("Grupo 2 — CTA 'Conhecer a Diar.ia' pós-voto (jogar.ts, renderSubscribeCtaBlock, #3978)", () => {
  it("href carrega utm_medium=posvoto-cta + utm_campaign=eia-jogar-conhecer (antes: SEM parâmetro nenhum)", () => {
    const html = renderSubscribeCtaBlock();
    assert.match(html, /utm_source=eia-standalone/);
    assert.match(html, /utm_medium=posvoto-cta/);
    assert.match(html, /utm_campaign=eia-jogar-conhecer/);
  });

  it("aparece embutido (hidden) nas páginas /jogar (par único e sequência)", () => {
    const htmlPar = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(htmlPar, /utm_medium=posvoto-cta/);
    const htmlSeq = renderJogarSequencePageHtml(["260101", "260102"]);
    assert.match(htmlSeq, /utm_medium=posvoto-cta/);
  });
});

describe("Grupo 2 — rodapé '← Voltar para a Diar.ia' em /jogar (par único, sequência, quiz — #3978)", () => {
  it("renderJogarPageHtml (par único via ?edition=): link 'Voltar' carrega utm_medium=jogar-footer", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: false });
    assert.match(html, /href="[^"]*utm_medium=jogar-footer[^"]*">← Voltar para a Diar\.ia<\/a>/);
    assert.match(html, /utm_campaign=eia-jogar-footer/);
  });

  it("renderJogarSequencePageHtml (sequência do mês): mesmo medium/campaign do par único", () => {
    const html = renderJogarSequencePageHtml(["260101", "260102"]);
    assert.match(html, /href="[^"]*utm_medium=jogar-footer[^"]*">← Voltar para a Diar\.ia<\/a>/);
  });

  it("renderJogarQuizPageHtml (quiz relâmpago): mesmo medium/campaign", () => {
    const html = renderJogarQuizPageHtml(["260101", "260102"]);
    assert.match(html, /href="[^"]*utm_medium=jogar-footer[^"]*">← Voltar para a Diar\.ia<\/a>/);
  });
});

describe("Grupo 2 — rodapé de /vote (index.ts, votePageHtml, #3978)", () => {
  it("link 'Voltar' carrega UTM (medium=vote-footer) — antes ia com BRAND_INFO[brand].siteUrl cru", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "diaria");
    assert.match(html, /href="[^"]*utm_source=eia-standalone[^"]*utm_medium=vote-footer[^"]*utm_campaign=eia-vote-footer[^"]*">← Voltar para a Diar\.ia<\/a>/);
  });

  it("brand clarice: usa BRAND_INFO.clarice.siteUrl (clarice.ai) preservando via=diaria + UTM", () => {
    const html = votePageHtml("Você acertou!", true, null, null, null, "clarice");
    assert.match(html, /href="https:\/\/clarice\.ai\/\?via=diaria&amp;utm_source=eia-standalone&amp;utm_medium=vote-footer&amp;utm_campaign=eia-vote-footer"/);
  });
});

describe("Grupo 2 — sub-copy do leaderboard (leaderboard-routes.ts, #3978)", () => {
  it("brand clarice: os 2 links (diar.ia.br e Clarice) carregam UTM — antes o 1º ia pra diaria.beehiiv.com SEM parâmetro nenhum", async () => {
    const html = await fetchHtml("/leaderboard/2026?brand=clarice");
    const subCopyMatch = html.match(/<p class="sub">.*?<\/p>/s);
    assert.ok(subCopyMatch, "sub-copy deve existir");
    const subCopy = subCopyMatch![0];
    assert.match(subCopy, /utm_medium=leaderboard-copy/);
    assert.match(subCopy, /utm_campaign=eia-leaderboard-copy/);
    // 2 ocorrências de utm_source: 1 por link.
    assert.equal((subCopy.match(/utm_source=eia-standalone/g) ?? []).length, 2);
  });

  it("brand diaria: link único também ganha UTM (antes: BRAND_INFO.diaria.siteUrl cru)", async () => {
    const html = await fetchHtml("/leaderboard");
    const subCopyMatch = html.match(/<p class="sub">.*?<\/p>/s);
    assert.ok(subCopyMatch);
    assert.match(subCopyMatch![0], /utm_medium=leaderboard-copy/);
  });
});

describe("Grupo 3 — cadeia de share (share.ts, #3978) — utm_source/campaign completam o funil", () => {
  it("renderShareCardBlock: os 3 botões (social/whatsapp/copy) carregam utm_source=eia-standalone + utm_campaign=eia-share", () => {
    const html = renderShareCardBlock("260716.1.abc123", { edition: "260716", correct: true });
    for (const medium of ["social", "whatsapp", "copy"]) {
      assert.match(
        html,
        new RegExp(`utm_source=eia-standalone&amp;utm_medium=${medium}&amp;utm_campaign=eia-share`),
        `botão ${medium} deveria ter utm_source/utm_campaign`,
      );
    }
  });

  it("renderSharePageHtml: CTA 'Jogar agora' usa utm_source=eia-standalone (não mais 'share' hardcoded) + utm_campaign=eia-share, preservando utm_medium recebido", () => {
    const html = renderSharePageHtml({ token: "t", payload: { edition: "260716", correct: true }, utmMedium: "whatsapp" });
    assert.match(html, /href="\/jogar\?utm_source=eia-standalone&amp;utm_medium=whatsapp&amp;utm_campaign=eia-share"/);
  });

  it("renderQuizShareCardBlock: os 3 botões carregam utm_campaign=eia-quiz-share (distinto do par único)", () => {
    const html = renderQuizShareCardBlock("s4t5.abc", { score: 4, total: 5 });
    for (const medium of ["social", "whatsapp", "copy"]) {
      assert.match(
        html,
        new RegExp(`utm_source=eia-standalone&amp;utm_medium=${medium}&amp;utm_campaign=eia-quiz-share`),
      );
    }
  });

  it("renderQuizSharePageHtml: CTA 'Jogar o quiz' usa utm_source=eia-standalone + utm_campaign=eia-quiz-share", () => {
    const html = renderQuizSharePageHtml({ token: "t", payload: { score: 4, total: 5 }, utmMedium: "copy" });
    assert.match(html, /href="\/jogar\/quiz\?utm_source=eia-standalone&amp;utm_medium=copy&amp;utm_campaign=eia-quiz-share"/);
  });

  it("utm_campaign do par único e do quiz são DISTINTOS (funil mensurado separadamente)", () => {
    const shareHtml = renderShareCardBlock("t", { edition: "260716", correct: true });
    const quizHtml = renderQuizShareCardBlock("t", { score: 4, total: 5 });
    assert.match(shareHtml, /utm_campaign=eia-share/);
    assert.doesNotMatch(shareHtml, /utm_campaign=eia-quiz-share/);
    assert.match(quizHtml, /utm_campaign=eia-quiz-share/);
  });
});

describe("O que já estava correto NÃO foi tocado (#3978, regressão)", () => {
  it("buildSubscribeUrl (jogar.ts) continua indo pra diaria.beehiiv.com direto, com os 3 UTMs originais", async () => {
    const { buildSubscribeUrl, SUBSCRIBE_UTM_SOURCE, SUBSCRIBE_UTM_MEDIUM, SUBSCRIBE_UTM_CAMPAIGN } = await import("../workers/poll/src/jogar.ts");
    const url = buildSubscribeUrl();
    assert.match(url, /^https:\/\/diaria\.beehiiv\.com\/\?/);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("utm_source"), SUBSCRIBE_UTM_SOURCE);
    assert.equal(parsed.searchParams.get("utm_medium"), SUBSCRIBE_UTM_MEDIUM);
    assert.equal(parsed.searchParams.get("utm_campaign"), SUBSCRIBE_UTM_CAMPAIGN);
  });

  it("BRAND_INFO não foi alterado pelo #3978 (buildBrandSiteUrl é aditivo, não muda os dados de brand)", () => {
    assert.equal(BRAND_INFO.diaria.siteUrl, "https://diar.ia.br");
    assert.equal(BRAND_INFO.clarice.siteUrl, "https://clarice.ai/?via=diaria");
    assert.equal(BRAND_INFO.web.siteUrl, "https://diar.ia.br");
  });

  it("canonical/og:url (renderSeoMeta) continuam SEM UTM — SEO não deve carregar parâmetro de campanha", async () => {
    const html = await fetchHtml("/leaderboard");
    const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)">/);
    assert.ok(canonicalMatch, "canonical deve existir");
    assert.doesNotMatch(canonicalMatch![1], /utm_/, "canonical não deve carregar UTM (SEO)");
  });
});
