/**
 * test/shorts-linkedin-timer-ambiguous-cover-11628.test.ts (#11628)
 *
 * Com o vertical único em `Final/` mas duas capas Still no Drive, o
 * `fetch-drive-video.ts` devolve `needs-editor` com `selection:
 * "ambiguous-cover"` (#11545). O alarme `drive-needs-editor` do timer do
 * LinkedIn pessoal mandava "Deixe um só vertical final", quando o que trava é
 * a capa (que o LinkedIn nem usa). Agora o texto orienta deixar uma só capa
 * Still. Sem rede: I/O falso.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLinkedinTimerAlarm, interpretDriveLookup, runLinkedinTimer, type LinkedinTimerRunDeps } from "../scripts/shorts-linkedin-profile-timer.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

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
  schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" },
};
const CFG = { publishing: { shorts: SHORTS } };
// 261027: vertical às 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";

/** Saída do fetch-drive-video no caso da issue: vertical único, duas capas Still. */
const DRIVE_AMBIGUOUS_COVER = JSON.stringify({
  edition: AAMMDD,
  orientation: "vertical",
  folder_id: "root",
  local_path: "x",
  edition_folder_id: "edfolder123",
  final_folder_ids: ["final123"],
  target: "generic",
  action: "needs-editor",
  selection: "ambiguous-cover",
  candidates: [
    { id: "c1", name: "Still 1.jpg" },
    { id: "c2", name: "Still 2.jpg" },
  ],
});

function fakeGh() {
  const issues: { body: string }[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      issues.push({ body: args[args.indexOf("--body") + 1] ?? "" });
      return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/901\n", stderr: "" };
    }
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  return { issues, notify: { ghRun, sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true } };
}

describe("#11628 alarme de capa ambígua orienta a capa, não o vertical", () => {
  it("interpretDriveLookup carrega o selection do needs-editor", () => {
    const l = interpretDriveLookup(3, DRIVE_AMBIGUOUS_COVER);
    assert.equal(l.kind, "wait");
    assert.equal((l as { selection?: string }).selection, "ambiguous-cover");
  });

  it("buildLinkedinTimerAlarm com ambiguous-cover pede uma só capa Still e não manda deixar um só vertical", () => {
    const { body } = buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "drive-needs-editor", reason: "r", at: AT, selection: "ambiguous-cover" });
    assert.match(body, /uma só capa Still/);
    assert.doesNotMatch(body, /Deixe um só vertical/);
  });

  it("outros needs-editor seguem pedindo um só vertical", () => {
    const { body } = buildLinkedinTimerAlarm({ aammdd: AAMMDD, key: "drive-needs-editor", reason: "r", at: AT, selection: "ambiguous" });
    assert.match(body, /Deixe um só vertical/);
  });

  it("regressão: runLinkedinTimer com capa ambígua alarma com a instrução da capa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "li-timer-11628-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo.\n");
      const gh = fakeGh();
      const deps: LinkedinTimerRunDeps = {
        config: CFG,
        now: new Date(Date.parse(AT) + 30 * 60_000),
        runScript: (args: string[]) => {
          if (args[0] === "scripts/fetch-drive-video.ts") return { status: 3, stdout: DRIVE_AMBIGUOUS_COVER };
          throw new Error("não deveria publicar");
        },
        notify: gh.notify,
      };
      assert.equal(await runLinkedinTimer(AAMMDD, dir, false, deps), 0);
      assert.equal(gh.issues.length, 1);
      assert.match(gh.issues[0].body, /uma só capa Still/);
      assert.doesNotMatch(gh.issues[0].body, /Deixe um só vertical/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
