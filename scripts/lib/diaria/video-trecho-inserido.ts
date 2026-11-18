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
 * PR 2 da #13437: o clipe cortado do export do vídeo de origem
 * (`TrechoInseridoClip`, achado por `video-trecho-fonte.ts` e cortado no
 * `build`) entra no XML numa faixa própria (vídeo e áudio, clipitems
 * `trecho-{seq}-v{n}`/`trecho-{seq}-a{n}` com o nome `trecho {fala}`, label
 * de cor e o marcador cobrindo o clipe), logo depois
 * da fala. A sequência abre espaço para ele (`trechoRipple`): o que vem
 * depois da fala anda a duração do trecho, só no XML. O plano (`plan.json`)
 * segue sem o trecho, e a prévia também; o `verify-xml` desfaz o deslocamento
 * (`unrippleXmlClips`) antes de conferir o XML contra o plano. Trecho sem
 * fonte fica só no marcador, como antes, com aviso.
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
  /** Duração do marcador em quadros (a do clipe inserido); ausente = 1 quadro, só o ponto de inserção. */
  frames?: number;
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Marcadores do xmeml (`trecho {id}`), de 1 quadro, no ponto de inserção. O
 * comentário leva vídeo, intervalo e o texto do trecho, para o editor achar o clipe.
 */
export function trechoInseridoMarkersXml(markers: readonly TrechoInseridoMarker[]): string {
  return markers
    .map((m) => `<marker><name>${escapeXml(`trecho ${m.id}`)}</name><comment>${escapeXml(`${rotuloTrecho(m.trecho)}: "${m.trecho.texto}"`)}</comment><in>${m.at}</in><out>${m.at + Math.max(1, m.frames ?? 1)}</out></marker>\n`)
    .join("");
}

/**
 * Linha da `[premissa]` de um marcador: o formato estruturado garante vídeo e
 * intervalo (#13437). Com `clip`, o clipe já está no XML (PR 2); sem ele, o
 * clipe entra à mão no Premiere, no marcador.
 */
export function trechoInseridoLine(
  m: TrechoInseridoMarker,
  fps: number,
  clip?: Pick<TrechoInseridoClip, "path" | "frames" | "fonte"> | null,
): { level: "premissa"; text: string } {
  const at = (m.at / fps).toFixed(1);
  const { inicioS, fimS, youtubeId, edicao, migrado } = m.trecho;
  const video = youtubeId ? `vídeo youtu.be/${youtubeId}` : `vídeo da edição ${edicao}`;
  const antigo = migrado ? "; o roteiro usa o formato antigo (origem em texto livre): migrar com scripts/migrar-trecho-inserido.ts" : "";
  const onde = clip
    ? `soma ${(clip.frames / fps).toFixed(1)} s ao horizontal no XML: clipe ${baseName(clip.path)} (cortado de ${clip.fonte}) na faixa própria "trecho", e o que vem depois da fala anda essa duração; a prévia e o plan.json seguem sem o trecho; conferir no 1º import (#13437)`
    : `soma ${(fimS - inicioS).toFixed(1)} s ao horizontal; inserir o clipe à mão no Premiere (#13437)`;
  return {
    level: "premissa",
    text: `trecho inserido depois da fala ${m.id}, em ${at} s (marcador "trecho ${m.id}"): ${video}, ${fmtTempoTrecho(inicioS)} a ${fmtTempoTrecho(fimS)}, ${onde}${antigo}`,
  };
}

const baseName = (p: string): string => p.replace(/\\/g, "/").split("/").pop() ?? p;

/**
 * O clipe de um trecho inserido, cortado do export do vídeo de origem e pronto
 * para o XML (#13437, PR 2). O arquivo já sai no tamanho e no fps da
 * sequência (escala 100%, in/out em quadros da sequência).
 */
