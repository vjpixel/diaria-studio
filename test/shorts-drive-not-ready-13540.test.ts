/**
 * test/shorts-drive-not-ready-13540.test.ts (#13540, #13541)
 *
 * Edição 261118: o editor subiu o vertical para o Drive às 14:59:19Z (o
 * arquivo nasce antes do conteúdo; os 137 MB ficaram completos às 14:59:30Z).
 * Os timers do Threads pessoal e do Instagram rodaram às 15:00Z (12:00 BRT, o
 * horário do vertical), acharam o arquivo, e o `publish-shorts --from-drive`
 * baixou zero bytes: "download do Drive veio vazio". Saía exit 1 sem JSON, e o
 * timer abria o alarme `no-output` (urgente, issue + e-mail) na 1ª tentativa,
 * com a execução da hora seguinte ainda pela frente.
 *
 * Agora: o download vazio é `DriveDownloadEmptyError`, o publish-shorts sai
 * com exit próprio (75), e os timers esperam a próxima hora em vez de alarmar,
 * enquanto estiverem a menos de 1 h do horário do vertical. Depois disso, o
 * alarme `no-output` de sempre (o upload que segue vazio é problema real).
 * Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveDownloadEmptyError, downloadDriveFileById, type DriveDownloadDeps } from "../scripts/lib/drive-download.ts";
import {
  DRIVE_NOT_READY_GRACE_MS,
  PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT,
  driveNotReadyWait,
} from "../scripts/lib/diaria/vertical-download-guard.ts";
import { runThreadsTimer, type ThreadsTimerRunDeps } from "../scripts/shorts-threads-profile-timer.ts";
import { runInstagramTimer, type InstagramCutLookup, type InstagramTimerRunDeps } from "../scripts/shorts-instagram-timer.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import { publishShortsSource } from "./_helpers/publish-shorts-source.ts"; // #14054

const ID = "1URBiCeLtsdNZjX6ks56IsLdAOmOaa6Xp";
const FAST = { metadataMs: 5_000, downloadMs: 15_000, idleMs: 5_000 };
// 261027 (terça): 2º dia do teste de horários → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const BASE_SHORTS = { facebook_pages: [], linkedin_profile: false, linkedin_page_repost: false, x: false, facebook_profile: false, youtube_shorts_api: false, schedule: SCHEDULE };
const THREADS_CFG = { publishing: { shorts: { ...BASE_SHORTS, instagram: false, threads_profile: true, threads_profile_via_timer: true } } };
const IG_CFG = { publishing: { shorts: { ...BASE_SHORTS, instagram: true, instagram_collaborators: ["vjpixel"], threads_profile: false } } };
const STDERR = `publish-shorts: download do Drive veio vazio (${ID}) — nada gravado; o arquivo provavelmente ainda está subindo para o Drive`;
const EMPTY_RUN = { status: PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT, stdout: "", stderr: STDERR };

function edition(): string {
  const dir = mkdtempSync(join(tmpdir(), "shorts-drive-not-ready-13540-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo do destaque. Outra frase.\n");
  return dir;
}

/** `gh` e e-mail falsos com estado. */
function fakeNotify() {
  const issues: { number: number; url: string; title: string; body: string; state: string }[] = [];
  const emails: string[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      const n = 900 + issues.length;
      issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, title: args[args.indexOf("--title") + 1] ?? "", body: args[args.indexOf("--body") + 1] ?? "", state: "OPEN" });
      return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
    }
    if (args[0] === "issue" && (args[1] === "comment" || args[1] === "edit" || args[1] === "reopen")) return { status: 0, stdout: "", stderr: "" };
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  const sendPush = async (m: { subject: string }) => {
    emails.push(m.subject);
    return { ok: true };
  };
  return { issues, emails, deps: { ghRun, sendPush, emailPolicy: "urgent_only" as const, log: () => true } };
}

describe("#13540 download do Drive com corpo vazio", () => {
  it("lança DriveDownloadEmptyError (tipado, diz que pode estar subindo) e não deixa arquivo nem .part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-empty-13540-"));
    try {
      const deps: DriveDownloadDeps = {
        async driveFetch(url) {
          if (new URL(url).searchParams.get("alt") !== "media") return Response.json({ id: ID, name: "261118_Diaria comentada_Vertical_V1.mp4", mimeType: "video/mp4" });
          return new Response(new Uint8Array([]) as BodyInit, { status: 200, headers: { "content-type": "video/mp4" } });
        },
      };
      const err = await downloadDriveFileById(deps, ID, join(dir, "v.mp4"), FAST).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof DriveDownloadEmptyError, `esperava DriveDownloadEmptyError, veio ${String(err)}`);
      assert.equal((err as DriveDownloadEmptyError).fileId, ID);
      assert.match((err as Error).message, /veio vazio .*ainda está subindo/);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publish-shorts --from-drive devolve o exit dedicado só para o download vazio", () => {
    const src = publishShortsSource();
    assert.match(src, /return e instanceof DriveDownloadEmptyError \? PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT : 1;/);
    assert.equal(PUBLISH_SHORTS_DRIVE_NOT_READY_EXIT, 75);
  });
});

