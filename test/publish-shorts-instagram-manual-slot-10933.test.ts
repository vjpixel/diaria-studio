/**
 * test/publish-shorts-instagram-manual-slot-10933.test.ts
 *
 * #10933: acima do teto da API (#10893) o Instagram vira post MANUAL no app.
 * Antes deste fix esse post ficava fora da grade do planner (#10819): os outros
 * destinos eram planejados como se o Instagram não existisse naquele dia, e o
 * item guiado trazia só o `shortTime`, não um horário da grade. Agora o slot do
 * Instagram manual é reservado na grade como o de qualquer destino de API e o
 * item guiado carrega esse horário (`at`). Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planShortsPublish } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import type { ScheduledSlot } from "../scripts/lib/social-slot-planner.ts";

const reviewed = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n";
const pages: ResolvedFacebookPage[] = [
  { slug: "diaria", enabled: true, pageId: "1", token: "t1", missing: [], utmContent: null },
  { slug: "vjpixel", enabled: false, pageId: "937", token: "tok", missing: [], utmContent: "page-vjpixel" },
];
const shorts = { facebook_pages: ["diaria", "vjpixel"], instagram: true, instagram_backend: "worker-r2", instagram_author_page: "vjpixel", instagram_collaborators: ["diar.ia.br"] };

/**
 * Janela do teste de horário FIXADA no próprio teste (hotfix #10933): nunca
 * depender de `DEFAULT_SHORT_SCHEDULE_RAW` nem do `platform.config.json` vivo —
 * o #10942 trocou o default (12:00/19:00 desde 261022 → 06:30/08:00/12:00 desde
 * 261026) e um caso que omitia `schedule` deixou master vermelho. Aqui 261023 é
 * o 2º dia da rotação (19:00 BRT) e 261110 fica fora dela (default 12:00).
 */
const SCHEDULE = { rotation_times: ["12:00", "19:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const config = { publishing: { shorts: { ...shorts, schedule: SCHEDULE } } };

/** Fora da janela do teste de horário (#10831): a grade decide por destino. */
function planOutside(grid: ScheduledSlot[], extra: Partial<Parameters<typeof planShortsPublish>[0]> = {}) {
  return planShortsPublish({
    aammdd: "261110",
    reviewedMd: reviewed,
    now: new Date("2026-11-09T20:00:00Z"),
    config,
    pages,
    instagramReady: true,
    instagramQueue: { ready: true, account: "vjpixel" },
    published: { aammdd: "261110", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 275_000_000 },
    videoDurationSeconds: 113.9,
    editionUrl: "https://diar.ia.br/p/x",
    grid,
    ...extra,
  });
}

const brt = (iso: string) => new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(11, 16);

describe("#10933 Instagram manual acima do teto entra na grade", () => {
  it("o slot do Instagram manual existe, vem do planner e o item guiado carrega o mesmo horário", () => {
    const p = planOutside([]);
    const slot = p.slots.find((s) => s.destination === "instagram");
    assert.ok(slot, "Instagram manual reserva slot na grade");
    assert.notEqual(slot!.rule, "test-schedule");
    const ig = p.items.find((i) => i.destination === "instagram") as { action: string; at?: string; detail: string };
    assert.equal(ig.action, "guided");
    assert.equal(ig.at, slot!.at, "o passo manual sai no slot reservado");
    assert.match(ig.detail, new RegExp(`às ${slot!.hhmm} BRT`));
    assert.ok(p.premises.some((m) => /instagram: passo manual \(Chrome ou app\)/.test(m) && /#10933/.test(m)));
  });

  it("cenário da issue: a grade da conta já tem post às 12:00 → o Instagram manual NÃO cola nele", () => {
    const account = planOutside([]).slots.find((s) => s.destination === "instagram")!.account;
    const p = planOutside([{ account, at: "2026-11-10T15:00:00Z", label: "instagram d1" }]); // 12:00 BRT
    const slot = p.slots.find((s) => s.destination === "instagram")!;
    const gapMin = Math.abs(Date.parse(slot.at) - Date.parse("2026-11-10T15:00:00Z")) / 60_000;
    assert.ok(gapMin >= 60, `Instagram manual a ${gapMin} min do post da mesma conta (${brt(slot.at)} BRT)`);
    const ig = p.items.find((i) => i.destination === "instagram") as { at?: string };
    assert.equal(ig.at, slot.at);
  });

  it("os outros destinos são planejados com o Instagram manual já na grade (entra antes do repost)", () => {
    const p = planOutside([]);
    // O plano expõe a grade planejada inteira em `slots`; o repost do LinkedIn
    // (`planLinkedInRepostSlot`) e cada destino seguinte enxergam o Instagram.
    assert.deepEqual(
      p.slots.map((s) => s.destination).sort(),
      ["facebook:diaria", "facebook:vjpixel", "instagram"].sort(),
    );
  });

  it("durante o teste de horário (#10831) o Instagram manual segue o horário do teste e gera o aviso de grade se colar", () => {
    // Mesma `config` (com SCHEDULE explícito) — nunca `{ publishing: { shorts } }`
    // sem `schedule`, que cairia no default de produção (a causa do vermelho).
    const base = {
      aammdd: "261023",
      now: new Date("2026-10-23T09:00:00Z"),
      published: { aammdd: "261023", entries: [] },
    };
    const account = planOutside([], base).slots.find((s) => s.destination === "instagram")!.account;
    const p = planOutside([{ account, at: "2026-10-23T22:30:00Z" }], base); // 19:30 BRT; teste dá 19:00 em 261023
    const slot = p.slots.find((s) => s.destination === "instagram")!;
    assert.equal(slot.rule, "test-schedule");
    assert.ok(p.warnings.some((w) => w.startsWith("instagram:") && /mesma conta/.test(w)), "aviso #10819 também vale pro post manual");
  });

  it("Instagram já registrado (--mark) não reserva slot de novo", () => {
    const p = planOutside([], {
      published: { aammdd: "261110", entries: [{ destination: "instagram", id: "x", url: "https://www.instagram.com/reel/x/", status: "published", at: "2026-11-10T15:00:00Z" } as never] },
    });
    assert.ok(!p.slots.some((s) => s.destination === "instagram"));
  });
});
