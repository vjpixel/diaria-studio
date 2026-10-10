/**
 * test/use-melhor-pool-swap-demote-9869.test.ts (#9869)
 *
 * Dois achados do gate da edição 261008:
 *   (a) item do POOL (`01-approved.json`) incluído no USE MELHOR à mão no
 *       gate não era elegível ao 4º post — o seletor só lia o
 *       `01-approved-capped.json` (os 2 USE MELHOR de maior score);
 *   (b) `swap-destaques.ts` devolvia o destaque trocado sempre ao
 *       `radar[0]`; mandá-lo a LANÇAMENTOS exigia mover à mão e deixava a
 *       cópia no radar (duplicata `lancamento` + `radar` no `url-bucket`).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mergeUseMelhorPools,
  readApprovedPoolForUseMelhor,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { runSelection } from "../scripts/select-use-melhor-post.ts";
import {
  swapManualInApprovedJson,
  parseSwapDestaquesArgs,
  removeUrlFromPoolBuckets,
} from "../scripts/swap-destaques.ts";

const ON: UseMelhorPostConfigState = { enabled: true, time: "08:00" };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmpEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-9869-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

// ── (a) seletor do 4º post consulta o pool ──────────────────────────────────

const CAP_A = { url: "https://a.example.com/guia", title: "Guia A", summary: "", score: 70 };
const CAP_B = { url: "https://b.example.com/guia", title: "Guia B", summary: "", score: 65 };
const POOL_C = { url: "https://machinelearningmastery.com/rag-guide/", title: "RAG guide", summary: "", score: 58 };
const CAPPED = { use_melhor: [CAP_A, CAP_B] };
const FULL = { use_melhor: [CAP_A, CAP_B, POOL_C] };

/** Editor tirou A e B do USE MELHOR e incluiu C (vindo do pool) — caso 261008. */
const REVIEWED_ONLY_POOL = [
  "**🛠️ USE MELHOR**",
  "",
  `**[${POOL_C.title}](${POOL_C.url})**`,
  "Como montar um RAG. (12 min)",
  "",
].join("\n");

describe("#9869 (a) — item do pool incluído no gate é elegível ao 4º post", () => {
  it("REGRESSÃO 261008: só o item do pool renderizado → selecionado (não 'colado à mão')", () => {
    const dir = tmpEdition();
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(CAPPED));
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(FULL));
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_ONLY_POOL);
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, POOL_C.url, JSON.stringify(r.state));
    assert.equal(r.state.item?.score, 58);
    assert.equal(r.state.selected_from, "reviewed");
    assert.equal(r.state.reason, undefined);
  });

  it("item realmente colado à mão (fora dos dois JSONs) continua não elegível", () => {
    const dir = tmpEdition();
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(CAPPED));
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(FULL));
    writeFileSync(
      join(dir, "02-reviewed.md"),
      ["**🛠️ USE MELHOR**", "", "**[Outro](https://nao-esta.example.com/x)**", "Texto. (5 min)", ""].join("\n"),
    );
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.equal(r.state.item, null);
    assert.match(r.state.reason ?? "", /colados à mão/);
  });

  it("Stage 2 (sem 02-reviewed.md) segue selecionando só do capped", () => {
    const dir = tmpEdition();
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ use_melhor: [CAP_B] }));
    writeFileSync(
      join(dir, "_internal", "01-approved.json"),
      JSON.stringify({ use_melhor: [CAP_B, { ...POOL_C, score: 99 }] }),
    );
    const r = runSelection(dir, ON, { discontinuationTopics: [] });
    assert.equal(r.state.item?.url, CAP_B.url, "item fora do capped (não renderizado) nunca é escolhido no Stage 2");
  });

  it("mergeUseMelhorPools: capped primeiro, pool sem duplicar URL (www/barra/utm)", () => {
    const merged = mergeUseMelhorPools(CAPPED, {
      use_melhor: [{ ...CAP_A, url: "https://www.a.example.com/guia/?utm_source=x", score: 1 }, POOL_C],
    }) as { use_melhor: Array<{ url: string; score: number }> };
    assert.deepEqual(
      merged.use_melhor.map((i) => i.url),
      [CAP_A.url, CAP_B.url, POOL_C.url],
    );
    assert.equal(merged.use_melhor[0].score, 70, "score do capped vence");
    assert.equal(mergeUseMelhorPools(null, null), null);
    assert.deepEqual((mergeUseMelhorPools(null, FULL) as typeof FULL).use_melhor.length, 3);
  });

  it("readApprovedPoolForUseMelhor: capped ilegível não derruba — usa o pool", () => {
    const dir = tmpEdition();
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), "{ quebrado");
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(FULL));
    const p = readApprovedPoolForUseMelhor(dir) as typeof FULL;
    assert.equal(p.use_melhor.length, 3);
  });
});

