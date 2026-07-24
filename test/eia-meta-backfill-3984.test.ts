/**
 * test/eia-meta-backfill-3984.test.ts (#3984)
 *
 * Lado SCRIPT do encanamento pipeline→KV: close-poll.ts empurra
 * descrição+crédito pro Worker (best-effort, fail-soft) no fluxo normal de
 * fechamento da diária; backfill-eia-meta.ts faz o mesmo pra edições
 * retroativas (script one-time, NÃO executado por esta suíte contra
 * produção — só a LÓGICA, com mocks).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";
import { adminEiaMetaSig } from "../scripts/close-poll.ts";
import { buildEiaMetaBackfillPlan, pushEiaMetaForEdition } from "../scripts/backfill-eia-meta.ts";

const isWindows = process.platform === "win32";

function spawnNpxAsync(
  args: string[],
  opts: SpawnOptions & { env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", args, { shell: isWindows, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

interface EiaMetaCall {
  edition: string | null;
  description: string | null;
  credit: string | null;
  sig: string | null;
}

function startMockPollWorker(
  expectedAnswer: string,
  opts: { eiaMetaStatus?: number } = {},
): Promise<{ server: Server; url: string; eiaMetaCalls: EiaMetaCall[] }> {
  const eiaMetaCalls: EiaMetaCall[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/correct") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updated_votes: 1 }));
        return;
      }
      if (url.pathname === "/admin/eiameta") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let parsed: { edition?: string; description?: string; credit?: string; sig?: string } = {};
          try { parsed = JSON.parse(body); } catch { /* ignore */ }
          eiaMetaCalls.push({
            edition: parsed.edition ?? null,
            description: parsed.description ?? null,
            credit: parsed.credit ?? null,
            sig: parsed.sig ?? null,
          });
          const status = opts.eiaMetaStatus ?? 200;
          res.writeHead(status);
          res.end(JSON.stringify(status === 200 ? { ok: true, edition: parsed.edition } : { ok: false, error: "mock_error" }));
        });
        return;
      }
      if (url.pathname === "/stats") {
        res.writeHead(200);
        res.end(JSON.stringify({ correct_answer: expectedAnswer }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, eiaMetaCalls });
    });
  });
}

function makeEditionFixture(
  editionsDir: string,
  edition: string,
  aiSide: "A" | "B",
  wikimedia: { title?: string; image_url?: string; credit?: string; description?: string } = {},
): void {
  const yymm = edition.slice(0, 4);
  const nestedInternalDir = join(editionsDir, yymm, edition, "_internal");
  mkdirSync(nestedInternalDir, { recursive: true });
  writeFileSync(
    join(nestedInternalDir, "01-eia-meta.json"),
    JSON.stringify({
      edition,
      composed_at: "2026-07-07T00:00:00.000Z",
      ai_image_file: "01-eia-A.jpg",
      real_image_file: "01-eia-B.jpg",
      ai_side: aiSide,
      wikimedia: { title: "Foo", image_url: "https://example.com/foo.jpg", ...wikimedia },
    }),
  );
}

// ── close-poll.ts: push best-effort de eiameta (#3984) ──────────────────────

describe("close-poll.ts empurra eiameta (#3984)", () => {
  it("edição com description+credit: POST /admin/eiameta com o payload correto", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "eiameta-push-"));
    const { server, url: pollWorkerUrl, eiaMetaCalls } = await startMockPollWorker("A");

    try {
      makeEditionFixture(editionsDir, "260709", "A", { description: "Uma ponte no Japão.", credit: "Foto: Fulano" });

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260709", "--editions-dir", editionsDir],
        { env: { ...process.env, ADMIN_SECRET: "test-secret-3984", POLL_WORKER_URL: pollWorkerUrl } },
      );

      assert.equal(r.status, 0, `esperado exit 0 — stderr: ${r.stderr}`);
      assert.equal(eiaMetaCalls.length, 1);
      assert.equal(eiaMetaCalls[0].edition, "260709");
      assert.equal(eiaMetaCalls[0].description, "Uma ponte no Japão.");
      assert.equal(eiaMetaCalls[0].credit, "Foto: Fulano");
      assert.match(r.stderr, /eiameta \(descrição\+crédito\) gravado/);
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edição SEM description/credit: pula o push (nada útil a compartilhar)", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "eiameta-skip-"));
    const { server, url: pollWorkerUrl, eiaMetaCalls } = await startMockPollWorker("A");

    try {
      makeEditionFixture(editionsDir, "260710", "A"); // sem description/credit

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260710", "--editions-dir", editionsDir],
        { env: { ...process.env, ADMIN_SECRET: "test-secret-3984", POLL_WORKER_URL: pollWorkerUrl } },
      );

      assert.equal(r.status, 0);
      assert.equal(eiaMetaCalls.length, 0, "sem description/credit não deve chamar /admin/eiameta");
      assert.match(r.stderr, /eiameta pulado.*sem descrição\/crédito/);
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("push de eiameta falha (mock 500) → NÃO bloqueia o close-poll da diária (fail-soft)", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "eiameta-fail-"));
    const { server, url: pollWorkerUrl, eiaMetaCalls } = await startMockPollWorker("A", { eiaMetaStatus: 500 });

    try {
      makeEditionFixture(editionsDir, "260711", "A", { description: "X", credit: "Y" });

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260711", "--editions-dir", editionsDir],
        { env: { ...process.env, ADMIN_SECRET: "test-secret-3984", POLL_WORKER_URL: pollWorkerUrl } },
      );

      assert.equal(r.status, 0, `mock 500 no eiameta NÃO deve derrubar o close-poll — stderr: ${r.stderr}`);
      assert.equal(eiaMetaCalls.length, 1, "tentou o push mesmo assim");
      assert.match(r.stderr, /aviso \(#3984\).*push de eiameta falhou/);
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("--brand explícito (web) NÃO dispara o push de eiameta (só o branch default/diária dispara, mesmo gate shouldMirrorToWeb)", async () => {
    const { server, url: pollWorkerUrl, eiaMetaCalls } = await startMockPollWorker("A");
    try {
      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", "260712", "--brand", "web", "--answer", "A"],
        { env: { ...process.env, ADMIN_SECRET: "test-secret-3984", POLL_WORKER_URL: pollWorkerUrl } },
      );
      assert.equal(r.status, 0);
      assert.equal(eiaMetaCalls.length, 0, "brand não-default não tem 01-eia-meta.json — nunca dispara o push");
    } finally {
      server.close();
    }
  });
});

