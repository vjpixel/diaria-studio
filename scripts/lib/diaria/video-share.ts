/** Trecho compartilhável do horizontal (#13164). Tempos do plano são sugestões;
 * a publicação exige o segundo conferido no export final, vinculado ao SHA-256. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SETA } from "./roteiro-gravacao.ts";
import { sanitizeForYouTube } from "./youtube-video.ts";
import { itemInTarget, tokenize, type BlockKey, type ResolvedItem, type SequencePlan } from "./video-montage.ts";

export interface ShareCue { inicio: string; rotulo: string; texto: string }
export interface SharePublish extends ShareCue { seconds: number; videoSha256: string }
export const SHARE_FILE = "trecho-compartilhar.json";
export const videoSha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Lê só o `porVideo.horizontal.trechoCompartilhar` e a fala `inicio` (review
 * #13170): problema em outro campo do roteiro não bloqueia publish nem build.
 * JSON ilegível vira aviso e `null`, como `readRoteiroHorizontal`, exceto
 * quando o texto cru cita `trechoCompartilhar`: aí a promessa de link feita no
 * roteiro não pode sumir em silêncio, e a leitura falha. Trecho declarado e
 * inválido (fala ausente, fora do horizontal, rótulo vazio) também falha.
 */
export function readShareCue(editionDir: string, warn: (msg: string) => void = () => {}): ShareCue | null {
  const path = join(editionDir, "_internal/roteiro-falas.json");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    if (text.includes("trechoCompartilhar")) throw new Error(`trechoCompartilhar: ${path} ilegível (${(e as Error).message}); corrija o JSON antes de seguir`);
    warn(`${path} ilegível (${(e as Error).message}): sem trecho compartilhável (#13164)`);
    return null;
  }
  const r = (raw ?? {}) as { falas?: unknown; porVideo?: { horizontal?: { trechoCompartilhar?: unknown } } };
  const t = r.porVideo?.horizontal?.trechoCompartilhar as { inicio?: unknown; rotulo?: unknown } | null | undefined;
  if (t === undefined) return null;
  const falas = Array.isArray(r.falas) ? (r.falas as Array<Record<string, unknown> | null>) : [];
  const fala = t && typeof t.inicio === "string" ? falas.find((f) => f?.id === t.inicio) : undefined;
  const problemas: string[] = [];
  if (!fala || !Array.isArray(fala.videos) || !fala.videos.includes("horizontal")) problemas.push("trechoCompartilhar.inicio deve ser id de fala do horizontal");
  else if (typeof fala.texto !== "string" || !fala.texto.trim()) problemas.push(`fala ${String(t?.inicio)} sem texto`);
  if (!t || typeof t.rotulo !== "string" || !t.rotulo.trim() || /[\r\n]/.test(t.rotulo) || SETA.test(t.rotulo)) problemas.push("trechoCompartilhar.rotulo deve ser texto não vazio, em uma linha, sem seta");
  if (problemas.length) throw new Error(`trechoCompartilhar: roteiro inválido: ${problemas.join("; ")}`);
  return { inicio: t!.inicio as string, rotulo: (t!.rotulo as string).trim(), texto: fala!.texto as string };
}

/** Itens de até tantas palavras só casam com a fala inteira, como no `telaMarkersFor`. */
const SHARE_MIN_TOKENS_TRECHO = 3;

/**
 * Localiza a primeira palavra da fala nos itens decupados e projeta nos clipes
 * finais (já com pausas removidas, reordenação e vinheta). Casa o item como o
 * `telaMarkersFor` (#13140): a fala inteira, ou um trecho dela com 3+ palavras
 * (fala dividida em vários itens ou com texto ajustado); o início é o item que
 * abre a fala. O valor é só sugestão (`requiresFinalCheck`): sem casamento único
 * devolve `null` com aviso, nunca para o build (review #13170).
 */
