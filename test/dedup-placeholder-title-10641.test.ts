/**
 * test/dedup-placeholder-title-10641.test.ts (#10641)
 *
 * Regressão: na edição 261021 o link do TechCrunch "Anthropic says its
 * workforce has become less junior..." entrou pelo inbox (newsletter 7min.ai)
 * com `title: "(newsletter:\"7min.ai\")"` — o enrichment não conseguiu o
 * og:title. Pass-1b/1c do dedup compararam o PLACEHOLDER contra os títulos das
 * edições passadas, nada casou, e o item foi parar no RADAR embora a MESMA URL
 * estivesse no pool da 261019 com o título real (match de 100% quando o
 * editor rodou o dedup à mão com o título real).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedup } from "../scripts/dedup.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";
import {
  slugTitleFromUrl,
  dedupComparisonTitle,
} from "../scripts/lib/placeholder-dedup-title.ts";
import { extractPastEditionArticleTitleByUrl } from "../scripts/lib/past-editions-extract.ts";

const URL_261021 =
  "https://techcrunch.com/2026/10/17/anthropic-says-its-workforce-has-become-less-junior-and-is-spending-more-time-in-meetings";
const REAL_TITLE = "Anthropic says its workforce has become less junior and is spending more time in meetings";
const PLACEHOLDER = '(newsletter:"7min.ai")';

function runDedup(
  articles: { url: string; title?: string; flag?: string }[],
  pastArticleTitles: string[],
  titleByUrl: Map<string, string>,
  pastTitles: string[] = [],
) {
  return dedup(
    articles as never,
    new Set<string>(),
    0.85,
    pastTitles,
    0.7,
    pastArticleTitles,
    0.6,
    new Set<string>(),
    0.55,
    new Set<string>(),
    [],
    [],
    new Map(),
    new Map(),
    titleByUrl,
  );
}

describe("dedup Pass-1c com título placeholder (#10641)", () => {
  it("cenário 261021: placeholder cuja URL esteve no pool recente com título real é removido", () => {
    const titleByUrl = new Map([[canonicalize(URL_261021), REAL_TITLE]]);
    const res = runDedup(
      [{ url: URL_261021, title: PLACEHOLDER, flag: "newsletter_extracted" }],
      [REAL_TITLE],
      titleByUrl,
    );
    assert.equal(res.kept.length, 0, "item repetido deveria sair do pool");
    assert.equal(res.removed.length, 1);
    assert.match(res.removed[0].dedup_note ?? "", /subject similar/);
    assert.match(res.removed[0].dedup_note ?? "", /#10641/);
  });

  it("sem título substituto conhecido, cai no slug da URL", () => {
    const res = runDedup(
      [{ url: URL_261021, title: PLACEHOLDER, flag: "newsletter_extracted" }],
      [REAL_TITLE],
      new Map(),
    );
    assert.equal(res.kept.length, 0);
    assert.match(res.removed[0].dedup_note ?? "", /slug da URL/);
  });

  it("Pass-1b (headline) também usa o substituto", () => {
    const titleByUrl = new Map([[canonicalize(URL_261021), REAL_TITLE]]);
    const res = runDedup(
      [{ url: URL_261021, title: PLACEHOLDER }],
      [],
      titleByUrl,
      [REAL_TITLE],
    );
    assert.equal(res.kept.length, 0);
    assert.match(res.removed[0].dedup_note ?? "", /headline de edição anterior/);
  });

  it("placeholder sem substituto e sem slug útil continua passando (comportamento anterior)", () => {
    const res = runDedup(
      [{ url: "https://example.com/p/123", title: PLACEHOLDER }],
      [REAL_TITLE],
      new Map(),
    );
    assert.equal(res.kept.length, 1);
  });

  it("título real nunca é trocado pelo substituto", () => {
    const titleByUrl = new Map([[canonicalize(URL_261021), REAL_TITLE]]);
    const res = runDedup(
      [{ url: URL_261021, title: "Gemini ganha modo offline no Android" }],
      [REAL_TITLE],
      titleByUrl,
    );
    assert.equal(res.kept.length, 1);
    assert.equal(res.kept[0].title, "Gemini ganha modo offline no Android");
  });

  it("título exibido do item mantido não muda (substituto é só para comparação)", () => {
    const url = "https://techcrunch.com/2026/10/18/openai-ships-a-new-voice-model-for-call-centers-today";
    const res = runDedup([{ url, title: PLACEHOLDER }], [REAL_TITLE], new Map());
    assert.equal(res.kept.length, 1);
    assert.equal(res.kept[0].title, PLACEHOLDER);
  });
});

describe("slugTitleFromUrl (#10641)", () => {
  it("extrai o slug descritivo, ignorando segmentos de data", () => {
    assert.equal(
      slugTitleFromUrl(URL_261021),
      "anthropic says its workforce has become less junior and is spending more time in meetings",
    );
  });
  it("remove extensão e ids numéricos", () => {
    assert.equal(
      slugTitleFromUrl("https://g1.globo.com/tec/noticia/2026/10/20/curso-de-ia-supera-medicina-na-nota-de-corte.ghtml"),
      "curso de ia supera medicina na nota de corte",
    );
  });
  it("slug curto ou numérico não vira título", () => {
    assert.equal(slugTitleFromUrl("https://api-docs.deepseek.com/news/news261017"), null);
    assert.equal(slugTitleFromUrl("https://example.com/p/123"), null);
    assert.equal(slugTitleFromUrl("https://example.com/blog/claude-opus"), null);
    assert.equal(slugTitleFromUrl("not a url"), null);
  });
});

describe("dedupComparisonTitle (#10641)", () => {
  it("prioriza título da mesma URL em edição recente sobre o slug", () => {
    const titleByUrl = new Map([[canonicalize(URL_261021), REAL_TITLE]]);
    assert.deepEqual(dedupComparisonTitle({ url: URL_261021, title: "(inbox)" }, titleByUrl), {
      title: REAL_TITLE,
      source: "past-url",
    });
  });
  it("título vazio também é placeholder", () => {
    assert.equal(dedupComparisonTitle({ url: URL_261021 }, new Map()).source, "slug");
  });
});

describe("extractPastEditionArticleTitleByUrl (#10641)", () => {
  const root = mkdtempSync(join(tmpdir(), "dedup-10641-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("lê URL→título dos 01-approved.json recentes (layout nested) e exclui a edição corrente", () => {
    const mk = (aammdd: string, approved: unknown) => {
      const dir = join(root, aammdd.slice(0, 4), aammdd, "_internal");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "01-approved.json"), JSON.stringify(approved));
    };
    mk("261019", { radar: [{ url: URL_261021, title: REAL_TITLE }], highlights: [] });
    mk("261021", { radar: [{ url: "https://x.com/current", title: "Da edição corrente" }] });

    const map = extractPastEditionArticleTitleByUrl(root, 3, "261021");
    assert.equal(map.get(canonicalize(URL_261021)), REAL_TITLE);
    assert.equal(map.has(canonicalize("https://x.com/current")), false);
  });
});
