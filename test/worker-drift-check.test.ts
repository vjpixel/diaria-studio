/**
 * test/worker-drift-check.test.ts (#4723)
 *
 * Regressão pura pra `scripts/lib/worker-drift-check.ts` — parsing de
 * `wrangler.toml`/`.jsonc`, decisão de drift (todos os casos do item 9 da
 * issue: sem drift, com drift, nunca deployado, erro de consulta), fingerprint
 * + idempotência do alarme, e o texto do e-mail. Nenhum teste bate em
 * rede/Cloudflare/Gmail/git real — os dois timestamps entram já resolvidos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseWranglerTomlName,
  parseWranglerJsoncName,
  evaluateWorkerDrift,
  evaluateAllWorkerDrift,
  hasPendingDrift,
  computeDriftFingerprint,
  emptyWorkerDriftAlarmState,
  advanceState,
  shouldAlarm,
  shouldAdvanceState,
  buildWorkerDriftAlarmEmail,
  type WorkerDriftCheckInput,
  type WorkerDriftResult,
} from "../scripts/lib/worker-drift-check.ts";

// ─── parseWranglerTomlName / parseWranglerJsoncName ────────────────────────

describe("parseWranglerTomlName (#4723)", () => {
  it("extrai o name de um wrangler.toml real (workers/reativar)", () => {
    const toml = `name = "reativar"\nmain = "src/index.ts"\ncompatibility_date = "2024-01-01"\n`;
    assert.equal(parseWranglerTomlName(toml), "reativar");
  });

  it("name com hífen (ex: diaria-artigos) — dir e name podem divergir", () => {
    const toml = `name = "diaria-artigos"\nmain = "src/index.ts"\n`;
    assert.equal(parseWranglerTomlName(toml), "diaria-artigos");
  });

  it("name não é obrigatoriamente a 1ª linha — funciona com comentários antes", () => {
    const toml = `# comentário\n\nname = "clarice-dashboard"\nmain = "src/index.ts"\n`;
    assert.equal(parseWranglerTomlName(toml), "clarice-dashboard");
  });

  it("sem campo name -> null", () => {
    assert.equal(parseWranglerTomlName(`main = "src/index.ts"\n`), null);
  });

  it("arquivo vazio -> null (nunca lança)", () => {
    assert.equal(parseWranglerTomlName(""), null);
  });

  it("não confunde outro campo terminado em 'name' (ex: kv_namespace_name) com o campo name", () => {
    const toml = `kv_namespace_name = "algo"\nname = "poll"\n`;
    assert.equal(parseWranglerTomlName(toml), "poll");
  });

  it("#4723 fleet review achado 2: não confunde o 'name' de um binding ([[durable_objects.bindings]]) com o name de topo", () => {
    // Caso real: workers/poll/wrangler.toml — o campo name de topo continua
    // sendo encontrado mesmo com múltiplos bindings tendo seu PRÓPRIO 'name'
    // depois dele no arquivo (VOTE_DEDUP, STATS_COUNTER, SCORE_COUNTER).
    const toml = [
      `name = "poll"`,
      `main = "src/index.ts"`,
      `[[kv_namespaces]]`,
      `binding = "POLL"`,
      `id = "abc123"`,
      ``,
      `[[durable_objects.bindings]]`,
      `name = "VOTE_DEDUP"`,
      `class_name = "VoteDedup"`,
      ``,
      `[[durable_objects.bindings]]`,
      `name = "STATS_COUNTER"`,
      `class_name = "StatsCounter"`,
    ].join("\n");
    assert.equal(parseWranglerTomlName(toml), "poll");
  });

  it("#4723 fleet review achado 2: se o name de topo VIER DEPOIS de uma seção, não é mais confundido com o name da seção", () => {
    // Sem o corte no preâmbulo, o regex antigo casaria "VOTE_DEDUP" aqui
    // (1º 'name' do arquivo) em vez do name de topo real — cenário
    // hipotético que a ordem de arquivo atual do repo não exercita, mas que
    // o parser precisa recusar corretamente (retorna null — não há name no
    // preâmbulo antes da 1ª seção).
    const toml = [
      `[[durable_objects.bindings]]`,
      `name = "VOTE_DEDUP"`,
      `class_name = "VoteDedup"`,
      ``,
      `name = "poll"`,
    ].join("\n");
    assert.equal(parseWranglerTomlName(toml), null);
  });
});

describe("parseWranglerJsoncName (#4723)", () => {
  it("extrai o name de um wrangler.jsonc com comentários", () => {
    const jsonc = `{\n  // comentário\n  "name": "cursos",\n  "main": "src/index.ts"\n}\n`;
    assert.equal(parseWranglerJsoncName(jsonc), "cursos");
  });

  it("sem campo name -> null", () => {
    assert.equal(parseWranglerJsoncName(`{ "main": "src/index.ts" }`), null);
  });
});

// ─── evaluateWorkerDrift — os 4 casos do item 9 da issue ───────────────────

const NOW = new Date("2026-08-07T12:00:00Z");

function input(overrides: Partial<WorkerDriftCheckInput>): WorkerDriftCheckInput {
  return {
    workerName: "reativar",
    workerDir: "reativar",
    lastDeployedAt: null,
    lastCommitAt: null,
    deployError: null,
    ...overrides,
  };
}

describe("evaluateWorkerDrift (#4723 item 9)", () => {
  it("sem drift: deploy mais recente que o commit -> status ok, driftMs null", () => {
    const r = evaluateWorkerDrift(
      input({ lastCommitAt: "2026-08-01T10:00:00Z", lastDeployedAt: "2026-08-02T10:00:00Z" }),
      NOW,
    );
    assert.equal(r.status, "ok");
    assert.equal(r.driftMs, null);
  });

  it("deploy no MESMO instante do commit -> ok (não é '>', é estritamente depois que conta como drift)", () => {
    const r = evaluateWorkerDrift(
      input({ lastCommitAt: "2026-08-01T10:00:00Z", lastDeployedAt: "2026-08-01T10:00:00Z" }),
      NOW,
    );
    assert.equal(r.status, "ok");
  });

  it("com drift: commit mais recente que o deploy -> status drift, driftMs = diferença exata", () => {
    const r = evaluateWorkerDrift(
      input({ lastCommitAt: "2026-08-05T10:00:00Z", lastDeployedAt: "2026-08-01T10:00:00Z" }),
      NOW,
    );
    assert.equal(r.status, "drift");
    assert.equal(r.driftMs, 4 * 24 * 60 * 60 * 1000); // 4 dias — cenário real da issue (#4723)
  });

  it("worker sem NENHUM deploy ainda, mas com commit(s) em workers/{nome}/ -> never_deployed", () => {
    const r = evaluateWorkerDrift(input({ lastCommitAt: "2026-08-05T10:00:00Z", lastDeployedAt: null }), NOW);
    assert.equal(r.status, "never_deployed");
    assert.equal(r.driftMs, NOW.getTime() - Date.parse("2026-08-05T10:00:00Z"));
  });

  it("worker sem deploy E sem commit encontrado -> no_data (nada a comparar, não é 'never_deployed')", () => {
    const r = evaluateWorkerDrift(input({ lastCommitAt: null, lastDeployedAt: null }), NOW);
    assert.equal(r.status, "no_data");
    assert.equal(r.driftMs, null);
  });

  it("erro ao consultar a API (credencial ausente/API indisponível) -> status error, não crasha", () => {
    const r = evaluateWorkerDrift(
      input({ lastCommitAt: "2026-08-05T10:00:00Z", lastDeployedAt: null, deployError: "401 Unauthorized" }),
      NOW,
    );
    assert.equal(r.status, "error");
    assert.match(r.message, /401 Unauthorized/);
  });

  it("erro presente IGNORA um lastDeployedAt que porventura tenha vindo preenchido (não confiável)", () => {
    const r = evaluateWorkerDrift(
      input({
        lastCommitAt: "2026-08-05T10:00:00Z",
        lastDeployedAt: "2026-08-01T10:00:00Z",
        deployError: "timeout",
      }),
      NOW,
    );
    assert.equal(r.status, "error");
    assert.equal(r.lastDeployedAt, null);
  });

  it("preserva workerName/workerDir distintos no resultado (ex: dir artigos -> name diaria-artigos)", () => {
    const r = evaluateWorkerDrift(
      input({ workerName: "diaria-artigos", workerDir: "artigos", lastCommitAt: "2026-08-05T10:00:00Z" }),
      NOW,
    );
    assert.equal(r.workerName, "diaria-artigos");
    assert.equal(r.workerDir, "artigos");
  });
});

describe("evaluateAllWorkerDrift (#4723)", () => {
  it("mapeia cada input independentemente — erro num worker não afeta os demais", () => {
    const inputs: WorkerDriftCheckInput[] = [
      input({ workerName: "a", workerDir: "a", lastCommitAt: "2026-08-01T10:00:00Z", lastDeployedAt: "2026-08-02T10:00:00Z" }),
      input({ workerName: "b", workerDir: "b", lastCommitAt: "2026-08-05T10:00:00Z", deployError: "500" }),
      input({ workerName: "c", workerDir: "c", lastCommitAt: "2026-08-06T10:00:00Z", lastDeployedAt: "2026-08-01T10:00:00Z" }),
    ];
    const results = evaluateAllWorkerDrift(inputs, NOW);
    assert.equal(results.length, 3);
    assert.equal(results[0].status, "ok");
    assert.equal(results[1].status, "error");
    assert.equal(results[2].status, "drift");
  });
});

// ─── hasPendingDrift / computeDriftFingerprint / shouldAlarm ───────────────

function driftResult(overrides: Partial<WorkerDriftResult>): WorkerDriftResult {
  return {
    workerName: "reativar",
    workerDir: "reativar",
    status: "drift",
    lastDeployedAt: "2026-08-01T10:00:00Z",
    lastCommitAt: "2026-08-05T10:00:00Z",
    driftMs: 1000,
    message: "",
    ...overrides,
  };
}

describe("hasPendingDrift (#4723)", () => {
  it("todos ok/no_data/error -> false", () => {
    const results = [
      driftResult({ status: "ok", driftMs: null }),
      driftResult({ status: "no_data", driftMs: null }),
      driftResult({ status: "error", driftMs: null }),
    ];
    assert.equal(hasPendingDrift(results), false);
  });

  it("pelo menos 1 drift -> true", () => {
    assert.equal(hasPendingDrift([driftResult({ status: "ok", driftMs: null }), driftResult({ status: "drift" })]), true);
  });

  it("pelo menos 1 never_deployed -> true", () => {
    assert.equal(hasPendingDrift([driftResult({ status: "never_deployed", lastDeployedAt: null })]), true);
  });
});

describe("computeDriftFingerprint (#4723)", () => {
  it("determinístico e independente da ordem de chegada", () => {
    const a = [driftResult({ workerName: "a" }), driftResult({ workerName: "b" })];
    const b = [driftResult({ workerName: "b" }), driftResult({ workerName: "a" })];
    assert.equal(computeDriftFingerprint(a), computeDriftFingerprint(b));
  });

  it("ignora workers ok/error no fingerprint (só drift/never_deployed contam)", () => {
    const withExtra = [driftResult({ status: "drift" }), driftResult({ workerName: "b", status: "ok", driftMs: null })];
    const withoutExtra = [driftResult({ status: "drift" })];
    assert.equal(computeDriftFingerprint(withExtra), computeDriftFingerprint(withoutExtra));
  });

  it("novo commit sem novo deploy MUDA o fingerprint (mesmo worker, mesmo status)", () => {
    const before = [driftResult({ lastCommitAt: "2026-08-05T10:00:00Z" })];
    const after = [driftResult({ lastCommitAt: "2026-08-06T10:00:00Z" })];
    assert.notEqual(computeDriftFingerprint(before), computeDriftFingerprint(after));
  });

  it("lista vazia -> fingerprint vazio (string vazia)", () => {
    assert.equal(computeDriftFingerprint([]), "");
  });
});

describe("shouldAlarm (#4723)", () => {
  it("sem drift pendente -> nunca alarma, mesmo com state vazio", () => {
    assert.equal(shouldAlarm(emptyWorkerDriftAlarmState(), [driftResult({ status: "ok", driftMs: null })]), false);
  });

  it("1ª ocorrência de drift (state vazio) -> alarma", () => {
    assert.equal(shouldAlarm(emptyWorkerDriftAlarmState(), [driftResult({})]), true);
  });

  it("MESMO drift já alarmado antes -> não realarma (evita spam a cada execução de 6h)", () => {
    const results = [driftResult({})];
    const state = advanceState(computeDriftFingerprint(results), new Date("2026-08-05T12:00:00Z"));
    assert.equal(shouldAlarm(state, results), false);
  });

  it("novo commit sem novo deploy -> fingerprint muda -> alarma de novo", () => {
    const before = [driftResult({ lastCommitAt: "2026-08-05T10:00:00Z" })];
    const state = advanceState(computeDriftFingerprint(before), new Date("2026-08-05T12:00:00Z"));
    const after = [driftResult({ lastCommitAt: "2026-08-06T10:00:00Z" })];
    assert.equal(shouldAlarm(state, after), true);
  });

  it("drift resolvido (state re-armado pra null) e o worker volta a driftar depois -> alarma de novo", () => {
    const results = [driftResult({})];
    let state = advanceState(computeDriftFingerprint(results), new Date("2026-08-05T12:00:00Z"));
    assert.equal(shouldAlarm(state, results), false);
    // Editor rodou `wrangler deploy` -> próxima checagem não tem mais drift -> caller re-arma.
    state = advanceState(null, new Date("2026-08-06T12:00:00Z"));
    // Novo commit sem novo deploy reaparece.
    assert.equal(shouldAlarm(state, results), true);
  });
});

describe("shouldAdvanceState (#4723 fleet review achado 1)", () => {
  it("execução normal (sem dry-run, sem erro de conta) -> avança", () => {
    assert.equal(shouldAdvanceState({ isDryRun: false, metadataError: null }), true);
  });

  it("--dry-run -> nunca avança, mesmo sem erro", () => {
    assert.equal(shouldAdvanceState({ isDryRun: true, metadataError: null }), false);
  });

  it("falha de API pra conta inteira -> NÃO avança, mesmo sem dry-run (preserva cursor, evita re-alarme espúrio)", () => {
    assert.equal(shouldAdvanceState({ isDryRun: false, metadataError: "HTTP 500" }), false);
  });

  it("dry-run E erro de API simultâneos -> continua não avançando (nenhuma das duas condições permite)", () => {
    assert.equal(shouldAdvanceState({ isDryRun: true, metadataError: "HTTP 500" }), false);
  });
});

// ─── buildWorkerDriftAlarmEmail ─────────────────────────────────────────────

describe("buildWorkerDriftAlarmEmail (#4723)", () => {
  it("lista os workers com drift, o comando de deploy, e a duração formatada", () => {
    const results = [
      driftResult({
        workerName: "reativar",
        workerDir: "reativar",
        status: "drift",
        lastCommitAt: "2026-08-05T10:00:00Z",
        lastDeployedAt: "2026-08-01T10:00:00Z",
        driftMs: 4 * 24 * 60 * 60 * 1000,
      }),
    ];
    const { subject, body } = buildWorkerDriftAlarmEmail(results, NOW);
    assert.match(subject, /1 worker\(s\)/);
    assert.match(body, /reativar/);
    assert.match(body, /cd workers\/reativar && npx wrangler deploy/);
    assert.match(body, /4\.0 dia\(s\)/);
  });

  it("worker never_deployed -> corpo diz 'nunca deployado' em vez de citar um último deploy", () => {
    const results = [
      driftResult({
        workerName: "novo-worker",
        workerDir: "novo-worker",
        status: "never_deployed",
        lastDeployedAt: null,
        lastCommitAt: "2026-08-05T10:00:00Z",
        driftMs: 2 * 24 * 60 * 60 * 1000,
      }),
    ];
    const { body } = buildWorkerDriftAlarmEmail(results, NOW);
    assert.match(body, /nunca deployado/);
    assert.doesNotMatch(body, /último deploy: null/);
  });

  it("workers com status error entram numa seção de aviso separada, sem contar como drift no assunto", () => {
    const results = [
      driftResult({ workerName: "ok-worker", workerDir: "ok-worker", status: "drift" }),
      driftResult({
        workerName: "quebrado",
        workerDir: "quebrado",
        status: "error",
        driftMs: null,
        message: "erro ao consultar deploy publicado: 401 Unauthorized",
      }),
    ];
    const { subject, body } = buildWorkerDriftAlarmEmail(results, NOW);
    assert.match(subject, /^\[diar\.ia\.br\] 1 worker\(s\)/); // só 1 conta (o "quebrado" não é drift)
    assert.match(body, /não puderam ser checados/);
    assert.match(body, /quebrado.*401 Unauthorized/s);
  });

  it("sem workers error -> nenhuma seção de aviso aparece", () => {
    const results = [driftResult({})];
    const { body } = buildWorkerDriftAlarmEmail(results, NOW);
    assert.doesNotMatch(body, /não puderam ser checados/);
  });
});
