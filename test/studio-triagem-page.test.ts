/**
 * test/studio-triagem-page.test.ts (#3562) — cockpit de triagem de issues/PRs:
 * `GET /triagem` faz rewrite pro shell estático (`public/triagem.html`),
 * `GET /api/issues` serve o snapshot montado por `studio-issues.ts` (com um
 * `ghRun` mockado — nunca invoca o binário `gh` real nem rede em teste,
 * mesmo precedente de `test/bug-heatmap.test.ts`), e nenhuma rota de
 * mutação existe (guard read-only já coberto genericamente em
 * `studio-server.test.ts`, reforçado aqui pra `/api/issues` especificamente).
 * A página em si (fetch + filtros client-side) roda no browser sem harness
 * de DOM neste projeto — mesmo precedente de `studio-edicao-page.test.ts`.
 *
 * Extensão (#3562, entrega 2): `GET /api/waves` — composição de wave
 * PREVIEW sobre o mesmo snapshot (`studio-waves.ts::buildWaveProposal`).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { clearTriageCache, type GhRunFn } from "../scripts/studio-ui/studio-issues.ts";

const mockIssues = [
  { number: 10, title: "issue P1", url: "https://github.com/x/y/issues/10", state: "OPEN", labels: [{ name: "P1" }] },
  { number: 11, title: "issue sem prioridade", url: "https://github.com/x/y/issues/11", state: "OPEN", labels: [{ name: "bug" }] },
];
const mockPrs = [
  {
    number: 20,
    title: "fix overnight",
    url: "https://github.com/x/y/pull/20",
    state: "OPEN",
    isDraft: false,
    headRefName: "overnight/fix-10-slug",
    labels: [{ name: "P0" }],
  },
];

const mockGhRun: GhRunFn = (args: string[]) => {
  if (args[0] === "issue") return { status: 0, stdout: JSON.stringify(mockIssues), stderr: "" };
  return { status: 0, stdout: JSON.stringify(mockPrs), stderr: "" };
};

describe("GET /triagem + GET /api/issues (#3562)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-triagem-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30, ghRun: mockGhRun });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearTriageCache();
  });

  it("serve o shell triagem.html", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("triagem.js"));
    assert.ok(body.includes("filters-bar"));
    assert.ok(body.includes("issues-tbody"));
    assert.ok(body.includes("prs-tbody"));
  });

  it("aceita /triagem/ com trailing slash", async () => {
    const res = await fetch(new URL("/triagem/", server.url));
    assert.equal(res.status, 200);
  });

  it("(#3874) banners de erro têm role=alert; tabela zerada tem contêiner de estado vazio; botão desabilitado tem motivo em texto visível", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="triage-error" class="panel alert-banner" role="alert"'));
    assert.ok(body.includes('id="waves-error" class="panel alert-banner" role="alert"'));
    assert.ok(body.includes('id="wave-capacity-warning" class="alert-banner" role="alert"'));
    assert.ok(body.includes('id="issues-empty"'));
    assert.ok(body.includes('id="prs-empty"'));
    assert.ok(body.includes('id="dispatch-track-legend"'), "legenda visível de DISPATCH_TRACK_EXPLAIN precisa existir (não só title= por linha)");
  });

  it("GET /triagem.js é servido com content-type JS", async () => {
    const res = await fetch(new URL("/triagem.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });

  it("GET /triagem.css é servido com content-type CSS", async () => {
    const res = await fetch(new URL("/triagem.css", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });

  it("POST /triagem é rejeitado com 405 (guard read-only)", async () => {
    const res = await fetch(new URL("/triagem", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("GET /api/issues retorna 200 JSON com o shape esperado, populado pelo runner mockado", async () => {
    const res = await fetch(new URL("/api/issues", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.equal(body.issues.length, 2);
    assert.equal(body.prs.length, 1);
    assert.equal(body.issues[0].priority, "P1");
    assert.equal(body.issues[1].priority, null);
    assert.equal(body.prs[0].track, "overnight");
    assert.equal(body.prs[0].priority, "P0");
  });

  it("POST /api/issues é rejeitado com 405 — nenhuma rota de mutação existe", async () => {
    const res = await fetch(new URL("/api/issues", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("DELETE /api/issues é rejeitado com 405 — reforça o guard read-only pra esta rota", async () => {
    const res = await fetch(new URL("/api/issues", server.url), { method: "DELETE" });
    assert.equal(res.status, 405);
  });

  it("resposta de /api/issues não inclui nenhum token/segredo — só o shape normalizado", async () => {
    const res = await fetch(new URL("/api/issues", server.url));
    const raw = await res.text();
    assert.ok(!/ghp_|gho_|github_pat_/.test(raw), "resposta não deve conter padrão de token do GitHub");
  });
});

describe("GET /api/waves (#3562, entrega 2)", () => {
  let root: string;
  let server: StudioServer;

  const wavesMockIssues = [
    {
      number: 100,
      title: "toca scripts/a.ts",
      url: "https://github.com/x/y/issues/100",
      state: "OPEN",
      labels: [{ name: "P1" }],
      body: "Mexe em `scripts/shared.ts`.",
    },
    {
      number: 101,
      title: "também toca scripts/a.ts",
      url: "https://github.com/x/y/issues/101",
      state: "OPEN",
      labels: [{ name: "P0" }],
      body: "Mexe em `scripts/shared.ts` também.",
    },
    {
      number: 102,
      title: "issue bloqueada não entra na análise",
      url: "https://github.com/x/y/issues/102",
      state: "OPEN",
      labels: [{ name: "external-blocker" }],
      body: "toca `scripts/outro.ts`",
    },
    {
      number: 103,
      title: "issue independente",
      url: "https://github.com/x/y/issues/103",
      state: "OPEN",
      labels: [],
      body: "toca `scripts/independente.ts`",
    },
  ];

  const wavesMockGhRun: GhRunFn = (args: string[]) => {
    if (args[0] === "issue") return { status: 0, stdout: JSON.stringify(wavesMockIssues), stderr: "" };
    return { status: 0, stdout: "[]", stderr: "" };
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-waves-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30, ghRun: wavesMockGhRun });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearTriageCache();
  });

  it("propõe onda: #101 (P0, representante do cluster com #100) + #103 (singleton); #100 adiada; #102 (bloqueada) fora", async () => {
    const res = await fetch(new URL("/api/waves", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.ok(!body.consideredIds.includes(102), "issue bloqueada não deveria entrar em consideredIds");
    assert.ok(body.wave.includes(101), "#101 (P0) deveria ser o representante do cluster");
    assert.ok(!body.wave.includes(100), "#100 deveria estar adiada, não na onda");
    assert.ok(body.deferred.includes(100));
    assert.ok(body.wave.includes(103), "#103 é singleton, deveria entrar direto na onda");
    assert.equal(body.maxConcurrency, 6);
  });

  it("POST /api/waves é rejeitado com 405 — guard read-only", async () => {
    const res = await fetch(new URL("/api/waves", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("reusa o mesmo cache de /api/issues — 2ª chamada não invoca `gh` de novo", async () => {
    let calls = 0;
    const countingRun: GhRunFn = (args) => {
      calls++;
      return wavesMockGhRun(args, root);
    };
    const s2 = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30, ghRun: countingRun });
    try {
      await fetch(new URL("/api/issues", s2.url));
      const callsAfterIssues = calls;
      await fetch(new URL("/api/waves", s2.url));
      assert.equal(calls, callsAfterIssues, "/api/waves não deveria disparar novo fetch de `gh` dentro do TTL");
    } finally {
      await s2.close();
    }
  });
});
