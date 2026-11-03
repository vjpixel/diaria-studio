/**
 * video-fact-check.ts (#11956) — fact-check da fala do vídeo antes do Gate 2
 * da `/diaria-video-montagem`.
 *
 * Na 261103 o editor pediu "faça fact check" sobre o roteiro e a checagem à
 * mão, contra as fontes do D1, achou 4 erros graves na fala gravada (benchmark
 * atribuído ao modelo errado, modelo inexistente, duas empresas "usando a
 * mesma definição", um 4º ponto que não estava em nenhuma fonte). A fala do
 * vídeo não passa pelo `fact-checker` da Etapa 4, que só vê newsletter e social.
 *
 * Fluxo: `video-montagem.ts fact-check-input` grava os itens que vão ao ar
 * (`factCheckItems`, a união das versões, com a fala ouvida quando difere do
 * pedido) e o hash deles; o agent `fact-checker` (`mode: "video"`) grava
 * `fact-check.json`; o `roteiro` lê esse JSON e põe os achados no Doc do Gate 2
 * (`factCheckSection`), com o trecho do bruto e a proposta de corte.
 * Puro, sem I/O.
 */

import { createHash } from "node:crypto";
import { clockTime, itemInTarget, normalizeToken, type BlockKey, type Interval, type ResolvedItem, type SequencePlan } from "./video-montage.ts";
import { BLOCK_LABELS, mdCell, versionLabel } from "./video-montage-docs.ts";

/** Um item do roteiro que vai ao ar em pelo menos uma versão. */
export interface FactCheckItem {
  /** `{bloco}[{índice}]`, o índice do item no bloco do `blocks.json` resolvido. */
  id: string;
  block: BlockKey;
  index: number;
  /** O texto pedido no roteiro. */
  text: string;
  /** A fala ouvida no trecho, quando difere do pedido (#11362): é ela que vai ao ar. */
  heard?: string;
  /** Trecho do bruto (s). */
  start: number;
  end: number;
  /** Versões (rótulo do Doc) em que o item entra. */
  versions: string[];
}

/** Os itens que vão ao ar, na ordem da 1ª versão em que aparecem; cada um uma vez. */
export function factCheckItems(plans: SequencePlan[], resolved: Partial<Record<BlockKey, ResolvedItem[]>>): FactCheckItem[] {
  const byId = new Map<string, FactCheckItem>();
  // A versão mais longa primeiro (o horizontal): a ordem do Doc segue a fala dela.
  const ordered = [...plans].sort((a, b) => b.durationFrames - a.durationFrames);
  for (const p of ordered) {
    for (const key of p.spec.order) {
      (resolved[key] ?? []).forEach((it, index) => {
        if (!itemInTarget(it, p.spec)) return;
        const id = `${key}[${index}]`;
        const label = versionLabel(p.spec);
        const prev = byId.get(id);
        if (prev) {
          if (!prev.versions.includes(label)) prev.versions.push(label);
          return;
        }
        byId.set(id, { id, block: key, index, text: it.text, ...(it.heard !== undefined ? { heard: it.heard } : {}), start: it.interval.start, end: it.interval.end, versions: [label] });
      });
    }
  }
  return [...byId.values()];
}

/** Hash do que foi checado: texto e fala de cada item (o tempo no bruto não muda o fato). */
export function factCheckItemsSha256(items: FactCheckItem[]): string {
  return createHash("sha256").update(JSON.stringify(items.map((i) => [i.id, i.text, i.heard ?? null]))).digest("hex");
}

export const VIDEO_FACT_VERDICTS = ["SUSTAINED", "INFERRED", "DIVERGENT", "NOT_FOUND_IN_SOURCE", "SOURCE_UNREACHABLE"] as const;
export type VideoFactVerdict = (typeof VIDEO_FACT_VERDICTS)[number];
/** Vereditos graves: entram no Doc do Gate 2 com a proposta de corte. */
export const GRAVE_VERDICTS: ReadonlySet<VideoFactVerdict> = new Set(["DIVERGENT", "NOT_FOUND_IN_SOURCE"]);

export interface VideoFactClaim {
  /** `id` do item (`comentario[2]`). */
  item: string;
  /** Trecho verbatim da fala. */
  claim: string;
  claim_type?: string;
  verdict: VideoFactVerdict;
  source_url?: string;
  note?: string;
  /** Valor certo, verbatim da fonte (só DIVERGENT). */
  suggested_fix?: string;
}

export interface VideoFactCheck {
  mode: "video";
  edition: string;
  /** `factCheckItemsSha256` dos itens checados. */
  items_sha256: string;
  claims: VideoFactClaim[];
}

