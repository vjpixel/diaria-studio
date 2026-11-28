/**
 * test/instagram-first-comment-retry-13759.test.ts (#13759)
 *
 * Follow-up do #13709: o 1º comentário do Reels leva o link por edição e a
 * legenda promete "link no primeiro comentário". Se o comentário falhava (ex.:
 * token sem `instagram_manage_comments`), virava só aviso: o registro saía sem
 * rastro, a rodada seguinte do timer via o `instagram` registrado e não
 * tentava de novo, e o alarme saía como `collab` (convite descartado).
 *
 * Agora: a falha grava `first_comment_pending` na entrada; o timer do 300
 * retenta via `retry-instagram-first-comment.ts` até 4 tentativas, com alarme
 * próprio (`first-comment`, depois `first-comment-stuck`). Resposta sem id não
 * retenta (o comentário pode existir). Sem rede: Graph, `gh` e e-mail falsos.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishInstagramReel } from "../scripts/publish-shorts/instagram.ts";
import { type GraphDeps } from "../scripts/publish-shorts/facebook.ts";
import {
  INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS,
  applyFirstCommentAttempt,
  firstCommentRetryState,
  initialFirstCommentPending,
} from "../scripts/lib/diaria/instagram-first-comment-retry.ts";
import { retryInstagramFirstComment, type RetryFirstCommentDeps } from "../scripts/retry-instagram-first-comment.ts";
import {
  INSTAGRAM_TIMER_ALARM_STATE_FILE,
  alarmSeverity,
  buildInstagramTimerAlarm,
  decideInstagramTimerRun,
  interpretFirstCommentRetryOutput,
  interpretInstagramTimerOutput,
  runInstagramTimer,
  type InstagramTimerRunDeps,
} from "../scripts/shorts-instagram-timer.ts";
import { SHORTS_PUBLISHED_FILE, type ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, readShortsRegistryRaws } from "../scripts/lib/diaria/shorts-published-store.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const AAMMDD = "261027";
const NOW = new Date("2026-10-27T16:00:00.000Z");
const MSG = "Vídeo completo: https://diar.ia.br/video/261027";
const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const CFG = { publishing: { shorts: { facebook_pages: [], instagram: true, instagram_collaborators: [], linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE } } };

function igEntry(over: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry {
  return { destination: "instagram", status: "published", id: "m1", url: "https://instagram.com/reel/m1", scheduled_at: null, at: "2026-10-27T15:00:00.000Z", ...over };
}

function edition(entries: ShortPublishedEntry[], file = SHORTS_INSTAGRAM_TIMER_LEDGER_FILE): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-first-comment-13759-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n");
  writeFileSync(join(dir, file), JSON.stringify({ aammdd: AAMMDD, entries }, null, 2));
  return dir;
}

function readIg(dir: string, file = SHORTS_INSTAGRAM_TIMER_LEDGER_FILE): ShortPublishedEntry {
  return (JSON.parse(readFileSync(join(dir, file), "utf8")).entries as ShortPublishedEntry[]).find((e) => e.destination === "instagram")!;
}

const pending = (attempts: number, extra: object = {}) => ({ message: MSG, error: "(#10) sem instagram_manage_comments", attempts, last_attempt_at: "2026-10-27T15:00:00.000Z", ...extra });

describe("#13759 publishInstagramReel: falha do comentário fica no registro", () => {
  function fakeDeps(responses: Array<() => Record<string, unknown>>): GraphDeps {
    let i = 0;
    return {
      fetch: async (url) => {
        const r = responses[i++];
        if (!r) throw new Error(`chamada inesperada: ${url}`);
        const { __http, ...json } = r() as { __http?: number };
        return new Response(JSON.stringify(json), { status: __http ?? 200 });
      },
      sleep: async () => {},
      now: () => NOW,
      log: () => {},
    };
  }
  const publish = (commentResponse: () => Record<string, unknown>) =>
    publishInstagramReel(
      fakeDeps([() => ({ id: "c1" }), () => ({ status_code: "FINISHED" }), () => ({ id: "m1" }), () => ({ permalink: "https://instagram.com/reel/m1" }), commentResponse]),
      "ig",
      "tok",
      "v25.0",
      { videoUrl: "https://media.diar.ia.br/v.mp4" },
      "legenda",
      [],
      undefined,
      { firstComment: MSG },
    );

  it("403 do comentário: first_comment_pending com texto, erro e 1 tentativa", async () => {
    const out = await publish(() => ({ __http: 403, error: { message: "(#10) sem instagram_manage_comments" } }));
    assert.equal(out.entry.first_comment_id, undefined);
    assert.equal(out.entry.first_comment_pending?.message, MSG);
    assert.equal(out.entry.first_comment_pending?.attempts, 1);
    assert.match(out.entry.first_comment_pending?.error ?? "", /instagram_manage_comments/);
    assert.equal(out.entry.first_comment_pending?.uncertain, undefined);
    assert.equal(firstCommentRetryState(out.entry).kind, "retry");
  });

  it("resposta sem id: pendência incerta, nunca retentada", async () => {
    const out = await publish(() => ({ success: true }));
    assert.equal(out.entry.first_comment_pending?.uncertain, true);
    assert.equal(firstCommentRetryState(out.entry).kind, "uncertain");
  });

  it("comentário ok: sem pendência", async () => {
    const out = await publish(() => ({ id: "cm1" }));
    assert.equal(out.entry.first_comment_id, "cm1");
    assert.equal(out.entry.first_comment_pending, undefined);
  });
});

describe("#13759 estado e tentativa (puro)", () => {
  it("retry até o teto; esgotado depois; publish incerto (sem url) não retenta", () => {
    assert.equal(firstCommentRetryState(igEntry()).kind, "none");
    assert.equal(firstCommentRetryState(igEntry({ first_comment_pending: pending(1) })).kind, "retry");
    assert.equal(firstCommentRetryState(igEntry({ first_comment_pending: pending(INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS) })).kind, "exhausted");
    assert.equal(firstCommentRetryState(igEntry({ url: undefined, first_comment_pending: pending(1) })).kind, "invalid");
    assert.equal(firstCommentRetryState(igEntry({ first_comment_id: "cm1", first_comment_pending: pending(1) })).kind, "none");
  });
  it("sucesso troca a pendência pelo id; falha soma a tentativa", () => {
    const e = igEntry({ first_comment_pending: pending(1) });
    const ok = applyFirstCommentAttempt(e, { ok: true, id: "cm9" }, NOW);
    assert.equal(ok.first_comment_id, "cm9");
    assert.equal("first_comment_pending" in ok, false);
    const fail = applyFirstCommentAttempt(e, { ok: false, error: "503" }, NOW);
    assert.equal(fail.first_comment_pending?.attempts, 2);
    assert.equal(fail.first_comment_pending?.error, "503");
    assert.equal(fail.first_comment_pending?.last_attempt_at, NOW.toISOString());
    assert.deepEqual(initialFirstCommentPending(MSG, { ok: false, error: "x" }, NOW), { message: MSG, error: "x", attempts: 1, last_attempt_at: NOW.toISOString() });
  });
});

describe("#13759 retry-instagram-first-comment.ts", () => {
  const deps = (post: RetryFirstCommentDeps["postComment"], author: Awaited<ReturnType<RetryFirstCommentDeps["resolveAuthor"]>> = { token: "tok", apiVersion: "v25.0" }) => {
    const posted: string[] = [];
    const d: RetryFirstCommentDeps = {
      now: () => NOW,
      resolveAuthor: async () => author,
      postComment: async (mediaId, token, apiVersion, message) => {
        posted.push(`${mediaId}|${message}`);
        return post(mediaId, token, apiVersion, message);
      },
    };
    return { d, posted };
  };

  it("retentativa que sai: grava first_comment_id no arquivo do timer e apaga a pendência", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = deps(async () => ({ ok: true, id: "cm2" }));
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(r.action, "commented");
      assert.deepEqual(posted, [`m1|${MSG}`]);
      const e = readIg(dir);
      assert.equal(e.first_comment_id, "cm2");
      assert.equal(e.first_comment_pending, undefined);
      // De novo: nada a fazer, nada postado.
      const again = deps(async () => ({ ok: true, id: "x" }));
      assert.equal((await retryInstagramFirstComment(dir, AAMMDD, false, again.d)).action, "none");
      assert.equal(again.posted.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha soma tentativa; a 4ª esgota; esgotado não posta mais", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS - 1) })], SHORTS_PUBLISHED_FILE);
    try {
      const { d } = deps(async () => ({ ok: false, error: "503" }));
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(r.action, "failed");
      assert.equal(r.action === "failed" && r.exhausted, true);
      assert.equal(readIg(dir, SHORTS_PUBLISHED_FILE).first_comment_pending?.attempts, INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS);
      const after = deps(async () => ({ ok: true, id: "x" }));
      assert.equal((await retryInstagramFirstComment(dir, AAMMDD, false, after.d)).action, "exhausted");
      assert.equal(after.posted.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem credencial: conta como tentativa (nunca loop infinito), nada postado", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = deps(async () => ({ ok: true, id: "x" }), { error: "sem INSTAGRAM_ACCESS_TOKEN" });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(r.action, "failed");
      assert.equal(posted.length, 0);
      assert.equal(readIg(dir).first_comment_pending?.attempts, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run não posta nem grava", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = deps(async () => ({ ok: true, id: "x" }));
      assert.equal((await retryInstagramFirstComment(dir, AAMMDD, true, d)).action, "dry-run");
      assert.equal(posted.length, 0);
      assert.equal(readIg(dir).first_comment_pending?.attempts, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13759 timer do Instagram", () => {
  const publishOut = (entry: ShortPublishedEntry, warnings: string[] = []) =>
    JSON.stringify({ dry_run: false, items: [], results: [{ destination: "instagram", ok: true, entry, warnings }] });

  it("publish com o comentário falho: alarme first-comment (acao), não collab", () => {
    const r = interpretInstagramTimerOutput(0, publishOut(igEntry({ first_comment_pending: pending(1) }), ["Reels publicado (m1), 1º comentário não saiu: (#10)"]));
    assert.equal(r.kind, "alarm");
    assert.equal(r.kind === "alarm" && r.key, "first-comment");
    assert.equal(alarmSeverity("first-comment"), "acao");
    assert.equal(alarmSeverity("first-comment-stuck"), "acao");
    const u = interpretInstagramTimerOutput(0, publishOut(igEntry({ first_comment_pending: pending(1, { uncertain: true }) })));
    assert.equal(u.kind === "alarm" && u.key, "first-comment-stuck");
  });

  it("registrado com pendência: decide first-comment (antes ficava em skip para sempre); comentário registrado em outro arquivo vence", () => {
    const raws = (entries: ShortPublishedEntry[]) => [{ path: SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, raw: JSON.stringify({ aammdd: AAMMDD, entries }) }];
    const d = decideInstagramTimerRun({ config: CFG, reviewedExists: true, registryRaws: raws([igEntry({ first_comment_pending: pending(1) })]), aammdd: AAMMDD, now: NOW, videoSeen: true });
    assert.equal(d.kind, "first-comment");
    assert.equal(d.kind === "first-comment" && d.state.kind, "retry");
    assert.equal(decideInstagramTimerRun({ config: CFG, reviewedExists: true, registryRaws: raws([igEntry()]), aammdd: AAMMDD, now: NOW, videoSeen: true }).kind, "skip");
    const both = [
      ...raws([igEntry({ first_comment_pending: pending(1) })]),
      { path: SHORTS_PUBLISHED_FILE, raw: JSON.stringify({ aammdd: AAMMDD, entries: [igEntry({ first_comment_id: "cm1" })] }) },
    ];
    assert.equal(decideInstagramTimerRun({ config: CFG, reviewedExists: true, registryRaws: both, aammdd: AAMMDD, now: NOW, videoSeen: true }).kind, "skip");
  });

  it("saída da retentativa: commented = done; failed = first-comment; esgotado = first-comment-stuck", () => {
    assert.equal(interpretFirstCommentRetryOutput(0, JSON.stringify({ action: "commented", media_id: "m1", comment_id: "cm2", attempts: 2 })).kind, "done");
    const f = interpretFirstCommentRetryOutput(1, JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "503", attempts: 2, max_attempts: 4, exhausted: false, uncertain: false }));
    assert.equal(f.kind === "alarm" && f.key, "first-comment");
    const x = interpretFirstCommentRetryOutput(1, JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "503", attempts: 4, max_attempts: 4, exhausted: true, uncertain: false }));
    assert.equal(x.kind === "alarm" && x.key, "first-comment-stuck");
    assert.match(x.detail, /Texto: Vídeo completo/);
    assert.equal(interpretFirstCommentRetryOutput(1, "lixo").kind, "alarm");
  });

  it("corpo dos alarmes: no ar, não repostar; first-comment manda não comentar à mão, stuck manda comentar", () => {
    const a = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "first-comment", reason: "403", videoArg: null });
    assert.match(a.body, /NÃO reposte/);
    assert.match(a.body, /Não comente à mão enquanto o timer tenta/);
    assert.match(a.body, /retry-instagram-first-comment\.ts 261027/);
    assert.doesNotMatch(a.body, /--publish/);
    const s = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "first-comment-stuck", reason: "esgotado", videoArg: null });
    assert.match(s.body, /comente à mão/);
  });

  it("de ponta a ponta: o timer roda a retentativa; falha abre 1 alarme e a 2ª falha não repete; esgotado abre o stuck", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const issues: { title: string }[] = [];
      const ghRun = (args: string[]): GhSpawnResult => {
        if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues.map((x, i) => ({ number: 900 + i, url: `u${i}`, title: x.title, body: "", state: "OPEN" }))), stderr: "" };
        if (args[0] === "issue" && args[1] === "create") {
          issues.push({ title: args[args.indexOf("--title") + 1] ?? "" });
          return { status: 0, stdout: `https://github.com/vjpixel/diaria-studio/issues/${900 + issues.length}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };
      const scripts: string[][] = [];
      let attempts = 1;
      const runDeps = (): InstagramTimerRunDeps => ({
        config: CFG,
        now: NOW,
        lookupInstagramCut: () => {
          throw new Error("o timer não deve consultar o Drive com o Reels já registrado");
        },
        lookupGenericVertical: () => {
          throw new Error("idem");
        },
        runScript: (args) => {
          scripts.push(args);
          attempts++;
          // Simula o script: grava a tentativa no registro como o de verdade faria.
          const e = readIg(dir);
          writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [{ ...e, first_comment_pending: { ...e.first_comment_pending, attempts } }] }));
          return { status: 1, stdout: JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "503", attempts, max_attempts: 4, exhausted: attempts >= 4, uncertain: false }), stderr: "" };
        },
        notify: { ghRun, sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true },
      });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, runDeps()), 0);
      assert.deepEqual(scripts[0], ["scripts/retry-instagram-first-comment.ts", AAMMDD, "--edition-dir", dir]);
      assert.equal(issues.length, 1);
      assert.match(issues[0].title, /first-comment/);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, runDeps()), 0);
      assert.equal(issues.length, 1, "a 2ª falha do mesmo motivo não repete o alarme");
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, runDeps()), 0);
      assert.equal(issues.length, 2);
      assert.match(issues[1].title, /first-comment-stuck/);
      // Esgotado: o timer nem roda o script, e o stuck não repete.
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, runDeps()), 0);
      assert.equal(scripts.length, 3);
      assert.equal(issues.length, 2);
      assert.ok(readFileSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE), "utf8").includes("first-comment-stuck"));
      assert.equal(readShortsRegistryRaws(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
