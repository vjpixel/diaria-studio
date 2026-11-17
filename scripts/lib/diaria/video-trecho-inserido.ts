/**
 * Trecho de outro vídeo no horizontal (formato react, #13437; o campo
 * `trechoInserido` da fala é da #13397).
 *
 * Primeira fatia: a montagem passa a LER o campo. Cada fala do horizontal com
 * `trechoInserido` vira um marcador `trecho {id}` no `<sequence>` do XML, no
 * quadro em que a fala termina (onde o trecho entra), com a origem e o texto
 * no comentário. O `build` diz em `[premissa]` onde inserir, o intervalo lido
 * da `origem` e a duração que o trecho soma ao horizontal; `origem` sem
 * intervalo legível sai em `[aviso]`, sem tempo inventado.
 *
 * Fora desta fatia (seguem na #13437): baixar o vídeo de origem (o
 * `05-youtube-published.json` da edição de origem ou o export do Drive),
 * cortar o intervalo, conferir o texto contra o SRT e pôr o clipe numa faixa
 * do XML. Até lá o clipe entra à mão no Premiere, no marcador. O formato da
 * `origem` segue texto livre (decisão de formato pendente com o editor, #13437):
 * `parseTrechoOrigem` lê a convenção que a doc do campo já usa
 * ("Vídeo de 10/11, youtu.be/ID, 3:42 a 4:00").
 *
 * Puro, salvo `readTrechosInseridos` (lê o `roteiro-falas.json`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * O mesmo `ROTEIRO_FALAS_FILE` de `roteiro-videos.ts`, repetido aqui de
 * propósito: importar de lá fecha um ciclo com `video-montage.ts` (que importa
 * este módulo) via `roteiro-gravacao.ts`. Travado por teste.
 */
export const ROTEIRO_FALAS_PATH = "_internal/roteiro-falas.json";

/** Um trecho inserido, como o roteiro o grava, com o id e o texto da fala que o antecede. */
export interface TrechoInseridoRoteiro {
  /** Id da fala depois da qual o trecho entra. */
  id: string;
  /** Texto da fala (para casar com o item do `blocks.json`, como o texto de tela). */
  texto: string;
  origem: string;
  trecho: string;
}

/** O que dá para ler da `origem` (texto livre). `null` em cada campo = não achado. */
export interface TrechoOrigem {
  /** Id do vídeo no YouTube (youtu.be/ID, watch?v=ID, shorts/ID). */
  youtubeId: string | null;
  /** Intervalo no vídeo de origem, em segundos. */
  inicioS: number | null;
  fimS: number | null;
}

const YT_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s,]*&)?v=|shorts\/|live\/))([A-Za-z0-9_-]{11})/u;
const TEMPO = String.raw`(\d{1,2}(?::\d{2}){1,2})`;
/** "3:42 a 4:00", "3:42-4:00", "3:42 – 4:00", "de 3:42 até 4:00". */
const INTERVALO_RE = new RegExp(`${TEMPO}\\s*(?:a|até|-|–|—)\\s*${TEMPO}`, "u");

/** "m:ss" ou "h:mm:ss" em segundos; `null` se algum campo passa de 59. */
export function parseTempo(t: string): number | null {
  const parts = t.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.slice(1).some((n) => n > 59)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Lê vídeo e intervalo da `origem` (texto livre). Intervalo invertido ou vazio sai `null`. */
export function parseTrechoOrigem(origem: string): TrechoOrigem {
  const yt = YT_RE.exec(origem);
  const iv = INTERVALO_RE.exec(origem);
  let inicioS: number | null = null;
  let fimS: number | null = null;
  if (iv) {
    const a = parseTempo(iv[1]);
    const b = parseTempo(iv[2]);
    if (a !== null && b !== null && b > a) {
      inicioS = a;
      fimS = b;
    }
  }
  return { youtubeId: yt ? yt[1] : null, inicioS, fimS };
}

/**
 * Os trechos inseridos do roteiro (`_internal/roteiro-falas.json`). Roteiro
 * ausente = `[]`; ilegível = `[]` com aviso. Fala com `trechoInserido` fora do
 * horizontal fica fora (o validador do roteiro já recusa).
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
    const ti = f?.trechoInserido as { origem?: unknown; texto?: unknown } | null | undefined;
    if (!f || !ti || typeof f.id !== "string" || typeof f.texto !== "string") continue;
    if (typeof ti.origem !== "string" || !ti.origem.trim() || typeof ti.texto !== "string" || !ti.texto.trim()) {
      warn(`fala ${f.id}: trechoInserido sem origem ou texto, fora do XML (#13437)`);
      continue;
    }
    if (Array.isArray(f.videos) && !f.videos.includes("horizontal")) continue;
    out.push({ id: f.id, texto: f.texto, origem: ti.origem.trim(), trecho: ti.texto.trim() });
  }
  return out;
}

/** Um marcador do trecho no `<sequence>`, em quadros da sequência. */
export interface TrechoInseridoMarker {
  id: string;
  origem: string;
  trecho: string;
  /** Quadro em que a fala termina: onde o trecho entra. */
  at: number;
  parsed: TrechoOrigem;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Marcadores do xmeml (`trecho {id}`), de 1 quadro, no ponto de inserção. O
 * comentário leva a origem e o texto do trecho, para o editor achar o clipe.
 */
export function trechoInseridoMarkersXml(markers: readonly TrechoInseridoMarker[]): string {
  return markers
    .map((m) => `<marker><name>${escapeXml(`trecho ${m.id}`)}</name><comment>${escapeXml(`${m.origem}: "${m.trecho}"`)}</comment><in>${m.at}</in><out>${m.at + 1}</out></marker>\n`)
    .join("");
}

/** Linha da `[premissa]` (ou do `[aviso]`, sem intervalo legível) de um marcador. */
export function trechoInseridoLine(m: TrechoInseridoMarker, fps: number): { level: "premissa" | "aviso"; text: string } {
  const at = (m.at / fps).toFixed(1);
  const { inicioS, fimS, youtubeId } = m.parsed;
  const video = youtubeId ? `vídeo youtu.be/${youtubeId}` : "vídeo sem link do YouTube na origem";
  if (inicioS === null || fimS === null) {
    return {
      level: "aviso",
      text: `trecho inserido depois da fala ${m.id} (${at} s): origem "${m.origem}" sem intervalo legível (ex.: "3:42 a 4:00"); o marcador vai no XML e a duração do trecho fica fora da conta (#13437)`,
    };
  }
  return {
    level: "premissa",
    text: `trecho inserido depois da fala ${m.id}, em ${at} s (marcador "trecho ${m.id}"): ${video}, ${inicioS}–${fimS} s, soma ${(fimS - inicioS).toFixed(1)} s ao horizontal; inserir o clipe à mão no Premiere (#13437)`,
  };
}
