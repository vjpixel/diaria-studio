/**
 * scripts/lib/diaria/video-short-words.ts (#12093) — palavras curtas do
 * roteiro (artigos e preposições: o/um/a/uma/em/no...) contra uma
 * retranscrição da janela de cada item, sem VAD, antes do Gate 2.
 *
 * Na 261104 o texto do roteiro saiu do Whisper com "utilizado o deepfake"; o
 * `srt` (#11960) põe o roteiro na legenda, então o "o" do Whisper ia para a
 * tela sem ninguém conferir. O editor quis "utilizado deepfake" (sem artigo):
 * a legenda pode diferir do ouvido por escolha editorial, então o achado NÃO
 * corrige nada sozinho. Ele lista, no roteiro do Gate 2, onde a retranscrição
 * da janela ouve uma palavra curta diferente da do roteiro; o editor decide e,
 * se mudar, edita o texto do item (o roteiro aprovado é a fonte final da
 * legenda, #12093).
 *
 * Puro: o CLI (`video-montagem.ts roteiro`) retranscreve as janelas e chama
 * `shortWordDivergences` por item.
 */

import { forceAlignToScript, normalizeToken, type VocabAlias, type Word } from "./video-montage.ts";
import { mdCell } from "./video-montage-docs.ts";

/** Artigos, preposições e contrações curtas que o Whisper troca entre si ou inventa. */
export const SHORT_WORDS: ReadonlySet<string> = new Set([
  "o", "a", "os", "as",
  "um", "uma", "uns", "umas",
  "em", "no", "na", "nos", "nas", "num", "numa",
  "de", "do", "da", "dos", "das",
  "ao", "aos",
]);

/** Folga da janela retranscrita em volta de cada item, em segundos (o corte do Whisper no começo da fala). */
export const SHORT_WORD_WINDOW_PAD_S = 0.3;

export const isShortWord = (token: string): boolean => SHORT_WORDS.has(normalizeToken(token));

export interface ShortWordDivergence {
  /** O que o roteiro diz ("" = o roteiro não tem a palavra). */
  script: string;
  /** O que a retranscrição ouviu ("" = a retranscrição não ouviu a palavra). */
  heard: string;
  /** Segundo do bruto da palavra ouvida, quando há uma. */
  at?: number;
}

/**
 * Onde a retranscrição da janela (`heard`, tempo do bruto) e o texto do
 * roteiro do item divergem numa palavra curta: troca ("o" × "um"), palavra
 * ouvida que o roteiro não tem em plena fala ("utilizado o deepfake" ×
 * "utilizado deepfake") e palavra curta do roteiro que a retranscrição não
 * ouviu. As palavras ouvidas nas bordas da janela (antes da 1ª ou depois da
 * última casada) são a folga, não divergência.
 */
export function shortWordDivergences(heard: Word[], script: string, aliases: VocabAlias[] = []): ShortWordDivergence[] {
  if (!script.trim() || heard.length === 0) return [];
  const a = forceAlignToScript(heard, script, { aliases });
  const out: ShortWordDivergence[] = [];
  for (const s of a.substituted) {
    const tokens = [...s.heard.split(/\s+/), ...s.script.split(/\s+/)];
    if (tokens.some(isShortWord)) out.push({ script: s.script, heard: s.heard });
  }
  for (const d of a.dropped) {
    if ((d.reason === "fora do roteiro" || d.reason === "em silêncio" || d.reason === "perto de corte") && isShortWord(d.word.text)) {
      out.push({ script: "", heard: d.word.text.trim(), at: d.word.start });
    }
  }
  for (const t of a.interpolated) if (isShortWord(t)) out.push({ script: t, heard: "" });
  return out;
}

/** Um item do roteiro conferido (`id` como no fact-check: `comentario[2]`). */
export interface ShortWordItemCheck {
  id: string;
  text: string;
  start: number;
  end: number;
  divergences: ShortWordDivergence[];
}

/**
 * A seção do roteiro (Gate 2). `skipped` = a conferência não rodou (sem
 * `audio.wav`, `--no-short-word-check`, falha da retranscrição): o Doc diz
 * isso, nunca "nenhuma divergência".
 */
export function shortWordSection(checks: ShortWordItemCheck[] | null, skipped?: string): string[] {
  const lines = ["## Palavras curtas: roteiro × retranscrição (#12093)", ""];
  if (!checks) {
    lines.push(`**[aviso] conferência não rodou (${mdCell(skipped ?? "motivo desconhecido")}):** conferir no áudio os artigos e preposições do roteiro antes de aprovar o Gate 2.`);
    return lines;
  }
  const found = checks.filter((c) => c.divergences.length);
  lines.push(
    `Cada item foi retranscrito na janela dele, sem VAD. A legenda sai com o texto do roteiro: onde a retranscrição ouviu outra palavra curta, decidir aqui e, se for mudar, editar o text do item antes de aprovar (a legenda pode diferir do ouvido por escolha editorial).`,
    "",
  );
  if (!found.length) {
    lines.push(`Nenhuma divergência em ${checks.length} item(ns).`);
    return lines;
  }
  lines.push("| Item | Trecho do bruto | Roteiro | Ouvido |", "|---|---|---|---|");
  for (const c of found) {
    for (const d of c.divergences) {
      const at = d.at !== undefined ? `${d.at.toFixed(1)} s` : `${c.start.toFixed(1)}–${c.end.toFixed(1)} s`;
      lines.push(`| ${c.id} | ${at} | ${d.script ? mdCell(d.script) : "(sem a palavra)"} | ${d.heard ? mdCell(d.heard) : "(não ouvida)"} |`);
    }
  }
  return lines;
}
