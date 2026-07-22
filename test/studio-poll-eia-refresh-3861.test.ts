/**
 * test/studio-poll-eia-refresh-3861.test.ts (#3861) — contrato HTTP do botão
 * "Atualizar É IA?" da dashboard diária embutida no studio-server:
 *
 *  - `POST /api/painel/eia/refresh` regenera SÓ `data/poll-eia-summary.json`
 *    local (fail-soft: sem `data/editions/`, sem edições, ou fetch
 *    indisponível → `{ok:false,error}`, sempre HTTP 200).
 *  - Caminho feliz: com `data/editions/` populado e o worker poll respondendo
 *    (via fetch stubado), o arquivo é escrito e o summary volta no payload.
 *  - `GET /api/painel/eia/refresh` (método errado) não casa a rota → 404.
 *  - A rota é uma exceção estreita ao guard read-only global (#3555), mesmo
 *    padrão de `/api/apoios/refresh` (#3859) — nunca 405.
 *
 * Regra #633 (PR de feature exige teste): cobre o endpoint novo + o guard de
 * publicação (nunca deriva pro push de produção — ver
 * scripts/build-poll-eia-data.ts::refreshPollEiaSummaryLocal).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("POST /api/painel/eia/refresh (#3861)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-poll-eia-refresh-"));
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/editions/ -> 200 fail-soft com {ok:false,error}", async () => {
    const res = await fetch(new URL("/api/painel/eia/refresh", server.url), { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error ?? "", /data\/editions/);
  });

  it("GET /api/painel/eia/refresh (método errado) não casa nenhuma rota GET conhecida -> 404", async () => {
    const res = await fetch(new URL("/api/painel/eia/refresh", server.url));
    assert.equal(res.status, 404);
  });
});

describe("POST /api/painel/eia/refresh — caminho feliz (fetch do worker poll stubado) (#3861)", () => {
  let root: string;
  let server: StudioServer;
  let origFetch: typeof globalThis.fetch;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-poll-eia-refresh-happy-"));
    mkdirSync(join(root, "data", "editions", "260418"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });

    origFetch = globalThis.fetch;
    const loopbackHost = new URL(server.url).host;
    // O stub só intercepta chamadas ao worker poll (poll.diaria.workers.dev,
    // default de DEFAULT_WORKER_URL) — requests ao próprio servidor de teste
    // loopback (a request HTTP que os testes fazem pra exercitar a rota)
    // passam direto pro fetch original, senão o teste quebraria a si mesmo.
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes(loopbackHost)) {
        return origFetch(url as any, init);
      }
      if (urlStr.includes("/stats") && urlStr.includes("edition=260418")) {
        return new Response(JSON.stringify({
          edition: "260418", total: 10, voted_a: 6, voted_b: 4,
          correct_answer: "A", correct_count: 6, correct_pct: 60,
        }), { status: 200 });
      }
      if (urlStr.includes("/leaderboard/")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = origFetch;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("200 {ok:true,summary} e escreve data/poll-eia-summary.json local", async () => {
    const res = await fetch(new URL("/api/painel/eia/refresh", server.url), { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.summary.editions.length, 1);
    assert.equal(body.summary.editions[0].edition, "260418");

    const outPath = join(root, "data", "poll-eia-summary.json");
    assert.ok(existsSync(outPath), "deve escrever data/poll-eia-summary.json");
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(written.last_edition, "260418");
  });

  it("regressão (guard de publicação): a resposta nunca inclui rastro de push remoto (só summary local)", async () => {
    const res = await fetch(new URL("/api/painel/eia/refresh", server.url), { method: "POST" });
    const body = await res.json();
    // O payload é exatamente {ok, summary?, error?} — nenhum campo adicional
    // relacionado a KV/Cloudflare/produção (ver refreshPollEiaSummaryLocal,
    // que nunca importa nem chama pushEiaEngagementToBrevoKv).
    assert.deepEqual(Object.keys(body).sort(), ["ok", "summary"]);
  });
});

describe("POST /api/painel/eia/refresh não quebra o guard read-only global (#3555) — mesma classe de exceção de #3859", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-poll-eia-refresh-guard-"));
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("outras rotas POST não-allowlistadas continuam 405 (a exceção é estreita, só esta rota)", async () => {
    const res = await fetch(new URL("/api/painel/eia/nao-existe", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});
