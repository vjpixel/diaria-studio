/**
 * scripts/lib/mensal/monthly-video-do-mes.ts (#12081)
 *
 * "O vídeo do mês" no encerramento da mensal: o horizontal do D1 mais visto
 * entre as edições do mês de conteúdo do ciclo (decisão do editor de
 * 03/11/2026 na #12081). Miolo PURO — quem mede as views e grava o arquivo é
 * `scripts/monthly-video-do-mes.ts`.
 *
 * A linha entra como o PRIMEIRO parágrafo do bloco `**PARA ENCERRAR**` do
 * `draft.md`: `parseEncerramento` a lê como prosa antes das curadorias, e
 * todos os renders da mensal (Clarice, Kit dos apoiadores, página web) a
 * mostram sem plumbing próprio. No `draft.md` ela também aparece para o
 * editor no gate da Etapa 4, onde pode ser editada ou apagada.
 *
 * Idempotente: se o draft já cita o vídeo (mesma URL), nada muda; se cita
 * a linha com outro vídeo (rodada anterior, views mudaram), troca a linha.
 */

/** Começo da linha (identifica a linha numa re-rodada). */
export const VIDEO_DO_MES_LEAD = "O vídeo mais assistido do mês no canal da diar.ia.br foi";

export interface VideoDoMes {
  title: string;
  url: string;
}

/** Pure: a linha do vídeo do mês (Markdown). */
export function videoDoMesLine(video: VideoDoMes): string {
  const title = video.title.replace(/[[\]]/g, "").trim();
  return `${VIDEO_DO_MES_LEAD} [${title}](${video.url}).`;
}

export type InsertVideoDoMesResult =
  | { changed: true; draft: string; action: "inserted" | "replaced" }
  | { changed: false; draft: string; reason: string };

const ENCERRAR_RE = /^\*\*(PARA ENCERRAR|ENCERRAMENTO)\*\*[ \t]*\r?\n/m;

/** Pure: insere (ou troca) a linha no início do bloco PARA ENCERRAR. */
export function insertVideoDoMesLine(draft: string, video: VideoDoMes): InsertVideoDoMesResult {
  const line = videoDoMesLine(video);
  const lines = draft.split("\n");
  const existing = lines.findIndex((l) => l.trim().startsWith(VIDEO_DO_MES_LEAD));
  if (existing >= 0) {
    if (lines[existing].trim() === line) return { changed: false, draft, reason: "o draft já traz este vídeo do mês" };
    lines[existing] = line;
    return { changed: true, draft: lines.join("\n"), action: "replaced" };
  }
  const m = ENCERRAR_RE.exec(draft);
  if (!m) return { changed: false, draft, reason: "draft sem bloco **PARA ENCERRAR**" };
  const at = m.index + m[0].length;
  const rest = draft.slice(at).replace(/^(?:[ \t]*\r?\n)+/, "");
  return { changed: true, draft: `${draft.slice(0, at)}\n${line}\n\n${rest}`, action: "inserted" };
}
