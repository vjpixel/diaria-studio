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
import { parseTaskNamesFromSetupScript } from "../scripts/lib/pending-scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function logicalLines(source: string): string[] {
  return source
    .replace(/`\r?\n\s*/g, " ") // colapsa continuações de linha do PowerShell
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l));
}

/** Todas as linhas de `New-ScheduledTaskTrigger` do script — plural desde
 * 260811, quando `setup-clarice-envio-schedule.ps1` passou a registrar DUAS
 * tasks (19:00 + 05:00) no mesmo arquivo. Enquanto o script tem uma task só,
 * a lista tem 1 elemento e as asserções abaixo valem exatamente como antes. */
function triggerLines(source: string): string[] {
  return logicalLines(source).filter((l) => /New-ScheduledTaskTrigger/i.test(l));
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

  it("todo legacySetupScript referencia um .ps1 que existe de verdade no repo", () => {
    for (const t of SCHEDULED_TASKS) {
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
  for (const t of SCHEDULED_TASKS) {
    it(`${t.name}: o .ps1 legado declara um $TaskName igual a task.name`, () => {
      const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
      // `includes` e não igualdade com o PRIMEIRO nome: um script de setup
      // pode registrar mais de uma task (setup-clarice-envio-schedule.ps1
      // registra o par 19:00 + 05:00). Pra script de task única a lista tem 1
      // elemento e a asserção é a mesma de antes.
      const parsedNames = parseTaskNamesFromSetupScript(source, t.legacySetupScript);
      assert.ok(
        parsedNames.includes(t.name),
        `"${t.name}" não aparece entre os $TaskName de ${t.legacySetupScript} (achei: ${parsedNames.join(", ")})`,
      );
    });

    if (t.schedule.kind === "daily") {
      it(`${t.name}: schedule daily bate com algum New-ScheduledTaskTrigger -Daily -At Hour/Minute do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const triggers = triggerLines(source);
        assert.ok(triggers.length > 0, "nenhum New-ScheduledTaskTrigger encontrado");
        const schedule = t.schedule;
        const match = triggers.find(
          (trigger) =>
            /-Daily\b/.test(trigger) &&
            Number((trigger.match(/-Hour\s+(\d+)/i) ?? [])[1]) === schedule.hour &&
            Number((trigger.match(/-Minute\s+(\d+)/i) ?? [])[1]) === schedule.minute,
        );
        assert.ok(
          match,
          `nenhum trigger -Daily às ${schedule.hour}:${String(schedule.minute).padStart(2, "0")} ` +
            `em ${t.legacySetupScript}. Triggers do script:\n${triggers.map((l) => l.trim()).join("\n")}`,
        );
      });
    }

    if (t.schedule.kind === "weekly") {
      it(`${t.name}: schedule weekly bate com algum New-ScheduledTaskTrigger -Weekly -DaysOfWeek/-At do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const triggers = triggerLines(source);
        assert.ok(triggers.length > 0, "nenhum New-ScheduledTaskTrigger encontrado");
        const schedule = t.schedule;
        const match = triggers.find(
          (trigger) =>
            /-Weekly\b/.test(trigger) &&
            new RegExp(`-DaysOfWeek\\s+${schedule.dayOfWeek}\\b`).test(trigger) &&
            Number((trigger.match(/-Hour\s+(\d+)/i) ?? [])[1]) === schedule.hour &&
            Number((trigger.match(/-Minute\s+(\d+)/i) ?? [])[1]) === schedule.minute,
        );
        assert.ok(
          match,
          `nenhum trigger -Weekly ${schedule.dayOfWeek} às ${schedule.hour}:${String(schedule.minute).padStart(2, "0")} ` +
            `em ${t.legacySetupScript}. Triggers do script:\n${triggers.map((l) => l.trim()).join("\n")}`,
        );
      });
    }

    if (t.schedule.kind === "interval") {
      it(`${t.name}: schedule interval bate com algum -RepetitionInterval (New-TimeSpan -Hours N) do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const triggers = triggerLines(source);
        assert.ok(triggers.length > 0, "nenhum New-ScheduledTaskTrigger encontrado");
        const schedule = t.schedule;
        const match = triggers.find(
          (trigger) =>
            /-Once\b/.test(trigger) &&
            Number((trigger.match(/-RepetitionInterval\s+\(New-TimeSpan\s+-Hours\s+(\d+)\)/i) ?? [])[1]) ===
              schedule.hours,
        );
        assert.ok(
          match,
          `nenhum trigger -Once com -RepetitionInterval de ${schedule.hours}h em ${t.legacySetupScript}. ` +
            `Triggers do script:\n${triggers.map((l) => l.trim()).join("\n")}`,
        );
      });
    }
  }
});

