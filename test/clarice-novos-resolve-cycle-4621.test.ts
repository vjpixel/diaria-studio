/**
 * test/clarice-novos-resolve-cycle-4621.test.ts (#4621)
 *
 * Achado ao vivo 260804: `clarice-novos-resolve-cycle.ts` caiu (D3, fallback
 * legítimo por design) do ciclo corrente `2607-08` pro ciclo `2605-06` — o
 * digest de MAIO, ~2 meses desatualizado — porque `2607-08` não tinha
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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync as realExistsSync,
  statSync as realStatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cycleMonthDistance,
  mostRecentActiveClariceCycle,
  evaluateClariceActivityGuard,
  type ClariceActivityDeps,
  type ResolveLatestMonthlyCycleResult,
} from "../scripts/lib/mensal/monthly-paths.ts";
import { cycleHasClariceActivity, listClariceCycleDirs, type ClariceCycleFsOps } from "../scripts/lib/clarice-paths.ts";
import { main } from "../scripts/clarice-novos-resolve-cycle.ts";

/** Fs ops de teste: existsSync/statSync reais + readdirSync que sempre lança (simula EBUSY/EPERM). */
function throwingFsOps(err: NodeJS.ErrnoException): ClariceCycleFsOps {
  return {
    existsSync: realExistsSync,
    statSync: realStatSync,
    // @ts-expect-error -- assinatura mínima suficiente pro caso de teste (sem opts, sem overloads)
    readdirSync: () => {
      throw err;
    },
  };
}

