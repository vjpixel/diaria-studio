/**
 * test/clarice-novos-resolve-cycle-4621.test.ts (#4621)
 *
 * Achado ao vivo 260804: `clarice-novos-resolve-cycle.ts` caiu (D3, fallback
 * legítimo por design) do ciclo corrente `2607-08` pro ciclo `2605-06` — o
 * digest de JUNHO, ~2 meses desatualizado — porque `2607-08` não tinha
 * entrada em `campaigns-summary.json` (os envios reais daquele ciclo foram
 * montados via `clarice-build-segment.ts --group`/`clarice-schedule-group.ts
 * --group`, que nunca escrevem nesse arquivo). Este arquivo cobre o guard de
 * atividade real (itens 2+3 da issue) em dois níveis:
 *   - núcleo puro (`cycleMonthDistance`, `mostRecentActiveClariceCycle`,
 *     `evaluateClariceActivityGuard`) via deps/fixtures injetadas;
 *   - integração de `main()` da CLI via overrides injetáveis (nunca toca
 *     disco real / dados de produção).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cycleMonthDistance,
  mostRecentActiveClariceCycle,
  evaluateClariceActivityGuard,
  type ClariceActivityDeps,
  type ResolveLatestMonthlyCycleResult,
} from "../scripts/lib/mensal/monthly-paths.ts";
import { cycleHasClariceActivity, listClariceCycleDirs } from "../scripts/lib/clarice-paths.ts";
import { main } from "../scripts/clarice-novos-resolve-cycle.ts";

function activityDeps(overrides: {
  cycles?: string[];
  activity?: Record<string, boolean>;
}): ClariceActivityDeps {
  const cycles = overrides.cycles ?? [];
  const activity = overrides.activity ?? {};
  return {
    listCyclesWithClariceDir: () => cycles,
    cycleHasActivity: (c) => activity[c] ?? false,
  };
}

// ── cycleMonthDistance ──────────────────────────────────────────────────────

test("cycleMonthDistance: mesmo ciclo -> 0", () => {
  assert.equal(cycleMonthDistance("2607-08", "2607-08"), 0);
});

test("cycleMonthDistance: 2605-06 vs 2607-08 (maio -> julho) -> 2", () => {
  assert.equal(cycleMonthDistance("2605-06", "2607-08"), 2);
});

test("cycleMonthDistance: 2606-07 vs 2607-08 (junho -> julho) -> 1", () => {
  assert.equal(cycleMonthDistance("2606-07", "2607-08"), 1);
});

test("cycleMonthDistance: é simétrica", () => {
  assert.equal(cycleMonthDistance("2607-08", "2605-06"), 2);
});

test("cycleMonthDistance: cruza virada de ano", () => {
  assert.equal(cycleMonthDistance("2612-01", "2701-02"), 1);
});

// ── cycleHasClariceActivity / listClariceCycleDirs (IO real, tmpdir isolado) ─

test("cycleHasClariceActivity: pasta com arquivo -> true; pasta vazia ou ausente -> false", () => {
  const root = mkdtempSync(join(tmpdir(), "clarice-activity-"));
  try {
    // 2607-08 tem atividade (arquivo dentro de segments/)
    mkdirSync(join(root, "2607-08", "segments"), { recursive: true });
    writeFileSync(join(root, "2607-08", "segments", "group-campaigns.json"), "[]", "utf8");
    // 2606-07 existe mas está vazio (só pastas, sem arquivo)
    mkdirSync(join(root, "2606-07", "waves"), { recursive: true });

    assert.equal(cycleHasClariceActivity("2607-08", root), true);
    assert.equal(cycleHasClariceActivity("2606-07", root), false);
    assert.equal(cycleHasClariceActivity("2605-06", root), false); // nem existe
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cycleHasClariceActivity: ciclo com forma inválida -> false sem tocar disco", () => {
  const root = mkdtempSync(join(tmpdir(), "clarice-activity-invalid-"));
  try {
    assert.equal(cycleHasClariceActivity("nao-e-ciclo", root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listClariceCycleDirs: lista só subpastas com nome de ciclo válido", () => {
  const root = mkdtempSync(join(tmpdir(), "clarice-list-"));
  try {
    mkdirSync(join(root, "2607-08"), { recursive: true });
    mkdirSync(join(root, "2605-06"), { recursive: true });
    mkdirSync(join(root, "nao-e-ciclo"), { recursive: true });
    writeFileSync(join(root, "arquivo-solto.txt"), "x", "utf8"); // não é diretório
    const dirs = listClariceCycleDirs(root).sort();
    assert.deepEqual(dirs, ["2605-06", "2607-08"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listClariceCycleDirs: base inexistente -> [] (nunca lança)", () => {
  assert.deepEqual(listClariceCycleDirs(join(tmpdir(), "nao-existe-" + Date.now())), []);
});

// ── mostRecentActiveClariceCycle ────────────────────────────────────────────

test("mostRecentActiveClariceCycle: escolhe o maior ciclo COM atividade, ignora pastas vazias/sem arquivo", () => {
  const deps = activityDeps({
    cycles: ["2605-06", "2606-07", "2607-08"],
    activity: { "2605-06": true, "2606-07": true, "2607-08": false }, // 2607-08 tem pasta mas sem arquivo
  });
  assert.equal(mostRecentActiveClariceCycle(deps), "2606-07");
});

test("mostRecentActiveClariceCycle: nenhum ciclo com atividade -> undefined", () => {
  const deps = activityDeps({ cycles: ["2605-06"], activity: {} });
  assert.equal(mostRecentActiveClariceCycle(deps), undefined);
});

test("mostRecentActiveClariceCycle: ciclo com forma inválida é ignorado", () => {
  const deps = activityDeps({
    cycles: ["nao-e-ciclo", "2607-08"],
    activity: { "nao-e-ciclo": true, "2607-08": true },
  });
  assert.equal(mostRecentActiveClariceCycle(deps), "2607-08");
});

// ── evaluateClariceActivityGuard ────────────────────────────────────────────

test("evaluateClariceActivityGuard: cenário real da issue — fallback caiu 2 ciclos pra trás do ciclo com atividade real -> bloqueia", () => {
  const deps = activityDeps({
    cycles: ["2607-08"],
    activity: { "2607-08": true }, // envios ad-hoc por grupo, agosto em curso
  });
  const guard = evaluateClariceActivityGuard("2605-06", /* fallback */ true, /* hasExplicitSubject */ false, deps);
  assert.equal(guard.activeCycle, "2607-08");
  assert.equal(guard.distance, 2);
  assert.equal(guard.diverges, true);
  assert.equal(guard.blocked, true);
  assert.match(guard.note ?? "", /diverge/);
});

