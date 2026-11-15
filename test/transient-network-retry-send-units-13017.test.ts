/**
 * test/transient-network-retry-send-units-13017.test.ts (#13017, #13098)
 *
 * Decisão do editor (15/11/2026): unit que ENVIA a terceiros só ganha o retry
 * de rede se a rerrodada depois de uma queda no meio não reenviar nem
 * esconder falha. `Diaria-Clarice-Novos`/`-Tarde` entraram no modo
 * `"step-declares"`; este arquivo trava o contrato que sustenta isso:
 *
 *   1. Queda de rede ANTES da seleção ser gravada: o script sai 105 e a unit
 *      reagenda. Nada foi selecionado nem enviado.
 *   2. Queda DEPOIS da seleção gravada (import, `--create`, `--send-test`,
 *      guard antes do POST): sai 4, nunca 105. Os contatos estão presos no
 *      `sent-or-queued.json`; reagendar daria uma rerrodada vazia, verde e
 *      sem alarme (review da PR #13098, P2-1).
 *   3. O aviso de presos (`stranded`, campo à parte do status) atravessa as
 *      rodadas seguintes (105, vazia, envio de outra key) até a key presa
 *      sair ou o editor limpar com `--clear-stranded`.
 *   4. O runner não reclassifica a saída inteira: um `gh` sem rede ecoado por
 *      um sub-passo que deu certo não transforma um abort determinístico em
 *      retry (P3).
 *   5. POST `sendNow` ambíguo sai 3, sucesso declarado: nunca reagenda.
 *   6. Duas invocações de `clarice-schedule-group.ts` no mesmo ciclo (a Tarde
 *      reagendada cruzando o `Diaria-Clarice-Envio` das 19:10) não apagam a
 *      entrada uma da outra no `group-campaigns.json` (P2-2).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runNovos,
  subStepFailedByNetwork,
  NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE,
  NOVOS_STRANDED_SELECTION_EXIT_CODE,
  type ExecFn,
  type NovosRunDeps,
  type StepResult,
} from "../scripts/clarice-novos-run.ts";
import {
  applySendNowVerifyResults,
  baselineEntriesMissingFromDisk,
  mergeGroupCampaigns,
  readGroupCampaigns,
  writeGroupCampaignsMerged,
  type CampaignEntry,
} from "../scripts/clarice-schedule-group.ts";
import {
  clearNovosStranded,
  readNovosRunStatus,
  resolveStrandedCarry,
  writeNovosRunStatus,
} from "../scripts/lib/clarice-novos-run-status.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import {
  resolveStepDeclaredExitCode,
  TRANSIENT_NETWORK_EXIT_CODE,
} from "../scripts/lib/transient-network-failure.ts";
import { runScheduledTask, type ExecStepFn } from "../scripts/lib/task-runner.ts";
import { buildSystemdUnitFiles } from "../scripts/lib/systemd-units.ts";
import { getScheduledTaskByName, type ScheduledTaskDefinition } from "../scripts/lib/scheduled-tasks.ts";
import type { GitSyncResult } from "../scripts/lib/git-sync.ts";

const SEND_UNITS = ["Diaria-Clarice-Novos", "Diaria-Clarice-Novos-Tarde"] as const;

// Saídas reais: undici numa queda de DNS e o gh CLI sem rede.
const UNDICI_EAI_AGAIN =
  "TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13\n" +
  "  [cause]: Error: getaddrinfo EAI_AGAIN api.brevo.com\n      errno: -3001,\n      code: 'EAI_AGAIN',";
const GH_OFFLINE = "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com";

function json(obj: unknown, code = 0): StepResult {
  return { code, stdout: JSON.stringify(obj), stderr: "" };
}

/** exec fake: por script, uma resposta ou uma fila de respostas (uma por chamada). */
function fakeExec(handlers: Record<string, StepResult | StepResult[]>): { exec: ExecFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const seen: Record<string, number> = {};
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const i = seen[script] ?? 0;
    seen[script] = i + 1;
    const h = handlers[script];
    if (h === undefined) throw new Error(`script inesperado: ${script} ${args.join(" ")}`);
    const r = Array.isArray(h) ? h[i] : h;
    if (!r) throw new Error(`fila esgotada para ${script} na chamada #${i}`);
    return r;
  };
  return { exec, calls };
}

