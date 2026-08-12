/**
 * test/reader-facing-no-leaderboard-5107.test.ts (#5107 Grupo B)
 *
 * Guard anti-regressão, no molde de `test/reader-facing-no-legacy-brand-4424.test.ts`:
 * "leaderboard" nunca deve aparecer como texto VISÍVEL pro leitor — nem em
 * <title>/<h1>/parágrafo/link/meta description. O jogo "É IA?" usava duas
 * palavras pra mesma coisa ("ranking" em `/jogar`/`/share`/gate, "leaderboard"
 * em `/leaderboard*` e no e-mail); #5107 unificou em "ranking".
 *
 * O que este guard NÃO cobre de propósito (ficam como estão, decisão da
 * issue): identificador (`leaderboardHref`, `LeaderboardEntry`, ...), nome de
 * função (`handleLeaderboard*`, `renderLeaderboardHtml`, ...), a ROTA em si
 * (`/leaderboard`, `/leaderboard/{slug}` — trocar quebraria link em e-mail já
 * enviado), chave de KV (`leaderboard-snapshot:*`) e comentário de código.
 * Por isso o helper abaixo só olha o HTML RENDERIZADO (texto de elemento +
 * `<title>` + `content=` de `<meta>`), e ainda assim descarta o valor de
 * `href="..."` — que carrega a rota `/leaderboard*` por design.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { votePageHtml, type Env } from "../workers/poll/src/index.ts";
import {
  renderNicknameFormHtml,
  renderSubscribeBoxHtml,
  type SubscribeBoxState,
} from "../workers/poll/src/lib.ts";
import {
  handleLeaderboardByMonth,
  handleLeaderboardByYear,
  renderArchiveListHtml,
  renderArchiveVoteHtml,
} from "../workers/poll/src/leaderboard-routes.ts";
import {
  renderLeaderboardTop1Row,
  renderLeaderboardLinkRow,
} from "../scripts/lib/newsletter-render-html.ts";
import type { EIA } from "../scripts/lib/newsletter-parse.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

const LEADERBOARD_WORD_RE = /leaderboard/i;

/**
 * Descarta o que NÃO é texto visível pro leitor antes de checar a palavra:
 * comentários HTML, `<script>`/`<style>` inteiros (JS/CSS, não copy — CSS
 * pode citar um identificador em comentário, ex: "ver renderLeaderboardHtml
 * acima"), o VALOR de todo `href="…"` (rota `/leaderboard*` + UTM
 * `utm_medium=leaderboard-copy` — nenhum dos dois é texto que o leitor lê,
 * são destino/tracking de link, e ambos ficam intocados por decisão da
 * issue) e as tags `<meta>` cujo `content` é URL, não copy (`og:url`,
 * `og:image`, `twitter:image`). `content="…"` de `<meta name="description">`/
 * `og:title`/`og:description`/`twitter:description` NÃO é descartado — é
 * reader-facing (SEO/preview de link) e é justamente onde 4 das strings
 * corrigidas viviam.
 */
function stripNonVisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/href="[^"]*"/gi, 'href=""')
    .replace(/<meta property="og:(url|image)"[^>]*>/gi, "")
    .replace(/<meta name="twitter:image"[^>]*>/gi, "");
}

function assertNoVisibleLeaderboard(html: string, label: string): void {
  const stripped = stripNonVisible(html);
  const m = stripped.match(LEADERBOARD_WORD_RE);
  if (m) {
    const line = stripped.slice(0, m.index).split("\n").length;
    assert.fail(`${label}: "leaderboard" visível pro leitor (linha ~${line}) — deveria ser "ranking" (#5107)`);
  }
}

function makeEnv(seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeTrackedKv> } {
  return {
    POLL: makeTrackedKv(seed),
    POLL_SECRET: "test-secret",
    ADMIN_SECRET: "test-admin",
    ALLOWED_ORIGINS: "*",
  } as Env & { POLL: ReturnType<typeof makeTrackedKv> };
}

function baseEia(overrides: Partial<EIA> = {}): EIA {
  return {
    credit: "Foto teste",
    imageA: "01-eia-A.jpg",
    imageB: "01-eia-B.jpg",
    edition: "260601",
    ...overrides,
  };
}

