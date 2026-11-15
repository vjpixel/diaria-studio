/**
 * Capa no começo dos verticais (#13123, opção a da issue, em TESTE).
 *
 * Proposta do editor (15/11/2026, roteiro da 261116): a capa ser o 1º frame do
 * vertical, para as redes sem controle de capa (TikTok, Facebook, LinkedIn,
 * Threads, X) escolherem esse frame como capa padrão. A issue pede teste em
 * 2 ou 3 edições antes de virar regra, então isto é OPT-IN por edição:
 * `"capaInicio": true` (ou um número de ms) no `blocks.json`. Sem o campo, o
 * build sai como antes.
 *
 * Opção (a), a preferida: sobrepor o texto da capa nos primeiros frames da
 * fala de abertura, sem cortar nem atrasar o áudio. O que entra é o painel
 * escuro + o gancho da capa do Short (`composeShortCoverOverlay`, mesmo
 * desenho do `04-youtube-short-capa.jpg`), num PNG transparente do tamanho da
 * sequência, numa faixa de vídeo acima de todas, do quadro 0 até
 * `CAPA_INICIO.defaultMs`. O fundo é o próprio vídeo (o rosto do editor no
 * alto), não a foto da capa: a capa JPG só existe depois da montagem (ela sai
 * de um frame do vertical exportado, no `/diaria-publica`).
 *
 * Só nas sequências verticais (vertical da edição e cortes, como o `guia`). O
 * horizontal tem capa pela API e fica como está.
 *
 * Texto da capa, nesta ordem: `capa` da sequência no `blocks.json`; `capa` do
 * arquivo (só a vertical da edição, sem corte); o `porVideo.*.capa` do
 * `_internal/roteiro-falas.json` (vertical 1 para a vertical da edição,
 * vertical 2 para o corte `guia`). Sem texto = a sequência sai sem a capa, com
 * aviso.
 *
 * Puro: só monta texto (nome de arquivo, clipitem do xmeml, argumentos do
 * ffmpeg da prévia, conferência do XML). Quem rasteriza é o `build` de
 * `video-montagem.ts`.
 */

/** Tempos da capa no começo (ms). */
export const CAPA_INICIO = {
  /** Duração default: o fim da faixa de 0,2 a 0,3 s da issue, para o frame não piscar. */
  defaultMs: 300,
  minMs: 100,
  /** Teto: mais que isto atrasa o gancho visual (a regra do gancho em ~3 s, #13116). */
  maxMs: 1000,
} as const;

/**
 * Valida o `capaInicio` do `blocks.json`: `true`/`false`, ou um inteiro de ms
 * entre `CAPA_INICIO.minMs` e `CAPA_INICIO.maxMs`. Lista de erros (vazia = ok).
 */
export function validateCapaInicio(raw: unknown): string[] {
  if (raw === undefined || typeof raw === "boolean") return [];
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= CAPA_INICIO.minMs && raw <= CAPA_INICIO.maxMs) return [];
  return [`capaInicio precisa ser true/false ou um inteiro de ms entre ${CAPA_INICIO.minMs} e ${CAPA_INICIO.maxMs} (#13123)`];
}

/** Duração pedida (ms), ou null quando a capa no começo está desligada (ausente ou `false`). */
export function capaInicioMsOf(raw: boolean | number | undefined): number | null {
  if (raw === true) return CAPA_INICIO.defaultMs;
  if (typeof raw === "number") return raw;
  return null;
}

/** Quadros da capa numa sequência de `fps`: pelo menos 1, nunca mais que a sequência. */
export function capaInicioFrames(fps: number, ms: number, durationFrames?: number): number {
  const n = Math.max(1, Math.round((ms / 1000) * fps));
  return durationFrames !== undefined ? Math.max(0, Math.min(n, durationFrames)) : n;
}

/** De onde veio o texto da capa de uma sequência. */
export type CapaInicioTextSource = "sequencia" | "blocks" | "roteiro-vertical1" | "roteiro-vertical2";

/**
 * O texto da capa de uma sequência vertical. `corteVertical2` = o slug do
 * corte que é o vertical 2 do roteiro (`guia`). Sem texto = `text: null`.
 */
export function resolveCapaInicioText(input: {
  spec: { corte?: string; capa?: string };
  fileCapa?: string;
  roteiro?: { vertical1?: string; vertical2?: string } | null;
  corteVertical2: string;
}): { text: string; how: CapaInicioTextSource } | { text: null } {
  const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const own = clean(input.spec.capa);
  if (own) return { text: own, how: "sequencia" };
  if (input.spec.corte === undefined) {
    const file = clean(input.fileCapa);
    if (file) return { text: file, how: "blocks" };
    const r1 = clean(input.roteiro?.vertical1);
    if (r1) return { text: r1, how: "roteiro-vertical1" };
    return { text: null };
  }
  if (input.spec.corte === input.corteVertical2) {
    const r2 = clean(input.roteiro?.vertical2);
    if (r2) return { text: r2, how: "roteiro-vertical2" };
  }
  return { text: null };
}

