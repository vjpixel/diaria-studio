import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchContext } from "../scripts/publish-linkedin.ts";
import {
  deriveChannelStatusFromPostEntry,
  parseCliArgs,
  parseAnoSlugFromDir,
  resolveImageUrl,
  runArtigoEspecialLinkedinDispatch,
} from "../scripts/publish-artigo-especial-linkedin.ts";
import {
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  buildDoneChannelState,
  withChannelState,
  type ArtigoEspecialState,
} from "../scripts/lib/artigo-especial-state.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

describe("deriveChannelStatusFromPostEntry (#5979)", () => {
  it("status draft -> done", () => {
    assert.equal(deriveChannelStatusFromPostEntry({ platform: "linkedin", destaque: "pagina", url: null, status: "draft", scheduled_at: null }), "done");
  });
  it("status scheduled -> done", () => {
    assert.equal(deriveChannelStatusFromPostEntry({ platform: "linkedin", destaque: "pagina", url: null, status: "scheduled", scheduled_at: "x" }), "done");
  });
  it("status failed -> failed", () => {
    assert.equal(deriveChannelStatusFromPostEntry({ platform: "linkedin", destaque: "perfil", url: null, status: "failed", scheduled_at: null }), "failed");
  });
});

describe("parseAnoSlugFromDir (#5979)", () => {
  it("extrai ano e slug simples", () => {
    assert.deepEqual(parseAnoSlugFromDir("2026-o-agente"), { ano: "2026", slug: "o-agente" });
  });
  it("slug com multiplos hifens preservado inteiro", () => {
    assert.deepEqual(parseAnoSlugFromDir("2026-engenharia-de-ilusao"), { ano: "2026", slug: "engenharia-de-ilusao" });
  });
  it("sem padrao {ano}-{slug} -> null", () => {
    assert.equal(parseAnoSlugFromDir("qualquer-coisa"), null);
    assert.equal(parseAnoSlugFromDir("26-slug"), null); // ano precisa ter 4 digitos
  });
});

describe("parseCliArgs (#5979)", () => {
  it("--dir obrigatorio", () => {
    const r = parseCliArgs([]);
    assert.ok("error" in r);
  });
  it("only default = [pagina, perfil]", () => {
    const r = parseCliArgs(["--dir", "data/artigo-especial/2026-x"]);
    assert.ok(!("error" in r));
    if (!("error" in r)) assert.deepEqual(r.only, ["pagina", "perfil"]);
  });
  it("--only filtra e ignora valores invalidos", () => {
    const r = parseCliArgs(["--dir", "d", "--only", "pagina,bogus"]);
    assert.ok(!("error" in r));
    if (!("error" in r)) assert.deepEqual(r.only, ["pagina"]);
  });
  it("--only todo invalido -> erro", () => {
    const r = parseCliArgs(["--dir", "d", "--only", "bogus"]);
    assert.ok("error" in r);
  });
  it("--force e --dry-run viram flags", () => {
    const r = parseCliArgs(["--dir", "d", "--force", "--dry-run"]);
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.equal(r.force, true);
      assert.equal(r.dryRun, true);
    }
  });
});

describe("resolveImageUrl (#5979)", () => {
  it("override explicito tem precedencia", () => {
    const url = resolveImageUrl("/nao-existe", "2026", "x", "https://override/img.jpg");
    assert.equal(url, "https://override/img.jpg");
  });
  it("artigo real do repo: le og:image do index.html publicado", () => {
    const rootDir = join(import.meta.dirname, "..");
    const url = resolveImageUrl(rootDir, "2026", "engenharia-de-ilusao");
    assert.equal(url, "https://especial.diar.ia.br/2026/engenharia-de-ilusao/capa.jpg");
  });
  it("artigo inexistente -> null (sem lancar)", () => {
    const rootDir = join(import.meta.dirname, "..");
    assert.equal(resolveImageUrl(rootDir, "2026", "nao-existe-mesmo"), null);
  });
});

