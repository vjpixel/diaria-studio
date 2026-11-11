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
 *     com os `targets` de cada fala e a sequência de corte do vertical 2.
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
import { validarRoteiroFalas, VIDEO_LABEL, VIDEOS_ROTEIRO, type FalaRoteiro, type PecaVideo, type RoteiroFalas, type VideoRoteiro } from "./roteiro-gravacao.ts";

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
  texto: string;
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
  avisos: string[];
}

/**
 * A proposta de blocos da montagem a partir do roteiro (#12751): cada fala no
 * bloco dela, com os `targets` das sequências que a usam (omitidos quando são
 * todas as que têm aquele bloco), e o vertical 2 como corte (`corte: "guia"`,
 * título na tela = o título do vertical 2 no roteiro; o gancho gravado à
 * parte vira o `hook`). Fala sem `bloco` fica fora, com aviso.
 */
export function propostaBlocosDoRoteiro(roteiro: RoteiroFalas, opts: { corteSlug?: string; version?: string } = {}): PropostaBlocos {
  const slug = opts.corteSlug ?? VERTICAL2_CORTE_SLUG;
  const pecas = roteiroPecas(roteiro);
  const avisos: string[] = [];
  const chaveDe: Record<VideoRoteiro, string> = { horizontal: "youtube", vertical1: "outras-redes", vertical2: slug };

  const semBloco = roteiro.falas.filter((f) => !f.bloco);
  if (semBloco.length) avisos.push(`falas sem bloco no roteiro-falas.json (fora da proposta): ${semBloco.map((f) => f.id).join(", ")}`);
  const comBloco = roteiro.falas.filter((f): f is FalaRoteiro & { bloco: BlockKey } => Boolean(f.bloco));

  const blocoEm = (f: FalaRoteiro & { bloco: BlockKey }, v: VideoRoteiro): BlockKey | null => (v === "horizontal" ? f.bloco : blocoNaVertical(f.bloco));
  const sequencias: SequenciaProposta[] = [];
  for (const v of VIDEOS_ROTEIRO) {
    const falas: FalaNaSequencia[] = [];
    for (const f of comBloco) {
      if (!f.videos.includes(v)) continue;
      const bloco = blocoEm(f, v);
      if (!bloco) {
        avisos.push(`${f.id}: bloco ${f.bloco} não existe no ${VIDEO_LABEL[v]}; a fala ficou fora dele`);
        continue;
      }
      falas.push({ id: f.id, bloco, texto: f.texto });
    }
    if (falas.length) sequencias.push({ video: v, chave: chaveDe[v], ...pecas[v], falas });
  }

  // O fragmento de blocks: um item por (bloco, texto), com as sequências que o usam.
  const itens = new Map<string, { bloco: BlockKey; text: string; chaves: Set<string> }>();
  for (const s of sequencias) {
    for (const f of s.falas) {
      const k = `${f.bloco}\u0000${f.texto}`;
      const it = itens.get(k) ?? { bloco: f.bloco, text: f.texto, chaves: new Set<string>() };
      it.chaves.add(s.chave);
      itens.set(k, it);
    }
  }
  const blocosHorizontal = new Set(sequencias.find((s) => s.video === "horizontal")?.falas.map((f) => f.bloco) ?? []);
  const draft: Partial<Record<BlockKey, unknown[]>> = {};
  for (const it of itens.values()) (draft[it.bloco] ??= []).push(it);
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
  for (const it of itens.values()) {
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
    linhas.push("| Fala | Bloco | Texto |", "|---|---|---|");
    for (const f of s.falas) linhas.push(`| ${f.id} | ${f.bloco} | ${f.texto.replace(/\|/g, "\\|")} |`);
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
