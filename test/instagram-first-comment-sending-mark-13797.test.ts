/**
 * test/instagram-first-comment-sending-mark-13797.test.ts (#13797)
 *
 * A gravação da marca `sending` antes do POST (#13791) é um ponto de falha
 * (lock ocupado, EBUSY do Drive, mídia trocada). Antes, a exceção subia ao
 * catch de `main` e virava `{action:"invalid"}`, que o timer traduz em
 * `first-comment-stuck` ("comente à mão") com a pendência ainda retentável:
 * o editor comentava à mão e a hora seguinte publicava um 2º comentário igual.
 * Agora a saída é `failed` não esgotada, que o timer lê como `first-comment`
 * (o timer retenta sozinho), e nada é postado nem gravado.
 *
 * P3 do mesmo ciclo: `clipsHaveSpokenCta` não via o `fecho` com CTA quando o
 * clipe de `comentario` se fundia ao `fecho` seguinte (corte contíguo).
 *
 * Sem rede: Graph falso, registro em diretório temporário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryInstagramFirstComment, main, type RetryFirstCommentDeps } from "../scripts/retry-instagram-first-comment.ts";
import { interpretFirstCommentRetryOutput } from "../scripts/shorts-instagram-timer.ts";
import { firstCommentRetryState } from "../scripts/lib/diaria/instagram-first-comment-retry.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, updateShortEntry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { clipsHaveSpokenCta } from "../scripts/lib/diaria/video-sequence-fecho.ts";
import { assembleClips, CTA_BLOCKS } from "../scripts/lib/diaria/video-montage.ts";

const AAMMDD = "261027";
const NOW = new Date("2026-10-27T16:00:00.000Z");
const MSG = "Vídeo completo: https://diar.ia.br/video/261027";

const pending = (attempts: number) => ({ message: MSG, error: "503", attempts, last_attempt_at: "2026-10-27T15:00:00.000Z" });
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
  const dir = mkdtempSync(join(tmpdir(), "ig-first-comment-13797-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries }, null, 2));
  return dir;
}
const readIg = (dir: string): ShortPublishedEntry =>
  (JSON.parse(readFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), "utf8")).entries as ShortPublishedEntry[]).find((e) => e.destination === "instagram")!;

/** `updateShortEntry` que lança sempre (EBUSY do Drive), contando as chamadas. */
function alwaysFailing(err = "EBUSY: resource busy or locked"): { fn: typeof updateShortEntry; calls: () => number } {
  let n = 0;
  return {
    fn: (() => {
      n++;
      throw new Error(err);
    }) as typeof updateShortEntry,
    calls: () => n,
  };
}

function deps(updateEntry: typeof updateShortEntry, author: Awaited<ReturnType<RetryFirstCommentDeps["resolveAuthor"]>> = { token: "tok", apiVersion: "v25.0" }) {
  const posted: string[] = [];
  const d: RetryFirstCommentDeps = {
    now: () => NOW,
    resolveAuthor: async () => author,
    postComment: async (mediaId) => {
      posted.push(mediaId);
      return { ok: true, id: "cm-dup" };
    },
    updateEntry,
  };
  return { d, posted };
}

describe("#13797 marca de envio que não grava: tenta na próxima, nunca stuck", () => {
  it("updateEntry lançando na 1ª chamada: zero POST, saída failed não esgotada, alarme first-comment (não stuck)", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const fail = alwaysFailing();
      const { d, posted } = deps(fail.fn);
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(fail.calls(), 1);
      assert.equal(r.action, "failed");
      if (r.action !== "failed") return;
      assert.equal(r.exhausted, false);
      assert.equal(r.uncertain, false);
      assert.equal(r.attempts, 1, "nada gravado: a tentativa não soma");
      assert.match(r.error, /marca de envio não gravou.*EBUSY.*nada foi postado/);
      // O registro não mudou e segue retentável.
      assert.deepEqual(readIg(dir).first_comment_pending, pending(1));
      assert.equal(firstCommentRetryState(readIg(dir)).kind, "retry");
      // O timer lê como "tenta de novo", não como "comente à mão".
      const out = interpretFirstCommentRetryOutput(1, JSON.stringify(r));
      assert.equal(out.kind === "alarm" && out.key, "first-comment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main: a mesma falha sai como JSON failed (exit 1), não como invalid", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(2) })]);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      const { d, posted } = deps(alwaysFailing().fn);
      const code = await main([AAMMDD, "--edition-dir", dir], d);
      assert.equal(code, 1);
      assert.equal(posted.length, 0);
      const out = JSON.parse(lines.at(-1)!);
      assert.equal(out.action, "failed");
      assert.equal(out.exhausted, false);
      const outcome = interpretFirstCommentRetryOutput(code, lines.at(-1)!);
      assert.equal(outcome.kind === "alarm" && outcome.key, "first-comment");
    } finally {
      console.log = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mídia trocada no meio (sameMedia lança na marca): zero POST e failed não esgotada", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      // Troca a mídia da entrada entre a leitura e a marca: o mutator real recusa.
      const swap = ((...args: Parameters<typeof updateShortEntry>) => {
        writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [igEntry({ id: "m2", first_comment_pending: pending(1) })] }, null, 2));
        return updateShortEntry(...args);
      }) as typeof updateShortEntry;
      const { d, posted } = deps(swap);
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(r.action, "failed");
      assert.match(r.action === "failed" ? r.error : "", /mudou de mídia/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem credencial e registro que não grava: nada postado, failed não esgotada (era exceção → stuck)", async () => {
    const dir = edition([igEntry({ first_comment_pending: pending(1) })]);
    try {
      const { d, posted } = deps(alwaysFailing().fn, { error: "token ausente" });
      const r = await retryInstagramFirstComment(dir, AAMMDD, false, d);
      assert.equal(posted.length, 0);
      assert.equal(r.action, "failed");
      if (r.action !== "failed") return;
      assert.equal(r.exhausted, false);
      assert.equal(r.attempts, 1);
      assert.match(r.error, /sem credencial do Instagram: token ausente.*não gravou/);
      assert.deepEqual(readIg(dir).first_comment_pending, pending(1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#13797 P3: CTA no fecho de um clipe fundido", () => {
  it("comentario contíguo ao fecho com CTA vira um clipe só (parts) e conta como CTA falado", () => {
    const { clips } = assembleClips(
      { scales: [115, 130] },
      [
        { block: "comentario", srcIn: 5, srcOut: 8, script: "Um comentário curto." },
        { block: "fecho", srcIn: 8, srcOut: 12, script: "O vídeo completo tá no YouTube da diar.ia.br." },
      ],
      30,
    );
    assert.equal(clips.length, 1);
    assert.equal(clips[0].block, "comentario");
    assert.deepEqual(clips[0].parts?.map((p) => p.block), ["comentario", "fecho"]);
    assert.equal(clipsHaveSpokenCta(clips, CTA_BLOCKS), true);
  });

  it("fundido com fecho de despedida segue sem CTA; parts sem fecho também", () => {
    assert.equal(clipsHaveSpokenCta([{ block: "comentario", script: "Um comentário. Até amanhã", parts: [{ block: "comentario" }, { block: "fecho" }] }], CTA_BLOCKS), false);
    assert.equal(clipsHaveSpokenCta([{ block: "titulo", script: "No YouTube da diar.ia.br", parts: [{ block: "titulo" }, { block: "comentario" }] }], CTA_BLOCKS), false);
  });
});
