/**
 * test/fetch-source-text.test.ts (#8595) — sem rede, fetch injetado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToText, slugFromUrl, fetchSourceText, blockedMessage } from "../scripts/fetch-source-text.ts";
import { prefetchHighlightSources } from "../scripts/run-fact-checker.ts";

const HTML = `<!doctype html><html><head><title>T</title><style>p{color:red}</style>
<script>var x = "preço R$ 99";</script></head><body><!-- c -->
<h1>Lançamento &amp; preço</h1><p>O plano custa   R$&nbsp;24,99
por mês.</p><p>Primeira vez&#33;</p></body></html>`;

const mk = (status: number, body = "", ct = "text/html") =>
  (async () => new Response(body, { status, headers: { "content-type": ct } })) as unknown as typeof fetch;

describe("htmlToText", () => {
  it("remove script/style/comentários/tags e normaliza espaços", () => {
    const t = htmlToText(HTML);
    assert.ok(t.includes("Lançamento & preço"));
    assert.ok(t.includes("O plano custa R$ 24,99 por mês."));
    assert.ok(t.includes("Primeira vez!"));
    assert.ok(!t.includes("R$ 99"));
    assert.ok(!t.includes("color:red"));
    assert.ok(!/[<>]/.test(t));
  });
});

describe("slugFromUrl", () => {
  it("gera slug seguro", () => {
    assert.equal(slugFromUrl("https://Example.com/a/b?x=1"), "example-com-a-b");
    assert.equal(slugFromUrl("nao-url"), "source");
  });
});

describe("fetchSourceText", () => {
  it("200 HTML -> texto", async () => {
    const r = await fetchSourceText("https://x.test/a", mk(200, HTML));
    assert.ok(r.ok && r.text.includes("R$ 24,99"));
  });
  it("451 e 403 -> blocked com mensagem clara", async () => {
    for (const s of [451, 403]) {
      const r = await fetchSourceText("https://x.test/a", mk(s));
      assert.ok(!r.ok && r.kind === "blocked" && r.status === s);
      assert.equal(r.message, blockedMessage(s));
      assert.match(r.message, /fonte bloqueada; tente equivalente/);
    }
  });
  it("500 -> error; corpo vazio -> error; rede -> error", async () => {
    const a = await fetchSourceText("https://x.test/a", mk(500));
    assert.ok(!a.ok && a.kind === "error");
    const b = await fetchSourceText("https://x.test/a", mk(200, "<script>1</script>"));
    assert.ok(!b.ok && b.kind === "error");
    const c = await fetchSourceText("https://x.test/a", (async () => { throw new Error("boom"); }) as unknown as typeof fetch);
    assert.ok(!c.ok && /boom/.test(c.message));
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
  it("grava d{N}.txt para sucesso e registra erro (451) sem abortar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcs-"));
    try {
      const f = (async (u: string) =>
        u.includes("bloq") ? new Response("", { status: 451 }) : new Response(HTML, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      const res = await prefetchHighlightSources(
        { highlights: [{ url: "https://a.test/1" }, { url: "https://a.test/bloq" }, { url: "https://a.test/3" }] },
        dir,
        f,
      );
      assert.equal(res.length, 3);
      assert.ok(res[0].path && existsSync(res[0].path));
      assert.match(readFileSync(res[0].path!, "utf8"), /R\$ 24,99/);
      assert.equal(res[1].path, undefined);
      assert.match(res[1].error!, /bloqueada/);
      assert.ok(res[2].path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
