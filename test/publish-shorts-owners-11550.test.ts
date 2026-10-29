/**
 * test/publish-shorts-owners-11550.test.ts (#11550)
 *
 * Decisão do editor (28/10/2026, edição 261029): "sempre é você que precisa
 * publicar". O plano do `publish-shorts.ts` nomeia o dono automático de todo
 * destino que não sai nesta rodada (`owners`) e nenhum texto devolve ao editor
 * o passo de "rodar de novo depois do horário". Na 261029 o Threads pessoal
 * ficou `pending_schedule` com "rode de novo depois das 06:30" e a skill
 * devolveu o comando ao editor. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LINKEDIN_TIMER_DETAIL,
  SHORTS_TIMER_TASKS,
  THREADS_TIMER_DETAIL,
  assignShortsDestinationOwners,
  planShortsPublish,
  type ShortsPlanItem,
} from "../scripts/publish-shorts.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SCHEDULE = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/x)

Um modelo da OpenAI gastou o saldo de terceiros. O caso foi descoberto depois.

Por que isso importa: porque sim.
`;
const shorts = { facebook_pages: [], instagram: false, linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: true, schedule: SCHEDULE };
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const base = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  config: { publishing: { shorts } },
  pages: [page("diaria")],
  instagramReady: false,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar",
  threadsPersonal: { ready: true } as const,
  linkedinPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
};
const BEFORE = new Date("2026-10-22T03:00:00Z"); // 00:00 BRT, antes do vertical (12:00)
const LATE = new Date("2026-10-22T20:00:00Z"); // 17:00 BRT, 5 h depois
const ownerOf = (p: ReturnType<typeof planShortsPublish>, d: string) => p.owners.find((o) => o.destination === d);
const itemOf = (p: ReturnType<typeof planShortsPublish>, d: string) => p.items.find((i) => i.destination === d) as any;
const editorStep = /rode de novo|Publique à mão/;

describe("#11550 threads_profile", () => {
  it("timer ligado: skip_delegated com dono timer-300 (Diaria-Shorts-Threads-Profile)", () => {
    const config = { publishing: { shorts: { ...shorts, threads_profile_via_timer: true } } };
    const p = planShortsPublish({ ...base, config, now: BEFORE });
    assert.equal(itemOf(p, "threads_profile").action, "skip_delegated");
    assert.equal(itemOf(p, "threads_profile").detail, THREADS_TIMER_DETAIL);
    assert.deepEqual(
      { by: ownerOf(p, "threads_profile")?.by, task: ownerOf(p, "threads_profile")?.task },
      { by: "timer-300", task: "Diaria-Shorts-Threads-Profile" },
    );
  });

  it("sem timer, antes do horário: pending_schedule com task agendada pela skill, sem devolver o passo ao editor", () => {
    const p = planShortsPublish({ ...base, now: BEFORE });
    const item = itemOf(p, "threads_profile");
    assert.equal(item.action, "pending_schedule");
    assert.doesNotMatch(item.detail, editorStep);
    const o = ownerOf(p, "threads_profile")!;
    assert.equal(o.by, "agent-scheduled-task");
    assert.equal(o.at, item.scheduledAt);
    assert.equal(o.command, "npx tsx scripts/publish-shorts.ts 261022 --only threads_profile --publish");
    assert.match(o.note, /Diaria-Shorts-Threads-Profile/);
  });

  it("sem timer, depois do teto: skip_late com o agente publicando com --now", () => {
    const p = planShortsPublish({ ...base, now: LATE });
    const item = itemOf(p, "threads_profile");
    assert.equal(item.action, "skip_late");
    assert.doesNotMatch(item.detail, editorStep);
    assert.ok(!p.warnings.some((w) => editorStep.test(w)), p.warnings.join("\n"));
    const o = ownerOf(p, "threads_profile")!;
    assert.equal(o.by, "agent");
    assert.match(o.command ?? "", /--only threads_profile --publish --now$/);
  });
});

describe("#11550 linkedin_profile e repost da página", () => {
  const li = { ...shorts, threads_profile: false, linkedin_profile: true, linkedin_page_repost: true };

  it("skip_late do linkedin_profile tem dono (agente, --now) e não devolve ao editor", () => {
    const p = planShortsPublish({ ...base, config: { publishing: { shorts: li } }, now: LATE });
    assert.equal(itemOf(p, "linkedin_profile").action, "skip_late");
    assert.doesNotMatch(itemOf(p, "linkedin_profile").detail, editorStep);
    assert.equal(ownerOf(p, "linkedin_profile")?.by, "agent");
  });

  it("timer do LinkedIn ligado: dono timer-300", () => {
    const config = { publishing: { shorts: { ...li, linkedin_profile_via_timer: true } } };
    const p = planShortsPublish({ ...base, config, now: BEFORE });
    assert.equal(itemOf(p, "linkedin_profile").detail, LINKEDIN_TIMER_DETAIL);
    assert.equal(ownerOf(p, "linkedin_profile")?.task, "Diaria-Shorts-LinkedIn-Profile");
  });

  it("repost guiado no futuro: a skill agenda a própria re-execução para o horário dele", () => {
    const p = planShortsPublish({ ...base, config: { publishing: { shorts: li } }, now: BEFORE });
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.action, "guided");
    const o = ownerOf(p, "linkedin_page_repost")!;
    assert.equal(o.by, "agent-scheduled-task");
    assert.equal(o.at, repost.at);
    assert.equal(o.command, "/diaria-publica-video 261022 --so vertical");
  });
});

describe("#11550 assignShortsDestinationOwners", () => {
  const ctx = { aammdd: "261022", now: BEFORE, instagramViaTimer: false };

  it("todo pending/late/delegated/guided/buffer tem dono; nenhum dono é o editor", () => {
    const items: ShortsPlanItem[] = [
      { destination: "instagram", mode: "api", action: "pending_schedule", caption: "c", scheduledAt: "2026-10-22T15:00:00Z", detail: "d" },
      { destination: "linkedin_profile", mode: "api", action: "skip_late", detail: "d" },
      { destination: "threads_profile", mode: "api", action: "skip_delegated", detail: "d" },
      { destination: "youtube_shorts", mode: "guided", action: "guided", detail: "d" },
      { destination: "x", mode: "guided", action: "buffer", caption: "c", scheduledAt: null, detail: "d" },
      { destination: "facebook:diaria", mode: "api", action: "publish", caption: "c", scheduledAt: null },
      { destination: "facebook_profile", mode: "guided", action: "skip_done" },
    ];
    const owners = assignShortsDestinationOwners(items, ctx);
    assert.deepEqual(owners.map((o) => o.destination), ["instagram", "linkedin_profile", "threads_profile", "youtube_shorts", "x"]);
    for (const o of owners) assert.ok(["timer-300", "agent-scheduled-task", "agent"].includes(o.by), o.destination);
    assert.equal(owners[3].by, "agent", "guiado sem horário futuro: agente nesta rodada");
  });

  it("instagram pendente com o timer do 300: dono é o timer", () => {
    const owners = assignShortsDestinationOwners(
      [{ destination: "instagram", mode: "api", action: "pending_schedule", caption: "c", scheduledAt: "2026-10-22T15:00:00Z", detail: "d" }],
      { ...ctx, instagramViaTimer: true },
    );
    assert.equal(owners[0].by, "timer-300");
    assert.equal(owners[0].task, "Diaria-Shorts-Instagram");
  });

  it("as tasks citadas existem no registro de tasks agendadas", () => {
    const names = new Set(SCHEDULED_TASKS.map((t: { name: string }) => t.name));
    for (const task of Object.values(SHORTS_TIMER_TASKS)) assert.ok(names.has(task), task);
  });
});
