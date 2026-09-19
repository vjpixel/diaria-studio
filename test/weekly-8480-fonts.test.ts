import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllowOwnEditions, applyOwnEditionAllowance } from "../scripts/publish-weekly-social.ts";
import { sectionCardCacheKey } from "../scripts/lib/weekly-instagram-ondemand-card.ts";
import { buildOverlaySvg, overlayFittingFontSize, WEEKLY_OVERLAY_WRAP } from "../scripts/gen-social-card-4x5.ts";
import type { InstagramRankedCandidate } from "../scripts/lib/weekly-instagram-select.ts";

const cand = (editionDate: string, n: number, excluded: boolean) =>
  ({ kind: "destaque", destaqueNumber: n, editionDate, excluded, title: "t", url: "https://x/" + editionDate + n }) as unknown as InstagramRankedCandidate;

describe("--allow-own-editions (#8480)", () => {
  it("parse separa AAMMDD válidos de inválidos", () => {
    assert.deepEqual(parseAllowOwnEditions("260914, 260915,abc"), { editions: ["260914", "260915"], invalid: ["abc"] });
    assert.deepEqual(parseAllowOwnEditions(undefined), { editions: [], invalid: [] });
  });
  it("un-exclude só o D1 da edição permitida e NÃO muta a entrada", () => {
    const input = [cand("260914", 1, true), cand("260914", 2, true), cand("260915", 1, true)];
    const out = applyOwnEditionAllowance(input, ["260914"]);
    assert.equal(out[0].excluded, false);
    assert.equal(out[1].excluded, true);
    assert.equal(out[2].excluded, true);
    assert.equal(input[0].excluded, true, "entrada intacta (sem mutação)");
  });
  it("lista vazia devolve a mesma referência", () => {
    const input = [cand("260914", 1, true)];
    assert.equal(applyOwnEditionAllowance(input, []), input);
  });
});

describe("chave de cache do card de radar inclui o tamanho da fonte (#8480)", () => {
  it("tamanhos diferentes → chaves diferentes; sem tamanho → chave legada", () => {
    const u = "https://exemplo.com/a";
    assert.notEqual(sectionCardCacheKey("radar", u, 62), sectionCardCacheKey("radar", u, 70));
    assert.notEqual(sectionCardCacheKey("radar", u, 62), sectionCardCacheKey("radar", u));
    assert.match(sectionCardCacheKey("radar", u, 62), /_4x5_fs62$/);
    assert.match(sectionCardCacheKey("radar", u), /_4x5$/);
  });
});

describe("overlay: wrap semanal não altera o card diário (#8480)", () => {
  const title = "DeepSeek quase iguala GPT-6 Astra por 1,4% do custo";
  const textLines = (svg: string) => (svg.match(/font-weight="700"[^>]*>([^<]*)</g) ?? []).map((m) => m.replace(/.*>/, ""));
  it("sem wrap, o SVG diário é idêntico ao de antes (mesmo tamanho e mesmas linhas)", () => {
    assert.equal(buildOverlaySvg(title, "16 SET 2026", undefined, 62), buildOverlaySvg(title, "16 SET 2026", undefined, 62, "", undefined));
  });
  it("com wrap semanal quebra mais cedo (linhas mais curtas) que o diário", () => {
    const daily = Math.max(...textLines(buildOverlaySvg(title, "", undefined, 62)).map((l) => l.length));
    const weekly = Math.max(...textLines(buildOverlaySvg(title, "", undefined, 62, "", WEEKLY_OVERLAY_WRAP)).map((l) => l.length));
    assert.ok(weekly < daily, `semanal ${weekly} deveria ser < diário ${daily}`);
  });
  it("overlayFittingFontSize sem wrap segue igual ao default diário", () => {
    assert.equal(overlayFittingFontSize(title, 936), overlayFittingFontSize(title, 936, { divisor: 29, ratio: 0.58 }));
  });
});