export interface TrechoInseridoClip {
  /** Id da fala depois da qual o trecho entra. */
  id: string;
  /** Quadro do PLANO (sem trecho nenhum) em que a fala termina: onde o trecho entra. */
  at: number;
  /** Duração do clipe, em quadros da sequência. */
  frames: number;
  /** O arquivo cortado, no disco desta máquina. */
  path: string;
  /** O caminho que o XML aponta (traduzido para o Premiere no `url()`). */
  xmlPath: string;
  width: number;
  height: number;
  /** O vídeo de origem, como o roteiro o cita (`youtu.be/ID` ou AAMMDD). */
  video: string;
  inicioS: number;
  fimS: number;
  /** O arquivo de origem de onde o clipe foi cortado (para o relato). */
  fonte: string;
}

/** Quadros da sequência de um intervalo do vídeo de origem (o corte recodifica em CFR no fps da sequência). */
export function trechoClipFrames(inicioS: number, fimS: number, fps: number): number {
  return Math.max(0, Math.round((fimS - inicioS) * fps));
}

/** Onde cada trecho fica no XML, e como os quadros do plano andam com eles. */
export interface TrechoRipple {
  /** Os clipes na ordem do XML, com o quadro de início no XML (`pos`). */
  placed: Array<{ clip: TrechoInseridoClip; pos: number }>;
  /** Quadros somados à sequência. */
  total: number;
  /** Quadro de INÍCIO do plano levado ao XML: um início no ponto de inserção anda (é o que vem depois da fala). */
  start: (f: number) => number;
  /** Quadro de FIM do plano levado ao XML: um fim no ponto de inserção fica (é a fala que termina ali). */
  end: (f: number) => number;
}

/**
 * O deslocamento dos trechos na sequência: cada trecho abre `frames` quadros
 * no ponto `at` do plano, e tudo que começa a partir dali anda. Ordem pelo
 * `at` (empate: a ordem recebida, a do roteiro). Trecho de 0 quadro fica fora.
 */
export function trechoRipple(clips: readonly TrechoInseridoClip[]): TrechoRipple {
  const sorted = clips
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.frames > 0)
    .sort((a, b) => a.c.at - b.c.at || a.i - b.i)
    .map((x) => x.c);
  const placed: TrechoRipple["placed"] = [];
  let acc = 0;
  for (const clip of sorted) {
    placed.push({ clip, pos: clip.at + acc });
    acc += clip.frames;
  }
  const sum = (pred: (at: number) => boolean) => sorted.reduce((k, c) => k + (pred(c.at) ? c.frames : 0), 0);
  return { placed, total: acc, start: (f) => f + sum((at) => at <= f), end: (f) => f + sum((at) => at < f) };
}

/** O mínimo de um clipe do plano que o deslocamento mexe (o `PlannedClip` de `video-montage.ts`). */
export interface RippleableClip {
  seqStart: number;
  seqEnd: number;
  frameIn: number;
  frameOut: number;
  srcIn: number;
  srcOut: number;
}

/**
 * Parte os clipes do plano nos pontos de inserção que caem DENTRO deles (itens
 * contíguos no bruto viram um clipe só, e a fala pode terminar no meio dele).
 * As partes seguem do mesmo arquivo, com a mídia emendada.
 */
export function splitClipsAt<C extends RippleableClip>(clips: readonly C[], ats: readonly number[], fps: number): C[] {
  const out: C[] = [];
  const round3 = (x: number) => Math.round(x * 1000) / 1000;
  for (const c of clips) {
    const cuts = [...new Set(ats.filter((a) => a > c.seqStart && a < c.seqEnd))].sort((a, b) => a - b);
    if (!cuts.length) {
      out.push(c);
      continue;
    }
    const edges = [c.seqStart, ...cuts, c.seqEnd];
    for (let k = 0; k + 1 < edges.length; k++) {
      const s = edges[k];
      const e = edges[k + 1];
      out.push({
        ...c,
        seqStart: s,
        seqEnd: e,
        frameIn: c.frameIn + (s - c.seqStart),
        frameOut: c.frameIn + (e - c.seqStart),
        srcIn: k === 0 ? c.srcIn : round3(c.srcIn + (s - c.seqStart) / fps),
        srcOut: k === edges.length - 2 ? c.srcOut : round3(c.srcIn + (e - c.seqStart) / fps),
      });
    }
  }
  return out;
}

