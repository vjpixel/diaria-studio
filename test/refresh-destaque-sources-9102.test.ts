/**
 * Regressão #9102 — troca/promoção de destaque no gate 4 deixava
 * `fact-check-sources/manifest.json` + `d{N}.txt` com o texto do destaque
 * ANTIGO, e o writer-destaque sem texto-fonte do artigo novo.
 *
 * Cenário: fontes pré-baixadas para D1/D2/D3, depois a URL de highlights[1]
 * (D2) é trocada em 01-approved.json (substituição §4d.1b). O refresh tem de
 * detectar a defasagem, invalidar o manifest e regenerar d2.txt com o texto
 * do artigo novo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isSourcesCacheStale, refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";

const URLS = ["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"];

function fakeFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL) => {
    const u = String(input);
    calls.push(u);
    return new Response(`<p>TEXTO DE ${u}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

function setup(urls: string[]): string {
  const editionDir = mkdtempSync(join(tmpdir(), "refresh-src-9102-"));
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeApproved(editionDir, urls);
  return editionDir;
}

function writeApproved(editionDir: string, urls: string[]): void {
  const approved = {
    highlights: urls.map((url, i) => ({ rank: i + 1, url, article: { url, title: `t${i}` } })),
    radar: [],
  };
  writeFileSync(join(editionDir, "_internal", "01-approved.json"), JSON.stringify(approved), "utf8");
}

const srcDir = (ed: string) => join(ed, "_internal", "fact-check-sources");

describe("refresh-destaque-sources (#9102)", () => {
  it("trocar a URL de highlights[1] invalida o manifest e regenera d2.txt", async () => {
    const ed = setup(URLS);
    try {
      const calls: string[] = [];
      const first = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls) });
      assert.equal(first.stale_before, true, "sem manifest = defasado");
      assert.equal(calls.length, 3);
      assert.match(readFileSync(join(srcDir(ed), "d2.txt"), "utf8"), /ex\.com\/b/);

      // Sem troca: cache reusado, nenhuma rede.
      const again = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls) });
      assert.equal(again.stale_before, false);
      assert.equal(again.refetched, false);
      assert.equal(calls.length, 3);

      // Promoção §4d.1b: D2 substituído por item do pool.
      const newUrl = "https://ex.com/promovido";
      writeApproved(ed, [URLS[0], newUrl, URLS[2]]);
      const approved = JSON.parse(readFileSync(join(ed, "_internal", "01-approved.json"), "utf8"));
      assert.equal(isSourcesCacheStale(approved, join(ed, "_internal")), true);

      const after = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls) });
      assert.equal(after.stale_before, true);
      assert.equal(after.refetched, true);
      assert.ok(calls.includes(newUrl), "fonte do destaque novo foi baixada");
      const d2 = readFileSync(join(srcDir(ed), "d2.txt"), "utf8");
      assert.match(d2, /promovido/);
      assert.doesNotMatch(d2, /ex\.com\/b/, "texto do destaque antigo não sobrevive");
      const manifest = JSON.parse(readFileSync(join(srcDir(ed), "manifest.json"), "utf8"));
      assert.equal(manifest[1].url, newUrl);
      assert.equal(manifest[1].status, "ok");
      assert.equal(after.sources[1].path, join(srcDir(ed), "d2.txt"));
      assert.equal(isSourcesCacheStale(approved, join(ed, "_internal")), false);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("--check sai 3 quando defasado e não toca o disco", async () => {
    const ed = setup(URLS);
    try {
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch([]) });
      writeApproved(ed, [URLS[0], URLS[1], "https://ex.com/outro"]);
      const script = join(import.meta.dirname, "..", "scripts", "refresh-destaque-sources.ts");
      const r = spawnSync(process.execPath, ["--import", "tsx", script, "--edition-dir", ed, "--check"], {
        encoding: "utf8",
      });
      assert.equal(r.status, 3, r.stderr);
      assert.equal(JSON.parse(r.stdout).stale_before, true);
      // manifest antigo intacto (check é read-only)
      const manifest = JSON.parse(readFileSync(join(srcDir(ed), "manifest.json"), "utf8"));
      assert.equal(manifest[2].url, URLS[2]);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("01-approved.json ausente lança erro", async () => {
    const ed = mkdtempSync(join(tmpdir(), "refresh-src-9102-"));
    try {
      await assert.rejects(() => refreshDestaqueSources(ed), /01-approved\.json/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});
