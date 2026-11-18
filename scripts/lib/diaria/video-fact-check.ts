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

/**
 * Hash do que foi checado: texto e fala de cada item (o tempo no bruto não muda
 * o fato) e, desde #13132, as fontes do roteiro (`url` + `sustenta`): trocar
 * uma fonte depois do fact-check também o torna velho. Sem fontes, o hash é o
 * de antes, para um `fact-check.json` já gravado continuar valendo.
 */
export function factCheckItemsSha256(items: FactCheckItem[], fontes: ReadonlyArray<{ fala: string; url: string; sustenta: string }> = []): string {
  const base = items.map((i) => [i.id, i.text, i.heard ?? null]);
  const payload = fontes.length ? { items: base, fontes: fontes.map((f) => [f.fala, f.url, f.sustenta]) } : base;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
 * Achado cujo trecho saiu do roteiro (editor já cortou) vira "resolvido", mas
 * só com o roteiro mudado (`stale`); sem mudança, claim não localizado segue em
 * aberto como "não localizado, conferir" (#11994).
 */
export function factCheckSection(
  fc: VideoFactCheck | null,
  items: FactCheckItem[],
  fontes: ReadonlyArray<{ fala: string; url: string; sustenta: string }> = [],
): { lines: string[]; graves: number; stale: boolean } {
  const lines = ["## Fact-check da fala (#11956)", ""];
  if (!fc) {
    lines.push("**[aviso] fact-check não rodou (ou o agent ainda não voltou):** rodar o Passo 2b (`fact-check-input` + agent `fact-checker` em `mode: \"video\"`) e esperar o resultado antes de aprovar o Gate 2.", "");
    return { lines, graves: 0, stale: false };
  }
  const stale = fc.items_sha256 !== factCheckItemsSha256(items, fontes);
  if (stale) lines.push("**[aviso] o roteiro mudou depois do fact-check:** os achados abaixo são da versão anterior; frases ou fontes novas não foram checadas (rodar `fact-check-input` de novo: refaz só os itens que mudaram, #13597).", "");
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
        // "Resolvido" só se o roteiro mudou (#11994): com o mesmo roteiro, um
        // claim não localizado é paráfrase ou junção de frases do agent, e o
        // achado continua em aberto.
        if (stale) {
          lines.push(`| ${k + 1} | ${mdCell(c.item)} | ${mdCell(c.claim)} |  | ${mdCell(why)} | resolvido: o trecho saiu do roteiro |`);
          return;
        }
        open++;
        const byId = items.find((i) => i.id === c.item);
        const where = byId ? `${BLOCK_LABELS[byId.block]} [${byId.index}]` : c.item;
        lines.push(`| ${k + 1} | ${mdCell(where)} | ${mdCell(c.claim)} | ${byId ? span(byId) : ""} | ${mdCell(why)} | trecho não localizado no roteiro, conferir${byId ? ` o item ${mdCell(byId.id)}` : ""} |`);
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

// ── Fact-check incremental (#13597) ─────────────────────────────────────────
//
// O fact-check da fala passou a rodar logo depois da decupagem, em paralelo
// com `face`/`roteiro`. Quando o editor muda a fala no Gate 2 (tomada trocada,
// corte de repetição, texto corrigido), refazer só os itens cujo texto/fala
// mudou: o `fact-check-input` grava o delta e os achados dos itens que não
// mudaram (`carried_claims`), o agent checa só o delta e o `fact-check-merge`
// junta os dois no `fact-check.json`.

type Fonte = { fala: string; url: string; sustenta: string };

/** Hash do que o fact-check checa num item: o texto pedido e a fala ouvida (o tempo e o índice não mudam o fato). */
export function factCheckItemHash(item: Pick<FactCheckItem, "text" | "heard">): string {
  return createHash("sha256").update(JSON.stringify([item.text, item.heard ?? null])).digest("hex");
}

/** Hash só das fontes do roteiro: trocar uma fonte refaz o fact-check inteiro. */
export function factCheckFontesSha256(fontes: ReadonlyArray<Fonte> = []): string {
  return createHash("sha256").update(JSON.stringify(fontes.map((f) => [f.fala, f.url, f.sustenta]))).digest("hex");
}

/** O que o `fact-check-input` anterior registrou: o hash de todos os itens daquela versão e o das fontes. */
export interface CheckedSnapshot {
  /** `items_sha256` daquela versão (o mesmo que o agent copiou para o `fact-check.json`). */
  items_sha256: string;
  /** Um por item da versão inteira (não só do delta). */
  all_items: Array<{ id: string; hash: string }>;
  fontes_sha256: string;
}

/**
 * O snapshot que o `fact-check.json` atual cobre, a partir do
 * `fact-check-input.json` que o gerou (`items_sha256` igual). `null` = não dá
 * para saber o que foi checado (sem fact-check, input ausente ou de outra
 * versão, formato ilegível): aí o fact-check é inteiro.
 */
export function checkedSnapshotFrom(prevInput: unknown, fc: VideoFactCheck | null): CheckedSnapshot | null {
  if (!fc) return null;
  const o = prevInput as { items_sha256?: unknown; all_items?: unknown; items?: unknown; fontes_sha256?: unknown; roteiro_fontes?: unknown } | null;
  if (!o || typeof o !== "object" || o.items_sha256 !== fc.items_sha256) return null;
  let all: Array<{ id: string; hash: string }> | null = null;
  if (Array.isArray(o.all_items)) {
    const raw = o.all_items as Array<{ id?: unknown; hash?: unknown }>;
    if (raw.some((x) => typeof x?.id !== "string" || typeof x?.hash !== "string")) return null;
    all = raw as Array<{ id: string; hash: string }>;
  } else if (Array.isArray(o.items)) {
    // Input anterior ao #13597: era sempre o fact-check inteiro, `items` = todos.
    const items = o.items as Array<Partial<FactCheckItem>>;
    if (items.some((i) => typeof i?.id !== "string" || typeof i?.text !== "string")) return null;
    all = items.map((i) => ({ id: i.id!, hash: factCheckItemHash({ text: i.text!, heard: i.heard }) }));
  }
  if (!all) return null;
  const fontesSha =
    typeof o.fontes_sha256 === "string" ? o.fontes_sha256 : factCheckFontesSha256(Array.isArray(o.roteiro_fontes) ? (o.roteiro_fontes as Fonte[]) : []);
  return { items_sha256: o.items_sha256 as string, all_items: all, fontes_sha256: fontesSha };
}

export type FactCheckPlan =
  | { mode: "full"; reason: string; check: FactCheckItem[] }
  | { mode: "em-dia" }
  | { mode: "delta"; check: FactCheckItem[]; carried: VideoFactClaim[]; reused: number };

/**
 * O que checar agora (#13597). `full` sem fact-check anterior utilizável, com
 * as fontes do roteiro trocadas ou com achado que não se liga a item nenhum da
 * versão checada (o agent citou um id de fora: não dá para saber se segue
 * valendo). `em-dia` com o hash inteiro igual. `delta` = só os itens com texto
 * ou fala novos; os achados dos itens que não mudaram seguem, com o `item`
 * trocado pelo id atual (inserir um item renumera o bloco), e os dos itens
 * que mudaram ou saíram caem (o agent checa o texto novo).
 */
export function planVideoFactCheck(items: FactCheckItem[], fontes: ReadonlyArray<Fonte>, fc: VideoFactCheck | null, snapshot: CheckedSnapshot | null): FactCheckPlan {
  if (!fc) return { mode: "full", reason: "sem fact-check anterior", check: items };
  if (fc.items_sha256 === factCheckItemsSha256(items, fontes)) return { mode: "em-dia" };
  if (!snapshot) return { mode: "full", reason: "fact-check anterior sem o registro do que foi checado (fact-check-input.json ausente, de outra versão ou ilegível)", check: items };
  if (snapshot.fontes_sha256 !== factCheckFontesSha256(fontes)) return { mode: "full", reason: "as fontes do roteiro mudaram", check: items };
  const oldHashById = new Map(snapshot.all_items.map((x) => [x.id, x.hash]));
  const checked = new Set(snapshot.all_items.map((x) => x.hash));
  const curIdByHash = new Map<string, string>();
  for (const it of items) {
    const h = factCheckItemHash(it);
    if (!curIdByHash.has(h)) curIdByHash.set(h, it.id);
  }
  const carried: VideoFactClaim[] = [];
  for (const c of fc.claims) {
    const h = oldHashById.get(c.item);
    if (h === undefined) return { mode: "full", reason: `achado com item "${c.item}" fora da versão checada`, check: items };
    const now = curIdByHash.get(h);
    if (now !== undefined) carried.push({ ...c, item: now });
  }
  const check = items.filter((it) => !checked.has(factCheckItemHash(it)));
  return { mode: "delta", check, carried, reused: items.length - check.length };
}

/**
 * Junta o delta que o agent checou com os achados carregados (#13597). O
 * `items_sha256` do delta é o da versão inteira (o `fact-check-input` grava
 * esse, o agent copia): diferente do esperado = delta de outra versão, erro.
 */
export function mergeVideoFactCheck(delta: VideoFactCheck, carried: VideoFactClaim[], expectedSha: string): VideoFactCheck {
  if (delta.items_sha256 !== expectedSha) {
    throw new Error(`fact-check do delta é de outra versão (items_sha256 ${delta.items_sha256.slice(0, 12)}…, esperado ${expectedSha.slice(0, 12)}…): rodar fact-check-input e o agent de novo`);
  }
  return { mode: "video", edition: delta.edition, items_sha256: expectedSha, claims: [...carried, ...delta.claims] };
}
