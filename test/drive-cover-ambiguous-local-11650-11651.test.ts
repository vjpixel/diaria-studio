/**
 * test/drive-cover-ambiguous-local-11650-11651.test.ts (#11650, #11651)
 *
 * #11650: com duas capas Still no Drive (`Final/` + `Editados/`) e o vídeo
 * ainda fora do disco, `fetch-drive-video.ts` devolvia `needs-editor`
 * (`ambiguous-cover`) ANTES de ver que a capa local seria mantida (#11636) —
 * a capa do Drive nunca seria usada e mesmo assim travava o vídeo. Agora a
 * ambiguidade só pesa quando o Still do Drive seria de fato usado (sem capa
 * local, ou com `--force`), e o `needs-editor` leva `video_selection` para o
 * alarme do timer só dizer "o vertical já é único" quando é.
 *
 * #11651: o alarme `late` do timer do LinkedIn pessoal repassava o `detail` do
 * planner (escrito para o agente da skill) e oferecia `/diaria-publica-video
 * --so vertical`; os dois caem em `skip_delegated` com o timer dono do
 * destino. Agora o corpo oferece `--linkedin-timer --now` (ou postar à mão +
 * `--mark`). Sem rede: Drive e gh falsos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFetchDriveVideo, type FetchDriveVideoDeps } from "../scripts/fetch-drive-video.ts";
import {
  buildLinkedinTimerAlarm,
  interpretDriveLookup,
  interpretLinkedinTimerOutput,
  lateReason,
  runLinkedinTimer,
  type LinkedinTimerRunDeps,
} from "../scripts/shorts-linkedin-profile-timer.ts";
import { shortVideoFileName } from "../scripts/lib/diaria/short-video.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const FOLDER = "application/vnd.google-apps.folder";
const VIDEO_BYTES = Buffer.from("conteudo do video");
const folder = (id: string, name: string) => ({ id, name, mimeType: FOLDER });
const still = (id: string, name: string) => ({ id, name, mimeType: "image/png", modifiedTime: "2026-10-29T01:33:00Z" });
const mp4 = (id: string, name: string, width: number, height: number) => ({
  id,
  name,
  mimeType: "video/mp4",
  size: String(VIDEO_BYTES.length),
  createdTime: "2026-10-29T01:00:00Z",
  modifiedTime: "2026-10-29T01:00:00Z",
  videoMediaMetadata: { width, height },
});

/** Drive com `261029/Final/` (vídeo + 1 Still) e `261029/Editados/` (outro Still). */
function drive(orientation: "horizontal" | "vertical") {
  const media: string[] = [];
  const video =
    orientation === "horizontal"
      ? mp4("vid", "Diaria comentada_Youtube_V3.mp4", 1920, 1080)
      : mp4("vid", "Diaria comentada_Outras redes_V3.mp4", 1080, 1920);
  const stillName = orientation === "horizontal" ? "Diaria comentada_Youtube_V3.00_00_03_08.Still001.png" : "Diaria comentada_Outras redes_V3.00_00_03_08.Still001.png";
  const deps: FetchDriveVideoDeps = {
    driveFetch: async (url) => {
      const u = new URL(url);
      if (u.searchParams.get("alt") === "media") {
        media.push(u.pathname.split("/").at(-1) ?? "");
        return new Response(new Uint8Array(VIDEO_BYTES), { headers: { "content-type": "video/mp4" } });
      }
      if (u.pathname.endsWith("/root")) return Response.json(folder("root", "YouTube"));
      const q = u.searchParams.get("q") ?? "";
      if (q.startsWith("'root'")) return Response.json({ files: [folder("edition", "261029")] });
      if (q.startsWith("'edition'")) return Response.json({ files: [folder("final", "Final"), folder("edited", "Editados")] });
      if (q.startsWith("'final'")) return Response.json({ files: [video, still("one", stillName)] });
      if (q.startsWith("'edited'")) return Response.json({ files: [still("two", stillName.replace("Still001", "Still002"))] });
      throw new Error(`pasta inesperada: ${url}`);
    },
  };
  return { deps, media };
}

