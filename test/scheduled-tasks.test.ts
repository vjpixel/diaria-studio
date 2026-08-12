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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getScheduledTaskByName,
  listScheduledTaskNames,
  SCHEDULED_TASKS,
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
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 8, minute: 30 });
  });

  it("Diaria-Brevo-Diaria-Evaluate dispara às 05:30, antes do envio das 06:00 (#4534)", () => {
    // A Brevo congela destinatários no AGENDAMENTO da campanha, não no envio
    // — rodar depois deixaria o unlink (desvincula quem foi
    // promovido/suprimido/descadastrado) sem efeito no envio do dia.
    const t = getScheduledTaskByName("Diaria-Brevo-Diaria-Evaluate");
    assert.ok(t);
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

describe("#5005 — Diaria-Beehiiv-Home-Meta-Check registrada, systemd-only", () => {
  it("está presente no registro, com o step apontando pro script correto", () => {
    const t = getScheduledTaskByName("Diaria-Beehiiv-Home-Meta-Check");
    assert.ok(t, "Diaria-Beehiiv-Home-Meta-Check ausente de SCHEDULED_TASKS");
    assert.deepEqual(
      t!.steps.map((s) => s.script),
      ["scripts/beehiiv-home-meta-check.ts"],
    );
    assert.deepEqual(t!.schedule, { kind: "interval", hours: 6 });
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

  it("ordem: Diaria-Clarice-Envio (19:00) roda DEPOIS de Diaria-Clarice-Novos (11:00) — cadastros novos já no store", () => {
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

  it("#5140: folga de >= 4h entre Clarice-Novos e Clarice-Envio — o guard queued∪sent não cobre in_process", () => {
    // Não é preferência de horário, é a margem que impede ENVIO DUPLICADO.
    // `isNovos` é subconjunto ESTRITO de `isRampWarm`, então todo contato que
    // o `novos` acabou de atender continua no universo da onda que o
    // `Diaria-Clarice-Envio` monta. O que os exclui é o guard
    // `fetchCommittedCampaignListIds` (`queued ∪ sent`), e ele NÃO enxerga
    // `in_process` — o status que apareceu de fato nas rodadas de 09 e
    // 11/08/2026. Se a campanha do `novos` ainda não assentou em `sent` na
    // hora em que o envio segmenta, os mesmos contatos entram na onda de
    // amanhã e recebem duas vezes em poucas horas.
    //
    // Com 11:00 × 19:00 a folga é de 8h. O piso de 4h existe pra que mover
    // qualquer uma das duas tasks pra perto da outra quebre AQUI, e não em
    // produção — onde o sintoma seria um contato reclamando de e-mail
    // repetido, semanas depois, sem rastro óbvio da causa.
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
