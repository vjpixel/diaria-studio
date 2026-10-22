/**
 * social-slot-planner-10819.test.ts (#10819)
 *
 * Grades reais de 261022 (corpo da issue): diar.ia.br com posts às 07:00,
 * 11:00, 15:00 e 19:00 BRT; Reels às 06:00 fixas; VJ pixel sem nada além do
 * Reels. A regra antiga (06:00 fixas, cego à grade) é o que estes casos travam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MIN_GAP_MINUTES,
  DEFAULT_PEAK_WINDOWS_BRT,
  brtDayWindow,
  gridFromShortsPublished,
  gridFromSocialPublished,
  planSlot,
  planSlots,
  socialAccountKey,
  type ScheduledSlot,
} from "../scripts/lib/social-slot-planner.ts";

const brt = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00-03:00`).toISOString();
const WINDOW = brtDayWindow("261022");

/** Posts diários da diar.ia.br em 261022, nas 3 contas que recebem a grade. */
function dailyGrid(accounts = ["instagram:diaria", "facebook:diaria", "linkedin:diaria"]): ScheduledSlot[] {
  return accounts.flatMap((account) => ["07:00", "11:00", "15:00", "19:00"].map((h) => ({ account, at: brt(h) })));
}

describe("#10819 regra 1: conta sem post no dia alinha a horário de outra conta", () => {
  it("Reels da página VJ pixel (06:00 preferido) sai às 07:00, junto do 1º post da diar.ia.br — não às 06:00 cegas", () => {
    const d = planSlot(dailyGrid(), { account: "facebook:vjpixel", window: WINDOW, preferredAt: brt("06:00") });
    assert.equal(d.rule, "align-other-account");
    assert.equal(d.at, brt("07:00"));
    assert.match(d.premise, /07:00 BRT/);
  });

  it("sem preferredAt escolhe o horário de outra conta mais cedo", () => {
    const d = planSlot(dailyGrid(), { account: "instagram:vjpixel", window: WINDOW });
    assert.equal(d.at, brt("07:00"));
  });

  it("respeita notBefore: depois das 12:00 o alinhamento vai pro 15:00", () => {
    const d = planSlot(dailyGrid(), {
      account: "instagram:vjpixel",
      window: WINDOW,
      preferredAt: brt("06:00"),
      notBefore: brt("12:00"),
    });
    assert.equal(d.at, brt("15:00"));
  });

  it("empate de distância ao preferido escolhe o mais cedo", () => {
    const d = planSlot(dailyGrid(), { account: "instagram:vjpixel", window: WINDOW, preferredAt: brt("09:00") });
    assert.equal(d.at, brt("07:00"));
  });
});

describe("#10819 regra 2: conta com vários posts distribui o dia dela", () => {
  it("Reels do Instagram da diar.ia.br não fica colado às 06:00 — sai às 09:00 (120 min dos vizinhos)", () => {
    const d = planSlot(dailyGrid(), { account: "instagram:diaria", window: WINDOW, preferredAt: brt("06:00") });
    assert.equal(d.rule, "spread-same-account");
    assert.equal(d.at, brt("09:00"));
    assert.equal(d.warning, undefined);
  });

  it("nunca empilha no horário de um post da mesma conta", () => {
    const d = planSlot(dailyGrid(), { account: "instagram:diaria", window: WINDOW, preferredAt: brt("11:00") });
    const own = new Set(dailyGrid(["instagram:diaria"]).map((s) => s.at));
    assert.ok(d.at && !own.has(d.at));
    // 09:00 e 13:00 empatam em 120 min e na distância ao 11:00 → o mais cedo
    assert.equal(d.at, brt("09:00"));
  });

  it("desempata a favor do horário de post de outra conta", () => {
    // Conta própria às 08, 12 e 16; janela 06–18: 10:00 e 14:00 empatam (120
    // min). Outra conta às 14:00 → 14:00 vence o mais cedo.
    const grid: ScheduledSlot[] = [
      { account: "instagram:diaria", at: brt("08:00") },
      { account: "instagram:diaria", at: brt("12:00") },
      { account: "instagram:diaria", at: brt("16:00") },
      { account: "facebook:vjpixel", at: brt("14:00") },
    ];
    const d = planSlot(grid, { account: "instagram:diaria", window: { start: brt("06:00"), end: brt("18:00") } });
    assert.equal(d.at, brt("14:00"));
    assert.match(d.premise, /alinhado a post de outra conta/);
  });

  it("não joga o post pra borda da janela (22:00) só por estar longe de tudo", () => {
    const d = planSlot(dailyGrid(), { account: "instagram:diaria", window: WINDOW });
    assert.notEqual(d.at, brt("22:00"));
    assert.equal(d.at, brt("09:00"));
  });

  it("avisa quando nenhum horário respeita o espaçamento mínimo, sem deixar de decidir", () => {
    const grid: ScheduledSlot[] = [
      { account: "instagram:diaria", at: brt("10:00") },
      { account: "instagram:diaria", at: brt("11:00") },
    ];
    const d = planSlot(grid, { account: "instagram:diaria", window: { start: brt("10:00"), end: brt("11:00") }, minGapMinutes: 60 });
    assert.equal(d.at, brt("10:30"));
    assert.match(d.warning ?? "", /espaçamento mínimo/);
  });

  it("planSlots: dois Reels da mesma conta em sequência nunca caem no mesmo horário", () => {
    const [a, b] = planSlots(dailyGrid(), [
      { account: "instagram:diaria", window: WINDOW, preferredAt: brt("06:00") },
      { account: "instagram:diaria", window: WINDOW, preferredAt: brt("06:00") },
    ]);
    assert.equal(a.at, brt("09:00"));
    assert.notEqual(b.at, a.at);
    assert.equal(b.at, brt("13:00"));
  });

  it("planSlots: o 1º planejado vira referência de alinhamento pra outra conta", () => {
    const [a, b] = planSlots([], [
      { account: "facebook:diaria", window: WINDOW, preferredAt: brt("06:00") },
      { account: "facebook:vjpixel", window: WINDOW, preferredAt: brt("08:00") },
    ]);
    assert.equal(a.rule, "empty-grid");
    assert.equal(b.rule, "align-other-account");
    assert.equal(b.at, a.at);
  });
});

