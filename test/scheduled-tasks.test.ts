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

/**
 * Acha a linha `New-ScheduledTaskTrigger` que de fato corresponde a
 * `taskName` dentro de `source` — necessário desde #5027, quando um `.ps1`
 * passou a declarar MAIS de 1 task (`setup-clarice-envio-schedule.ps1`
 * registra `Diaria-Clarice-Envio` E `Diaria-Clarice-Envio-Guard`, cada uma
 * com seu próprio `$Trigger`/`$GuardTrigger`). Pegar cegamente "o primeiro
 * `New-ScheduledTaskTrigger` do arquivo" (como o teste fazia até então)
 * silenciosamente valida o par errado sempre que há mais de 1 bloco — a
 * 2ª+ task nunca teria o próprio horário conferido de verdade.
 *
 * Resolve seguindo a mesma cadeia que o PowerShell segue em runtime:
 *   `$XxxTaskName = "taskName"` → acha o var (`$XxxTaskName`)
 *   → `Register-ScheduledTask ... -TaskName $XxxTaskName ... -Trigger $YyyTrigger ...`
 *     (bloco que registra ESSA task) → acha o var do trigger (`$YyyTrigger`)
 *   → `$YyyTrigger = New-ScheduledTaskTrigger ...` → a linha procurada.
 *
 * Retorna `null` (nunca lança) se qualquer elo da cadeia não bater — os
 * `it()` que chamam isto já fazem `assert.ok` no resultado, então uma
 * cadeia quebrada falha o teste com um `assert.ok(false)` legível, não um
 * throw de regex undefined.
 */
