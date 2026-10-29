/**
 * test/shorts-linkedin-timer-alarm-11618.test.ts (#11618)
 *
 * O timer do LinkedIn pessoal (`Diaria-Shorts-LinkedIn-Profile`) saía em
 * silêncio quando o vertical "Outras redes" não estava no disco nem no Drive
 * (`fetch-drive-video --orientation vertical` → `action: none`): sem post e
 * sem aviso (29/10/2026, `Final/` com 9 .mp4 e nenhum "Outras redes"). Agora
 * alarma o editor, uma vez por motivo e edição, num dia que teve vídeo. O
 * timer do Threads pessoal passa a contar a pasta da edição no Drive como
 * "dia com vídeo" pelo mesmo motivo. Sem rede: I/O falso.
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
  interpretDriveLookup,
  linkedinVerticalTime,
  linkedinWaitAlarm,
  runLinkedinTimer,
  type LinkedinTimerRunDeps,
} from "../scripts/shorts-linkedin-profile-timer.ts";
import { interpretThreadsVerticalLookup, runThreadsTimer, THREADS_TIMER_ALARM_STATE_FILE, type ThreadsTimerRunDeps } from "../scripts/shorts-threads-profile-timer.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const SHORTS = {
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
};
const CFG = { publishing: { shorts: SHORTS } };
// 261027 (terça): 2º dia do teste → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";
const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo.\n";

/** Saída real do fetch-drive-video no incidente: pasta da edição e `Final/` existem, nenhum vertical "Outras redes". */
const DRIVE_NONE = JSON.stringify({
  edition: AAMMDD,
  orientation: "vertical",
  folder_id: "root",
  local_path: "x",
  edition_folder_id: "edfolder123",
  final_folder_ids: ["final123"],
  target: "generic",
  action: "none",
  selection: "none",
  reason: "nenhum .mp4 vertical final",
});
/** Dia sem vídeo: nem a pasta da edição existe no Drive. */
const DRIVE_NONE_NO_FOLDER = JSON.stringify({ edition: AAMMDD, orientation: "vertical", folder_id: "root", local_path: "x", edition_folder_id: null, final_folder_ids: [], target: "generic", action: "none", selection: "none", reason: "sem pasta" });

function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "li-timer-11618-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
  return dir;
}

