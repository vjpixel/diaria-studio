/**
 * blind-label-core.ts (#8413 — Fase 0 do epic #8412)
 *
 * Motor genérico de gabarito cego, generalizado de `scripts/blind-label-sample.ts`
 * (#5995/#8206, que era hardcoded pro bucket do categorizador). Cada FEATURE
 * (ver `scripts/lib/blind-label-features.ts`) declara como coletar seu pool de
 * candidatos "em silêncio" e qual o vocabulário de rótulos aceito; este
 * módulo faz a amostragem estratificada, a cegueira (nunca expõe o palpite
 * do mecanismo atual antes do rótulo), e a persistência.
 *
 * Layout em disco (novo — #8413, generaliza `data/bucket-blind-labels.json`):
 *   data/jev-eval/{feature}/sample.json    — amostra gerada (sem rótulos)
 *   data/jev-eval/{feature}/labels.jsonl   — rótulos, append-only, 1 por linha
 *
 * Por que separar amostra de rótulos: rótulo é caro e insubstituível (mesmo
 * princípio do #8206) — um arquivo append-only nunca precisa reescrever o que
 * já foi gravado, então uma falha de escrita a meio de `--record` no MÁXIMO
 * perde a linha em progresso, nunca corrompe histórico anterior. `sample.json`
 * pode ser regenerado livremente (mesmo invariante aditivo do #8206: nenhum
 * item já rotulado pode sair da amostra numa re-geração).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const MAX_RANK = 0xffffffff;
export const MIN_PER_STRATUM = 8;

export interface PoolItem {
  /** Identidade estável do item (URL, id de artigo, etc). */
  id: string;
  /** Estado a mostrar ao rotulador — nunca inclui o palpite do mecanismo. */
  display: Record<string, unknown>;
  /** `state` a passar pra `askJev` quando for medir — pode ser igual a `display` ou um subconjunto/superset. */
  jevState: Record<string, unknown>;
  /** Estratégia de estratificação — grupo do item (ex: bucket atual). NUNCA mostrado ao rotulador antes do rótulo. */
  stratum: string;
  /** Palpite do mecanismo atual — NUNCA mostrado ao rotulador antes do rótulo. */
  hiddenGuess: string;
  /** Regra/motivo do palpite, se houver — só pra relatório posterior. */
  hiddenRule?: string;
  edition?: string;
}

export interface LabeledItem extends PoolItem {
  label?: string;
  labeled_at?: string;
}

export interface FeatureDef {
  id: string;
  /** Vocabulário de rótulos aceitos por `--record` (inclui qualquer "não pertence"/opt-out da própria feature). */
  labels: readonly string[];
  /** Coleta o pool de candidatos "em silêncio" pra esta feature. `rootDir` = raiz do repo. */
  collectPool(rootDir: string): { pool: PoolItem[]; skipped: string[] };
  /**
   * Rótulos de OPT-OUT — "isto não pertence a nenhuma das opções que o
   * mecanismo/Jev conseguem produzir" (ex: `nao_pertence` do bucket do
   * categorizador). Itens rotulados assim saem do cálculo de acordo/
   * discordância de `report()` e da avaliação de `jev-eval.ts` — contar
   * como erro puniria QUALQUER classificador pela mesma limitação
   * estrutural de vocabulário, não por ter julgado mal. Default `[]` (toda
   * feature sem opt-out declarado avalia 100% dos rótulos).
   */
  optOutLabels?: readonly string[];
}

interface SampleState {
  generated_at: string;
  items: PoolItem[];
}

export function featureDir(rootDir: string, feature: string): string {
  return join(rootDir, "data", "jev-eval", feature);
}

function samplePath(rootDir: string, feature: string): string {
  return join(featureDir(rootDir, feature), "sample.json");
}

function labelsPath(rootDir: string, feature: string): string {
  return join(featureDir(rootDir, feature), "labels.jsonl");
}

/** Ordem determinística por hash do id — estável entre rodadas e máquinas. */
export function stableRank(id: string): number {
  return parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
}

/**
 * Corte no espaço de hash que rende ~`target` itens de um estrato com
 * `strataSize` candidatos, proporcional ao PRÓPRIO estrato (nunca ao pool
 * inteiro) — crescimento de outro estrato não encolhe este. Piso de
 * `MIN_PER_STRATUM` pra que estrato raro ainda renda precisão própria.
 */
export function stratumQuota(strataSize: number, poolSize: number, target: number): number {
  if (strataSize <= 0 || poolSize <= 0 || !Number.isFinite(target) || target <= 0) return 0;
  const proportional = Math.round((strataSize / poolSize) * target);
  return Math.min(Math.max(MIN_PER_STRATUM, proportional), strataSize);
}

/**
 * Seleção por limiar: itens cujo `stableRank` cai abaixo do corte, MAIS todo
 * item já rotulado (nunca sai da amostra, mesmo fora do corte) — mesmo
 * invariante aditivo do #8206.
 */
export function selectByThreshold(
  candidates: PoolItem[],
  quota: number,
  alreadyLabeled: ReadonlySet<string>,
): PoolItem[] {
  if (candidates.length === 0) return [];
  const cutoff = quota >= candidates.length ? MAX_RANK : Math.floor((quota / candidates.length) * MAX_RANK);
  const picked = candidates.filter((c) => stableRank(c.id) <= cutoff || alreadyLabeled.has(c.id));
  return picked.sort((a, b) => stableRank(a.id) - stableRank(b.id));
}

