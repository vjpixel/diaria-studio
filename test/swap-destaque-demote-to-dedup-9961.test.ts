/**
 * test/swap-destaque-demote-to-dedup-9961.test.ts (#9961)
 *
 * Regressão: `swap-destaque.ts --promote radar:N --demote d3 --demote-to radar`
 * quando o D3 rebaixado veio originalmente do bucket `lancamento` — o wrapper
 * do destaque nunca tirou o `article` de lá, então o item ficava em
 * `lancamento` E `radar` de `01-approved.json`/`01-approved-capped.json`, e o
 * `url-bucket` do gate do Stage 4 acusava `found_in_bucket: duplicate`
 * (achado na edição 261009).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  swapInApprovedJson,
  mirrorCappedSwapFallback,
  buildSwapDestaqueSteps,
  urlBucketDuplicateWarnings,
  removeUrlFromPoolBuckets,
} from "../scripts/swap-destaque.ts";
import { removeUrlFromPoolBuckets as reexported } from "../scripts/swap-destaques.ts";
import { lintNewsletter, type ApprovedJson } from "../scripts/lib/lint-checks/url-bucket.ts";

const D3_URL = "https://vendor.example/blog/launch-x";

/** Edição fixture: o D3 é um lançamento oficial cujo `article` continua em `lancamento[]`. */
function fixture(): Record<string, unknown> {
  const d3Article = { url: D3_URL, title: "Vendor lança X", category: "lancamento", score: 70 };
  return {
    highlights: [
      { rank: 1, score: 90, bucket: "radar", url: "https://a.example/d1", article: { url: "https://a.example/d1", title: "D1" } },
      { rank: 2, score: 85, bucket: "radar", url: "https://a.example/d2", article: { url: "https://a.example/d2", title: "D2" } },
      { rank: 3, score: 80, bucket: "lancamento", url: D3_URL, article: { ...d3Article, title_options: ["Manchete D3"] } },
    ],
    lancamento: [d3Article, { url: "https://other.example/launch-y", title: "Y" }],
    radar: [{ url: "https://news.example/r0", title: "Notícia R0" }, { url: "https://news.example/r1", title: "R1" }],
    use_melhor: [],
    video: [],
    runners_up: [],
  };
}

function urls(list: unknown): string[] {
  return (list as Array<{ url: string }>).map((x) => x.url);
}

function duplicates(data: Record<string, unknown>) {
  return lintNewsletter("", data as ApprovedJson).errors.filter((e) => e.found_in_bucket === "duplicate");
}

