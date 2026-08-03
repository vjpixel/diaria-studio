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
});
