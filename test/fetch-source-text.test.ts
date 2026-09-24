/**
 * test/fetch-source-text.test.ts (#8595) — sem rede, fetch injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  htmlToText, fetchSourceText, blockedMessage, isForbiddenHost, validateUrl,
} from "../scripts/fetch-source-text.ts";
import {
  prefetchHighlightSources,
  manifestMatchesCurrentUrls,
  readExistingManifest,
  type ManifestEntry,
} from "../scripts/run-fact-checker.ts";

const HTML = `<!doctype html><html><head><title>T</title><style>p{color:red}</style>
<script>var x = "preço R$ 99";</script></head><body><!-- c --><nav>MENU</nav>
<h1>Lançamento &amp; preço</h1><p>O plano custa   R$&nbsp;24,99
por mês.</p><p>Primeira vez&#33;</p><footer>RODAPE</footer></body></html>`;

const mk = (status: number, body: BodyInit = "", ct = "text/html") =>
  (async () => new Response(body, { status, headers: { "content-type": ct } })) as unknown as typeof fetch;

describe("htmlToText", () => {
  it("remove script/style/nav/footer/comentários/tags e normaliza espaços", () => {
    const t = htmlToText(HTML);
    assert.ok(t.includes("Lançamento & preço"));
    assert.ok(t.includes("O plano custa R$ 24,99 por mês."));
    assert.ok(t.includes("Primeira vez!"));
    for (const bad of ["R$ 99", "color:red", "MENU", "RODAPE"]) assert.ok(!t.includes(bad), bad);
    assert.ok(!/[<>]/.test(t));
  });
  it("entidade numérica inválida não lança", () => {
    const t = htmlToText("<p>a&#1114112;b&#x110000;c&#55296;d</p>");
    assert.match(t, /^a.b.c.d$/);
  });
});

describe("isForbiddenHost / validateUrl", () => {
  it("bloqueia loopback, privados, link-local, localhost, IPv6", () => {
    for (const h of ["localhost", "a.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.9.9",
      "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "[::1]", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      assert.ok(isForbiddenHost(h), h);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1"]) assert.ok(!isForbiddenHost(h), h);
  });
  it("rejeita esquema não http(s)", () => {
    assert.ok(validateUrl("file:///etc/passwd"));
    assert.ok(validateUrl("ftp://x.test"));
    assert.equal(validateUrl("https://x.test/a"), null);
  });
});

describe("fetchSourceText", () => {
  it("200 HTML -> texto", async () => {
    const r = await fetchSourceText("https://x.test/a", mk(200, HTML));
    assert.ok(r.ok && r.text.includes("R$ 24,99") && r.bytes > 0);
  });
  it("401/403/429/451 -> blocked", async () => {
    for (const s of [401, 403, 429, 451]) {
      const r = await fetchSourceText("https://x.test/a", mk(s));
      assert.ok(!r.ok && r.kind === "blocked" && r.status === s);
      assert.equal(r.message, blockedMessage(s));
    }
  });
  it("500 / corpo vazio / rede -> error", async () => {
    const a = await fetchSourceText("https://x.test/a", mk(500));
    assert.ok(!a.ok && a.kind === "error");
    const b = await fetchSourceText("https://x.test/a", mk(200, "<script>1</script>"));
    assert.ok(!b.ok && b.kind === "error");
    const c = await fetchSourceText("https://x.test/a", (async () => { throw new Error("boom"); }) as unknown as typeof fetch);
    assert.ok(!c.ok && /boom/.test(c.message));
  });
  it("content-type binário (PDF) rejeitado", async () => {
    const r = await fetchSourceText("https://x.test/a.pdf", mk(200, "%PDF-1.4", "application/pdf"));
    assert.ok(!r.ok && /não textual/.test(r.message));
  });
  it("decodifica ISO-8859-1 via charset", async () => {
    const body = new Uint8Array([0x3c, 0x70, 0x3e, 0x61, 0xe7, 0xe3, 0x6f, 0x3c, 0x2f, 0x70, 0x3e]); // <p>ação</p>
    const r = await fetchSourceText("https://x.test/a", mk(200, body, "text/html; charset=ISO-8859-1"));
    assert.ok(r.ok && r.text === "ação");
  });
  it("redirect para IP privado é bloqueado (e não é seguido)", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest" } });
    }) as unknown as typeof fetch;
    const r = await fetchSourceText("https://x.test/a", f);
    assert.ok(!r.ok && /host proibido/.test(r.message));
    assert.equal(calls, 1);
  });
  it("redirect público é seguido; loop excede o limite", async () => {
    let n = 0;
    const ok = (async () =>
      n++ === 0
        ? new Response("", { status: 301, headers: { location: "/b" } })
        : new Response("<p>fim</p>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await fetchSourceText("https://x.test/a", ok);
    assert.ok(r.ok && r.text === "fim");
    const loop = (async () => new Response("", { status: 302, headers: { location: "/a" } })) as unknown as typeof fetch;
    const l = await fetchSourceText("https://x.test/a", loop);
    assert.ok(!l.ok && /redirects/.test(l.message));
  });
  it("URL inicial proibida nem chama fetch", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response(""); }) as unknown as typeof fetch;
    const r = await fetchSourceText("http://localhost:8080/x", f);
    assert.ok(!r.ok);
    assert.equal(called, false);
  });
  it("envia User-Agent de navegador", async () => {
    let ua = "";
    const f = (async (_u: string, init: RequestInit) => {
      ua = (init.headers as Record<string, string>)["User-Agent"];
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    await fetchSourceText("https://x.test/a", f);
    assert.match(ua, /Mozilla/);
  });
});

describe("prefetchHighlightSources", () => {
  it("grava d{N}.txt + manifest, registra 451 sem abortar, remove arquivo velho", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-"));
    try {
      const srcDir = join(dir, "fact-check-sources");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, "d2.txt"), "VELHO", "utf8");
      writeFileSync(join(srcDir, "d3.txt"), "VELHO3", "utf8");
      const f = (async (u: string) =>
        u.includes("bloq") ? new Response("", { status: 451 }) : new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      const res = await prefetchHighlightSources(
        { highlights: [{ url: "https://a.test/1" }, { url: "https://a.test/bloq" }] },
        dir,
        f,
      );
      assert.equal(res.length, 2);
      assert.match(readFileSync(res[0].path!, "utf8"), /R\$ 24,99/);
      assert.equal(res[1].path, undefined);
      assert.match(res[1].error!, /bloqueada/);
      assert.equal(existsSync(join(srcDir, "d2.txt")), false, "d2 velho removido");
      assert.equal(existsSync(join(srcDir, "d3.txt")), false, "d3 velho removido");
      const m = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8"));
      assert.equal(m.length, 2);
      assert.equal(m[0].status, "ok");
      assert.ok(m[0].bytes > 0 && m[0].fetched_at && m[0].url === "https://a.test/1");
      assert.equal(m[1].status, "blocked");
      assert.match(m[1].erro, /451/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #8782: regressão — URLs de destaque mudadas (ex: "ajustar" no gate promove
  // itens do RADAR trocando D1/D2/D3) DEVEM invalidar o cache e refazer o
  // fetch, nunca servir ao fact-checker o texto bruto da história ERRADA.
  it("#8782 — manifest com URLs ANTIGAS + destaques com URLs NOVAS invalida o cache e refaz o fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-stale-"));
    try {
      const srcDir = join(dir, "fact-check-sources");
      mkdirSync(srcDir, { recursive: true });
      // Estado "pós-Stage 4 antigo": manifest + d{N}.txt de uma rodada anterior,
      // cujas URLs não são mais as dos destaques atuais.
      writeFileSync(join(srcDir, "d1.txt"), "TEXTO DA HISTÓRIA ERRADA (destaque antigo)", "utf8");
      const staleManifest: ManifestEntry[] = [
        {
          destaque: 1,
          url: "https://old.test/destaque-antigo",
          status: "ok",
          erro: null,
          bytes: 42,
          fetched_at: "2026-09-20T10:00:00.000Z",
        },
      ];
      writeFileSync(join(srcDir, "manifest.json"), JSON.stringify(staleManifest, null, 2), "utf8");

      let fetchCalls = 0;
      const f = (async () => {
        fetchCalls++;
        return new Response("TEXTO DA HISTÓRIA CERTA (destaque novo)", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }) as unknown as typeof fetch;

      // 01-approved.json já reflete o destaque NOVO (editor já ajustou no gate).
      const res = await prefetchHighlightSources(
        { highlights: [{ url: "https://new.test/destaque-novo" }] },
        dir,
        f,
      );

      assert.equal(fetchCalls, 1, "URL divergente deve disparar refetch de verdade, não reusar o cache");
      assert.equal(res.length, 1);
      assert.equal(res[0].url, "https://new.test/destaque-novo");
      assert.match(readFileSync(res[0].path!, "utf8"), /HISTÓRIA CERTA/);
      assert.doesNotMatch(readFileSync(res[0].path!, "utf8"), /HISTÓRIA ERRADA/);

      const m = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8"));
      assert.equal(m.length, 1);
      assert.equal(m[0].url, "https://new.test/destaque-novo", "manifest deve ser regravado com a URL nova");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#8782 — manifest com as MESMAS URLs (status ok) reusa o cache sem tocar rede", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-fresh-"));
    try {
      const srcDir = join(dir, "fact-check-sources");
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, "d1.txt"), "TEXTO JÁ BAIXADO", "utf8");
      const freshManifest: ManifestEntry[] = [
        {
          destaque: 1,
          url: "https://same.test/destaque",
          status: "ok",
          erro: null,
          bytes: 100,
          fetched_at: "2026-09-24T10:00:00.000Z",
        },
      ];
      writeFileSync(join(srcDir, "manifest.json"), JSON.stringify(freshManifest, null, 2), "utf8");

      let fetchCalls = 0;
      const f = (async () => {
        fetchCalls++;
        return new Response("NUNCA DEVERIA CHEGAR AQUI", { status: 200 });
      }) as unknown as typeof fetch;

      const res = await prefetchHighlightSources(
        { highlights: [{ url: "https://same.test/destaque" }] },
        dir,
        f,
      );

      assert.equal(fetchCalls, 0, "URL igual + status ok não deve refazer o fetch");
      assert.equal(res.length, 1);
      assert.equal(res[0].path, join(srcDir, "d1.txt"));
      assert.equal(readFileSync(res[0].path!, "utf8"), "TEXTO JÁ BAIXADO", "conteúdo em disco preservado, não sobrescrito");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#8782 — manifest com URL igual mas .txt ausente do disco não reusa (refaz o fetch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-missingfile-"));
    try {
      const srcDir = join(dir, "fact-check-sources");
      mkdirSync(srcDir, { recursive: true });
      // manifest existe, mas d1.txt nunca foi escrito (ou foi apagado à mão).
      const manifestOnly: ManifestEntry[] = [
        {
          destaque: 1,
          url: "https://same.test/destaque",
          status: "ok",
          erro: null,
          bytes: 100,
          fetched_at: "2026-09-24T10:00:00.000Z",
        },
      ];
      writeFileSync(join(srcDir, "manifest.json"), JSON.stringify(manifestOnly, null, 2), "utf8");

      let fetchCalls = 0;
      const f = (async () => {
        fetchCalls++;
        return new Response("REFETCHED", { status: 200, headers: { "content-type": "text/plain" } });
      }) as unknown as typeof fetch;

      const res = await prefetchHighlightSources(
        { highlights: [{ url: "https://same.test/destaque" }] },
        dir,
        f,
      );

      assert.equal(fetchCalls, 1, "manifest sem o .txt correspondente não é cache válido");
      assert.equal(readFileSync(res[0].path!, "utf8"), "REFETCHED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#8782 — manifest com status blocked/error nunca é reusado, mesmo com URL igual", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-retry-"));
    try {
      const srcDir = join(dir, "fact-check-sources");
      mkdirSync(srcDir, { recursive: true });
      const blockedManifest: ManifestEntry[] = [
        {
          destaque: 1,
          url: "https://same.test/destaque",
          status: "blocked",
          erro: "HTTP 429",
          bytes: 0,
          fetched_at: "2026-09-24T10:00:00.000Z",
        },
      ];
      writeFileSync(join(srcDir, "manifest.json"), JSON.stringify(blockedManifest, null, 2), "utf8");

      let fetchCalls = 0;
      const f = (async () => {
        fetchCalls++;
        return new Response("AGORA DISPONÍVEL", { status: 200, headers: { "content-type": "text/plain" } });
      }) as unknown as typeof fetch;

      const res = await prefetchHighlightSources(
        { highlights: [{ url: "https://same.test/destaque" }] },
        dir,
        f,
      );

      assert.equal(fetchCalls, 1, "entrada blocked/error deve ser tentada de novo, nunca 'cacheada' como falha permanente");
      assert.equal(readFileSync(res[0].path!, "utf8"), "AGORA DISPONÍVEL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manifestMatchesCurrentUrls / readExistingManifest (#8782)", () => {
  it("manifest ausente → não bate (força refetch)", () => {
    assert.equal(manifestMatchesCurrentUrls(null, ["https://a.test/1"]), false);
  });

  it("mesma URL, mesma posição, status ok → bate", () => {
    const m: ManifestEntry[] = [
      { destaque: 1, url: "https://a.test/1", status: "ok", erro: null, bytes: 1, fetched_at: "x" },
      { destaque: 2, url: "https://a.test/2", status: "ok", erro: null, bytes: 1, fetched_at: "x" },
    ];
    assert.equal(manifestMatchesCurrentUrls(m, ["https://a.test/1", "https://a.test/2"]), true);
  });

  it("URL divergente numa posição → não bate", () => {
    const m: ManifestEntry[] = [
      { destaque: 1, url: "https://a.test/1", status: "ok", erro: null, bytes: 1, fetched_at: "x" },
    ];
    assert.equal(manifestMatchesCurrentUrls(m, ["https://a.test/OUTRA"]), false);
  });

  it("contagem de destaques diferente (2→3 ou 3→2) → não bate", () => {
    const m: ManifestEntry[] = [
      { destaque: 1, url: "https://a.test/1", status: "ok", erro: null, bytes: 1, fetched_at: "x" },
      { destaque: 2, url: "https://a.test/2", status: "ok", erro: null, bytes: 1, fetched_at: "x" },
    ];
    assert.equal(manifestMatchesCurrentUrls(m, ["https://a.test/1"]), false);
    assert.equal(
      manifestMatchesCurrentUrls(m, ["https://a.test/1", "https://a.test/2", "https://a.test/3"]),
      false,
    );
  });

  it("status não-ok (blocked/error) → não bate, mesmo com URL igual", () => {
    const m: ManifestEntry[] = [
      { destaque: 1, url: "https://a.test/1", status: "error", erro: "boom", bytes: 0, fetched_at: "x" },
    ];
    assert.equal(manifestMatchesCurrentUrls(m, ["https://a.test/1"]), false);
  });

  it("readExistingManifest: diretório sem manifest.json → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-readmanifest-"));
    try {
      assert.equal(readExistingManifest(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readExistingManifest: JSON malformado → null (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-readmanifest-bad-"));
    try {
      writeFileSync(join(dir, "manifest.json"), "{ isso não é um array", "utf8");
      assert.equal(readExistingManifest(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run-fact-checker CLI: --dry-run/--input-json não tocam a rede", () => {
  it("não criam fact-check-sources", () => {
    const ed = mkdtempSync(join(tmpdir(), "fced-"));
    try {
      mkdirSync(join(ed, "_internal"), { recursive: true });
      writeFileSync(join(ed, "02-reviewed.md"), "DESTAQUE 1\nR$ 99\n");
      writeFileSync(join(ed, "03-social.md"), "# LinkedIn\n");
      writeFileSync(join(ed, "_internal", "01-approved.json"), JSON.stringify({ highlights: [{ url: "https://example.invalid/x" }] }));
      const dry = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-fact-checker.ts", "--edition-dir", ed, "--dry-run"], { encoding: "utf8" });
      assert.equal(dry.status, 0, dry.stderr);
      const input = join(ed, "in.json");
      writeFileSync(input, JSON.stringify({ claims: [] }));
      const inj = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-fact-checker.ts", "--edition-dir", ed, "--input-json", input], { encoding: "utf8" });
      assert.equal(inj.status, 0, inj.stderr);
      assert.equal(existsSync(join(ed, "_internal", "fact-check-sources")), false);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});