async function fetchWith(opts: { orientation: "horizontal" | "vertical"; localCover: boolean; force?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "cover-11650-"));
  const cover = join(dir, opts.orientation === "horizontal" ? "04-youtube-thumb.jpg" : "04-youtube-short-capa.jpg");
  if (opts.localCover) writeFileSync(cover, "capa local ajustada");
  const { deps, media } = drive(opts.orientation);
  const logs: string[] = [];
  try {
    const result = await runFetchDriveVideo(
      deps,
      { aammdd: "261029", orientation: opts.orientation, folderId: "root", editionDir: dir, now: new Date("2026-10-29T12:00:00Z"), windowHours: 36, force: opts.force ?? false, dryRun: false },
      (l) => logs.push(l),
    );
    const coverAfter = opts.localCover ? readFileSync(cover, "utf8") : null;
    const videoAfter = (() => {
      try {
        return readFileSync(join(dir, opts.orientation === "horizontal" ? "diaria-comentada-261029.mp4" : shortVideoFileName("261029")), "utf8");
      } catch {
        return null;
      }
    })();
    return { result, media, logs, coverAfter, videoAfter };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#11650 capa Still ambígua com capa local mantida não trava o vídeo", () => {
  it("regressão (horizontal): ambíguo + capa local + sem --force → baixa o vídeo e mantém a capa local", async () => {
    const { result, media, coverAfter, videoAfter, logs } = await fetchWith({ orientation: "horizontal", localCover: true });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(result.output.action, "downloaded");
    assert.equal(result.output.cover?.source, "local");
    assert.deepEqual(media, ["vid"], "só o vídeo desce; nenhum Still");
    assert.equal(coverAfter, "capa local ajustada");
    assert.equal(videoAfter, VIDEO_BYTES.toString());
    assert.ok(logs.some((l) => l.includes("capa local mantida") && l.includes("#11650")));
  });

  it("regressão (vertical, o caso do timer): ambíguo + capa local → print-id do vertical, sem needs-editor", async () => {
    const { result, media, coverAfter } = await fetchWith({ orientation: "vertical", localCover: true });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(result.output.action, "print-id");
    if (result.output.action === "print-id") assert.equal(result.output.file.id, "vid");
    assert.deepEqual(media, []);
    assert.equal(coverAfter, "capa local ajustada");
  });

  it("com --force a capa do Drive seria usada: a ambiguidade segue com o editor, com video_selection", async () => {
    const { result, media, coverAfter } = await fetchWith({ orientation: "horizontal", localCover: true, force: true });
    assert.equal(result.exitCode, 3);
    assert.equal(result.output.action, "needs-editor");
    if (result.output.action === "needs-editor" && result.output.selection === "ambiguous-cover") {
      assert.equal(result.output.video_selection, "found");
    } else assert.fail("esperava ambiguous-cover");
    assert.deepEqual(media, []);
    assert.equal(coverAfter, "capa local ajustada");
  });

  it("sem capa local a capa do Drive seria usada: needs-editor ambiguous-cover", async () => {
    const { result } = await fetchWith({ orientation: "vertical", localCover: false });
    assert.equal(result.exitCode, 3);
    assert.equal(result.output.action, "needs-editor");
    const lookup = interpretDriveLookup(result.exitCode, JSON.stringify(result.output));
    assert.equal(lookup.kind, "wait");
    if (lookup.kind === "wait") {
      assert.equal(lookup.selection, "ambiguous-cover");
      assert.equal(lookup.videoSelection, "found");
    }
  });
});

const AAMMDD = "261027";
// 261027: vertical às 08:00 BRT = 11:00Z.
const AT = "2026-10-27T11:00:00.000Z";

describe("#11650 alarme do timer só afirma 'vertical único' quando a escolha do vídeo é única", () => {
  it("ambiguous-cover com video_selection found: 'O vertical já é único'", () => {
    const { body } = buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "drive-needs-editor", reason: "r", at: AT, selection: "ambiguous-cover", videoSelection: "found" });
    assert.match(body, /O vertical já é único/);
  });
  for (const videoSelection of ["ambiguous", "none", undefined]) {
    it(`ambiguous-cover com video_selection ${videoSelection ?? "ausente"}: não afirma que o vertical é único`, () => {
      const { body } = buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "drive-needs-editor", reason: "r", at: AT, selection: "ambiguous-cover", videoSelection });
      assert.doesNotMatch(body, /vertical já é único/);
      assert.match(body, /uma só capa Still/);
      assert.match(body, /um só vertical "final"/);
    });
  }
});

