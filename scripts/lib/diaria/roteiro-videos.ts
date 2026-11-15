/**
 * scripts/lib/diaria/roteiro-videos.ts (#12751)
 *
 * O roteiro do `/diaria-video-roteiro` planeja uma gravação que rende 3 vídeos
 * (horizontal, vertical 1 "a notícia", vertical 2 "o guia") e define título e
 * texto da capa de cada um. Até o #12751 isso ficava só na página
 * (`_internal/roteiro-d1.html`): a montagem montava 2 versões sem saber quais
 * falas cada vertical usa, e a publicação usava o título do D1.
 *
 * Fonte única, em JSON: `_internal/roteiro-falas.json` (o mesmo arquivo da
 * conferência da gravação, #12754), que a skill grava junto com a página e
 * mantém em dia a cada versão. Este módulo, puro:
 *
 *   - `roteiroPecas`: título e capa de cada vídeo, para o `/diaria-publica`
 *     (o `publish-youtube.ts` usa o título do horizontal quando não há `--title`);
 *   - `propostaBlocosDoRoteiro`: a proposta de `blocks.json` para a montagem,
 *     com os `targets` de cada fala e a sequência de corte do vertical 2;
 *   - `avisosGanchoETitulo`: gancho longo no vertical e título que repete o
 *     gancho (#13116);
 *   - `resolverPeca`/`avisosDuracao`: cada vídeo na ordem dele
 *     (`porVideo.{vertical}.ordem`, #13128), com os cortes parciais por
 *     vertical (`cortes`, #13129) e a duração estimada contra o alvo do config
 *     (`publishing.video.roteiro`, #13130);
 *   - `fontesDoRoteiro`: as fontes por fala para o fact-check da montagem (#13132).
 *
 * A proposta é ponto de partida do Gate 1/Gate 2 da montagem, nunca o
 * `blocks.json` final: os tempos no bruto saem da decupagem, e quem decide é o
 * editor.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_KEYS,
  defaultSequences,
  openingBlockOf,
  type BlockKey,
  type SequenceSpec,
} from "./video-montage.ts";
import { contentWords } from "./youtube-title-research.ts";
import { cortesDaFala, validarRoteiroFalas, VIDEO_LABEL, VIDEOS_ROTEIRO, type FalaRoteiro, type PecaVideo, type RoteiroFalas, type VideoRoteiro } from "./roteiro-gravacao.ts";

/** Caminho do JSON do roteiro, relativo à pasta da edição. */
export const ROTEIRO_FALAS_FILE = "_internal/roteiro-falas.json";

/** Slug default do corte do vertical 2 na montagem ("o guia"). */
export const VERTICAL2_CORTE_SLUG = "guia";

/** O JSON lido e validado, ou o motivo de não servir. */
export type RoteiroLido = { ok: true; roteiro: RoteiroFalas } | { ok: false; problemas: string[] };

export function parseRoteiroFalas(raw: unknown): RoteiroLido {
  const problemas = validarRoteiroFalas(raw);
  return problemas.length ? { ok: false, problemas } : { ok: true, roteiro: raw as RoteiroFalas };
}

/** Título e texto da capa de cada vídeo, só os preenchidos (texto aparado). */
export function roteiroPecas(roteiro: Pick<RoteiroFalas, "porVideo">): Partial<Record<VideoRoteiro, PecaVideo>> {
  const out: Partial<Record<VideoRoteiro, PecaVideo>> = {};
  for (const v of VIDEOS_ROTEIRO) {
    const p = roteiro.porVideo?.[v];
    const titulo = p?.titulo?.trim();
    const capa = p?.capa?.trim();
    if (titulo || capa) out[v] = { ...(titulo ? { titulo } : {}), ...(capa ? { capa } : {}) };
  }
  return out;
}

/**
 * Bloco da fala numa sequência vertical: o resumo do horizontal vira o resumo
 * curto, o CTA falado vira o CTA da vertical. `abertura` não existe na
 * vertical (null: a fala fica fora com aviso).
 */
export function blocoNaVertical(bloco: BlockKey): BlockKey | null {
  if (bloco === "resumo") return "resumo_curto";
  if (bloco === "cta_yt" || bloco === "cta_ig" || bloco === "cta_out") return "cta_vertical";
  if (bloco === "abertura") return null;
  return bloco;
}

export interface FalaNaSequencia {
  id: string;
  bloco: BlockKey;
  /** O texto que vai ao ar NESTE vídeo (com os cortes parciais aplicados, #13129). */
  texto: string;
  /** Texto de tela da fala (#13120), para a montagem propor os textos de tela. */
  tela?: string;
  /** Trechos cortados neste vídeo (#13129). */
  cortes?: string[];
}