function findTriggerLineForTask(source: string, taskName: string): string | null {
  const lines = logicalLines(source);

  const varToLiteral = new Map<string, string>();
  for (const l of lines) {
    const m = l.match(/^\s*\$(\w+)\s*=\s*"([^"]+)"/);
    if (m) varToLiteral.set(m[1], m[2]);
  }
  const taskVar = [...varToLiteral.entries()].find(([, v]) => v === taskName)?.[0];
  if (!taskVar) return null;

  const registerLine = lines.find(
    (l) => /Register-ScheduledTask\b/.test(l) && new RegExp(`-TaskName\\s+\\$${taskVar}\\b`).test(l),
  );
  if (!registerLine) return null;
  const triggerVar = registerLine.match(/-Trigger\s+\$(\w+)\b/)?.[1];
  if (!triggerVar) return null;

  return (
    lines.find((l) => new RegExp(`^\\s*\\$${triggerVar}\\s*=.*New-ScheduledTaskTrigger`).test(l)) ?? null
  );
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
  //
  // #5027: um `.ps1` pode declarar MAIS de 1 task (o par
  // Diaria-Clarice-Envio/-Guard compartilha `setup-clarice-envio-schedule.ps1`)
  // — por isso o parser usado aqui é o plural
  // (`parseTaskNamesFromSetupScript`) com um `includes`, não igualdade 1:1;
  // a proteção contra órfão/duplicata continua vindo do teste de unicidade
  // de `SCHEDULED_TASKS` acima + do `describe` de PoC do par mais abaixo.
  for (const t of SCHEDULED_TASKS) {
    if (!t.legacySetupScript) continue;
    it(`${t.name}: o .ps1 legado declara um $...TaskName = "${t.name}"`, () => {
      const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
      const parsedNames = parseTaskNamesFromSetupScript(source, t.legacySetupScript);
      assert.ok(
        parsedNames.includes(t.name),
        `esperava "${t.name}" entre os nomes declarados em ${t.legacySetupScript}: [${parsedNames.join(", ")}]`,
      );
    });

    if (t.schedule.kind === "daily") {
      it(`${t.name}: schedule daily bate com New-ScheduledTaskTrigger -Daily -At Hour/Minute do .ps1`, () => {
        const source = readFileSync(resolve(ROOT, ...t.legacySetupScript.split("/")), "utf8");
        const trigger = findTriggerLineForTask(source, t.name);
        assert.ok(trigger, `nenhum New-ScheduledTaskTrigger resolvido pra "${t.name}" em ${t.legacySetupScript}`);
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
        const trigger = findTriggerLineForTask(source, t.name);
        assert.ok(trigger, `nenhum New-ScheduledTaskTrigger resolvido pra "${t.name}" em ${t.legacySetupScript}`);
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
        const trigger = findTriggerLineForTask(source, t.name);
        assert.ok(trigger, `nenhum New-ScheduledTaskTrigger resolvido pra "${t.name}" em ${t.legacySetupScript}`);
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
    "Diaria-Clarice-Envio": "scripts/run-clarice-envio.ps1",
    "Diaria-Clarice-Envio-Guard": "scripts/run-clarice-envio-guard.ps1",
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

describe("#5123 — Diaria-Hub-Staleness-Check registrada, diária, systemd-only (sem .ps1 legado)", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 09:30", () => {
    const t = getScheduledTaskByName("Diaria-Hub-Staleness-Check");
    assert.ok(t, "Diaria-Hub-Staleness-Check ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/hub-staleness-check.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 30 });
  });

  it("NÃO tem legacySetupScript (task registrada depois do cutover systemd, épica #4798)", () => {
    const t = getScheduledTaskByName("Diaria-Hub-Staleness-Check");
    assert.ok(t);
    assert.equal(t!.legacySetupScript, undefined);
  });

  it("horário de 09:30 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Hub-Staleness-Check" && t.schedule.hour === 9 && t.schedule.minute === 30,
    );
    assert.deepEqual(collisions, []);
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

describe("#5025/#5026/#5027 — par Diaria-Clarice-Envio / Diaria-Clarice-Envio-Guard", () => {
  it("Diaria-Clarice-Envio: presente, 19:00 diário, step aponta pro orquestrador correto", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Envio");
    assert.ok(t, "Diaria-Clarice-Envio ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/clarice-envio-run.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 19, minute: 0 });
  });

  it("Diaria-Clarice-Envio-Guard: presente, 05:00 diário, step aponta pro guard correto", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Envio-Guard");
    assert.ok(t, "Diaria-Clarice-Envio-Guard ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/clarice-envio-guard.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 5, minute: 0 });
  });

  it("as duas entradas compartilham o MESMO legacySetupScript (1 script, 2 tasks — de propósito, #5027)", () => {
    const run = getScheduledTaskByName("Diaria-Clarice-Envio");
    const guard = getScheduledTaskByName("Diaria-Clarice-Envio-Guard");
    assert.ok(run && guard);
    assert.equal(run!.legacySetupScript, "scripts/setup-clarice-envio-schedule.ps1");
    assert.equal(guard!.legacySetupScript, "scripts/setup-clarice-envio-schedule.ps1");
  });

  it("assimetria de guard é intencional: run TEM guard de clarice-users.db, guard NÃO tem guard nenhum", () => {
    const run = getScheduledTaskByName("Diaria-Clarice-Envio");
    const guard = getScheduledTaskByName("Diaria-Clarice-Envio-Guard");
    assert.ok(run && guard);
    assert.ok(run!.guard, "Diaria-Clarice-Envio deveria ter guard.requiredFile (mesma proteção do Clarice-Novos)");
    assert.equal(run!.guard!.requiredFile, "clarice-subscribers/clarice-users.db");
    assert.equal(
      guard!.guard,
      undefined,
      "Diaria-Clarice-Envio-Guard NÃO deve ter guard de pré-condição — ele É a rede de segurança, um guard que " +
        "aborta a rodada suprimiria justamente a checagem que pode segurar um disparo ruim",
    );
  });

  it("ordem: guard (05:00) roda ANTES do horário de disparo da campanha (06:00 BRT)", () => {
    const guard = getScheduledTaskByName("Diaria-Clarice-Envio-Guard");
    assert.ok(guard);
    assert.equal(guard!.schedule.kind, "daily");
    const s = guard!.schedule as { kind: "daily"; hour: number; minute: number };
    const guardMinutes = s.hour * 60 + s.minute;
    const dispatchMinutes = 6 * 60; // 06:00 BRT — memória do projeto: brevo-recipients-snapshot
    assert.ok(guardMinutes < dispatchMinutes, `guard (${s.hour}:${s.minute}) deveria rodar antes de 06:00`);
  });

  it("ordem: Diaria-Clarice-Envio (19:00) roda DEPOIS de Diaria-Clarice-Novos (17:00) — cadastros novos já no store", () => {
    const novos = getScheduledTaskByName("Diaria-Clarice-Novos");
    const envio = getScheduledTaskByName("Diaria-Clarice-Envio");
    assert.ok(novos && envio);
    assert.equal(novos!.schedule.kind, "daily");
    assert.equal(envio!.schedule.kind, "daily");
    const novosSched = novos!.schedule as { kind: "daily"; hour: number; minute: number };
    const envioSched = envio!.schedule as { kind: "daily"; hour: number; minute: number };
    const novosMinutes = novosSched.hour * 60 + novosSched.minute;
    const envioMinutes = envioSched.hour * 60 + envioSched.minute;
    assert.ok(envioMinutes > novosMinutes, "Diaria-Clarice-Envio deveria rodar depois de Diaria-Clarice-Novos");
  });
});
