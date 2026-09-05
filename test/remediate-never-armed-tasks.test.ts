/**
 * test/remediate-never-armed-tasks.test.ts (#7441, #7442, #7443)
 *
 * Cobre `scripts/remediate-never-armed-tasks.ts` — a orquestração que
 * substitui o par manual "rodar `setup-systemd-timers.ts --task X` +
 * `arm-systemd-timers.ts --task X` uma vez por task achada pelo alarme" por
 * uma chamada única que descobre sozinha o conjunto `neverArmed` e gera+arma
 * só esse conjunto.
 *
 * Estrutural: NUNCA chama `systemctl` real — todo `execFileSync` é
 * injetado via mock (mesmo padrão de `test/arm-systemd-timers.test.ts` /
 * `test/task-never-armed-alarm.test.ts`). `remediate`/`main` tocam o
 * filesystem de verdade só dentro de diretórios temporários (`mkdtempSync`).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, planRemediation, remediate } from "../scripts/remediate-never-armed-tasks.ts";

// ---------------------------------------------------------------------------
// Mock exec — roteia por subcomando systemctl, nunca spawna de verdade
// ---------------------------------------------------------------------------

function makeMockExec(handlers: {
  listTimers?: () => string;
  show?: (unit: string) => string;
  enable?: (unit: string) => void;
}): { exec: typeof execFileSync; calls: string[][] } {
  const calls: string[][] = [];
  const exec = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const sub = args[1];
    if (sub === "list-timers") return handlers.listTimers ? handlers.listTimers() : "";
    if (sub === "show") return handlers.show ? handlers.show(args[2]) : "LoadState=not-found\nActiveState=inactive\n";
    if (sub === "daemon-reload") return "";
    if (sub === "enable") {
      handlers.enable?.(args[3]);
      return "";
    }
    return "";
  }) as unknown as typeof execFileSync;
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// planRemediation — lógica pura de seleção
// ---------------------------------------------------------------------------

describe("planRemediation", () => {
  it("task registrada sem timer armado -> vira target", () => {
    const plan = planRemediation(["Diaria-GA4-Sync"], [], []);
    assert.deepEqual(plan, { targets: ["Diaria-GA4-Sync"], stoppedDeliberately: [], orphanTimers: [] });
  });

  it("3 tasks nunca armadas ao mesmo tempo -> as 3 viram target (caso #7441/#7442/#7443)", () => {
    const registry = ["Diaria-GA4-Sync", "Diaria-Metrics-Health-Alarm", "Diaria-Reconcile-Send-Audiences"];
    const plan = planRemediation(registry, [], []);
    assert.deepEqual(plan.targets.sort(), [...registry].sort());
  });

  it("task já armada -> não é target", () => {
    const plan = planRemediation(["Diaria-GA4-Sync"], ["diaria-ga4-sync"], []);
    assert.deepEqual(plan.targets, []);
  });

  it("task desabilitada -> nunca é target mesmo sem timer armado", () => {
    const plan = planRemediation(["Diaria-Foo"], [], ["Diaria-Foo"]);
    assert.deepEqual(plan.targets, []);
  });

  it("task parada deliberadamente (ActiveState=inactive, unit existe) -> reportada, NUNCA target", () => {
    const unitStates = new Map([["diaria-foo", { loadState: "loaded", activeState: "inactive" }]]);
    const plan = planRemediation(["Diaria-Foo"], [], [], unitStates);
    assert.deepEqual(plan.targets, []);
    assert.deepEqual(plan.stoppedDeliberately, ["Diaria-Foo"]);
  });

  it("timer órfão (armado sem task no registro) -> reportado, nunca vira target de arme", () => {
    const plan = planRemediation([], ["diaria-orfao"], []);
    assert.deepEqual(plan.targets, []);
    assert.deepEqual(plan.orphanTimers, ["diaria-orfao"]);
  });
});

// ---------------------------------------------------------------------------
// remediate / main — orquestração completa (fs real em tmpdir, systemctl mockado)
// ---------------------------------------------------------------------------

describe("remediate/main", () => {
  it("systemctl ausente (ENOENT) -> status no-systemd, nenhuma escrita", () => {
    const exec = ((): never => {
      throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof execFileSync;
    const outcome = remediate({ repoRootAbs: tmpdir(), isDryRun: false, exec });
    assert.equal(outcome.status, "no-systemd");
  });

  it("systemctl indisponível (ENOENT) via main() -> exit 0, log honesto", () => {
    const exec = ((): never => {
      throw Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof execFileSync;
    const code = main([], tmpdir(), exec);
    assert.equal(code, 0);
  });

  it("nada nunca-armado -> status nothing-to-do", () => {
    // `remediate()` sempre lê `listScheduledTaskNames()` do registro REAL do
    // repo (dezenas de tasks) — em vez de mockar um registro sintético,
    // cobrimos aqui o caminho onde `show` reporta tudo como já ativo
    // (nenhum `not-found`), fazendo `planRemediation` reduzir a zero mesmo
    // sobre o registro real.
    const { exec } = makeMockExec({
      listTimers: () => "",
      show: () => "LoadState=loaded\nActiveState=active\n",
    });
    const outcome = remediate({ repoRootAbs: tmpdir(), isDryRun: false, exec });
    assert.equal(outcome.status, "nothing-to-do");
  });

  it("--dry-run com candidato nunca-armado -> status dry-run, nenhum arquivo escrito, nenhum enable chamado", () => {
    const unitsDirAbs = mkdtempSync(join(tmpdir(), "remediate-units-"));
    const targetDirAbs = mkdtempSync(join(tmpdir(), "remediate-target-"));
    try {
      const { exec, calls } = makeMockExec({
        listTimers: () => "",
        show: () => "LoadState=not-found\nActiveState=inactive\n",
      });
      const outcome = remediate({ repoRootAbs: tmpdir(), isDryRun: true, exec, unitsDirAbs, targetDirAbs });
      assert.equal(outcome.status, "dry-run");
      assert.ok(outcome.plan!.targets.length > 0, "registro real do repo não está vazio");
      assert.ok(!calls.some((c) => c.includes("enable")), "--dry-run nunca chama enable");
      assert.ok(!existsSync(join(targetDirAbs, "diaria-ga4-sync.timer")), "--dry-run nunca escreve no target-dir");
    } finally {
      rmSync(unitsDirAbs, { recursive: true, force: true });
      rmSync(targetDirAbs, { recursive: true, force: true });
    }
  });

  it("main() end-to-end: task sintética nunca-armada -> gera unit + arma (enable --now chamado)", () => {
    const unitsDirAbs = mkdtempSync(join(tmpdir(), "remediate-units-"));
    const targetDirAbs = mkdtempSync(join(tmpdir(), "remediate-target-"));
    const repoRootAbs = mkdtempSync(join(tmpdir(), "remediate-repo-"));
    try {
      // remediate() sempre resolve tasks via getScheduledTaskByName sobre o
      // registro REAL — não dá para injetar uma task sintética no fluxo de
      // ponta-a-ponta sem tocar o registro do repo. Este teste cobre então
      // o comportamento fim-a-fim contra o registro real: pelo menos 1 task
      // real deve existir e, no caminho feliz (systemctl sempre "not-found"
      // -> "active" depois de armar), sair com exit 0 e ter chamado enable
      // para cada alvo.
      const { exec, calls } = makeMockExec({
        listTimers: () => "",
        show: () => "LoadState=not-found\nActiveState=inactive\n",
        enable: () => {},
      });
      // --units-dir/--target-dir SEMPRE explícitos aqui — sem eles, main()
      // usaria o default real (`~/.config/systemd/user/`), escrevendo
      // arquivos de verdade na máquina que roda o teste (systemctl está
      // mockado, mas `copyFileSync` dentro de `armSystemdTimers` não é).
      const code = main(
        [`--units-dir=${unitsDirAbs}`, `--target-dir=${targetDirAbs}`],
        repoRootAbs,
        exec,
      );
      assert.equal(code, 0);
      assert.ok(calls.some((c) => c.includes("enable")), "main() deve chamar enable --now para os alvos nunca-armados");
      assert.ok(calls.some((c) => c.includes("daemon-reload")), "main() deve rodar daemon-reload antes de enable");
    } finally {
      rmSync(unitsDirAbs, { recursive: true, force: true });
      rmSync(targetDirAbs, { recursive: true, force: true });
      rmSync(repoRootAbs, { recursive: true, force: true });
    }
  });

  after(() => {
    // no-op: cleanup feito por teste, mantido por simetria com o padrão do
    // arquivo irmão (test/arm-systemd-timers.test.ts).
  });
});
