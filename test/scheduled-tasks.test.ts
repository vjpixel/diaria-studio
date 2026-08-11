/**
 * test/scheduled-tasks.test.ts (#4805 Fase 1)
 *
 * Cobertura de `scripts/lib/scheduled-tasks.ts`: estrutura do registro
 * (nomes únicos, steps não-vazios, scripts existentes de verdade) +
 * PARIDADE com os `setup-*-schedule.ps1`/`run-*.ps1` legados que cada
 * entrada espelha — trava a regressão "registro e `.ps1` divergiram" (ex:
 * alguém muda o horário no `.ps1` e esquece do registro, ou vice-versa).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getScheduledTaskByName,
  listScheduledTaskNames,
  SCHEDULED_TASKS,
  type WeekDay,
} from "../scripts/lib/scheduled-tasks.ts";
import { parseTaskNameFromSetupScript } from "../scripts/lib/pending-scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function logicalLines(source: string): string[] {
  return source
    .replace(/`\r?\n\s*/g, " ") // colapsa continuações de linha do PowerShell
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l));
}

describe("SCHEDULED_TASKS — estrutura do registro", () => {
  it("tem pelo menos 1 task (senão o registro está vazio por engano)", () => {
    assert.ok(SCHEDULED_TASKS.length > 0);
  });

  it("nomes de task são únicos (sem duplicata)", () => {
    const names = SCHEDULED_TASKS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, `nomes duplicados: ${names.join(", ")}`);
  });

  it("todo TaskName segue o prefixo Diaria- (convenção do repo)", () => {
    for (const t of SCHEDULED_TASKS) {
      assert.match(t.name, /^Diaria-/, `task "${t.name}" não segue o prefixo Diaria-`);
    }
  });

  it("toda task tem pelo menos 1 step", () => {
    for (const t of SCHEDULED_TASKS) {
      assert.ok(t.steps.length > 0, `task "${t.name}" sem steps`);
    }
  });

  it("todo step.script referencia um arquivo .ts que existe de verdade no repo", () => {
    for (const t of SCHEDULED_TASKS) {
      for (const step of t.steps) {
        const abs = resolve(ROOT, ...step.script.split("/"));
        assert.ok(existsSync(abs), `task "${t.name}" step "${step.key}": script não encontrado: ${step.script}`);
      }
    }
  });

  it("todo legacySetupScript (quando presente) referencia um .ps1 que existe de verdade no repo", () => {
    // #5005: legacySetupScript é opcional pra task registrada depois do
    // cutover systemd (épica #4798) — sem contraparte Windows/.ps1.
    for (const t of SCHEDULED_TASKS) {
      if (!t.legacySetupScript) continue;
      const abs = resolve(ROOT, ...t.legacySetupScript.split("/"));
      assert.ok(existsSync(abs), `task "${t.name}": legacySetupScript não encontrado: ${t.legacySetupScript}`);
    }
  });

  it("schedule.kind é sempre daily, weekly ou interval com campos válidos", () => {
    const validDays: WeekDay[] = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    for (const t of SCHEDULED_TASKS) {
      const s = t.schedule;
      if (s.kind === "daily" || s.kind === "weekly") {
        assert.ok(s.hour >= 0 && s.hour <= 23, `task "${t.name}": hour fora do intervalo: ${s.hour}`);
        assert.ok(s.minute >= 0 && s.minute <= 59, `task "${t.name}": minute fora do intervalo: ${s.minute}`);
      }
      if (s.kind === "weekly") {
        assert.ok(validDays.includes(s.dayOfWeek), `task "${t.name}": dayOfWeek inválido: ${s.dayOfWeek}`);
      }
      if (s.kind === "interval") {
        assert.ok(s.hours > 0, `task "${t.name}": interval.hours deve ser > 0`);
      }
    }
  });

  it("guard (quando presente) tem requiredFile e abortMessage não-vazios", () => {
    for (const t of SCHEDULED_TASKS) {
      if (!t.guard) continue;
      assert.ok(t.guard.requiredFile.length > 0, `task "${t.name}": guard.requiredFile vazio`);
      assert.ok(t.guard.abortMessage.length > 0, `task "${t.name}": guard.abortMessage vazio`);
    }
  });
});

describe("getScheduledTaskByName / listScheduledTaskNames", () => {
  it("getScheduledTaskByName retorna a definição correta por nome exato", () => {
    const t = getScheduledTaskByName("Diaria-Apoios-Diff-Alarm");
    assert.ok(t);
    assert.equal(t!.name, "Diaria-Apoios-Diff-Alarm");
  });

  it("getScheduledTaskByName retorna undefined pra nome desconhecido", () => {
    assert.equal(getScheduledTaskByName("Diaria-Nao-Existe"), undefined);
  });

  it("getScheduledTaskByName é case-sensitive (nome exato do Task Scheduler)", () => {
    assert.equal(getScheduledTaskByName("diaria-apoios-diff-alarm"), undefined);
  });

  it("listScheduledTaskNames retorna os mesmos nomes de SCHEDULED_TASKS, na mesma ordem", () => {
    assert.deepEqual(
      listScheduledTaskNames(),
      SCHEDULED_TASKS.map((t) => t.name),
    );
  });
});

