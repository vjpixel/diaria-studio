/**
 * test/instagram-first-comment-13791-13781.test.ts (#13791, #13781)
 *
 * #13791: a retentativa do 1º comentário do Reels (`retry-instagram-first-comment.ts`)
 * postava e só depois gravava o resultado. Se a gravação falhasse (lock ocupado,
 * EBUSY do Drive), a pendência ficava com a tentativa antiga e o timer
 * publicava OUTRO comentário a cada hora, até 4. Agora a marca de envio
 * (`sending` + `uncertain`) vai ao registro antes do POST; se o resultado não
 * gravar, a marca fica e a próxima rodada só alarma. Também: POST do comentário
 * sem resposta HTTP (timeout/abort) deixa o comentário incerto, nunca retentado.
 *
 * #13781: a rota à mão do Reels (`--confirm-instagram`, `--mark`) lembra o
 * editor de comentar o link, e o `--update-published` devolve o comentário a
 * fazer quando a legenda nova promete um que o Reels não tem.
 *
 * Sem rede: Graph e registro falsos ou em diretório temporário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GraphResponseError,
  confirmInstagram,
  firstCommentErrorIsUncertain,
  instagramManualFirstCommentReminder,
  postInstagramReelFirstComment,
  type GraphDeps,
} from "../scripts/publish-shorts.ts";
import {
  INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS,
  applyFirstCommentAttempt,
  firstCommentRetryState,
  markFirstCommentSending,
} from "../scripts/lib/diaria/instagram-first-comment-retry.ts";
import { retryInstagramFirstComment, type RetryFirstCommentDeps } from "../scripts/retry-instagram-first-comment.ts";
import { decideInstagramTimerRun, firstCommentStuckDetail, interpretFirstCommentRetryOutput } from "../scripts/shorts-instagram-timer.ts";
import { SHORTS_PUBLISHED_FILE, type ShortPublishedEntry, type ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import { SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, readShortsRegistryRaws, updateShortEntry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { planPublishedTextUpdates } from "../scripts/lib/diaria/short-published-update.ts";
import { ROTEIRO_FALAS_FILE } from "../scripts/lib/diaria/roteiro-videos.ts";
import { YOUTUBE_PUBLISHED_FILE } from "../scripts/lib/diaria/youtube-upload.ts";

const AAMMDD = "261027";
const NOW = new Date("2026-10-27T16:00:00.000Z");
const MSG = "Vídeo completo: https://diar.ia.br/video/261027";
const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const CFG = { publishing: { shorts: { facebook_pages: [], instagram: true, instagram_collaborators: [], linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE } } };

function igEntry(over: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry {
  return { destination: "instagram", status: "published", id: "m1", url: "https://instagram.com/reel/m1", scheduled_at: null, at: "2026-10-27T15:00:00.000Z", ...over };
}

const pending = (attempts: number, extra: object = {}) => ({ message: MSG, error: "503", attempts, last_attempt_at: "2026-10-27T15:00:00.000Z", ...extra });

function edition(entries: ShortPublishedEntry[], file = SHORTS_INSTAGRAM_TIMER_LEDGER_FILE): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-first-comment-13791-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo.\n");
  writeFileSync(join(dir, file), JSON.stringify({ aammdd: AAMMDD, entries }, null, 2));
  return dir;
}

function readIg(dir: string, file = SHORTS_INSTAGRAM_TIMER_LEDGER_FILE): ShortPublishedEntry {
  return (JSON.parse(readFileSync(join(dir, file), "utf8")).entries as ShortPublishedEntry[]).find((e) => e.destination === "instagram")!;
}

function retryDeps(post: RetryFirstCommentDeps["postComment"], updateEntry?: RetryFirstCommentDeps["updateEntry"]) {
  const posted: string[] = [];
  const d: RetryFirstCommentDeps = {
    now: () => NOW,
    resolveAuthor: async () => ({ token: "tok", apiVersion: "v25.0" }),
    postComment: async (mediaId, token, apiVersion, message) => {
      posted.push(`${mediaId}|${message}`);
      return post(mediaId, token, apiVersion, message);
    },
    ...(updateEntry ? { updateEntry } : {}),
  };
  return { d, posted };
}

/** `updateShortEntry` de verdade, mas lança a partir da chamada `failFrom` (1 = a 1ª). */
function failingUpdate(failFrom: number): RetryFirstCommentDeps["updateEntry"] {
  let calls = 0;
  return ((...args: Parameters<typeof updateShortEntry>) => {
    calls++;
    if (calls >= failFrom) throw new Error("EBUSY: resource busy or locked (Drive sincronizando)");
    return updateShortEntry(...args);
  }) as typeof updateShortEntry;
}

