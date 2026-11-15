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
 *     gancho (#13116).
 *
 * A proposta é ponto de partida do Gate 1/Gate 2 da montagem, nunca o
 * `blocks.json` final: os tempos no bruto saem da decupagem, e quem decide é o
 * editor.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCK_KEYS,
  defaultSequences,
  openingBlockOf,
  type BlockKey,
  type SequenceSpec,
} from "./video-montage.ts";
import { contentWords } from "./youtube-title-research.ts";
import { hasRecognizableSubject } from "./youtube-capa-hooks.ts";
import { corteDaFala, segmentosSemTrecho, validarRoteiroFalas, VIDEO_LABEL, VIDEOS_ROTEIRO, type FalaRoteiro, type PecaVideo, type RoteiroFalas, type VideoRoteiro } from "./roteiro-gravacao.ts";

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

/**
 * Título e texto da capa de cada vídeo, só os preenchidos (texto aparado).
 * O vertical 1 sem título herda o do horizontal (#13116, decisão do editor de
 * 15/11/2026: o vertical 1 chama para o "vídeo completo no YouTube", e com o
 * mesmo título a pessoa reconhece o vídeo). As capas continuam próprias.
 */
export function roteiroPecas(roteiro: Pick<RoteiroFalas, "porVideo">): Partial<Record<VideoRoteiro, PecaVideo>> {
  const out: Partial<Record<VideoRoteiro, PecaVideo>> = {};
  for (const v of VIDEOS_ROTEIRO) {
    const p = roteiro.porVideo?.[v];
    const titulo = p?.titulo?.trim() || (v === "vertical1" ? roteiro.porVideo?.horizontal?.titulo?.trim() : undefined);
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
  /** O texto que vai ao ar naquele vídeo: já sem o corte parcial (#13129), quando há. */
  texto: string;
  /** Os trechos que sobram depois do corte (2 quando o corte é no meio): cada um vira um item. */
  segmentos?: string[];
  /** O trecho cortado naquele vídeo (#13129). */
  cortado?: string;
}

/** Um corte de reserva (#13129): só entra se o vídeo passar do alvo. */
export interface CorteReserva {
  video: VideoRoteiro;
  chave: string;
  id: string;
  trecho: string;
  /** Os itens que substituem a fala inteira quando o corte entra. */
  segmentos: string[];
  /** Segundos que o corte economiza, à taxa de fala do roteiro. */
  economiaS: number;
}

export interface SequenciaProposta {
  video: VideoRoteiro;
  /** `sequenceKey` da sequência na montagem: `youtube`, `outras-redes` ou o slug do corte. */
  chave: string;
  titulo?: string;
  capa?: string;
  /** true quando a ordem veio de `porVideo.{vertical}.ordem` (#13128). */
  ordemDeclarada?: boolean;
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
  /** Cortes de reserva declarados (#13129): fora da proposta, só acima do alvo. */
  cortesReserva: CorteReserva[];
  /** Fontes das falas (#13132), para o fact-check da fala na montagem. */
  fontes: Array<{ id: string; url: string; sustenta: string }>;
  avisos: string[];
}

/** As falas de um vídeo na ordem dele: a de `porVideo.{v}.ordem` (#13128) ou a do JSON. */
export function falasDoVideo(roteiro: Pick<RoteiroFalas, "falas" | "porVideo">, v: VideoRoteiro): { falas: FalaRoteiro[]; declarada: boolean } {
  const doVideo = roteiro.falas.filter((f) => f.videos.includes(v));
  const ordem = v === "horizontal" ? undefined : roteiro.porVideo?.[v]?.ordem;
  if (!ordem?.length) return { falas: doVideo, declarada: false };
  const porId = new Map(doVideo.map((f) => [f.id, f] as const));
  const ordenadas = ordem.map((id) => porId.get(id)).filter((f): f is FalaRoteiro => Boolean(f));
  // O validador garante o mesmo conjunto; se não bater (JSON não validado), não perder fala.
  for (const f of doVideo) if (!ordenadas.includes(f)) ordenadas.push(f);
  return { falas: ordenadas, declarada: true };
}

/**
 * A proposta de blocos da montagem a partir do roteiro (#12751): cada fala no
 * bloco dela, com os `targets` das sequências que a usam (omitidos quando são
 * todas as que têm aquele bloco), e o vertical 2 como corte (`corte: "guia"`,
 * título na tela = o título do vertical 2 no roteiro; o gancho gravado à
 * parte vira o `hook`). Fala sem `bloco` fica fora, com aviso.
 *
 * Desde #13128/#13129: cada vertical segue a `ordem` declarada (dentro de um
 * bloco, uma fala que o vertical põe noutra posição vira item próprio dele,
 * com `targets`), e o corte parcial sai aplicado no vertical (a fala vira os
 * trechos que sobram, cada um um item); os cortes de reserva ficam fora, em
 * `cortesReserva`, prontos para entrar se a duração passar do alvo.
 */
export function propostaBlocosDoRoteiro(roteiro: RoteiroFalas, opts: { corteSlug?: string; version?: string; palavrasPorMinuto?: number } = {}): PropostaBlocos {
  const slug = opts.corteSlug ?? VERTICAL2_CORTE_SLUG;
  const ppm = opts.palavrasPorMinuto ?? PALAVRAS_POR_MINUTO;
  const pecas = roteiroPecas(roteiro);
  const avisos: string[] = [];
  const cortesReserva: CorteReserva[] = [];
  const chaveDe: Record<VideoRoteiro, string> = { horizontal: "youtube", vertical1: "outras-redes", vertical2: slug };

  const semBloco = roteiro.falas.filter((f) => !f.bloco);
  if (semBloco.length) avisos.push(`falas sem bloco no roteiro-falas.json (fora da proposta): ${semBloco.map((f) => f.id).join(", ")}`);

  const blocoEm = (f: FalaRoteiro & { bloco: BlockKey }, v: VideoRoteiro): BlockKey | null => (v === "horizontal" ? f.bloco : blocoNaVertical(f.bloco));
  const sequencias: SequenciaProposta[] = [];
  for (const v of VIDEOS_ROTEIRO) {
    const { falas: ordenadas, declarada } = falasDoVideo(roteiro, v);
    const falas: FalaNaSequencia[] = [];
    for (const f of ordenadas) {
      if (!f.bloco) continue;
      const bloco = blocoEm(f as FalaRoteiro & { bloco: BlockKey }, v);
      if (!bloco) {
        avisos.push(`${f.id}: bloco ${f.bloco} não existe no ${VIDEO_LABEL[v]}; a fala ficou fora dele`);
        continue;
      }
      const corte = corteDaFala(f, v);
      const segmentos = corte ? segmentosSemTrecho(f.texto, corte.trecho) : null;
      if (corte && segmentos?.length && corte.reserva) {
        const economia = palavrasDe(f.texto).length - palavrasDe(segmentos.join(" ")).length;
        cortesReserva.push({ video: v, chave: chaveDe[v], id: f.id, trecho: corte.trecho, segmentos, economiaS: Math.round((economia / ppm) * 60) });
      }
      if (corte && segmentos?.length && !corte.reserva) falas.push({ id: f.id, bloco, texto: segmentos.join(" "), segmentos, cortado: corte.trecho });
      else falas.push({ id: f.id, bloco, texto: f.texto });
    }
    if (falas.length) sequencias.push({ video: v, chave: chaveDe[v], ...pecas[v], ...(declarada ? { ordemDeclarada: true } : {}), falas });
    // A montagem ordena por bloco: uma ordem declarada que cruza blocos não sai como pedida.
    if (declarada) {
      const posBloco = falas.map((f) => BLOCK_KEYS.indexOf(f.bloco));
      const quebra = falas.find((_, i) => i > 0 && posBloco[i] < posBloco[i - 1]);
      if (quebra) avisos.push(`${VIDEO_LABEL[v]}: a ordem declarada põe ${quebra.id} (${quebra.bloco}) depois de uma fala de bloco posterior; a montagem ordena por bloco, então essa troca não sai como pedida (#13128)`);
    }
  }

  // O fragmento de blocks, por bloco e em ordem: cada sequência anda sobre a
  // lista do bloco; a fala que ela usa mais à frente que a posição corrente é
  // reaproveitada (ganha a chave), e a que ficaria para trás vira item próprio
  // inserido ali (#13128). Fala cortada vira os itens dos trechos (#13129).
  type Item = { text: string; chaves: Set<string> };
  const porBloco = new Map<BlockKey, Item[]>();
  for (const s of sequencias) {
    const pos = new Map<BlockKey, number>();
    for (const f of s.falas) {
      const lista = porBloco.get(f.bloco) ?? [];
      porBloco.set(f.bloco, lista);
      for (const text of f.segmentos ?? [f.texto]) {
        let p = pos.get(f.bloco) ?? 0;
        const achado = lista.findIndex((it, j) => j >= p && it.text === text);
        if (achado >= 0) {
          lista[achado].chaves.add(s.chave);
          p = achado + 1;
        } else {
          lista.splice(p, 0, { text, chaves: new Set([s.chave]) });
          p += 1;
        }
        pos.set(f.bloco, p);
      }
    }
  }
  const draft: Partial<Record<BlockKey, unknown[]>> = {};
  for (const [b, lista] of porBloco) if (lista.length) draft[b] = lista;
  const blocosHorizontal = new Set(sequencias.find((s) => s.video === "horizontal")?.falas.map((f) => f.bloco) ?? []);
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
  for (const [b, lista] of porBloco) {
    const comBlocoAqui = Object.entries(ordemDe).filter(([, order]) => order.includes(b)).map(([k]) => k);
    for (const it of lista) {
      const todas = comBlocoAqui.every((k) => it.chaves.has(k));
      (blocks[b] ??= []).push({ text: it.text, ...(todas ? {} : { targets: [...it.chaves] }) });
    }
  }

  const fontes = roteiro.falas.flatMap((f) => (f.fontes ?? []).map((fo) => ({ id: f.id, url: fo.url, sustenta: fo.sustenta })));

  return {
    ...(roteiro.edicao ? { edicao: roteiro.edicao } : {}),
    sequencias,
    blocks,
    ...(corteSpec ? { sequences: [specH, specV, corteSpec] } : {}),
    ...(v1?.titulo ? { screenTitle: v1.titulo } : {}),
    cortesReserva,
    fontes,
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
    if (s.ordemDeclarada) linhas.push(`- Ordem declarada em porVideo.${s.video}.ordem (#13128)`);
    if (s.titulo || s.capa || s.ordemDeclarada) linhas.push("");
    linhas.push("| Fala | Bloco | Texto |", "|---|---|---|");
    const cel = (t: string) => t.replace(/\|/g, "\\|");
    for (const f of s.falas) linhas.push(`| ${f.id} | ${f.bloco} | ${cel(f.texto)}${f.cortado ? ` (corte: sem "${cel(f.cortado)}")` : ""} |`);
    linhas.push("");
  }
  if (p.cortesReserva.length) {
    linhas.push("Cortes de reserva (#13129), só se o vídeo passar do alvo de duração:");
    for (const c of p.cortesReserva) {
      linhas.push(`- ${VIDEO_LABEL[c.video]} (\`${c.chave}\`), ${c.id}: tirar "${c.trecho}" (~${c.economiaS} s); a fala vira ${c.segmentos.map((t) => `"${t}"`).join(" + ")}`);
    }
    linhas.push("");
  }
  if (p.fontes.length) {
    linhas.push("Fontes das falas (#13132), para o fact-check da fala:");
    for (const fo of p.fontes) linhas.push(`- ${fo.id}: ${fo.url} (${fo.sustenta})`);
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
  const roteiro = readRoteiroDaEdicao(editionDir, warn, "título e capa do roteiro ignorados, usando o D1 (#12751)");
  return roteiro ? roteiroPecas(roteiro).horizontal ?? null : null;
}

/**
 * O `roteiro-falas.json` da edição, validado. Sem o arquivo = null em
 * silêncio; ilegível ou inválido = null com aviso (`consequencia` diz o que
 * o chamador faz sem ele).
 */
export function readRoteiroDaEdicao(editionDir: string, warn: (msg: string) => void, consequencia: string): RoteiroFalas | null {
  const path = join(editionDir, ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn(`${path} ilegível (${(e as Error).message}): ${consequencia}`);
    return null;
  }
  const lido = parseRoteiroFalas(raw);
  if (!lido.ok) {
    warn(`${path} inválido (${lido.problemas.join("; ")}): ${consequencia}`);
    return null;
  }
  return lido.roteiro;
}

/**
 * As fontes de fora do D1 declaradas por fala no roteiro (#13132), para o
 * fact-check da fala na montagem (`fact-check-input`). Sem roteiro = [].
 */
export function readRoteiroFontes(editionDir: string, warn: (msg: string) => void): Array<{ fala: string; texto: string; url: string; sustenta: string }> {
  const roteiro = readRoteiroDaEdicao(editionDir, warn, "fontes do roteiro fora do fact-check da fala; só as do D1 (#13132)");
  if (!roteiro) return [];
  return roteiro.falas.flatMap((f) => (f.fontes ?? []).map((fo) => ({ fala: f.id, texto: f.texto, url: fo.url, sustenta: fo.sustenta })));
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
  // Critério 3: na grade do perfil a capa do vertical aparece sem o título.
  for (const v of ["vertical1", "vertical2"] as const) {
    const capa = pecas[v]?.capa;
    if (capa && !hasRecognizableSubject(capa)) {
      avisos.push(`${VIDEO_LABEL[v]}: a capa "${capa}" não tem sujeito reconhecível; na grade do perfil ela aparece sem o título, diga quem ("Sua Busca", "Google") (#13116)`);
    }
  }
  return avisos;
}

// ─── Duração estimada por vídeo (#13130) ─────────────────────────────────────

/** Alvos de duração do roteiro; o default é o desta tabela, a config sobrepõe. */
export interface RoteiroDuracaoConfig {
  palavrasPorMinuto: number;
  /** Alvo de fala por vídeo, em segundos (o card de CTA fica fora). */
  alvoS: Record<VideoRoteiro, number>;
  /** Folga do horizontal para mais e para menos do alvo antes de avisar. */
  horizontalFolgaS: number;
  /** Duração do card de CTA, mostrada à parte. */
  ctaCardS: number;
}

/**
 * Defaults (#13130): vertical 1 e vertical 2 de ~60 s (na 261116 o vertical 2
 * de ~75 s na skill saiu ~60 na prática, e a decisão é alertar acima de 60),
 * horizontal de ~3 min com 1 min de folga, card de CTA de ~4 s.
 */
export const ROTEIRO_DURACAO_DEFAULT: RoteiroDuracaoConfig = {
  palavrasPorMinuto: PALAVRAS_POR_MINUTO,
  alvoS: { horizontal: 180, vertical1: 60, vertical2: 60 },
  horizontalFolgaS: 60,
  ctaCardS: 4,
};

const numPositivo = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);

/**
 * `publishing.video.roteiro` do `platform.config.json` (#13130), por cima dos
 * defaults: `palavras_por_minuto`, `alvo_s.{horizontal,vertical1,vertical2}`,
 * `horizontal_folga_s`, `cta_card_s`. Valor ausente ou inválido = o default.
 */
export function roteiroDuracaoConfigFrom(config: unknown): RoteiroDuracaoConfig {
  const r = (config as { publishing?: { video?: { roteiro?: Record<string, unknown> } } })?.publishing?.video?.roteiro ?? {};
  const alvo = (r.alvo_s ?? {}) as Record<string, unknown>;
  const d = ROTEIRO_DURACAO_DEFAULT;
  return {
    palavrasPorMinuto: numPositivo(r.palavras_por_minuto) ?? d.palavrasPorMinuto,
    alvoS: {
      horizontal: numPositivo(alvo.horizontal) ?? d.alvoS.horizontal,
      vertical1: numPositivo(alvo.vertical1) ?? d.alvoS.vertical1,
      vertical2: numPositivo(alvo.vertical2) ?? d.alvoS.vertical2,
    },
    horizontalFolgaS: numPositivo(r.horizontal_folga_s) ?? d.horizontalFolgaS,
    ctaCardS: numPositivo(r.cta_card_s) ?? d.ctaCardS,
  };
}

export interface DuracaoVideo {
  video: VideoRoteiro;
  palavras: number;
  /** Fala estimada, em segundos, com os cortes que não são de reserva já aplicados. */
  segundos: number;
  alvoS: number;
  /** Passou do alvo (vertical) ou saiu da faixa do horizontal. */
  foraDoAlvo: boolean;
}

/** A fala do vídeo como vai ao ar: com os cortes que não são de reserva (#13129). */
function textoNoVideo(f: FalaRoteiro, v: VideoRoteiro): string {
  const c = corteDaFala(f, v);
  if (!c || c.reserva) return f.texto;
  const seg = segmentosSemTrecho(f.texto, c.trecho);
  return seg?.length ? seg.join(" ") : f.texto;
}

/** Pure (#13130): palavras e duração estimada de cada vídeo do roteiro. */
export function duracaoPorVideo(roteiro: Pick<RoteiroFalas, "falas">, cfg: RoteiroDuracaoConfig = ROTEIRO_DURACAO_DEFAULT): DuracaoVideo[] {
  const out: DuracaoVideo[] = [];
  for (const v of VIDEOS_ROTEIRO) {
    const falas = roteiro.falas.filter((f) => f.videos.includes(v));
    if (!falas.length) continue;
    const palavras = falas.reduce((n, f) => n + palavrasDe(textoNoVideo(f, v)).length, 0);
    const segundos = Math.round((palavras / cfg.palavrasPorMinuto) * 60);
    const alvoS = cfg.alvoS[v];
    const foraDoAlvo = v === "horizontal" ? Math.abs(segundos - alvoS) > cfg.horizontalFolgaS : segundos > alvoS;
    out.push({ video: v, palavras, segundos, alvoS, foraDoAlvo });
  }
  return out;
}

/** "3 min 22 s" / "62 s". */
export function fmtDuracao(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`;
}

/**
 * Pure (#13130): avisos de duração. Vertical acima do alvo sai com a sugestão
 * de corte, nesta ordem: os cortes de reserva declarados, depois as falas mais
 * longas do vídeo (sem o gancho, que abre, nem a chamada final). Horizontal
 * fora da faixa avisa para mais ou para menos.
 */
export function avisosDuracao(roteiro: Pick<RoteiroFalas, "falas">, cfg: RoteiroDuracaoConfig = ROTEIRO_DURACAO_DEFAULT): string[] {
  const avisos: string[] = [];
  for (const d of duracaoPorVideo(roteiro, cfg)) {
    if (!d.foraDoAlvo) continue;
    if (d.video === "horizontal") {
      const lado = d.segundos > d.alvoS ? "acima" : "abaixo";
      avisos.push(`horizontal com ~${fmtDuracao(d.segundos)} de fala, ${lado} da faixa de ~${fmtDuracao(d.alvoS)} (± ${cfg.horizontalFolgaS} s) (#13130)`);
      continue;
    }
    const sugestoes: string[] = [];
    for (const f of roteiro.falas) {
      const c = corteDaFala(f, d.video);
      if (!c?.reserva || !f.videos.includes(d.video)) continue;
      const seg = segmentosSemTrecho(f.texto, c.trecho);
      if (!seg) continue;
      const eco = Math.round(((palavrasDe(f.texto).length - palavrasDe(seg.join(" ")).length) / cfg.palavrasPorMinuto) * 60);
      sugestoes.push(`corte de reserva da ${f.id} ("${c.trecho}", ~${eco} s)`);
    }
    const longas = roteiro.falas
      .filter((f) => f.videos.includes(d.video) && f.bloco !== "gancho" && !String(f.bloco ?? "").startsWith("cta"))
      .map((f) => ({ id: f.id, s: Math.round((palavrasDe(textoNoVideo(f, d.video)).length / cfg.palavrasPorMinuto) * 60) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    if (longas.length) sugestoes.push(`as falas mais longas: ${longas.map((l) => `${l.id} (~${l.s} s)`).join(", ")}`);
    avisos.push(
      `${VIDEO_LABEL[d.video]} com ~${fmtDuracao(d.segundos)} de fala, acima do alvo de ${fmtDuracao(d.alvoS)} (card de CTA à parte)${sugestoes.length ? `; para cortar: ${sugestoes.join("; ")}` : ""} (#13130)`,
    );
  }
  return avisos;
}

/** As durações em Markdown, uma linha por vídeo (o card de CTA à parte). */
export function renderDuracoes(roteiro: Pick<RoteiroFalas, "falas">, cfg: RoteiroDuracaoConfig = ROTEIRO_DURACAO_DEFAULT): string {
  const linhas = [`## Duração estimada (${cfg.palavrasPorMinuto} palavras/min, #13130)`, "", "| Vídeo | Palavras | Fala | Alvo |", "|---|---|---|---|"];
  for (const d of duracaoPorVideo(roteiro, cfg)) {
    const alvo = d.video === "horizontal" ? `~${fmtDuracao(d.alvoS)} ± ${cfg.horizontalFolgaS} s` : `até ${fmtDuracao(d.alvoS)}`;
    linhas.push(`| ${VIDEO_LABEL[d.video]} | ${d.palavras} | ~${fmtDuracao(d.segundos)}${d.foraDoAlvo ? " (fora do alvo)" : ""} | ${alvo} |`);
  }
  linhas.push("", `Mais o card de CTA, ~${cfg.ctaCardS} s em cada vídeo.`, "");
  return linhas.join("\n");
}