/** Saída real do publish-shorts no `skip_late` (o `detail` é o do planner, `publish-shorts.ts`). */
const LATE_DETAIL =
  "08:00 BRT passou há 200 min (teto 3 h) — fora do horário do teste (#10831), esta rodada não publica sozinha. " +
  "O agente publica com --only linkedin_profile --publish --now (ou registra com --mark linkedin_profile=URL se já saiu); nunca volta ao editor (#11550)";
const LATE_OUT = JSON.stringify({
  dry_run: false,
  items: [{ destination: "linkedin_profile", mode: "api", action: "skip_late", detail: LATE_DETAIL }],
  results: [],
});

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
      schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" },
    },
  },
};

/** Remédios que não publicam com o timer dono do destino (caem em skip_delegated). */
function assertNoDelegatedRemedy(body: string) {
  assert.doesNotMatch(body, /--so vertical/);
  assert.doesNotMatch(body, /O agente publica/);
  assert.doesNotMatch(body, /--publish --now/, "comando sem --linkedin-timer cai em skip_delegated");
  assert.match(body, new RegExp(`publish-shorts\\.ts ${AAMMDD} --only linkedin_profile --publish --linkedin-timer --now`));
  assert.match(body, new RegExp(`publish-shorts\\.ts ${AAMMDD} --mark linkedin_profile=URL`));
}

describe("#11651 alarme late do timer do LinkedIn pessoal", () => {
  it("lateReason guarda só o atraso; texto do agente vira o motivo genérico", () => {
    assert.equal(lateReason(LATE_DETAIL), "08:00 BRT passou há 200 min (teto 3 h)");
    assert.equal(lateReason("O agente publica com --only linkedin_profile --publish --now"), "passou do teto de 3 h depois do horário do vertical");
    assert.equal(lateReason(""), "passou do teto de 3 h depois do horário do vertical");
  });

  it("interpretLinkedinTimerOutput: o detail do late não repassa o comando da skill", () => {
    const o = interpretLinkedinTimerOutput(0, LATE_OUT);
    assert.equal(o.kind, "alarm");
    if (o.kind === "alarm") {
      assert.equal(o.key, "late");
      assert.equal(o.detail, "08:00 BRT passou há 200 min (teto 3 h)");
    }
  });

  it("buildLinkedinTimerAlarm late: oferece --linkedin-timer --now ou postar à mão + --mark", () => {
    const { body } = buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "late", reason: lateReason(LATE_DETAIL), at: AT });
    assertNoDelegatedRemedy(body);
    assert.match(body, /NÃO publica mais sozinho/);
  });

  it("regressão: runLinkedinTimer com skip_late real manda o corpo sem os remédios que caem em skip_delegated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "li-timer-11651-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo.\n");
      writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "mp4");
      const issues: string[] = [];
      const ghRun = (args: string[]): GhSpawnResult => {
        if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
        if (args[0] === "issue" && args[1] === "create") {
          issues.push(args[args.indexOf("--body") + 1] ?? "");
          return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/902\n", stderr: "" };
        }
        throw new Error(`gh inesperado: ${args.join(" ")}`);
      };
      const deps: LinkedinTimerRunDeps = {
        config: CFG,
        now: new Date(Date.parse(AT) + 200 * 60_000),
        runScript: (args: string[]) => {
          if (args[0] === "scripts/publish-shorts.ts") return { status: 0, stdout: LATE_OUT };
          throw new Error(`script inesperado: ${args.join(" ")}`);
        },
        notify: { ghRun, sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true },
      };
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps), 0);
      assert.equal(issues.length, 1);
      assertNoDelegatedRemedy(issues[0]);
      assert.match(issues[0], /Motivo \(late\): 08:00 BRT passou há 200 min \(teto 3 h\)\n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("os demais alarmes de 'não saiu' também não oferecem o /diaria-publica-video --so vertical", () => {
    for (const key of ["missing-video", "drive-needs-editor", "publish-failed", "credentials", "no-output"] as const) {
      assertNoDelegatedRemedy(buildLinkedinTimerAlarm({ aammdd: AAMMDD, key, reason: "r", at: AT }).body);
    }
  });
});
