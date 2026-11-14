/**
 * test/transient-network-retry-13017.test.ts (#13017)
 *
 * Regressão do achado de 13/11/2026: queda de WAN de ~3h derrubou 16 units
 * diárias do `300` por `EAI_AGAIN`/`fetch failed`/`gh` sem rede, e nenhuma
 * tentou de novo até o dia seguinte. Trava as três peças do retry no nível
 * da unit: a classificação da saída, o exit code do runner e o `.service`
 * gerado, além do recorte do registro (quem tem retry e quem fica fora).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasTransientNetworkSignature,
  isTransientNetworkRun,
  resolveTransientNetworkExitCode,
  TRANSIENT_NETWORK_EXIT_CODE,
  TRANSIENT_NETWORK_MAX_RETRIES,
  TRANSIENT_NETWORK_RETRY_INTERVAL_MIN,
  TRANSIENT_NETWORK_START_LIMIT_WINDOW_H,
} from "../scripts/lib/transient-network-failure.ts";
import { runScheduledTask, type ExecStepFn } from "../scripts/lib/task-runner.ts";
import { buildSystemdUnitFiles } from "../scripts/lib/systemd-units.ts";
import { SCHEDULED_TASKS, getScheduledTaskByName, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import type { GitSyncResult } from "../scripts/lib/git-sync.ts";

// Saídas no formato real das falhas de 13/11 (undici do Node e gh CLI).
const UNDICI_EAI_AGAIN =
  "TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13\n" +
  "  [cause]: Error: getaddrinfo EAI_AGAIN api.brevo.com\n      errno: -3001,\n      code: 'EAI_AGAIN',";
const GH_OFFLINE = 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';
const HTTP_401 = "Erro: Brevo respondeu 401 Unauthorized (key inválida)";

const NOOP_SYNC = (): GitSyncResult => ({
  outcome: "already_up_to_date",
  message: "no-op de teste",
  branch_before: "master",
  warnings: [],
  proceed: true,
  up_to_date: true,
  commits_behind: 0,
  preserved_stash: null,
  stale_autostash_count: -1,
});

function def(overrides: Partial<ScheduledTaskDefinition> = {}): ScheduledTaskDefinition {
  return {
    name: "Diaria-Teste-13017",
    description: "task de teste do retry de rede",
    steps: [{ key: "a", script: "scripts/nao-roda-a.ts" }],
    logPath: "task-runner-test/.13017.log",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    issue: "#13017 (teste)",
    retryOnTransientNetwork: true,
    ...overrides,
  };
}

/** execStep fake: devolve, por script, o par code/output dado. */
function fakeExec(byScript: Record<string, { code: number; output: string }>): ExecStepFn {
  return (scriptAbs) => {
    const hit = Object.entries(byScript).find(([s]) => scriptAbs.endsWith(s));
    if (!hit) throw new Error(`script inesperado: ${scriptAbs}`);
    return hit[1];
  };
}

describe("hasTransientNetworkSignature (#13017)", () => {
  it("reconhece o fetch failed / EAI_AGAIN do undici e o gh sem rede", () => {
    assert.equal(hasTransientNetworkSignature(UNDICI_EAI_AGAIN), true);
    assert.equal(hasTransientNetworkSignature(GH_OFFLINE), true);
    assert.equal(hasTransientNetworkSignature("getaddrinfo ENOTFOUND oauth2.googleapis.com"), true);
    assert.equal(hasTransientNetworkSignature("curl: (6) Could not resolve host: api.cloudflare.com"), true);
    assert.equal(hasTransientNetworkSignature("read ECONNRESET"), true);
  });

  it("não reconhece erro de aplicação nem conexão recusada (serviço local parado)", () => {
    assert.equal(hasTransientNetworkSignature(HTTP_401), false);
    assert.equal(hasTransientNetworkSignature("connect ECONNREFUSED 127.0.0.1:3000"), false);
    assert.equal(hasTransientNetworkSignature("TypeError: Cannot read properties of undefined"), false);
  });
});