describe("#13791 marca de envio antes do POST", () => {
  it("POST ok + gravação do resultado lançando: saída uncertain, registro incerto, e a hora seguinte não comenta de novo", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = retryDeps(async () => ({ ok: true, id: "cm2" }), failingUpdate(2));
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(r.action, "uncertain");
      assert.match(r.action === "uncertain" ? r.error : "", /SAIU \(id cm2\).*registro não gravou/);
      assert.equal(posted.length, 1);
      const e = readIg(dir);
      assert.equal(e.first_comment_pending?.sending, true);
      assert.equal(e.first_comment_pending?.uncertain, true);
      assert.equal(e.first_comment_pending?.attempts, 2);
      assert.equal(firstCommentRetryState(e).kind, "uncertain");

      // A rodada seguinte do timer: decide só o alarme, e o script não posta.
      const decision = decideInstagramTimerRun({ config: CFG, reviewedExists: true, registryRaws: readShortsRegistryRaws(dir), aammdd: AAMMDD, now: NOW, videoSeen: true });
      assert.equal(decision.kind === "first-comment" && decision.state.kind, "uncertain");
      const again = retryDeps(async () => ({ ok: true, id: "cm3" }));
      const r2 = await retryInstagramFirstComment(dir, AAMMDD, false, again.d);
      assert.equal(r2.action, "uncertain");
      assert.equal(again.posted.length, 0);
      // No máximo 1 comentário no total.
      assert.equal(posted.length + again.posted.length, 1);
      const out = interpretFirstCommentRetryOutput(1, JSON.stringify(r));
      assert.equal(out.kind === "alarm" && out.key, "first-comment-stuck");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marca que não grava: nada é postado e a pendência fica como estava", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = retryDeps(async () => ({ ok: true, id: "cm2" }), failingUpdate(1));
      // #13797: sai `failed` não esgotada (o timer retenta), nunca exceção → `invalid` → stuck.
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(r.action, "failed");
      assert.match(r.action === "failed" ? r.error : "", /EBUSY/);
      assert.equal(posted.length, 0);
      assert.deepEqual(readIg(dir).first_comment_pending, pending(1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha normal depois da marca: soma UMA tentativa, tira a marca e segue retentável", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })], SHORTS_PUBLISHED_FILE);
    try {
      const { d } = retryDeps(async () => ({ ok: false, error: "500 de novo" }));
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(r.action, "failed");
      const p = readIg(dir, SHORTS_PUBLISHED_FILE).first_comment_pending;
      assert.equal(p?.attempts, 2);
      assert.equal(p?.error, "500 de novo");
      assert.equal(p?.sending, undefined);
      assert.equal(p?.uncertain, undefined);
      assert.equal(firstCommentRetryState(readIg(dir, SHORTS_PUBLISHED_FILE)).kind, "retry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sucesso depois da marca: first_comment_id e nenhuma pendência", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS - 1) })]);
    try {
      const { d } = retryDeps(async () => ({ ok: true, id: "cm9" }));
      assert.equal((await retryInstagramFirstComment(dir, AAMMDD, false, d)).action, "commented");
      const e = readIg(dir);
      assert.equal(e.first_comment_id, "cm9");
      assert.equal(e.first_comment_pending, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("puro: a marca soma a tentativa e é incerta; marcar de novo recusa; o resultado sem id mantém incerto", () => {
    const marked = markFirstCommentSending(igEntry({ first_comment_pending: pending(1) }), NOW);
    assert.equal(marked.first_comment_pending?.attempts, 2);
    assert.equal(marked.first_comment_pending?.last_attempt_at, NOW.toISOString());
    assert.match(marked.first_comment_pending?.error ?? "", /em envio.*Erro anterior: 503/);
    assert.throws(() => markFirstCommentSending(marked, NOW), /já está incerta/);
    const noId = applyFirstCommentAttempt(marked, { ok: false, error: "resposta sem id", uncertain: true }, NOW);
    assert.equal(noId.first_comment_pending?.attempts, 2);
    assert.equal(noId.first_comment_pending?.uncertain, true);
    assert.equal(noId.first_comment_pending?.sending, undefined);
    // Sem marca, a falha soma como antes (#13759).
    assert.equal(applyFirstCommentAttempt(igEntry({ first_comment_pending: pending(1) }), { ok: false, error: "x" }, NOW).first_comment_pending?.attempts, 2);
    // `sending` sem `uncertain` (registro editado à mão) também não retenta.
    assert.equal(firstCommentRetryState(igEntry({ first_comment_pending: pending(2, { sending: true }) })).kind, "uncertain");
  });

  it("alarme do timer para a marca que ficou nomeia o envio sem resultado, não a resposta sem id", () => {
    const state = firstCommentRetryState(markFirstCommentSending(igEntry({ first_comment_pending: pending(1) }), NOW));
    assert.equal(state.kind, "uncertain");
    if (state.kind !== "uncertain") return;
    assert.match(firstCommentStuckDetail(state), /tentativa sem resultado gravado/);
  });
});

describe("#13791 POST sem resposta HTTP é incerto", () => {
  const graph = (err: unknown): GraphDeps => ({
    fetch: async () => {
      throw err;
    },
    sleep: async () => {},
    now: () => NOW,
    log: () => {},
  });

  it("timeout do AbortSignal: uncertain (nunca retentado)", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const r = await postInstagramReelFirstComment(graph(timeout), "m1", "tok", "v25.0", MSG);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.uncertain, true);
    assert.match(!r.ok ? r.warning : "", /sem retentativa automática/);
  });

  it("classificação: resposta HTTP (4xx/5xx) retenta; DNS/conexão recusada retenta; conexão caída é incerta", () => {
    assert.equal(firstCommentErrorIsUncertain(new GraphResponseError("POST m1/comments: 500 {}", 500, null)), false);
    assert.equal(firstCommentErrorIsUncertain(new GraphResponseError("POST m1/comments: 403 {}", 403, 10)), false);
    assert.equal(firstCommentErrorIsUncertain(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), false);
    assert.equal(firstCommentErrorIsUncertain(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), false);
    assert.equal(firstCommentErrorIsUncertain(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), true);
    assert.equal(firstCommentErrorIsUncertain(new DOMException("aborted", "AbortError")), true);
  });

  it("5xx com resposta segue retentável (comportamento do #13759)", async () => {
    const deps: GraphDeps = {
      fetch: async () => new Response(JSON.stringify({ error: { message: "erro" } }), { status: 503 }),
      sleep: async () => {},
      now: () => NOW,
      log: () => {},
    };
    const r = await postInstagramReelFirstComment(deps, "m1", "tok", "v25.0", MSG);
    assert.equal(!r.ok && r.uncertain, undefined);
  });
});

