/**
 * #14327: `--mark-replaced` e `--mark` (registro à mão de destino guiado, da
 * Buffer e da troca agendada), extraídos de `mainUnlocked` (`run.ts`) sem
 * mudar a lógica. Cada um é uma rodada inteira: grava, imprime o JSON e
 * devolve o exit code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAuthorizationStore } from "../lib/diaria/video-publish-authorization.ts";
import { CORTE_SPEC_FILE, parseCorteSpec, type CorteSpec } from "../lib/diaria/short-corte.ts";
import type { ShortPublishedEntry, ShortsPublishedFile } from "../lib/diaria/short-video.ts";
import {
  instagramTimerScopeError,
  linkedinTimerScopeError,
  threadsTimerScopeError,
  readShortsRegistry,
  readShortReplacements,
  recordShortReplacement,
} from "../lib/diaria/shorts-published-store.ts";
import { carryOverCover } from "../lib/diaria/short-cover.ts";
import { ROOT } from "./_shared.ts";
import { parseMarkArg, buildMarkEntry, parseThumbnailOffsetArg } from "./run-checks.ts";
import { type ReplacementStoreArg, bufferDeletedRefusal, bufferReplacementMarkRefusal, applyBufferReplacementMark } from "./buffer.ts";
import { configuredThreadsViaTimer, configuredInstagramBackend } from "./cli.ts";
import { syncCorteAgendamento, syncCorteAgendamentoFailSoft } from "./corte.ts";
import { readInstagramManualFirstCommentReminder } from "./confirm.ts";

/** #12279: `--mark-replaced DEST=ID`, logo depois do delete_post do post antigo na Buffer. */
export function runMarkReplaced(input: { dir: string; aammdd: string; markReplaced: string }): number {
  const { dir, aammdd, markReplaced } = input;
  // #12279: logo depois do delete_post do post antigo na Buffer: o registro deixa de apontá-lo.
  let entries: ShortPublishedEntry[];
  try {
    entries = readShortsRegistry(dir, aammdd).entries;
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  let store: ReplacementStoreArg;
  try {
    store = readAuthorizationStore(dir, aammdd);
  } catch (e) {
    store = (e as Error).message;
  }
  const r = bufferDeletedRefusal({ mark: markReplaced, entries, store });
  if (!r.ok) {
    console.error(`publish-shorts: ${r.error}`);
    return 2;
  }
  try {
    recordShortReplacement(dir, { destination: r.entry.destination, id: r.entry.id, scheduled_at: r.entry.scheduled_at ?? null, replaced_at: new Date().toISOString(), new_video_sha256: null });
  } catch (e) {
    console.error(`publish-shorts: histórico não gravado (${(e as Error).message}): o registro ainda aponta ${r.entry.id}; repita o --mark-replaced (#12279)`);
    return 2;
  }
  console.log(JSON.stringify({ mark_replaced: r.entry.destination, id: r.entry.id, scheduled_at: r.entry.scheduled_at ?? null }));
  return 0;
}

/** `--mark DEST=URL` (e `--replaces`, `--scheduled-at`, `--thumbnail-offset`, `--video-sha256`). */
export function runMark(input: {
  dir: string;
  aammdd: string;
  markArg: string;
  values: Readonly<Record<string, string>>;
  corte: CorteSpec | null;
  linkedinTimer: boolean;
  instagramTimer: boolean;
  threadsTimer: boolean;
  published: ShortsPublishedFile;
  persist: (entry: ShortPublishedEntry) => ShortsPublishedFile;
  cleanup: () => void;
}): number {
  const { dir, aammdd, markArg, values, corte, linkedinTimer, instagramTimer, threadsTimer, persist, cleanup } = input;
  let { published } = input;
  let mark: ReturnType<typeof parseMarkArg>;
  try {
    mark = parseMarkArg(markArg);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const markScopeErr =
    linkedinTimerScopeError({ linkedinTimer, only: null, markDestination: mark.destination }) ??
    instagramTimerScopeError({ instagramTimer, backend: configuredInstagramBackend(), linkedinTimer, only: null, markDestination: mark.destination }) ??
    threadsTimerScopeError({ threadsTimer, viaTimer: configuredThreadsViaTimer(), only: null, markDestination: mark.destination });
  if (markScopeErr) {
    console.error(`publish-shorts: ${markScopeErr}`);
    return 2;
  }
  // #11547: a capa do X só entra no registro com o offset que a skill DE FATO passou à Buffer.
  const offset = parseThumbnailOffsetArg(values["thumbnail-offset"], Boolean(mark.bufferId));
  if (!offset.ok) {
    console.error(offset.error);
    return 2;
  }
  const built = buildMarkEntry(mark, values["scheduled-at"], new Date().toISOString(), offset.value);
  if (!built.ok) {
    console.error(built.error);
    return 2;
  }
  const videoSha = values["video-sha256"];
  if (videoSha !== undefined && !/^[a-f0-9]{64}$/.test(videoSha)) {
    console.error("publish-shorts: --video-sha256 espera o hash hexadecimal de 64 caracteres (o `video_sha256` do preparo da Buffer)");
    return 2;
  }
  const readStore = (): ReplacementStoreArg => {
    try {
      return readAuthorizationStore(dir, aammdd);
    } catch (e) {
      return (e as Error).message;
    }
  };
  // #11547: a confirmação (`x=URL`) mantém o registro da capa do agendamento.
  const markEntry = carryOverCover(built.entry, values["replaces"] !== undefined ? undefined : published.entries.find((e) => e.destination === mark.destination));
  const newEntry = videoSha ? { ...markEntry, video_sha256: videoSha } : markEntry;
  if (values["replaces"] !== undefined) {
    // #12279: o post novo da Buffer que troca o agendado antigo (criado pela skill depois da rodada de troca).
    let replaced: ReturnType<typeof readShortReplacements>;
    try {
      replaced = readShortReplacements(dir);
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
    const refusal = bufferReplacementMarkRefusal({
      destination: mark.destination,
      bufferId: mark.bufferId ?? null,
      replaces: values["replaces"],
      scheduledAt: values["scheduled-at"],
      videoSha256: videoSha,
      entries: published.entries,
      replaced,
      store: readStore(),
    });
    if (refusal) {
      console.error(`publish-shorts: ${refusal}`);
      return 2;
    }
    const old = published.entries.find((e) => e.destination === mark.destination) ?? replaced.find((r) => r.destination === mark.destination && r.id === values["replaces"])!;
    const applied = applyBufferReplacementMark({
      persist: () => {
        published = persist(newEntry);
      },
      record: () =>
        recordShortReplacement(dir, { destination: mark.destination, id: values["replaces"], scheduled_at: old.scheduled_at ?? null, replaced_at: new Date().toISOString(), new_video_sha256: videoSha ?? null }),
      warn: (m) => console.error(`[aviso] ${mark.destination}: ${m}`),
    });
    if (!applied.ok) {
      console.error(`publish-shorts: ${applied.error}`);
      return 2;
    }
  } else {
    published = persist(newEntry);
  }
  if (corte) {
    syncCorteAgendamentoFailSoft(() =>
      syncCorteAgendamento(ROOT, parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), dir), published.entries, [], new Date()),
    );
  }
  // #13781: o Reels registrado à mão não ganha o 1º comentário sozinho; lembra o editor.
  const firstCommentReminder = mark.destination === "instagram" && !corte ? readInstagramManualFirstCommentReminder(dir, aammdd) : null;
  if (firstCommentReminder) console.error(`[aviso] instagram: ${firstCommentReminder}`);
  console.log(JSON.stringify({ marked: mark.destination, url: mark.url, ...(mark.bufferId ? { buffer_id: mark.bufferId } : {}), ...(firstCommentReminder ? { first_comment_reminder: firstCommentReminder } : {}) }));
  cleanup();
  return 0;
}
