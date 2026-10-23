/**
 * test/publish-shorts-slot-planner-10819.test.ts
 *
 * #10819: o `publish-shorts.ts` passa a olhar a grade já agendada do dia.
 * Durante o teste de horário do vertical (#10831) o horário do teste tem
 * precedência e a grade só avisa; fora dele, o `social-slot-planner` escolhe
 * o horário de cada destino de API. Antes deste fix todos os destinos saíam
 * no mesmo horário, cegos à grade. Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planShortSlots, type ShortDestination } from "../scripts/lib/diaria/short-video.ts";
import { loadScheduledGrid, planShortsPublish } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import type { ScheduledSlot } from "../scripts/lib/social-slot-planner.ts";

const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-03:00`).toISOString();
const reviewed = "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n";
const pages: ResolvedFacebookPage[] = [
  { slug: "diaria", enabled: true, pageId: "1", token: "t1", missing: [], utmContent: null },
  { slug: "vjpixel", enabled: false, pageId: "937", token: "tok", missing: [], utmContent: "page-vjpixel" },
];

function daily(date: string, accounts = ["facebook:diaria", "instagram:diaria", "linkedin:diaria"]): ScheduledSlot[] {
  return accounts.flatMap((account) => ["07:00", "11:00", "15:00", "19:00"].map((h) => ({ account, at: at(date, h) })));
}

function plan(aammdd: string, date: string, grid: ScheduledSlot[], extra: Partial<Parameters<typeof planShortsPublish>[0]> = {}) {
  return planShortsPublish({
    aammdd,
    reviewedMd: reviewed,
    now: new Date(`${date}T03:00:00Z`),
    config: {},
    pages,
    instagramReady: true,
    published: { aammdd, entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 1 },
    editionUrl: "https://diar.ia.br/p/x",
    grid,
    ...extra,
  });
}

describe("#10819 durante o teste do #10831: horário do teste tem precedência", () => {
  it("261027 (08:00 do teste) mantém 08:00 em todos os destinos mesmo com post da diar.ia.br por perto", () => {
    const p = plan("261027", "2026-10-27", daily("2026-10-27"));
    assert.ok(p.slots.length > 0);
    for (const s of p.slots) {
      assert.equal(s.rule, "test-schedule");
      assert.equal(s.hhmm, "08:00");
    }
    const fb = p.items.find((i) => i.destination === "facebook:diaria") as { scheduledAt: string | null };
    assert.equal(fb.scheduledAt, at("2026-10-27", "08:00"));
  });

  it("avisa quando o horário do teste cola num post da MESMA conta (facebook:diaria, 06:30 contra o post das 07:00), não nas outras", () => {
    const p = plan("261026", "2026-10-26", daily("2026-10-26"));
    const fbWarn = p.warnings.filter((w) => w.startsWith("facebook:diaria:"));
    assert.equal(fbWarn.length, 1);
    assert.match(fbWarn[0], /06:30 BRT/);
    // VJ pixel (página e Instagram autor) não tem post no dia: sem aviso.
    assert.ok(!p.warnings.some((w) => w.startsWith("facebook:vjpixel:") || w.startsWith("instagram:")));
  });

  it("grade vazia: sem aviso de grade", () => {
    const p = plan("261026", "2026-10-26", []);
    assert.ok(!p.warnings.some((w) => /mesma conta/.test(w)));
  });
});

describe("#10819 fora do teste: o planner decide por destino", () => {
  // 261116 (segunda) fica depois de rotation_end (2026-11-13): default_time 12:00.
  it("página da diar.ia.br espalha entre os próprios posts; VJ pixel e Instagram alinham a post de outra conta", () => {
    const p = plan("261116", "2026-11-16", daily("2026-11-16"));
    assert.equal(p.shortTime.source, "default");
    const by = Object.fromEntries(p.slots.map((s) => [s.destination, s]));
    // facebook:diaria tem 07/11/15/19: 09, 13 e 17 empatam em 120 min; 13:00 é o mais perto do 12:00 preferido.
    assert.equal(by["facebook:diaria"].rule, "spread-same-account");
    assert.equal(by["facebook:diaria"].hhmm, "13:00");
    // VJ pixel sem post: alinha ao horário de outra conta mais perto de 12:00 (11:00 e 13:00 empatam → o mais cedo).
    assert.equal(by["facebook:vjpixel"].rule, "align-other-account");
    assert.equal(by["facebook:vjpixel"].hhmm, "11:00");
    // Instagram autor = conta do editor (instagram:vjpixel), não a da diar.ia.br.
    assert.equal(by["instagram"].account, "instagram:vjpixel");
    assert.equal(by["instagram"].hhmm, "11:00");

    const fb = p.items.find((i) => i.destination === "facebook:diaria") as { scheduledAt: string | null };
    assert.equal(fb.scheduledAt, at("2026-11-16", "13:00"));
    const ig = p.items.find((i) => i.destination === "instagram") as { action: string; detail: string };
    assert.equal(ig.action, "pending_schedule");
    assert.match(ig.detail, /11:00 BRT/);
  });

  it("nunca empilha o Reels num post da mesma conta (o bug antigo: todos no horário fixo)", () => {
    const grid: ScheduledSlot[] = [{ account: "facebook:diaria", at: at("2026-11-16", "12:00") }];
    const p = plan("261116", "2026-11-16", grid);
    const fb = p.slots.find((s) => s.destination === "facebook:diaria")!;
    assert.notEqual(fb.at, at("2026-11-16", "12:00"));
  });

  it("destino já registrado e página sem credencial não disputam a grade", () => {
    const p = plan("261116", "2026-11-16", [], {
      pages: [pages[0], { ...pages[1], missing: ["FACEBOOK_VJPIXEL_PAGE_TOKEN"] }],
      published: { aammdd: "261116", entries: [{ destination: "facebook:diaria", status: "published", id: "1", at: at("2026-11-16", "12:00") }] },
    });
    assert.deepEqual(p.slots.map((s) => s.destination), ["instagram"]);
  });

  it("--now ignora o horário planejado (publica na hora)", () => {
    const p = plan("261116", "2026-11-16", daily("2026-11-16"), { forceNow: true });
    const fb = p.items.find((i) => i.destination === "facebook:diaria") as { action: string; scheduledAt: string | null };
    assert.equal(fb.action, "publish");
    assert.equal(fb.scheduledAt, null);
  });
});

describe("#10819 planShortSlots puro", () => {
  const dests: ShortDestination[] = [
    { id: "youtube_shorts", kind: "youtube_shorts", mode: "guided" },
    { id: "facebook:diaria", kind: "facebook_page", mode: "api", slug: "diaria" },
    { id: "facebook_profile", kind: "facebook_profile", mode: "guided" },
  ];
  it("destinos guiados ficam fora (seguem shortTime)", () => {
    const slots = planShortSlots({
      aammdd: "261116",
      time: { hhmm: "12:00", source: "default", reason: "x" },
      timeAt: at("2026-11-16", "12:00"),
      destinations: dests,
      cfg: { instagramAuthorPage: null },
      grid: [],
    });
    assert.deepEqual(slots.map((s) => s.destination), ["facebook:diaria"]);
    assert.equal(slots[0].hhmm, "12:00");
    assert.equal(slots[0].rule, "empty-grid");
  });
});

describe("#10819 loadScheduledGrid", () => {
  it("junta 06-social-published com o registro do vertical; store social ilegível vira aviso", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-grid-10819-"));
    try {
      const published = { aammdd: "261116", entries: [{ destination: "instagram", status: "published" as const, id: "9", at: at("2026-11-16", "12:00") }] };
      const warns: string[] = [];
      // sem store social: só o vertical, Instagram na conta autora
      assert.deepEqual(loadScheduledGrid(dir, published, "vjpixel", (m) => warns.push(m)).map((s) => s.account), ["instagram:vjpixel"]);

      mkdirSync(join(dir, "_internal"));
      writeFileSync(
        join(dir, "_internal", "06-social-published.json"),
        JSON.stringify({ posts: [{ platform: "facebook", destaque: "d1", status: "scheduled", scheduled_at: at("2026-11-16", "09:45") }] }),
      );
      const grid = loadScheduledGrid(dir, published, "vjpixel", (m) => warns.push(m));
      assert.deepEqual(grid.map((s) => s.account).sort(), ["facebook:diaria", "instagram:vjpixel"]);
      assert.equal(warns.length, 0);

      writeFileSync(join(dir, "_internal", "06-social-published.json"), "{nao é json");
      const g2 = loadScheduledGrid(dir, published, "vjpixel", (m) => warns.push(m));
      assert.equal(g2.length, 1);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /ilegível/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
