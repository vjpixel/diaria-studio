/**
 * #9991: regressão da migração #9911. `process.exit()` matava o socket de um
 * `fetch` cujo corpo ninguém leu; com `runCli`/`process.exitCode` o processo
 * só sai quando o loop esvazia, e o corpo pendente o segura até o servidor
 * fechar ou um timeout abortar. Todo caminho que descarta a resposta precisa
 * de `await res.body?.cancel().catch(() => {})`.
 *
 * O teste trava:
 *  1. o guard de conjunto: nenhum script que sai por `runCli` tem fetch com
 *     corpo descartado sem cancelar (scanner em process-exit-fetch-scan.ts);
 *  2. a heurística do scanner (o que conta e o que não conta);
 *  3. o comportamento real nos dois scripts citados na issue
 *     (fetch-source-text e fetch-rss): o stream do corpo é cancelado em cada
 *     caminho de descarte.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanUnconsumedBodyInRunCliScripts,
  scanUnconsumedFetchBody,
  usesRunCli,
} from "../scripts/lib/process-exit-fetch-scan.ts";
import { fetchSourceText } from "../scripts/fetch-source-text.ts";
import { fetchRss } from "../scripts/fetch-rss.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("guard: corpo de fetch descartado sem cancelar (#9991)", () => {
  it("nenhum script que sai por runCli descarta corpo de fetch sem cancelar", () => {
    const v = scanUnconsumedBodyInRunCliScripts(ROOT);
    assert.deepEqual(
      v.map((x) => `${x.file}:${x.line} ${x.name} ${x.reason}`),
      [],
      "adicione `await res.body?.cancel().catch(() => {})` antes de sair sem ler o corpo",
    );
  });

  it("usesRunCli reconhece o import do helper", () => {
    assert.equal(usesRunCli(`import { runCli } from "./lib/cli-exit.ts";`), true);
    assert.equal(usesRunCli(`import { x } from "./lib/cli-args.ts";`), false);
  });
});

describe("scanUnconsumedFetchBody (#9991)", () => {
  const scan = (body: string) => scanUnconsumedFetchBody(`async function f(u: string) {\n${body}\n}`);

  it("acusa `if (!res.ok) return` sem cancelar", () => {
    const r = scan(`const res = await fetch(u);\nif (!res.ok) return null;\nreturn await res.json();`);
    assert.deepEqual(r.map((x) => x.reason), ["exit-without-consume"]);
  });

  it("acusa throw, continue e o 429 com retry sem cancelar", () => {
    assert.equal(scan(`const res = await fetch(u);\nif (!res.ok) throw new Error("x");\nreturn res.text();`).length, 1);
    assert.equal(
      scan(`for (const k of []) { const res = await fetch(u); if (res.status === 404) continue; await res.text(); }`).length,
      1,
    );
    assert.equal(
      scan(`const res = await fetchImpl(u);\nif (res.status === 429) { await sleep(1); return f(u); }\nreturn res.json();`).length,
      1,
    );
  });

  it("acusa resposta cujo corpo nunca é lido (só status)", () => {
    const r = scan(`const r = await fetch(u, { method: "GET" });\nreturn { ok: r.ok, status: r.status };`);
    assert.deepEqual(r.map((x) => x.reason), ["never-consumed"]);
  });

  it("aceita o cancel no ramo de saída", () => {
    assert.deepEqual(
      scan(`const res = await fetch(u);\nif (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }\nreturn res.json();`),
      [],
    );
  });

  it("aceita 404 aninhado depois do cancel no ramo de erro", () => {
    assert.deepEqual(
      scan(
        `const res = await fetch(u);\nif (!res.ok) { await res.body?.cancel().catch(() => {}); if (res.status === 404) return null; throw new Error("x"); }\nreturn res.text();`,
      ),
      [],
    );
  });

  it("aceita corpo já lido antes do if, ou lido/repassado dentro do ramo", () => {
    assert.deepEqual(scan(`const res = await fetch(u);\nconst d = await res.json();\nif (!res.ok) return d;\nreturn d;`), []);
    assert.deepEqual(scan(`const res = await fetch(u);\nif (!res.ok) throw new Error(await res.text());\nreturn res.json();`), []);
    assert.deepEqual(scan(`const res = await fetch(u);\nif (!res.ok) return handle(res);\nreturn res.json();`), []);
  });

  it("ignora HEAD (sem corpo) e fetch que não é o global", () => {
    assert.deepEqual(scan(`const res = await fetch(u, { method: "HEAD" });\nreturn res.status;`), []);
    assert.deepEqual(scan(`const res = await env.ASSETS.fetch(u);\nif (!res.ok) return null;\nreturn 1;`), []);
  });

  it("variáveis homônimas em blocos irmãos são independentes", () => {
    const r = scan(
      `{ const res = await fetch(u, { method: "HEAD" }); if (res.status >= 400) return 1; }\n` +
        `{ const res = await fetch(u); await res.body?.cancel().catch(() => {}); return res.status; }`,
    );
    assert.deepEqual(r, []);
  });
});

/** Response com stream que registra o cancel (corpo nunca termina sozinho). */
function trackedResponse(status: number, headers: Record<string, string>): { res: Response; cancelled: () => boolean } {
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      ctrl.enqueue(new Uint8Array(1024));
    },
    cancel() {
      wasCancelled = true;
    },
  });
  return { res: new Response(stream, { status, headers }), cancelled: () => wasCancelled };
}

describe("fetch-source-text cancela o corpo descartado (#9991)", () => {
  const cases: Array<[string, number, Record<string, string>, string]> = [
    ["conteúdo não textual (PDF)", 200, { "content-type": "application/pdf" }, "conteúdo não textual"],
    ["status bloqueado", 403, { "content-type": "text/html" }, "bloqueada"],
    ["!res.ok", 500, { "content-type": "text/html" }, "HTTP 500"],
  ];
  for (const [name, status, headers, msg] of cases) {
    it(name, async () => {
      const t = trackedResponse(status, headers);
      const r = await fetchSourceText("https://example.com/x", (async () => t.res) as typeof fetch);
      assert.equal(r.ok, false);
      assert.match((r as { message: string }).message, new RegExp(msg));
      assert.equal(t.cancelled(), true, "corpo não cancelado");
    });
  }

  it("cada salto 3xx cancela o corpo do redirect", async () => {
    const hops = [trackedResponse(302, { location: "https://example.com/y" }), trackedResponse(500, {})];
    let i = 0;
    const r = await fetchSourceText("https://example.com/x", (async () => hops[i++].res) as typeof fetch);
    assert.equal(r.ok, false);
    assert.equal(hops[0].cancelled(), true, "salto 3xx não cancelado");
    assert.equal(hops[1].cancelled(), true, "resposta final não cancelada");
  });
});

describe("fetch-rss cancela o corpo de erro (#9991)", () => {
  it("!res.ok cancela o corpo", async () => {
    const t = trackedResponse(503, { "content-type": "text/html" });
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => t.res) as typeof fetch;
    try {
      const r = await fetchRss({ url: "https://example.com/feed", sourceName: "x" });
      assert.equal(r.error, "HTTP 503");
      assert.equal(t.cancelled(), true);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
