/**
 * test/shorts-linkedin-profile-timer-10982.test.ts (#10982)
 *
 * O vertical sai no LinkedIn pessoal pelo timer do 300, sem passo manual:
 * decisão do timer (edição do dia, já registrado, config), leitura do Drive,
 * lock, delegação no plano do `/diaria-shorts` (não duplica entre máquinas) e
 * o par horário do teste do vertical ↔ horário das tasks. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTimerLock, decideTimerRun, interpretDriveLookup, TIMER_LOCK_STALE_MS } from "../scripts/shorts-linkedin-profile-timer.ts";
import { LINKEDIN_TIMER_DETAIL, SHORTS_BOOLEAN_FLAGS, planShortsPublish } from "../scripts/publish-shorts.ts";
import { loadShortsConfig } from "../scripts/lib/diaria/short-video.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import platformConfig from "../platform.config.json" with { type: "json" };

const SHORTS = { facebook_pages: [], instagram: false, linkedin_profile: true, linkedin_page_repost: true, x: false, threads_profile: false, linkedin_profile_via_timer: true };
const CFG = { publishing: { shorts: SHORTS } };

describe("#10982 decideTimerRun", () => {
  const base = { config: CFG, reviewedExists: true, publishedRaw: null, aammdd: "261027", videoExists: true };

  it("edição com vertical no disco: publica sem Drive", () => {
    assert.deepEqual(decideTimerRun(base), { kind: "publish", fromDrive: false });
  });
  it("vertical fora do disco: publica via Drive", () => {
    assert.deepEqual(decideTimerRun({ ...base, videoExists: false }), { kind: "publish", fromDrive: true });
  });
  it("dia sem edição: nada a fazer", () => {
    assert.equal(decideTimerRun({ ...base, reviewedExists: false }).kind, "skip");
  });
  it("linkedin_profile já registrado (qualquer status, inclusive send_unknown): nada a fazer", () => {
    const raw = JSON.stringify({ aammdd: "261027", entries: [{ destination: "linkedin_profile", status: "send_unknown", id: "x", at: "t" }] });
    const d = decideTimerRun({ ...base, publishedRaw: raw });
    assert.equal(d.kind, "skip");
    assert.match((d as { reason: string }).reason, /já registrado/);
  });
  it("registro ilegível lança (nunca vira 'nada publicado')", () => {
    assert.throws(() => decideTimerRun({ ...base, publishedRaw: "{" }), /JSON inválido/);
  });
  it("timer desligado no config: o /diaria-shorts publica, o timer não", () => {
    const d = decideTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, linkedin_profile_via_timer: false } } } });
    assert.equal(d.kind, "skip");
  });
  it("linkedin_profile desligado: nada a fazer", () => {
    const d = decideTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, linkedin_profile: false, linkedin_page_repost: false } } } });
    assert.equal(d.kind, "skip");
  });
});

describe("#10982 interpretDriveLookup", () => {
  it("print-id → id do arquivo", () => {
    assert.deepEqual(interpretDriveLookup(0, JSON.stringify({ action: "print-id", file: { id: "abc123def456", name: "x final.mp4" } })), { kind: "found", fileId: "abc123def456", name: "x final.mp4" });
  });
  it("none → espera (exit 0 no timer)", () => {
    assert.equal(interpretDriveLookup(0, JSON.stringify({ action: "none", reason: "nada" })).kind, "wait");
  });
  it("needs-editor → espera, nunca escolhe", () => {
    assert.equal(interpretDriveLookup(3, JSON.stringify({ action: "needs-editor", selection: "ambiguous" })).kind, "wait");
  });
  it("error / sem JSON → error", () => {
    assert.equal(interpretDriveLookup(1, JSON.stringify({ action: "error", error: "401" })).kind, "error");
    assert.equal(interpretDriveLookup(1, "boom").kind, "error");
  });
});

describe("#10982 lock", () => {
  it("2ª execução concorrente não pega o lock; lock velho é retomado", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-lock-"));
    try {
      const path = join(dir, "_internal", "x.lock");
      const release = acquireTimerLock(path);
      assert.ok(release);
      assert.equal(acquireTimerLock(path), null);
      release!();
      assert.ok(acquireTimerLock(path));
      const old = (Date.now() - TIMER_LOCK_STALE_MS - 60_000) / 1000;
      utimesSync(path, old, old);
      assert.ok(acquireTimerLock(path), "lock de processo morto não trava para sempre");
      writeFileSync(join(dir, "ok"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#10982 delegação no plano do /diaria-shorts", () => {
  const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
  const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://a.b/c)\n\nCorpo do destaque.\n\nPor que isso importa: sim.\n";
  const base = {
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: { publishing: { shorts: { ...SHORTS, schedule: { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" } } } },
    pages: [page("diaria")],
    instagramReady: false,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
    linkedinPersonal: { ready: true } as const,
    now: new Date("2026-10-22T15:30:00Z"),
  };
  const item = (p: ReturnType<typeof planShortsPublish>, d: string) => p.items.find((i) => i.destination === d) as any;

  it("sem --linkedin-timer: skip_delegated, e o repost espera o perfil", () => {
    const p = planShortsPublish(base);
    assert.equal(item(p, "linkedin_profile").action, "skip_delegated");
    assert.equal(item(p, "linkedin_profile").detail, LINKEDIN_TIMER_DETAIL);
    assert.equal(item(p, "linkedin_page_repost").action, "skip_invalid");
  });
  it("com --linkedin-timer (a rodada do timer): publica", () => {
    assert.equal(item(planShortsPublish({ ...base, writer: "linkedin-timer" }), "linkedin_profile").action, "publish");
  });
  it("timer desligado no config: a skill publica como antes", () => {
    const cfg = { publishing: { shorts: { ...base.config.publishing.shorts, linkedin_profile_via_timer: false } } };
    assert.equal(item(planShortsPublish({ ...base, config: cfg }), "linkedin_profile").action, "publish");
  });
  it("--linkedin-timer é flag booleana do CLI", () => {
    assert.ok((SHORTS_BOOLEAN_FLAGS as readonly string[]).includes("linkedin-timer"));
  });
});

describe("#10982 tasks do 300 cobrem os horários do vertical", () => {
  const daily = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-LinkedIn-Profile");
  const hourly = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-LinkedIn-Profile-Catchup");

  it("as duas tasks existem, armáveis, rodando o script do timer", () => {
    for (const t of [daily, hourly]) {
      assert.ok(t);
      assert.notEqual(t!.enabled, false);
      assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/shorts-linkedin-profile-timer.ts"]);
    }
    assert.deepEqual(hourly!.schedule, { kind: "interval", hours: 1 });
  });

  it("todo horário do teste fora da hora cheia é o da diária menos 1 min (o resto cai na de hora em hora)", () => {
    const sched = (platformConfig as any).publishing.shorts.schedule;
    const times: string[] = [...sched.rotation_times, sched.default_time];
    assert.equal(daily!.schedule.kind, "daily");
    const d = daily!.schedule as { hour: number; minute: number };
    const offHour = times.filter((t) => !t.endsWith(":00"));
    for (const t of offHour) {
      const [h, m] = t.split(":").map(Number);
      assert.equal(h * 60 + m + 1, d.hour * 60 + d.minute, `horário ${t} sem execução 1 min depois`);
    }
  });

  it("o platform.config.json liga a delegação junto com o timer", () => {
    assert.equal(loadShortsConfig(platformConfig).linkedinProfileViaTimer, true);
  });
});