function preSendHandlers(selected: number): Record<string, StepResult | StepResult[]> {
  return {
    "scripts/clarice-check-derived-stale.ts": { code: 0, stdout: "fresh", stderr: "" },
    "scripts/clarice-build-db.ts": { code: 0, stdout: "", stderr: "" },
    "scripts/clarice-stripe-delta.ts": json({ mode: "execute", since: "2026-11-13", rows: 5 }),
    "scripts/verify-emails-mv.ts": json({ mode: "since", total_verified: 5 }),
    "scripts/clarice-build-segment.ts": json({ selected, cycle: "2611-12", group: "novos" }),
    "scripts/clarice-novos-resolve-key.ts": json({ key: "novos-261114" }),
    "scripts/clarice-resolve-folder.ts": json({ folderId: 7, resolved: true }),
    "scripts/clarice-import-waves.ts": json({ mode: "execute", results: [{ listId: 99, wave: "novos" }] }),
    "scripts/clarice-novos-resolve-cycle.ts": json({ cycle: "2611-12", subject: "Assunto", fallback: false, checked: [] }),
    "scripts/clarice-novos-html-state.ts": json({ htmlSha256: "abc", shouldSendTest: true, previousState: null }),
  };
}

function deps(rootDir: string, exec: ExecFn, iso = "2026-11-14T12:00:00.000Z"): NovosRunDeps {
  return {
    rootDir,
    now: () => new Date(iso),
    exec,
    isEnabled: () => true,
    resolveEnvioCycle: () => "2611-12",
    execMode: () => "local",
  };
}

const statusDir = (root: string) => join(root, "data", "clarice-subscribers");

/** Rodada completa que envia (confirmado) a key de OUTRO dia. */
function runSentOtherKey(root: string, iso: string) {
  const handlers = preSendHandlers(5);
  handlers["scripts/clarice-novos-resolve-key.ts"] = json({ key: "novos-261115" });
  handlers["scripts/clarice-schedule-group.ts"] = [
    json({ key: "novos-261115", listId: 98, campaignId: 556, phase: "create", status: "draft" }),
    json({ key: "novos-261115", listId: 98, campaignId: 556, phase: "send-test" }),
    json({ key: "novos-261115", listId: 98, campaignId: 556, phase: "send-now", status: "sent" }),
  ];
  handlers["scripts/clarice-novos-html-state.ts"] = [
    json({ htmlSha256: "abc", shouldSendTest: true, previousState: null }),
    json({ lastRunAt: iso, sentCount: 5, lastCycle: "2611-12" }),
  ];
  return runNovos([], deps(root, fakeExec(handlers).exec, iso));
}
const ENV_KEYS = ["STRIPE_API_KEY", "BREVO_CLARICE_API_KEY", "MILLION_VERIFIER_API_KEY"] as const;

