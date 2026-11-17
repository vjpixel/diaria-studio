/**
 * 2º leitor independente do XML no `verify-xml` (#13372, R5 da #13199).
 *
 * O `verify-xml` é código nosso lendo XML nosso (`parseXmlAudio`): um erro de
 * interpretação comum ao gerador (`buildXmeml`) e ao leitor passa sem
 * acusação. Aqui o mesmo arquivo é lido pelo adapter FCP7 (`fcp_xml`) do
 * OpenTimelineIO (`scripts/video/otio_read_xml.py`), uma biblioteca de
 * referência da indústria, e o resultado é comparado com o do leitor próprio:
 * número de clipes de áudio da fala, in/out de cada um (na sequência e na
 * mídia), fim do áudio, duração total da sequência e taxa de quadros.
 *
 * O gerador xmeml próprio continua: o OTIO não modela zoom, Audio Levels,
 * título, vinheta, card e marcadores, então ele só confere a estrutura.
 *
 * Fail-soft e NÃO bloqueante, por decisão do editor (briefing 261117b):
 *   - sem OpenTimelineIO (ou sem o `otio-fcp-adapter`) no Python, o
 *     verify-xml avisa uma vez e segue (`indisponivel`);
 *   - XML que o adapter não entende (extensão que usamos e ele não modela)
 *     vira `erro` com aviso, nunca `exit 1`;
 *   - divergência entre os dois leitores sai como `[aviso]` e em
 *     `verify-xml.json` (`otio`), sem somar aos problemas que reprovam o XML.
 */

import { spawnSync } from "node:child_process";
import type { ParsedXmlAudio } from "./video-xml-verify.ts";

/** Um item de faixa como o `otio_read_xml.py` devolve (quadros inteiros na taxa da sequência). */
export interface OtioItem {
  type: string;
  name?: string;
  /** Na sequência. */
  recStart: number;
  recEnd: number;
  /** Na mídia (só clipe). */
  srcStart?: number;
  srcEnd?: number;
  url?: string | null;
}

export interface OtioTrack {
  /** `Video` ou `Audio` (`otio.schema.TrackKind`). */
  kind: string;
  name?: string;
  items: OtioItem[];
}

export interface OtioTimeline {
  name: string;
  durationFrames: number;
  rate: number;
  tracks: OtioTrack[];
}

export type OtioReadResult =
  | { ok: true; version: string; timelines: OtioTimeline[] }
  | { ok: false; reason: string; missingModule: boolean };

export interface OtioCheck {
  /** `ok` = o OTIO leu e foi comparado; `indisponivel` = sem OTIO/adapter neste Python; `erro` = o adapter não leu o XML. */
  status: "ok" | "indisponivel" | "erro";
  version?: string;
  reason?: string;
  /** Clipes de áudio da fala pelo OTIO (pedaços contíguos remontados). */
  clips?: number;
  divergences: string[];
}

/** Clipe de áudio da fala pelo OTIO, no mesmo formato do leitor próprio. */
export interface OtioSpeechClip {
  start: number;
  end: number;
  in: number;
  out: number;
  url: string | null;
}

/** Quantas divergências de clipe listar por sequência; o resto vira "e mais N". */
export const OTIO_MAX_CLIP_LINES = 5;

/**
 * Pure: lê o stdout do `otio_read_xml.py` (um JSON na última linha não vazia).
 * Saída ilegível vira `ok: false`; o código 3 do script é o "módulo ausente".
 */
export function parseOtioReaderOutput(status: number | null, stdout: string, stderr: string): OtioReadResult {
  const last = stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    const j = JSON.parse(last) as Partial<{ ok: boolean; version: string; timelines: OtioTimeline[]; reason: string; missingModule: boolean }>;
    if (j.ok === true && Array.isArray(j.timelines)) return { ok: true, version: String(j.version ?? "?"), timelines: j.timelines };
    if (j.ok === false) return { ok: false, reason: String(j.reason ?? "sem motivo"), missingModule: j.missingModule === true || status === 3 };
  } catch {
    // cai no retorno abaixo
  }
  const tail = (stderr.trim() || stdout.trim()).slice(-300);
  return { ok: false, reason: `saída do 2º leitor ilegível (exit ${status ?? "?"})${tail ? `: ${tail}` : ""}`, missingModule: status === 3 };
}

/** Pure: a sequência do XML (o build grava uma por arquivo); com várias, a de mesmo nome, senão a 1ª. */
export function pickOtioTimeline(timelines: readonly OtioTimeline[], name?: string): OtioTimeline | null {
  if (!timelines.length) return null;
  return (name ? timelines.find((t) => t.name === name) : undefined) ?? timelines[0];
}

/**
 * Pure: os clipes da 1ª faixa de áudio (a da fala; a vinheta tem faixa
 * própria depois dela), sem os gaps. Pedaço contíguo ao anterior na
 * sequência E na mídia, da mesma mídia, volta a ser um clipe só: o clipe
 * partido sob a vinheta (#13249) é um clipe no plano, e um corte de verdade
 * nunca emenda na mídia. É a mesma regra do leitor próprio, aplicada aqui só
 * com o que o OTIO leu (sem os ids `a{n}-2` do nosso gerador).
 */
export function otioSpeechClips(tl: OtioTimeline): OtioSpeechClip[] | null {
  const track = tl.tracks.find((t) => t.kind === "Audio");
  if (!track) return null;
  const out: OtioSpeechClip[] = [];
  for (const it of track.items) {
    if (it.type !== "clip" || it.srcStart === undefined || it.srcEnd === undefined) continue;
    const c: OtioSpeechClip = { start: it.recStart, end: it.recEnd, in: it.srcStart, out: it.srcEnd, url: it.url ?? null };
    const prev = out[out.length - 1];
    if (prev && prev.url === c.url && prev.end === c.start && prev.out === c.in) {
      prev.end = c.end;
      prev.out = c.out;
    } else out.push(c);
  }
  return out;
}