/**
 * O plano como o XML o leva com os trechos (#13437, PR 2): clipes partidos no
 * ponto de inserção, deslocados pelo `trechoRipple`, e a duração somada. Sem
 * trecho, o mesmo plano (o XML de antes).
 */
export function planComTrechos<C extends RippleableClip, P extends { clips: C[]; durationFrames: number }>(
  plan: P,
  clips: readonly TrechoInseridoClip[],
  fps: number,
): { plan: P; ripple: TrechoRipple } {
  const ripple = trechoRipple(clips);
  if (!ripple.placed.length) return { plan, ripple };
  const split = splitClipsAt(plan.clips, ripple.placed.map((p) => p.clip.at), fps);
  const moved = split.map((c) => ({ ...c, seqStart: ripple.start(c.seqStart), seqEnd: ripple.end(c.seqEnd) }));
  return { plan: { ...plan, clips: moved, durationFrames: plan.durationFrames + ripple.total }, ripple };
}

/**
 * As faixas do trecho no XML: uma de vídeo e uma de áudio, um clipitem por
 * trecho, linkados, com label de cor (`Mango`) e o nome `trecho {id}` (a
 * marca no Premiere, junto do marcador que cobre o clipe).
 */
export function trechoInseridoTracksXml(input: {
  placed: TrechoRipple["placed"];
  rate: string;
  idPrefix: string;
  url: (p: string) => string;
  /** Índice (1-based) da faixa de áudio do trecho entre as faixas de áudio da sequência, para o `<link>`. */
  audioTrackIndex: number;
}): { video: string; audio: string } {
  if (!input.placed.length) return { video: "", audio: "" };
  const v: string[] = [];
  const a: string[] = [];
  input.placed.forEach(({ clip, pos }, n) => {
    const vid = `${input.idPrefix}-v${n + 1}`;
    const aid = `${input.idPrefix}-a${n + 1}`;
    const fileId = `file-${input.idPrefix}-${n + 1}`;
    const head =
      `<name>${escapeXml(`trecho ${clip.id}`)}</name><enabled>TRUE</enabled><duration>${clip.frames}</duration>\n` +
      `${input.rate}<start>${pos}</start><end>${pos + clip.frames}</end><in>0</in><out>${clip.frames}</out>\n`;
    const file =
      `<file id="${fileId}"><name>${escapeXml(baseName(clip.xmlPath))}</name><pathurl>${escapeXml(input.url(clip.xmlPath))}</pathurl>\n` +
      `${input.rate}<duration>${clip.frames}</duration>\n` +
      `<media><video><samplecharacteristics><width>${clip.width}</width><height>${clip.height}</height></samplecharacteristics></video>\n` +
      `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`;
    const links =
      `<link><linkclipref>${vid}</linkclipref><mediatype>video</mediatype></link>` +
      `<link><linkclipref>${aid}</linkclipref><mediatype>audio</mediatype><trackindex>${input.audioTrackIndex}</trackindex><clipindex>${n + 1}</clipindex></link>`;
    const label = "<labels><label2>Mango</label2></labels>";
    v.push(`<clipitem id="${vid}">${head}${file}\n${label}${links}</clipitem>`);
    a.push(`<clipitem id="${aid}">${head}<file id="${fileId}"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>\n${label}${links}</clipitem>`);
  });
  return { video: `\n<track>${v.join("\n")}</track>`, audio: `<track>${a.join("\n")}</track>` };
}