// ─── Alvos de duração (#13130) ────────────────────────────────────────────────

/** Alvos de duração dos 3 vídeos e o ritmo de fala, de `publishing.video.roteiro` no config. */
export interface AlvosRoteiro {
  palavrasPorMinuto: number;
  horizontalS: number;
  /** O horizontal avisa fora de `horizontalS ± horizontalToleranciaS`. */
  horizontalToleranciaS: number;
  vertical1S: number;
  vertical2S: number;
  /** O card de CTA, contado à parte (não é fala). */
  ctaCardS: number;
}

/** Defaults da skill (Passo 2): horizontal ~3 min, vertical 1 ~60 s, vertical 2 ~75 s, ~150 palavras/min. */
export const ALVOS_ROTEIRO_DEFAULT: AlvosRoteiro = {
  palavrasPorMinuto: 150,
  horizontalS: 180,
  horizontalToleranciaS: 30,
  vertical1S: 60,
  vertical2S: 75,
  ctaCardS: 4,
};

const ALVO_CAMPOS: Array<[keyof AlvosRoteiro, string]> = [
  ["palavrasPorMinuto", "palavras_por_minuto"],
  ["horizontalS", "horizontal_s"],
  ["horizontalToleranciaS", "horizontal_tolerancia_s"],
  ["vertical1S", "vertical1_s"],
  ["vertical2S", "vertical2_s"],
  ["ctaCardS", "cta_card_s"],
];

/** Pure: os alvos a partir do config inteiro; campo ausente = default, inválido = default com aviso. */
export function alvosRoteiroFrom(cfg: unknown): { alvos: AlvosRoteiro; avisos: string[] } {
  const alvos = { ...ALVOS_ROTEIRO_DEFAULT };
  const avisos: string[] = [];
  const sec = (cfg as { publishing?: { video?: { roteiro?: unknown } } } | null)?.publishing?.video?.roteiro;
  if (sec === undefined) return { alvos, avisos };
  if (!sec || typeof sec !== "object") return { alvos, avisos: ["publishing.video.roteiro não é objeto: alvos default (#13130)"] };
  for (const [k, campo] of ALVO_CAMPOS) {
    const v = (sec as Record<string, unknown>)[campo];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) alvos[k] = v;
    else avisos.push(`publishing.video.roteiro.${campo} inválido (${JSON.stringify(v)}): usando ${ALVOS_ROTEIRO_DEFAULT[k]} (#13130)`);
  }
  return { alvos, avisos };
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Os alvos do `platform.config.json` do repo; config ilegível = defaults com aviso (nunca lança). */
export function loadAlvosRoteiro(rootDir: string = REPO_ROOT): { alvos: AlvosRoteiro; avisos: string[] } {
  try {
    return alvosRoteiroFrom(JSON.parse(readFileSync(join(rootDir, "platform.config.json"), "utf8")));
  } catch (e) {
    return { alvos: { ...ALVOS_ROTEIRO_DEFAULT }, avisos: [`platform.config.json ilegível (${(e as Error).message}): alvos default (#13130)`] };
  }
}

export function alvoDoVideo(alvos: AlvosRoteiro, v: VideoRoteiro): number {
  return v === "horizontal" ? alvos.horizontalS : v === "vertical1" ? alvos.vertical1S : alvos.vertical2S;
}

/** Segundos estimados de fala para o texto, ao ritmo dado. */
export function segundosDeFala(texto: string, palavrasPorMinuto: number): number {
  return (palavrasDe(texto).length / palavrasPorMinuto) * 60;
}

/** "62 s" ou "3 min 22 s". */
export function formatarDuracao(s: number): string {
  const t = Math.round(s);
  if (t < 90) return `${t} s`;
  const m = Math.floor(t / 60);
  const r = t % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

// ─── Cortes parciais (#13129) ────────────────────────────────────────────────

function limparTexto(t: string): string {
  return t
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?…])/g, "$1")
    .replace(/[,;:]+([.!?…])/g, "$1")
    .replace(/^[\s,;:.]+/, "")
    .replace(/[\s,;:]+$/, "")
    .trim();
}

/**
 * Pure (#13129): o texto da fala sem os trechos cortados. `partes` são os
 * pedaços contíguos que sobram (um corte no meio deixa dois): cada um vira um
 * item no `blocks.json`, porque a montagem acha a tomada pela frase contígua.
 */