// ── (b) swap-destaques --demote-to ──────────────────────────────────────────

const D1 = { rank: 1, score: 90, bucket: "lancamento", url: "https://openai.com/index/launch", title_options: ["Manchete D1"], article: { url: "https://openai.com/index/launch", title: "Introducing X" } };
const D2 = { rank: 2, score: 80, bucket: "radar", url: "https://ex.com/d2", title_options: ["Manchete D2"] };
const D3 = { rank: 3, score: 70, bucket: "radar", url: "https://ex.com/d3", title_options: ["Manchete D3"] };

function approved(): Record<string, unknown> {
  return {
    highlights: [structuredClone(D1), { ...D2 }, { ...D3 }],
    radar: [{ url: "https://ex.com/r1", title: "R1" }],
    lancamento: [{ url: "https://anthropic.com/news/y", title: "L1" }],
  };
}
const NEW = { position: 1 as const, url: "https://nova.example.com/x", title: "Nova X" };

describe("#9869 (b) — swap-destaques --demote-to {bucket}", () => {
  it("REGRESSÃO 261008: --demote-to lancamento põe o rebaixado em lancamento[0] e não no radar", () => {
    const data = approved();
    const r = swapManualInApprovedJson(data, [NEW], false, "lancamento");
    assert.equal(r.ok, true);
    const lanc = data.lancamento as Array<{ url: string; title?: string }>;
    const radar = data.radar as Array<{ url: string }>;
    assert.equal(lanc[0].url, D1.url);
    assert.equal(lanc[0].title, "Introducing X", "item de pool é flat, com o título da fonte (#9381/#9601)");
    assert.equal(lanc.length, 2);
    assert.ok(!radar.some((i) => i.url === D1.url), "nenhuma cópia no radar");
  });

  it("cópia pré-existente da URL em outro bucket sai — item fica em UM bucket (sem duplicata url-bucket)", () => {
    const data = approved();
    (data.radar as unknown[]).push({ url: D1.url + "/", title: "cópia velha" });
    swapManualInApprovedJson(data, [NEW], false, "lancamento");
    const all = ["radar", "lancamento", "use_melhor", "video", "runners_up"].flatMap(
      (b) => ((data[b] as Array<{ url: string }> | undefined) ?? []).map((i) => ({ b, url: i.url.replace(/\/+$/, "") })),
    );
    assert.deepEqual(all.filter((x) => x.url === D1.url).map((x) => x.b), ["lancamento"]);
  });

  it("default sem --demote-to segue radar[0] (comportamento #8995 preservado)", () => {
    const data = approved();
    swapManualInApprovedJson(data, [NEW], false);
    assert.equal((data.radar as Array<{ url: string }>)[0].url, D1.url);
  });

  it("--drop não insere o rebaixado no pool e tira a cópia pré-existente (#9990)", () => {
    const data = approved();
    (data.radar as unknown[]).push({ url: D1.url, title: "cópia" });
    swapManualInApprovedJson(data, [NEW], true, "lancamento");
    assert.equal((data.lancamento as unknown[]).length, 1);
    assert.equal((data.radar as unknown[]).length, 1);
    assert.ok(!(data.radar as Array<{ url: string }>).some((i) => i.url === D1.url));
  });

  it("bucket ausente no JSON é criado", () => {
    const data = approved();
    swapManualInApprovedJson(data, [NEW], false, "use_melhor");
    assert.equal((data.use_melhor as Array<{ url: string }>)[0].url, D1.url);
  });

  it("removeUrlFromPoolBuckets: URL vazia é no-op", () => {
    const data = approved();
    removeUrlFromPoolBuckets(data, "");
    assert.equal((data.radar as unknown[]).length, 1);
  });

  it("parse: --demote-to lancamento; default radar", () => {
    const base = ["--edition", "261008", "--edition-dir", "/tmp/fake", "--d1-url", "https://x.com", "--d1-title", "X"];
    assert.equal(parseSwapDestaquesArgs(base).demoteTo, "radar");
    assert.equal(parseSwapDestaquesArgs([...base, "--demote-to", "lancamento"]).demoteTo, "lancamento");
  });
});