function activityDeps(overrides: {
  cycles?: string[];
  activity?: Record<string, boolean>;
  ioErrors?: string[];
}): ClariceActivityDeps {
  const cycles = overrides.cycles ?? [];
  const activity = overrides.activity ?? {};
  const ioErrors = overrides.ioErrors ?? [];
  return {
    listCyclesWithClariceDir: () => cycles,
    cycleHasActivity: (c) => activity[c] ?? false,
    ioErrors: () => ioErrors,
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

// ── Erro de IO não-ENOENT: fail-closed mas VISÍVEL, não fail-open silencioso
// (#4621 follow-up, silent-failure-hunter). Injeta readdirSync mockado que
// lança EBUSY (lock do OneDrive, p.ex.) — diferente de "pasta não existe"
// (que existsSync já filtra ANTES do try, sem tocar o mock).

test("cycleHasClariceActivity: readdirSync lança EBUSY -> false, mas onError é chamado com o motivo (não é 'sem atividade' silencioso)", () => {
  const root = mkdtempSync(join(tmpdir(), "clarice-activity-ebusy-"));
  try {
    mkdirSync(join(root, "2607-08"), { recursive: true });
    const errors: string[] = [];
    const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    const result = cycleHasClariceActivity("2607-08", root, (msg) => errors.push(msg), throwingFsOps(err));
    assert.equal(result, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /EBUSY|resource busy/);
    assert.match(errors[0], /cycleHasClariceActivity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cycleHasClariceActivity: onError default (sem override) imprime warning no stderr em erro de IO", () => {
  const root = mkdtempSync(join(tmpdir(), "clarice-activity-ebusy-default-"));
  try {
    mkdirSync(join(root, "2607-08"), { recursive: true });
    const origErr = console.error;
    const captured: string[] = [];
    console.error = (...a: unknown[]) => captured.push(a.join(" "));
    try {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      const result = cycleHasClariceActivity("2607-08", root, undefined, throwingFsOps(err));
      assert.equal(result, false);
    } finally {
      console.error = origErr;
    }
    assert.ok(captured.some((line) => /EPERM|permission denied/.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listClariceCycleDirs: readdirSync lança EBUSY -> [], mas onError é chamado (comportamento visível difere de 'base genuinamente vazia')", () => {
  const root = mkdtempSync(join(tmpdir(), "clarice-list-ebusy-"));
  try {
    const errors: string[] = [];
    const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    const result = listClariceCycleDirs(root, (msg) => errors.push(msg), throwingFsOps(err));
    assert.deepEqual(result, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /EBUSY|resource busy/);
    assert.match(errors[0], /listClariceCycleDirs/);

    // Contraste explícito: base genuinamente vazia (sem erro) -> [] SEM chamar onError.
    const cleanErrors: string[] = [];
    const cleanResult = listClariceCycleDirs(root, (msg) => cleanErrors.push(msg));
    assert.deepEqual(cleanResult, []);
    assert.equal(cleanErrors.length, 0);
    assert.notEqual(errors.length, cleanErrors.length); // comportamento visível DIFERE entre os dois "[]"
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("evaluateClariceActivityGuard: ioErrors da deps propaga pro resultado (mesmo sem nenhum ciclo ativo encontrado)", () => {
  const deps = activityDeps({ cycles: [], activity: {}, ioErrors: ["listClariceCycleDirs: falha ao listar ... (EBUSY)"] });
  const guard = evaluateClariceActivityGuard("2605-06", true, false, deps);
  assert.equal(guard.activeCycle, undefined); // sinal aparentemente "sem atividade" -- mas...
  assert.deepEqual(guard.ioErrors, ["listClariceCycleDirs: falha ao listar ... (EBUSY)"]); // ...não é confiável
});

test("evaluateClariceActivityGuard: sem fallback -> ioErrors sempre [] (guard não avalia, não deveria ter lido nada)", () => {
  const deps = activityDeps({ cycles: [], activity: {}, ioErrors: ["nunca deveria aparecer aqui"] });
  const guard = evaluateClariceActivityGuard("2605-06", /* fallback */ false, false, deps);
  assert.deepEqual(guard.ioErrors, []);
});

test("evaluateClariceActivityGuard: sem erro de IO -> ioErrors == []", () => {
  const deps = activityDeps({ cycles: ["2607-08"], activity: { "2607-08": true } });
  const guard = evaluateClariceActivityGuard("2605-06", true, false, deps);
  assert.deepEqual(guard.ioErrors, []);
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

// ── main(): erro de IO durante o guard não pode virar "sem atividade" silencioso
// (#4621 follow-up, silent-failure-hunter) ──────────────────────────────────

test("main(): ioErrors não-vazio sem --subject -> ABORTA (exit 1) com warning distinto, mesmo que activeCycle pareça undefined", () => {
  const { exitCode, errs } = captureMain([], {
    resolveCycle: () => makeResolveResult("2605-06", true),
    activityDeps: activityDeps({ cycles: [], activity: {}, ioErrors: ["listClariceCycleDirs: falha ao listar data/clarice-subscribers/ (EBUSY)"] }),
  });
  assert.equal(exitCode, 1);
  assert.ok(errs.some((e) => /erro\(s\) de IO/.test(e)));
  assert.ok(errs.some((e) => /não conseguiu ler.*com confiança/.test(e)));
  // Não pode ser confundido com o caminho "sem atividade" que segue em frente:
  assert.ok(!errs.some((e) => /ciclo mais recente não estava pronto/.test(e)));
});

test("main(): ioErrors não-vazio COM --subject explícito -> não aborta, mas ainda avisa o erro de IO", () => {
  const { exitCode, errs } = captureMain(["--subject", "Assunto explícito"], {
    resolveCycle: (subjectOverride) => ({
      ...makeResolveResult("2605-06", true),
      subject: subjectOverride ?? "Assunto qualquer",
    }),
    activityDeps: activityDeps({ cycles: [], activity: {}, ioErrors: ["listClariceCycleDirs: falha ao listar data/clarice-subscribers/ (EBUSY)"] }),
  });
  assert.equal(exitCode, undefined);
  assert.ok(errs.some((e) => /erro\(s\) de IO/.test(e)));
  assert.ok(!errs.some((e) => /não conseguiu ler.*com confiança/.test(e))); // não abortou
});