describe("#13540 driveNotReadyWait (puro)", () => {
  const nowAt = (ms: number) => Date.parse(AT) + ms;
  it("exit dedicado sem JSON, dentro de 1 h do horário: espera", () => {
    assert.match(driveNotReadyWait({ exitCode: 75, stdout: "", nowMs: nowAt(30_000), at: AT }) ?? "", /upload ainda está em curso/);
    assert.ok(driveNotReadyWait({ exitCode: 75, stdout: "  \n", nowMs: nowAt(DRIVE_NOT_READY_GRACE_MS - 1), at: AT }));
    // Timer que roda antes do horário (o do LinkedIn agenda) também espera.
    assert.ok(driveNotReadyWait({ exitCode: 75, stdout: "", nowMs: nowAt(-3 * 60 * 60_000), at: AT }));
  });
  it("1 h ou mais depois do horário: não espera mais (o alarme de sempre)", () => {
    assert.equal(driveNotReadyWait({ exitCode: 75, stdout: "", nowMs: nowAt(DRIVE_NOT_READY_GRACE_MS), at: AT }), null);
  });
  it("outro exit, JSON no stdout ou horário ilegível: não é este caso", () => {
    assert.equal(driveNotReadyWait({ exitCode: 1, stdout: "", nowMs: nowAt(0), at: AT }), null);
    assert.equal(driveNotReadyWait({ exitCode: null, stdout: "", nowMs: nowAt(0), at: AT }), null);
    assert.equal(driveNotReadyWait({ exitCode: 75, stdout: "{}", nowMs: nowAt(0), at: AT }), null);
    assert.equal(driveNotReadyWait({ exitCode: 75, stdout: "", nowMs: nowAt(0), at: "x" }), null);
  });
});

describe("#13540 timer do Threads pessoal: vertical ainda subindo", () => {
  function deps(now: Date, notify: ReturnType<typeof fakeNotify>): ThreadsTimerRunDeps & { scripts: string[][] } {
    const scripts: string[][] = [];
    return {
      config: THREADS_CFG,
      now,
      lookupVertical: () => ({ kind: "found", fileId: ID, name: "261118_Diaria comentada_Vertical_V1.mp4" }),
      runScript: (args: string[]) => {
        scripts.push(args);
        return EMPTY_RUN;
      },
      notify: notify.deps,
      scripts,
    };
  }
  it("no horário do vertical: espera sem alarme e sai 0; uma hora depois, ainda vazio: alarma no-output", async () => {
    const dir = edition();
    try {
      const n = fakeNotify();
      const first = deps(at(30_000), n);
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, first), 0);
      assert.equal(first.scripts.length, 1, "tentou baixar e publicar");
      assert.equal(n.issues.length, 0, "sem issue de alarme na 1ª tentativa");
      assert.equal(n.emails.length, 0);

      const later = deps(at(DRIVE_NOT_READY_GRACE_MS + 30_000), n);
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, later), 1);
      assert.equal(n.issues.length, 1);
      assert.match(n.issues[0].title, /\(no-output\)/);
      assert.match(n.issues[0].body, /veio vazio/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13541 timer do Instagram: corte ainda subindo", () => {
  const FOUND: InstagramCutLookup = { kind: "found", fileId: ID, name: "261118_Diaria comentada_Vertical_V1.mp4", modifiedTime: "2026-10-27T10:59:19.599Z" };
  function deps(now: Date, notify: ReturnType<typeof fakeNotify>): InstagramTimerRunDeps & { scripts: string[][] } {
    const scripts: string[][] = [];
    return {
      config: IG_CFG,
      now,
      lookupInstagramCut: () => FOUND,
      lookupGenericVertical: () => ({ kind: "none", reason: "nada" }),
      runScript: (args: string[]) => {
        scripts.push(args);
        return EMPTY_RUN;
      },
      notify: notify.deps,
      scripts,
    };
  }
  it("no horário do vertical: espera sem alarme, sem sidecar; uma hora depois, ainda vazio: alarma no-output", async () => {
    const dir = edition();
    try {
      const n = fakeNotify();
      const first = deps(at(30_000), n);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, first), 0);
      assert.equal(first.scripts.length, 1, "tentou baixar e publicar");
      assert.ok(first.scripts[0].includes("--from-drive"));
      assert.equal(n.issues.length, 0, "sem issue de alarme na 1ª tentativa");
      assert.equal(existsSync(join(dir, "_internal", ".shorts-instagram-cut.json")), false, "download vazio não grava o sidecar do corte");

      const later = deps(at(DRIVE_NOT_READY_GRACE_MS + 30_000), n);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, later), 1);
      assert.equal(n.issues.length, 1);
      assert.match(n.issues[0].title, /\(no-output\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
