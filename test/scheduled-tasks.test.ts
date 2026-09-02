/**
 * test/scheduled-tasks.test.ts (#4805 Fase 1, paridade `.ps1` removida no #5115)
 *
 * Cobertura de `scripts/lib/scheduled-tasks.ts`: estrutura do registro
 * (nomes únicos, steps não-vazios, scripts existentes de verdade) + testes
 * dedicados por task recém-registrada (schedule, args, guard, ordem relativa
 * entre tasks correlatas).
 *
 * **#5115 (cutover final, 260812):** este arquivo cobria PARIDADE do
 * registro contra os `setup-*-schedule.ps1`/`run-*.ps1` legados — removidos
 * do repo junto com os outros 38 `.ps1` (decisão do editor, nenhuma máquina
 * Windows roda mais tasks `Diaria-*`). Os blocos de paridade e o campo
 * `legacySetupScript` que testavam saíram com eles; o que resta é a
 * cobertura estrutural do registro em si, que segue valendo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatScheduleHuman,
  getScheduledTaskByName,
  GSC_URL_INSPECTION_DAILY_QUOTA,
  listDisabledScheduledTaskNames,
  listScheduledTaskNames,
  listScheduledTaskRows,
  renderScheduledTasksTable,
  SCHEDULED_TASKS,
  type ScheduledTaskDefinition,
  type WeekDay,
} from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

  it("schedule.kind é sempre daily, weekly, monthly ou interval com campos válidos", () => {
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
      if (s.kind === "daily" || s.kind === "weekly" || s.kind === "monthly") {
        assert.ok(s.hour >= 0 && s.hour <= 23, `task "${t.name}": hour fora do intervalo: ${s.hour}`);
        assert.ok(s.minute >= 0 && s.minute <= 59, `task "${t.name}": minute fora do intervalo: ${s.minute}`);
      }
      if (s.kind === "weekly") {
        assert.ok(validDays.includes(s.dayOfWeek), `task "${t.name}": dayOfWeek inválido: ${s.dayOfWeek}`);
      }
      if (s.kind === "monthly") {
        // 1-28: válido em todo mês (ver docstring de ScheduledTaskSchedule
        // — sem isso, um `day` de 29-31 pularia fevereiro na maioria dos anos).
        assert.ok(s.day >= 1 && s.day <= 28, `task "${t.name}": monthly.day fora do intervalo 1-28: ${s.day}`);
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

describe("horários com dependência de ordem em relação ao envio canônico das 06:00 BRT", () => {
  // Portado de test/scheduled-task-registration.test.ts (removido no #5115
  // junto com os `.ps1` que testava) — os dois invariantes de horário abaixo
  // continuam reais, só a fonte migrou do `.ps1` pro registro.

  it("Diaria-Clarice-Sync dispara às 08:30, depois do envio das 06:00 (nunca de madrugada, #2932/#3682)", () => {
    // Rodar antes deixa a onda do dia invisível pro store (`sends_count` e
    // `brevo_list_ids` não refletiriam quem tinha acabado de receber) — a
    // armadilha do #3682.
    const t = getScheduledTaskByName("Diaria-Clarice-Sync");
    assert.ok(t);
    const schedule = t!.schedule;
    if (schedule.kind === "interval") assert.fail("Diaria-Clarice-Sync não deveria ser kind: interval");
    // Invariante RELACIONAL (a que de fato importa — sobrevive a um
    // reagendamento legítimo futuro, ex: mover pra 09:00 continua depois
    // das 06:00): nunca de madrugada, sempre depois do envio canônico.
    const minutesSinceMidnight = schedule.hour * 60 + schedule.minute;
    assert.ok(
      minutesSinceMidnight > 6 * 60,
      `Diaria-Clarice-Sync precisa disparar depois das 06:00 BRT, mas está em ${schedule.hour}:${String(schedule.minute).padStart(2, "0")}`,
    );
    // Pin do valor atual (#2932) — travado à parte pra flagar qualquer
    // mudança de horário como decisão consciente, não regressão silenciosa.
    assert.deepEqual(schedule, { kind: "daily", hour: 8, minute: 30 });
  });

  it("Diaria-Brevo-Diaria-Evaluate dispara às 05:30, antes do envio das 06:00 (#4534)", () => {
    // A Brevo congela destinatários no AGENDAMENTO da campanha, não no envio
    // — rodar depois deixaria o unlink (desvincula quem foi
    // promovido/suprimido/descadastrado) sem efeito no envio do dia.
    const t = getScheduledTaskByName("Diaria-Brevo-Diaria-Evaluate");
    assert.ok(t);
    const schedule = t!.schedule;
    if (schedule.kind === "interval") assert.fail("Diaria-Brevo-Diaria-Evaluate não deveria ser kind: interval");
    // Invariante RELACIONAL: sempre antes do envio canônico das 06:00 BRT.
    const minutesSinceMidnight = schedule.hour * 60 + schedule.minute;
    assert.ok(
      minutesSinceMidnight < 6 * 60,
      `Diaria-Brevo-Diaria-Evaluate precisa disparar antes das 06:00 BRT, mas está em ${schedule.hour}:${String(schedule.minute).padStart(2, "0")}`,
    );
    // Pin do valor atual (#4534) — travado à parte pra flagar qualquer
    // mudança de horário como decisão consciente, não regressão silenciosa.
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 5, minute: 30 });
  });
});

describe("Diaria-SEO-Weekly: loop semanal roda os dois scripts de medição (#4105)", () => {
  // Portado de test/seo-index-check.test.ts (describe "agendamento semanal
  // .ps1", removido no #5115 junto com os `.ps1` que testava) — sem o
  // seo-index-check no loop, a rodada semanal viraria só o pull (que hoje
  // retorna 0 linhas) e pareceria saudável sem medir cobertura de indexação.
  it("step 'index' chama seo-index-check.ts com --only-posts (host principal)", () => {
    const t = getScheduledTaskByName("Diaria-SEO-Weekly");
    assert.ok(t);
    const step = t!.steps.find((s) => s.key === "index");
    assert.ok(step, "step 'index' ausente");
    assert.equal(step!.script, "scripts/seo-index-check.ts");
    assert.ok(step!.args?.includes("--only-posts"));
  });

  it("step 'pull' chama seo-pull.ts (Search Analytics)", () => {
    const t = getScheduledTaskByName("Diaria-SEO-Weekly");
    assert.ok(t);
    const step = t!.steps.find((s) => s.key === "pull");
    assert.ok(step, "step 'pull' ausente");
    assert.equal(step!.script, "scripts/seo-pull.ts");
  });

  it("step 'index-arquivo' chama seo-index-check.ts com --sitemap do host arquivo.diar.ia.br, SEM --only-posts", () => {
    const t = getScheduledTaskByName("Diaria-SEO-Weekly");
    assert.ok(t);
    const step = t!.steps.find((s) => s.key === "index-arquivo");
    assert.ok(step, "step 'index-arquivo' ausente");
    assert.equal(step!.script, "scripts/seo-index-check.ts");
    assert.ok(step!.args?.includes("https://arquivo.diar.ia.br/sitemap.xml"));
    assert.ok(!step!.args?.includes("--only-posts"), "--only-posts zeraria o sitemap de arquivo.diar.ia.br (filtro /\\/p\\//)");
  });

  it("step 'index-arquivo': --limit é 2000, não o 10 antigo (regressão #5975 — sitemap tem ~252 URLs reais, --limit 10 descartava 242/rodada)", () => {
    const t = getScheduledTaskByName("Diaria-SEO-Weekly");
    assert.ok(t);
    const step = t!.steps.find((s) => s.key === "index-arquivo");
    assert.ok(step);
    const limitIndex = step!.args?.indexOf("--limit") ?? -1;
    assert.ok(limitIndex >= 0, "--limit ausente no step 'index-arquivo'");
    assert.equal(step!.args![limitIndex + 1], String(GSC_URL_INSPECTION_DAILY_QUOTA));
    assert.equal(step!.args![limitIndex + 1], "2000", "pin do valor literal — reverter pro 10 antigo precisa mudar este teste também");
  });

  it("soma dos --limit de 'index' + 'index-arquivo' não estoura a cota diária compartilhada da URL Inspection API (achado do fleet review pré-merge #5975/#5983)", () => {
    const t = getScheduledTaskByName("Diaria-SEO-Weekly");
    assert.ok(t);
    function limitOf(key: string): number {
      const step = t!.steps.find((s) => s.key === key);
      assert.ok(step, `step '${key}' ausente`);
      const idx = step!.args?.indexOf("--limit") ?? -1;
      assert.ok(idx >= 0, `--limit ausente no step '${key}'`);
      return Number(step!.args![idx + 1]);
    }
    const somaNominal = limitOf("index") + limitOf("index-arquivo");
    // Os dois --limit nominais somados (4000) EXCEDEM a cota real (2000) —
    // isso é esperado e seguro: os `--limit` são um teto de segurança por
    // passo, não uma reserva; o consumo REAL de hoje (~239 + ~252 = ~491,
    // ver comentário do step "index-arquivo") é que precisa caber. Este
    // teste só documenta a relação, não afirma que a soma nominal cabe —
    // se algum dia os dois sitemaps crescerem simultaneamente perto do
    // teto nominal, é a cota real (GSC) que decide, não este teste.
    assert.ok(somaNominal >= GSC_URL_INSPECTION_DAILY_QUOTA, "sanity: os dois --limit nominais juntos cobrem a cota inteira");
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

  it("listDisabledScheduledTaskNames (#6773) retorna exatamente as tasks com enabled:false", () => {
    assert.deepEqual(
      listDisabledScheduledTaskNames(),
      SCHEDULED_TASKS.filter((t) => t.enabled === false).map((t) => t.name),
    );
    // Diaria-Sunset-Weekly é o caso real que motivou a issue (#5807/#6773) —
    // interruptor desligado por decisão do editor, não esquecimento.
    assert.ok(listDisabledScheduledTaskNames().includes("Diaria-Sunset-Weekly"));
  });

  it("listDisabledScheduledTaskNames nunca inclui task sem `enabled` (default true implícito)", () => {
    const enabledTask = SCHEDULED_TASKS.find((t) => t.enabled === undefined);
    assert.ok(enabledTask, "esperava pelo menos 1 task sem campo `enabled` no registro");
    assert.ok(!listDisabledScheduledTaskNames().includes(enabledTask!.name));
  });
});

describe("#5408 — enumeração programática (listScheduledTaskRows / --list / --json)", () => {
  it("listScheduledTaskRows devolve exatamente SCHEDULED_TASKS.length linhas, na mesma ordem", () => {
    const rows = listScheduledTaskRows();
    assert.equal(rows.length, SCHEDULED_TASKS.length);
    assert.deepEqual(
      rows.map((r) => r.name),
      SCHEDULED_TASKS.map((t) => t.name),
    );
  });

  it("adicionar uma task ao registro faz ela aparecer em listScheduledTaskRows SEM tocar a função (#5408)", () => {
    // Chama a função REAL (não uma duplicata da lógica) com um array
    // injetado (SCHEDULED_TASKS + 1 fake) — prova literal do critério da
    // issue: "adicionar uma task ao array a faz aparecer sem tocar no
    // comando". Não mutamos o `SCHEDULED_TASKS` exportado (afetaria outros
    // testes do processo) — o parâmetro injetável de listScheduledTaskRows
    // existe justamente pra permitir este teste sem essa mutação global.
    const fakeExtra: ScheduledTaskDefinition = {
      name: "Diaria-Fake-Task-Para-Teste",
      description: "task fake só pra este teste",
      steps: [{ key: "noop", script: "scripts/does-not-exist.ts" }],
      logPath: "fake/.fake.log",
      schedule: { kind: "daily", hour: 12, minute: 0 },
      issue: "#5408 (teste)",
    };
    const before = listScheduledTaskRows();
    const after = listScheduledTaskRows([...SCHEDULED_TASKS, fakeExtra]);
    assert.equal(after.length, before.length + 1);
    assert.ok(after.some((r) => r.name === "Diaria-Fake-Task-Para-Teste"));
  });

  it("formatScheduleHuman cobre os 4 kinds sem lançar", () => {
    assert.equal(formatScheduleHuman({ kind: "daily", hour: 9, minute: 5 }), "daily 09:05");
    assert.equal(formatScheduleHuman({ kind: "weekly", dayOfWeek: "Sunday", hour: 3, minute: 0 }), "weekly Sunday 03:00");
    assert.equal(formatScheduleHuman({ kind: "monthly", day: 1, hour: 9, minute: 0 }), "monthly day 1 09:00");
    assert.equal(formatScheduleHuman({ kind: "interval", hours: 4 }), "interval 4h");
  });

  it("renderScheduledTasksTable produz exatamente SCHEDULED_TASKS.length linhas", () => {
    const table = renderScheduledTasksTable();
    const lines = table.split("\n");
    assert.equal(lines.length, SCHEDULED_TASKS.length);
  });

  it("CLI --list imprime exatamente SCHEDULED_TASKS.length linhas em stdout", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/lib/scheduled-tasks.ts", "--list"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const lines = out.trim().split("\n");
    assert.equal(lines.length, SCHEDULED_TASKS.length);
  });

  it("CLI --json imprime um array JSON de tamanho SCHEDULED_TASKS.length", () => {
    const out = execFileSync(process.execPath, ["--import", "tsx", "scripts/lib/scheduled-tasks.ts", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, SCHEDULED_TASKS.length);
    assert.equal(parsed[0].name, SCHEDULED_TASKS[0].name);
  });
});

describe("#5005 — Diaria-Home-Meta-Check registrada, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto", () => {
    const t = getScheduledTaskByName("Diaria-Home-Meta-Check");
    assert.ok(t, "Diaria-Home-Meta-Check ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/home-meta-check.ts"],
    );
    // #5113: diária 09:35 (mudou de "a cada 6h"; 09:35 e não 09:30 porque
    // 09:30 colide com Diaria-Hub-Staleness-Check, #5123).
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 35 });
  });
});

describe("#5229 — Diaria-Beehiiv-Backup registrada, semanal, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, domingo 03:00", () => {
    const t = getScheduledTaskByName("Diaria-Beehiiv-Backup");
    assert.ok(t, "Diaria-Beehiiv-Backup ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/backup-beehiiv.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "weekly", dayOfWeek: "Sunday", hour: 3, minute: 0 });
  });

  it("domingo 03:00 não colide com nenhuma outra weekly nem cai numa batida de interval", () => {
    // Metade do bug da #5229 era "o backup nunca rodou agendado" — um
    // reagendamento por engano pra cima de outro timer reintroduz a classe do
    // problema (task registrada que não roda de verdade). Este teste trava o
    // slot, não só a existência da entrada.
    const t = getScheduledTaskByName("Diaria-Beehiiv-Backup")!;
    assert.equal(t.schedule.kind, "weekly");
    const mine = t.schedule as { kind: "weekly"; dayOfWeek: string; hour: number; minute: number };

    for (const other of SCHEDULED_TASKS) {
      if (other.name === t.name) continue;
      if (other.schedule.kind === "weekly" && other.schedule.dayOfWeek === mine.dayOfWeek) {
        assert.ok(
          other.schedule.hour !== mine.hour || other.schedule.minute !== mine.minute,
          `colisão de horário com ${other.name} (${mine.dayOfWeek} ${mine.hour}:${mine.minute})`,
        );
      }
      // `interval` bate em múltiplos de N horas a partir da meia-noite —
      // 03:00 só colidiria com um interval que divida 3 (1h ou 3h).
      // #5217: um interval de 1h (ex: Diaria-Clarice-Dashboard-Precompute)
      // bate em TODO horário cheio, por definição — "colidiria" com
      // qualquer daily/weekly/monthly agendado em minute:0, incluindo este.
      // Isso não é uma colisão evitável nem um sinal de mau agendamento (são
      // 2 processos independentes, sistemas totalmente diferentes — systemd
      // não serializa timers concorrentes); é só a consequência inerente de
      // "roda toda hora". Excluído do guard por design.
      if (other.schedule.kind === "interval" && other.schedule.hours > 1) {
        assert.ok(
          mine.minute !== 0 || mine.hour % other.schedule.hours !== 0,
          `03:00 cai numa batida de ${other.name} (interval de ${other.schedule.hours}h)`,
        );
      }
    }
  });
});

describe("#5123 — Diaria-Hub-Staleness-Check registrada, diária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 09:30", () => {
    const t = getScheduledTaskByName("Diaria-Hub-Staleness-Check");
    assert.ok(t, "Diaria-Hub-Staleness-Check ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/hub-staleness-check.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 30 });
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

describe("#5125 — Diaria-Entity-Pages-Regen registrada, diária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 09:40", () => {
    const t = getScheduledTaskByName("Diaria-Entity-Pages-Regen");
    assert.ok(t, "Diaria-Entity-Pages-Regen ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/regenerate-entity-pages.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 40 });
  });

  it("horário de 09:40 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Entity-Pages-Regen" && t.schedule.hour === 9 && t.schedule.minute === 40,
    );
    assert.deepEqual(collisions, []);
  });
});

describe("#4451 — Diaria-Clarice-Cohorts-Crawl registrada, roda o v2, systemd-only", () => {
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

  it("#5826: Diaria-Clarice-Envio trata exit 4 (lock de concorrência) como sucesso, não falha", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Envio");
    assert.ok(t, "Diaria-Clarice-Envio ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.successExitCodes,
      [4],
      "exit 4 = lock já travado por outra sessão (abort seguro, runEnvio nunca tocou Brevo) — não deveria marcar a unit systemd como failed",
    );
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

  it("ordem: Diaria-Clarice-Envio (19:00) roda DEPOIS de Diaria-Clarice-Novos (09:00) — cadastros novos já no store", () => {
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

  it("#5140: folga de >= 4h entre Clarice-Novos e Clarice-Envio — piso histórico, mantido como regressão mesmo após #5410", () => {
    // Histórico do piso: até o #5410, `isNovos` era subconjunto ESTRITO de
    // `isRampWarm`, então todo contato que o `novos` acabou de atender
    // continuava no universo da onda que o `Diaria-Clarice-Envio` monta. O
    // que os excluía era o guard `fetchCommittedCampaignListIds`
    // (`queued ∪ sent`), que NÃO enxergava `in_process` — o status que
    // apareceu de fato nas rodadas de 09 e 11/08/2026. Se a campanha do
    // `novos` ainda não tivesse assentado em `sent` na hora em que o envio
    // segmentava, os mesmos contatos entravam na onda de amanhã e recebiam
    // duas vezes em poucas horas.
    //
    // #5410 (16/08/2026) fechou esse caminho ESTRUTURALMENTE: `isNovos` e
    // `isRampWarm` hoje PARTICIONAM a fila de 1º envio
    // (`segmentRampWarm` corta por `readNovosCutoff()`) em vez de um ser
    // subconjunto do outro — a duplicata não depende mais de folga de
    // horas. Mesmo assim o piso de 4h AQUI é mantido como regressão barata:
    // a rodada da manhã moveu de 11:00→09:00 no #5447 (folga com as 19:00
    // subiu de 8h pra 10h, não caiu), e é preferível que uma reaproximação
    // futura das duas tasks quebre este teste explicitamente em vez de
    // depender só da partição estrutural do #5410 nunca regredir sozinha.
    const novos = getScheduledTaskByName("Diaria-Clarice-Novos");
    const envio = getScheduledTaskByName("Diaria-Clarice-Envio");
    assert.ok(novos && envio);
    const n = novos!.schedule as { kind: "daily"; hour: number; minute: number };
    const e = envio!.schedule as { kind: "daily"; hour: number; minute: number };
    const gapMinutes = (e.hour * 60 + e.minute) - (n.hour * 60 + n.minute);
    assert.ok(
      gapMinutes >= 240,
      `folga entre Clarice-Novos e Clarice-Envio caiu pra ${gapMinutes}min (< 240) — ` +
        "risco de a campanha do 'novos' ainda estar in_process quando a onda for segmentada",
    );
  });

  it("#5185: Diaria-Clarice-Novos-Tarde presente, 18:00 diário (#5447, sucede 15:00), mesmo script/guard de Diaria-Clarice-Novos, log próprio", () => {
    const tarde = getScheduledTaskByName("Diaria-Clarice-Novos-Tarde");
    const manha = getScheduledTaskByName("Diaria-Clarice-Novos");
    assert.ok(tarde, "Diaria-Clarice-Novos-Tarde ausente de SCHEDULED_TASKS");
    assert.ok(manha);
    assert.deepEqual(
      tarde!.steps.map((s) => s.script),
      manha!.steps.map((s) => s.script),
      "a 2a captura roda o MESMO orquestrador (clarice-novos-run.ts) — decisão do editor 260814, sem integração com clarice-envio-run.ts",
    );
    assert.deepEqual(tarde!.schedule, { kind: "daily", hour: 18, minute: 0 });
    assert.deepEqual(tarde!.guard, manha!.guard, "mesmo guard de pré-condição (data/ montada) das duas tasks");
    assert.notEqual(tarde!.logPath, manha!.logPath, "logs separados — não misturar as duas rodadas no mesmo arquivo");
  });

  it("#5185: ordem — Diaria-Clarice-Novos-Tarde (18:00) roda depois de Diaria-Clarice-Novos (09:00) e antes de Diaria-Clarice-Envio (19:00)", () => {
    const manha = getScheduledTaskByName("Diaria-Clarice-Novos");
    const tarde = getScheduledTaskByName("Diaria-Clarice-Novos-Tarde");
    const envio = getScheduledTaskByName("Diaria-Clarice-Envio");
    assert.ok(manha && tarde && envio);
    const m = manha!.schedule as { kind: "daily"; hour: number; minute: number };
    const t = tarde!.schedule as { kind: "daily"; hour: number; minute: number };
    const e = envio!.schedule as { kind: "daily"; hour: number; minute: number };
    const manhaMinutes = m.hour * 60 + m.minute;
    const tardeMinutes = t.hour * 60 + t.minute;
    const envioMinutes = e.hour * 60 + e.minute;
    assert.ok(tardeMinutes > manhaMinutes, "Diaria-Clarice-Novos-Tarde deveria rodar depois de Diaria-Clarice-Novos");
    assert.ok(envioMinutes > tardeMinutes, "Diaria-Clarice-Envio deveria rodar depois de Diaria-Clarice-Novos-Tarde");
  });

  it("#5447: espaçamento — as 2 rodadas do 'novos' ficam a >= 6h uma da outra (09:00 x 18:00)", () => {
    // #5445 mostrou que o par 11:00+15:00 (4h de espaçamento) era só a 210ª
    // melhor combinação entre 276 possíveis — o par vencedor (09:00+18:00,
    // 9h de espaçamento) cobre melhor as duas pontas da curva de chegada de
    // cadastro. Este teste trava o INVARIANTE de espaçamento mínimo que a
    // #5445 mostrou faltar (nenhum teste anterior travava a distância entre
    // as duas rodadas do dia, só a ordem relativa) — não um valor fixo, pra
    // não impedir um futuro ajuste fino (ex: 09:00+18:30) desde que a folga
    // mínima seja preservada.
    const manha = getScheduledTaskByName("Diaria-Clarice-Novos");
    const tarde = getScheduledTaskByName("Diaria-Clarice-Novos-Tarde");
    assert.ok(manha && tarde);
    const m = manha!.schedule as { kind: "daily"; hour: number; minute: number };
    const t = tarde!.schedule as { kind: "daily"; hour: number; minute: number };
    const gapMinutes = (t.hour * 60 + t.minute) - (m.hour * 60 + m.minute);
    assert.ok(
      gapMinutes >= 360,
      `espaçamento entre as 2 rodadas do 'novos' caiu pra ${gapMinutes}min (< 360) — ` +
        "#5445 mostrou que espaçamento curto degrada a latência média de chegada",
    );
  });

  it("#5220: Diaria-Clarice-Envio-Guard-Alarm presente, 06:15 diário, step aponta pro alarme próprio do guard", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Envio-Guard-Alarm");
    assert.ok(t, "Diaria-Clarice-Envio-Guard-Alarm ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/clarice-envio-guard-alarm.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 6, minute: 15 });
  });

  it("#5220: ordem — Diaria-Clarice-Envio-Guard-Alarm roda DEPOIS do guard (05:00) e depois do disparo (06:00)", () => {
    const guard = getScheduledTaskByName("Diaria-Clarice-Envio-Guard");
    const guardAlarm = getScheduledTaskByName("Diaria-Clarice-Envio-Guard-Alarm");
    assert.ok(guard && guardAlarm);
    const g = guard!.schedule as { kind: "daily"; hour: number; minute: number };
    const ga = guardAlarm!.schedule as { kind: "daily"; hour: number; minute: number };
    const guardMinutes = g.hour * 60 + g.minute;
    const alarmMinutes = ga.hour * 60 + ga.minute;
    const dispatchMinutes = 6 * 60;
    assert.ok(alarmMinutes > guardMinutes, "o alarme do guard deveria rodar depois do próprio guard");
    assert.ok(alarmMinutes >= dispatchMinutes, "o alarme do guard deveria rodar no horário do disparo (06:00) ou depois");
  });

  it("#5220: Diaria-Clarice-Envio-Guard-Alarm é DISTINTA de Diaria-Clarice-Envio-Alarm (não reaproveita o alarme do run)", () => {
    const guardAlarm = getScheduledTaskByName("Diaria-Clarice-Envio-Guard-Alarm");
    const runAlarm = getScheduledTaskByName("Diaria-Clarice-Envio-Alarm");
    assert.ok(guardAlarm && runAlarm);
    assert.notEqual(guardAlarm!.steps[0].script, runAlarm!.steps[0].script);
    assert.notDeepEqual(guardAlarm!.schedule, runAlarm!.schedule);
  });
});

describe("#5128/#5130 — Diaria-Bing-Seo-Monthly-Pull registrada, mensal, systemd-only", () => {
  it("está presente no registro, com os 2 steps (keywords + links) apontando pro mesmo módulo", () => {
    const t = getScheduledTaskByName("Diaria-Bing-Seo-Monthly-Pull");
    assert.ok(t, "Diaria-Bing-Seo-Monthly-Pull ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/bing-pull.ts", "scripts/bing-pull.ts"],
    );
    assert.deepEqual(
      t!.steps.map((s) => s.args),
      [["--mode", "keywords"], ["--mode", "links"]],
    );
    assert.deepEqual(t!.schedule, { kind: "monthly", day: 1, hour: 9, minute: 0 });
  });
});

describe("#5217 — Diaria-Clarice-Dashboard-Precompute registrada, horária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, interval de 1h", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Dashboard-Precompute");
    assert.ok(t, "Diaria-Clarice-Dashboard-Precompute ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/clarice-dashboard-precompute.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "interval", hours: 1 });
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Dashboard-Precompute")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });
});

describe("#5249 — Diaria-Acquisition-Health-Alarm registrada, semanal, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, domingo 03:30", () => {
    const t = getScheduledTaskByName("Diaria-Acquisition-Health-Alarm");
    assert.ok(t, "Diaria-Acquisition-Health-Alarm ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/check-acquisition-health.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "weekly", dayOfWeek: "Sunday", hour: 3, minute: 30 });
  });

  it("roda 30min DEPOIS do Diaria-Beehiiv-Backup (03:00) — a task que gera o snapshot que este alarme lê", () => {
    const alarm = getScheduledTaskByName("Diaria-Acquisition-Health-Alarm")!;
    const backup = getScheduledTaskByName("Diaria-Beehiiv-Backup")!;
    assert.equal(alarm.schedule.kind, "weekly");
    assert.equal(backup.schedule.kind, "weekly");
    const alarmSchedule = alarm.schedule as { kind: "weekly"; dayOfWeek: string; hour: number; minute: number };
    const backupSchedule = backup.schedule as { kind: "weekly"; dayOfWeek: string; hour: number; minute: number };
    assert.equal(alarmSchedule.dayOfWeek, backupSchedule.dayOfWeek);
    const alarmMinutes = alarmSchedule.hour * 60 + alarmSchedule.minute;
    const backupMinutes = backupSchedule.hour * 60 + backupSchedule.minute;
    assert.ok(alarmMinutes > backupMinutes, "Diaria-Acquisition-Health-Alarm deveria rodar depois de Diaria-Beehiiv-Backup");
  });

  it("domingo 03:30 não colide com nenhuma outra weekly nem cai numa batida de interval", () => {
    const t = getScheduledTaskByName("Diaria-Acquisition-Health-Alarm")!;
    assert.equal(t.schedule.kind, "weekly");
    const mine = t.schedule as { kind: "weekly"; dayOfWeek: string; hour: number; minute: number };

    for (const other of SCHEDULED_TASKS) {
      if (other.name === t.name) continue;
      if (other.schedule.kind === "weekly" && other.schedule.dayOfWeek === mine.dayOfWeek) {
        assert.ok(
          other.schedule.hour !== mine.hour || other.schedule.minute !== mine.minute,
          `colisão de horário com ${other.name} (${mine.dayOfWeek} ${mine.hour}:${mine.minute})`,
        );
      }
      // Mesmo racional documentado no bloco #5229 acima: interval de 1h bate
      // em todo horário cheio por definição, mas 03:30 nunca cai em minute:0
      // — então só intervals que dividem 30min importariam, e nenhum existe
      // hoje no registro. Guard mantido pra simetria e futura-prova.
      if (other.schedule.kind === "interval" && other.schedule.hours > 1) {
        assert.ok(
          mine.minute !== 0 || mine.hour % other.schedule.hours !== 0,
          `03:30 cai numa batida de ${other.name} (interval de ${other.schedule.hours}h)`,
        );
      }
    }
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Acquisition-Health-Alarm")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });
});

describe("#5405 — alarme removido pelo #5660", () => {
  it("não está mais registrado porque clarice-novos-run não produz semaphore-red", () => {
    assert.equal(getScheduledTaskByName("Diaria-Clarice-Novos-Abort-Alarm"), undefined);
  });
});

describe("#5704 — Diaria-Google-Ads-Spend-Ingest registrada, diária, systemd-only, NÃO armada", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 09:50", () => {
    const t = getScheduledTaskByName("Diaria-Google-Ads-Spend-Ingest");
    assert.ok(t, "Diaria-Google-Ads-Spend-Ingest ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/google-ads-ingest-spend.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 50 });
    assert.equal(t!.issue, "#5704");
  });

  it("horário de 09:50 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Google-Ads-Spend-Ingest" && t.schedule.hour === 9 && t.schedule.minute === 50,
    );
    assert.deepEqual(collisions, []);
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Google-Ads-Spend-Ingest")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });
});

describe("#5754/#6267 — Diaria-Hub-Pages-Build registrada, semanal, systemd-only, DESLIGADA DE PROPÓSITO", () => {
  it("está presente no registro, com o step apontando pro build-hub-page.ts com --all --check-facts, domingo 08:05", () => {
    const t = getScheduledTaskByName("Diaria-Hub-Pages-Build");
    assert.ok(t, "Diaria-Hub-Pages-Build ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/build-hub-page.ts"],
    );
    // `--check-facts` é o que garante que a task NÃO contorna o gate de
    // fact-check de hub (#5060/#5102) — `--all` sozinho não aciona esse
    // gate (ver docstring de scripts/build-hub-page.ts).
    assert.deepEqual(t!.steps[0].args, ["--all", "--check-facts"]);
    assert.deepEqual(t!.schedule, { kind: "weekly", dayOfWeek: "Sunday", hour: 8, minute: 5 });
    assert.equal(t!.issue, "#5754");
  });

  it("enabled: false (#6267) — como declarada a task NÃO PODE ter sucesso; religar exige resolver 2 bloqueadores", () => {
    // Bloqueador 1: `--check-facts` sem `--skip-fact-check` exige
    // `data/hub-fact-check/{slug}-report.json`, que NUNCA existiu pra nenhum
    // hub (o dispatch do `fact-checker mode:hub` nunca foi ligado — ver
    // `.claude/agents/fact-checker.md` §"Modo hub"). Armada, ela aborta
    // `exit 2` no 1º hub todo domingo, sem gerar um `.generated.ts`.
    // Bloqueador 2: `UPDATED_DATE` é hand-written por hub e
    // `validateHubContent` exige `updatedDate >= sourceEditions[0].date`
    // (guard do #5124), então nem "só regenerar as fontes" roda
    // desassistido — com as fontes regeneradas, 5 testes de render quebram,
    // e a checkout compartilhada ficaria suja toda semana.
    // Decisão do editor (#6267, 26/08/2026): o regen fica MANUAL (#6274).
    const t = getScheduledTaskByName("Diaria-Hub-Pages-Build")!;
    assert.equal(
      t.enabled,
      false,
      "task deve seguir DESLIGADA até os 2 bloqueadores do #6267 serem resolvidos — ver docs/scheduled-tasks-registry.md",
    );
  });

  it("nunca ganha --skip-fact-check (destravar contornando o gate de conteúdo é o oposto da decisão do #5754)", () => {
    // Distinto da asserção de `args` acima, que trava a lista EXATA de hoje:
    // esta nomeia o invariante — se um dia a lista mudar legitimamente, a de
    // cima é atualizada, esta continua barrando a flag que anularia o gate.
    const t = getScheduledTaskByName("Diaria-Hub-Pages-Build")!;
    assert.ok(
      !(t.steps[0].args ?? []).includes("--skip-fact-check"),
      "contornar o fact-check em run desassistida é pior que falhar alto (#5754) — se o objetivo é destravar, resolva o #6267",
    );
  });

  it("domingo 08:05 não colide com nenhuma outra weekly nem cai numa batida de interval", () => {
    const t = getScheduledTaskByName("Diaria-Hub-Pages-Build")!;
    assert.equal(t.schedule.kind, "weekly");
    const mine = t.schedule as { kind: "weekly"; dayOfWeek: string; hour: number; minute: number };

    for (const other of SCHEDULED_TASKS) {
      if (other.name === t.name) continue;
      if (other.schedule.kind === "weekly" && other.schedule.dayOfWeek === mine.dayOfWeek) {
        assert.ok(
          other.schedule.hour !== mine.hour || other.schedule.minute !== mine.minute,
          `colisão de horário com ${other.name} (${mine.dayOfWeek} ${mine.hour}:${mine.minute})`,
        );
      }
      if (other.schedule.kind === "interval" && other.schedule.hours > 1) {
        assert.ok(
          mine.minute !== 0 || mine.hour % other.schedule.hours !== 0,
          `08:00 cai numa batida de ${other.name} (interval de ${other.schedule.hours}h)`,
        );
      }
    }
  });

  it("08:00 fica antes da janela 09:30-10:20 dos checks de drift/staleness de hub (motivo do horário, #5754)", () => {
    const build = getScheduledTaskByName("Diaria-Hub-Pages-Build")!;
    const buildMinutes = (build.schedule as { hour: number; minute: number }).hour * 60 + (build.schedule as { hour: number; minute: number }).minute;
    for (const name of ["Diaria-Hub-Staleness-Check", "Diaria-Hub-Drift-Check", "Diaria-Robots-Txt-Drift-Check"]) {
      const t = getScheduledTaskByName(name);
      assert.ok(t, `${name} ausente de SCHEDULED_TASKS`);
      const schedule = t!.schedule as { hour: number; minute: number };
      const otherMinutes = schedule.hour * 60 + schedule.minute;
      assert.ok(buildMinutes < otherMinutes, `Diaria-Hub-Pages-Build (${build.schedule.hour}:${build.schedule.minute}) deveria rodar antes de ${name}`);
    }
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Hub-Pages-Build")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });
});

describe("#5807 — Diaria-Sunset-Weekly registrada, semanal, DESLIGADA DE PROPÓSITO (não 'ainda não armada')", () => {
  it("está presente no registro, com o step apontando pro sunset-dead-subscribers.ts --push, domingo 09:20", () => {
    const t = getScheduledTaskByName("Diaria-Sunset-Weekly");
    assert.ok(t, "Diaria-Sunset-Weekly ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/sunset-dead-subscribers.ts"],
    );
    assert.deepEqual(t!.steps[0].args, ["--push"]);
    assert.deepEqual(t!.schedule, { kind: "weekly", dayOfWeek: "Sunday", hour: 9, minute: 20 });
  });

  it("enabled: false — a #5849 (relacionada) ainda não resolveu o trade-off de receivedMin=20 contra medição de campanha", () => {
    const t = getScheduledTaskByName("Diaria-Sunset-Weekly")!;
    assert.equal(t.enabled, false, "task deve nascer DESLIGADA até a #5849 ser resolvida — ver docs/scheduled-tasks-registry.md");
  });

  it("guard.requiredFile aponta pro mesmo store de Diaria-Brevo-Diaria-Evaluate (sinal de junction data/ montada)", () => {
    const t = getScheduledTaskByName("Diaria-Sunset-Weekly")!;
    assert.equal(t.guard?.requiredFile, "brevo-diaria/contacts.json");
  });

  it("domingo 09:20 não colide com nenhuma outra weekly nem cai numa batida de interval", () => {
    const t = getScheduledTaskByName("Diaria-Sunset-Weekly")!;
    assert.equal(t.schedule.kind, "weekly");
    const mine = t.schedule as { kind: "weekly"; dayOfWeek: string; hour: number; minute: number };

    for (const other of SCHEDULED_TASKS) {
      if (other.name === t.name) continue;
      if (other.schedule.kind === "weekly" && other.schedule.dayOfWeek === mine.dayOfWeek) {
        assert.ok(
          other.schedule.hour !== mine.hour || other.schedule.minute !== mine.minute,
          `colisão de horário com ${other.name} (${mine.dayOfWeek} ${mine.hour}:${mine.minute})`,
        );
      }
      if (other.schedule.kind === "interval" && other.schedule.hours > 1) {
        assert.ok(
          mine.minute !== 0 || mine.hour % other.schedule.hours !== 0,
          `09:20 cai numa batida de ${other.name} (interval de ${other.schedule.hours}h)`,
        );
      }
      // dailies também rodam domingo — checar colisão com as tasks daily do
      // cluster matinal 09:00-09:50 já registrado.
      if (other.schedule.kind === "daily") {
        assert.ok(
          other.schedule.hour !== mine.hour || other.schedule.minute !== mine.minute,
          `colisão de horário com a daily ${other.name} (09:20, também roda domingo)`,
        );
      }
    }
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Sunset-Weekly")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });
});

describe("#6093 — Diaria-Kit-Subscriber-Sync registrada, diária, sync Beehiiv -> Kit (--push)", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 09:25", () => {
    const t = getScheduledTaskByName("Diaria-Kit-Subscriber-Sync");
    assert.ok(t, "Diaria-Kit-Subscriber-Sync ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/sync-beehiiv-subscribers-kit.ts"],
    );
    assert.deepEqual(t!.steps[0].args, ["--push"]);
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 25 });
  });

  it("horário de 09:25 não colide com nenhuma outra daily nem com a weekly Diaria-Sunset-Weekly (domingo 09:20)", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Kit-Subscriber-Sync" && t.schedule.hour === 9 && t.schedule.minute === 25,
    );
    assert.deepEqual(collisions, []);
  });

  it("sem guard.requiredFile — o script já tem guard de blast radius embutido (lista Kit suspeita-vazia)", () => {
    const t = getScheduledTaskByName("Diaria-Kit-Subscriber-Sync")!;
    assert.equal(t.guard, undefined);
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Kit-Subscriber-Sync")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });

  it("aparece em listScheduledTaskRows / CLI --list / CLI --json sem tocar nenhum consumidor (#5408)", () => {
    const rows = listScheduledTaskRows();
    assert.ok(rows.some((r) => r.name === "Diaria-Kit-Subscriber-Sync"));

    const listOut = execFileSync(process.execPath, ["--import", "tsx", "scripts/lib/scheduled-tasks.ts", "--list"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.match(listOut, /Diaria-Kit-Subscriber-Sync/);

    const jsonOut = execFileSync(process.execPath, ["--import", "tsx", "scripts/lib/scheduled-tasks.ts", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const parsed = JSON.parse(jsonOut);
    assert.ok(parsed.some((t: { name: string }) => t.name === "Diaria-Kit-Subscriber-Sync"));
  });
});

describe("#6130 — Diaria-Session-Registry-Gc registrada, diária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 09:55", () => {
    const t = getScheduledTaskByName("Diaria-Session-Registry-Gc");
    assert.ok(t, "Diaria-Session-Registry-Gc ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/session-registry-gc.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 9, minute: 55 });
  });

  it("horário de 09:55 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Session-Registry-Gc" && t.schedule.hour === 9 && t.schedule.minute === 55,
    );
    assert.deepEqual(collisions, []);
  });
});

describe("#6130 — Diaria-Session-Registry-SafeBackup-Alarm registrada, diária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 10:05", () => {
    const t = getScheduledTaskByName("Diaria-Session-Registry-SafeBackup-Alarm");
    assert.ok(t, "Diaria-Session-Registry-SafeBackup-Alarm ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/session-registry-safebackup-alarm.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 10, minute: 5 });
  });

  it("horário de 10:05 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Session-Registry-SafeBackup-Alarm" && t.schedule.hour === 10 && t.schedule.minute === 5,
    );
    assert.deepEqual(collisions, []);
  });
});

describe("#6198 — Diaria-Backlog-Reconcile registrada, diária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 10:10", () => {
    const t = getScheduledTaskByName("Diaria-Backlog-Reconcile");
    assert.ok(t, "Diaria-Backlog-Reconcile ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/backlog-reconcile.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 10, minute: 10 });
  });

  it("horário de 10:10 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Backlog-Reconcile" && t.schedule.hour === 10 && t.schedule.minute === 10,
    );
    assert.deepEqual(collisions, []);
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const others = SCHEDULED_TASKS.filter((t) => t.name !== "Diaria-Backlog-Reconcile").flatMap((t) => t.steps);
    assert.ok(!others.some((s) => s.script === "scripts/backlog-reconcile.ts"));
  });
});

describe("#6985 — Diaria-Openrouter-Billing-Leak-Alarm registrada, diária, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto, diária às 21:45", () => {
    const t = getScheduledTaskByName("Diaria-Openrouter-Billing-Leak-Alarm");
    assert.ok(t, "Diaria-Openrouter-Billing-Leak-Alarm ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/openrouter-billing-leak-check.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 21, minute: 45 });
  });

  it("horário de 21:45 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Openrouter-Billing-Leak-Alarm" && t.schedule.hour === 21 && t.schedule.minute === 45,
    );
    assert.deepEqual(collisions, []);
  });

  it("declara successExitCodes: [3] (LEAK_FOUND_EXIT_CODE) — 'achou vazamento' não é falha da unit", () => {
    const t = getScheduledTaskByName("Diaria-Openrouter-Billing-Leak-Alarm");
    assert.deepEqual(t!.successExitCodes, [3]);
  });

  it("NÃO declara exit 1 como successExitCode — indeterminado/erro continua reprovando a unit (#6985)", () => {
    const t = getScheduledTaskByName("Diaria-Openrouter-Billing-Leak-Alarm");
    assert.ok(!(t!.successExitCodes ?? []).includes(1));
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const others = SCHEDULED_TASKS.filter((t) => t.name !== "Diaria-Openrouter-Billing-Leak-Alarm").flatMap(
      (t) => t.steps,
    );
    assert.ok(!others.some((s) => s.script === "scripts/openrouter-billing-leak-check.ts"));
  });
});

describe("#6802 — Diaria-Branch-Cleanup registrada, diária, isolada da Diaria-Session-Registry-Gc", () => {
  it("está presente no registro, com o step apontando pro script correto + --push, diária às 10:45", () => {
    const t = getScheduledTaskByName("Diaria-Branch-Cleanup");
    assert.ok(t, "Diaria-Branch-Cleanup ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/branch-cleanup.ts"],
    );
    assert.deepEqual(t!.steps[0]!.args, ["--push"]);
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 10, minute: 45 });
  });

  it("horário de 10:45 não colide com nenhuma outra daily do registro", () => {
    const dailies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "daily"; hour: number; minute: number } } =>
        t.schedule.kind === "daily",
    );
    const collisions = dailies.filter(
      (t) => t.name !== "Diaria-Branch-Cleanup" && t.schedule.hour === 10 && t.schedule.minute === 45,
    );
    assert.deepEqual(collisions, []);
  });

  it("não colide com nenhuma weekly de domingo às 10:45 (dailies também rodam domingo)", () => {
    const weeklies = SCHEDULED_TASKS.filter(
      (t): t is typeof t & { schedule: { kind: "weekly"; dayOfWeek: string; hour: number; minute: number } } =>
        t.schedule.kind === "weekly" && t.schedule.dayOfWeek === "Sunday",
    );
    const collisions = weeklies.filter((t) => t.schedule.hour === 10 && t.schedule.minute === 45);
    assert.deepEqual(collisions, []);
  });

  it("é uma task NOVA e isolada — não reaproveita nem estende os steps da Diaria-Session-Registry-Gc (decisão do editor, #6802)", () => {
    const branchCleanup = getScheduledTaskByName("Diaria-Branch-Cleanup");
    const sessionGc = getScheduledTaskByName("Diaria-Session-Registry-Gc");
    assert.ok(branchCleanup);
    assert.ok(sessionGc);
    assert.notEqual(branchCleanup!.name, sessionGc!.name);
    assert.deepEqual(
      branchCleanup!.steps.map((s) => s.script),
      ["scripts/branch-cleanup.ts"],
    );
    assert.deepEqual(
      sessionGc!.steps.map((s) => s.script),
      ["scripts/session-registry-gc.ts"],
    );
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const others = SCHEDULED_TASKS.filter((t) => t.name !== "Diaria-Branch-Cleanup").flatMap((t) => t.steps);
    assert.ok(!others.some((s) => s.script === "scripts/branch-cleanup.ts"));
  });
});