test("evaluateClariceActivityGuard: fallback legítimo — sem atividade recente em data/clarice-subscribers/ -> cai peacefully, não bloqueia", () => {
  const deps = activityDeps({ cycles: [], activity: {} }); // nenhum sinal de atividade
  const guard = evaluateClariceActivityGuard("2605-06", true, false, deps);
  assert.equal(guard.activeCycle, undefined);
  assert.equal(guard.diverges, false);
  assert.equal(guard.blocked, false);
  assert.equal(guard.note, undefined);
});

test("evaluateClariceActivityGuard: fallback de só 1 ciclo -> diverge mas NÃO bloqueia (rastro auditável via note)", () => {
  const deps = activityDeps({
    cycles: ["2607-08"],
    activity: { "2607-08": true },
  });
  const guard = evaluateClariceActivityGuard("2606-07", true, false, deps);
  assert.equal(guard.distance, 1);
  assert.equal(guard.diverges, true);
  assert.equal(guard.blocked, false);
  assert.match(guard.note ?? "", /diverge/);
});

test("evaluateClariceActivityGuard: --subject explícito destrava o bloqueio mas ainda registra a nota", () => {
  const deps = activityDeps({
    cycles: ["2607-08"],
    activity: { "2607-08": true },
  });
  const guard = evaluateClariceActivityGuard("2605-06", true, /* hasExplicitSubject */ true, deps);
  assert.equal(guard.blocked, false);
  assert.match(guard.note ?? "", /diverge/);
});