export function aplicarCortes(texto: string, trechos: readonly string[]): { texto: string; partes: string[] } {
  const ranges: Array<[number, number]> = [];
  for (const t of trechos) {
    let from = 0;
    for (;;) {
      const i = texto.indexOf(t, from);
      if (i < 0) break;
      const fim = i + t.length;
      if (!ranges.some(([a, b]) => i < b && fim > a)) {
        ranges.push([i, fim]);
        break;
      }
      from = i + 1;
    }
  }
  if (!ranges.length) return { texto, partes: [texto] };
  ranges.sort((a, b) => a[0] - b[0]);
  const pedacos: string[] = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    pedacos.push(texto.slice(pos, a));
    pos = b;
  }
  pedacos.push(texto.slice(pos));
  const junto = limparTexto(pedacos.join(" "));
  const partes = pedacos.map(limparTexto).filter((p) => /[\p{L}\p{N}]/u.test(p));
  return { texto: junto, partes: partes.length > 1 ? partes : [junto] };
}

/** Uma fala como ela entra num vídeo: ordem, cortes e reservas resolvidos. */
export interface FalaNoVideo {
  fala: FalaRoteiro;
  texto: string;
  partes: string[];
  /** Trechos cortados neste vídeo (fixos + reservas aplicadas). */
  cortes: string[];
}

export interface PecaResolvida {
  video: VideoRoteiro;
  falas: FalaNoVideo[];
  palavras: number;
  /** Fala estimada, sem o card de CTA. */
  segundos: number;
  alvoS: number;
  /** Cortes de reserva que entraram porque a estimativa passou do alvo. */
  reservasAplicadas: Array<{ id: string; trecho: string }>;
  /** Cortes de reserva que não precisaram entrar. */
  reservasNaoAplicadas: Array<{ id: string; trecho: string }>;
  /** A ordem veio de `porVideo.{v}.ordem` (#13128). */
  ordemDeclarada: boolean;
}

/** A fala entra no vídeo? No vertical, a abertura fica fora (não existe lá). */
function entraNoVideo(f: FalaRoteiro, v: VideoRoteiro): boolean {
  if (!f.videos.includes(v)) return false;
  return v === "horizontal" || !f.bloco || blocoNaVertical(f.bloco) !== null;
}

/**
 * Pure (#13128, #13129, #13130): as falas de um vídeo na ordem dele (a
 * declarada em `porVideo.{v}.ordem`, ou a do horizontal), com os cortes
 * parciais aplicados e a duração estimada. Os cortes de reserva entram um a um,
 * na ordem das falas, só enquanto a estimativa passar do alvo.
 */
export function resolverPeca(roteiro: RoteiroFalas, v: VideoRoteiro, alvos: AlvosRoteiro = ALVOS_ROTEIRO_DEFAULT): PecaResolvida {
  const ordem = v === "horizontal" ? undefined : roteiro.porVideo?.[v]?.ordem;
  const porId = new Map(roteiro.falas.map((f) => [f.id, f]));
  const base = ordem ? ordem.map((id) => porId.get(id)).filter((f): f is FalaRoteiro => Boolean(f)) : roteiro.falas;
  let falas = base.filter((f) => entraNoVideo(f, v));
  if (!ordem && v !== "horizontal") {
    // Sem ordem declarada, o vertical segue a montagem: bloco a bloco (o gancho
    // gravado à parte abre, mesmo listado no fim), e dentro do bloco a ordem do horizontal.
    const idx = (f: FalaRoteiro) => (f.bloco ? BLOCK_KEYS.indexOf(blocoNaVertical(f.bloco) ?? f.bloco) : BLOCK_KEYS.length);
    falas = falas.map((f, i) => ({ f, i })).sort((a, b) => idx(a.f) - idx(b.f) || a.i - b.i).map((x) => x.f);
  }
  const alvoS = alvoDoVideo(alvos, v);
  const reservas = v === "horizontal" ? [] : falas.flatMap((f) => cortesDaFala(f, v).filter((c) => c.reserva).map((c) => ({ id: f.id, trecho: c.trecho })));
  const montar = (aplicadas: Array<{ id: string; trecho: string }>): FalaNoVideo[] =>
    falas.map((f) => {
      const trechos = v === "horizontal" ? [] : cortesDaFala(f, v).filter((c) => !c.reserva || aplicadas.some((r) => r.id === f.id && r.trecho === c.trecho)).map((c) => c.trecho);
      const { texto, partes } = aplicarCortes(f.texto, trechos);
      return { fala: f, texto, partes, cortes: trechos };
    });
  const medir = (fs: FalaNoVideo[]) => fs.reduce((n, f) => n + palavrasDe(f.texto).length, 0);
  const aplicadas: Array<{ id: string; trecho: string }> = [];
  let resolvidas = montar(aplicadas);
  for (const r of reservas) {
    if ((medir(resolvidas) / alvos.palavrasPorMinuto) * 60 <= alvoS) break;
    aplicadas.push(r);
    resolvidas = montar(aplicadas);
  }
  const palavras = medir(resolvidas);
  return {
    video: v,
    falas: resolvidas,
    palavras,
    segundos: (palavras / alvos.palavrasPorMinuto) * 60,
    alvoS,
    reservasAplicadas: aplicadas,
    reservasNaoAplicadas: reservas.filter((r) => !aplicadas.includes(r)),
    ordemDeclarada: Boolean(ordem),
  };
}