describe("paridade registro <-> .ps1 legado (evita divergência silenciosa)", () => {
  // #5005: task sem legacySetupScript (registrada depois do cutover
  // systemd) não tem .ps1 pra comparar — sem parity a checar.
  for (const t of SCHEDULED_TASKS) {
    if (!t.legacySetupScript) continue;
    it(`${t.name}: o $TaskName do .ps1 legado bate com task.name`, () => {
      const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
      const parsedName = parseTaskNameFromSetupScript(source, t.legacySetupScript);
      assert.equal(parsedName, t.name);
    });

    if (t.schedule.kind === "daily") {
      it(`${t.name}: schedule daily bate com New-ScheduledTaskTrigger -Daily -At Hour/Minute do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const trigger = logicalLines(source).find((l) => /New-ScheduledTaskTrigger/i.test(l));
        assert.ok(trigger, "nenhum New-ScheduledTaskTrigger encontrado");
        assert.match(trigger!, /-Daily\b/);
        const hour = Number((trigger!.match(/-Hour\s+(\d+)/i) ?? [])[1]);
        const minute = Number((trigger!.match(/-Minute\s+(\d+)/i) ?? [])[1]);
        assert.equal(hour, t.schedule.hour, `hora: registro=${t.schedule.hour} .ps1=${hour}`);
        assert.equal(minute, t.schedule.minute, `minuto: registro=${t.schedule.minute} .ps1=${minute}`);
      });
    }

    if (t.schedule.kind === "weekly") {
      it(`${t.name}: schedule weekly bate com New-ScheduledTaskTrigger -Weekly -DaysOfWeek/-At do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const trigger = logicalLines(source).find((l) => /New-ScheduledTaskTrigger/i.test(l));
        assert.ok(trigger, "nenhum New-ScheduledTaskTrigger encontrado");
        assert.match(trigger!, /-Weekly\b/);
        assert.match(
          trigger!,
          new RegExp(`-DaysOfWeek\\s+${t.schedule.dayOfWeek}\\b`),
          `dayOfWeek: registro=${t.schedule.dayOfWeek}, trigger=${trigger}`,
        );
        const hour = Number((trigger!.match(/-Hour\s+(\d+)/i) ?? [])[1]);
        const minute = Number((trigger!.match(/-Minute\s+(\d+)/i) ?? [])[1]);
        assert.equal(hour, t.schedule.hour, `hora: registro=${t.schedule.hour} .ps1=${hour}`);
        assert.equal(minute, t.schedule.minute, `minuto: registro=${t.schedule.minute} .ps1=${minute}`);
      });
    }

    if (t.schedule.kind === "interval") {
      it(`${t.name}: schedule interval bate com -RepetitionInterval (New-TimeSpan -Hours N) do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const trigger = logicalLines(source).find((l) => /New-ScheduledTaskTrigger/i.test(l));
        assert.ok(trigger, "nenhum New-ScheduledTaskTrigger encontrado");
        assert.match(trigger!, /-Once\b/);
        const hours = Number((trigger!.match(/-RepetitionInterval\s+\(New-TimeSpan\s+-Hours\s+(\d+)\)/i) ?? [])[1]);
        assert.equal(hours, t.schedule.hours, `interval: registro=${t.schedule.hours}h .ps1=${hours}h`);
      });
    }
  }
});

describe("registro <-> scripts/run-*.ps1: mesmos scripts .ts invocados (ordem preservada)", () => {
  // Só cobre as tasks cujo run-*.ps1 chama scripts .ts diretamente por nome
  // literal (todas as 14 do #4805) — não tenta reconstruir a invocação
  // completa (args), só confirma que nenhum passo do registro ficou órfão
  // do .ps1 correspondente (e vice-versa) por script basename.
  const RUNNER_BY_TASK: Record<string, string> = {
    "Diaria-Apoios-Diff-Alarm": "scripts/run-apoios-diff-alarm.ps1",
    "Diaria-Brevo-Diaria-Guardrail": "scripts/run-check-brevo-diaria-guardrail.ps1",
    "Diaria-Clarice-Guardrail-Alarm": "scripts/run-clarice-guardrail-alarm.ps1",
    "Diaria-Clarice-Novos": "scripts/run-clarice-novos.ps1",
    "Diaria-Clarice-Opens-Catchup-Alarm": "scripts/run-clarice-opens-catchup-alarm.ps1",
    "Diaria-Clarice-Sync": "scripts/run-clarice-sync-daily.ps1",
    "Diaria-Cursos-Error-Alarm": "scripts/run-cursos-error-alarm.ps1",
    "Diaria-Cursos-Kv-Sync": "scripts/run-cursos-kv-sync.ps1",
    "Diaria-Brevo-Diaria-Evaluate": "scripts/run-evaluate-brevo-diaria.ps1",
    "Diaria-Geo-Citation-Monitor": "scripts/run-geo-citation-monitor.ps1",
    "Diaria-Geo-Citation-Staleness-Alarm": "scripts/run-geo-citation-staleness-alarm.ps1",
    "Diaria-Hub-Drift-Check": "scripts/run-hub-drift-check.ps1",
    "Diaria-Postmaster-Spam-Sync": "scripts/run-postmaster-spam-sync.ps1",
    "Diaria-Robots-Txt-Drift-Check": "scripts/run-robots-txt-drift-check.ps1",
    "Diaria-SEO-Weekly": "scripts/run-seo-weekly.ps1",
    "Diaria-Worker-Drift-Check": "scripts/run-worker-drift-check.ps1",
  };

  it("toda task COM legacySetupScript tem um run-*.ps1 mapeado neste teste (nenhum órfão)", () => {
    // #5005: task sem legacySetupScript não tem `.ps1` nenhum — nem
    // setup nem run — por design (ver docstring do campo).
    for (const t of SCHEDULED_TASKS) {
      if (!t.legacySetupScript) continue;
      assert.ok(RUNNER_BY_TASK[t.name], `task "${t.name}" sem run-*.ps1 mapeado em RUNNER_BY_TASK`);
    }
  });

  for (const [taskName, runnerRelPath] of Object.entries(RUNNER_BY_TASK)) {
    it(`${taskName}: todo step.script do registro aparece (por basename) no ${runnerRelPath}`, () => {
      const task = getScheduledTaskByName(taskName);
      assert.ok(task, `task "${taskName}" não encontrada no registro`);
      const runnerSource = readFileSync(resolve(ROOT, ...runnerRelPath.split("/")), "utf8");
      for (const step of task!.steps) {
        const basename = step.script.split("/").pop()!;
        assert.match(
          runnerSource,
          new RegExp(basename.replace(".", "\\.")),
          `script "${basename}" (step "${step.key}") não aparece em ${runnerRelPath}`,
        );
      }
    });
  }
});

describe("#5005 — Diaria-Beehiiv-Home-Meta-Check registrada, systemd-only (sem .ps1 legado)", () => {
  it("está presente no registro, com o step apontando pro script correto", () => {
    const t = getScheduledTaskByName("Diaria-Beehiiv-Home-Meta-Check");
    assert.ok(t, "Diaria-Beehiiv-Home-Meta-Check ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/beehiiv-home-meta-check.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "interval", hours: 6 });
  });

  it("NÃO tem legacySetupScript (task registrada depois do cutover systemd, épica #4798)", () => {
    const t = getScheduledTaskByName("Diaria-Beehiiv-Home-Meta-Check");
    assert.ok(t);
    assert.equal(t!.legacySetupScript, undefined);
  });
});

describe("#4451 — Diaria-Clarice-Cohorts-Crawl registrada, roda o v2, systemd-only (sem .ps1 legado)", () => {
  it("está presente no registro, com o step apontando pro script v2 (não o v1)", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Cohorts-Crawl");
    assert.ok(t, "Diaria-Clarice-Cohorts-Crawl ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/clarice-engagement-cohorts-v2.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 21, minute: 0 });
  });

  it("o step passa --out apontando para dentro de data/ (path explícito, cwd é a raiz do repo)", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Cohorts-Crawl");
    assert.ok(t);
    const args = t!.steps[0].args ?? [];
    const outIdx = args.indexOf("--out");
    assert.ok(outIdx >= 0, "--out ausente dos args do step");
    assert.match(args[outIdx + 1], /^data\//, "--out precisa começar com data/ (cwd do step é a raiz do repo)");
  });

  it("o step passa --push (#5015 — sem isso a task roda mas nunca atualiza o KV que o dashboard lê)", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Cohorts-Crawl");
    assert.ok(t);
    const args = t!.steps[0].args ?? [];
    assert.ok(args.includes("--push"), "--push ausente dos args do step");
  });

  it("NÃO tem legacySetupScript (a task Windows DiariaCohortsCrawl nunca existiu neste registro — registro do zero pro v2, #4451)", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Cohorts-Crawl");
    assert.ok(t);
    assert.equal(t!.legacySetupScript, undefined);
  });
});
