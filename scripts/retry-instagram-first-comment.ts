/**
 * retry-instagram-first-comment.ts (#13759) — retenta o 1º comentário do
 * Reels do vertical (o link por edição, #13709) quando a entrada `instagram`
 * do registro tem `first_comment_pending`.
 *
 * Quem chama é o timer do Instagram no 300 (`scripts/shorts-instagram-timer.ts`),
 * uma vez por execução enquanto a pendência vale; também roda à mão:
 *
 *   npx tsx scripts/retry-instagram-first-comment.ts AAMMDD [--edition-dir DIR] [--dry-run]
 *
 * Saída: uma linha JSON no stdout com `action`:
 *   - `none`: nada pendente (exit 0);
 *   - `commented`: o comentário saiu e o registro ganhou `first_comment_id` (exit 0);
 *   - `failed`: a tentativa falhou e foi somada ao registro (exit 1);
 *   - `exhausted` / `uncertain` / `invalid`: não tenta; só o editor resolve (exit 1);
 *   - `dry-run`: o que faria (exit 0).
 *
 * Efeito público: posta UM comentário no Reels da edição. Lê e grava só a
 * entrada `instagram` do arquivo do registro que a contém (principal ou o do
 * timer), sob o lock do `updateShortEntry`.
 *
 * #13791: antes do POST grava a marca de envio (`sending` + `uncertain`, a
 * tentativa já somada); sem ela gravada, não comenta. Se o registro não gravar
 * o resultado depois do POST, a marca fica, a saída é `uncertain` e a rodada
 * seguinte do timer só alarma, nunca comenta de novo.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { loadResolvedFacebookPages } from "./lib/facebook-pages.ts";
import { loadShortsConfig, parseShortsPublishedFile, SHORTS_PUBLISHED_FILE, type ShortPublishedEntry } from "./lib/diaria/short-video.ts";
import {
  readShortsRegistryRaws,
  SHORTS_INSTAGRAM_TIMER_LEDGER_FILE,
  updateShortEntry,
  type ShortsRegistryWriter,
} from "./lib/diaria/shorts-published-store.ts";
import {
  applyFirstCommentAttempt,
  firstCommentRetryState,
  markFirstCommentSending,
  INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS,
  type FirstCommentAttempt,
} from "./lib/diaria/instagram-first-comment-retry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resultado (a linha JSON do stdout). */
export type RetryFirstCommentResult =
  | { action: "none"; reason: string }
  | { action: "dry-run"; media_id: string; message: string; attempts: number }
  | { action: "commented"; media_id: string; comment_id: string; attempts: number }
  | { action: "failed"; media_id: string; message: string; error: string; attempts: number; max_attempts: number; exhausted: boolean; uncertain: boolean }
  | { action: "exhausted" | "uncertain"; media_id: string; message: string; error: string; attempts: number; max_attempts: number }
  | { action: "invalid"; reason: string };

export interface RetryFirstCommentDeps {
  now: () => Date;
  /** Conta autora + token; `null` com o motivo quando não há credencial. */
  resolveAuthor: () => Promise<{ token: string; apiVersion: string } | { error: string }>;
  postComment: (mediaId: string, token: string, apiVersion: string, message: string) => Promise<FirstCommentAttempt>;
  /** Gravação da entrada sob o lock do registro; o default é `updateShortEntry` (o teste injeta a falha, #13791). */
  updateEntry?: typeof updateShortEntry;
}

/** Só os dois arquivos com escritor conhecido; cópia de conflito do sync não é gravada aqui. */
function writerOf(path: string): ShortsRegistryWriter | null {
  const name = basename(path);
  if (name === basename(SHORTS_PUBLISHED_FILE)) return "main";
  if (name === basename(SHORTS_INSTAGRAM_TIMER_LEDGER_FILE)) return "instagram-timer";
  return null;
}

/**
 * Pure-ish (I/O só do registro e dos deps): uma rodada da retentativa. Entre
 * as entradas `instagram` dos arquivos do registro, a com pendência decide;
 * sem pendência em nenhuma, ou com `first_comment_id` em alguma, nada a fazer.
 */