test("evaluateClariceActivityGuard: sem fallback (ciclo resolvido já é o mais recente candidato) -> guard não avalia nada", () => {
  const deps = activityDeps({
    cycles: ["2607-08"],
    activity: { "2607-08": true },
  });
  const guard = evaluateClariceActivityGuard("2605-06", /* fallback */ false, false, deps);
  assert.equal(guard.activeCycle, undefined);
  assert.equal(guard.diverges, false);
  assert.equal(guard.blocked, false);
  assert.equal(guard.note, undefined);
});

test("evaluateClariceActivityGuard: ciclo resolvido == ciclo ativo -> não diverge mesmo com fallback true", () => {
  const deps = activityDeps({
    cycles: ["2605-06"],
    activity: { "2605-06": true },
  });
  const guard = evaluateClariceActivityGuard("2605-06", true, false, deps);
  assert.equal(guard.diverges, false);
  assert.equal(guard.blocked, false);
});

// ── Integração: main() da CLI (overrides injetados, sem tocar disco real) ──

function makeResolveResult(cycle: string, fallback: boolean): ResolveLatestMonthlyCycleResult {
  return {
    cycle,
    subject: "Assunto qualquer",
    fallback,
    checked: [],
  };
}

function captureMain(argv: string[], overrides: Parameters<typeof main>[1]): { exitCode: number | undefined; errs: string[] } {
  const errs: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  const origExit = process.exit;
  let exitCode: number | undefined;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  console.log = () => {};
  // @ts-expect-error stub
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error("mock-exit"), { __mockExit: true });
  };
  try {
    main(argv, overrides);
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    console.error = origErr;
    console.log = origLog;
    process.exit = origExit;
  }
  return { exitCode, errs };
}

test("main(): cenário real da issue via overrides — fallback 2 ciclos pra trás do sinal de atividade -> exit 1, mensagem explica o guard", () => {
  const { exitCode, errs } = captureMain([], {
    resolveCycle: () => makeResolveResult("2605-06", true),
    activityDeps: activityDeps({ cycles: ["2607-08"], activity: { "2607-08": true } }),
  });
  assert.equal(exitCode, 1);
  assert.ok(errs.some((e) => /fallback caiu mais de 1 ciclo/.test(e)));
  assert.ok(errs.some((e) => /2607-08/.test(e)));
});

test("main(): fallback legítimo (sem atividade recente em data/clarice-subscribers/) -> cai peacefully, não aborta", () => {
  const { exitCode, errs } = captureMain([], {
    resolveCycle: () => makeResolveResult("2605-06", true),
    activityDeps: activityDeps({ cycles: [], activity: {} }),
  });
  assert.equal(exitCode, undefined);
  assert.ok(errs.some((e) => /ciclo mais recente não estava pronto/.test(e)));
  assert.ok(!errs.some((e) => /fallback caiu mais de 1 ciclo/.test(e)));
});

test("main(): --subject explícito destrava o bloqueio mesmo com divergência >1 ciclo", () => {
  const { exitCode, errs } = captureMain(["--subject", "Assunto explícito"], {
    resolveCycle: (subjectOverride) => ({
      ...makeResolveResult("2605-06", true),
      subject: subjectOverride ?? "Assunto qualquer",
    }),
    activityDeps: activityDeps({ cycles: ["2607-08"], activity: { "2607-08": true } }),
  });
  assert.equal(exitCode, undefined);
  assert.ok(!errs.some((e) => /fallback caiu mais de 1 ciclo/.test(e)));
  // ainda deixa rastro auditável da divergência mesmo destravado
  assert.ok(errs.some((e) => /diverge/.test(e)));
});

test("main(): sem fallback (ciclo mais recente candidato já pronto) -> guard não interfere mesmo com atividade divergente", () => {
  const { exitCode, errs } = captureMain([], {
    resolveCycle: () => makeResolveResult("2607-08", false),
    activityDeps: activityDeps({ cycles: ["2605-06"], activity: { "2605-06": true } }),
  });
  assert.equal(exitCode, undefined);
  assert.ok(errs.some((e) => /ciclo resolvido: 2607-08/.test(e)));
  assert.ok(!errs.some((e) => /diverge/.test(e)));
});