/**
 * Pure (#13130): avisos de duração. Vertical acima do alvo leva a sugestão de
 * corte: primeiro as frases do fim do comentário (a 1ª fala do comentário
 * fica), depois as falas mais longas, nunca o gancho nem a chamada final, até
 * cobrir o excesso. Horizontal fora de `alvo ± tolerância`.
 */
export function avisosDuracao(pecas: readonly PecaResolvida[], alvos: AlvosRoteiro = ALVOS_ROTEIRO_DEFAULT): string[] {
  const avisos: string[] = [];
  for (const p of pecas) {
    if (!p.falas.length) continue;
    const label = VIDEO_LABEL[p.video];
    if (p.video === "horizontal") {
      const min = p.alvoS - alvos.horizontalToleranciaS;
      const max = p.alvoS + alvos.horizontalToleranciaS;
      if (p.segundos < min || p.segundos > max) {
        avisos.push(`horizontal: ~${formatarDuracao(p.segundos)} de fala estimada, fora de ${formatarDuracao(min)} a ${formatarDuracao(max)} (alvo ~${formatarDuracao(p.alvoS)}, #13130)`);
      }
      continue;
    }
    if (p.segundos <= p.alvoS) continue;
    const excesso = p.segundos - p.alvoS;
    const seg = (f: FalaNoVideo) => segundosDeFala(f.texto, alvos.palavrasPorMinuto);
    const protegida = (f: FalaNoVideo, i: number) => i === 0 || f.fala.bloco === "gancho" || f.fala.bloco === "cta_vertical" || f.fala.gravarAParte === true;
    const comentario = p.falas.map((f, i) => ({ f, i })).filter(({ f }) => f.fala.bloco === "comentario");
    const fimDoComentario = comentario.slice(1).reverse().filter(({ f, i }) => !protegida(f, i));
    const longas = p.falas
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => !protegida(f, i) && !fimDoComentario.some((c) => c.f === f))
      .sort((a, b) => seg(b.f) - seg(a.f));
    const sugestao: string[] = [];
    let coberto = 0;
    for (const { f } of [...fimDoComentario, ...longas]) {
      if (coberto >= excesso) break;
      sugestao.push(`${f.fala.id} (~${formatarDuracao(seg(f))}${fimDoComentario.some((c) => c.f === f) ? ", fim do comentário" : ", fala longa"})`);
      coberto += seg(f);
    }
    const reservas = p.reservasAplicadas.length ? `; cortes de reserva já aplicados: ${p.reservasAplicadas.map((r) => `${r.id} "${r.trecho}"`).join(", ")}` : "";
    avisos.push(
      `${label}: ~${formatarDuracao(p.segundos)} de fala estimada, acima do alvo de ${formatarDuracao(p.alvoS)} (+${formatarDuracao(alvos.ctaCardS)} do card de CTA à parte)${reservas}; para caber, cortar ou encurtar: ${sugestao.join(", ") || "nenhuma fala cortável sem mexer no gancho ou na chamada final"} (#13130)`,
    );
  }
  return avisos;
}

/** Pure (#13132): as fontes por fala, para o fact-check da fala gravada na montagem. */
export function fontesDoRoteiro(roteiro: Pick<RoteiroFalas, "falas">): Array<{ fala: string; texto: string; url: string; sustenta: string }> {
  return roteiro.falas.flatMap((f) => (f.fontes ?? []).map((fo) => ({ fala: f.id, texto: f.texto, url: fo.url, sustenta: fo.sustenta })));
}

/**
 * As fontes por fala do `roteiro-falas.json` da edição (#13132). Sem o
 * arquivo = [] em silêncio; ilegível ou inválido = [] com aviso.
 */