describe("#5107 Grupo B — 'leaderboard' nunca aparece como texto visível pro leitor", () => {
  describe("lib.ts — renderNicknameFormHtml / renderSubscribeBoxHtml", () => {
    for (const brand of ["diaria", "clarice"] as const) {
      for (const surface of ["vote", "leaderboard"] as const) {
        it(`renderNicknameFormHtml (brand=${brand}, surface=${surface})`, () => {
          const html = renderNicknameFormHtml({ email: "a@x.com", sig: "sig" }, brand, true, surface);
          assertNoVisibleLeaderboard(html, `renderNicknameFormHtml(${brand}, ${surface})`);
        });
      }
    }

    it("renderSubscribeBoxHtml (brand=clarice)", () => {
      const box: SubscribeBoxState = { email: "a@x.com", sig: "sig", nickname: "Ana" };
      const html = renderSubscribeBoxHtml(box, "clarice");
      assertNoVisibleLeaderboard(html, "renderSubscribeBoxHtml(clarice)");
    });
  });

  describe("index.ts — votePageHtml", () => {
    for (const brand of ["diaria", "clarice", "web"] as const) {
      it(`votePageHtml com nicknameForm (brand=${brand})`, () => {
        const html = votePageHtml(
          "Acertou!", true, { email: "a@x.com", sig: "sig" }, null, "2026-07", brand,
        );
        assertNoVisibleLeaderboard(html, `votePageHtml(${brand}, com nicknameForm)`);
      });

      it(`votePageHtml sem nicknameForm (brand=${brand})`, () => {
        const html = votePageHtml("Já votou", false, null, null, "2026-07", brand);
        assertNoVisibleLeaderboard(html, `votePageHtml(${brand}, sem nicknameForm)`);
      });
    }
  });

  describe("leaderboard-routes.ts — páginas do ranking mensal/anual", () => {
    for (const brand of ["diaria", "clarice"] as const) {
      it(`handleLeaderboardByMonth (brand=${brand}, mês passado com votos)`, async () => {
        // Nota: o prefixo de brand na chave KV (`clarice:score-by-month:...`)
        // é aplicado por `brandedEnv` (index.ts) ANTES de chegar aqui — como
        // este teste chama o handler direto (sem passar pelo router), a chave
        // fica sem prefixo pros 2 brands; o que importa pro guard é o HTML
        // renderizado, não a fixture de dados em si.
        const env = makeEnv({
          "score-by-month:2020-01:reader@x.com": JSON.stringify({
            correct: 3, total: 5, nickname: "Leitor", masked: "l***@x.com",
          }),
        });
        const res = await handleLeaderboardByMonth("2020-01", env, brand);
        const html = await res.text();
        assertNoVisibleLeaderboard(html, `handleLeaderboardByMonth(${brand}, 2020-01)`);
      });

      it(`handleLeaderboardByMonth (brand=${brand}, mês futuro sem votos → "ainda não começou")`, async () => {
        const env = makeEnv();
        const res = await handleLeaderboardByMonth("2099-12", env, brand);
        const html = await res.text();
        assert.match(html, /O ranking de dezembro de 2099 ainda não começou/);
        assertNoVisibleLeaderboard(html, `handleLeaderboardByMonth(${brand}, 2099-12, not-started)`);
      });
    }

    it("handleLeaderboardByYear (brand=clarice, ano passado com votos)", async () => {
      const env = makeEnv({
        "score-by-month:2020-01:reader@x.com": JSON.stringify({
          correct: 3, total: 5, nickname: "Leitor", masked: "l***@x.com",
        }),
      });
      const res = await handleLeaderboardByYear("2020", env, "clarice");
      const html = await res.text();
      assertNoVisibleLeaderboard(html, "handleLeaderboardByYear(clarice, 2020)");
    });

    it('handleLeaderboardByYear (brand=clarice, ano futuro sem votos → "ainda não começou")', async () => {
      const env = makeEnv();
      const res = await handleLeaderboardByYear("2099", env, "clarice");
      const html = await res.text();
      assert.match(html, /O ranking de 2099 ainda não começou/);
      assertNoVisibleLeaderboard(html, "handleLeaderboardByYear(clarice, 2099, not-started)");
    });
  });

  describe("leaderboard-routes.ts — arquivo retroativo (#2867)", () => {
    it("renderArchiveListHtml (brand=clarice)", async () => {
      const res = renderArchiveListHtml(["260101", "260615"], "2026", "clarice");
      const html = await res.text();
      assertNoVisibleLeaderboard(html, "renderArchiveListHtml(clarice)");
    });

    it("renderArchiveVoteHtml (brand=clarice, mês comum)", async () => {
      const res = renderArchiveVoteHtml("260531", "2026", "clarice");
      const html = await res.text();
      assertNoVisibleLeaderboard(html, "renderArchiveVoteHtml(clarice, 260531)");
    });

    it("renderArchiveVoteHtml (brand=clarice, dezembro — nota de reconciliação de ano)", async () => {
      const res = renderArchiveVoteHtml("261231", "2026", "clarice");
      const html = await res.text();
      assertNoVisibleLeaderboard(html, "renderArchiveVoteHtml(clarice, 261231)");
    });
  });

  describe("scripts/lib/newsletter-render-html.ts — bloco do É IA? no rodapé do e-mail", () => {
    it("renderLeaderboardTop1Row — com pódio", () => {
      const html = renderLeaderboardTop1Row(
        baseEia({
          leaderboardPodium: [{ nickname: "Davyd", rank: 1 }],
          leaderboardPeriod: "Maio",
          leaderboardPeriodSlug: "2026-05",
        }),
        "font-family:sans-serif;",
      );
      assertNoVisibleLeaderboard(html, "renderLeaderboardTop1Row(com pódio)");
    });

    it("renderLeaderboardTop1Row — sem líderes, 1ª edição do mês (convite)", () => {
      const html = renderLeaderboardTop1Row(
        baseEia({ leaderboardPeriod: "Junho", leaderboardPeriodSlug: "2026-06" }),
        "font-family:sans-serif;",
      );
      assert.match(html, /Acompanhe o ranking de Junho/);
      assertNoVisibleLeaderboard(html, "renderLeaderboardTop1Row(convite)");
    });

    it("renderLeaderboardLinkRow — link persistente de toda edição", () => {
      const html = renderLeaderboardLinkRow("font-family:sans-serif;");
      assertNoVisibleLeaderboard(html, "renderLeaderboardLinkRow");
    });
  });
});