describe("#9961 — --demote-to ≠ bucket de origem não duplica a URL", () => {
  it("fixture reproduz o bug: o url-bucket acusa a duplicata se a cópia de lancamento ficar", () => {
    const data = fixture();
    // estado que o código antigo deixava: D3 fora de highlights, prepend no
    // radar sem limpar lancamento
    data.highlights = (data.highlights as unknown[]).slice(0, 2);
    (data.radar as unknown[]).unshift({ url: D3_URL, title: "Vendor lança X" });
    const dups = duplicates(data);
    assert.equal(dups.length, 1);
    assert.deepEqual([...(dups[0].duplicate_buckets ?? [])].sort(), ["lancamento", "radar"]);
  });

  it("swapInApprovedJson remove o D3 de lancamento ao demover pra radar", () => {
    const data = fixture();
    const r = swapInApprovedJson(data, "radar", 0, 2, false, "radar");
    assert.equal(r.ok, true);
    assert.deepEqual(urls(data.lancamento), ["https://other.example/launch-y"]);
    assert.equal(urls(data.radar)[0], D3_URL);
    assert.equal(urls(data.radar).filter((u) => u === D3_URL).length, 1);
    assert.deepEqual(duplicates(data), []);
  });

  it("demover pro MESMO bucket de origem não deixa 2 cópias no bucket", () => {
    const data = fixture();
    const r = swapInApprovedJson(data, "radar", 0, 2, false, "lancamento");
    assert.equal(r.ok, true);
    assert.deepEqual(urls(data.lancamento), [D3_URL, "https://other.example/launch-y"]);
  });

  it("--drop não mexe nos buckets além do promovido (comportamento preservado)", () => {
    const data = fixture();
    swapInApprovedJson(data, "radar", 0, 2, true, "radar");
    assert.deepEqual(urls(data.lancamento), [D3_URL, "https://other.example/launch-y"]);
  });

  it("mirrorCappedSwapFallback (capped sem o bucket do promovido) também limpa a cópia", () => {
    const capped = fixture();
    delete capped.radar; // força o fallback: bucket do promovido ausente no capped
    const promoted = { url: "https://news.example/r0", title: "Notícia R0" };
    const r = mirrorCappedSwapFallback(capped, "radar", 2, false, promoted, "radar");
    assert.equal(r.synced, true);
    assert.deepEqual(urls(capped.lancamento), ["https://other.example/launch-y"]);
    assert.deepEqual(urls(capped.radar), [D3_URL]);
    assert.deepEqual(duplicates(capped), []);
  });

  it("removeUrlFromPoolBuckets ignora barra final e não toca highlights; swap-destaques re-exporta a mesma função", () => {
    const data = fixture();
    removeUrlFromPoolBuckets(data, D3_URL + "/");
    assert.deepEqual(urls(data.lancamento), ["https://other.example/launch-y"]);
    assert.equal((data.highlights as unknown[]).length, 3);
    assert.equal(reexported, removeUrlFromPoolBuckets);
  });

  it("urlBucketDuplicateWarnings acusa duplicata pré-existente e fica vazio no estado limpo", () => {
    const dirty = fixture();
    dirty.highlights = (dirty.highlights as unknown[]).slice(0, 2);
    (dirty.radar as unknown[]).unshift({ url: D3_URL, title: "x" });
    const w = urlBucketDuplicateWarnings("", dirty, "01-approved.json");
    assert.equal(w.length, 1);
    assert.match(w[0], /#9961/);
    assert.match(w[0], /01-approved\.json/);
    assert.deepEqual(urlBucketDuplicateWarnings("", fixture(), "01-approved.json"), []);
  });

  it("rerenders_needed manda conferir o url-bucket depois de incluir o rebaixado no MD", () => {
    const steps = buildSwapDestaqueSteps("/ed/261009", 3, "Notícia R0", "radar");
    const i = steps.findIndex((s) => s.includes("Incluir o destaque rebaixado"));
    assert.ok(i >= 0);
    assert.match(steps[i + 1], /url-bucket/);
    assert.match(steps[i + 1], /lint-newsletter-md\.ts --md \/ed\/261009\/02-reviewed\.md --approved/);
    assert.ok(!buildSwapDestaqueSteps("/ed/261009", 3, "t", null).some((s) => s.includes("url-bucket")));
  });
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "swap-destaque.ts");

describe("#9961 — CLI e2e: --promote radar:0 --demote d3 --demote-to radar", () => {
  it("as 2 approved saem sem a cópia em lancamento e sem aviso de duplicata", () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-9961-"));
    try {
      const internal = join(dir, "_internal");
      mkdirSync(internal, { recursive: true });
      writeFileSync(join(internal, "01-approved.json"), JSON.stringify(fixture(), null, 2));
      writeFileSync(join(internal, "01-approved-capped.json"), JSON.stringify(fixture(), null, 2));
      const stdout = execFileSync(
        "npx",
        ["tsx", SCRIPT, "--edition", "261009", "--edition-dir", dir, "--promote", "radar:0", "--demote", "d3", "--demote-to", "radar"],
        { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      const result = JSON.parse(stdout);
      for (const f of ["01-approved.json", "01-approved-capped.json"]) {
        const data = JSON.parse(readFileSync(join(internal, f), "utf8"));
        assert.deepEqual(urls(data.lancamento), ["https://other.example/launch-y"], f);
        assert.equal(urls(data.radar)[0], D3_URL, f);
        assert.deepEqual(duplicates(data), [], f);
      }
      assert.ok(!result.rerenders_needed.some((s: string) => s.includes("CORRIGIR ANTES DO GATE")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