export function readRoteiroFontes(editionDir: string, warn: (msg: string) => void): ReturnType<typeof fontesDoRoteiro> {
  const lido = lerRoteiro(editionDir, warn, "as fontes por fala ficam fora do fact-check (#13132)");
  return lido ? fontesDoRoteiro(lido) : [];
}

function lerRoteiro(editionDir: string, warn: (msg: string) => void, efeito: string): RoteiroFalas | null {
  const path = join(editionDir, ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn(`${path} ilegível (${(e as Error).message}): ${efeito}`);
    return null;
  }
  const lido = parseRoteiroFalas(raw);
  if (!lido.ok) {
    warn(`${path} inválido (${lido.problemas.join("; ")}): ${efeito}`);
    return null;
  }
  return lido.roteiro;
}

/**
 * Pure (#13128): junta as listas de itens de um bloco, uma por sequência, numa
 * lista só que, filtrada por sequência, devolve a ordem de cada uma. Um item
 * casa pelo texto; uma fala que muda de posição num corte vira dois itens, cada
 * um com o `targets` da sua sequência.
 */
export function mesclarOrdens(listas: ReadonlyArray<{ chave: string; textos: readonly string[] }>): Array<{ text: string; chaves: Set<string> }> {
  const m: Array<{ text: string; chaves: Set<string> }> = [];
  for (const { chave, textos } of listas) {
    let p = 0;
    for (const t of textos) {
      let j = -1;
      for (let k = p; k < m.length; k++) {
        if (m[k].text === t && !m[k].chaves.has(chave)) {
          j = k;
          break;
        }
      }
      if (j >= 0) {
        m[j].chaves.add(chave);
        p = j + 1;
      } else {
        m.splice(p, 0, { text: t, chaves: new Set([chave]) });
        p += 1;
      }
    }
  }
  return m;
}

export interface SequenciaProposta {
  video: VideoRoteiro;
  /** `sequenceKey` da sequência na montagem: `youtube`, `outras-redes` ou o slug do corte. */
  chave: string;
  titulo?: string;
  capa?: string;
  falas: FalaNaSequencia[];
}

export interface PropostaBlocos {
  edicao?: string;
  sequencias: SequenciaProposta[];
  /** Fragmento do `blocks.json`: só os textos e o escopo (`targets`), sem tempo no bruto. */
  blocks: Partial<Record<BlockKey, Array<{ text: string; targets?: string[] }>>>;
  /** As sequências do `blocks.json` (as duas de sempre + o corte do vertical 2), ou ausente sem vertical 2. */
  sequences?: SequenceSpec[];
  /** Título na tela da vertical da edição (o do vertical 1 no roteiro). */
  screenTitle?: string;
  /** Duração estimada da fala de cada vídeo, sem o card de CTA (#13130). */
  duracoes: Array<{ video: VideoRoteiro; palavras: number; segundos: number; alvoS: number }>;
  /** O card de CTA, à parte da fala (#13130). */
  ctaCardS: number;
  avisos: string[];
}

/**
 * A proposta de blocos da montagem a partir do roteiro (#12751): cada fala no
 * bloco dela, com os `targets` das sequências que a usam (omitidos quando são
 * todas as que têm aquele bloco), e o vertical 2 como corte (`corte: "guia"`,
 * título na tela = o título do vertical 2 no roteiro; o gancho gravado à
 * parte vira o `hook`). Fala sem `bloco` fica fora, com aviso.
 */