describe("isTransientNetworkRun / resolveTransientNetworkExitCode (#13017)", () => {
  it("todo passo obrigatório que falhou é de rede -> rodada de rede", () => {
    assert.equal(isTransientNetworkRun([{ code: 1, bestEffort: false, output: UNDICI_EAI_AGAIN }]), true);
  });

  it("um passo obrigatório falhou por outro motivo -> não é de rede", () => {
    const steps = [
      { code: 1, bestEffort: false, output: UNDICI_EAI_AGAIN },
      { code: 1, bestEffort: false, output: HTTP_401 },
    ];
    assert.equal(isTransientNetworkRun(steps), false);
    assert.equal(resolveTransientNetworkExitCode(1, steps), 1);
  });

  it("falha só em passo best-effort não conta; exit em successExitCodes não conta", () => {
    assert.equal(isTransientNetworkRun([{ code: 1, bestEffort: true, output: UNDICI_EAI_AGAIN }]), false);
    assert.equal(isTransientNetworkRun([{ code: 3, bestEffort: false, output: HTTP_401 }], [3]), false);
    assert.equal(
      isTransientNetworkRun(
        [
          { code: 3, bestEffort: false, output: HTTP_401 },
          { code: 1, bestEffort: false, output: GH_OFFLINE },
        ],
        [3],
      ),
      true,
    );
  });

  it("passo que sai 105 por conta própria, sem ser rede, não reagenda", () => {
    const steps = [{ code: TRANSIENT_NETWORK_EXIT_CODE, bestEffort: false, output: HTTP_401 }];
    assert.equal(resolveTransientNetworkExitCode(TRANSIENT_NETWORK_EXIT_CODE, steps), 1);
  });

  it("código 0 fica 0", () => {
    assert.equal(resolveTransientNetworkExitCode(0, []), 0);
  });
});

describe("runScheduledTask com retryOnTransientNetwork (#13017)", () => {
  let workDir: string;
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-13017-"));
  });
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function run(d: ScheduledTaskDefinition, exec: ExecStepFn, tag: string) {
    const reports: string[] = [];
    const result = runScheduledTask(d, {
      rootDir: workDir,
      logPathOverride: join(workDir, `${tag}-final.log`),
      tempLogPathOverride: join(workDir, `${tag}-temp.log`),
      execStep: exec,
      syncCode: NOOP_SYNC,
      reportFailure: (m) => reports.push(m),
    });
    return { result, reports, log: readFileSync(join(workDir, `${tag}-final.log`), "utf8") };
  }

  it("cenário de 13/11: passo cai com EAI_AGAIN -> sai com o código de retry e registra no log", () => {
    const { result, reports, log } = run(def(), fakeExec({ "nao-roda-a.ts": { code: 1, output: UNDICI_EAI_AGAIN } }), "wan");
    assert.equal(result.code, TRANSIENT_NETWORK_EXIT_CODE);
    assert.match(log, /falha só de rede nesta rodada; saindo com 105/);
    assert.ok(reports.some((m) => /falha só de rede/.test(m)));
  });

  it("sem a flag, a mesma falha segue exit 1 (comportamento de sempre)", () => {
    const d = def({ retryOnTransientNetwork: undefined });
    const { result } = run(d, fakeExec({ "nao-roda-a.ts": { code: 1, output: UNDICI_EAI_AGAIN } }), "noflag");
    assert.equal(result.code, 1);
  });

  it("falha de aplicação (401) não reagenda", () => {
    const { result } = run(def(), fakeExec({ "nao-roda-a.ts": { code: 1, output: HTTP_401 } }), "app");
    assert.equal(result.code, 1);
  });

  it("multi-passo: um de rede + um de aplicação -> código do 1º que falhou, sem retry", () => {
    const d = def({
      steps: [
        { key: "a", script: "scripts/nao-roda-a.ts" },
        { key: "b", script: "scripts/nao-roda-b.ts" },
      ],
    });
    const { result } = run(
      d,
      fakeExec({ "nao-roda-a.ts": { code: 2, output: GH_OFFLINE }, "nao-roda-b.ts": { code: 1, output: HTTP_401 } }),
      "mixed",
    );
    assert.equal(result.code, 2);
  });

  it("guard abortado (data/ sem montar) não é rede: exit 1", () => {
    const d = def({ guard: { requiredFile: "nao-existe/arquivo.db", abortMessage: "data/ sem montar" } });
    const { result } = run(d, fakeExec({}), "guard");
    assert.equal(result.guardAborted, true);
    assert.equal(result.code, 1);
  });

  it("rodada OK fica 0", () => {
    const { result } = run(def(), fakeExec({ "nao-roda-a.ts": { code: 0, output: "ok" } }), "ok");
    assert.equal(result.code, 0);
  });
});

