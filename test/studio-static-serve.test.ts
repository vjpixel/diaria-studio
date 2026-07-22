/**
 * test/studio-static-serve.test.ts (#3555) — guard de path traversal +
 * resolução de MIME de scripts/studio-ui/static-serve.ts.
 *
 * #3891 (itens 5 e 10): cobertura de `serveStaticFile` fim-a-fim (antes só
 * `mimeFor`/`resolveStaticPath`, as funções puras, eram testadas aqui) —
 * ETag por mtime+size, `Cache-Control: no-cache`, 304 condicional via
 * `If-None-Match`, e os headers de segurança (`X-Content-Type-Options`,
 * CSP) presentes em toda resposta (200/304/403).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage } from "node:http";
import {
  mimeFor,
  resolveStaticPath,
  serveStaticFile,
  computeETag,
  SECURITY_HEADERS,
} from "../scripts/studio-ui/static-serve.ts";

function setupPublicDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "studio-static-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "nested.css"), "body{}");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mimeFor (#3555)", () => {
  it("mapeia extensões conhecidas", () => {
    assert.equal(mimeFor("x.html"), "text/html; charset=utf-8");
    assert.equal(mimeFor("x.css"), "text/css; charset=utf-8");
    assert.equal(mimeFor("x.js"), "text/javascript; charset=utf-8");
  });
  it("extensão desconhecida cai em octet-stream", () => {
    assert.equal(mimeFor("x.weird"), "application/octet-stream");
  });
});

describe("resolveStaticPath (#3555)", () => {
  it("'/' resolve pra index.html dentro do publicDir", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/"), join(dir, "index.html"));
    } finally {
      cleanup();
    }
  });

  it("path relativo simples resolve normalmente", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/app.js"), join(dir, "app.js"));
      assert.equal(resolveStaticPath(dir, "/sub/nested.css"), join(dir, "sub", "nested.css"));
    } finally {
      cleanup();
    }
  });

  it("ignora query string", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/app.js?v=2"), join(dir, "app.js"));
    } finally {
      cleanup();
    }
  });

  it("path traversal (../../) retorna null em vez de escapar do publicDir", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      assert.equal(resolveStaticPath(dir, "/../../../../etc/passwd"), null);
      assert.equal(resolveStaticPath(dir, "/..%2f..%2fsecret"), null);
    } finally {
      cleanup();
    }
  });
});

describe("computeETag (#3891)", () => {
  it("determinístico — mesma entrada (mtime, size) sempre produz o mesmo ETag", () => {
    assert.equal(computeETag(123456, 42), computeETag(123456, 42));
  });
  it("mtime ou size diferente muda o ETag (invalidação por reescrita do arquivo)", () => {
    assert.notEqual(computeETag(123456, 42), computeETag(123457, 42));
    assert.notEqual(computeETag(123456, 42), computeETag(123456, 43));
  });
  it("é um weak ETag (prefixo W/) — aspas presentes", () => {
    assert.match(computeETag(1, 1), /^W\/"1-1"$/);
  });
});

/** Server HTTP mínimo em cima de `serveStaticFile` — testa o wiring real de
 * headers (Content-Length/ETag/Cache-Control/segurança) e o fluxo 304
 * condicional via `If-None-Match`, sem precisar subir `server.ts` inteiro
 * (este módulo é deliberadamente independente do resto do Studio). */
function startTestServer(publicDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server: Server = createServer((req: IncomingMessage, res) => {
      const served = serveStaticFile(publicDir, req.url ?? "/", res, req);
      if (!served) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("serveStaticFile (#3891, itens 5+10) — ETag/Cache-Control + headers de segurança", () => {
  it("200: inclui ETag, Cache-Control: no-cache, e os headers de segurança (nosniff + CSP)", async () => {
    const { dir, cleanup } = setupPublicDir();
    const { url, close } = await startTestServer(dir);
    try {
      const res = await fetch(`${url}/app.js`);
      assert.equal(res.status, 200);
      const stat = statSync(join(dir, "app.js"));
      assert.equal(res.headers.get("etag"), computeETag(stat.mtimeMs, stat.size));
      assert.equal(res.headers.get("cache-control"), "no-cache");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("content-security-policy"), SECURITY_HEADERS["Content-Security-Policy"]);
    } finally {
      await close();
      cleanup();
    }
  });

  it("304: If-None-Match batendo com o ETag atual não reenvia o corpo", async () => {
    const { dir, cleanup } = setupPublicDir();
    const { url, close } = await startTestServer(dir);
    try {
      const first = await fetch(`${url}/app.js`);
      const etag = first.headers.get("etag")!;
      assert.ok(etag);

      const second = await fetch(`${url}/app.js`, { headers: { "If-None-Match": etag } });
      assert.equal(second.status, 304);
      const body = await second.text();
      assert.equal(body, ""); // 304 nunca carrega corpo
      // 304 também carrega os headers de segurança — nunca um caminho "mais barato".
      assert.equal(second.headers.get("x-content-type-options"), "nosniff");
    } finally {
      await close();
      cleanup();
    }
  });

  it("nunca staleness: arquivo reescrito (mtime muda) -> ETag muda -> If-None-Match antigo NÃO bate mais -> 200 com conteúdo novo", async () => {
    const { dir, cleanup } = setupPublicDir();
    const { url, close } = await startTestServer(dir);
    try {
      const first = await fetch(`${url}/app.js`);
      const staleEtag = first.headers.get("etag")!;

      // reescreve o arquivo com conteúdo diferente — mtime muda.
      await new Promise((r) => setTimeout(r, 5)); // garante mtime != (resolução de FS)
      writeFileSync(join(dir, "app.js"), "console.log(2)"); // conteúdo mudou

      const second = await fetch(`${url}/app.js`, { headers: { "If-None-Match": staleEtag } });
      assert.equal(second.status, 200, "ETag do disco mudou — a request com o ETag ANTIGO não pode resolver pra 304");
      const body = await second.text();
      assert.equal(body, "console.log(2)");
    } finally {
      await close();
      cleanup();
    }
  });

  it("403 (path traversal) também carrega os headers de segurança", async () => {
    const { dir, cleanup } = setupPublicDir();
    const { url, close } = await startTestServer(dir);
    try {
      const res = await fetch(`${url}/..%2f..%2fsecret`);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    } finally {
      await close();
      cleanup();
    }
  });

  it("sem `req` (retrocompat) — ainda serve 200 com ETag, nunca resolve 304 (não há If-None-Match pra comparar)", () => {
    const { dir, cleanup } = setupPublicDir();
    try {
      const chunks: Buffer[] = [];
      const headers: Record<string, unknown> = {};
      let statusCode = 0;
      const fakeRes = {
        writeHead(status: number, h: Record<string, unknown>) {
          statusCode = status;
          Object.assign(headers, h);
        },
        end(body?: Buffer) {
          if (body) chunks.push(body);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const served = serveStaticFile(dir, "/app.js", fakeRes);
      assert.equal(served, true);
      assert.equal(statusCode, 200);
      assert.ok(headers.ETag);
    } finally {
      cleanup();
    }
  });
});