export function propostaBlocosDoRoteiro(roteiro: RoteiroFalas, opts: { corteSlug?: string; version?: string; alvos?: AlvosRoteiro } = {}): PropostaBlocos {
  const slug = opts.corteSlug ?? VERTICAL2_CORTE_SLUG;
  const alvos = opts.alvos ?? ALVOS_ROTEIRO_DEFAULT;
  const pecas = roteiroPecas(roteiro);
  const avisos: string[] = [];
  const chaveDe: Record<VideoRoteiro, string> = { horizontal: "youtube", vertical1: "outras-redes", vertical2: slug };

  const semBloco = roteiro.falas.filter((f) => !f.bloco);
  if (semBloco.length) avisos.push(`falas sem bloco no roteiro-falas.json (fora da proposta): ${semBloco.map((f) => f.id).join(", ")}`);

  const resolvidas = VIDEOS_ROTEIRO.map((v) => resolverPeca(roteiro, v, alvos));
  const sequencias: SequenciaProposta[] = [];
  /** As partes de cada fala, por sequência e bloco, na ordem daquele vídeo. */
  const partesPorSeq = new Map<string, Map<BlockKey, string[]>>();
  for (const peca of resolvidas) {
    const v = peca.video;
    const falas: FalaNaSequencia[] = [];
    const porBloco = new Map<BlockKey, string[]>();
    for (const fv of peca.falas) {
      const f = fv.fala;
      if (!f.bloco) continue;
      const bloco = v === "horizontal" ? f.bloco : blocoNaVertical(f.bloco);
      if (!bloco) continue;
      falas.push({ id: f.id, bloco, texto: fv.texto, ...(f.tela ? { tela: f.tela } : {}), ...(fv.cortes.length ? { cortes: fv.cortes } : {}) });
      const l = porBloco.get(bloco) ?? [];
      l.push(...fv.partes);
      porBloco.set(bloco, l);
    }
    // A abertura no vertical: `entraNoVideo` já a tirou; o aviso de sempre segue.
    for (const f of roteiro.falas) {
      if (v !== "horizontal" && f.bloco && f.videos.includes(v) && blocoNaVertical(f.bloco) === null) {
        avisos.push(`${f.id}: bloco ${f.bloco} não existe no ${VIDEO_LABEL[v]}; a fala ficou fora dele`);
      }
    }
    if (peca.ordemDeclarada) {
      // A montagem monta por bloco (a ordem da sequência); a ordem declarada só vale dentro de cada bloco.
      const seqBlocos = falas.map((f) => f.bloco);
      const cruzou = seqBlocos.some((b, i) => i > 0 && BLOCK_KEYS.indexOf(b) < BLOCK_KEYS.indexOf(seqBlocos[i - 1]));
      if (cruzou) avisos.push(`${VIDEO_LABEL[v]}: porVideo.${v}.ordem cruza blocos (${falas.map((f) => `${f.id}:${f.bloco}`).join(", ")}); a montagem monta bloco a bloco, então a ordem declarada só vale dentro de cada bloco (#13128)`);
    }
    for (const r of peca.reservasAplicadas) avisos.push(`${VIDEO_LABEL[v]}: corte de reserva aplicado em ${r.id} ("${r.trecho}"): a estimativa sem ele passava de ${formatarDuracao(peca.alvoS)} (#13129)`);
    if (falas.length) {
      sequencias.push({ video: v, chave: chaveDe[v], ...pecas[v], falas });
      partesPorSeq.set(chaveDe[v], porBloco);
    }
  }
  avisos.push(...avisosDuracao(resolvidas, alvos));

  // O fragmento de blocks: por bloco, as listas das sequências mescladas (#13128),
  // cada item com as sequências que o usam.
  const itens: Array<{ bloco: BlockKey; text: string; chaves: Set<string> }> = [];
  for (const bloco of BLOCK_KEYS) {
    const listas = sequencias.map((s) => ({ chave: s.chave, textos: partesPorSeq.get(s.chave)?.get(bloco) ?? [] })).filter((l) => l.textos.length);
    for (const it of mesclarOrdens(listas)) itens.push({ bloco, ...it });
  }
  const blocosHorizontal = new Set(sequencias.find((s) => s.video === "horizontal")?.falas.map((f) => f.bloco) ?? []);
  const draft: Partial<Record<BlockKey, unknown[]>> = {};
  for (const it of itens) (draft[it.bloco] ??= []).push(it);
  const opening = openingBlockOf(draft);
  const [specH, specV] = defaultSequences(opts.version ?? "V1", "monologo", opening);

  const v2 = sequencias.find((s) => s.video === "vertical2");
  let corteSpec: SequenceSpec | undefined;
  if (v2) {
    // Os blocos do vertical 2 na ordem canônica da montagem (o gancho gravado à parte abre).
    const order = BLOCK_KEYS.filter((k) => v2.falas.some((f) => f.bloco === k));
    const hook = roteiro.falas.find((f) => f.gravarAParte && f.videos.length === 1 && f.videos[0] === "vertical2");
    corteSpec = {
      target: "instagram",
      name: `${specV.name}-${slug}`,
      corte: slug,
      width: specV.width,
      height: specV.height,
      order,
      scales: specV.scales,
      ...(v2.titulo ? { screenTitle: v2.titulo } : {}),
      ...(hook ? { hook: hook.texto } : {}),
    };
    if (!v2.titulo) avisos.push("vertical 2 sem título no roteiro (porVideo.vertical2.titulo): o corte sai com o título da notícia, e o build avisa");
  }

  // Quais sequências têm cada bloco: o item que cobre todas não precisa de `targets`.
  const ordemDe: Record<string, readonly BlockKey[]> = { youtube: specH.order, "outras-redes": specV.order, ...(corteSpec ? { [slug]: corteSpec.order } : {}) };
  const v1 = sequencias.find((s) => s.video === "vertical1");
  if (v1) {
    const fora = [...new Set(v1.falas.map((f) => f.bloco).filter((b) => !specV.order.includes(b)))];
    if (fora.length) avisos.push(`vertical 1 usa bloco fora da ordem da vertical da edição (${specV.order.join(", ")}): ${fora.join(", ")}`);
  }
  const fora = [...blocosHorizontal].filter((b) => !specH.order.includes(b));
  if (fora.length) avisos.push(`horizontal usa bloco fora da ordem do horizontal (${specH.order.join(", ")}): ${fora.join(", ")}`);

  const blocks: PropostaBlocos["blocks"] = {};
  for (const it of itens) {
    const comBlocoAqui = Object.entries(ordemDe).filter(([, order]) => order.includes(it.bloco)).map(([k]) => k);
    const todas = comBlocoAqui.every((k) => it.chaves.has(k));
    (blocks[it.bloco] ??= []).push({ text: it.text, ...(todas ? {} : { targets: [...it.chaves] }) });
  }

  return {
    ...(roteiro.edicao ? { edicao: roteiro.edicao } : {}),
    sequencias,
    blocks,
    ...(corteSpec ? { sequences: [specH, specV, corteSpec] } : {}),
    ...(v1?.titulo ? { screenTitle: v1.titulo } : {}),
    duracoes: resolvidas.filter((r) => r.falas.length).map((r) => ({ video: r.video, palavras: r.palavras, segundos: r.segundos, alvoS: r.alvoS })),
    ctaCardS: alvos.ctaCardS,
    avisos,
  };
}