describe("buildSystemdUnitFiles com retryOnTransientNetwork (#13017)", () => {
  it("a unit reagenda só o código dedicado, a cada 15 min, com teto de 17 partidas", () => {
    const { serviceContent } = buildSystemdUnitFiles(def(), "/repo");
    const [unitSection, serviceSection] = serviceContent.split("[Service]");
    assert.match(unitSection, /^StartLimitIntervalSec=12h$/m);
    assert.match(unitSection, new RegExp(`^StartLimitBurst=${TRANSIENT_NETWORK_MAX_RETRIES + 1}$`, "m"));
    assert.match(serviceSection, /^RestartForceExitStatus=105$/m);
    assert.match(serviceSection, /^RestartSec=15min$/m);
    // Restart= fica no default (no): nenhuma outra falha reagenda.
    assert.doesNotMatch(serviceContent, /^Restart=/m);
  });

  it("as tentativas (~4h) cabem na janela do limite, senão o teto nunca dispara", () => {
    const retriesMin = TRANSIENT_NETWORK_MAX_RETRIES * TRANSIENT_NETWORK_RETRY_INTERVAL_MIN;
    assert.ok(retriesMin >= 3.5 * 60, "precisa cobrir as quedas de ~3h15 de 13/11");
    assert.ok(retriesMin < TRANSIENT_NETWORK_START_LIMIT_WINDOW_H * 60);
    assert.ok(TRANSIENT_NETWORK_START_LIMIT_WINDOW_H < 24, "a janela vence antes do próximo disparo diário");
  });

  it("sem a flag, nenhuma linha de retry", () => {
    const { serviceContent } = buildSystemdUnitFiles(def({ retryOnTransientNetwork: undefined }), "/repo");
    assert.doesNotMatch(serviceContent, /RestartForceExitStatus=|RestartSec=|StartLimit/);
  });

  it("recusa schedule interval e código de retry declarado como sucesso", () => {
    assert.throws(() => buildSystemdUnitFiles(def({ schedule: { kind: "interval", hours: 4 } }), "/repo"), /interval/);
    assert.throws(
      () => buildSystemdUnitFiles(def({ successExitCodes: [TRANSIENT_NETWORK_EXIT_CODE] }), "/repo"),
      /successExitCodes/,
    );
  });
});

describe("registro: quem tem retry de rede (#13017)", () => {
  // As units diárias de leitura/sync/alarme que caíram em 13/11.
  const COM_RETRY = [
    "Diaria-GA4-Sync",
    "Diaria-Clarice-Sync",
    "Diaria-Clarice-Unblock-Suspended",
    "Diaria-Cursos-Kv-Sync",
    "Diaria-Artigos-Apoio-Kv-Sync",
    "Diaria-Kit-Roster-Ingest",
    "Diaria-Ai-Fetch-Report",
    "Diaria-Dmarc-Drain",
    "Diaria-Backlog-Reconcile",
  ];
  // As que ENVIAM: fora até a idempotência de cada uma ser conferida.
  const SEM_RETRY_ENVIO = [
    "Diaria-Clarice-Novos",
    "Diaria-Clarice-Novos-Tarde",
    "Diaria-Onboarding-Welcome-Run",
    "Diaria-Google-Ads-Confirmations-Upload",
  ];

  it("as units de leitura/sync de 13/11 têm a flag", () => {
    for (const name of COM_RETRY) {
      assert.equal(getScheduledTaskByName(name)?.retryOnTransientNetwork, true, name);
    }
  });

  it("as units que enviam não têm a flag", () => {
    for (const name of SEM_RETRY_ENVIO) {
      assert.ok(getScheduledTaskByName(name), `${name} existe no registro`);
      assert.notEqual(getScheduledTaskByName(name)?.retryOnTransientNetwork, true, name);
    }
  });

  it("toda task com a flag gera unit válida (não-interval, sem 105 em successExitCodes)", () => {
    for (const t of SCHEDULED_TASKS.filter((x) => x.retryOnTransientNetwork)) {
      assert.doesNotThrow(() => buildSystemdUnitFiles(t, "/repo"), t.name);
    }
  });

  it("nenhuma task declara o código de retry como sucesso", () => {
    for (const t of SCHEDULED_TASKS) {
      assert.ok(!(t.successExitCodes ?? []).includes(TRANSIENT_NETWORK_EXIT_CODE), t.name);
    }
  });
});
