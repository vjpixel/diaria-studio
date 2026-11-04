/**
 * #11412 (passos 2 e 3 da ativação): `scripts/probe-public-images-r2.ts`
 * sobe um objeto de teste pelo uploader da edição e confere o GET nos dois
 * Workers. Tudo com fetch falso, sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brtAammdd, probeImageKey, runProbe, servedImageProblems } from "../scripts/probe-public-images-r2.ts";
import { r2KeyForImageKey } from "../scripts/lib/shared/kv-image.ts";

const CONFIG = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "diaria-shorts", publicBase: "https://media.diar.ia.br" };
const BODY = Buffer.from("probe-bytes");

function headers(h: Record<string, string>) {
  return { get: (n: string) => h[n.toLowerCase()] ?? null };
}

function fakeFetch(getResponse: (url: string) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = async (u: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: u, method });
    if (method === "PUT") return new Response("", { status: 200 });
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(BODY.length) } });
    return getResponse(u);
  };
  return { fetch, calls };
}

describe("#11412 probeImageKey", () => {
  it("é content-addressed e mapeia para img/{AAMMDD}/ no R2", () => {
    const key = probeImageKey("261104", BODY);
    assert.match(key, /^img-261104-r2-probe-[0-9a-f]{8}\.jpg$/);
    assert.equal(r2KeyForImageKey(key), key.replace(/^img-261104-/, "img/261104/"));
  });
  it("recusa edição fora de AAMMDD", () => {
    assert.throws(() => probeImageKey("2611", BODY), /AAMMDD/);
  });
});

describe("#11412 brtAammdd", () => {
  it("usa o fuso de São Paulo (01:00 UTC ainda é o dia anterior)", () => {
    assert.equal(brtAammdd(new Date("2026-11-05T01:00:00Z")), "261104");
    assert.equal(brtAammdd(new Date("2026-11-05T12:00:00Z")), "261105");
  });
});

describe("#11412 servedImageProblems", () => {
  const good = headers({ "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" });
  it("resposta certa não tem problema", () => {
    assert.deepEqual(servedImageProblems({ status: 200, headers: good }, 10, 10), []);
  });
  it("404 para no status", () => {
    assert.deepEqual(servedImageProblems({ status: 404, headers: good }, 0, 10), ["HTTP 404 (esperado 200)"]);
  });
  it("acusa Content-Type, Cache-Control sem immutable e tamanho", () => {
    const p = servedImageProblems({ status: 200, headers: headers({ "content-type": "text/plain", "cache-control": "max-age=3600" }) }, 3, 10);
    assert.equal(p.length, 3);
    assert.match(p[0], /Content-Type/);
    assert.match(p[1], /immutable/);
    assert.match(p[2], /3 bytes/);
  });
});

describe("#11412 runProbe", () => {
  const writeTemp = (b: Buffer): [string, () => void] => {
    // O uploader lê o arquivo; um arquivo real no tmp é o caminho mais simples.
    const dir = mkdtempSync(join(tmpdir(), "probe-test-"));
    const p = join(dir, "p.jpg");
    writeFileSync(p, b);
    return [p, () => rmSync(dir, { recursive: true, force: true })];
  };

  it("passa quando os dois Workers servem a imagem do R2", async () => {
    const { fetch, calls } = fakeFetch(
      () => new Response(BODY, { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } }),
    );
    const r = await runProbe({ config: CONFIG, workerUrl: "https://eia.diar.ia.br", aammdd: "261104", body: BODY, deps: { fetch, now: () => new Date() }, writeTemp });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.checks.length, 2);
    assert.deepEqual(
      calls.filter((c) => c.method === "GET").map((c) => c.url),
      [`https://eia.diar.ia.br/img/${r.imageKey}`, `https://diar.ia.br/img/${r.imageKey}`],
    );
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].url, `https://acc.r2.cloudflarestorage.com/diaria-shorts/${r.r2Key}`);
  });

  it("falha quando o site serve sem immutable", async () => {
    const { fetch } = fakeFetch((u) =>
      new Response(BODY, {
        status: 200,
        headers: { "content-type": "image/jpeg", "cache-control": u.startsWith("https://diar.ia.br") ? "max-age=3600" : "public, immutable" },
      }),
    );
    const r = await runProbe({ config: CONFIG, workerUrl: "https://eia.diar.ia.br", aammdd: "261104", body: BODY, deps: { fetch, now: () => new Date() }, writeTemp });
    assert.equal(r.ok, false);
    assert.deepEqual(r.checks[0].problems, []);
    assert.match(r.checks[1].problems[0], /immutable/);
  });

  it("erro do uploader (Worker sem binding → HEAD 404) vira ok=false com a mensagem, sem GET", async () => {
    const calls: string[] = [];
    const fetch = async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (init?.method === "PUT") return new Response("", { status: 200 });
      if (init?.method === "HEAD" && u.startsWith("https://media.")) return new Response(null, { status: 200, headers: { "content-length": String(BODY.length) } });
      return new Response(null, { status: 404 });
    };
    const r = await runProbe({ config: CONFIG, workerUrl: "https://eia.diar.ia.br", aammdd: "261104", body: BODY, deps: { fetch, now: () => new Date() }, writeTemp });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /HTTP 404/);
    assert.equal(r.checks.length, 0);
    assert.ok(!calls.some((c) => c.startsWith("GET ")));
  });

  it("limpa o arquivo temporário mesmo quando o upload falha", async () => {
    let cleaned = false;
    const fetch = async () => new Response("denied", { status: 403 });
    const r = await runProbe({
      config: CONFIG,
      workerUrl: "https://eia.diar.ia.br",
      aammdd: "261104",
      body: BODY,
      deps: { fetch, now: () => new Date() },
      writeTemp: (b) => {
        const [p, c] = writeTemp(b);
        return [p, () => { cleaned = true; c(); }];
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /403/);
    assert.equal(cleaned, true);
  });
});
