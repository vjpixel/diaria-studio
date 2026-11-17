/**
 * scripts/lib/diaria/youtube-thumb-roteiro.ts (#13401)
 *
 * O gancho das capas do YouTube a partir do roteiro do vídeo
 * (`_internal/roteiro-falas.json`, gravado pela `/diaria-video-roteiro`):
 * sem `--hook`, o `gen-youtube-thumb.ts` usa `porVideo.{video}.capa`, com
 * `[premissa]` dizendo de onde veio. `--hook` explícito sempre sobrepõe.
 * Roteiro ausente: o comportamento de antes. Roteiro presente mas ilegível,
 * inválido ou sem o campo de capa: lança, nomeando arquivo e campo e pedindo
 * `--hook` (nunca cai na capa antiga calado).
 *
 * Capa do Short: o default é o vertical 1 (a vertical da edição, o vídeo
 * default do `--short-cover`). Com `--video` explícito (qualquer caminho) o
 * roteiro só é lido com `--roteiro-capa vertical1|vertical2`: sem isso, a capa
 * de um vídeo diferente sairia com o texto do vertical 1.
 *
 * A regra de cada capa é a do gerador, nunca uma contagem paralela:
 * `normalizeShortCoverHook` nos verticais, `splitHook(hookHorizontalDoRoteiro())`
 * no horizontal. `errosCapaDoRoteiro` aplica a mesma regra no roteiro inteiro,
 * para o `video-roteiro-blocos.ts` e o `render-roteiro-video.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERTICAIS_ROTEIRO, VIDEO_LABEL, type RoteiroFalas, type VerticalRoteiro, type VideoRoteiro } from "./roteiro-gravacao.ts";
import { parseRoteiroFalas, ROTEIRO_FALAS_FILE } from "./roteiro-videos.ts";
import { hookHorizontalDoRoteiro, normalizeShortCoverHook, splitHook } from "./youtube-thumb.ts";

export type CapaAlvo = "horizontal" | "short";

/** Valor do `--roteiro-capa` (só na capa do Short): `vertical1` ou `vertical2`. */
export function parseRoteiroCapaVideo(v: string | undefined): VerticalRoteiro | undefined {
  if (v === undefined) return undefined;
  const vertical = VERTICAIS_ROTEIRO.find((x) => x === v);
  if (!vertical) throw new Error(`--roteiro-capa ${JSON.stringify(v)}: use vertical1 ou vertical2 (#13401)`);
  return vertical;
}

/**
 * O gancho pronto para o gerador a partir do texto da capa do roteiro, ou
 * lança com a mensagem do gerador. Vertical: `normalizeShortCoverHook` (2 a 5
 * palavras, já com a quebra em 2 linhas). Horizontal: `hookHorizontalDoRoteiro`
 * (capa de 1 linha com mais de 4 palavras em 2 linhas) validado pelo
 * `splitHook` (até 4 por linha, 2 a 8 no total).
 */
export function hookDaCapa(video: VideoRoteiro, capa: string): string {
  if (video === "horizontal") {
    const hook = hookHorizontalDoRoteiro(capa);
    splitHook(hook);
    return hook;
  }
  return normalizeShortCoverHook(capa);
}

/**
 * Capas do roteiro que o `gen-youtube-thumb.ts` recusaria (#13401), uma
 * mensagem por campo. Campo ausente não é erro aqui (a skill do roteiro exige
 * a capa por outro caminho).
 */
export function errosCapaDoRoteiro(roteiro: Pick<RoteiroFalas, "porVideo">): string[] {
  const erros: string[] = [];
  for (const v of ["horizontal", ...VERTICAIS_ROTEIRO] as const) {
    const capa = roteiro.porVideo?.[v]?.capa?.trim();
    if (!capa) continue;
    try {
      hookDaCapa(v, capa);
    } catch (e) {
      const gerador = v === "horizontal" ? "gen-youtube-thumb.ts" : "gen-youtube-thumb.ts --short-cover";
      erros.push(`porVideo.${v}.capa (${VIDEO_LABEL[v]}): ${(e as Error).message}; o ${gerador} recusa, encurte a capa (#13401)`);
    }
  }
  return erros;
}

export interface ResolverHookOpts {
  alvo: CapaAlvo;
  /** O `--hook` da linha de comando (sobrepõe o roteiro). */
  hook?: string;
  editionDir: string;
  /** `--video` explícito no `--short-cover`. */
  videoExplicito?: boolean;
  /** `--roteiro-capa` (só no `--short-cover`). */
  roteiroCapa?: VerticalRoteiro;
}

export interface ResolverHookLog {
  warn: (msg: string) => void;
  premissa: (msg: string) => void;
}

/**
 * O gancho da capa: o `--hook`, ou o texto da capa do roteiro já no formato do
 * gerador, ou `undefined` (sem roteiro, ou `--video` sem `--roteiro-capa`: o
 * fluxo de antes). Lança com o arquivo e o campo quando o roteiro existe mas
 * não serve (ilegível, inválido, sem a capa) ou quando a capa é recusada pela
 * regra do gerador, antes de qualquer ffmpeg ou composição.
 */
export function resolverHookDaCapa(o: ResolverHookOpts, log: ResolverHookLog): string | undefined {
  if (o.alvo === "horizontal" && o.roteiroCapa !== undefined) throw new Error("--roteiro-capa vale só com --short-cover (#13401)");
  if (o.hook !== undefined) {
    if (o.roteiroCapa !== undefined) log.warn(`--roteiro-capa ${o.roteiroCapa} ignorado: o --hook explícito vence o roteiro (#13401)`);
    return o.hook;
  }
  let video: VideoRoteiro;
  if (o.alvo === "horizontal") video = "horizontal";
  else if (o.roteiroCapa !== undefined) video = o.roteiroCapa;
  else if (o.videoExplicito) {
    log.warn("--short-cover com --video e sem --hook: nenhuma capa do roteiro aplicada (o vídeo pode não ser o vertical 1); passe --hook ou --roteiro-capa vertical1|vertical2 (#13401)");
    return undefined;
  } else video = "vertical1";
  const path = join(o.editionDir, ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) return undefined;
  const campo = `porVideo.${video}.capa`;
  const pedir = `passe --hook (ou corrija ${campo} no roteiro) (#13401)`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} ilegível (${(e as Error).message}): não li ${campo}; ${pedir}`);
  }
  const lido = parseRoteiroFalas(raw);
  if (!lido.ok) throw new Error(`${path} inválido (${lido.problemas.join("; ")}): não uso ${campo}; ${pedir}`);
  const capa = lido.roteiro.porVideo?.[video]?.capa?.trim();
  if (!capa) throw new Error(`${path} sem ${campo}: ${pedir}`);
  const origem = `texto da capa do ${VIDEO_LABEL[video]} no roteiro (${path}, ${campo})`;
  let hook: string;
  try {
    hook = hookDaCapa(video, capa);
  } catch (e) {
    throw new Error(`${origem}: ${(e as Error).message}. Corrija a capa no roteiro ou passe --hook (#13401)`);
  }
  log.premissa(`--hook ${JSON.stringify(hook)}: ${origem}; passe --hook para outro gancho (#13401)`);
  return hook;
}
