/**
 * test/shorts-timers-first-comment-repost-13803-13799-13807.test.ts
 *
 * #13803: o alarme `first-comment-stuck` manda o editor comentar à mão, e saía
 * também com a pendência ainda retentável (filho sem JSON, exceção do
 * `resolveAuthor`, pendência numa cópia de conflito). O timer não lia o estado
 * do alarme antes de retentar: o editor comentava e a hora seguinte postava um
 * 2º comentário. Agora (a) falha de infraestrutura é `first-comment`
 * retentável e (b) depois do `first-comment-stuck` o timer não retenta mais.
 *
 * #13799: (1) marca de envio que nunca grava não soma `attempts`, e o stuck
 * nunca saía; agora o timer conta as execuções seguidas sem gravação e escala.
 * (2) recusa de domínio da marca (pendência já incerta) não é falha de I/O.
 *
 * #13807: o `repost-failed` do repost da página já entregue suprime o
 * `unregistered` do mesmo repost 3 h depois (era um 2º e-mail).
 *
 * Sem rede: Graph, `gh` e e-mail falsos; registro em diretório temporário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as retryMain, retryInstagramFirstComment, type RetryFirstCommentDeps } from "../scripts/retry-instagram-first-comment.ts";
import {
  INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER,
  INSTAGRAM_FIRST_COMMENT_UNRECORDED_FILE,
  INSTAGRAM_TIMER_ALARM_STATE_FILE,
  buildInstagramTimerAlarm,
  escalateUnrecordedFirstComment,
  firstCommentStuckAlreadyRaised,
  interpretFirstCommentRetryOutput,
  parseFirstCommentUnrecordedCount,
  runInstagramTimer,
  type InstagramTimerRunDeps,
} from "../scripts/shorts-instagram-timer.ts";
import { firstCommentRetryState } from "../scripts/lib/diaria/instagram-first-comment-retry.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, updateShortEntry } from "../scripts/lib/diaria/shorts-published-store.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import {
  CORTE_TIMER_ALARM_STATE_FILE,
  CORTE_TIMER_REPOST_DESTINATION,
  corteAlarmId,
  corteRepostFailedDelivered,
  decideCorteTimerRun,
  runCorteTimerFor,
  type CorteTimerAlarmKey,
} from "../scripts/shorts-corte-timer.ts";
import { CORTE_SPEC_FILE, parseCorteSpec, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../scripts/lib/diaria/corte-content.ts";
import { prepareCorteRun, recordCortePublishAuthorization } from "../scripts/publish-shorts/corte.ts";

const AAMMDD = "261027";
const NOW = new Date("2026-10-27T16:00:00.000Z");
const MSG = "Vídeo completo: https://diar.ia.br/video/261027";
const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const CFG = { publishing: { shorts: { facebook_pages: [], instagram: true, instagram_collaborators: [], linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE } } };

const pending = (attempts: number, extra: object = {}) => ({ message: MSG, error: "503", attempts, last_attempt_at: "2026-10-27T15:00:00.000Z", ...extra });
const igEntry = (over: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry => ({
  destination: "instagram",
  status: "published",
  id: "m1",
  url: "https://instagram.com/reel/m1",
  scheduled_at: null,
  at: "2026-10-27T15:00:00.000Z",
  ...over,
});

function edition(entries: ShortPublishedEntry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-13803-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título](https://a.com/x)\n\nCorpo.\n");
  writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries }, null, 2));
  return dir;
}
const readIg = (dir: string): ShortPublishedEntry =>
  (JSON.parse(readFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), "utf8")).entries as ShortPublishedEntry[]).find((e) => e.destination === "instagram")!;

function retryDeps(over: Partial<RetryFirstCommentDeps> = {}) {
  const posted: string[] = [];
  const d: RetryFirstCommentDeps = {
    now: () => NOW,
    resolveAuthor: async () => ({ token: "tok", apiVersion: "v25.0" }),
    postComment: async (mediaId) => {
      posted.push(mediaId);
      return { ok: true, id: "cm-x" };
    },
    ...over,
  };
  return { d, posted };
}

/** `gh` falso que guarda as issues abertas (o alarme reaproveita pelo título). */
function fakeGh() {
  const issues: { title: string }[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues.map((x, i) => ({ number: 900 + i, url: `u${i}`, title: x.title, body: "", state: "OPEN" }))), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      issues.push({ title: args[args.indexOf("--title") + 1] ?? "" });
      return { status: 0, stdout: `https://github.com/vjpixel/diaria-studio/issues/${900 + issues.length}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { issues, notify: { ghRun, sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true } };
}

function timerDeps(notify: InstagramTimerRunDeps["notify"], runScript: InstagramTimerRunDeps["runScript"]): InstagramTimerRunDeps {
  return {
    config: CFG,
    now: NOW,
    lookupInstagramCut: () => {
      throw new Error("o timer não deve consultar o Drive com o Reels já registrado");
    },
    lookupGenericVertical: () => {
      throw new Error("idem");
    },
    runScript,
    notify,
  };
}

describe("#13803 falha de infraestrutura da retentativa: retentável, nunca 'comente à mão'", () => {
  it("filho sem JSON e action error viram first-comment (unrecorded); invalid segue stuck", () => {
    const noJson = interpretFirstCommentRetryOutput(1, "Error: Cannot find module", "stack");
    assert.ok(noJson.kind === "alarm" && noJson.key === "first-comment" && noJson.unrecorded === true);
    const err = interpretFirstCommentRetryOutput(1, JSON.stringify({ action: "error", reason: "ENOTFOUND graph.facebook.com" }));
    assert.ok(err.kind === "alarm" && err.key === "first-comment" && err.unrecorded === true);
    assert.match(err.detail, /ENOTFOUND/);
    const inv = interpretFirstCommentRetryOutput(1, JSON.stringify({ action: "invalid", reason: "cópia de conflito" }));
    assert.equal(inv.kind === "alarm" && inv.key, "first-comment-stuck");
    // failed comum (a tentativa somou no registro) não é unrecorded.
    const f = interpretFirstCommentRetryOutput(1, JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "503", attempts: 2, max_attempts: 4, exhausted: false, uncertain: false }));
    assert.ok(f.kind === "alarm" && f.key === "first-comment" && f.unrecorded === undefined);
  });

  it("resolveAuthor lançando: a tentativa grava e soma como 'sem credencial' (era exceção → invalid → stuck)", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = retryDeps({
        resolveAuthor: async () => {
          throw new Error("ECONNRESET na Graph");
        },
      });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(r.action, "failed");
      if (r.action !== "failed") return;
      assert.equal(r.attempts, 2);
      assert.equal(r.not_recorded, undefined);
      assert.match(r.error, /falha ao resolver a conta autora.*ECONNRESET/);
      assert.equal(readIg(dir).first_comment_pending?.attempts, 2);
      const out = interpretFirstCommentRetryOutput(1, JSON.stringify(r));
      assert.equal(out.kind === "alarm" && out.key, "first-comment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main: exceção depois da marca (POST lançou) sai action error, e a marca deixa a pendência incerta", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      const { d } = retryDeps({
        postComment: async () => {
          throw new Error("socket hang up");
        },
      });
      const code = await retryMain([AAMMDD, "--edition-dir", dir], d);
      assert.equal(code, 1);
      const out = JSON.parse(lines.at(-1)!);
      assert.equal(out.action, "error");
      assert.match(out.reason, /socket hang up/);
      // O POST pode ter rodado: a marca ficou e a próxima execução só alarma, nunca comenta.
      assert.equal(firstCommentRetryState(readIg(dir)).kind, "uncertain");
    } finally {
      console.log = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cenário da issue: stuck entregue, o editor comenta à mão, e a hora seguinte NÃO roda a retentativa", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { issues, notify } = fakeGh();
      const scripts: string[][] = [];
      // 10h: a pendência está numa cópia de conflito (invalid) → stuck ("comente à mão").
      const first = timerDeps(notify, (args) => {
        scripts.push(args);
        return { status: 1, stdout: JSON.stringify({ action: "invalid", reason: "a pendência está em uma cópia de conflito" }), stderr: "" };
      });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, first), 0);
      assert.equal(issues.length, 1);
      assert.match(issues[0].title, /first-comment-stuck/);
      assert.equal(scripts.length, 1);
      // 11h: a retentativa daria certo (postaria o 2º comentário). O timer não pode rodá-la.
      const posts: string[] = [];
      const second = timerDeps(notify, (args) => {
        scripts.push(args);
        posts.push("cm-dup");
        return { status: 0, stdout: JSON.stringify({ action: "commented", media_id: "m1", comment_id: "cm-dup", attempts: 2 }), stderr: "" };
      });
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, second), 0);
      assert.equal(posts.length, 0, "depois do stuck o timer não comenta");
      assert.equal(scripts.length, 1);
      assert.equal(issues.length, 1, "o stuck não repete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stuck com o e-mail pendente também bloqueia a retentativa; o estado sem stuck não bloqueia", () => {
    assert.equal(firstCommentStuckAlreadyRaised(JSON.stringify({ aammdd: AAMMDD, alarmed: [], emailPending: ["first-comment-stuck"] })), true);
    assert.equal(firstCommentStuckAlreadyRaised(JSON.stringify({ aammdd: AAMMDD, alarmed: ["first-comment-stuck"], emailPending: [] })), true);
    assert.equal(firstCommentStuckAlreadyRaised(JSON.stringify({ aammdd: AAMMDD, alarmed: ["first-comment", "collab"], emailPending: [] })), false);
    assert.equal(firstCommentStuckAlreadyRaised(null), false);
  });

  it("os corpos dizem que o timer para depois do stuck e que escala sem gravação", () => {
    const s = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "first-comment-stuck", reason: "x", videoArg: null });
    assert.match(s.body, /o timer não comenta mais nesta edição/);
    const f = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "first-comment", reason: "x", videoArg: null });
    assert.match(f.body, new RegExp(`${INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER} execuções seguidas falharem sem gravar`));
  });
});

describe("#13799 (1) marca de envio que nunca grava: o timer escala", () => {
  const notRecorded = (attempts: number) =>
    JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "a marca de envio não gravou no registro (EBUSY); nada foi postado", attempts, max_attempts: 4, exhausted: false, uncertain: false, not_recorded: true });

  it("escalateUnrecordedFirstComment: abaixo do limite passa igual; no limite vira stuck com o texto do comentário", () => {
    const o = interpretFirstCommentRetryOutput(1, "lixo");
    assert.equal(escalateUnrecordedFirstComment(o, INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER - 1, MSG), o);
    const up = escalateUnrecordedFirstComment(o, INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER, MSG);
    assert.ok(up.kind === "alarm" && up.key === "first-comment-stuck");
    assert.match(up.detail, /vezes seguidas sem gravar/);
    assert.match(up.detail, /Texto: Vídeo completo/);
    // Falha que gravou a tentativa nunca escala por aqui (o MAX_ATTEMPTS cuida dela).
    const recorded = interpretFirstCommentRetryOutput(1, JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "503", attempts: 2, max_attempts: 4, exhausted: false, uncertain: false }));
    assert.equal(escalateUnrecordedFirstComment(recorded, 99, MSG), recorded);
  });

  it("parseFirstCommentUnrecordedCount: outra edição, lixo ou ausente = 0", () => {
    assert.equal(parseFirstCommentUnrecordedCount(JSON.stringify({ aammdd: AAMMDD, count: 2 }), AAMMDD), 2);
    assert.equal(parseFirstCommentUnrecordedCount(JSON.stringify({ aammdd: "261026", count: 2 }), AAMMDD), 0);
    assert.equal(parseFirstCommentUnrecordedCount("{", AAMMDD), 0);
    assert.equal(parseFirstCommentUnrecordedCount(null, AAMMDD), 0);
  });

  it("de ponta a ponta: 1º first-comment, a 3ª execução seguida sem gravar abre o stuck, e a 4ª não roda o script", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { issues, notify } = fakeGh();
      const scripts: string[][] = [];
      const deps = () =>
        timerDeps(notify, (args) => {
          scripts.push(args);
          return { status: 1, stdout: notRecorded(1), stderr: "" };
        });
      for (let i = 1; i < INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER; i++) assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps()), 0);
      assert.equal(issues.length, 1);
      assert.doesNotMatch(issues[0].title, /first-comment-stuck/);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps()), 0);
      assert.equal(issues.length, 2);
      assert.match(issues[1].title, /first-comment-stuck/);
      assert.equal(scripts.length, INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER);
      assert.equal(await runInstagramTimer(AAMMDD, dir, false, deps()), 0);
      assert.equal(scripts.length, INSTAGRAM_FIRST_COMMENT_UNRECORDED_ESCALATE_AFTER, "depois do stuck o timer não retenta");
      assert.ok(readFileSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE), "utf8").includes("first-comment-stuck"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uma execução que grava no meio zera o contador (só as SEGUIDAS escalam)", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { issues, notify } = fakeGh();
      const outs = [notRecorded(1), notRecorded(1), JSON.stringify({ action: "failed", media_id: "m1", message: MSG, error: "503", attempts: 2, max_attempts: 4, exhausted: false, uncertain: false }), notRecorded(2), notRecorded(2)];
      for (const stdout of outs) await runInstagramTimer(AAMMDD, dir, false, timerDeps(notify, () => ({ status: 1, stdout, stderr: "" })));
      assert.ok(!issues.some((x) => /first-comment-stuck/.test(x.title)));
      assert.equal(parseFirstCommentUnrecordedCount(readFileSync(join(dir, INSTAGRAM_FIRST_COMMENT_UNRECORDED_FILE), "utf8"), AAMMDD), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13799 (2) recusa de domínio da marca não é falha de gravação", () => {
  /** Grava a pendência como `stateOver` entre a leitura e o `update` (CLI à mão sem o lock do timer). */
  const racing = (dir: string, over: object) =>
    ((...args: Parameters<typeof updateShortEntry>) => {
      writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [igEntry({ first_comment_pending: pending(2, over) })] }, null, 2));
      return updateShortEntry(...args);
    }) as typeof updateShortEntry;

  it("outra execução gravou a marca de envio: saída uncertain (stuck), zero POST, nada de 'o timer retenta'", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = retryDeps({ updateEntry: racing(dir, { sending: true, uncertain: true }) });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(r.action, "uncertain");
      assert.match(r.action === "uncertain" ? r.error : "", /registro mudou durante a retentativa/);
      const out = interpretFirstCommentRetryOutput(1, JSON.stringify(r));
      assert.equal(out.kind === "alarm" && out.key, "first-comment-stuck");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outra execução esgotou as tentativas: saída exhausted, zero POST (era a 5ª tentativa)", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const updateEntry = ((...args: Parameters<typeof updateShortEntry>) => {
        writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [igEntry({ first_comment_pending: pending(4) })] }, null, 2));
        return updateShortEntry(...args);
      }) as typeof updateShortEntry;
      const { d, posted } = retryDeps({ updateEntry });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(r.action, "exhausted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("outra execução já comentou: none, zero POST", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const updateEntry = ((...args: Parameters<typeof updateShortEntry>) => {
        writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [igEntry({ first_comment_id: "cm1" })] }, null, 2));
        return updateShortEntry(...args);
      }) as typeof updateShortEntry;
      const { d, posted } = retryDeps({ updateEntry });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(r.action, "none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha de I/O (EBUSY) segue failed not_recorded, retentável", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = retryDeps({
        updateEntry: (() => {
          throw new Error("EBUSY");
        }) as typeof updateShortEntry,
      });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.ok(r.action === "failed" && r.not_recorded === true && !r.exhausted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #13807: repost-failed entregue suprime o unregistered do repost ──────────
const REPOST = CORTE_TIMER_REPOST_DESTINATION;
const shorts = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: true,
  linkedin_page_repost: true,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  instagram_api_max_seconds_by_account: { diaria: null },
  corte_via_timer: true,
  schedule: SCHEDULE,
};
const CORTE_CONFIG = { publishing: { shorts } };
const BASE: CorteSpec = { slug: "guia-261116", date: "261122", hhmm: "12:00", title: "Novo Gemini", hook: "A IA do Google mudou.", video: "corte-guia-261116.mp4" };
const AT = "2026-11-22T15:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const ALL = ["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", REPOST, "threads_profile"];
const authorized: CorteSpec = { ...BASE, publish_confirmed_at: "2026-11-19T15:10:51.638Z", publish_confirmed_destinations: ALL, publish_confirmed_content: { video_sha256: "a".repeat(64), cover_sha256: null } };
const registry = (...dests: string[]) => [
  { path: "/c/_internal/06-shorts-published.json", raw: JSON.stringify({ aammdd: BASE.date, entries: dests.map((d) => ({ destination: d, status: "scheduled", id: `id-${d}`, at: AT, scheduled_at: AT })) }) },
];
const REPOST_FAILED_ID = corteAlarmId(REPOST, "repost-failed", `${BASE.date}-${BASE.hhmm}`);
const stateWith = (alarmed: string[], emailPending: string[] = []) => JSON.stringify({ aammdd: BASE.date, alarmed, emailPending });

describe("#13807 decideCorteTimerRun: sem unregistered do repost depois do repost-failed", () => {
  const raws = registry("instagram", "linkedin_profile", "threads_profile", "facebook:diaria");
  const unregisteredOf = (stateRaw: string | null) => {
    const d = decideCorteTimerRun({ config: CORTE_CONFIG, spec: authorized, registryRaws: raws, alarmStateRaw: stateRaw, now: at(4 * 3_600_000) });
    return ("alarms" in d ? (d.alarms ?? []) : []).filter((a) => a.key === "unregistered").map((a) => a.destination).sort();
  };

  it("repost-failed entregue: só o youtube_shorts alarma unregistered", () => {
    assert.deepEqual(unregisteredOf(stateWith([REPOST_FAILED_ID])), ["youtube_shorts"]);
  });

  it("sem estado, ou com o repost-failed só com o e-mail pendente, o unregistered do repost segue (é o aviso que sobra)", () => {
    assert.deepEqual(unregisteredOf(null), [REPOST, "youtube_shorts"].sort());
    assert.deepEqual(unregisteredOf(stateWith([REPOST_FAILED_ID], [REPOST_FAILED_ID])), [REPOST, "youtube_shorts"].sort());
    assert.deepEqual(unregisteredOf(stateWith([], [REPOST_FAILED_ID])), [REPOST, "youtube_shorts"].sort());
  });

  it("repost-failed de OUTRO plano (corte reagendado) não cobre este", () => {
    const old = corteAlarmId(REPOST, "repost-failed", "261121-12:00");
    assert.equal(corteRepostFailedDelivered(stateWith([old]), authorized), false);
    assert.deepEqual(unregisteredOf(stateWith([old])), [REPOST, "youtube_shorts"].sort());
  });
});

describe("#13807 runCorteTimerFor: repost-failed e unregistered em sequência = um alarme do repost", () => {
  type Alarm = { destination: string; key: CorteTimerAlarmKey };
  function corteDir(): string {
    const root = mkdtempSync(join(tmpdir(), "corte-13807-"));
    const dir = join(root, BASE.slug);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, BASE.video), "mp4");
    prepareCorteRun({ slug: BASE.slug, dir, values: { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) }, positionalDate: "", log: () => {} });
    const spec = parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");
    recordCortePublishAuthorization(dir, ALL.join(","), new Set(ALL), corteContentFingerprint(dir, spec), "2026-11-19T15:10:51.638Z", () => {});
    return dir;
  }

  it("a execução do horário alarma repost-failed (gravado no estado); 3 h depois o unregistered do repost não sai", async () => {
    const dir = corteDir();
    try {
      const alarms: Alarm[] = [];
      const statePath = join(dir, CORTE_TIMER_ALARM_STATE_FILE);
      const deps = (now: Date, stdout: string) => ({
        config: CORTE_CONFIG,
        now,
        runScript: () => {
          // Simula o publish-shorts: registra o que saiu (perfil, instagram, threads).
          const reg = join(dir, "_internal", "06-shorts-published.json");
          const entries = ["linkedin_profile", "instagram", "threads_profile", "facebook:diaria", "youtube_shorts"].map((d) => ({ destination: d, status: "published", id: `id-${d}`, at: AT, scheduled_at: null, url: `https://x/${d}` }));
          writeFileSync(reg, JSON.stringify({ aammdd: BASE.date, entries }, null, 2));
          return { status: 0, stdout, stderr: "" };
        },
        notify: { cwd: "/nao-usado" },
        // Alarme falso que grava o estado como o real (entregue).
        alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey, _r: string, variant?: string) => {
          alarms.push({ destination, key });
          const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { alarmed: [], emailPending: [] };
          writeFileSync(statePath, JSON.stringify({ aammdd: BASE.date, alarmed: [...prev.alarmed, corteAlarmId(destination, key, variant)], emailPending: [] }));
          return true;
        },
      });
      const stdout = JSON.stringify({
        results: [{ destination: "linkedin_profile", ok: true, entry: { destination: "linkedin_profile", status: "published", id: "urn:li:share:1", at: AT } }],
        items: [{ destination: REPOST, action: "guided", detail: "repost (fila do Worker: Worker sem o token da página)" }],
      });
      await runCorteTimerFor(dir, false, deps(at(10 * 60_000), stdout));
      assert.ok(alarms.some((a) => a.destination === REPOST && a.key === "repost-failed"));
      const before = alarms.length;
      await runCorteTimerFor(dir, false, deps(at(4 * 3_600_000), stdout));
      assert.deepEqual(alarms.slice(before).filter((a) => a.destination === REPOST), [], "o repost já foi avisado pelo repost-failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