/** Valida o `fact-check.json` do agent; formato errado = erro com o campo. */
export function parseVideoFactCheck(raw: unknown): VideoFactCheck {
  const o = raw as Partial<VideoFactCheck> | null;
  if (!o || typeof o !== "object") throw new Error("fact-check.json: não é um objeto");
  if (o.mode !== "video") throw new Error(`fact-check.json: mode "${String(o.mode)}", esperado "video"`);
  if (typeof o.items_sha256 !== "string") throw new Error("fact-check.json: items_sha256 ausente (copiar do fact-check-input.json)");
  if (!Array.isArray(o.claims)) throw new Error("fact-check.json: claims não é uma lista");
  o.claims.forEach((c, i) => {
    if (!c || typeof c.claim !== "string" || !c.claim.trim()) throw new Error(`fact-check.json: claims[${i}].claim vazio`);
    if (typeof c.item !== "string") throw new Error(`fact-check.json: claims[${i}].item ausente`);
    if (!(VIDEO_FACT_VERDICTS as readonly string[]).includes(c.verdict)) throw new Error(`fact-check.json: claims[${i}].verdict "${String(c.verdict)}" fora de ${VIDEO_FACT_VERDICTS.join("/")}`);
  });
  return { mode: "video", edition: String(o.edition ?? ""), items_sha256: o.items_sha256, claims: o.claims as VideoFactClaim[] };
}

const norm = (s: string) => s.split(/\s+/).map(normalizeToken).filter(Boolean).join(" ");

/** O item atual que diz o trecho (pela fala ouvida ou pelo texto); sem nenhum, o do `id`, se ainda diz o mesmo. */
export function locateClaim(claim: VideoFactClaim, items: FactCheckItem[]): FactCheckItem | null {
  const c = norm(claim.claim);
  if (!c) return null;
  const says = (it: FactCheckItem) => norm(it.text).includes(c) || (it.heard !== undefined && norm(it.heard).includes(c));
  const byId = items.find((it) => it.id === claim.item);
  if (byId && says(byId)) return byId;
  return items.find(says) ?? null;
}

const span = (i: Interval) => `${clockTime(i.start)}–${clockTime(i.end)}`;

/** A proposta para o editor: corte do item (o padrão da 261103, sem regravação) ou a correção da fonte. */
export function factCheckProposal(claim: VideoFactClaim, item: FactCheckItem): string {
  const cut = `cortar o trecho (bruto ${span(item)}: \`"skip"\` no item ${item.id} do blocks.json, ou intervalo sem a frase)`;
  if (claim.verdict === "DIVERGENT" && claim.suggested_fix) return `${cut}; ou regravar com "${claim.suggested_fix}"`;
  return cut;
}

/**
 * Seção do Doc do Gate 2. `fc` ausente = o passo não rodou (aviso no Doc).
 * Achado cujo trecho saiu do roteiro (editor já cortou) vira "resolvido".
 */
export function factCheckSection(fc: VideoFactCheck | null, items: FactCheckItem[]): { lines: string[]; graves: number; stale: boolean } {
  const lines = ["## Fact-check da fala (#11956)", ""];
  if (!fc) {
    lines.push("**[aviso] fact-check não rodou:** rodar o Passo 3a (`fact-check-input` + agent `fact-checker` em `mode: \"video\"`) antes de aprovar o Gate 2.", "");
    return { lines, graves: 0, stale: false };
  }
  const stale = fc.items_sha256 !== factCheckItemsSha256(items);
  if (stale) lines.push("**[aviso] o roteiro mudou depois do fact-check:** os achados abaixo são da versão anterior; frases novas não foram checadas (rodar o Passo 3a de novo).", "");
  const graves = fc.claims.filter((c) => GRAVE_VERDICTS.has(c.verdict));
  const unreachable = fc.claims.filter((c) => c.verdict === "SOURCE_UNREACHABLE");
  const ok = fc.claims.length - graves.length - unreachable.length;
  let open = 0;
  if (graves.length) {
    lines.push("| # | Bloco | Fala | Bruto | Veredito | Proposta |", "|---|---|---|---|---|---|");
    graves.forEach((c, k) => {
      const it = locateClaim(c, items);
      const why = [c.verdict, c.note, c.source_url].filter(Boolean).join(": ");
      if (!it) {
        lines.push(`| ${k + 1} | ${mdCell(c.item)} | ${mdCell(c.claim)} |  | ${mdCell(why)} | resolvido: o trecho saiu do roteiro |`);
        return;
      }
      open++;
      lines.push(`| ${k + 1} | ${mdCell(`${BLOCK_LABELS[it.block]} [${it.index}]`)} | ${mdCell(c.claim)} | ${span(it)} | ${mdCell(why)} | ${mdCell(factCheckProposal(c, it))} |`);
    });
    lines.push("");
  }
  for (const c of unreachable) lines.push(`- **não verificado** (fonte fora do ar): "${mdCell(c.claim)}"${c.source_url ? ` (${c.source_url})` : ""}`);
  if (unreachable.length) lines.push("");
  lines.push(`${open} achado(s) grave(s) em aberto, ${unreachable.length} não verificado(s), ${ok} sustentado(s) ou inferido(s).`, "");
  return { lines, graves: open, stale };
}