describe("Clarice-Novos com retry de rede (#13017, #13098)", () => {
  const saved: Record<string, string | undefined> = {};
  const roots: string[] = [];
  const freshRoot = () => {
    const r = mkdtempSync(join(tmpdir(), "novos-retry-13098-"));
    roots.push(r);
    return r;
  };

  before(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      process.env[k] = "test-key";
    }
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  it("as duas units declaram o modo step-declares e só o 3 como sucesso extra", () => {
    for (const name of SEND_UNITS) {
      const t = getScheduledTaskByName(name);
      assert.ok(t, `${name} existe no registro`);
      assert.equal(t.retryOnTransientNetwork, "step-declares", name);
      assert.deepEqual(t.successExitCodes, [NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE], name);
      assert.match(buildSystemdUnitFiles(t, "/repo").serviceContent, /RestartForceExitStatus=105/, name);
    }
  });

  it("queda de rede antes da seleção: sai 105, nem chega ao build-segment", async () => {
    const root = freshRoot();
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-stripe-delta.ts"] = { code: 1, stdout: "", stderr: UNDICI_EAI_AGAIN };
    const { exec, calls } = fakeExec(handlers);
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, TRANSIENT_NETWORK_EXIT_CODE);
    assert.ok(!calls.some((c) => c.script === "scripts/clarice-build-segment.ts"));
    assert.equal(readNovosRunStatus(statusDir(root))?.stranded, undefined);
  });

  it("queda de rede depois da seleção gravada: sai 4 (presos), nunca 105, e o --send-now não roda", async () => {
    const root = freshRoot();
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-schedule-group.ts"] = [
      json({ key: "novos-261114", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
      { code: 1, stdout: "", stderr: UNDICI_EAI_AGAIN }, // --send-test
    ];
    const { exec, calls } = fakeExec(handlers);
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, NOVOS_STRANDED_SELECTION_EXIT_CODE);
    assert.ok(!calls.some((c) => c.args.includes("--send-now")));
    assert.match(r.reportMarkdown, /PRESOS/);
    assert.match(r.reportMarkdown, /--key novos-261114 --send-now/);
    const status = readNovosRunStatus(statusDir(root));
    assert.equal(status?.status, "other-error");
    assert.equal(status?.stranded?.key, "novos-261114");
    assert.equal(status?.stranded?.cycle, "2611-12");
  });

  it("build-segment sai 0 sem resumo legível: presos (4), nunca rodada vazia", async () => {
    const root = freshRoot();
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-build-segment.ts"] = { code: 0, stdout: "✅ 42 contato(s)", stderr: "" };
    const { exec, calls } = fakeExec(handlers);
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, NOVOS_STRANDED_SELECTION_EXIT_CODE);
    assert.ok(!calls.some((c) => c.script === "scripts/clarice-import-waves.ts"));
    assert.ok(readNovosRunStatus(statusDir(root))?.stranded);
  });

  it("aviso do brevo-rate-state com 'fetch failed' não faz um abort comum virar 105", async () => {
    const root = freshRoot();
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-stripe-delta.ts"] = {
      code: 1,
      stdout: "",
      stderr:
        "⚠️  brevo-rate-state: KV da Cloudflare indisponível (leitura: fetch failed) — seguindo com o arquivo local (#12841).\n" +
        "❌ Stripe respondeu 401 (key inválida)",
    };
    const { exec } = fakeExec(handlers);
    assert.equal((await runNovos([], deps(root, exec))).code, 1);
    assert.equal(subStepFailedByNetwork(UNDICI_EAI_AGAIN), true);
  });

  it("rede cai ao resolver a key (logo depois da seleção): também é presos, mesmo sem key", async () => {
    const root = freshRoot();
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-novos-resolve-key.ts"] = { code: 1, stdout: "", stderr: GH_OFFLINE };
    const { exec } = fakeExec(handlers);
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, NOVOS_STRANDED_SELECTION_EXIT_CODE);
  });

  it("3 rodadas no dia (4 → 105 → vazia) e o envio de outra key não apagam o aviso; a key presa disparada limpa", async () => {
    const root = freshRoot();
    const failing = preSendHandlers(42);
    failing["scripts/clarice-schedule-group.ts"] = [
      json({ key: "novos-261114", listId: 99, campaignId: 555, phase: "create", status: "draft" }),
      { code: 1, stdout: "", stderr: UNDICI_EAI_AGAIN },
    ];
    // 09:00 BRT: cai depois da seleção.
    assert.equal((await runNovos([], deps(root, fakeExec(failing).exec, "2026-11-14T12:00:00.000Z"))).code, 4);
    // 18:00 BRT: cai por rede antes da seleção (other-error transitório).
    const net = preSendHandlers(0);
    net["scripts/clarice-stripe-delta.ts"] = { code: 1, stdout: "", stderr: UNDICI_EAI_AGAIN };
    assert.equal((await runNovos([], deps(root, fakeExec(net).exec, "2026-11-14T21:00:00.000Z"))).code, 105);
    assert.equal(readNovosRunStatus(statusDir(root))?.status, "other-error");
    assert.equal(readNovosRunStatus(statusDir(root))?.stranded?.key, "novos-261114");
    // 18:15 BRT: a rerrodada sai vazia (os presos saíram do universo).
    const empty = await runNovos([], deps(root, fakeExec(preSendHandlers(0)).exec, "2026-11-14T21:15:00.000Z"));
    assert.equal(empty.code, 0);
    assert.match(empty.reportMarkdown, /PRESOS desde/);
    assert.equal(readNovosRunStatus(statusDir(root))?.status, "empty");
    assert.equal(readNovosRunStatus(statusDir(root))?.stranded?.key, "novos-261114");
    // Dia seguinte, envio confirmado de OUTRA key: o aviso fica.
    const segDir = clariceSegmentsDir("2611-12", statusDir(root));
    mkdirSync(segDir, { recursive: true });
    const registry = join(segDir, "group-campaigns.json");
    writeFileSync(registry, JSON.stringify([{ key: "novos-261114", campaignId: 555, listId: 99, subject: "x", status: "draft" }]));
    assert.equal((await runSentOtherKey(root, "2026-11-15T12:00:00.000Z")).code, 0);
    assert.equal(readNovosRunStatus(statusDir(root))?.stranded?.key, "novos-261114");
    // Editor dispara a key presa: a próxima gravação limpa o aviso.
    writeFileSync(registry, JSON.stringify([{ key: "novos-261114", campaignId: 555, listId: 99, subject: "x", status: "sent" }]));
    assert.equal((await runSentOtherKey(root, "2026-11-15T21:00:00.000Z")).code, 0);
    assert.equal(readNovosRunStatus(statusDir(root))?.stranded, undefined);
  });

  it("resolveStrandedCarry e --clear-stranded", () => {
    const root = freshRoot();
    const base = statusDir(root);
    const prev = { at: "2026-11-14T12:00:00.000Z", key: "novos-261114", cycle: "2611-12" };
    assert.deepEqual(resolveStrandedCarry(prev, undefined, base), prev, "registro ausente conserva o aviso");
    assert.equal(resolveStrandedCarry({ at: prev.at }, undefined, base)?.at, prev.at, "sem key, só a limpeza manual tira");
    const next = { at: "2026-11-15T12:00:00.000Z", key: "novos-261115", cycle: "2611-12" };
    assert.deepEqual(resolveStrandedCarry(prev, next, base), next);
    writeNovosRunStatus({ status: "empty", checkedAt: prev.at, stranded: prev }, base);
    assert.equal(clearNovosStranded(base), true);
    assert.equal(readNovosRunStatus(base)?.stranded, undefined);
    assert.equal(readNovosRunStatus(base)?.status, "empty");
    assert.equal(clearNovosStranded(base), false);
  });

  it("abort determinístico com 'gh' sem rede ecoado por sub-passo que deu certo: sai 1, não 105", async () => {
    const root = freshRoot();
    const handlers = preSendHandlers(42);
    handlers["scripts/clarice-check-derived-stale.ts"] = { code: 0, stdout: "fresh", stderr: GH_OFFLINE };
    handlers["scripts/verify-emails-mv.ts"] = { code: 1, stdout: "", stderr: "❌ guard de custo D8: 900 créditos acima do teto" };
    const { exec } = fakeExec(handlers);
    const r = await runNovos([], deps(root, exec));
    assert.equal(r.code, 1);
  });
});

