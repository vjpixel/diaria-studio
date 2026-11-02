/**
 * test/publish-video-confirm-interrupt-11741.test.ts (#11741)
 *
 * Em 261030 duas chamadas de publisher rejeitadas no app parecem ter
 * publicado mesmo assim. Mitigação decidida pelo editor:
 *   1. `publish-youtube.ts --upload` e `publish-shorts.ts --publish` exigem
 *      `--confirm-publish AAMMDD` (a mesma edição) e recusam antes de
 *      qualquer I/O sem ela;
 *   2. a skill relê o registro depois de qualquer interrupção
 *      (`video-publish-registry-status.ts --since`).
 *
 * Os CLIs aqui só são executados no caminho de RECUSA (exit 2 antes de
 * credencial, vídeo ou rede), num diretório temporário vazio — nenhum
 * publisher roda de verdade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLISH_CONFIRM_FLAG,
  publishConfirmArgs,
  publishConfirmationError,
} from "../scripts/lib/diaria/publish-confirm.ts";
import { assignShortsDestinationOwners } from "../scripts/publish-shorts.ts";
import { threadsPublishArgs } from "../scripts/shorts-threads-profile-timer.ts";
import { instagramPublishArgs } from "../scripts/shorts-instagram-timer.ts";
import { summarizeVideoRegistries } from "../scripts/video-publish-registry-status.ts";
import { parseArgs } from "../scripts/lib/cli-args.ts";

const ROOT = join(import.meta.dirname, "..");
const AAMMDD = "261030";

function confirmErr(argv: string[], mode: "--upload" | "--publish" = "--upload") {
  const { flags, values } = parseArgs(argv);
  return publishConfirmationError({ script: "publish-youtube", mode, aammdd: AAMMDD, flags, values });
}

describe("#11741 publishConfirmationError", () => {
  it("sem a flag: recusa e manda reler o registro", () => {
    const err = confirmErr([AAMMDD, "--upload"]);
    assert.ok(err);
    assert.match(err!, /confirmação explícita/);
    assert.match(err!, /video-publish-registry-status\.ts 261030 --since/);
    assert.match(err!, /Nada foi enviado/);
  });
  it("flag sem valor: recusa", () => {
    assert.match(confirmErr([AAMMDD, "--upload", `--${PUBLISH_CONFIRM_FLAG}`])!, /exige a edição/);
  });
  it("flag com outra edição: recusa (a confirmação vale só para a edição do comando)", () => {
    assert.match(confirmErr([AAMMDD, "--upload", `--${PUBLISH_CONFIRM_FLAG}`, "261029"])!, /não confirma a edição 261030/);
  });
  it("flag com a mesma edição, em qualquer posição: confirma", () => {
    assert.equal(confirmErr([AAMMDD, "--upload", ...publishConfirmArgs(AAMMDD)]), null);
    assert.equal(confirmErr([...publishConfirmArgs(AAMMDD), AAMMDD, "--upload"]), null);
    assert.equal(confirmErr([AAMMDD, "--upload", `--${PUBLISH_CONFIRM_FLAG}=${AAMMDD}`]), null);
  });
});

describe("#11741 CLIs recusam sem confirmação, antes de qualquer I/O", () => {
  const run = (script: string, args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "confirm-11741-"));
    try {
      // Diretório vazio: sem 02-reviewed.md, sem vídeo, sem registro. A recusa
      // tem de vir ANTES da checagem desses arquivos (que sairia exit 1).
      return spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", script), AAMMDD, "--edition-dir", dir, ...args], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, YOUTUBE_REFRESH_TOKEN: "", YOUTUBE_CHANNEL_ID: "" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it("publish-youtube --upload sem --confirm-publish: exit 2", () => {
    const r = run("publish-youtube.ts", ["--upload"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /exige confirmação explícita \(#11741\)/);
    assert.equal(r.stdout, "");
  });
  it("publish-youtube --upload com outra edição: exit 2", () => {
    const r = run("publish-youtube.ts", ["--upload", "--confirm-publish", "261029"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /não confirma a edição 261030/);
  });
  it("publish-youtube --upload confirmado passa do guard (para no 02-reviewed.md ausente, exit 1)", () => {
    const r = run("publish-youtube.ts", ["--upload", "--confirm-publish", AAMMDD]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /02-reviewed\.md não existe/);
  });
  it("publish-youtube --dry-run não pede confirmação", () => {
    const r = run("publish-youtube.ts", ["--dry-run"]);
    assert.doesNotMatch(r.stderr, /#11741/);
  });
  it("publish-shorts --publish sem --confirm-publish: exit 2", () => {
    const r = run("publish-shorts.ts", ["--publish"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /publish-shorts: --publish tem efeito público e exige confirmação explícita/);
    assert.equal(r.stdout, "");
  });
  it("publish-shorts --publish do timer também exige (o timer passa a flag sozinho)", () => {
    const r = run("publish-shorts.ts", ["--only", "linkedin_profile", "--publish", "--linkedin-timer"]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /#11741/);
  });
  it("publish-shorts --publish confirmado passa do guard (para no 02-reviewed.md ausente, exit 1)", () => {
    const r = run("publish-shorts.ts", ["--publish", "--confirm-publish", AAMMDD]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /02-reviewed\.md não existe/);
  });
});

describe("#11741 chamadores automáticos autorizados passam a confirmação", () => {
  it("timers do Threads e do Instagram", () => {
    const t = threadsPublishArgs(AAMMDD, null);
    assert.deepEqual(t.slice(t.indexOf("--confirm-publish"), t.indexOf("--confirm-publish") + 2), ["--confirm-publish", AAMMDD]);
    const ig = instagramPublishArgs(AAMMDD, { kind: "use-local", path: "/e/ig.mp4", source: "instagram-cut" } as never);
    assert.equal(ig[ig.indexOf("--confirm-publish") + 1], AAMMDD);
  });
  it("timer do LinkedIn e stage5-youtube montam o comando com a flag", () => {
    const li = readFileSync(join(ROOT, "scripts", "shorts-linkedin-profile-timer.ts"), "utf8");
    assert.match(li, /"--publish", "--linkedin-timer", \.\.\.publishConfirmArgs\(aammdd\)\]/);
    const s5 = readFileSync(join(ROOT, "scripts", "stage5-youtube.ts"), "utf8");
    assert.match(s5, /"--upload", "--edition-dir", dir, \.\.\.publishConfirmArgs\(aammdd\)\]/);
  });
  it("owners[]: task one-shot e skip_late levam a flag no command", () => {
    const owners = assignShortsDestinationOwners(
      [
        { destination: "threads_profile", mode: "api", action: "pending_schedule", scheduledAt: "2026-10-30T15:00:00.000Z" },
        { destination: "linkedin_profile", mode: "api", action: "skip_late", detail: "x" },
      ] as never,
      { aammdd: AAMMDD, now: new Date("2026-10-30T12:00:00Z"), instagramViaTimer: true },
    );
    for (const o of owners) assert.match(o.command ?? "", /--publish.* --confirm-publish 261030$/, o.destination);
  });
});

describe("#11741 releitura do registro depois da interrupção", () => {
  const since = "2026-10-30T13:43:00.000Z";
  const ytDone = (uploadedAt: string) => ({
    ok: true as const,
    value: { kind: "done" as const, record: { aammdd: AAMMDD, videoId: "abc", url: "https://youtu.be/abc", state: "scheduled", uploadedAt } as never },
  });
  const shorts = (entries: Array<{ destination: string; at: string; status?: string }>) => ({
    ok: true as const,
    value: { aammdd: AAMMDD, entries: entries.map((e) => ({ id: "x", status: e.status ?? "published", ...e })) as never },
  });

  it("cenário real de 261030: upload 13:43:23 depois da chamada rejeitada → registered-since", () => {
    const s = summarizeVideoRegistries({
      aammdd: AAMMDD,
      since,
      youtube: ytDone("2026-10-30T13:43:23.000Z"),
      shorts: shorts([
        { destination: "youtube_shorts", at: "2026-10-30T13:49:56.000Z" },
        { destination: "facebook:diaria", at: "2026-10-30T13:52:50.000Z" },
        { destination: "threads_profile", at: "2026-10-30T13:20:00.000Z" },
      ]),
    });
    assert.equal(s.verdict, "registered-since");
    assert.deepEqual(s.registered_since, ["youtube", "youtube_shorts", "facebook:diaria"]);
    assert.match(s.message, /nunca publicar esses destinos de novo/);
  });
  it("nada depois do corte → nothing-since (a interrupção é um não)", () => {
    const s = summarizeVideoRegistries({ aammdd: AAMMDD, since, youtube: { ok: true, value: { kind: "none" } }, shorts: shorts([]) });
    assert.equal(s.verdict, "nothing-since");
    assert.deepEqual(s.registered_since, []);
  });
  it("marcador in_progress do upload depois do corte conta (pode ter saído)", () => {
    const s = summarizeVideoRegistries({
      aammdd: AAMMDD,
      since,
      youtube: { ok: true, value: { kind: "pending", sentinel: { aammdd: AAMMDD, status: "in_progress", at: "2026-10-30T13:43:10.000Z" } as never } },
      shorts: shorts([]),
    });
    assert.deepEqual(s.registered_since, ["youtube"]);
    assert.equal(s.youtube.status, "in_progress");
  });
  it("registro sem data legível nunca some do corte", () => {
    const s = summarizeVideoRegistries({ aammdd: AAMMDD, since, youtube: { ok: true, value: { kind: "none" } }, shorts: shorts([{ destination: "x", at: "?" }]) });
    assert.deepEqual(s.registered_since, ["x"]);
  });
  it("registro ilegível → unreadable", () => {
    const s = summarizeVideoRegistries({ aammdd: AAMMDD, since, youtube: { ok: false, error: "json" }, shorts: shorts([]) });
    assert.equal(s.verdict, "unreadable");
  });
  it("CLI lê os arquivos reais da edição (só leitura)", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-11741-"));
    try {
      mkdirSync(join(dir, "_internal"));
      writeFileSync(
        join(dir, "_internal", "05-youtube-published.json"),
        JSON.stringify({ aammdd: AAMMDD, videoId: "abc", url: "https://youtu.be/abc", state: "draft", uploadedAt: "2026-10-30T13:43:23.000Z" }),
      );
      writeFileSync(
        join(dir, "_internal", "06-shorts-published.json"),
        JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "facebook:diaria", status: "published", id: "1", at: "2026-10-30T13:52:50.000Z" }] }),
      );
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts", "video-publish-registry-status.ts"), AAMMDD, "--edition-dir", dir, "--since", since],
        { encoding: "utf8", cwd: ROOT },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.verdict, "registered-since");
      assert.deepEqual(out.registered_since, ["youtube", "facebook:diaria"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11741 a skill instrui confirmação e releitura", () => {
  const skill = readFileSync(join(ROOT, ".claude", "skills", "diaria-publica-video", "SKILL.md"), "utf8");
  it("não diz mais que invocar a skill é o pedido de publicação", () => {
    assert.doesNotMatch(skill, /Invocar a skill (já )?é o pedido/);
  });
  it("comandos de publicação levam --confirm-publish", () => {
    assert.match(skill, /publish-youtube\.ts \{AAMMDD\} --upload --confirm-publish \{AAMMDD\}/);
    assert.match(skill, /publish-shorts\.ts \{AAMMDD\} --publish --confirm-publish \{AAMMDD\}/);
  });
  it("manda reler o registro depois de interrupção", () => {
    assert.match(skill, /video-publish-registry-status\.ts \{AAMMDD\} --since/);
  });
});