/** A proposta em Markdown, para o modelo partir dela no Gate 1/Gate 2 da montagem. */
export function renderPropostaBlocos(p: PropostaBlocos): string {
  const linhas: string[] = [`# Proposta de blocos a partir do roteiro${p.edicao ? ` (${p.edicao})` : ""} (#12751)`, ""];
  linhas.push("Ponto de partida: os tempos no bruto saem da decupagem, e o editor decide no Gate 1/Gate 2.", "");
  for (const s of p.sequencias) {
    linhas.push(`## ${VIDEO_LABEL[s.video]} (sequência \`${s.chave}\`)`, "");
    if (s.titulo) linhas.push(`- Título: ${s.titulo}`);
    if (s.capa) linhas.push(`- Capa: ${s.capa}`);
    if (s.titulo || s.capa) linhas.push("");
    const d = p.duracoes.find((x) => x.video === s.video);
    if (d) linhas.push(`- Duração estimada: ~${formatarDuracao(d.segundos)} de fala (${d.palavras} palavras; alvo ~${formatarDuracao(d.alvoS)}), mais ~${formatarDuracao(p.ctaCardS)} do card de CTA`, "");
    const temTela = s.falas.some((f) => f.tela);
    linhas.push(temTela ? "| Fala | Bloco | Texto | Na tela |" : "| Fala | Bloco | Texto |", temTela ? "|---|---|---|---|" : "|---|---|---|");
    const cel = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
    for (const f of s.falas) {
      const texto = cel(f.texto) + (f.cortes?.length ? ` (cortado aqui: ${f.cortes.map((c) => `"${cel(c)}"`).join(", ")})` : "");
      linhas.push(temTela ? `| ${f.id} | ${f.bloco} | ${texto} | ${cel(f.tela ?? "")} |` : `| ${f.id} | ${f.bloco} | ${texto} |`);
    }
    linhas.push("");
  }
  if (p.screenTitle) linhas.push(`\`screenTitle\` da vertical da edição: "${p.screenTitle}" (título do vertical 1 no roteiro).`, "");
  if (p.sequences) linhas.push(`O vertical 2 entra como corte \`${p.sequences[2].corte}\` em \`sequences\` (as duas de sempre vêm junto: \`sequences\` substitui as default).`, "");
  if (p.avisos.length) {
    linhas.push("Avisos:");
    for (const a of p.avisos) linhas.push(`- ${a}`);
    linhas.push("");
  }
  return linhas.join("\n");
}

/**
 * Título e capa do horizontal no roteiro do vídeo (#12751), de
 * `{editionDir}/_internal/roteiro-falas.json`. Sem o arquivo = null em
 * silêncio (edição sem roteiro pela skill); arquivo ilegível ou inválido =
 * null com aviso (cai no título do D1, nunca derruba o plano).
 */