describe("runner no modo step-declares (#13098)", () => {
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
  let workDir: string;
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "task-runner-13098-"));
  });
  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function def(): ScheduledTaskDefinition {
    return {
      name: "Diaria-Teste-13098",
      description: "task de teste do modo step-declares",
      steps: [{ key: "run", script: "scripts/nao-roda.ts" }],
      logPath: "task-runner-test/.13098.log",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      issue: "#13098 (teste)",
      retryOnTransientNetwork: "step-declares",
      successExitCodes: [3],
    };
  }

  function run(code: number, output: string, tag: string): number {
    const exec: ExecStepFn = () => ({ code, output });
    return runScheduledTask(def(), {
      rootDir: workDir,
      logPathOverride: join(workDir, `${tag}-final.log`),
      tempLogPathOverride: join(workDir, `${tag}-temp.log`),
      execStep: exec,
      syncCode: NOOP_SYNC,
      reportFailure: () => {},
    }).code;
  }

  it("o 105 que o script declarou passa; saída com assinatura de rede e outro código não vira 105", () => {
    assert.equal(run(TRANSIENT_NETWORK_EXIT_CODE, "queda antes da seleção", "declarado"), TRANSIENT_NETWORK_EXIT_CODE);
    assert.equal(run(1, `${GH_OFFLINE}\n❌ guard de custo D8`, "determ"), 1);
    assert.equal(run(NOVOS_STRANDED_SELECTION_EXIT_CODE, UNDICI_EAI_AGAIN, "presos"), NOVOS_STRANDED_SELECTION_EXIT_CODE);
    assert.equal(run(NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE, UNDICI_EAI_AGAIN, "incerto"), NOVOS_SENDNOW_UNCERTAIN_EXIT_CODE);
  });

  it("resolveStepDeclaredExitCode: 105 misturado com outra falha vira 1", () => {
    const steps = [
      { code: TRANSIENT_NETWORK_EXIT_CODE, bestEffort: false, output: "" },
      { code: 2, bestEffort: false, output: "" },
    ];
    assert.equal(resolveStepDeclaredExitCode(TRANSIENT_NETWORK_EXIT_CODE, steps), 1);
    assert.equal(resolveStepDeclaredExitCode(0, steps), 0);
  });
});