describe("#10819 grade vazia e bordas", () => {
  it("grade vazia usa o horário preferido", () => {
    const d = planSlot([], { account: "instagram:diaria", window: WINDOW, preferredAt: brt("06:00") });
    assert.equal(d.rule, "empty-grid");
    assert.equal(d.at, brt("06:00"));
  });

  it("grade vazia sem preferido → meio da janela útil", () => {
    const d = planSlot([], { account: "instagram:diaria", window: WINDOW });
    assert.equal(d.at, brt("14:00"));
  });

  it("janela já passou → no-slot com at null", () => {
    const d = planSlot(dailyGrid(), { account: "instagram:diaria", window: WINDOW, notBefore: brt("23:00") });
    assert.equal(d.rule, "no-slot");
    assert.equal(d.at, null);
  });

  it("posts de outro dia não contam", () => {
    const grid = [{ account: "instagram:diaria", at: "2026-10-21T10:00:00.000Z" }];
    const d = planSlot(grid, { account: "instagram:vjpixel", window: WINDOW, preferredAt: brt("06:00") });
    assert.equal(d.rule, "empty-grid");
  });

  it("data inválida lança (bug do caller, não 'sem horário')", () => {
    assert.throws(() => planSlot([{ account: "x:y", at: "ontem" }], { account: "a:b", window: WINDOW }), /data inválida/);
    assert.throws(() => brtDayWindow("2610"), /aammdd inválido/);
  });
});

describe("#10819 adaptadores dos stores", () => {
  it("06-social-published.json: só scheduled/published com horário; page default diaria", () => {
    const grid = gridFromSocialPublished({
      posts: [
        { platform: "instagram", destaque: "d1", status: "scheduled", scheduled_at: brt("07:00"), url: null },
        { platform: "facebook", destaque: "d1", page: "vjpixel", status: "scheduled", scheduled_at: brt("11:00"), url: null },
        { platform: "linkedin", destaque: "d2", status: "failed", scheduled_at: brt("11:00"), url: null },
        { platform: "threads", destaque: "d3", status: "published", scheduled_at: null, published_at: brt("15:00"), url: "x" },
        { platform: "x", destaque: "d3", status: "scheduled", scheduled_at: null, url: null },
      ],
    });
    assert.deepEqual(
      grid.map((s) => [s.account, s.at]),
      [
        ["instagram:diaria", brt("07:00")],
        ["facebook:vjpixel", brt("11:00")],
        ["threads:diaria", brt("15:00")],
      ],
    );
    assert.deepEqual(gridFromSocialPublished(null), []);
  });

  it("06-shorts-published.json: instagram vira a conta autora; facebook:{slug} passa direto", () => {
    const grid = gridFromShortsPublished(
      {
        aammdd: "261022",
        entries: [
          { destination: "facebook:diaria", status: "scheduled", id: "1", scheduled_at: brt("06:00"), at: brt("01:00") },
          { destination: "instagram", status: "published", id: "2", scheduled_at: null, at: brt("06:02") },
          { destination: "youtube_shorts", status: "published", id: "u", at: brt("12:00") },
        ],
      },
      "vjpixel",
    );
    assert.deepEqual(
      grid.map((s) => [s.account, s.at]),
      [
        ["facebook:diaria", brt("06:00")],
        ["instagram:vjpixel", brt("06:02")],
        ["youtube_shorts:diaria", brt("12:00")],
      ],
    );
  });

  it("socialAccountKey normaliza caixa e página ausente", () => {
    assert.equal(socialAccountKey("Instagram"), "instagram:diaria");
    assert.equal(socialAccountKey("facebook", "VJPixel"), "facebook:vjpixel");
  });
});