describe("#13781 rota à mão e --update-published", () => {
  it("lembrete puro: só quando a legenda promete o comentário", () => {
    const r = instagramManualFirstCommentReminder({ aammdd: AAMMDD, ctaVertical: true, noVideo: false });
    assert.match(r ?? "", /link no primeiro comentário/);
    assert.match(r ?? "", /diar\.ia\.br\/video\/261027/);
    assert.equal(instagramManualFirstCommentReminder({ aammdd: AAMMDD, ctaVertical: false, noVideo: false }), null);
    assert.equal(instagramManualFirstCommentReminder({ aammdd: AAMMDD, ctaVertical: true, noVideo: true }), null);
  });

  function withRoteiro(dir: string): void {
    writeFileSync(join(dir, ROTEIRO_FALAS_FILE), JSON.stringify({ falas: [{ id: "f1", bloco: "cta_yt", texto: "Assista o vídeo completo" }], porVideo: { vertical1: { pertenceAoHorizontal: true } } }));
    writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify({ title: "Título do horizontal" }));
  }

  async function confirmByUrl(dir: string): Promise<{ code: number; stdout: string[]; stderr: string[]; persisted: ShortPublishedEntry[] }> {
    const persisted: ShortPublishedEntry[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (m: string) => void stdout.push(String(m));
    console.error = (m: string) => void stderr.push(String(m));
    try {
      const published: ShortsPublishedFile = { aammdd: AAMMDD, entries: [] };
      const code = await confirmInstagram(AAMMDD, dir, (e) => {
        persisted.push(e);
        return { aammdd: AAMMDD, entries: [e] };
      }, published, undefined, undefined, undefined, "https://www.instagram.com/reel/ABC123/");
      return { code, stdout, stderr, persisted };
    } finally {
      console.log = log;
      console.error = err;
    }
  }

  it("--confirm-instagram --url com legenda que promete o comentário: avisa com o texto e não grava pendência", async () => {
    const dir = edition([], SHORTS_PUBLISHED_FILE);
    try {
      withRoteiro(dir);
      const r = await confirmByUrl(dir);
      assert.equal(r.code, 0);
      assert.equal(r.persisted.length, 1);
      assert.equal(r.persisted[0].first_comment_pending, undefined);
      const out = JSON.parse(r.stdout.at(-1)!);
      assert.ok(out.warnings.some((w: string) => /comente: Vídeo completo: https:\/\/diar\.ia\.br\/video\/261027/.test(w)));
      assert.ok(r.stderr.some((l) => /#13781/.test(l)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--confirm-instagram --url sem cta_vertical no roteiro: sem lembrete", async () => {
    const dir = edition([], SHORTS_PUBLISHED_FILE);
    try {
      const r = await confirmByUrl(dir);
      assert.equal(r.code, 0);
      const out = JSON.parse(r.stdout.at(-1)!);
      assert.equal(out.warnings.some((w: string) => /#13781/.test(w)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const d1 = { title: "Título do D1", body: "Corpo." };
  const ig = (entry: ShortPublishedEntry, ctaVertical: boolean) =>
    planPublishedTextUpdates({ entries: [entry], d1, now: NOW, ctaVertical, instagramFirstComment: MSG }).find((i) => i.destination === "instagram")!;

  it("--update-published: Reels sem comentário registrado ganha o comentário a fazer; com comentário, nada", () => {
    const old = ig(igEntry(), true);
    assert.equal(old.action, "ui");
    assert.equal(old.action === "ui" && old.firstComment, MSG);
    assert.match(old.action === "ui" ? old.how : "", /não tem comentário registrado.*comente: Vídeo completo/);

    const withComment = ig(igEntry({ first_comment_id: "cm1" }), true);
    assert.equal(withComment.action === "ui" && withComment.firstComment, undefined);
    assert.doesNotMatch(withComment.action === "ui" ? withComment.how : "", /#13781/);

    const pend = ig(igEntry({ first_comment_pending: pending(1) }), true);
    assert.equal(pend.action === "ui" && pend.firstComment, undefined);
    assert.match(pend.action === "ui" ? pend.how : "", /pendente no registro/);

    const noCta = ig(igEntry(), false);
    assert.equal(noCta.action === "ui" && noCta.firstComment, undefined);
    assert.doesNotMatch(noCta.action === "ui" ? noCta.how : "", /comentário/);
  });

  it("--update-published sem link por edição: pede o comentário antes da troca, sem texto inventado", () => {
    const r = planPublishedTextUpdates({ entries: [igEntry()], d1, now: NOW, ctaVertical: true, instagramFirstComment: null }).find((i) => i.destination === "instagram")!;
    assert.equal(r.action === "ui" && r.firstComment, undefined);
    assert.match(r.action === "ui" ? r.how : "", /troque a legenda só depois de comentar/);
  });
});
