/**
 * Trecho de outro vídeo no horizontal (formato react, #13437; o campo
 * `trechoInserido` da fala é da #13397).
 *
 * A montagem LÊ o campo: cada fala do horizontal com `trechoInserido` vira um
 * marcador `trecho {id}` no `<sequence>` do XML, no quadro em que a fala
 * termina (onde o trecho entra), com vídeo, intervalo e texto no comentário.
 * O `build` diz em `[premissa]` onde inserir, o intervalo e a duração que o
 * trecho soma ao horizontal.
 *
 * Formato do campo desde a #13437 (PR 1): `{ video, inicio, fim, texto }`,
 * lido por `trecho-inserido-formato.ts`, que também migra o formato antigo
 * (`origem` em texto livre). Trecho que não passa na leitura sai em `[aviso]`
 * e fica fora do XML, sem tempo inventado.
 *
 * Fora desta fatia (PR 2 da #13437): baixar o vídeo de origem (o
 * `05-youtube-published.json` da edição de origem ou o export do Drive),
 * cortar o intervalo, conferir o texto contra o SRT e pôr o clipe numa faixa
 * do XML. Até lá o clipe entra à mão no Premiere, no marcador.
 *
 * Puro, salvo `readTrechosInseridos` (lê o `roteiro-falas.json`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtTempoTrecho, lerTrechoInserido, rotuloTrecho, type TrechoInseridoLido } from "./trecho-inserido-formato.ts";

/**
 * O mesmo `ROTEIRO_FALAS_FILE` de `roteiro-videos.ts`, repetido aqui de
 * propósito: importar de lá fecha um ciclo com `video-montage.ts` (que importa
 * este módulo) via `roteiro-gravacao.ts`. Travado por teste.
 */
export const ROTEIRO_FALAS_PATH = "_internal/roteiro-falas.json";

/** Um trecho inserido, lido do roteiro, com o id e o texto da fala que o antecede. */
export interface TrechoInseridoRoteiro {
  /** Id da fala depois da qual o trecho entra. */
  id: string;
  /** Texto da fala (para casar com o item do `blocks.json`, como o texto de tela). */
  texto: string;
  /** O trecho, já lido no formato estruturado (#13437). */
  trecho: TrechoInseridoLido;
}

/**
 * Os trechos inseridos do roteiro (`_internal/roteiro-falas.json`). Roteiro
 * ausente = `[]`; ilegível = `[]` com aviso. Fala com `trechoInserido` fora do
 * horizontal fica fora (o validador do roteiro já recusa); trecho que não
 * passa na leitura do formato sai com aviso.
 */
export function readTrechosInseridos(editionDir: string, warn: (msg: string) => void): TrechoInseridoRoteiro[] {
  const path = join(editionDir, ROTEIRO_FALAS_PATH);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn(`${path} ilegível (${(e as Error).message}): trechos inseridos do roteiro fora do XML (#13437)`);
    return [];
  }
  const falas = (raw as { falas?: unknown } | null)?.falas;
  if (!Array.isArray(falas)) return [];
  const out: TrechoInseridoRoteiro[] = [];
  for (const f of falas as Array<Record<string, unknown> | null>) {
    if (!f || f.trechoInserido === undefined || typeof f.id !== "string" || typeof f.texto !== "string") continue;
    if (Array.isArray(f.videos) && !f.videos.includes("horizontal")) continue;
    const lido = lerTrechoInserido(f.trechoInserido);
    if (!lido.ok) {
      warn(`fala ${f.id}: trechoInserido inválido (${lido.problemas.join("; ")}), fora do XML (#13437)`);
      continue;
    }
    out.push({ id: f.id, texto: f.texto, trecho: lido.trecho });
  }
  return out;
}

/** Um marcador do trecho no `<sequence>`, em quadros da sequência. */
export interface TrechoInseridoMarker {
  id: string;
  trecho: TrechoInseridoLido;
  /** Quadro em que a fala termina: onde o trecho entra. */
  at: number;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Marcadores do xmeml (`trecho {id}`), de 1 quadro, no ponto de inserção. O
 * comentário leva vídeo, intervalo e o texto do trecho, para o editor achar o clipe.
 */
export function trechoInseridoMarkersXml(markers: readonly TrechoInseridoMarker[]): string {
  return markers
    .map((m) => `<marker><name>${escapeXml(`trecho ${m.id}`)}</name><comment>${escapeXml(`${rotuloTrecho(m.trecho)}: "${m.trecho.texto}"`)}</comment><in>${m.at}</in><out>${m.at + 1}</out></marker>\n`)
    .join("");
}

/** Linha da `[premissa]` de um marcador: o formato estruturado garante vídeo e intervalo (#13437). */
export function trechoInseridoLine(m: TrechoInseridoMarker, fps: number): { level: "premissa"; text: string } {
  const at = (m.at / fps).toFixed(1);
  const { inicioS, fimS, youtubeId, edicao, migrado } = m.trecho;
  const video = youtubeId ? `vídeo youtu.be/${youtubeId}` : `vídeo da edição ${edicao}`;
  const antigo = migrado ? "; o roteiro usa o formato antigo (origem em texto livre): migrar com scripts/migrar-trecho-inserido.ts" : "";
  return {
    level: "premissa",
    text: `trecho inserido depois da fala ${m.id}, em ${at} s (marcador "trecho ${m.id}"): ${video}, ${fmtTempoTrecho(inicioS)} a ${fmtTempoTrecho(fimS)}, soma ${(fimS - inicioS).toFixed(1)} s ao horizontal; inserir o clipe à mão no Premiere (#13437)${antigo}`,
  };
}