describe("#10819 decisão do editor (briefing 261022b): espaçamento mínimo 2 h + preferência por picos", () => {
  it("defaults: 120 min e picos manhã/almoço/noite", () => {
    assert.equal(DEFAULT_MIN_GAP_MINUTES, 120);
    assert.deepEqual(
      DEFAULT_PEAK_WINDOWS_BRT.map((w) => `${w.start}-${w.end}`),
      ["07:00-09:00", "12:00-14:00", "18:00-21:00"],
    );
  });

  it("grade 261022 + Reels às 12:00 na diar.ia.br: o 2º post novo do dia fica em pico e a ≥2 h de todos", () => {
    // Reels (12:00, teste #10831) já agendado no Facebook da diar.ia.br além dos 4 posts diários.
    const grid = [...dailyGrid(), { account: "facebook:diaria", at: brt("12:00") }];
    const d = planSlot(grid, { account: "facebook:diaria", window: WINDOW, preferredAt: brt("12:00") });
    assert.equal(d.rule, "spread-same-account");
    // A ≥120 min de 07/11/12/15/19: 09:00, 17:00, 21:00 e 22:00. Em pico: 09:00 e 21:00.
    // 09:00 fica a 120 min dos vizinhos; 21:00 só a 60 da borda das 22:00 → 09:00.
    assert.equal(d.at, brt("09:00"));
    assert.equal(d.warning, undefined);
    assert.match(d.premise, /pico de uso/);
  });

  it("pico vence espalhamento quando os dois respeitam 2 h", () => {
    // Um post às 10:00, janela 06–22. Sem picos, o mais espalhado é 16:00 (360 min do post e da borda).
    // Com picos, só os horários de pico a ≥2 h disputam: 14:00 e 18:00 empatam (240 min) → o mais cedo.
    const grid: ScheduledSlot[] = [{ account: "instagram:diaria", at: brt("10:00") }];
    const withPeaks = planSlot(grid, { account: "instagram:diaria", window: WINDOW });
    assert.equal(withPeaks.at, brt("14:00"));
    const noPeaks = planSlot(grid, { account: "instagram:diaria", window: WINDOW, peakWindows: [] });
    assert.equal(noPeaks.at, brt("16:00"));
  });

  it("respeitar 2 h vem antes do pico: horário de pico colado (<2 h) perde para um fora de pico a 2 h", () => {
    // Posts às 08, 11, 13 e 19: manhã e almoço inteiros ficam a <2 h de algum post; da noite só 21:00
    // (120 min do 19:00) respeita o espaçamento → 21:00, mesmo perto da borda.
    const grid: ScheduledSlot[] = ["08:00", "11:00", "13:00", "19:00"].map((h) => ({ account: "linkedin:diaria", at: brt(h) }));
    const d = planSlot(grid, { account: "linkedin:diaria", window: WINDOW, preferredAt: brt("12:00") });
    assert.equal(d.at, brt("21:00"));
    // Com pico só no almoço (todo colado), o espaçamento vence o pico: 16:00, o mais espalhado entre os livres.
    const lunchOnly = planSlot(grid, { account: "linkedin:diaria", window: WINDOW, peakWindows: [{ start: "12:00", end: "14:00" }] });
    assert.equal(lunchOnly.at, brt("16:00"));
    assert.equal(lunchOnly.warning, undefined);
  });

  it("nenhum horário respeita 2 h → escolhe o mais espaçado e avisa (pico não pesa aí)", () => {
    const grid: ScheduledSlot[] = ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"].map((h) => ({ account: "x:y", at: brt(h) }));
    const d = planSlot(grid, { account: "x:y", window: WINDOW });
    assert.match(d.warning ?? "", /espaçamento mínimo de 120 min/);
    assert.ok(d.at);
  });

  it("peakWindows inválida lança", () => {
    assert.throws(
      () => planSlot([{ account: "a:b", at: brt("10:00") }], { account: "a:b", window: WINDOW, peakWindows: [{ start: "9:00", end: "10:00" }] }),
      /peakWindows/,
    );
  });
});
