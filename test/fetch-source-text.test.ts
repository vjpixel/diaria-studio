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
import { prefetchHighlightSources } from "../scripts/run-fact-checker.ts";

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
