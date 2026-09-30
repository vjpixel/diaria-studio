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
import { isSourcesManifestStale, refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";

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
      assert.equal(isSourcesManifestStale(approved, join(ed, "_internal")), true);

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
      assert.equal(after.sources.find((x) => x.destaque === 2)?.path, join(srcDir(ed), "d2.txt"));
      assert.equal(isSourcesManifestStale(approved, join(ed, "_internal")), false);
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

  it("download falho (451) não é defasagem: --check sai 0 com failed, sem loop", async () => {
    const ed = setup(URLS);
    try {
      const blocking = (async (input: string | URL) =>
        String(input).endsWith("/b")
          ? new Response("", { status: 451 })
          : new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      const r = await refreshDestaqueSources(ed, { fetchImpl: blocking });
      assert.deepEqual(r.failed, [2]);
      assert.equal(r.sources.find((x) => x.destaque === 2)?.path, undefined);
      const chk = await refreshDestaqueSources(ed, { check: true });
      assert.equal(chk.stale_before, false, "mesma URL com download falho = estado final, não defasado");
      assert.deepEqual(chk.failed, [2]);
      const script = join(import.meta.dirname, "..", "scripts", "refresh-destaque-sources.ts");
      const cli = spawnSync(process.execPath, ["--import", "tsx", script, "--edition-dir", ed, "--check"], { encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("wrapper sem url no topo (montagem manual §4d.1b) cai no article.url", async () => {
    const ed = setup(URLS);
    try {
      const approved = {
        highlights: [
          { rank: 1, url: URLS[0], article: { url: URLS[0] } },
          { rank: 2, article: { url: "https://ex.com/so-article" } },
          { rank: 3, url: URLS[2], article: { url: URLS[2] } },
        ],
      };
      writeFileSync(join(ed, "_internal", "01-approved.json"), JSON.stringify(approved), "utf8");
      const calls: string[] = [];
      const r = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls) });
      assert.ok(calls.includes("https://ex.com/so-article"));
      assert.match(readFileSync(join(srcDir(ed), "d2.txt"), "utf8"), /so-article/);
      assert.equal(r.sources.length, 3);
      assert.equal((await refreshDestaqueSources(ed, { check: true })).stale_before, false);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("d{N}.txt apagado com manifest intacto = defasado", async () => {
    const ed = setup(URLS);
    try {
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch([]) });
      rmSync(join(srcDir(ed), "d3.txt"));
      assert.equal((await refreshDestaqueSources(ed, { check: true })).stale_before, true);
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
