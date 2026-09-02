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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { execFileSync } from "node:child_process";
import {
  discoverWorkers,
  getLastCommitAt,
  resolveProductionRef,
  fetchAllWorkerScriptsMetadata,
  resolveLastDeployedAt,
  loadState,
  saveState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  toAlarmFinding,
} from "../scripts/worker-drift-check.ts";
import { emptyWorkerDriftAlarmState, advanceState, type WorkerDriftResult } from "../scripts/lib/worker-drift-check.ts";
import { emptyAlarmIssuesState, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";

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

describe("getLastCommitAt (#6413) — ignora commit de branch não-mergeada no checkout compartilhado", () => {
  // Reproduz o incidente relatado na issue #6413: o alarme rodou com o
  // checkout compartilhado numa branch de feature (de OUTRA sessão,
  // trabalhando outra issue) que tinha um commit tocando workers/{dir}
  // ainda não mergeado em master. `git log -1 -- path` (sem ref explícita)
  // segue HEAD e enxergava esse commit não-mergeado como "o último commit",
  // gerando um drift que não existia em produção. Repositório git real
  // temporário (não é viável mockar `spawnSync("git", ...)` aqui sem
  // reimplementar o parsing de `git log` — mesma disciplina do describe
  // acima, que já usa o repo real deste checkout).
  let tmpRepo: string;

  function git(args: string[], cwd: string = tmpRepo, env?: Record<string, string>): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env }).trim();
  }

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), "worker-drift-6413-"));
    git(["init", "-q", "-b", "master"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);

    // Commit 1 em master: cria o worker (equivalente ao "estado real de
    // produção"). Data de autor fixada (não "agora") pra garantir um
    // timestamp DISTINTO do commit 2 abaixo — sem isso os dois commits
    // podem cair no mesmo segundo e o teste não provaria nada.
    const workerDir = join(tmpRepo, "workers", "poll");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "index.ts"), "// v1\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "cria worker poll"], tmpRepo, {
      GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z",
    });

    // Simula `origin/master` apontando pro mesmo commit (equivalente a um
    // fetch já ter rodado antes) — sem precisar de um remote de verdade.
    git(["update-ref", "refs/remotes/origin/master", "master"]);

    // Commit 2 numa branch de FEATURE não-mergeada, tocando o mesmo worker
    // — o cenário exato do #6413 (issue #6340 tocando workers/poll numa
    // branch paralela), com data de autor POSTERIOR ao commit de master
    // (mesmo padrão do incidente real: o alarme comparou um commit mais
    // recente-mas-não-mergeado contra o deploy real).
    git(["checkout", "-q", "-b", "feature/outra-sessao"]);
    writeFileSync(join(workerDir, "index.ts"), "// v2 nao mergeado\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "feature flag ainda nao mergeada (#6340)"], tmpRepo, {
      GIT_AUTHOR_DATE: "2026-08-27T13:59:10Z",
      GIT_COMMITTER_DATE: "2026-08-27T13:59:10Z",
    });
    // Checkout compartilhado FICA nessa branch — é o estado no momento em
    // que o alarme roda, exatamente como no incidente relatado.
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("resolveProductionRef escolhe origin/master quando a ref existe localmente", () => {
    assert.equal(resolveProductionRef(tmpRepo), "origin/master");
  });

  it("getLastCommitAt reporta o commit de origin/master, não o da branch checked out", () => {
    const masterCommitAt = git(["log", "-1", "--format=%aI", "origin/master"], tmpRepo);
    const featureCommitAt = git(["log", "-1", "--format=%aI", "feature/outra-sessao"], tmpRepo);

    const reported = getLastCommitAt("poll", tmpRepo);
    assert.equal(reported, masterCommitAt);
    assert.notEqual(reported, featureCommitAt);
  });

  it("sem origin/master (clone atípico) cai pro master local, ainda ignorando a branch checked out", () => {
    git(["update-ref", "-d", "refs/remotes/origin/master"]);
    assert.equal(resolveProductionRef(tmpRepo), "master");

    const masterCommitAt = git(["log", "-1", "--format=%aI", "master"], tmpRepo);
    const reported = getLastCommitAt("poll", tmpRepo);
    assert.equal(reported, masterCommitAt);
  });

  it("checkout raso sem origin/master NEM master local (ex: CI fetch-depth:1 num PR) -> null, nunca lança (self-review #6413)", () => {
    // Reproduz o cenário achado no self-review deste PR: um checkout que
    // não tem `origin/master` (sem fetch de outras branches) nem uma
    // branch local chamada `master` (checkout raso/detached, ex:
    // actions/checkout@v4 com fetch-depth:1 padrão num evento
    // pull_request). resolveProductionRef cai pro literal "master", que
    // não resolve — getLastCommitAt precisa reportar `null` de forma
    // limpa (spawnSync com status != 0), nunca lançar. É por isso que
    // `.github/workflows/ci.yml` ganhou `fetch-depth: 0` no job `test`
    // neste mesmo PR — sem isso, este cenário aconteceria de verdade em
    // TODO PR e quebraria o teste "(#4723) — git log real" acima.
    git(["update-ref", "-d", "refs/remotes/origin/master"]);
    git(["branch", "-D", "master"]);
    assert.equal(resolveProductionRef(tmpRepo), "master");
    assert.doesNotThrow(() => getLastCommitAt("poll", tmpRepo));
    assert.equal(getLastCommitAt("poll", tmpRepo), null);
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

describe("loadAlarmIssuesState / saveAlarmIssuesState (#5339, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "worker-drift-check-alarm-issues-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadAlarmIssuesState(resolve(tmpDir, "nao-existe.json")), emptyAlarmIssuesState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "alarm-issues.json");
    const state: AlarmIssuesState = {
      "reativar:reativar:commit mais recente que o último deploy publicado": {
        issueNumber: 5337,
        url: "https://github.com/vjpixel/diaria-studio/issues/5337",
        missingStreak: 0,
        closedAt: null,
      },
    };
    saveAlarmIssuesState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadAlarmIssuesState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadAlarmIssuesState(path), emptyAlarmIssuesState());
  });
});

describe("toAlarmFinding — family (#5558)", () => {
  it("é sempre 'estado' — resolve sozinho quando o worker for redeployado", () => {
    const r: WorkerDriftResult = {
      workerName: "reativar",
      workerDir: "reativar",
      status: "drift",
      lastDeployedAt: "2026-08-01T10:00:00Z",
      lastCommitAt: "2026-08-05T10:00:00Z",
      driftMs: 4 * 24 * 60 * 60 * 1000,
      message: "commit mais recente que o último deploy publicado",
      deployBlockedBy: [],
    };
    assert.equal(toAlarmFinding(r).family, "estado");
  });
});
