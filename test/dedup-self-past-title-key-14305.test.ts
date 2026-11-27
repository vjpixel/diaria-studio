/**
 * test/dedup-self-past-title-key-14305.test.ts (#14305)
 *
 * Regressão: o Pass 1 do dedup casa URLs por `dedupUrlKey` (#14021: `www.`,
 * esquema e idioma unificados), mas `selfPastTitles` (#12193) e o título
 * substituto de placeholder (#10641) buscavam o título passado por
 * `canonicalize`. URL publicada em `https://www.x.com/a` no RADAR que volta
 * como `https://x.com/a` era reconhecida como a mesma pelo Pass 1 (candidata a
 * destaque), mas o título passado dela não era achado: com o título atual
 * divergente do gravado, o Pass 1c a removia comparando contra o PRÓPRIO
 * título passado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedup } from "../scripts/dedup.ts";
import { DESTAQUE_ONLY_FIELD } from "../scripts/lib/destaque-upgrade.ts";
import { dedupComparisonTitle } from "../scripts/lib/placeholder-dedup-title.ts";
import { canonicalize, dedupUrlKey } from "../scripts/lib/url-utils.ts";

const PAST_URL = "https://www.techcrunch.com/2026/11/02/anthropic-warns-that-its-very-close-to-rsi-capability";
const CURRENT_URL = "https://techcrunch.com/2026/11/02/anthropic-warns-that-its-very-close-to-rsi-capability";
const PAST_TITLE = "Anthropic warns that it's very close to RSI capability, aka self-building AI";
// Mesmo artigo, título reescrito pela fonte: parecido o bastante para o Pass 1c
// casar com o título passado, diferente o bastante para não ser o mesmo texto.
const CURRENT_TITLE = "Anthropic warns it is now very close to RSI capability, so-called self-building AI";

function runDedup(articles: Array<Record<string, unknown> & { url: string }>, pastUrl: string) {
  return dedup(
    articles,
    new Set([canonicalize(pastUrl)]),
    0.85,
    [],
    0.7,
    [PAST_TITLE],
    0.6,
    new Set(),
    0.55,
    new Set(),
    [],
    [],
    new Map(),
    new Map(),
    new Map([[canonicalize(pastUrl), PAST_TITLE]]),
    [],
    new Set([canonicalize(pastUrl)]),
  );
}

describe("#14305 título passado buscado pela chave do dedup", () => {
  it("URL passada em www. e atual sem www.: a candidata a destaque não cai no próprio título", () => {
    const r = runDedup([{ url: CURRENT_URL, title: CURRENT_TITLE, flag: "editor_submitted" }], PAST_URL);
    assert.equal(r.removed.length, 0, JSON.stringify(r.removed));
    assert.equal(r.kept.length, 1);
    assert.match(String(r.kept[0][DESTAQUE_ONLY_FIELD]), /só pode voltar como destaque/);
  });

  it("variante http:// também acha o título passado", () => {
    const r = runDedup(
      [{ url: CURRENT_URL, title: CURRENT_TITLE, flag: "editor_submitted" }],
      PAST_URL.replace("https://", "http://"),
    );
    assert.equal(r.removed.length, 0, JSON.stringify(r.removed));
  });

  it("controle: o mesmo título passado ainda derruba um artigo comum de outra URL", () => {
    const r = runDedup([{ url: "https://outro.com/copia-da-rsi", title: CURRENT_TITLE }], PAST_URL);
    assert.equal(r.kept.length, 0);
    assert.match(r.removed[0].dedup_note ?? "", /subject similar/);
  });

  it("dedupComparisonTitle: placeholder acha o título real pela chave do dedup (variante www.)", () => {
    const byKey = new Map([[dedupUrlKey(PAST_URL), PAST_TITLE]]);
    assert.deepEqual(dedupComparisonTitle({ url: CURRENT_URL, title: "(inbox)" }, byKey), {
      title: PAST_TITLE,
      source: "past-url",
    });
  });

  it("dedupComparisonTitle: mapa chaveado por canonicalize segue funcionando para a mesma URL", () => {
    const byCanon = new Map([[canonicalize(PAST_URL), PAST_TITLE]]);
    assert.equal(dedupComparisonTitle({ url: PAST_URL, title: "(inbox)" }, byCanon).source, "past-url");
  });

  it("placeholder com URL passada em www.: Pass 1c compara pelo título real e remove o artigo comum", () => {
    // Sem a marca de só-destaque (URL fora do Set de elegíveis e de pastUrls),
    // o placeholder comparado pelo título passado da variante www. casa com ele.
    const r = dedup(
      [{ url: CURRENT_URL, title: "(inbox)" }],
      new Set(),
      0.85,
      [],
      0.7,
      [PAST_TITLE],
      0.6,
      new Set(),
      0.55,
      new Set(),
      [],
      [],
      new Map(),
      new Map(),
      new Map([[canonicalize(PAST_URL), PAST_TITLE]]),
    );
    assert.equal(r.kept.length, 0);
    assert.match(r.removed[0].dedup_note ?? "", /comparado pelo título da mesma URL/);
  });
});
