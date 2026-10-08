/**
 * test/past-editions-links-usados-rendered-9867.test.ts (#9867)
 *
 * Regressão (edição 261008): `data/past-editions.md` listava em "Links usados"
 * da 261007 o `deepmind.google/models/model-cards/nano-banana-2-1/`, que na
 * 261007 era só candidato do pool (RADAR, posição 26 do `01-approved.json`) —
 * nunca publicado. `dedup.ts` e o invariante
 * `no-duplicate-urls-vs-past-editions` (#8993) acusaram repetição no D2 da
 * 261008. "Links usados" agora sai do que a edição renderizou.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictToRenderedUrls, usedUrlKey } from "../scripts/lib/approved-urls.ts";
import { extractUrlsFromApproved } from "../scripts/refresh-past-editions.ts";
import { extractUrlsFromApproved as extractPendingUrls } from "../scripts/merge-local-pending.ts";

const NANO = "https://deepmind.google/models/model-cards/nano-banana-2-1/";
const D1 = "https://openai.com/index/gpt-6/";
const RADAR_USED = "https://www.theverge.com/ai/123/story";
const CLUSTER = "https://techcrunch.com/2026/10/07/gpt-6-launch/";

const APPROVED_261007 = {
  highlights: [{ url: D1, article: { url: D1, cluster_sources: [{ url: CLUSTER }] } }],
  radar: [{ url: RADAR_USED }, { url: NANO }],
};

/** Só D1 (+ Aprofunde) e um item de RADAR chegaram ao texto; o nano-banana ficou no pool. */
const REVIEWED_261007 = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  `**[GPT-6 chega](${D1}?utm_source=diaria)**`,
  "",
  "Aprofunde:",
  `- [TechCrunch](${CLUSTER})`,
  "",
  "---",
  "",
  "**📡 RADAR**",
  "",
  `**[História do Verge](https://theverge.com/ai/123/story)**`,
  "Texto.",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeEdition(root: string, yymmdd: string, reviewed: string | null): string {
  const editionDir = join(root, "data/editions", yymmdd.slice(0, 4), yymmdd);
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(join(editionDir, "_internal", "01-approved.json"), JSON.stringify(APPROVED_261007));
  if (reviewed !== null) writeFileSync(join(editionDir, "02-reviewed.md"), reviewed);
  return editionDir;
}
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "diaria-9867-"));
  dirs.push(d);
  return d;
}

describe("#9867 — Links usados vem do que a edição renderizou", () => {
  it("REGRESSÃO 261007: candidato que ficou só no pool NÃO entra em Links usados", () => {
    const root = tmpRoot();
    writeEdition(root, "261007", REVIEWED_261007);
    const urls = extractUrlsFromApproved("261007", root);
    assert.ok(!urls.includes(NANO), `nano-banana não foi publicado: ${JSON.stringify(urls)}`);
    assert.deepEqual(urls, [RADAR_USED, D1, CLUSTER], "publicados (com Aprofunde) continuam, na ordem do approved");
  });

  it("merge-local-pending (edição aprovada mas não publicada) aplica a mesma regra", () => {
    const root = tmpRoot();
    const editionDir = writeEdition(root, "261007", REVIEWED_261007);
    const urls = extractPendingUrls(join(editionDir, "_internal", "01-approved.json"));
    assert.ok(!urls.includes(NANO));
    assert.ok(urls.includes(D1) && urls.includes(RADAR_USED));
  });

  it("sem 02-reviewed.md local → approved inteiro (fail-safe: bloqueia a mais, nunca perde publicado)", () => {
    const root = tmpRoot();
    writeEdition(root, "261007", null);
    assert.ok(extractUrlsFromApproved("261007", root).includes(NANO));
  });

  it("02-reviewed.md sem nenhuma URL → approved inteiro", () => {
    assert.deepEqual(restrictToRenderedUrls([D1, NANO], "texto truncado sem link"), [D1, NANO]);
  });

  it("usedUrlKey ignora www, utm, fragmento e barra final", () => {
    assert.equal(usedUrlKey("https://www.Theverge.com/ai/123/story/?utm_source=x#top"), usedUrlKey(RADAR_USED));
    assert.notEqual(usedUrlKey("https://ex.com/a?id=1"), usedUrlKey("https://ex.com/a?id=2"));
  });
});
