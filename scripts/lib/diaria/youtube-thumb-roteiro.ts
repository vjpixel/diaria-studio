/**
 * scripts/lib/diaria/youtube-thumb-roteiro.ts (#13401)
 *
 * O gancho das capas do YouTube a partir do roteiro do vídeo
 * (`_internal/roteiro-falas.json`, gravado pela `/diaria-video-roteiro`):
 * sem `--hook`, o `gen-youtube-thumb.ts` usa `porVideo.{video}.capa`, com
 * `[premissa]` dizendo de onde veio. `--hook` explícito sempre sobrepõe; sem
 * roteiro ou sem o campo, o comportamento de antes fica igual.
 *
 * Capa do Short: o default é o vertical 1 (a vertical da edição, o vídeo
 * default do `--short-cover`). Com `--video` explícito (corte avulso, outro
 * arquivo) o roteiro só é lido com `--roteiro-capa vertical1|vertical2`: sem
 * isso, a capa de um vídeo diferente sairia com o texto do vertical 1.
 */

import { join } from "node:path";
import { VIDEO_LABEL, type VideoRoteiro } from "./roteiro-gravacao.ts";
import { readRoteiroPecas, ROTEIRO_FALAS_FILE } from "./roteiro-videos.ts";
import { hookHorizontalDoRoteiro, normalizeShortCoverHook } from "./youtube-thumb.ts";

export type CapaAlvo = "horizontal" | "short";

const VERTICAIS: readonly VideoRoteiro[] = ["vertical1", "vertical2"];

/** Valor do `--roteiro-capa` (só na capa do Short): `vertical1` ou `vertical2`. */
export function parseRoteiroCapaVideo(v: string | undefined): VideoRoteiro | undefined {
  if (v === undefined) return undefined;
  if ((VERTICAIS as readonly string[]).includes(v)) return v as VideoRoteiro;
  throw new Error(`--roteiro-capa ${JSON.stringify(v)}: use vertical1 ou vertical2 (#13401)`);
}

export interface ResolverHookOpts {
  alvo: CapaAlvo;
  /** O `--hook` da linha de comando (sobrepõe o roteiro). */
  hook?: string;
  editionDir: string;
  /** `--video` explícito no `--short-cover`. */
  videoExplicito?: boolean;
  /** `--roteiro-capa` (só no `--short-cover`). */
  roteiroCapa?: VideoRoteiro;
}

export interface ResolverHookLog {
  warn: (msg: string) => void;
  premissa: (msg: string) => void;
}

/**
 * O gancho da capa: o `--hook`, ou o texto da capa do roteiro, ou `undefined`
 * (sem roteiro, sem o campo, ou `--video` sem `--roteiro-capa`: o fluxo de
 * antes). Capa do Short que o gerador recusa (fora de 2 a 5 palavras) lança
 * já aqui, nomeando o campo do roteiro, antes do ffmpeg.
 */
export function resolverHookDaCapa(o: ResolverHookOpts, log: ResolverHookLog): string | undefined {
  if (o.hook !== undefined) return o.hook;
  if (o.alvo === "horizontal" && o.roteiroCapa !== undefined) throw new Error("--roteiro-capa vale só com --short-cover (#13401)");
  let video: VideoRoteiro;
  if (o.alvo === "horizontal") video = "horizontal";
  else if (o.roteiroCapa !== undefined) video = o.roteiroCapa;
  else if (o.videoExplicito) {
    log.warn("--short-cover com --video e sem --hook: o texto da capa do roteiro não é usado (o vídeo pode não ser o vertical 1); passe --hook ou --roteiro-capa vertical1|vertical2 (#13401)");
    return undefined;
  } else video = "vertical1";
  const capa = readRoteiroPecas(o.editionDir, log.warn)?.[video]?.capa;
  if (!capa) return undefined;
  const origem = `texto da capa do ${VIDEO_LABEL[video]} no roteiro (${join(o.editionDir, ROTEIRO_FALAS_FILE)}, porVideo.${video}.capa)`;
  let hook = capa;
  if (o.alvo === "short") {
    try {
      normalizeShortCoverHook(capa);
    } catch (e) {
      throw new Error(`${origem}: ${(e as Error).message}. Corrija a capa no roteiro ou passe --hook (#13401)`);
    }
  } else {
    hook = hookHorizontalDoRoteiro(capa);
  }
  log.premissa(`--hook ${JSON.stringify(hook)}: ${origem}; passe --hook para outro gancho (#13401)`);
  return hook;
}