// ── backfill-eia-meta.ts: plano + push (lógica, sem execução contra produção) ─

describe("buildEiaMetaBackfillPlan (#3984, pure — lê disco, sem rede)", () => {
  it("edições com description/credit entram no plano; sem nenhum dos dois são puladas", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "backfill-plan-"));
    try {
      makeEditionFixture(editionsDir, "260601", "A", { description: "Desc 1", credit: "Credit 1" });
      makeEditionFixture(editionsDir, "260602", "B"); // sem description/credit — pulada
      const plan = buildEiaMetaBackfillPlan(editionsDir);
      assert.equal(plan.items.length, 1);
      assert.equal(plan.items[0].edition, "260601");
      assert.equal(plan.items[0].description, "Desc 1");
      assert.equal(plan.skipped.length, 1);
      assert.equal(plan.skipped[0].edition, "260602");
      assert.equal(plan.skipped[0].reason, "no_description_or_credit");
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("edição sem 01-eia-meta.json nenhum: skip reason no_meta_file", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "backfill-nometa-"));
    try {
      mkdirSync(join(editionsDir, "260601"), { recursive: true }); // dir existe, sem _internal/meta
      const plan = buildEiaMetaBackfillPlan(editionsDir, ["260601"]);
      assert.equal(plan.items.length, 0);
      assert.equal(plan.skipped[0].reason, "no_meta_file");
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("editionsFilter restringe o scan a um subconjunto explícito", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "backfill-filter-"));
    try {
      makeEditionFixture(editionsDir, "260601", "A", { description: "D1", credit: "C1" });
      makeEditionFixture(editionsDir, "260602", "A", { description: "D2", credit: "C2" });
      const plan = buildEiaMetaBackfillPlan(editionsDir, ["260601"]);
      assert.equal(plan.items.length, 1);
      assert.equal(plan.items[0].edition, "260601");
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  it("meta.json com schema inválido: skip reason invalid_meta_schema, não lança", () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "backfill-badschema-"));
    try {
      const internalDir = join(editionsDir, "260601", "_internal");
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(internalDir, "01-eia-meta.json"), JSON.stringify({ edition: "260601" })); // faltam campos required
      const plan = buildEiaMetaBackfillPlan(editionsDir, ["260601"]);
      assert.equal(plan.items.length, 0);
      assert.equal(plan.skipped[0].reason, "invalid_meta_schema");
    } finally {
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });
});

describe("pushEiaMetaForEdition (#3984, fetchImpl injetável — sem rede real)", () => {
  it("sucesso: retorna ok:true com o sig assinado corretamente", async () => {
    let capturedBody: unknown = null;
    const fakeFetch = async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, edition: "260601" }) };
    };
    const result = await pushEiaMetaForEdition("https://poll.test", "secret", { edition: "260601", description: "D", credit: "C" }, fakeFetch);
    assert.equal(result.ok, true);
    const expectedSig = adminEiaMetaSig("secret", "260601", "D", "C");
    assert.equal((capturedBody as { sig: string }).sig, expectedSig);
  });

  it("falha de rede (fetch lança) → ok:false, nunca lança", async () => {
    const fakeFetch = async () => { throw new Error("network down"); };
    const result = await pushEiaMetaForEdition("https://poll.test", "secret", { edition: "260601", description: "D", credit: "C" }, fakeFetch);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /network down/);
  });

  it("resposta 500 do worker → ok:false com status", async () => {
    const fakeFetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) });
    const result = await pushEiaMetaForEdition("https://poll.test", "secret", { edition: "260601", description: "D", credit: "C" }, fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });
});