/** A capa que o XML de uma sequência leva (gravada no `plan.json`, em `xmlAssets`). */
export interface CapaInicioAsset {
  /** PNG no out dir desta máquina (o que a prévia lê). */
  path: string;
  /** O mesmo PNG no caminho que o Premiere abre (a pasta da edição, ao lado do bruto). */
  xmlPath: string;
  width: number;
  height: number;
  /** Quadros da capa no começo da sequência. */
  frames: number;
  /** Duração pedida, em ms (a efetiva é `frames / fps`). */
  ms: number;
  /** O texto da capa, como foi desenhado. */
  text: string;
}

/** Nome do PNG na pasta da edição; `hash` identifica o desenho (um XML antigo segue achando o PNG dele). */
export function capaInicioFileName(edition: string, corte: string | undefined, hash: string): string {
  return `${edition}_capa_inicio${corte ? `-${corte}` : ""}-${hash}.png`;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * A faixa de vídeo da capa (#13123): um clipitem do quadro 0 até
 * `asset.frames`, acima de todas as outras faixas. PNG parado: a `<duration>`
 * do arquivo é longa (`total`, a do bruto, como o PNG do título) e o in/out
 * recorta. Sem áudio. `fileDefined` = o `<file>` deste PNG já saiu antes no
 * documento (referência curta).
 */
export function capaInicioTrack(input: { asset: CapaInicioAsset; rate: string; total: number; id: string; fileId: string; fileDefined: boolean; pathurl: string }): string {
  const { asset, rate, total, id, fileId } = input;
  const len = asset.frames;
  if (len <= 0) return "";
  const name = asset.xmlPath.replace(/\\/g, "/").split("/").pop() ?? asset.xmlPath;
  const file = input.fileDefined
    ? `<file id="${fileId}"/>`
    : `<file id="${fileId}"><name>${escapeXml(name)}</name><pathurl>${escapeXml(input.pathurl)}</pathurl>\n${rate}<duration>${total}</duration>\n` +
      `<media><video><samplecharacteristics><width>${asset.width}</width><height>${asset.height}</height></samplecharacteristics></video></media></file>`;
  return (
    `\n<track><clipitem id="${id}"><name>capa-inicio</name><enabled>TRUE</enabled><duration>${total}</duration>\n` +
    `${rate}<start>0</start><end>${len}</end><in>0</in><out>${len}</out>\n${file}</clipitem></track>`
  );
}

/** Lê do XML a capa do começo (`<clipitem id="capa-inicio-…">`): início e fim em quadros; ausente = null. */
export function parseCapaInicioClip(xml: string): { start: number; end: number } | null {
  const m = /<clipitem id="capa-inicio-[^"]*">[\s\S]*?<start>(\d+)<\/start><end>(\d+)<\/end>/.exec(xml);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

/**
 * `verify-xml` com a capa (#13123): esperada = começa no quadro 0 e dura os
 * quadros do plano; não esperada (build sem `capaInicio`) e presente no XML =
 * o XML não é o do plano. Puro.
 */
export function capaInicioXmlIssues(xml: string, expectedFrames: number | null): string[] {
  const clip = parseCapaInicioClip(xml);
  if (expectedFrames === null) return clip ? ["capa no começo no XML, mas o plano não tem (XML de outro build?) (#13123)"] : [];
  if (!clip) return ["capa no começo ausente no XML (o plano tem capaInicio): rode build de novo (#13123)"];
  const out: string[] = [];
  if (clip.start !== 0) out.push(`capa no começo começa no quadro ${clip.start}, não no 0 (#13123)`);
  if (Math.abs(clip.end - clip.start - expectedFrames) > 1) out.push(`capa no começo com ${clip.end - clip.start} quadros no XML, ${expectedFrames} no plano (#13123)`);
  return out;
}

/**
 * ffmpeg da prévia (#13123): a capa (PNG com alfa) por cima dos primeiros
 * `frames` quadros da prévia montada, escalada para o tamanho da prévia, com
 * o áudio copiado (a capa não mexe no som). O PNG é uma imagem só: o overlay
 * repete o último quadro dela e o `enable` limita aos primeiros quadros.
 */
export function previewCapaInicioArgs(input: { input: string; png: string; out: string; frames: number; width: number; height: number }): string[] {
  const n = Math.max(1, Math.round(input.frames));
  return [
    "-y", "-v", "error",
    "-i", input.input,
    "-i", input.png,
    "-filter_complex", `[1:v]scale=${input.width}:${input.height},format=rgba[capa];[0:v][capa]overlay=0:0:enable='lt(n,${n})'[v]`,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy",
    input.out,
  ];
}