/**
 * Pure: as divergências entre o OTIO e o leitor próprio (`parseXmlAudio`) no
 * mesmo XML. `expectedTotalFrames` = duração da sequência que o verify-xml
 * espera (plano + card de CTA, #12571); ausente = não compara o total.
 */
export function compareOtioWithOwn(own: ParsedXmlAudio, tl: OtioTimeline, expectedTotalFrames?: number): string[] {
  const out: string[] = [];
  if (Math.abs(tl.rate - own.rate) > 0.01) out.push(`taxa ${tl.rate.toFixed(3)} fps pelo OTIO, ${own.rate.toFixed(3)} pelo leitor próprio`);
  const speech = otioSpeechClips(tl);
  if (!speech) return [...out, "o OTIO não achou faixa de áudio na sequência"];
  if (speech.length !== own.clips.length) out.push(`${speech.length} clipes de áudio pelo OTIO, ${own.clips.length} pelo leitor próprio`);
  const clipLines: string[] = [];
  for (let i = 0; i < Math.min(speech.length, own.clips.length); i++) {
    const a = speech[i];
    const b = own.clips[i];
    if (a.start !== b.start || a.end !== b.end || a.in !== b.in || a.out !== b.out) {
      clipLines.push(`clipe ${i + 1}: OTIO lê sequência ${a.start}–${a.end}, mídia ${a.in}–${a.out}; leitor próprio ${b.start}–${b.end}, ${b.in}–${b.out}`);
    }
  }
  out.push(...clipLines.slice(0, OTIO_MAX_CLIP_LINES));
  if (clipLines.length > OTIO_MAX_CLIP_LINES) out.push(`e mais ${clipLines.length - OTIO_MAX_CLIP_LINES} clipe(s) com in/out divergente`);
  const otioEnd = speech[speech.length - 1]?.end ?? 0;
  const ownEnd = own.clips[own.clips.length - 1]?.end ?? 0;
  if (otioEnd !== ownEnd) out.push(`áudio da fala termina no quadro ${otioEnd} pelo OTIO, ${ownEnd} pelo leitor próprio`);
  if (expectedTotalFrames !== undefined && Math.abs(tl.durationFrames - expectedTotalFrames) > 1) {
    out.push(`sequência com ${tl.durationFrames} quadros pelo OTIO, ${expectedTotalFrames} esperados (plano + card de CTA)`);
  }
  return out;
}

export type OtioSpawn = (python: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

const defaultSpawn: OtioSpawn = (python, args) => {
  const r = spawnSync(python, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/**
 * Roda o 2º leitor num XML e compara com o leitor próprio. Nunca lança:
 * Python ausente, OTIO ausente e XML ilegível para o adapter viram status.
 */
export function otioCrossCheck(
  own: ParsedXmlAudio,
  xmlPath: string,
  opts: { python: string; script: string; sequenceName?: string; expectedTotalFrames?: number; spawn?: OtioSpawn },
): OtioCheck {
  const r = (opts.spawn ?? defaultSpawn)(opts.python, ["-P", opts.script, xmlPath]);
  if (r.error) return { status: "indisponivel", reason: `Python ${opts.python} não rodou (${r.error.message})`, divergences: [] };
  const read = parseOtioReaderOutput(r.status, r.stdout, r.stderr);
  if (!read.ok) return { status: read.missingModule ? "indisponivel" : "erro", reason: read.reason, divergences: [] };
  const tl = pickOtioTimeline(read.timelines, opts.sequenceName);
  if (!tl) return { status: "erro", version: read.version, reason: "o OTIO não achou sequência no XML", divergences: [] };
  return {
    status: "ok",
    version: read.version,
    clips: otioSpeechClips(tl)?.length ?? 0,
    divergences: compareOtioWithOwn(own, tl, opts.expectedTotalFrames),
  };
}

/** Python do 2º leitor: `DIARIA_OTIO_PYTHON` quando definido, senão o da montagem. */
export function resolveOtioPython(env: string | undefined, montagePython: string): string {
  return env && env.trim() ? env.trim() : montagePython;
}

/**
 * Pure: as linhas que o verify-xml imprime para uma sequência. `aviso` vai
 * como `[aviso]`; `info` como linha normal. Nenhuma reprova o XML.
 */
export function otioCheckLines(check: OtioCheck): { level: "info" | "aviso"; text: string }[] {
  if (check.status === "indisponivel") {
    return [{ level: "aviso", text: `2º leitor (OpenTimelineIO) indisponível: ${check.reason}; opcional, instalar com pip install -r scripts/video/otio-requirements.txt no Python de DIARIA_OTIO_PYTHON ou da montagem (#13372)` }];
  }
  if (check.status === "erro") {
    return [{ level: "aviso", text: `2º leitor (OpenTimelineIO${check.version ? ` ${check.version}` : ""}) não leu o XML: ${check.reason}; não bloqueia (o adapter FCP7 não modela todas as extensões do nosso XML, #13372)` }];
  }
  if (!check.divergences.length) {
    return [{ level: "info", text: `2º leitor (OpenTimelineIO ${check.version}) concorda: ${check.clips} clipe(s) de áudio, in/out e duração (#13372)` }];
  }
  return check.divergences.map((d) => ({ level: "aviso" as const, text: `2º leitor (OpenTimelineIO ${check.version}) diverge: ${d}; conferir o XML no Premiere, não bloqueia (#13372)` }));
}
