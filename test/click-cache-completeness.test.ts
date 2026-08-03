/**
 * click-cache-completeness.test.ts (#4493)
 *
 * Testa o helper compartilhado extraído de `identifyPostsNeedingClicks`
 * (beehiiv-sync.ts) e `identifyWeeklyPostsNeedingClicks`
 * (weekly-linkedin-clicks.ts) — ver docstring de
 * `scripts/lib/shared/click-cache-completeness.ts` pro racional da
 * heurística (soma verified email + web contra o agregado, limiar 50%).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sumCachedClicks,
  isClickCacheComplete,
  CLICK_CACHE_COMPLETENESS_THRESHOLD,
  CLICK_CACHE_ROW_COUNT_FLOOR,
} from "../scripts/lib/shared/click-cache-completeness.ts";

describe("sumCachedClicks", () => {
  it("soma email.verified_clicks + web.total_clicked de todas as linhas", () => {
    const sum = sumCachedClicks([
      { email: { verified_clicks: 3 }, web: { total_clicked: 1 } },
      { email: { verified_clicks: 2 } },
    ]);
    assert.equal(sum, 6);
  });

  it("fallback pra unique_verified_clicks/total_unique_clicked quando verified_clicks/total_clicked ausentes", () => {
    const sum = sumCachedClicks([{ email: { unique_verified_clicks: 5 }, web: { total_unique_clicked: 2 } }]);
    assert.equal(sum, 7);
  });

  it("rows undefined/vazio soma 0, nunca lança", () => {
    assert.equal(sumCachedClicks(undefined), 0);
    assert.equal(sumCachedClicks([]), 0);
  });

  it("linha sem email/web soma 0 pra essa linha", () => {
    assert.equal(sumCachedClicks([{}]), 0);
  });

  it("#4493 achado 2 (fleet review #4383): rows truthy NÃO-array (cache corrompido) soma 0, nunca lança TypeError", () => {
    // stats.clicks é lido via JSON.parse cru sem validação de shape — um
    // objeto ou string aqui não pode cair no .reduce() de array.
    assert.equal(sumCachedClicks({} as never), 0);
    assert.equal(sumCachedClicks("corrupted" as never), 0);
    assert.equal(sumCachedClicks(42 as never), 0);
  });
});

describe("isClickCacheComplete", () => {
  it("emailClicks <= 0 é vacuamente completo (nada a buscar)", () => {
    assert.equal(isClickCacheComplete(0, undefined), true);
    assert.equal(isClickCacheComplete(-1, []), true);
  });

  it("rows undefined/vazio com emailClicks > 0 é incompleto", () => {
    assert.equal(isClickCacheComplete(10, undefined), false);
    assert.equal(isClickCacheComplete(10, []), false);
  });

  it("#4493: reproduz o achado real — 1 linha cobrindo ~2-3% do agregado é incompleto", () => {
    // 5 posts confirmados da 26w31: stats.clicks com 1 linha, email.clicks 34-51.
    assert.equal(isClickCacheComplete(38, [{ url: "x", email: { verified_clicks: 1 } }] as never), false);
    assert.equal(isClickCacheComplete(51, [{ email: { verified_clicks: 2 } }] as never), false);
  });

  it("cache saudável (soma >= 50% do agregado) é completo", () => {
    assert.equal(isClickCacheComplete(50, [{ email: { verified_clicks: 25 } }] as never), true);
    assert.equal(isClickCacheComplete(50, [{ email: { verified_clicks: 48 } }] as never), true);
  });

  it("limiar é estritamente >= (boundary exato conta como completo)", () => {
    const emailClicks = 40;
    const rows = [{ email: { verified_clicks: emailClicks * CLICK_CACHE_COMPLETENESS_THRESHOLD } }] as never;
    assert.equal(isClickCacheComplete(emailClicks, rows), true);
  });

  it("logo abaixo do limiar é incompleto", () => {
    const emailClicks = 40;
    const rows = [{ email: { verified_clicks: emailClicks * CLICK_CACHE_COMPLETENESS_THRESHOLD - 1 } }] as never;
    assert.equal(isClickCacheComplete(emailClicks, rows), false);
  });

  it("cache com muitas linhas (24+) somando perto do agregado é completo — não regressiona custo", () => {
    const healthyRows = Array.from({ length: 24 }, () => ({ email: { verified_clicks: 2 } })) as never;
    assert.equal(isClickCacheComplete(48, healthyRows), true); // soma = 48/48 = 100%
  });

  it("#4493 achado 2 (fleet review #4383): rows truthy NÃO-array (cache corrompido) é incompleto, nunca lança", () => {
    assert.equal(isClickCacheComplete(10, {} as never), false);
    assert.equal(isClickCacheComplete(10, "corrupted" as never), false);
    assert.equal(isClickCacheComplete(10, 42 as never), false);
  });

  describe("recalibração 260802 — piso de linhas (fleet review #4383 achado 1)", () => {
    it(`rows.length >= ${CLICK_CACHE_ROW_COUNT_FLOOR} é completo independente da razão de soma`, () => {
      // 6 linhas somando bem abaixo de 50% do agregado — antes da
      // recalibração isto seria incompleto; o piso de linhas cobre.
      const rows = Array.from({ length: CLICK_CACHE_ROW_COUNT_FLOOR }, () => ({ email: { verified_clicks: 1 } })) as never;
      assert.equal(isClickCacheComplete(100, rows), true); // soma=6/100=6%, mas rows>=piso
    });

    it(`rows.length logo abaixo do piso (${CLICK_CACHE_ROW_COUNT_FLOOR - 1}) ainda depende da razão`, () => {
      const rows = Array.from({ length: CLICK_CACHE_ROW_COUNT_FLOOR - 1 }, () => ({ email: { verified_clicks: 1 } })) as never;
      assert.equal(isClickCacheComplete(100, rows), false); // soma=5/100=5%, abaixo do piso E da razão
    });

    it("padrão do bug original (26w31, 1 linha) segue incompleto mesmo com o piso novo", () => {
      assert.equal(isClickCacheComplete(38, [{ url: "x", email: { verified_clicks: 1 } }] as never), false);
    });
  });

  describe("recalibração 260802 — validação contra os 226 posts confirmados reais de data/beehiiv-cache/posts/*.json (fleet review #4383 achado 1)", () => {
    // Números confirmados ao vivo em 260802 (replicação da validação do
    // code-reviewer): 39/226 posts (17,3%) abaixo de 0.5 usando email.clicks
    // bruto como denominador; 13 desses têm 6-10 linhas — dentro do range
    // "saudável" da issue #4493. Os 3 casos abaixo são exemplos nomeados no
    // achado 1; os números batem exatamente com o cache real.

    it('post_1033143a "Novo curso de IA do Google" (8 linhas, clicks=87, verified=56, soma=40) — completo (piso de linhas E denominador verified concordam: 40/56=0,71)', () => {
      const rows = [
        { email: { verified_clicks: 21 } },
        { email: { verified_clicks: 13 } },
        { email: { verified_clicks: 1 } },
        { email: { verified_clicks: 1 } },
        { email: { verified_clicks: 1 } },
        { email: { verified_clicks: 1 } },
        { email: { verified_clicks: 1 } },
        { email: { verified_clicks: 1 } },
      ] as never;
      assert.equal(sumCachedClicks(rows), 40);
      // Antes da recalibração (denominador bruto 87, sem piso): 40/87=0,46 — falso-positivo (incompleto).
      assert.equal(40 / 87 < CLICK_CACHE_COMPLETENESS_THRESHOLD, true, "denominador bruto sozinho não bastava");
      // isClickCacheComplete real: piso de 8>=6 linhas já garante completo, com qualquer denominador.
      assert.equal(isClickCacheComplete(87, rows), true, "piso de linhas resolve independente do denominador bruto");
      assert.equal(isClickCacheComplete(56, rows), true, "denominador verified (56): 40/56=0,71 também resolveria sozinho, sem precisar do piso");
    });

    it('"Claude Opus 3 se aposenta e vira blogueiro" (10 linhas, clicks=40, verified=28, soma=17) — completo (piso de linhas E denominador verified concordam: 17/28=0,61)', () => {
      const rows = Array.from({ length: 10 }, () => ({ email: { verified_clicks: 0 } })) as Array<{
        email: { verified_clicks: number };
      }>;
      // soma real = 17 distribuída de forma arbitrária entre as 10 linhas — só a soma total importa aqui.
      rows[0].email.verified_clicks = 17;
      assert.equal(sumCachedClicks(rows as never), 17);
      assert.equal(17 / 40 < CLICK_CACHE_COMPLETENESS_THRESHOLD, true, "denominador bruto (40): 17/40=0,425, abaixo — falso-positivo antes da recalibração");
      assert.equal(isClickCacheComplete(40, rows as never), true, "piso de 10>=6 linhas resolve independente do denominador bruto");
      assert.equal(isClickCacheComplete(28, rows as never), true, "denominador verified (28): 17/28=0,61 também resolveria sozinho");
    });

    it('"Anthropic lança Claude Opus 4.7" (7 linhas, clicks=32, verified=24, soma=9) — só o denominador verified NÃO resolve (9/24=0,375); é o piso de linhas que garante completo', () => {
      const rows = Array.from({ length: 7 }, () => ({ email: { verified_clicks: 0 } })) as Array<{
        email: { verified_clicks: number };
      }>;
      rows[0].email.verified_clicks = 9;
      assert.equal(sumCachedClicks(rows as never), 9);
      assert.equal(9 / 32 < CLICK_CACHE_COMPLETENESS_THRESHOLD, true, "denominador bruto (32): 9/32=0,28");
      assert.equal(
        9 / 24 < CLICK_CACHE_COMPLETENESS_THRESHOLD,
        true,
        "denominador verified (24): 9/24=0,375 — AINDA abaixo de 50%; só o troco de denominador NÃO resolveria este post",
      );
      assert.equal(rows.length >= CLICK_CACHE_ROW_COUNT_FLOOR, true, "7 linhas >= piso de 6");
      // isClickCacheComplete real: o piso de linhas garante completo mesmo a razão (com qualquer denominador) ficando abaixo de 50%.
      assert.equal(isClickCacheComplete(32, rows as never), true, "denominador bruto — completo via piso de linhas");
      assert.equal(isClickCacheComplete(24, rows as never), true, "denominador verified — completo via piso de linhas (a razão sozinha não bastaria)");
    });

    it('"Brasil regula IA eleitoral antes do pleito 2026" (5 linhas, clicks=21, verified=16, soma=10) — resolvido só pela troca de denominador (rows<piso)', () => {
      const rows = Array.from({ length: 5 }, () => ({ email: { verified_clicks: 0 } })) as Array<{
        email: { verified_clicks: number };
      }>;
      rows[0].email.verified_clicks = 10;
      assert.equal(sumCachedClicks(rows as never), 10);
      assert.equal(rows.length < CLICK_CACHE_ROW_COUNT_FLOOR, true, "5 linhas < piso — o piso não se aplica aqui");
      assert.equal(isClickCacheComplete(21, rows as never), false, "denominador bruto (21): 10/21=0,476, abaixo");
      assert.equal(isClickCacheComplete(16, rows as never), true, "denominador verified (16): 10/16=0,625 — só o troco de denominador resolve, sem precisar do piso");
    });
  });
});
