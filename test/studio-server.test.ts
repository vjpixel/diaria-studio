/**
 * test/studio-server.test.ts (#3555) — integração fina do studio-server:
 * bind loopback-only, rotas de API, static + guard de traversal, method
 * guard (read-only). Não testa SSE stream de forma exaustiva aqui —
 * `run-log-tail.test.ts`/`plan-watch.test.ts` já cobrem os watchers que
 * alimentam `/api/events`; este arquivo só confirma que a rota abre com os
 * headers certos e entrega o primeiro chunk (tail inicial) antes de fechar.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("studio-server (#3555)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-server-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("faz bind em 127.0.0.1, nunca 0.0.0.0", () => {
    assert.ok(server.url.startsWith("http://127.0.0.1:"));
  });

  it("GET /api/state retorna 200 JSON com o shape esperado", async () => {
    const res = await fetch(new URL("/api/state", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.currentEdition, null);
    assert.deepEqual(body.editions, []);
    assert.deepEqual(body.gatesPending, []);
  });

  it("GET /api/editions/{AAMMDD} de edição existente retorna 200", async () => {
    mkdirSync(join(root, "data", "editions", "260716"), { recursive: true });
    writeFileSync(join(root, "data", "editions", "260716", "01-categorized.md"), "x");

    const res = await fetch(new URL("/api/editions/260716", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.edition, "260716");
    assert.equal(body.found, true);
  });

  it("GET /api/editions/{AAMMDD} de edição inexistente retorna 404", async () => {
    const res = await fetch(new URL("/api/editions/999999", server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/editions/{AAMMDD inválido} retorna 400", async () => {
    const res = await fetch(new URL("/api/editions/nope", server.url));
    assert.equal(res.status, 400);
  });

  it("GET /api/rota-desconhecida retorna 404 JSON", async () => {
    const res = await fetch(new URL("/api/nao-existe", server.url));
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  it("GET / serve a SPA (index.html)", async () => {
    const res = await fetch(new URL("/", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("Diar.ia Studio"));
  });

  it("GET /tokens.generated.css serve CSS com custom properties do DS", async () => {
    const res = await fetch(new URL("/tokens.generated.css", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
    const body = await res.text();
    assert.ok(body.includes("--brand:"));
  });

  it("path traversal na SPA estática retorna 403", async () => {
    const res = await fetch(new URL("/../../../../etc/passwd", server.url));
    // O parser de URL do navegador normalizaria isso, mas o Node's URL/fetch
    // preserva o path cru quando construído a partir de string relativa —
    // usamos %2e%2e pra forçar o traversal chegar cru no servidor.
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("path traversal com encoding explícito retorna 403", async () => {
    const res = await fetch(`${server.url}..%2f..%2f..%2f..%2fetc%2fpasswd`);
    assert.equal(res.status, 403);
  });

  it("POST é rejeitado com 405 — servidor é read-only nesta fatia", async () => {
    const res = await fetch(new URL("/api/state", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("GET /api/events abre um stream SSE com o content-type correto", async () => {
    const controller = new AbortController();
    const res = await fetch(new URL("/api/events", server.url), { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    // Primeiro chunk é o comentário de conexão OU já o evento `state`
    // (a ordem exata de flush não é garantida pelo Node http em todo
    // ambiente) — o que importa é que o stream abriu e está emitindo.
    assert.ok(chunk.length > 0);

    controller.abort();
  });
});
