/**
 * weekly-video-pitch.ts (#13045)
 *
 * A frase da semana sobre o vídeo do artigo semanal do LinkedIn: o que o vídeo
 * traz que o texto não traz. Entra depois da frase fixa da seção "Vídeo da
 * semana" ("Eu comento o destaque acima no YouTube da diar.ia.br.", ver
 * `LINKEDIN_WEEKLY_VIDEO_LEAD` em `weekly-linkedin-render.ts`), gravada em
 * `ln-selection.json` como `video.pitch`. Mesmo desenho da `videoDescription`
 * do post da Stack (`circle-stack-copy.ts`, #12549): a skill escreve a partir
 * da legenda da edição do vídeo (`diaria-comentada-{AAMMDD}.srt`), passa por
 * humanizador e Clarice, e o script recusa o texto que foge das regras.
 *
 * Puro: quem lê a legenda do disco é `render-linkedin-weekly.ts`.
 */

import { stackCopyTextProblems, unsourcedNumbers, videoAudienceClaim } from "./circle-stack-copy.ts";

/** Teto da frase da semana: o mesmo da descrição do vídeo da Stack. */
export const WEEKLY_VIDEO_PITCH_MAX_CHARS = 280;

/**
 * Pure: texto falado de uma legenda SRT, sem o número de cada bloco nem a
 * linha de tempo. Sem isso, a checagem de números aceitaria qualquer número
 * que aparecesse num timestamp ("00", "12", "480").
 */
export function srtSpokenText(srt: string): string {
  return srt
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^\d+$/.test(t)) return false;
      if (/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(t)) return false;
      return true;
    })
    .join("\n");
}

/**
 * Pure: problemas da frase da semana. Vazio = pode ir pro artigo.
 *
 * - as regras de texto da Stack (`stackCopyTextProblems`: teto, seta,
 *   markdown, URL, "agentivo", emoji, conselho ao leitor);
 * - nada de "mais assistido"/"mais visto" (#13023, pedido do editor na #13045);
 * - nada de "diar.ia.br" em texto puro: o LinkedIn o transforma em link para o
 *   site, e a marca aponta para a página do LinkedIn (#13049);
 * - número só se estiver na fala do vídeo (`transcript`, já sem a marcação do
 *   SRT). Sem legenda (`null`), a checagem de números não roda e o chamador
 *   avisa.
 */
export function weeklyVideoPitchProblems(pitch: string, transcript: string | null): string[] {
  const problems = stackCopyTextProblems(pitch, WEEKLY_VIDEO_PITCH_MAX_CHARS);
  if (problems.includes("vazio")) return problems;
  const audiencia = videoAudienceClaim(pitch);
  if (audiencia) problems.push(`chama o vídeo de "${audiencia}" — a frase diz o que o vídeo traz, não a audiência dele (#13023)`);
  if (/(^|[^\w./-])diar\.ia\.br(?![\w/-])/i.test(pitch)) {
    problems.push('cita "diar.ia.br" em texto puro — o LinkedIn vira link para o site; a marca já está no link do vídeo (#13049)');
  }
  if (transcript !== null) {
    const extra = unsourcedNumbers(pitch, [transcript]);
    if (extra.length > 0) problems.push(`número(s) que não aparecem na fala do vídeo (${extra.join(", ")})`);
  }
  return problems;
}
