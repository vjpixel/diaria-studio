/**
 * #11689 — guard de horário passado no agendamento da newsletter (Stage 6).
 * Relógio sempre injetado: nenhum teste depende de Date.now().
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkScheduledAtNotPast,
  nextViableScheduledAt,
  isoToBrtHhmm,
  MIN_SCHEDULE_LEAD_MS,
} from "../scripts/lib/edition-scheduled-at.ts";
import { main } from "../scripts/resolve-edition-scheduled-at.ts";

describe("checkScheduledAtNotPast (#11689)", () => {
  const now = new Date("2026-10-30T16:18:00.000Z"); // 13:18 BRT, caso real da 261030

  it("06:00 BRT do próprio dia (09:00Z) às 16:18Z é passado, com próximo viável", () => {
    const r = checkScheduledAtNotPast("2026-10-30T09:00:00.000Z", now);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.nextViable, "2026-10-30T16:35:00.000Z");
      assert.equal(r.nextViableBrt, "13:35");
      assert.match(r.reason, /passado/);
    }
  });

  it("futuro além da margem passa", () => {
    assert.equal(checkScheduledAtNotPast("2026-10-31T09:00:00.000Z", now).ok, true);
  });

  it("limite exato da margem passa; 1 ms antes falha", () => {
    const edge = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS).toISOString();
    assert.equal(checkScheduledAtNotPast(edge, now).ok, true);
    assert.equal(checkScheduledAtNotPast(new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS - 1).toISOString(), now).ok, false);
  });

  it("ISO malformado não é tratado como passado (cada agendador recusa com exit próprio)", () => {
    assert.equal(checkScheduledAtNotPast("lixo", now).ok, true);
  });

  it("próximo viável arredonda pra cima e vira o dia em BRT", () => {
    assert.equal(nextViableScheduledAt(new Date("2026-10-30T16:20:00.000Z")), "2026-10-30T16:35:00.000Z");
    assert.equal(isoToBrtHhmm("2026-10-31T02:30:00.000Z"), "23:30");
  });
});

describe("resolve-edition-scheduled-at CLI com relógio (#11689)", () => {
  let argv: string[];
  let ow: typeof process.stdout.write;
  let oe: typeof process.stderr.write;
  let out: string;
  let err: string;
  beforeEach(() => {
    argv = process.argv;
    ow = process.stdout.write.bind(process.stdout);
    oe = process.stderr.write.bind(process.stderr);
    out = err = "";
    process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => ((err += c), true)) as typeof process.stderr.write;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.argv = argv;
    process.stdout.write = ow;
    process.stderr.write = oe;
    process.exitCode = undefined;
  });

  it("passado: exit 2, stdout vazio, stderr com next_viable", () => {
    process.argv = ["node", "x", "--aammdd", "261030", "--now", "2026-10-30T16:18:00.000Z"];
    main();
    assert.equal(process.exitCode, 2);
    assert.equal(out, "");
    assert.match(err, /next_viable=2026-10-30T16:35:00.000Z next_viable_brt=13:35/);
  });

  it("--hhmm futuro no mesmo dia resolve normalmente", () => {
    process.argv = ["node", "x", "--aammdd", "261030", "--hhmm", "18:00", "--now", "2026-10-30T16:18:00.000Z"];
    main();
    assert.equal(process.exitCode, undefined);
    assert.equal(out, "2026-10-30T21:00:00.000Z");
  });

  it("edição futura (06:00 BRT de amanhã) resolve", () => {
    process.argv = ["node", "x", "--aammdd", "261031", "--now", "2026-10-30T16:18:00.000Z"];
    main();
    assert.equal(out, "2026-10-31T09:00:00.000Z");
  });
});

describe("agendadores recusam horário passado (#11689)", () => {
  it("schedule-newsletter-kit: code 6 antes de qualquer leitura, sem tocar no Kit", async () => {
    const { scheduleNewsletterKit } = await import("../scripts/schedule-newsletter-kit.ts");
    let touched = false;
    const deps = new Proxy({}, { get: () => () => { touched = true; throw new Error("não deveria chamar"); } });
    const r = await scheduleNewsletterKit(
      "/fake/data/editions/2610/261030",
      "2026-10-30T09:00:00.000Z",
      deps as never,
      { now: new Date("2026-10-30T16:18:00.000Z") },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 6);
      assert.match(r.reason, /13:35 BRT/);
    }
    assert.equal(touched, false);
  });

  it("schedule-daily-brevo: code 6", async () => {
    const { scheduleDailyBrevo } = await import("../scripts/schedule-daily-brevo.ts");
    const deps = new Proxy({}, { get: () => () => { throw new Error("não deveria chamar"); } });
    const r = await scheduleDailyBrevo("/fake/data/editions/2610/261030", "2026-10-30T09:00:00.000Z", deps as never, {
      now: new Date("2026-10-30T16:18:00.000Z"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 6);
  });

  it("schedule-kit-diaria: code 5", async () => {
    const { scheduleKitDiaria } = await import("../scripts/schedule-kit-diaria.ts");
    const deps = new Proxy({}, { get: () => () => { throw new Error("não deveria chamar"); } });
    const r = await scheduleKitDiaria("/fake/data/editions/2610/261030", "2026-10-30T09:00:00.000Z", deps as never, {
      now: new Date("2026-10-30T16:18:00.000Z"),
    });
    assert.equal(r.code, 5);
  });
});
