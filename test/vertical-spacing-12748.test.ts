import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeScheduledAt } from "../scripts/compute-social-schedule.ts";
import { planLinkedInRepostSlot } from "../scripts/lib/diaria/short-video.ts";
import { configuredVerticalGrid } from "../scripts/lib/diaria/vertical-schedule-grid.ts";
import { brtDayWindow, planStrictDailySlots, slotAccounts } from "../scripts/lib/social-slot-planner.ts";
import { publicationScheduleTable } from "../scripts/publication-schedule-table.ts";

const config = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
const fixture = () => {
  const c = structuredClone(config);
  c.publishing.social.rotation = { enabled: false };
  c.publishing.social.fallback_schedule = { day_offset: 0, d1_time: "11:00", d2_time: "15:00", d3_time: "19:00" };
  c.publishing.social.use_melhor_time = "07:00";
  return c;
};
const types = ["um", "d1", "d2", "d3"] as const;
const now = Date.parse("2026-11-01T00:00:00Z");
const gap = 120 * 60_000;
function check(c: typeof config, platform: "linkedin" | "facebook" | "instagram" | "twitter" | "threads", edition = "261111", clock = now, dayOffsetOverride?: number) {
  const dates = types.map((destaque) => computeScheduledAt({ config: c, editionDate: edition, destaque, platform, now: clock, dayOffsetOverride }));
  const reserved = configuredVerticalGrid(c, edition).filter((s) => slotAccounts(s).includes(`${platform}:diaria`)).map((s) => s.at);
  const times = [...dates, ...reserved].map(Date.parse).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= gap, `${platform}: ${times.map((t) => new Date(t).toISOString())}`);
  return dates;
}

describe("vertical fixo e social desvia (#12748)", () => {
  it("mantém offset explícito e hora local também nos slots deslocados", () => {
    const dates = check(fixture(), "facebook");
    assert.equal(dates[1], "2026-11-11T10:00:00-03:00");
    for (const at of dates) assert.match(at, /T\d{2}:\d{2}:00-03:00$/);
    const linkedin = check(fixture(), "linkedin");
    assert.equal(linkedin[1], "2026-11-11T10:30:00-03:00");
  });
  it("11h × 12h: evita colisão antes de existir store, em todas as contas compartilhadas", () => {
    const c = fixture();
    for (const platform of ["linkedin", "facebook", "instagram", "twitter"] as const) {
      const dates = check(c, platform);
      assert.notEqual(Date.parse(dates[1]), Date.parse("2026-11-11T11:00:00-03:00"));
      assert.deepEqual(dates, check(c, platform));
    }
    assert.match(check(c, "threads")[1], /T11:00:00/); // vertical é no perfil pessoal
  });
  it("conta a collab mesmo quando a autora é vjpixel; usa override por destino", () => {
    const c = fixture();
    c.publishing.shorts.instagram_author_page = "vjpixel";
    c.publishing.shorts.instagram_collaborators = ["diar.ia.br"];
    c.publishing.shorts.schedule.by_destination.instagram = "15:00";
    check(c, "instagram");
    const s = configuredVerticalGrid(c, "261111").find((s) => s.account === "instagram:vjpixel")!;
    assert.ok(s.alsoAccounts?.includes("instagram:diaria"));
    assert.equal(new Date(s.at).getUTCHours(), 18);
  });
  it("reconstrói a rotação inteira por data e mantém 2h durante um ciclo", () => {
    const c = fixture();
    c.publishing.social.rotation = config.publishing.social.rotation;
    for (let day = 9; day <= 20; day++) check(c, "instagram", `2611${String(day).padStart(2, "0")}`);
  });
  it("não reduz espaçamento para now+15min em execução tardia", () => {
    const c = fixture();
    const dates = check(c, "facebook", "261111", Date.parse("2026-11-11T10:30:00-03:00"));
    assert.ok(dates.every((s) => Date.parse(s) >= Date.parse("2026-11-11T10:45:00-03:00")));
    assert.throws(() => check(c, "facebook", "261111", Date.parse("2026-11-11T21:00:00-03:00")), /sem grade social/);
  });
  it("respeita day_offset e não bloqueia posts em outro dia pelo vertical da edição", () => {
    check(fixture(), "facebook", "261111", now, 1);
  });
  it("reserva o mesmo repost da Parte B, após os 30 min do perfil", () => {
    const grid = configuredVerticalGrid(fixture(), "261111");
    const profile = grid.find((s) => s.account === "linkedin:pessoal")!;
    const repost = grid.find((s) => s.account === "linkedin:diaria")!;
    assert.equal(Date.parse(repost.at) - Date.parse(profile.at), 30 * 60_000);
    const actual = planLinkedInRepostSlot({ aammdd: "261111", profileAt: profile.at, fixedAt: "2026-11-11T12:00:00-03:00", grid: [] });
    assert.equal(Date.parse(actual.at), Date.parse(repost.at));
    assert.throws(() => planLinkedInRepostSlot({ aammdd: "261111", profileAt: profile.at, fixedAt: repost.at,
      grid: [{ account: "linkedin:diaria", at: "2026-11-11T12:15:00-03:00" }] }), /colide com social/);
    const table = publicationScheduleTable(fixture(), "261111", {}, {});
    assert.match(table, /LinkedIn página.*12:30 \(previsto\)/);
  });
  it("config sintético e opt-out da rotação preservam o comportamento anterior", () => {
    const c = fixture();
    delete c.publishing.shorts;
    assert.match(computeScheduledAt({ config: c, editionDate: "261111", destaque: "d1", platform: "facebook", now }), /T11:00:00/);
    assert.match(computeScheduledAt({ config: fixture(), editionDate: "261111", destaque: "d1", platform: "facebook", now, applyRotation: false }), /T11:00:00/);
  });
  it("falha antes do envio se nenhuma combinação tem espaço", () => {
    const window = brtDayWindow("261111", "11:00", "13:00");
    assert.throws(() => planStrictDailySlots([{ account: "x", at: "2026-11-11T12:00:00-03:00" }], [{ account: "x", window }]), /sem grade social/);
  });
  it("tabela tem destinos exclusivos, collab e horários reais sobre o previsto", () => {
    const table = publicationScheduleTable(fixture(), "261111", { posts: [{ platform: "facebook", destaque: "d1", status: "scheduled", scheduled_at: "2026-11-11T10:00:00-03:00" }] }, { entries: [{ destination: "x", scheduled_at: "2026-11-11T12:15:00-03:00" }] });
    assert.match(table, /Vertical/);
    for (const name of ["YouTube Shorts", "TikTok", "Threads pessoal", "LinkedIn perfil", "Instagram"]) assert.ok(table.includes(name));
    assert.match(table, /YouTube Shorts \| — \| — \| — \| — \| 06:30 \(previsto\)/);
    assert.match(table, /Facebook diar.ia.br \| — \| 10:00 \| — \| — \| 12:00 \(previsto\)/);
    assert.match(table, /X \| — \| — \| — \| — \| 12:15 \|/);
  });
});
