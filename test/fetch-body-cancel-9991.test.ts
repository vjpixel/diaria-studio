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
 *
 * #10022 estendeu o guard para os scripts que atribuem `process.exitCode` à
 * mão (antes só os que importam `cli-exit` eram vistos), e fechou duas
 * brechas da heurística: `console.log(res.body)` contava como consumo, e
 * uma leitura do corpo dentro de um `if` anterior calava os `if` seguintes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignsProcessExitCode,
  scanUnconsumedBodyInExitCodeScripts,
  scanUnconsumedFetchBody,
  usesRunCli,
} from "../scripts/lib/process-exit-fetch-scan.ts";
import { fetchSourceText } from "../scripts/fetch-source-text.ts";
import { fetchRss } from "../scripts/fetch-rss.ts";
import { planWave, TransientDashboardError } from "../scripts/clarice-plan-wave.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("guard: corpo de fetch descartado sem cancelar (#9991)", () => {
  it("nenhum script que sai por runCli ou process.exitCode descarta corpo de fetch sem cancelar", () => {
    const v = scanUnconsumedBodyInExitCodeScripts(ROOT);
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

  it("assignsProcessExitCode reconhece a atribuição manual (#10022)", () => {
    assert.equal(assignsProcessExitCode(`process.exitCode = 1;`), true);
    assert.equal(assignsProcessExitCode(`process.exitCode ??= 2;`), true);
    assert.equal(assignsProcessExitCode(`process.exitCode ||= 3;`), true);
    assert.equal(assignsProcessExitCode(`if (process.exitCode === 1) x();`), false);
    assert.equal(assignsProcessExitCode(`const c = process.exitCode;`), false);
  });

  it("clarice-plan-wave (exitCode manual, sem runCli) entra no conjunto varrido (#10022)", () => {
    const src = readFileSync(resolve(ROOT, "scripts/clarice-plan-wave.ts"), "utf8");
    assert.equal(usesRunCli(src), false, "se passou a usar runCli, este caso perdeu o sentido: trocar de exemplo");
    assert.equal(assignsProcessExitCode(src), true);
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

  it("console.log(res.body) não conta como consumo (#10022)", () => {
    assert.deepEqual(
      scan(`const r = await fetch(u);\nconsole.log(r.body);\nreturn r.status;`).map((x) => x.reason),
      ["never-consumed"],
    );
    assert.deepEqual(
      scan(`const res = await fetch(u);\nif (!res.ok) { console.error(res.body); return null; }\nreturn res.json();`).map((x) => x.reason),
      ["exit-without-consume"],
    );
    // `if (res.body)` só inspeciona; o `return` sem ler segue acusado.
    assert.equal(scan(`const res = await fetch(u);\nif (!res.body) return null;\nreturn res.json();`).length, 1);
  });

  it("repassar ou consumir res.body segue valendo como consumo", () => {
    assert.deepEqual(scan(`const res = await fetch(u);\nreturn res.body;`), []);
    assert.deepEqual(scan(`const res = await fetch(u);\nawait pipeline(res.body, out);\nreturn res.status;`), []);
    assert.deepEqual(scan(`const res = await fetch(u);\nconst rd = res.body!.getReader();\nreturn rd;`), []);
    assert.deepEqual(scan(`const res = await fetch(u);\nfor await (const c of res.body) n += c.length;\nreturn n;`), []);
  });

  it("leitura do corpo dentro de um if anterior não cala os if seguintes (#10022)", () => {
    const r = scan(
      `const res = await fetch(u);\n` +
        `if (res.status === 200) { const d = await res.json(); log(d); }\n` +
        `if (!res.ok) return null;\n` +
        `return 1;`,
    );
    assert.deepEqual(r.map((x) => x.reason), ["exit-without-consume"]);
  });

  it("leitura em caminho condicional (&&, ?:, laço, catch) não cala o if seguinte", () => {
    const tail = `\nif (!res.ok) return null;\nreturn 1;`;
    assert.equal(scan(`const res = await fetch(u);\nconst d = flag && (await res.json());` + tail).length, 1);
    assert.equal(scan(`const res = await fetch(u);\nconst d = flag ? await res.text() : "";` + tail).length, 1);
    assert.equal(scan(`const res = await fetch(u);\nfor (const k of ks) await res.text();` + tail).length, 1);
    assert.equal(scan(`const res = await fetch(u);\ntry { x(); } catch { await res.text(); }` + tail).length, 1);
  });

  it("leitura incondicional antes do if (inclusive em try, ou na condição do if externo) cala o if", () => {
    const tail = `\nif (!res.ok) return null;\nreturn 1;`;
    assert.deepEqual(scan(`const res = await fetch(u);\ntry { d = await res.json(); } catch { d = null; }` + tail), []);
    assert.deepEqual(scan(`const res = await fetch(u);\nif ((await res.text()).length > 0) { if (!res.ok) return null; }\nreturn 1;`), []);
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

describe("clarice-plan-wave cancela o corpo de erro do dashboard (#10022)", () => {
  const base = { cycle: "2610-11", dates: ["2026-10-12"], dbPath: "/nao/existe.db", dashboardUrl: "https://dash.example", lockedSubject: null };
  it("429 (transitório) cancela o corpo e lança TransientDashboardError", async () => {
    const t = trackedResponse(429, { "content-type": "application/json" });
    await assert.rejects(planWave({ ...base, fetchImpl: (async () => t.res) as typeof fetch }), TransientDashboardError);
    assert.equal(t.cancelled(), true, "corpo do 429 não cancelado");
  });
  it("500 (estrutural) cancela o corpo e lança", async () => {
    const t = trackedResponse(500, { "content-type": "application/json" });
    await assert.rejects(planWave({ ...base, fetchImpl: (async () => t.res) as typeof fetch }), /falhou \(500\)/);
    assert.equal(t.cancelled(), true, "corpo do 500 não cancelado");
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