export async function retryInstagramFirstComment(dir: string, aammdd: string, dryRun: boolean, deps: RetryFirstCommentDeps): Promise<RetryFirstCommentResult> {
  const found: Array<{ path: string; entry: ShortPublishedEntry }> = [];
  for (const { path, raw } of readShortsRegistryRaws(dir)) {
    const entry = parseShortsPublishedFile(raw, aammdd, path).entries.find((e) => e.destination === "instagram");
    if (entry) found.push({ path, entry });
  }
  if (found.some((f) => f.entry.first_comment_id)) return { action: "none", reason: "o 1º comentário já está registrado" };
  const pendingHit = found.find((f) => f.entry.first_comment_pending !== undefined);
  if (!pendingHit) return { action: "none", reason: found.length ? "instagram sem 1º comentário pendente" : "instagram não registrado" };
  const state = firstCommentRetryState(pendingHit.entry);
  if (state.kind === "none") return { action: "none", reason: "instagram sem 1º comentário pendente" };
  if (state.kind === "invalid") return { action: "invalid", reason: state.reason };
  if (state.kind === "exhausted" || state.kind === "uncertain") {
    return { action: state.kind, media_id: state.mediaId, message: state.pending.message, error: state.pending.error, attempts: state.pending.attempts, max_attempts: INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS };
  }
  const writer = writerOf(pendingHit.path);
  if (!writer) return { action: "invalid", reason: `a pendência está em ${basename(pendingHit.path)}, que não é o registro principal nem o do timer (cópia de conflito?): una o registro antes` };
  if (dryRun) return { action: "dry-run", media_id: state.mediaId, message: state.pending.message, attempts: state.pending.attempts };

  const update = deps.updateEntry ?? updateShortEntry;
  const sameMedia = (entry: ShortPublishedEntry): void => {
    if (entry.id !== state.mediaId) throw new Error(`a entrada instagram de ${basename(pendingHit.path)} mudou de mídia (${state.mediaId} → ${entry.id}) no meio da retentativa`);
  };
  const author = await deps.resolveAuthor();
  let attempt: FirstCommentAttempt;
  if ("error" in author) {
    attempt = { ok: false, error: `sem credencial do Instagram: ${author.error}` };
  } else {
    // #13791: a marca vai ao registro ANTES do POST; se não gravar, lança e nada é postado.
    update(dir, aammdd, writer, "instagram", (entry) => {
      sameMedia(entry);
      return markFirstCommentSending(entry, deps.now());
    });
    attempt = await deps.postComment(state.mediaId, author.token, author.apiVersion, state.pending.message);
  }
  let updated: ShortPublishedEntry;
  try {
    updated = update(dir, aammdd, writer, "instagram", (entry) => {
      sameMedia(entry);
      return applyFirstCommentAttempt(entry, attempt, deps.now());
    });
  } catch (e) {
    if ("error" in author) throw e; // nada postado: a pendência segue como estava
    // #13791: o POST rodou e o resultado não gravou; a marca de envio fica e a próxima rodada só alarma.
    const what = attempt.ok ? `o comentário SAIU (id ${attempt.id})` : `a tentativa falhou (${attempt.error})`;
    return {
      action: "uncertain",
      media_id: state.mediaId,
      message: state.pending.message,
      error: `${what}, mas o registro não gravou o resultado (${(e as Error).message}): fica a marca de envio, sem retentativa automática; confira os comentários do post antes de comentar à mão (#13791)`,
      attempts: state.pending.attempts + 1,
      max_attempts: INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS,
    };
  }
  if (attempt.ok) return { action: "commented", media_id: state.mediaId, comment_id: attempt.id, attempts: state.pending.attempts + 1 };
  const attempts = updated.first_comment_pending?.attempts ?? state.pending.attempts + 1;
  return {
    action: "failed",
    media_id: state.mediaId,
    message: state.pending.message,
    error: attempt.error,
    attempts,
    max_attempts: INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS,
    exhausted: attempts >= INSTAGRAM_FIRST_COMMENT_MAX_ATTEMPTS,
    uncertain: attempt.uncertain === true,
  };
}

async function defaultDeps(): Promise<RetryFirstCommentDeps> {
  // Import tardio: o publish-shorts carrega o .env e a Graph; o teste injeta os deps.
  const ps = await import("./publish-shorts.ts");
  return {
    now: () => new Date(),
    resolveAuthor: async () => {
      const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
      const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
      const igApiVersion = process.env.INSTAGRAM_API_VERSION || apiVersion;
      const cfg = loadShortsConfig(config);
      const author = await ps.resolveInstagramAuthor(ps.defaultGraphDeps, cfg.instagramAuthorPage, pages, igApiVersion, {
        igUserId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "",
        token: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
      });
      return author.ready ? { token: author.token, apiVersion: igApiVersion } : { error: author.reason };
    },
    postComment: async (mediaId, token, apiVersion, message) => {
      const r = await ps.postInstagramReelFirstComment(ps.defaultGraphDeps, mediaId, token, apiVersion, message);
      return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error, ...(r.uncertain ? { uncertain: true } : {}) };
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2), depsIn?: RetryFirstCommentDeps): Promise<number> {
  const { values, flags, positional } = parseArgs(argv);
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: retry-instagram-first-comment.ts AAMMDD [--edition-dir DIR] [--dry-run]");
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? join(ROOT, editionDirFor(aammdd)));
  const deps = depsIn ?? (await defaultDeps());
  let result: RetryFirstCommentResult;
  try {
    result = await retryInstagramFirstComment(dir, aammdd, flags.has("dry-run"), deps);
  } catch (e) {
    result = { action: "invalid", reason: (e as Error).message };
  }
  console.log(JSON.stringify(result));
  return result.action === "none" || result.action === "commented" || result.action === "dry-run" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("retry-instagram-first-comment:", e instanceof Error ? e.message : e) });
}