export function readRoteiroHorizontal(editionDir: string, warn: (msg: string) => void): { titulo?: string; capa?: string } | null {
  const path = join(editionDir, ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn(`${path} ilegível (${(e as Error).message}): título e capa do roteiro ignorados, usando o D1 (#12751)`);
    return null;
  }
  const lido = parseRoteiroFalas(raw);
  if (!lido.ok) {
    warn(`${path} inválido (${lido.problemas.join("; ")}): título e capa do roteiro ignorados, usando o D1 (#12751)`);
    return null;
  }
  return roteiroPecas(lido.roteiro).horizontal ?? null;
}

// ─── Gancho e título (#13116) ────────────────────────────────────────────────

/**
 * No vertical o gancho chega ao ponto em ~3 s (critério 4 da #13116, decidido
 * com o editor em 15/11/2026). A ~150 palavras por minuto, 3 s são umas 7 a 8
 * palavras: acima disto antes do primeiro ponto, o que importa para quem
 * assiste chega tarde.
 */
export const GANCHO_VERTICAL_MAX_PALAVRAS = 8;
/** Ritmo de fala usado para estimar a duração do gancho. */
export const PALAVRAS_POR_MINUTO = 150;
/** Fração das palavras de conteúdo do título que já estão no gancho a partir da qual é repetição. */
export const TITULO_GANCHO_OVERLAP_LIMITE = 0.6;

/** A primeira frase do texto, até o primeiro `.`, `!`, `?` ou `…` seguido de espaço ou do fim. */
export function primeiraFrase(texto: string): string {
  const m = texto.trim().match(/^.*?[.!?…](?=\s|$)/su);
  return (m ? m[0] : texto).trim();
}

function palavrasDe(texto: string): string[] {
  return texto.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

function normFrase(texto: string): string {
  return texto.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Pure (#13116): avisos sobre o gancho e o título de cada vídeo do roteiro.
 *   - no vertical, gancho com mais de `GANCHO_VERTICAL_MAX_PALAVRAS` palavras
 *     antes do primeiro ponto (critério 4);
 *   - título que repete o gancho (critério 1): um contido no outro, ou a
 *     maior parte das palavras de conteúdo do título já no gancho. Nos
 *     verticais o título aparece escrito na tela e a fala sai como legenda:
 *     título igual ao gancho mostra a mesma frase duas vezes.
 * O gancho de um vídeo é a 1ª fala com `bloco: "gancho"` que ele usa.
 */
export function avisosGanchoETitulo(roteiro: Pick<RoteiroFalas, "falas" | "porVideo">): string[] {
  const avisos: string[] = [];
  const pecas = roteiroPecas(roteiro);
  for (const v of VIDEOS_ROTEIRO) {
    const gancho = roteiro.falas.find((f) => f.bloco === "gancho" && f.videos.includes(v));
    if (!gancho) continue;
    const frase = primeiraFrase(gancho.texto);
    if (v !== "horizontal") {
      const n = palavrasDe(frase).length;
      if (n > GANCHO_VERTICAL_MAX_PALAVRAS) {
        const seg = Math.round((n / PALAVRAS_POR_MINUTO) * 60);
        avisos.push(
          `${gancho.id}: o gancho do ${VIDEO_LABEL[v]} leva ${n} palavras até o primeiro ponto (~${seg} s a ${PALAVRAS_POR_MINUTO} palavras/min); no vertical ele chega ao ponto em ~3 s, até ~${GANCHO_VERTICAL_MAX_PALAVRAS} palavras (#13116)`,
        );
      }
    }
    const titulo = pecas[v]?.titulo;
    if (!titulo) continue;
    const t = normFrase(titulo);
    const f = normFrase(frase);
    const tituloContent = contentWords(titulo);
    const ganchoContent = new Set(contentWords(gancho.texto));
    const overlap = tituloContent.length ? tituloContent.filter((w) => ganchoContent.has(w)).length / tituloContent.length : 0;
    const contido = t.length > 0 && f.length > 0 && (normFrase(gancho.texto).includes(t) || t.includes(f));
    if (contido || overlap >= TITULO_GANCHO_OVERLAP_LIMITE) {
      avisos.push(
        `${VIDEO_LABEL[v]}: o título repete o gancho ${gancho.id} (${Math.round(overlap * 100)}% das palavras de conteúdo do título estão na fala); mesma promessa com outras palavras: o título diz o assunto, o gancho traz a tensão (#13116)`,
      );
    }
  }
  return avisos;
}
