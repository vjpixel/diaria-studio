/** Trecho compartilhável do horizontal (#13164). Tempos do plano são sugestões;
 * a publicação exige o segundo conferido no export final, vinculado ao SHA-256. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validarRoteiroFalas, type RoteiroFalas } from "./roteiro-gravacao.ts";
import { sanitizeForYouTube } from "./youtube-video.ts";
import { itemInTarget, tokenize, type BlockKey, type ResolvedItem, type SequencePlan } from "./video-montage.ts";

export interface ShareCue { inicio: string; rotulo: string; texto: string }
export interface SharePublish extends ShareCue { seconds: number; videoSha256: string }
export const SHARE_FILE = "trecho-compartilhar.json";
export const videoSha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function readShareCue(editionDir: string): ShareCue | null {
  const path = join(editionDir, "_internal/roteiro-falas.json");
  if (!existsSync(path)) return null;
  // JSON ilegível não pode esconder uma promessa de link feita no roteiro.
  const raw = JSON.parse(readFileSync(path, "utf8")) as RoteiroFalas;
  const cue = raw.porVideo?.horizontal?.trechoCompartilhar;
  if (cue === undefined) return null;
  const errors = validarRoteiroFalas(raw);
  if (errors.length) throw new Error(`trechoCompartilhar: roteiro inválido: ${errors.join("; ")}`);
  const fala = raw.falas.find((f) => f.id === cue.inicio)!;
  return { inicio: cue.inicio, rotulo: cue.rotulo.trim(), texto: fala.texto };
}

/** Localiza a primeira palavra da fala nos itens decupados e projeta nos clipes
 * finais (já com pausas removidas, reordenação e vinheta). Ambiguidade é erro. */
export function shareTimeInPlan(cue: ShareCue, plan: SequencePlan, resolved: Partial<Record<BlockKey, ResolvedItem[]>>, fps: number): number {
  const norm = (s: string) => tokenize(s).join(" ");
  const items = plan.spec.order.flatMap((b) => (resolved[b] ?? []).filter((it) => itemInTarget(it, plan.spec) && norm(it.text) === norm(cue.texto)));
  if (items.length !== 1 || !items[0].words.length) throw new Error(`trechoCompartilhar ${cue.inicio}: fala ausente ou ambígua na decupagem do horizontal; confira blocks.json`);
  const start = items[0].words[0].start;
  const clips = plan.clips.filter((c) => start >= c.srcIn && start < c.srcOut);
  if (clips.length !== 1) throw new Error(`trechoCompartilhar ${cue.inicio}: início removido ou repetido no corte; conferir o export final`);
  return (clips[0].seqStart + Math.round((start - clips[0].srcIn) * fps)) / fps;
}

export function confirmedShare(cue: ShareCue, rawSeconds: string | undefined, bytes: Buffer): SharePublish {
  if (rawSeconds === undefined || !/^\d+$/.test(rawSeconds) || !Number.isSafeInteger(Number(rawSeconds))) {
    throw new Error(`trechoCompartilhar ${cue.inicio}: confira a fala no export final e passe --share-start SEGUNDOS (inteiro, >=0); não reutilize o tempo da montagem sem conferir`);
  }
  return { ...cue, seconds: Number(rawSeconds), videoSha256: videoSha256(bytes) };
}

export function shareLine(cue: Pick<SharePublish, "rotulo" | "seconds">, videoId: string): string {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error("videoId inválido para o trecho compartilhável");
  return `${sanitizeForYouTube(cue.rotulo)}: https://youtu.be/${videoId}?t=${cue.seconds}`;
}

/** Request aprovado usa um espaço reservado; só a atualização pós-upload leva
 * o link resolvido. Nunca inserir uma URL com id fictício no vídeo. */
export function shareDescription(description: string, cue: Pick<SharePublish, "rotulo" | "seconds">, videoId?: string): string {
  const line = videoId ? shareLine(cue, videoId) : `${sanitizeForYouTube(cue.rotulo)}: https://youtu.be/{VIDEO_ID}?t=${cue.seconds}`;
  const result = `${description}\n\n${line}`;
  if (Array.from(result).length > 5000) throw new Error("descrição com trecho compartilhável excede 5000 caracteres");
  return result;
}