describe("group-campaigns.json: escrita mesclada sob trava (#13098, P2-2)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "group-campaigns-13098-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (key: string, campaignId: number, extra: Partial<CampaignEntry> = {}): CampaignEntry => ({
    key,
    campaignId,
    listId: campaignId + 1000,
    subject: `Assunto ${key}`,
    status: "draft",
    ...extra,
  });

  it("a Tarde lê, o Envio grava a onda de amanhã no meio, a Tarde grava: as duas entradas ficam", () => {
    const path = join(dir, "group-campaigns.json");
    writeFileSync(path, JSON.stringify([entry("ramp-warm-261114", 1)], null, 2));
    // Tarde (`novos`) lê no início da invocação.
    const tarde = readGroupCampaigns(path);
    // Envio das 19:10 grava a onda de amanhã enquanto a Tarde está no poll.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as CampaignEntry[];
    onDisk[0] = { ...onDisk[0], status: "sent" };
    onDisk.push(entry("daily-261115", 2, { status: "scheduled", scheduledAt: "2026-11-15T09:00:00.000Z" }));
    writeFileSync(path, JSON.stringify(onDisk, null, 2));
    // Tarde termina e grava o próprio array (com a entrada antiga intacta).
    tarde.push(entry("novos-261114-2", 3, { status: "sent" }));
    writeGroupCampaignsMerged(path, JSON.stringify(tarde, null, 2));

    const final = JSON.parse(readFileSync(path, "utf8")) as CampaignEntry[];
    assert.deepEqual(
      final.map((e) => [e.key, e.status]),
      [
        ["ramp-warm-261114", "sent"], // não volta para o draft lido pela Tarde
        ["daily-261115", "scheduled"], // a onda de amanhã do Envio fica
        ["novos-261114-2", "sent"],
      ],
    );
  });

  it("segunda escrita da mesma invocação aplica a mudança nova sem reverter a do outro processo", () => {
    const path = join(dir, "gc-2.json");
    writeFileSync(path, JSON.stringify([entry("a", 1), entry("b", 2)], null, 2));
    const mine = readGroupCampaigns(path);
    mine[0] = { ...mine[0], sendNowAttemptedAt: "2026-11-14T21:00:00.000Z" };
    writeGroupCampaignsMerged(path, JSON.stringify(mine));
    // Outro processo atualiza "b".
    const disk = JSON.parse(readFileSync(path, "utf8")) as CampaignEntry[];
    disk[1] = { ...disk[1], status: "scheduled" };
    writeFileSync(path, JSON.stringify(disk));
    mine[0] = { ...mine[0], status: "sent" };
    writeGroupCampaignsMerged(path, JSON.stringify(mine));
    const final = JSON.parse(readFileSync(path, "utf8")) as CampaignEntry[];
    assert.equal(final[0].status, "sent");
    assert.equal(final[0].sendNowAttemptedAt, "2026-11-14T21:00:00.000Z");
    assert.equal(final[1].status, "scheduled");
  });

  it("writer de produção sem writeFn injetado (applySendNowVerifyResults) mescla com escrita intercalada", () => {
    const path = join(dir, "gc-prod.json");
    writeFileSync(path, JSON.stringify([entry("novos-261114-2", 3)], null, 2));
    const mine = readGroupCampaigns(path);
    // Envio das 19:10 registra a onda de amanhã durante o poll do --send-now.
    const disk = JSON.parse(readFileSync(path, "utf8")) as CampaignEntry[];
    disk.push(entry("daily-261115", 4, { status: "scheduled" }));
    writeFileSync(path, JSON.stringify(disk, null, 2));
    applySendNowVerifyResults([{ status: "fulfilled", value: { status: "sent" } }], [mine[0]], mine, path, undefined, () => {});
    const final = JSON.parse(readFileSync(path, "utf8")) as CampaignEntry[];
    assert.deepEqual(
      final.map((e) => [e.key, e.status]),
      [
        ["novos-261114-2", "sent"],
        ["daily-261115", "scheduled"],
      ],
    );
  });

  it("entrada lida no início que sumiu do disco é avisada no log", () => {
    const path = join(dir, "gc-gone.json");
    writeFileSync(path, JSON.stringify([entry("a", 1), entry("b", 2)], null, 2));
    const mine = readGroupCampaigns(path);
    writeFileSync(path, JSON.stringify([entry("b", 2)], null, 2));
    const logs: string[] = [];
    mine.push(entry("c", 3));
    writeGroupCampaignsMerged(path, JSON.stringify(mine), (m) => logs.push(m));
    assert.ok(logs.some((l) => /entrada a .*sumiu do disco/.test(l)), logs.join(" | "));
    assert.deepEqual(baselineEntriesMissingFromDisk([entry("a", 1)], [entry("b", 2)]).map((e) => e.key), ["a"]);
  });

  it("mergeGroupCampaigns: entrada sem mudança não sobrescreve o disco; nova vai para o fim", () => {
    const base = [entry("a", 1)];
    const disk = [entry("a", 1, { status: "sent" }), entry("x", 9)];
    assert.deepEqual(mergeGroupCampaigns(base, [entry("a", 1)], disk), disk);
    const merged = mergeGroupCampaigns(base, [entry("a", 1), entry("n", 5)], disk);
    assert.deepEqual(
      merged.map((e) => e.key),
      ["a", "x", "n"],
    );
  });
});