/**
 * `verify-xml` com trecho inserido (#13437, PR 2): os clipes de áudio da faixa
 * principal voltam ao tempo do plano (tira a duração de cada trecho que
 * termina antes do clipe), e o clipe que o build partiu no ponto de inserção
 * volta a ser um só (mesmo `<file>`, mídia emendada). Só junta nos pontos que
 * caem DENTRO de um clipe do plano (`planClips`, os mesmos que `splitClipsAt`
 * parte): dois clipes do plano que já eram contíguos no ponto seguem dois.
 * Sem trecho, os mesmos clipes.
 */
export function unrippleXmlClips<C extends { start: number; end: number; in: number; out: number; fileId: string }>(
  clips: readonly C[],
  trechos: readonly TrechoInseridoClip[],
  planClips: ReadonlyArray<Pick<RippleableClip, "seqStart" | "seqEnd">>,
): C[] {
  const ripple = trechoRipple(trechos);
  if (!ripple.placed.length) return [...clips];
  const ats = new Set(ripple.placed.map((p) => p.clip.at).filter((a) => planClips.some((c) => a > c.seqStart && a < c.seqEnd)));
  const out: C[] = [];
  for (const c of clips) {
    const shift = ripple.placed.reduce((k, p) => k + (p.pos + p.clip.frames <= c.start ? p.clip.frames : 0), 0);
    const back = { ...c, start: c.start - shift, end: c.end - shift };
    const prev = out[out.length - 1];
    if (prev && prev.end === back.start && ats.has(back.start) && prev.fileId === back.fileId && prev.out === back.in) {
      prev.end = back.end;
      prev.out = back.out;
    } else out.push(back);
  }
  return out;
}

/** Um trecho do roteiro com a fonte achada (ou os lugares onde ela foi procurada), para o `roteiro.md`. */
export interface TrechoComFonte {
  id: string;
  trecho: TrechoInseridoLido;
  fonte: string | null;
  procurado: readonly string[];
}

/**
 * A seção do `roteiro.md` da montagem (#13437): cada trecho do horizontal, a
 * fonte (ou onde ela foi procurada) e quanto ele soma à duração. Sem trecho, vazio.
 */
export function trechosInseridosSection(trechos: readonly TrechoComFonte[]): string[] {
  if (!trechos.length) return [];
  const dur = (xs: readonly TrechoComFonte[]) => xs.reduce((k, t) => k + (t.trecho.fimS - t.trecho.inicioS), 0);
  // Só o trecho com fonte entra no XML: o sem fonte fica no marcador, e a duração dele só soma se o editor o puser à mão.
  const comFonte = trechos.filter((t) => t.fonte);
  const semFonte = trechos.length - comFonte.length;
  const soma = semFonte
    ? `${dur(comFonte).toFixed(1)} s somados ao horizontal no XML (até ${dur(trechos).toFixed(1)} s com ${semFonte === 1 ? "o trecho sem fonte inserido" : `os ${semFonte} trechos sem fonte inseridos`} à mão)`
    : `${dur(trechos).toFixed(1)} s somados ao horizontal`;
  const lines = [
    "## Trechos inseridos (horizontal)",
    "",
    `${trechos.length} trecho(s) de outro vídeo, ${soma}, fora da duração do plano acima: o build corta cada um do export do vídeo de origem e o põe no XML, numa faixa própria, logo depois da fala (#13437).`,
    "",
  ];
  for (const t of trechos) {
    const d = (t.trecho.fimS - t.trecho.inicioS).toFixed(1);
    const fonte = t.fonte
      ? `fonte: ${t.fonte}`
      : `**[aviso] fonte não encontrada** (procurado: ${t.procurado.join("; ") || "nada"}); o build deixa só o marcador: passar --trecho-fonte "${t.id}=caminho"`;
    lines.push(`- depois da fala ${t.id}: ${rotuloTrecho(t.trecho)} (${d} s), "${t.trecho.texto}"; ${fonte}`);
  }
  return lines;
}