function fakeGh() {
  const issues: { number: number; url: string; body: string; state: string }[] = [];
  const sent: string[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      const n = 900 + issues.length;
      issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, body: args[args.indexOf("--body") + 1] ?? "", state: "OPEN" });
      return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
    }
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  const notify = { ghRun, sendPush: async (m: { subject: string }) => (sent.push(m.subject), { ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
  return { issues, sent, notify };
}

function deps(now: Date, driveStdout: string, notify: LinkedinTimerRunDeps["notify"]): LinkedinTimerRunDeps & { scripts: string[][] } {
  const scripts: string[][] = [];
  return {
    config: CFG,
    now,
    runScript: (args: string[]) => {
      scripts.push(args);
      if (args[0] === "scripts/fetch-drive-video.ts") return { status: 0, stdout: driveStdout };
      return { status: 0, stdout: "" };
    },
    notify,
    scripts,
  };
}

describe("#11618 interpretDriveLookup carrega o motivo e se o dia teve vídeo", () => {
  it("none com a pasta da edição no Drive: espera, why none, editionFolderSeen", () => {
    const l = interpretDriveLookup(0, DRIVE_NONE);
    assert.equal(l.kind, "wait");
    assert.equal((l as { why: string }).why, "none");
    assert.equal((l as { editionFolderSeen: boolean }).editionFolderSeen, true);
  });
  it("none sem a pasta da edição: dia sem vídeo", () => {
    assert.equal((interpretDriveLookup(0, DRIVE_NONE_NO_FOLDER) as { editionFolderSeen: boolean }).editionFolderSeen, false);
  });
  it("needs-editor: why needs-editor; pasta duplicada conta como dia com vídeo", () => {
    const l = interpretDriveLookup(3, JSON.stringify({ action: "needs-editor", selection: "duplicate-edition-folder" }));
    assert.deepEqual([(l as { why: string }).why, (l as { editionFolderSeen: boolean }).editionFolderSeen], ["needs-editor", true]);
  });
});

describe("#11618 linkedinWaitAlarm", () => {
  const at = AT;
  const t = (deltaMin: number) => new Date(Date.parse(at) + deltaMin * 60_000);
  it("sem vertical: espera calada até 1 h depois do horário, alarma a partir daí", () => {
    assert.equal(linkedinWaitAlarm({ why: "none", videoSeen: true, now: t(-60), at }), null);
    assert.equal(linkedinWaitAlarm({ why: "none", videoSeen: true, now: t(30), at }), null);
    assert.equal(linkedinWaitAlarm({ why: "none", videoSeen: true, now: t(60), at }), "missing-video");
    assert.equal(linkedinWaitAlarm({ why: "none", videoSeen: true, now: t(300), at }), "missing-video");
  });
  it("ambíguo: alarma a partir do horário", () => {
    assert.equal(linkedinWaitAlarm({ why: "needs-editor", videoSeen: true, now: t(-1), at }), null);
    assert.equal(linkedinWaitAlarm({ why: "needs-editor", videoSeen: true, now: t(0), at }), "drive-needs-editor");
  });
  it("dia sem vídeo nunca alarma", () => {
    assert.equal(linkedinWaitAlarm({ why: "none", videoSeen: false, now: t(300), at }), null);
    assert.equal(linkedinWaitAlarm({ why: "needs-editor", videoSeen: false, now: t(300), at }), null);
  });
  it("o horário vem do teste do vertical (08:00 BRT em 261027)", () => {
    assert.deepEqual(linkedinVerticalTime(CFG, AAMMDD), { at: AT, hhmm: "08:00" });
  });
});

describe("#11618 runLinkedinTimer: vertical ausente no disco e no Drive", () => {
  it("regressão: action none, 1 h+ depois do horário, dia com vídeo → alarma (urgente) uma vez e não publica", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const d = deps(new Date(Date.parse(AT) + 90 * 60_000), DRIVE_NONE, gh.notify);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, d), 0);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, d), 0, "a execução seguinte (catch-up horário) não repete");
      assert.equal(gh.issues.length, 1);
      assert.equal(gh.sent.length, 1);
      assert.match(gh.sent[0], /LinkedIn pessoal de 261027 não saiu pelo timer do 300 \(missing-video\)/);
      assert.match(gh.issues[0].body, /Outras redes/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["missing-video"]);
      assert.ok(d.scripts.every((a) => a[0] === "scripts/fetch-drive-video.ts"), "nunca roda o publish-shorts sem vídeo");
      assert.equal(existsSync(join(dir, TIMER_LOCK_FILE)), false, "solta o lock");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("#11633: mudança de motivo na mesma edição avisa uma vez por motivo", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const now = new Date(Date.parse(AT) + 90 * 60_000);
      const missing = deps(now, DRIVE_NONE, gh.notify);
      const ambiguous = deps(now, JSON.stringify({ action: "needs-editor", selection: "duplicate-edition-folder" }), gh.notify);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, missing), 0);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, ambiguous), 0);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, missing), 0);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, ambiguous), 0);
      assert.equal(gh.issues.length, 2);
      assert.equal(gh.sent.length, 2);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["missing-video", "drive-needs-editor"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("antes de 1 h depois do horário: espera calada (o export pode estar subindo)", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) - 30 * 60_000), DRIVE_NONE, gh.notify)), 0);
      assert.equal(gh.issues.length, 0);
      assert.equal(existsSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("dia sem vídeo (sem pasta da edição no Drive, nada registrado): não alarma", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) + 5 * 3_600_000), DRIVE_NONE_NO_FOLDER, gh.notify)), 0);
      assert.equal(gh.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("outro destino já registrado conta como dia com vídeo, mesmo sem a pasta no Drive", async () => {
    const dir = edition();
    try {
      writeFileSync(
        join(dir, "_internal", "06-shorts-published.json"),
        JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "youtube_shorts", status: "published", id: "y", at: "t" }] }),
      );
      const gh = fakeGh();
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) + 2 * 3_600_000), DRIVE_NONE_NO_FOLDER, gh.notify)), 0);
      assert.equal(gh.issues.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("alarme que não chega (gh fora) sai 1 e não grava estado (a próxima execução tenta de novo)", async () => {
    const dir = edition();
    try {
      const offline = { ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh offline" }), sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps(new Date(Date.parse(AT) + 2 * 3_600_000), DRIVE_NONE, offline)), 1);
      assert.equal(existsSync(join(dir, LINKEDIN_TIMER_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("--dry-run não alarma", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      assert.equal(await runLinkedinTimer(AAMMDD, dir, true, deps(new Date(Date.parse(AT) + 2 * 3_600_000), DRIVE_NONE, gh.notify)), 0);
      assert.equal(gh.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("vertical achado no Drive: publica pelo --from-drive, sem alarme", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const d = deps(new Date(Date.parse(AT) + 2 * 3_600_000), JSON.stringify({ action: "print-id", file: { id: "abcdefghijk", name: "v.mp4" } }), gh.notify);
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, d), 0);
      assert.deepEqual(d.scripts.at(-1), ["scripts/publish-shorts.ts", AAMMDD, "--only", "linkedin_profile", "--publish", "--linkedin-timer", "--from-drive", "abcdefghijk"]);
      assert.equal(gh.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("corpo do alarme traz o prazo (horário + 3 h) e o --mark", () => {
    const { body } = buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "missing-video", reason: "r", at: AT });
    assert.match(body, /11:00 BRT/);
    assert.match(body, /--mark linkedin_profile=URL/);
  });
});

describe("#11618 Threads pessoal: pasta da edição no Drive conta como dia com vídeo", () => {
  it("interpretThreadsVerticalLookup marca editionFolderSeen", () => {
    assert.equal((interpretThreadsVerticalLookup(0, DRIVE_NONE) as { editionFolderSeen?: boolean }).editionFolderSeen, true);
    assert.equal((interpretThreadsVerticalLookup(0, DRIVE_NONE_NO_FOLDER) as { editionFolderSeen?: boolean }).editionFolderSeen, undefined);
  });
  it("sem vertical no disco e none no Drive com a pasta: alarma missing-video", async () => {
    const dir = edition();
    try {
      const gh = fakeGh();
      const d: ThreadsTimerRunDeps = {
        config: { publishing: { shorts: { ...SHORTS, linkedin_profile: false, threads_profile: true, threads_profile_via_timer: true } } },
        now: new Date(Date.parse(AT) + 90 * 60_000),
        lookupVertical: () => interpretThreadsVerticalLookup(0, DRIVE_NONE),
        runScript: () => {
          throw new Error("não deveria publicar");
        },
        notify: gh.notify,
      };
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.equal(gh.issues.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, THREADS_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["missing-video"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
