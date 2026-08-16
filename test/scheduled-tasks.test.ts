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
    const out = execFileSync("npx", ["tsx", "scripts/lib/scheduled-tasks.ts", "--list"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const lines = out.trim().split("\n");
    assert.equal(lines.length, SCHEDULED_TASKS.length);
  });

  it("CLI --json imprime um array JSON de tamanho SCHEDULED_TASKS.length", () => {
    const out = execFileSync("npx", ["tsx", "scripts/lib/scheduled-tasks.ts", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, SCHEDULED_TASKS.length);
    assert.equal(parsed[0].name, SCHEDULED_TASKS[0].name);
  });
});

describe("#5005 — Diaria-Beehiiv-Home-Meta-Check registrada, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto", () => {
    const t = getScheduledTaskByName("Diaria-Beehiiv-Home-Meta-Check");
    assert.ok(t, "Diaria-Beehiiv-Home-Meta-Check ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/beehiiv-home-meta-check.ts"],
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

describe("#5405 — Diaria-Clarice-Novos-Abort-Alarm registrada, diária 18:10 (#5447, sucede 15:10), depois das 2 rodadas do novos", () => {
  it("está presente no registro, com o step apontando pro script correto, 18:10 BRT", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Novos-Abort-Alarm");
    assert.ok(t, "Diaria-Clarice-Novos-Abort-Alarm ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/clarice-novos-abort-alarm.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 18, minute: 10 });
  });

  it("roda DEPOIS de Diaria-Clarice-Novos-Tarde (18:00) — lê o status da rodada mais recente do dia", () => {
    const alarm = getScheduledTaskByName("Diaria-Clarice-Novos-Abort-Alarm")!;
    const tarde = getScheduledTaskByName("Diaria-Clarice-Novos-Tarde")!;
    assert.equal(alarm.schedule.kind, "daily");
    assert.equal(tarde.schedule.kind, "daily");
    const alarmSchedule = alarm.schedule as { kind: "daily"; hour: number; minute: number };
    const tardeSchedule = tarde.schedule as { kind: "daily"; hour: number; minute: number };
    const alarmMinutes = alarmSchedule.hour * 60 + alarmSchedule.minute;
    const tardeMinutes = tardeSchedule.hour * 60 + tardeSchedule.minute;
    assert.ok(alarmMinutes > tardeMinutes, "Diaria-Clarice-Novos-Abort-Alarm deveria rodar depois de Diaria-Clarice-Novos-Tarde");
  });

  it("18:10 não colide com nenhuma outra daily", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Novos-Abort-Alarm")!;
    assert.equal(t.schedule.kind, "daily");
    const mine = t.schedule as { kind: "daily"; hour: number; minute: number };
    for (const other of SCHEDULED_TASKS) {
      if (other.name === t.name) continue;
      if (other.schedule.kind === "daily") {
        assert.ok(
          other.schedule.hour !== mine.hour || other.schedule.minute !== mine.minute,
          `colisão de horário com ${other.name} (${mine.hour}:${mine.minute})`,
        );
      }
    }
  });

  it("nenhum outro step do registro aponta pro mesmo script (task nova, não reaproveitamento)", () => {
    const t = getScheduledTaskByName("Diaria-Clarice-Novos-Abort-Alarm")!;
    const script = t.steps[0].script;
    const others = SCHEDULED_TASKS.filter((o) => o.name !== t.name && o.steps.some((s) => s.script === script));
    assert.deepEqual(others, [], `script ${script} também referenciado por: ${others.map((o) => o.name).join(", ")}`);
  });
});