function loadSample(rootDir: string, feature: string): SampleState | null {
  const p = samplePath(rootDir, feature);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function saveSample(rootDir: string, feature: string, s: SampleState): void {
  mkdirSync(featureDir(rootDir, feature), { recursive: true });
  writeFileSync(samplePath(rootDir, feature), JSON.stringify(s, null, 2));
}

interface LabelRecord {
  id: string;
  label: string;
  labeled_at: string;
}

/** Lê todos os rótulos gravados (append-only jsonl) — o ÚLTIMO registro por id vence. */
export function loadLabels(rootDir: string, feature: string): Map<string, LabelRecord> {
  const p = labelsPath(rootDir, feature);
  const byId = new Map<string, LabelRecord>();
  if (!existsSync(p)) return byId;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as LabelRecord;
      if (rec?.id) byId.set(rec.id, rec);
    } catch {
      // linha corrompida (write parcial) — ignora, não derruba o resto.
    }
  }
  return byId;
}

function appendLabel(rootDir: string, feature: string, rec: LabelRecord): void {
  mkdirSync(featureDir(rootDir, feature), { recursive: true });
  appendFileSync(labelsPath(rootDir, feature), JSON.stringify(rec) + "\n", "utf8");
}

/**
 * Une amostra + rótulos numa lista de `LabeledItem` — a view que `--next`/
 * `--report`/`jev-eval.ts` consomem.
 */
export function loadLabeledSample(rootDir: string, feature: string): LabeledItem[] | null {
  const sample = loadSample(rootDir, feature);
  if (!sample) return null;
  const labels = loadLabels(rootDir, feature);
  return sample.items.map((item) => {
    const rec = labels.get(item.id);
    return rec ? { ...item, label: rec.label, labeled_at: rec.labeled_at } : { ...item };
  });
}

export function generate(rootDir: string, def: FeatureDef, n: number): {
  poolSize: number;
  pickedCount: number;
  byStratum: Map<string, number>;
  alreadyLabeled: number;
  skipped: string[];
} {
  const { pool, skipped } = def.collectPool(rootDir);
  const labels = loadLabels(rootDir, def.id);
  const labeledIds = new Set(labels.keys());

  const strata = [...new Set(pool.map((p) => p.stratum))].sort();
  const picked: PoolItem[] = [];
  for (const s of strata) {
    const candidates = pool.filter((p) => p.stratum === s);
    const quota = stratumQuota(candidates.length, pool.length, n);
    picked.push(...selectByThreshold(candidates, quota, labeledIds));
  }

  // Guard do invariante aditivo: nenhum rótulo pago pode sumir numa re-geração.
  const keptIds = new Set(picked.map((p) => p.id));
  const lost = [...labeledIds].filter((id) => !keptIds.has(id));
  if (lost.length > 0) {
    throw new Error(
      `ABORTADO: ${lost.length} item(ns) já rotulado(s) sairiam da amostra: ${lost.join(", ")}. ` +
        `Nada foi gravado — o estado anterior segue intacto.`,
    );
  }

  saveSample(rootDir, def.id, { generated_at: new Date().toISOString(), items: picked });

  const byStratum = new Map<string, number>();
  for (const s of strata) byStratum.set(s, picked.filter((p) => p.stratum === s).length);

  return { poolSize: pool.length, pickedCount: picked.length, byStratum, alreadyLabeled: labeledIds.size, skipped };
}

export function next(rootDir: string, feature: string, k: number): LabeledItem[] {
  const labeled = loadLabeledSample(rootDir, feature);
  if (!labeled) throw new Error("rode --generate primeiro");
  return labeled.filter((i) => !i.label).slice(0, k);
}

export function record(rootDir: string, def: FeatureDef, id: string, label: string): void {
  const sample = loadSample(rootDir, def.id);
  if (!sample) throw new Error("rode --generate primeiro");
  if (!sample.items.some((i) => i.id === id)) {
    throw new Error(`id não está na amostra: ${id}`);
  }
  if (!def.labels.includes(label)) {
    throw new Error(`rótulo inválido: ${label} (aceitos: ${def.labels.join(", ")})`);
  }
  appendLabel(rootDir, def.id, { id, label, labeled_at: new Date().toISOString() });
}

export interface ReportSummary {
  total: number;
  labeled: number;
  agree: number;
  disagreements: Array<{ id: string; hiddenGuess: string; label: string; hiddenRule?: string }>;
}

export function report(rootDir: string, def: FeatureDef): ReportSummary | null {
  const labeled = loadLabeledSample(rootDir, def.id);
  if (!labeled) return null;
  const optOut = new Set(def.optOutLabels ?? []);
  const done = labeled.filter((i) => i.label && !optOut.has(i.label));
  const agree = done.filter((i) => i.hiddenGuess === i.label).length;
  const disagreements = done
    .filter((i) => i.hiddenGuess !== i.label)
    .map((i) => ({ id: i.id, hiddenGuess: i.hiddenGuess, label: i.label as string, hiddenRule: i.hiddenRule }));
  return { total: labeled.length, labeled: done.length, agree, disagreements };
}
