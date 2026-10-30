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
  FINAL_GUARD_MIN_LEAD_MS,
} from "../scripts/lib/edition-scheduled-at.ts";
import { main } from "../scripts/resolve-edition-scheduled-at.ts";

describe("checkScheduledAtNotPast (#11689)", () => {
  const now = new Date("2026-10-30T16:18:00.000Z"); // 13:18 BRT, caso real da 261030

  it("06:00 BRT do próprio dia (09:00Z) às 16:18Z é passado, com próximo viável", () => {
    const r = checkScheduledAtNotPast("2026-10-30T09:00:00.000Z", now);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.nextViable, "2026-10-30T16:50:00.000Z");
      assert.equal(r.nextViableBrt, "13:50");
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
    assert.equal(nextViableScheduledAt(new Date("2026-10-30T16:21:00.000Z")), "2026-10-30T16:55:00.000Z");
    assert.equal(isoToBrtHhmm("2026-10-31T02:30:00.000Z"), "23:30");
  });
});

describe("checkScheduledAtNotPast: folga, margem final e virada de dia (#11689)", () => {
  it("próximo viável tem folga ampla (>= 30 min), bem acima da margem de 15 min do gate", () => {
    const now = new Date("2026-10-30T16:18:00.000Z");
    const r = checkScheduledAtNotPast("2026-10-30T09:00:00.000Z", now);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(Date.parse(r.nextViable!) - now.getTime() >= 30 * 60 * 1000);
  });

  it("23:50 BRT da edição: próximo viável cairia no dia seguinte -> none, nunca HH:MM impossível", () => {
    const now = new Date("2026-10-31T02:50:00.000Z"); // 23:50 BRT de 261030
    const r = checkScheduledAtNotPast("2026-10-30T09:00:00.000Z", now, { editionAammdd: "261030" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.nextViable, null);
      assert.equal(r.nextViableBrt, null);
      assert.match(r.reason, /Não há horário viável/);
    }
  });

  it("edição de ontem (dia já passou): none", () => {
    const now = new Date("2026-10-31T15:00:00.000Z");
    const r = checkScheduledAtNotPast("2026-10-30T09:00:00.000Z", now, { editionAammdd: "261030" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.nextViable, null);
  });

  it("margem final: 5 min à frente passa (gate de 15 min recusaria); passado de fato falha", () => {
    const now = new Date("2026-10-30T16:18:00.000Z");
    const in5 = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    assert.equal(checkScheduledAtNotPast(in5, now).ok, false);
    assert.equal(checkScheduledAtNotPast(in5, now, { minLeadMs: FINAL_GUARD_MIN_LEAD_MS }).ok, true);
    assert.equal(
      checkScheduledAtNotPast(new Date(now.getTime() - 1).toISOString(), now, { minLeadMs: FINAL_GUARD_MIN_LEAD_MS }).ok,
      false,
    );
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
    assert.match(err, /next_viable=2026-10-30T16:50:00.000Z next_viable_brt=13:50/);
  });

  it("--hhmm futuro no mesmo dia resolve normalmente", () => {
    process.argv = ["node", "x", "--aammdd", "261030", "--hhmm", "18:00", "--now", "2026-10-30T16:18:00.000Z"];
    main();
    assert.equal(process.exitCode, undefined);
    assert.equal(out, "2026-10-30T21:00:00.000Z");
  });

  it("sem horário viável no dia da edição: exit 2 com next_viable=none", () => {
    process.argv = ["node", "x", "--aammdd", "261030", "--now", "2026-10-31T02:50:00.000Z"];
    main();
    assert.equal(process.exitCode, 2);
    assert.equal(out, "");
    assert.match(err, /next_viable=none next_viable_brt=none/);
  });

  it("edição futura (06:00 BRT de amanhã) resolve", () => {
    process.argv = ["node", "x", "--aammdd", "261031", "--now", "2026-10-30T16:18:00.000Z"];
    main();
    assert.equal(out, "2026-10-31T09:00:00.000Z");
  });
});

describe("agendadores: defesa final contra passado (#11689)", () => {
  const NOW = new Date("2026-10-30T16:18:00.000Z");
  const PAST = "2026-10-30T09:00:00.000Z";
  const boom = () => {
    throw new Error("não deveria chamar");
  };

  for (const dir of ["/fake/data/editions/2610/261030", "/fake/tmp/dir-sem-aammdd"]) {
    it(`newsletter-kit: passado -> code 6, sem PATCH (${dir})`, async () => {
      const { scheduleNewsletterKit } = await import("../scripts/schedule-newsletter-kit.ts");
      const deps = {
        readPublished: () => ({ broadcast_id: 1, status: "draft" }),
        writePublished: boom,
        patchSchedule: boom,
        getBroadcastStatus: boom,
      };
      const r = await scheduleNewsletterKit(dir, PAST, deps as never, { now: NOW, allowOtherDate: true });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 6);
    });

    it(`brevo: passado -> code 6, sem PUT (${dir})`, async () => {
      const { scheduleDailyBrevo } = await import("../scripts/schedule-daily-brevo.ts");
      const deps = {
        readPublished: () => ({ campaign_id: 1, list_id: 2, status: "draft" }),
        writePublished: boom,
        putSchedule: boom,
        getCampaign: boom,
        checkQuota: boom,
      };
      const r = await scheduleDailyBrevo(dir, PAST, deps as never, { now: NOW, allowOtherDate: true });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 6);
    });

    it(`kit-diaria: passado -> code 5, sem PATCH (${dir})`, async () => {
      const { scheduleKitDiaria } = await import("../scripts/schedule-kit-diaria.ts");
      const deps = {
        readPlatformConfig: () => ({ kit_diaria: { enabled: true }, publishing: { newsletter: { backend: "beehiiv" } } }),
        readState: () => ({ broadcast_id: 1, status: "draft" }),
        writeState: boom,
        patch: boom,
        verify: boom,
        log: () => {},
      };
      const r = await scheduleKitDiaria(dir, PAST, deps as never, { now: NOW, allowOtherDate: true });
      assert.equal(r.code, 5);
    });
  }

  it("idempotência: reagendar o MESMO instante já agendado segue sucesso mesmo depois que passou", async () => {
    const { scheduleNewsletterKit } = await import("../scripts/schedule-newsletter-kit.ts");
    const { scheduleDailyBrevo } = await import("../scripts/schedule-daily-brevo.ts");
    const { scheduleKitDiaria } = await import("../scripts/schedule-kit-diaria.ts");
    const dir = "/fake/data/editions/2610/261030";
    const kit = await scheduleNewsletterKit(
      dir,
      PAST,
      {
        readPublished: () => ({ broadcast_id: 1, status: "scheduled", scheduled_at: PAST }),
        writePublished: boom,
        patchSchedule: boom,
        getBroadcastStatus: boom,
      } as never,
      { now: NOW, allowOtherDate: true },
    );
    assert.equal(kit.ok, true);
    const brevo = await scheduleDailyBrevo(
      dir,
      PAST,
      {
        readPublished: () => ({ campaign_id: 1, list_id: 2, status: "scheduled", scheduled_at: PAST }),
        writePublished: boom,
        putSchedule: boom,
        getCampaign: boom,
        checkQuota: boom,
      } as never,
      { now: NOW, allowOtherDate: true },
    );
    assert.equal(brevo.ok, true);
    const diaria = await scheduleKitDiaria(
      dir,
      PAST,
      {
        readPlatformConfig: () => ({ kit_diaria: { enabled: true }, publishing: { newsletter: { backend: "beehiiv" } } }),
        readState: () => ({ broadcast_id: 1, status: "scheduled", scheduled_at: PAST }),
        writeState: boom,
        patch: boom,
        verify: async () => ({ send_at: PAST }),
        log: () => {},
      } as never,
      { now: NOW, allowOtherDate: true },
    );
    assert.equal(diaria.code, 0);
  });

  it("margem final: agendador aceita 5 min à frente (o gate de 15 min já filtrou antes)", async () => {
    const { scheduleNewsletterKit } = await import("../scripts/schedule-newsletter-kit.ts");
    const in5 = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
    let patched = false;
    const r = await scheduleNewsletterKit(
      "/fake/data/editions/2610/261030",
      in5,
      {
        readPublished: () => ({ broadcast_id: 1, status: "draft" }),
        writePublished: () => {},
        patchSchedule: async () => {
          patched = true;
        },
        getBroadcastStatus: async () => ({ status: "scheduled", sendAt: in5 }),
      } as never,
      { now: NOW, allowOtherDate: true },
    );
    assert.equal(patched, true);
    assert.equal(r.ok, true);
  });
});