describe("setup-*.ps1 que registram MAIS DE UMA task (260811)", () => {
  // A busca "algum trigger bate" do bloco acima é suficiente pra script de
  // task única (1 trigger), mas num script multi-task ela deixaria passar uma
  // TROCA de horário entre as duas tasks (cada asserção acharia o trigger da
  // outra). Estas checagens fecham esse buraco estruturalmente.
  const byScript = new Map<string, string[]>();
  for (const t of SCHEDULED_TASKS) {
    byScript.set(t.legacySetupScript, [...(byScript.get(t.legacySetupScript) ?? []), t.name]);
  }
  const shared = [...byScript.entries()].filter(([, names]) => names.length > 1);

  it("hoje só setup-clarice-envio-schedule.ps1 registra mais de uma task (par 19:00 + 05:00)", () => {
    assert.deepEqual(
      shared.map(([script]) => script),
      ["scripts/setup-clarice-envio-schedule.ps1"],
      "se um script novo passou a registrar N tasks, confirme que ele declara N triggers distintos " +
        "e acrescente a regressão de horário por variável abaixo",
    );
  });

  for (const [script, names] of shared) {
    it(`${script}: declara pelo menos ${names.length} triggers (um por task: ${names.join(", ")})`, () => {
      const source = readFileSync(resolve(ROOT, ...script.split("/")), "utf8");
      assert.ok(
        triggerLines(source).length >= names.length,
        `${names.length} tasks compartilham este script mas ele tem ${triggerLines(source).length} trigger(s) — ` +
          `duas tasks com horários diferentes não podem sair do mesmo New-ScheduledTaskTrigger`,
      );
    });
  }

  it("setup-clarice-envio-schedule.ps1: $Trigger é o das 19:00 e $GuardTrigger o das 05:00 (não trocados)", () => {
    const source = readFileSync(resolve(ROOT, "scripts", "setup-clarice-envio-schedule.ps1"), "utf8");
    const lines = logicalLines(source);
    const main = lines.find((l) => /^\s*\$Trigger\s*=.*New-ScheduledTaskTrigger/i.test(l));
    const guard = lines.find((l) => /^\s*\$GuardTrigger\s*=.*New-ScheduledTaskTrigger/i.test(l));
    assert.ok(main, "não achei a atribuição de $Trigger");
    assert.ok(guard, "não achei a atribuição de $GuardTrigger");
    assert.match(main!, /-Hour\s+19\b/, `$Trigger deveria ser 19:00 (planeja+agenda): ${main!.trim()}`);
    assert.match(guard!, /-Hour\s+5\b/, `$GuardTrigger deveria ser 05:00 (antes do disparo das 06:00): ${guard!.trim()}`);
  });

  it("o guard das 05:00 roda ANTES do disparo canônico das 06:00 BRT", () => {
    const guard = getScheduledTaskByName("Diaria-Clarice-Envio-Guard");
    assert.ok(guard);
    assert.equal(guard!.schedule.kind, "daily");
    if (guard!.schedule.kind !== "daily") return;
    assert.ok(
      guard!.schedule.hour * 60 + guard!.schedule.minute < 6 * 60,
      "a Brevo congela destinatários no AGENDAMENTO, não no envio — um guard que roda depois das " +
        "06:00 não segura mais o disparo do dia (mesma restrição do #4534)",
    );
  });

  it("o planejamento das 19:00 roda DEPOIS do Diaria-Clarice-Novos (17:00)", () => {
    const envio = getScheduledTaskByName("Diaria-Clarice-Envio");
    const novos = getScheduledTaskByName("Diaria-Clarice-Novos");
    assert.ok(envio && novos);
    assert.equal(envio!.schedule.kind, "daily");
    assert.equal(novos!.schedule.kind, "daily");
    if (envio!.schedule.kind !== "daily" || novos!.schedule.kind !== "daily") return;
    assert.ok(
      envio!.schedule.hour * 60 + envio!.schedule.minute >
        novos!.schedule.hour * 60 + novos!.schedule.minute,
      "os cadastros novos do dia precisam já estar no store quando a onda do dia seguinte é planejada",
    );
  });
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
    "Diaria-Clarice-Envio": "scripts/run-clarice-envio.ps1",
    "Diaria-Clarice-Envio-Guard": "scripts/run-clarice-envio-guard.ps1",
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

  it("todo SCHEDULED_TASKS tem um run-*.ps1 mapeado neste teste (nenhum órfão)", () => {
    for (const t of SCHEDULED_TASKS) {
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