export function shareTimeInPlan(
  cue: ShareCue, plan: Pick<SequencePlan, "spec" | "clips">, resolved: Partial<Record<BlockKey, ResolvedItem[]>>, fps: number,
  warn: (msg: string) => void = () => {},
): number | null {
  const norm = (s: string) => tokenize(s).join(" ");
  const fala = norm(cue.texto);
  const items = plan.spec.order.flatMap((b) => (resolved[b] ?? []).filter((it) => itemInTarget(it, plan.spec)));
  const matched = items.filter((it) => {
    const x = norm(it.text);
    if (!x || !fala) return false;
    return x === fala || (x.split(" ").length >= SHARE_MIN_TOKENS_TRECHO && ` ${fala} `.includes(` ${x} `));
  });
  const abre = matched.filter((it) => { const x = norm(it.text); return x === fala || fala.startsWith(`${x} `); });
  const fail = (why: string): null => { warn(`trechoCompartilhar ${cue.inicio}: ${why}; seconds fica null, conferir o tempo no export final`); return null; };
  if (!matched.length) return fail("fala ausente na decupagem do horizontal");
  if (abre.length !== 1) return fail(abre.length ? "fala repetida na decupagem do horizontal (início ambíguo)" : "início da fala não está na decupagem do horizontal");
  if (!abre[0].words.length) return fail("item da decupagem sem palavras com tempo");
  const start = abre[0].words[0].start;
  const clips = plan.clips.filter((c) => start >= c.srcIn && start < c.srcOut);
  if (clips.length !== 1) return fail("início removido ou repetido no corte");
  return (clips[0].seqStart + Math.round((start - clips[0].srcIn) * fps)) / fps;
}

export function confirmedShare(cue: ShareCue, rawSeconds: string | undefined, bytes: Buffer): SharePublish {
  if (rawSeconds === undefined || !/^\d+$/.test(rawSeconds) || !Number.isSafeInteger(Number(rawSeconds))) {
    throw new Error(`trechoCompartilhar ${cue.inicio}: confira a fala no export final e passe --share-start SEGUNDOS (inteiro, >=0); não reutilize o tempo da montagem sem conferir`);
  }
  return { ...cue, seconds: Number(rawSeconds), videoSha256: videoSha256(bytes) };
}

/**
 * Decide o trecho do plano do horizontal (review #13170): só o caminho que vai
 * criar o vídeo (dry-run, ou --upload que chega ao videos.insert) exige o
 * --share-start conferido e lê o arquivo. Retomada com registro,
 * --accept-period-match ou vídeo ausente (já limpo depois do upload) seguem
 * sem o trecho, com aviso.
 */
export function shareForRun(o: {
  cue: ShareCue | null; rawSeconds: string | undefined; videoExists: boolean; createsVideo: boolean;
  readVideo: () => Buffer; warn: (msg: string) => void;
}): SharePublish | undefined {
  if (!o.cue) {
    if (o.rawSeconds !== undefined) o.warn("--share-start recebido, mas o roteiro-falas.json não tem porVideo.horizontal.trechoCompartilhar; o tempo foi ignorado e o plano não muda (#13353). Grave o campo no roteiro (/diaria-video-roteiro) e rode de novo");
    return undefined;
  }
  if (!o.createsVideo) {
    o.warn(`trechoCompartilhar ${o.cue.inicio}: este --upload não cria vídeo (registro existente ou --accept-period-match); --share-start não é usado. Link do trecho: conferir o tempo no vídeo do canal e aplicar no Studio, se ainda não estiver lá`);
    return undefined;
  }
  if (!o.videoExists) {
    o.warn(`trechoCompartilhar ${o.cue.inicio}: vídeo ausente; o trecho fica fora do plano até o export final estar baixado (aí conferir e passar --share-start)`);
    return undefined;
  }
  return confirmedShare(o.cue, o.rawSeconds, o.readVideo());
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
