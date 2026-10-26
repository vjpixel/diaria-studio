/**
 * scripts/lib/diaria/d1-no-video.ts (#11125)
 *
 * Marcador por edição "esta edição NÃO tem vídeo": desliga a cópia do hero do
 * D1 com o convite "Clique e assista a notícia comentada"
 * (`04-d1-2x1-play.jpg`, #10784) e o link da imagem pro vídeo/canal.
 *
 * Por que um marcador e não uma flag de linha de comando: o upload
 * (`upload-images-public.ts`) roda em mais de um ponto do fluxo (Stage 4,
 * re-render, Stage 5) e REGERAVA a cópia em toda rodada em modo newsletter —
 * na edição 261026 o editor apagou a cópia, o carimbo e a chave `d1_play` à
 * mão e qualquer upload seguinte traria o convite de volta. O marcador fica
 * no disco da edição, então todos os pontos leem a mesma decisão.
 *
 * Com o marcador:
 *   - `upload-images-public.ts` não gera nem sobe a cópia, apaga a cópia e o
 *     carimbo que sobraram e tira `d1_play` de `06-public-images.json`;
 *   - `d1VideoHeroFields` (render) devolve `{}`: o D1 sai com o hero puro, sem
 *     link, mesmo que a cópia ainda esteja no disco.
 *
 * O marcador vence a URL do vídeo (`_internal/05-video-url.txt`): é a decisão
 * explícita do editor para a edição. Para religar, remover o marcador
 * (`scripts/set-d1-no-video.ts --edition-dir X --clear`) e rodar o upload.
 *
 * A presença do arquivo é o que conta (conteúdo é só registro: quando e por
 * quê). JSON ilegível segue valendo como "sem vídeo" — o lado seguro é não
 * pôr no e-mail um convite pra vídeo que não existe.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Marcador "edição sem vídeo" (relativo ao diretório da edição). */
export const D1_NO_VIDEO_MARKER_FILE = "_internal/no-video.json";

/** `true` quando a edição está marcada como sem vídeo. */
export function isNoVideoEdition(editionDir: string): boolean {
  return existsSync(join(editionDir, D1_NO_VIDEO_MARKER_FILE));
}

/** Grava o marcador (idempotente). Devolve o caminho gravado. */
export function markNoVideo(editionDir: string, reason?: string, now: Date = new Date()): string {
  const p = join(editionDir, D1_NO_VIDEO_MARKER_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const body = { no_video: true, marked_at: now.toISOString(), ...(reason ? { reason } : {}) };
  writeFileSync(p, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return p;
}

/** Remove o marcador. Devolve `true` se havia marcador. */
export function clearNoVideo(editionDir: string): boolean {
  const p = join(editionDir, D1_NO_VIDEO_MARKER_FILE);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}
