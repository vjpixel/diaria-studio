/**
 * test/studio-tasks.test.ts (#4799)
 *
 * Cobertura de `scripts/studio-ui/studio-tasks.ts`:
 *   - `describeSchedule` (rótulo pt-BR de cada `ScheduledTaskSchedule.kind`).
 *   - `buildTasksData` (orquestração fim-a-fim): cobre TODAS as
 *     `SCHEDULED_TASKS` reais do registro, injeta `queryArmedFn`/
 *     `readLastRunFn` (nunca spawna `schtasks`/`systemctl` real nem lê
 *     `data/` real — mesmo princípio de `test/studio-integrations.test.ts`:
 *     probes reais só em runtime), cache com TTL, `forceRefresh`, e o
 *     fail-soft por task (uma task quebrando não derruba as demais).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTasksData, clearTasksCache, describeSchedule } from "../scripts/studio-ui/studio-tasks.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import type { TaskArmedResult, TaskLastRunInfo } from "../scripts/lib/scheduled-task-status.ts";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "studio-tasks-"));
}

const NEVER_RUN: TaskLastRunInfo = {
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  outcome: null,
  steps: [],
  excerpt: null,
};

const ALWAYS_ARMED = (): TaskArmedResult => ({ scheduler: "windows-task-scheduler", state: "armed", note: null });
const NEVER_RUN_FN = () => NEVER_RUN;

describe("describeSchedule (#4799)", () => {
  it("daily -> 'diária às HH:MM'", () => {
    assert.equal(describeSchedule({ kind: "daily", hour: 8, minute: 30 }), "diária às 08:30");
  });

  it("weekly -> 'semanal (dia) às HH:MM'", () => {
    assert.equal(
      describeSchedule({ kind: "weekly", dayOfWeek: "Monday", hour: 10, minute: 30 }),
      "semanal (segunda) às 10:30",
    );
  });

  it("interval -> 'a cada Nh'", () => {
    assert.equal(describeSchedule({ kind: "interval", hours: 4 }), "a cada 4h");
  });

  it("monthly (#5128/#5130) -> 'mensal (dia D) às HH:MM'", () => {
    assert.equal(
      describeSchedule({ kind: "monthly", day: 1, hour: 9, minute: 0 }),
      "mensal (dia 1) às 09:00",
    );
  });
});

describe("buildTasksData (#4799) — orquestração fim-a-fim", () => {
  it("cobre TODAS as SCHEDULED_TASKS reais do registro, na mesma ordem", () => {
    clearTasksCache();
    const root = makeRoot();
    try {
      const data = buildTasksData(root, {
        now: () => new Date("2026-08-10T12:00:00.000Z"),
        queryArmedFn: ALWAYS_ARMED,
        readLastRunFn: NEVER_RUN_FN,
      });
      assert.equal(data.tasks.length, SCHEDULED_TASKS.length);
      assert.deepEqual(
        data.tasks.map((t) => t.name),
        SCHEDULED_TASKS.map((t) => t.name),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nunca lança mesmo sem data/ (clone fresco cloud) e reporta execMode 'cloud'", () => {
    clearTasksCache();
    const root = makeRoot(); // tmpdir vazio, sem data/
    try {
      const data = buildTasksData(root, {
        now: () => new Date(),
        queryArmedFn: ALWAYS_ARMED,
        readLastRunFn: NEVER_RUN_FN,
      });
      assert.equal(data.execMode, "cloud");
      assert.ok(data.tasks.length > 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cada task carrega scheduleLabel/issue/logPath do registro correspondente", () => {
    clearTasksCache();
    const root = makeRoot();
    try {
      const data = buildTasksData(root, {
        now: () => new Date("2026-08-10T12:00:00.000Z"),
        queryArmedFn: ALWAYS_ARMED,
        readLastRunFn: NEVER_RUN_FN,
      });
      const clariceSync = data.tasks.find((t) => t.name === "Diaria-Clarice-Sync");
      assert.ok(clariceSync);
      assert.equal(clariceSync?.scheduleLabel, "diária às 08:30");
      assert.match(clariceSync?.issue ?? "", /#2932/);
      assert.equal(clariceSync?.logPath, "clarice-subscribers/.brevo-sync-daily.log");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propaga armed/lastRun/overdue por task a partir das funções injetadas", () => {
    clearTasksCache();
    const root = makeRoot();
    try {
      const data = buildTasksData(root, {
        // #4941: quando Diaria-Clarice-Novos rodava às 17:00 BRT, 20:00 UTC
        // colidia exatamente com o `mostRecent` dela (grace de 60min fazia
        // ela sozinha reportar overdue=false enquanto as demais davam true).
        // 23:00 UTC (20:00 BRT) resolve isso — e NÃO porque fica depois de
        // toda daily do registro (não fica: Clarice-Envio-Alarm às 20:30 e
        // Cohorts-Crawl às 21:00 são mais tardias). Fica depois pro caso que
        // importava, e pras demais `computeMostRecentScheduledOccurrence`
        // envolve pra ocorrência de ONTEM, que somada ao grace já é <= now —
        // então elas reportam overdue=true do mesmo jeito.
        // #5140 moveu Clarice-Novos pra 11:00, o que dissolve a colisão
        // original; o `now` fica como está de propósito, porque afrouxá-lo
        // pra "só depois das 11:00" reintroduziria o problema na próxima
        // task vespertina que alguém registrar.
        now: () => new Date("2026-08-10T23:00:00.000Z"), // bem depois de qualquer daily/weekly do dia
        queryArmedFn: () => ({ scheduler: "systemd", state: "disabled", note: null }),
        readLastRunFn: () => ({ ...NEVER_RUN }),
      });
      for (const t of data.tasks) {
        assert.equal(t.armed.state, "disabled");
        assert.equal(t.lastRun.startedAt, null);
        assert.equal(t.error, null);
        // nunca rodou + schedule daily/weekly já passou do horário -> overdue;
        // interval sem lastRun também é sempre overdue (ver isTaskOverdue).
        assert.equal(t.overdue, true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("nextRunAt é ISO pra daily/weekly e null pra interval", () => {
    clearTasksCache();
    const root = makeRoot();
    try {
      const data = buildTasksData(root, {
        now: () => new Date("2026-08-10T12:00:00.000Z"),
        queryArmedFn: ALWAYS_ARMED,
        readLastRunFn: NEVER_RUN_FN,
      });
      const intervalTask = data.tasks.find((t) => SCHEDULED_TASKS.find((d) => d.name === t.name)?.schedule.kind === "interval");
      const dailyTask = data.tasks.find((t) => SCHEDULED_TASKS.find((d) => d.name === t.name)?.schedule.kind === "daily");
      assert.ok(intervalTask, "precisa existir ao menos 1 task 'interval' no registro real");
      assert.ok(dailyTask, "precisa existir ao menos 1 task 'daily' no registro real");
      assert.equal(intervalTask?.nextRunAt, null);
      assert.match(dailyTask?.nextRunAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uma task cuja avaliação lança (bug futuro) vira error nela, sem derrubar as demais (fail-soft por task)", () => {
    clearTasksCache();
    const root = makeRoot();
    try {
      const data = buildTasksData(root, {
        now: () => new Date("2026-08-10T12:00:00.000Z"),
        queryArmedFn: (taskName: string) => {
          if (taskName === SCHEDULED_TASKS[0].name) throw new Error("probe quebrado de propósito");
          return ALWAYS_ARMED();
        },
        readLastRunFn: NEVER_RUN_FN,
      });
      assert.equal(data.tasks.length, SCHEDULED_TASKS.length);
      const broken = data.tasks[0];
      assert.equal(broken.name, SCHEDULED_TASKS[0].name);
      assert.match(broken.error ?? "", /probe quebrado de propósito/);
      // as demais continuam normais.
      assert.ok(data.tasks.slice(1).every((t) => t.error === null));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cache: 2ª chamada dentro do TTL não reavalia (mesmo objeto de dados, cached:true)", () => {
    clearTasksCache();
    const root = makeRoot();
    let calls = 0;
    try {
      const queryArmedFn = () => {
        calls++;
        return ALWAYS_ARMED();
      };
      const first = buildTasksData(root, {
        now: () => new Date(0),
        cacheTtlMs: 60_000,
        queryArmedFn,
        readLastRunFn: NEVER_RUN_FN,
      });
      assert.equal(first.cached, false);
      const callsAfterFirst = calls;

      const second = buildTasksData(root, {
        now: () => new Date(1000),
        cacheTtlMs: 60_000,
        queryArmedFn,
        readLastRunFn: NEVER_RUN_FN,
      });
      assert.equal(second.cached, true);
      assert.equal(calls, callsAfterFirst, "não deveria ter reavaliado nenhuma task dentro do TTL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forceRefresh bypassa o cache mesmo dentro do TTL", () => {
    clearTasksCache();
    const root = makeRoot();
    let calls = 0;
    try {
      const queryArmedFn = () => {
        calls++;
        return ALWAYS_ARMED();
      };
      buildTasksData(root, { now: () => new Date(0), cacheTtlMs: 60_000, queryArmedFn, readLastRunFn: NEVER_RUN_FN });
      const callsAfterFirst = calls;
      const second = buildTasksData(root, {
        now: () => new Date(1000),
        cacheTtlMs: 60_000,
        forceRefresh: true,
        queryArmedFn,
        readLastRunFn: NEVER_RUN_FN,
      });
      assert.equal(second.cached, false);
      assert.ok(calls > callsAfterFirst, "forceRefresh deveria ter reavaliado as tasks");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