describe("runArtigoEspecialLinkedinDispatch (#5979)", () => {
  let dir: string;
  let artigoDir: string;
  let dataDir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artigo-especial-linkedin-"));
    artigoDir = join(dir, "artigo");
    dataDir = join(dir, "data");
    mkdirSync(artigoDir, { recursive: true });
    writeFileSync(join(artigoDir, "linkedin-pagina.md"), "Texto da pagina.");
    writeFileSync(join(artigoDir, "linkedin-perfil.md"), "Texto do perfil.");
    statePath = artigoEspecialStatePath(dataDir, "2026", "x");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function mkCtx(): DispatchContext {
    return {
      publishedPath: join(artigoDir, "linkedin-published.json"),
      webhookUrl: "https://hook.test/diaria",
      workerUrl: "https://worker.test",
      workerToken: "test-tok",
      useWorkerForScheduled: true,
      editionDate: "2026-x",
      rootDir: dir,
    };
  }

  it("--dry-run: nao chama dispatchEntry (rede), nao grava state, retorna 2 entries null", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch NAO deveria ser chamado em --dry-run");
    };
    try {
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina", "perfil"],
        force: false,
        dryRun: true,
        ctx: mkCtx(),
        statePath,
      });
      assert.equal(failedCount, 0);
      assert.equal(results.length, 2);
      assert.ok(results.every((r) => r.entry === null && !r.skipped));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("dispatch real (mockado): 2 sucessos via make_now, state e linkedin-published.json gravados", async () => {
    const savedFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ accepted: true, request_id: `req-${calls}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const ctx = { ...mkCtx(), useWorkerForScheduled: false }; // sem worker -> make_now (scheduledAt passado no futuro nao importa aqui pois useWorkerForScheduled=false força make_now)
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: "https://especial.diar.ia.br/2026/x/capa.jpg",
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina"], // perfil (pixel) sem worker lançaria — testado à parte
        force: false,
        dryRun: false,
        ctx,
        statePath,
      });
      assert.equal(failedCount, 0);
      assert.equal(results.length, 1);
      assert.equal(results[0].entry?.status, "draft");
      assert.equal(calls, 1);

      const state = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(state.channels.linkedin_pagina?.status, "done");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("canal linkedin_pagina ja done sem --force: pula sem chamar dispatchEntry", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch NAO deveria ser chamado — canal ja done");
    };
    try {
      let state: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };
      state = withChannelState(state, "linkedin_pagina", buildDoneChannelState("2026-08-01T00:00:00Z", null));
      writeArtigoEspecialState(statePath, state);

      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina"],
        force: false,
        dryRun: false,
        ctx: mkCtx(),
        statePath,
      });
      assert.equal(results[0].skipped, true);
      assert.equal(results[0].entry, null);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("--force reexecuta canal ja done", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accepted: true, request_id: "r" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      let state: ArtigoEspecialState = { ano: "2026", slug: "x", channels: {} };
      state = withChannelState(state, "linkedin_pagina", buildDoneChannelState("2026-08-01T00:00:00Z", null));
      writeArtigoEspecialState(statePath, state);

      const ctx = { ...mkCtx(), useWorkerForScheduled: false };
      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["pagina"],
        force: true,
        dryRun: false,
        ctx,
        statePath,
      });
      assert.equal(results[0].skipped, false);
      assert.equal(results[0].entry?.status, "draft");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("dispatch pixel sem Worker configurado -> entry status=failed, state grava failed (falha por canal, nao lanca)", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch nao deveria ser chamado — pixel sem worker falha antes de chamar rede");
    };
    try {
      const ctx = { ...mkCtx(), useWorkerForScheduled: false, workerUrl: "", workerToken: "" };
      const { results, failedCount } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2026-09-02T17:30:00-03:00",
        only: ["perfil"],
        force: false,
        dryRun: false,
        ctx,
        statePath,
      });
      assert.equal(failedCount, 1);
      assert.equal(results[0].entry?.status, "failed");

      const state = readArtigoEspecialState(statePath, "2026", "x");
      assert.equal(state.channels.linkedin_perfil?.status, "failed");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("verifyWorker injetavel e chamado quando ha entry 'scheduled'", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ queued: true, key: "k1", scheduled_at: "2026-09-02T17:30:00-03:00", destaque: "pagina" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      let verifyCalled = false;
      const { results } = await runArtigoEspecialLinkedinDispatch({
        artigoDir,
        ano: "2026",
        slug: "x",
        imageUrl: null,
        scheduledAt: "2099-01-01T17:30:00-03:00", // bem no futuro -> route=worker_queue
        only: ["pagina"],
        force: false,
        dryRun: false,
        ctx: mkCtx(),
        statePath,
        verifyWorker: async () => {
          verifyCalled = true;
          return { changes: 0 };
        },
      });
      assert.equal(results[0].entry?.status, "scheduled");
      assert.equal(verifyCalled, true);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
