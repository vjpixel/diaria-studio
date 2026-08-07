/**
 * test/worker-drift-check-script.test.ts (#4723)
 *
 * Cobre as partes DETERMINÍSTICAS de `scripts/worker-drift-check.ts` que não
 * exigem credencial Cloudflare/Gmail ao vivo (guard de #573/CLAUDE.md — sem
 * `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN` reais neste worktree,
 * ver docstring do script e o PR body):
 *
 *   - `discoverWorkers` contra a árvore REAL `workers/*` do repo — confirma
 *     que a descoberta automática (sem lista hardcoded) encontra todos os 11
 *     workers existentes e resolve corretamente os casos onde o diretório
 *     difere do `name` publicado (ex: workers/artigos -> "diaria-artigos").
 *   - `getLastCommitAt` contra o repo git real — um path que TEM histórico
 *     (workers/reativar) retorna uma data ISO parseável; um path inexistente
 *     retorna `null` sem lançar.
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário,
 *     mesmo padrão de `test/apoios-diff-alarm.test.ts`.
 *
 * `fetchAllWorkerScriptsMetadata` (a única função que bate na Cloudflare
 * API) é exercitada com um `fetchFn` mockado — sem rede real.
 * `resolveLastDeployedAt` (lookup puro no mapa já carregado) é testada
 * separadamente, sem I/O nenhum.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverWorkers,
  getLastCommitAt,
  fetchAllWorkerScriptsMetadata,
  resolveLastDeployedAt,
  loadState,
  saveState,
} from "../scripts/worker-drift-check.ts";
import { emptyWorkerDriftAlarmState, advanceState } from "../scripts/lib/worker-drift-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("discoverWorkers (#4723) — árvore real workers/*", () => {
  it("encontra todos os workers com wrangler.toml presente, sem lista hardcoded", () => {
    const discovered = discoverWorkers(resolve(ROOT, "workers"));
    const names = discovered.map((w) => w.workerName).sort();
    // Confere um subconjunto estável em vez da lista completa — um worker
    // novo no futuro não deveria quebrar este teste (a descoberta É o
    // ponto: nenhum nome é mantido à mão aqui nem no script).
    assert.ok(names.includes("reativar"), `esperava 'reativar' em ${JSON.stringify(names)}`);
    assert.ok(names.includes("poll"), `esperava 'poll' em ${JSON.stringify(names)}`);
    assert.ok(names.includes("cursos"), `esperava 'cursos' em ${JSON.stringify(names)}`);
    assert.ok(discovered.length >= 11, `esperava pelo menos 11 workers, achou ${discovered.length}`);
  });

  it("resolve corretamente workers cujo dir difere do name publicado", () => {
    const discovered = discoverWorkers(resolve(ROOT, "workers"));
    const artigos = discovered.find((w) => w.workerDir === "artigos");
    assert.ok(artigos, "esperava encontrar workers/artigos/");
    assert.equal(artigos!.workerName, "diaria-artigos");

    const brevoDashboard = discovered.find((w) => w.workerDir === "brevo-dashboard");
    assert.ok(brevoDashboard, "esperava encontrar workers/brevo-dashboard/");
    assert.equal(brevoDashboard!.workerName, "clarice-dashboard");
  });

  it("diretório inexistente -> lista vazia, nunca lança", () => {
    assert.deepEqual(discoverWorkers(resolve(ROOT, "workers-que-nao-existe")), []);
  });
});

describe("getLastCommitAt (#4723) — git log real", () => {
  it("path com histórico real (workers/reativar) -> ISO 8601 parseável", () => {
    const commitAt = getLastCommitAt("reativar", ROOT);
    assert.notEqual(commitAt, null);
    assert.ok(!Number.isNaN(Date.parse(commitAt!)), `esperava ISO parseável, obteve ${commitAt}`);
  });

  it("path sem NENHUM commit -> null, nunca lança", () => {
    assert.equal(getLastCommitAt("worker-que-nunca-existiu-4723", ROOT), null);
  });
});

describe("fetchAllWorkerScriptsMetadata (#4723) — fetch mockado, sem rede real", () => {
  it("200 com lista de scripts -> mapa id->modified_on preenchido, sem erro", async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { id: "reativar", modified_on: "2026-08-01T10:00:00Z" },
            { id: "poll", modified_on: "2026-07-15T08:00:00Z" },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const r = await fetchAllWorkerScriptsMetadata("acc", "token", mockFetch);
    assert.equal(r.error, null);
    assert.equal(r.metadata?.get("reativar"), "2026-08-01T10:00:00Z");
    assert.equal(r.metadata?.get("poll"), "2026-07-15T08:00:00Z");
  });

  it("item sem modified_on é ignorado no mapa (nunca gera entrada undefined)", async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({ success: true, result: [{ id: "sem-deploy-ainda" }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchAllWorkerScriptsMetadata("acc", "token", mockFetch);
    assert.equal(r.metadata?.has("sem-deploy-ainda"), false);
  });

  it("401 -> error preenchido, metadata null (credencial inválida)", async () => {
    const mockFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const r = await fetchAllWorkerScriptsMetadata("acc", "bad-token", mockFetch);
    assert.equal(r.metadata, null);
    assert.match(r.error ?? "", /401/);
  });

  it("success:false -> error preenchido com a mensagem da API", async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await fetchAllWorkerScriptsMetadata("acc", "token", mockFetch);
    assert.equal(r.metadata, null);
    assert.match(r.error ?? "", /Authentication error/);
  });

  it("fetch lança (rede indisponível) -> error preenchido, nunca propaga a exceção", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchAllWorkerScriptsMetadata("acc", "token", mockFetch);
    assert.equal(r.metadata, null);
    assert.match(r.error ?? "", /ECONNREFUSED/);
  });
});

describe("resolveLastDeployedAt (#4723) — lookup puro, sem I/O", () => {
  it("worker presente no mapa -> retorna o modified_on", () => {
    const metadata = new Map([["reativar", "2026-08-01T10:00:00Z"]]);
    assert.equal(resolveLastDeployedAt("reativar", metadata), "2026-08-01T10:00:00Z");
  });

  it("worker ausente do mapa (nunca publicado) -> null, mesma semântica que um 404 teria", () => {
    const metadata = new Map([["reativar", "2026-08-01T10:00:00Z"]]);
    assert.equal(resolveLastDeployedAt("worker-novo", metadata), null);
  });
});

describe("loadState / saveState (#4723, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "worker-drift-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyWorkerDriftAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceState("reativar:drift:2026-08-05T10:00:00Z:2026-08-01T10:00:00Z", new Date("2026-08-05T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyWorkerDriftAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceState(null, new Date("2026-08-05T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});
