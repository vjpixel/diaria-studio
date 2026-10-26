/**
 * test/retro-semanal-staleness-alarm-11069.test.ts (#11069)
 *
 * Cenário real da issue: na semana 261024 a `/diaria-retro-semanal` só rodou
 * no sábado 24/10 às 23:12 BRT; às 07:00 desse sábado não havia store nem
 * item na fila do Worker pro carrossel `highlights`, e nada avisou. Também
 * trava o registro da task (#27 do checklist de dispatch: guard construído
 * tem que ser armado) e a entrada no registro em prosa.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mostRecentSaturday,
  toAAMMDD,
  aammddToIsoDate,
  brtDateOf,
  addDaysIso,
  storeHasModeEvidence,
  workerHasModeEvidence,
  needsWorkerLookup,
  evaluateRetroSemanalStalenessAlarm,
  buildRetroSemanalStalenessAlarmEmail,
} from "../scripts/lib/retro-semanal-staleness-alarm.ts";
import { toAlarmFinding, readWeeklyStore, lookupWorkerQueue } from "../scripts/retro-semanal-staleness-alarm.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function ymd(y: number, m: number, d: number, h = 0): Date {
  return new Date(y, m - 1, d, h);
}

const SAT = "261024";

describe("mostRecentSaturday / toAAMMDD", () => {
  it("sábado 24/10/2026 07:00 → o próprio sábado (261024)", () => {
    assert.equal(toAAMMDD(mostRecentSaturday(ymd(2026, 10, 24, 7))), "261024");
  });
  it("domingo 25/10 (catch-up do Persistent) → o sábado de ontem", () => {
    assert.equal(toAAMMDD(mostRecentSaturday(ymd(2026, 10, 25, 9))), "261024");
  });
  it("sexta 30/10 → o sábado anterior (24/10), nunca o seguinte", () => {
    assert.equal(toAAMMDD(mostRecentSaturday(ymd(2026, 10, 30))), "261024");
  });
  it("virada de mês: segunda 02/11 → sábado 31/10", () => {
    assert.equal(toAAMMDD(mostRecentSaturday(ymd(2026, 11, 2))), "261031");
  });
});

describe("helpers de data", () => {
  it("aammddToIsoDate", () => {
    assert.equal(aammddToIsoDate("261024"), "2026-10-24");
    assert.throws(() => aammddToIsoDate("2610241"));
  });
  it("addDaysIso atravessa mês", () => {
    assert.equal(addDaysIso("2026-10-31", 1), "2026-11-01");
  });
  it("brtDateOf usa o fuso BRT, não UTC (02:00Z do domingo ainda é sábado em BRT)", () => {
    assert.equal(brtDateOf("2026-10-25T02:00:00.000Z"), "2026-10-24");
    assert.equal(brtDateOf("2026-10-24T11:00:00-03:00"), "2026-10-24");
    assert.equal(brtDateOf("lixo"), null);
  });
});

describe("storeHasModeEvidence", () => {
  it("entrada weekly-highlights scheduled conta", () => {
    const store = { posts: [{ platform: "instagram", destaque: "weekly-highlights", status: "scheduled" }] };
    assert.equal(storeHasModeEvidence(store, "highlights"), true);
    assert.equal(storeHasModeEvidence(store, "clicked"), false);
  });
  it("published e draft também contam", () => {
    assert.equal(storeHasModeEvidence({ posts: [{ destaque: "weekly-highlights", status: "published" }] }, "highlights"), true);
    assert.equal(storeHasModeEvidence({ posts: [{ destaque: "weekly-highlights", status: "draft" }] }, "highlights"), true);
  });
  it("só failed/skipped/deleted NÃO conta (rodada existiu mas nada ficou agendado)", () => {
    const store = {
      posts: [
        { destaque: "weekly-highlights", status: "failed" },
        { destaque: "weekly-highlights", status: "skipped" },
        { destaque: "weekly-highlights", status: "deleted" },
      ],
    };
    assert.equal(storeHasModeEvidence(store, "highlights"), false);
  });
  it("store ausente/malformado → false, nunca lança", () => {
    assert.equal(storeHasModeEvidence(null, "highlights"), false);
    assert.equal(storeHasModeEvidence({}, "highlights"), false);
    assert.equal(storeHasModeEvidence({ posts: "x" }, "highlights"), false);
    assert.equal(storeHasModeEvidence({ posts: [null, 3] }, "highlights"), false);
  });
});

describe("workerHasModeEvidence", () => {
  it("item weekly-highlights agendado no sábado (BRT) conta", () => {
    const items = [{ key: "k1", destaque: "weekly-highlights", scheduled_at: "2026-10-24T08:00:00-03:00" }];
    assert.equal(workerHasModeEvidence(items, "highlights", "2026-10-24"), true);
  });
  it("item weekly-highlights de OUTRO sábado não conta", () => {
    const items = [{ key: "k1", destaque: "weekly-highlights", scheduled_at: "2026-10-31T11:00:00-03:00" }];
    assert.equal(workerHasModeEvidence(items, "highlights", "2026-10-24"), false);
  });
  it("post diário (d1) no mesmo dia não conta", () => {
    const items = [{ key: "k1", destaque: "d1", scheduled_at: "2026-10-24T09:45:00-03:00" }];
    assert.equal(workerHasModeEvidence(items, "highlights", "2026-10-24"), false);
  });
});

describe("evaluateRetroSemanalStalenessAlarm", () => {
  it("cenário REAL da #11069: sábado 261024 sem store e sem item no Worker → alarm-missing", () => {
    const e = evaluateRetroSemanalStalenessAlarm(SAT, null, { ok: true, items: [] });
    assert.equal(e.verdict, "alarm-missing");
    assert.equal(e.highlightsSource, "none");
    assert.equal(e.workerConsulted, true);
  });
  it("store com highlights agendado → ok via store", () => {
    const store = { posts: [{ destaque: "weekly-highlights", status: "scheduled" }] };
    const e = evaluateRetroSemanalStalenessAlarm(SAT, store, null);
    assert.equal(e.verdict, "ok");
    assert.equal(e.highlightsSource, "store");
  });
  it("store ainda não replicado, mas Worker tem o item → ok via worker (item 23 das regras de dispatch)", () => {
    const items = [
      { destaque: "weekly-highlights", scheduled_at: "2026-10-24T11:00:00-03:00" },
      { destaque: "weekly-clicked", scheduled_at: "2026-10-25T11:00:00-03:00" },
    ];
    const e = evaluateRetroSemanalStalenessAlarm(SAT, null, { ok: true, items });
    assert.equal(e.verdict, "ok");
    assert.equal(e.highlightsSource, "worker");
    assert.equal(e.clickedSource, "worker");
  });
  it("só o clicked agendado ainda alarma (o slot de sábado é o do highlights)", () => {
    const store = { posts: [{ destaque: "weekly-clicked", status: "scheduled" }] };
    const e = evaluateRetroSemanalStalenessAlarm(SAT, store, { ok: true, items: [] });
    assert.equal(e.verdict, "alarm-missing");
    assert.equal(e.clickedSource, "store");
  });
  it("Worker indisponível NÃO vira ok — alarma e registra o erro", () => {
    const e = evaluateRetroSemanalStalenessAlarm(SAT, null, { ok: false, error: "Worker HTTP 503" });
    assert.equal(e.verdict, "alarm-missing");
    assert.equal(e.workerConsulted, false);
    assert.equal(e.workerError, "Worker HTTP 503");
  });
  it("needsWorkerLookup só quando o store não prova o highlights", () => {
    assert.equal(needsWorkerLookup(null), true);
    assert.equal(needsWorkerLookup({ posts: [{ destaque: "weekly-highlights", status: "scheduled" }] }), false);
  });
});

describe("toAlarmFinding / e-mail", () => {
  const evaluation = evaluateRetroSemanalStalenessAlarm(SAT, null, { ok: false, error: "credencial ausente" });
  it("fingerprint = sábado, family estado, P2, título cita o sábado", () => {
    const f = toAlarmFinding(evaluation);
    assert.equal(f.check, "retro-semanal-staleness");
    assert.equal(f.fingerprint, SAT);
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P2");
    assert.match(f.title, /261024/);
    assert.match(f.body, /credencial ausente/);
    assert.match(f.body, /\/diaria-retro-semanal 261024/);
  });
  it("e-mail cita o store e o comando, e a issue quando houver", () => {
    const mail = buildRetroSemanalStalenessAlarmEmail(evaluation, {
      issueNumber: 123,
      url: "https://example.invalid/123",
      action: "created",
    } as never);
    assert.match(mail.subject, /261024/);
    assert.match(mail.body, /data\/weekly\/261024\/06-weekly-published\.json/);
    assert.match(mail.body, /#123/);
  });
});

describe("I/O isolado do script", () => {
  it("readWeeklyStore: ausente → null; ilegível → null; válido → objeto", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-alarm-"));
    try {
      assert.equal(readWeeklyStore(SAT, dir), null);
      const weekDir = join(dir, "data", "weekly", SAT);
      mkdirSync(weekDir, { recursive: true });
      writeFileSync(join(weekDir, "06-weekly-published.json"), "{nao-json");
      assert.equal(readWeeklyStore(SAT, dir), null);
      writeFileSync(join(weekDir, "06-weekly-published.json"), JSON.stringify({ posts: [] }));
      assert.deepEqual(readWeeklyStore(SAT, dir), { posts: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("lookupWorkerQueue sem credencial → ok:false, sem rede", async () => {
    const prevUrl = process.env.DIARIA_LINKEDIN_CRON_URL;
    const prevTok = process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    delete process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    process.env.DIARIA_LINKEDIN_CRON_URL = "https://worker.example.invalid";
    try {
      const r = await lookupWorkerQueue(ROOT, async () => {
        throw new Error("não devia chamar a rede");
      });
      assert.equal(r?.ok, false);
    } finally {
      if (prevUrl === undefined) delete process.env.DIARIA_LINKEDIN_CRON_URL;
      else process.env.DIARIA_LINKEDIN_CRON_URL = prevUrl;
      if (prevTok !== undefined) process.env.DIARIA_LINKEDIN_CRON_TOKEN = prevTok;
    }
  });
  it("lookupWorkerQueue com fetch injetado devolve os items; erro vira ok:false", async () => {
    const prevUrl = process.env.DIARIA_LINKEDIN_CRON_URL;
    const prevTok = process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    process.env.DIARIA_LINKEDIN_CRON_URL = "https://worker.example.invalid";
    process.env.DIARIA_LINKEDIN_CRON_TOKEN = "t";
    try {
      const ok = await lookupWorkerQueue(ROOT, async (url) => {
        assert.match(url, /\/list$/);
        return { count: 1, items: [{ key: "a" }] };
      });
      assert.deepEqual(ok, { ok: true, items: [{ key: "a" }] });
      const fail = await lookupWorkerQueue(ROOT, async () => {
        throw new Error("boom");
      });
      assert.deepEqual(fail, { ok: false, error: "boom" });
    } finally {
      if (prevUrl === undefined) delete process.env.DIARIA_LINKEDIN_CRON_URL;
      else process.env.DIARIA_LINKEDIN_CRON_URL = prevUrl;
      if (prevTok === undefined) delete process.env.DIARIA_LINKEDIN_CRON_TOKEN;
      else process.env.DIARIA_LINKEDIN_CRON_TOKEN = prevTok;
    }
  });
});

describe("SCHEDULED_TASKS — Diaria-Retro-Semanal-Staleness-Alarm registrada (#27 do checklist de dispatch)", () => {
  it("existe no registro, aponta pro script certo, sábado antes do candidato de 08:00", () => {
    const task = getScheduledTaskByName("Diaria-Retro-Semanal-Staleness-Alarm");
    assert.ok(task, "task deve estar registrada em SCHEDULED_TASKS");
    assert.equal(task!.steps[0].script, "scripts/retro-semanal-staleness-alarm.ts");
    assert.equal(task!.logPath, "weekly/.retro-semanal-staleness-alarm.log");
    assert.equal(task!.enabled ?? true, true);
    assert.deepEqual(task!.schedule, { kind: "weekly", dayOfWeek: "Saturday", hour: 7, minute: 0 });
  });
  it("horário fica antes do candidato de fim de semana mais cedo da rotação (#10305)", () => {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const candidates: string[] = cfg?.publishing?.social?.rotation?.weekend_candidates ?? ["11:00"];
    const earliest = candidates.map((c) => Number(c.split(":")[0]) * 60 + Number(c.split(":")[1])).sort((a, b) => a - b)[0];
    const task = getScheduledTaskByName("Diaria-Retro-Semanal-Staleness-Alarm")!;
    assert.equal(task.schedule.kind, "weekly");
    const s = task.schedule as { hour: number; minute: number };
    assert.ok(s.hour * 60 + s.minute < earliest, `alarme (${s.hour}:${s.minute}) precisa vir antes do slot mais cedo`);
  });
  it("registro em prosa e doc de setup citam a task", () => {
    const registry = readFileSync(resolve(ROOT, "docs/scheduled-tasks-registry.md"), "utf8");
    assert.ok(registry.includes("Diaria-Retro-Semanal-Staleness-Alarm"));
    const setup = readFileSync(resolve(ROOT, "docs/retro-semanal-staleness-alarm-setup.md"), "utf8");
    assert.ok(setup.includes("setup-systemd-timers.ts --task Diaria-Retro-Semanal-Staleness-Alarm"));
  });
});
