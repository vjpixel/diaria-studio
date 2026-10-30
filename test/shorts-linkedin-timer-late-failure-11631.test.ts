/**
 * test/shorts-linkedin-timer-late-failure-11631.test.ts (#11631)
 *
 * Com o vertical já no disco, o timer do LinkedIn pessoal só olhava o exit
 * code do `publish-shorts.ts`: `skip_late` (passou de 3 h do horário, exit 0)
 * e falha de publicação (exit 1) terminavam sem alarme, e o editor só
 * descobria olhando. Os timers do Instagram e do Threads alarmam nesses
 * casos; agora o do LinkedIn também, com os helpers de
 * `lib/diaria/shorts-timer-alarm-state.ts`. Sem rede: I/O falso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINKEDIN_TIMER_ALARM_STATE_FILE,
  TIMER_LOCK_FILE,
  buildLinkedinTimerAlarm,
  interpretLinkedinTimerOutput,
  linkedinAlarmSeverity,
  linkedinAlarmSuppressed,
  runLinkedinTimer,
  type LinkedinTimerRunDeps,
} from "../scripts/shorts-linkedin-profile-timer.ts";
import { shortVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const CFG = {
  publishing: {
    shorts: {
      facebook_pages: [],
      instagram: false,
      linkedin_profile: true,
      linkedin_page_repost: false,
      linkedin_profile_via_timer: true,
      x: false,
      threads_profile: false,
      facebook_profile: false,
      youtube_shorts_api: false,
      schedule: SCHEDULE,
    },
  },
};
// 261027 (terça): 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";

/** Saída do publish-shorts quando o horário passou do teto (`skip_late`, exit 0). */
const LATE_OUT = JSON.stringify({
  dry_run: false,
  items: [{ destination: "linkedin_profile", mode: "api", action: "skip_late", detail: "08:00 BRT passou há 200 min (teto 3 h) — fora do horário do teste" }],
  results: [],
  summary: { published: 0, failed: 0 },
});
/** Saída do publish-shorts quando a API do LinkedIn recusa (exit 1). */
const FAILED_OUT = JSON.stringify({
  dry_run: false,
  items: [{ destination: "linkedin_profile", mode: "api", action: "publish", detail: "" }],
  results: [{ destination: "linkedin_profile", ok: false, error: "LinkedIn API 500: upload do vídeo falhou" }],
  summary: { published: 0, failed: 1 },
});
const PUBLISHED_OUT = JSON.stringify({
  dry_run: false,
  items: [{ destination: "linkedin_profile", mode: "api", action: "publish", detail: "" }],
  results: [{ destination: "linkedin_profile", ok: true, entry: { destination: "linkedin_profile", status: "published", id: "urn:li:share:1", url: "https://www.linkedin.com/feed/update/urn:li:share:1", at: "t" } }],
});
const PENDING_OUT = JSON.stringify({ dry_run: false, items: [{ destination: "linkedin_profile", mode: "api", action: "pending_schedule", detail: "antes das 08:00" }], results: [] });

/** Edição com o vertical já no disco (o caminho que não passa pelo Drive). */
function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "li-timer-11631-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo.\n");
  writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "mp4");
  return dir;
}

function fakeGh() {
  const issues: { number: number; url: string; body: string }[] = [];
  const sent: string[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      const n = 900 + issues.length;
      issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, body: args[args.indexOf("--body") + 1] ?? "" });
      return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
    }
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  const notify = { ghRun, sendPush: async (m: { subject: string }) => (sent.push(m.subject), { ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
  return { issues, sent, notify };
}

function deps(now: Date, publish: { status: number; stdout: string }, notify: LinkedinTimerRunDeps["notify"]): LinkedinTimerRunDeps & { scripts: { args: string[]; capture: boolean }[] } {
  const scripts: { args: string[]; capture: boolean }[] = [];
  return {
    config: CFG,
    now,
    runScript: (args: string[], capture: boolean) => {
      scripts.push({ args, capture });
      if (args[0] === "scripts/publish-shorts.ts") return publish;
      throw new Error(`script inesperado: ${args.join(" ")}`);
    },
    notify,
    scripts,
  };
}

describe("#11631 interpretLinkedinTimerOutput", () => {
  it("skip_late vira alarme late (não falha a unit)", () => {
    assert.deepEqual(
      [interpretLinkedinTimerOutput(0, LATE_OUT).kind, (interpretLinkedinTimerOutput(0, LATE_OUT) as { key: string }).key, (interpretLinkedinTimerOutput(0, LATE_OUT) as { failed: boolean }).failed],
      ["alarm", "late", false],
    );
  });
  it("resultado com ok:false vira publish-failed (falha a unit)", () => {
    const o = interpretLinkedinTimerOutput(1, FAILED_OUT);
    assert.equal(o.kind, "alarm");
    assert.equal((o as { key: string }).key, "publish-failed");
    assert.equal((o as { failed: boolean }).failed, true);
    assert.match(o.detail, /upload do vídeo falhou/);
  });
  it("publicado: done; pending_schedule: wait; sem JSON: no-output", () => {
    assert.equal(interpretLinkedinTimerOutput(0, PUBLISHED_OUT).kind, "done");
    assert.equal(interpretLinkedinTimerOutput(0, PENDING_OUT).kind, "wait");
    assert.equal((interpretLinkedinTimerOutput(1, "Error: boom") as { key: string }).key, "no-output");
  });
  it("send_unknown e post sem registro pedem conferência (acao), não repost", () => {
    const unknown = JSON.stringify({ items: [], results: [{ destination: "linkedin_profile", ok: true, entry: { status: "send_unknown", id: "x" } }] });
    const unregistered = JSON.stringify({ items: [], results: [{ destination: "linkedin_profile", ok: false, entry: { status: "published", id: "x", url: "u" }, error: "EACCES" }] });
    assert.equal((interpretLinkedinTimerOutput(0, unknown) as { key: string }).key, "send-unknown");
    assert.equal((interpretLinkedinTimerOutput(1, unregistered) as { key: string }).key, "published-unregistered");
    assert.equal(linkedinAlarmSeverity("send-unknown"), "acao");
    assert.equal(linkedinAlarmSeverity("late"), "urgente");
    assert.equal(linkedinAlarmSeverity("publish-failed"), "urgente");
    assert.doesNotMatch(buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "send-unknown", reason: "r", at: AT }).body, /--so vertical/);
  });
  it("late não sai depois de um motivo que diz que o post pode estar no ar", () => {
    const state = JSON.stringify({ aammdd: AAMMDD, alarmed: ["send-unknown"], emailPending: [] });
    assert.equal(linkedinAlarmSuppressed(state, "late"), true);
    assert.equal(linkedinAlarmSuppressed(null, "late"), false);
  });
});

describe("#11631 runLinkedinTimer: vertical no disco, publish-shorts não publica", () => {
  it("regressão: skip_late alarma (urgente) uma vez por edição e sai 0", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const d = deps(new Date(Date.parse(AT) + 200 * 60_000), { status: 0, stdout: LATE_OUT }, gh.notify);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, d), 0);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, d), 0, "a execução seguinte não repete");
      assert.equal(gh.issues.length, 1);
      assert.equal(gh.sent.length, 1, "urgente manda e-mail");
      assert.match(gh.sent[0], /LinkedIn pessoal de 261027 não saiu pelo timer do 300 \(late\)/);
      assert.match(gh.issues[0].body, /NÃO publica mais sozinho/);
      assert.match(gh.issues[0].body, /--mark linkedin_profile=URL/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["late"]);
      assert.ok(d.scripts.every((s) => s.capture), "o stdout do publish-shorts é capturado para ser lido");
      assert.equal(existsSync(join(dir, TIMER_LOCK_FILE)), false, "solta o lock");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("regressão: publicação que falha alarma e sai 1", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const d = deps(new Date(Date.parse(AT) + 10 * 60_000), { status: 1, stdout: FAILED_OUT }, gh.notify);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, d), 1);
      assert.equal(gh.issues.length, 1);
      assert.match(gh.sent[0], /\(publish-failed\)/);
      assert.match(gh.issues[0].body, /upload do vídeo falhou/);
      assert.match(gh.issues[0].body, /até 11:00 BRT/, "prazo = horário + 3 h");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["publish-failed"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("alarme que não chega (gh fora) sai 1 e não grava estado", async () => {
    const dir = edition();
    try {
      const offline = { ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh offline" }), sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) + 200 * 60_000), { status: 0, stdout: LATE_OUT }, offline)), 1);
      assert.equal(existsSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("publicado ou antes do horário: sem alarme, sai 0", async () => {
    for (const stdout of [PUBLISHED_OUT, PENDING_OUT]) {
      const dir = edition();
      try {
        const gh = fakeGh();
        assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT)), { status: 0, stdout }, gh.notify)), 0);
        assert.equal(gh.issues.length, 0);
        assert.equal(existsSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE)), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  it("--dry-run não roda o publish-shorts nem alarma", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const d = deps(new Date(Date.parse(AT) + 200 * 60_000), { status: 0, stdout: LATE_OUT }, gh.notify);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, true, d), 0);
      assert.equal(d.scripts.length, 0);
      assert.equal(gh.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
