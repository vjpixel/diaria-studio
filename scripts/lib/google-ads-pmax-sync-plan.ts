/**
 * scripts/lib/google-ads-pmax-sync-plan.ts (#8550)
 *
 * Plano auditável da troca de criativos do PMax "Max" — o que
 * `scripts/google-ads-swap-asset-group-creatives.ts` grava em JSON
 * (`--plan-out`) e usa como trava antes/depois de cada mutação:
 *
 *   1. **Contagem por field_type passo a passo** (`simulateSteps`): estado de
 *      hoje → cada `assetGroupAssets:mutate` da Fase 1 (link dos novos, com a
 *      remoção atômica mínima do #9017/#9057/#9080) → Fase 2. Marca violação
 *      quando um passo deixa um tipo acima do máximo, ou o REMOVE abaixo do
 *      mínimo do PMax.
 *   2. **Piso na Fase 2** (`planPhase2Removal`): a remoção dos antigos nunca
 *      deixa um tipo abaixo do mínimo contando só o que o Google já APROVOU
 *      (`policy_summary.approval_status` APPROVED/APPROVED_LIMITED). Até este
 *      módulo, `--send --remove-stale` removia TODO o stale sem olhar piso
 *      nem aprovação — rodado antes da Fase 1 (ou com os novos ainda em
 *      revisão/reprovados), deixava o grupo com 1 headline e 0 imagem
 *      paisagem, abaixo do mínimo obrigatório.
 *   3. **Releitura pós-mutação** (`verifyLinkedAfterApply`,
 *      `verifyRemovedAfterApply`): 2xx com a contagem certa de `results` não
 *      prova o estado do grupo (escrita silenciosa já aconteceu em outras
 *      plataformas de anúncio) — a CLI relê o grupo depois de cada fase e
 *      compara com o que pediu.
 *
 * Tudo aqui é puro (sem rede, sem disco).
 */

import {
  PMAX_TEXT_LIMITS,
  PMAX_IMAGE_FIELD_MAX,
  PMAX_IMAGE_FIELD_MIN,
  PMAX_IMAGE_COMBINED_MAX,
  type AssetGroupAssetItem,
  type AssetGroupClassification,
  type FieldLinkPlan,
  type ImageFieldType,
  type TextFieldType,
} from "./google-ads-asset-group-assets.ts";

export type ManagedFieldType = TextFieldType | ImageFieldType;

/** Mínimo/máximo de `asset_group_asset` ENABLED por tipo que este fluxo
 *  mexe — derivado das constantes do módulo irmão (fonte única). */
export const PMAX_MANAGED_FIELD_LIMITS: Readonly<Record<ManagedFieldType, { min: number; max: number }>> = {
  HEADLINE: { min: PMAX_TEXT_LIMITS.headline.min, max: PMAX_TEXT_LIMITS.headline.max },
  LONG_HEADLINE: { min: PMAX_TEXT_LIMITS.longHeadline.min, max: PMAX_TEXT_LIMITS.longHeadline.max },
  DESCRIPTION: { min: PMAX_TEXT_LIMITS.description.min, max: PMAX_TEXT_LIMITS.description.max },
  SQUARE_MARKETING_IMAGE: { min: PMAX_IMAGE_FIELD_MIN.SQUARE_MARKETING_IMAGE, max: PMAX_IMAGE_FIELD_MAX.SQUARE_MARKETING_IMAGE },
  MARKETING_IMAGE: { min: PMAX_IMAGE_FIELD_MIN.MARKETING_IMAGE, max: PMAX_IMAGE_FIELD_MAX.MARKETING_IMAGE },
  PORTRAIT_MARKETING_IMAGE: { min: PMAX_IMAGE_FIELD_MIN.PORTRAIT_MARKETING_IMAGE, max: PMAX_IMAGE_FIELD_MAX.PORTRAIT_MARKETING_IMAGE },
};

export const MANAGED_FIELD_TYPES = Object.keys(PMAX_MANAGED_FIELD_LIMITS) as readonly ManagedFieldType[];
const IMAGE_TYPES = Object.keys(PMAX_IMAGE_FIELD_MAX) as readonly ImageFieldType[];

function isManaged(ft: string): ft is ManagedFieldType {
  return (MANAGED_FIELD_TYPES as readonly string[]).includes(ft);
}

/** Aprovação que conta pro piso. `UNKNOWN`/ausente (em revisão, ou campo não
 *  lido) NÃO conta — fail-closed: na dúvida o antigo fica. */
export const CONFIRMED_APPROVAL_STATUSES: ReadonlySet<string> = new Set(["APPROVED", "APPROVED_LIMITED"]);

export function isApprovalConfirmed(item: Pick<AssetGroupAssetItem, "approvalStatus">): boolean {
  return item.approvalStatus !== undefined && CONFIRMED_APPROVAL_STATUSES.has(item.approvalStatus);
}

export type FieldCounts = Record<ManagedFieldType, number>;

/** @pure */
export function countEnabledByFieldType(items: readonly AssetGroupAssetItem[]): FieldCounts {
  const counts = Object.fromEntries(MANAGED_FIELD_TYPES.map((ft) => [ft, 0])) as FieldCounts;
  for (const i of items) if (i.status === "ENABLED" && isManaged(i.fieldType)) counts[i.fieldType]++;
  return counts;
}

export interface SyncStep {
  label: string;
  /** Quantos recursos novos o passo linka, por tipo. */
  add: Partial<Record<ManagedFieldType, number>>;
  /** `asset_group_asset` removidos no MESMO passo, com o tipo de cada um. */
  remove: ReadonlyArray<{ resourceName: string; fieldType: string }>;
}

export interface CountSnapshot {
  label: string;
  counts: FieldCounts;
  imagesCombined: number;
  violations: string[];
}

/**
 * Aplica os passos em ordem e devolve a contagem depois de cada um. Violação
 * = o passo deixa um tipo acima do máximo, o teto combinado de imagens
 * estourado, ou um tipo abaixo do mínimo PORQUE o passo removeu dele (um tipo
 * que já estava abaixo antes e o passo não tocou não é culpa do passo).
 * @pure
 */
export function simulateSteps(initial: FieldCounts, steps: readonly SyncStep[]): CountSnapshot[] {
  let counts: FieldCounts = { ...initial };
  const snapshots: CountSnapshot[] = [];
  for (const step of steps) {
    const next: FieldCounts = { ...counts };
    const removedFrom = new Set<ManagedFieldType>();
    for (const [ft, n] of Object.entries(step.add) as Array<[ManagedFieldType, number]>) next[ft] += n;
    for (const r of step.remove) {
      if (!isManaged(r.fieldType)) continue;
      next[r.fieldType]--;
      removedFrom.add(r.fieldType);
    }
    const violations: string[] = [];
    for (const ft of MANAGED_FIELD_TYPES) {
      const { min, max } = PMAX_MANAGED_FIELD_LIMITS[ft];
      if (next[ft] > max) violations.push(`${ft}: ${next[ft]} > máximo ${max}`);
      if (removedFrom.has(ft) && next[ft] < min) violations.push(`${ft}: ${next[ft]} < mínimo ${min} (o passo removeu deste tipo)`);
    }
    const imagesCombined = IMAGE_TYPES.reduce((a, ft) => a + next[ft], 0);
    const addedImages = IMAGE_TYPES.some((ft) => (step.add[ft] ?? 0) > 0);
    if (addedImages && imagesCombined > PMAX_IMAGE_COMBINED_MAX) {
      violations.push(`imagens somadas: ${imagesCombined} > teto combinado ${PMAX_IMAGE_COMBINED_MAX}`);
    }
    snapshots.push({ label: step.label, counts: next, imagesCombined, violations });
    counts = next;
  }
  return snapshots;
}

/** Converte o plano de link da Fase 1 (um mutate por fieldType) em passos. */
export function phase1StepsFromLinkPlans(
  plans: ReadonlyArray<FieldLinkPlan>,
  items: readonly AssetGroupAssetItem[],
): SyncStep[] {
  const ftByAga = new Map(items.map((i) => [i.assetGroupAssetResourceName, i.fieldType]));
  return plans
    .filter((p) => p.newCount > 0)
    .map((p) => ({
      label: `Fase 1 — link ${p.fieldType}`,
      add: { [p.fieldType]: p.newCount } as Partial<Record<ManagedFieldType, number>>,
      remove: p.removeInSameMutate.map((rn) => ({ resourceName: rn, fieldType: ftByAga.get(rn) ?? "UNKNOWN" })),
    }));
}

export interface Phase2FieldPlan {
  fieldType: ManagedFieldType;
  min: number;
  /** ENABLED não-stale com aprovação confirmada — o que sobra garantido. */
  confirmedPermanent: number;
  /** ENABLED não-stale ainda sem aprovação confirmada (em revisão/reprovado). */
  unconfirmedPermanent: number;
  staleEnabled: number;
  remove: string[];
  /** Stale mantidos porque removê-los deixaria o tipo abaixo do mínimo. */
  retain: string[];
}

export interface Phase2RemovalPlan {
  remove: string[];
  fields: Phase2FieldPlan[];
  /** Stale de tipo fora dos 6 gerenciados — nunca removido aqui (não há
   *  piso conhecido pra ele); reportado. */
  unmanagedStale: string[];
}

/**
 * Plano da Fase 2 com piso: por tipo, remove o stale só até o ponto em que o
 * que SOBRA aprovado (não-stale com `approval_status` confirmado) cobre o
 * mínimo do PMax. Se os novos ainda estão em revisão, o stale necessário pro
 * piso fica — a Fase 2 pode ser rodada de novo depois, e remove o resto.
 * @pure
 */
export function planPhase2Removal(
  items: readonly AssetGroupAssetItem[],
  classification: Pick<AssetGroupClassification, "stale">,
): Phase2RemovalPlan {
  const staleSet = new Set(classification.stale.map((i) => i.assetGroupAssetResourceName));
  const fields: Phase2FieldPlan[] = [];
  const remove: string[] = [];
  for (const ft of MANAGED_FIELD_TYPES) {
    const enabled = items.filter((i) => i.status === "ENABLED" && i.fieldType === ft);
    const stale = enabled.filter((i) => staleSet.has(i.assetGroupAssetResourceName));
    const permanent = enabled.filter((i) => !staleSet.has(i.assetGroupAssetResourceName));
    const confirmedPermanent = permanent.filter(isApprovalConfirmed).length;
    const { min } = PMAX_MANAGED_FIELD_LIMITS[ft];
    const retainCount = Math.min(stale.length, Math.max(0, min - confirmedPermanent));
    // Mantém primeiro os stale JÁ aprovados — são os que de fato servem.
    const ordered = [...stale].sort((a, b) => Number(isApprovalConfirmed(b)) - Number(isApprovalConfirmed(a)));
    const retain = ordered.slice(0, retainCount).map((i) => i.assetGroupAssetResourceName);
    const removeFt = ordered.slice(retainCount).map((i) => i.assetGroupAssetResourceName);
    remove.push(...removeFt);
    fields.push({
      fieldType: ft,
      min,
      confirmedPermanent,
      unconfirmedPermanent: permanent.length - confirmedPermanent,
      staleEnabled: stale.length,
      remove: removeFt,
      retain,
    });
  }
  const unmanagedStale = classification.stale
    .filter((i) => i.status === "ENABLED" && !isManaged(i.fieldType))
    .map((i) => i.assetGroupAssetResourceName);
  return { remove, fields, unmanagedStale };
}

/**
 * Estado PROJETADO depois da Fase 1: tira o que sai no mesmo mutate do link e
 * acrescenta os novos como ENABLED. `assumeNewApproved` marca os novos como
 * APPROVED — premissa explícita do dry-run (a aprovação real só existe depois
 * da revisão do Google; a Fase 2 de verdade relê o estado).
 * @pure
 */
export function projectItemsAfterPhase1(
  items: readonly AssetGroupAssetItem[],
  steps: readonly SyncStep[],
  assumeNewApproved: boolean,
): AssetGroupAssetItem[] {
  const removed = new Set(steps.flatMap((s) => s.remove.map((r) => r.resourceName)));
  const out = items.filter((i) => !removed.has(i.assetGroupAssetResourceName));
  for (const step of steps) {
    for (const [ft, n] of Object.entries(step.add) as Array<[ManagedFieldType, number]>) {
      for (let k = 1; k <= n; k++) {
        const name = `(novo) ${ft} #${k}`;
        out.push({
          assetGroupAssetResourceName: name,
          assetResourceName: name,
          assetId: name,
          fieldType: ft,
          status: "ENABLED",
          assetType: (IMAGE_TYPES as readonly string[]).includes(ft) ? "IMAGE" : "TEXT",
          ...(assumeNewApproved ? { approvalStatus: "APPROVED" } : {}),
        });
      }
    }
  }
  return out;
}

/** Erros se algum asset pedido não aparece ENABLED no tipo certo na releitura. @pure */
export function verifyLinkedAfterApply(
  itemsAfter: readonly AssetGroupAssetItem[],
  expected: ReadonlyArray<{ fieldType: string; assetResourceNames: readonly string[] }>,
): string[] {
  const errors: string[] = [];
  for (const { fieldType, assetResourceNames } of expected) {
    for (const asset of assetResourceNames) {
      const found = itemsAfter.some((i) => i.assetResourceName === asset && i.fieldType === fieldType && i.status === "ENABLED");
      if (!found) errors.push(`${fieldType}: ${asset} não aparece ENABLED no grupo na releitura`);
    }
  }
  return errors;
}

/** Erros se algum `asset_group_asset` removido ainda aparece ENABLED. @pure */
export function verifyRemovedAfterApply(
  itemsAfter: readonly AssetGroupAssetItem[],
  removedAssetGroupAssets: readonly string[],
): string[] {
  const stillEnabled = new Set(
    itemsAfter.filter((i) => i.status === "ENABLED").map((i) => i.assetGroupAssetResourceName),
  );
  return removedAssetGroupAssets.filter((rn) => stillEnabled.has(rn)).map((rn) => `${rn} ainda ENABLED na releitura`);
}

/** Tipos abaixo do mínimo num estado lido (checagem pós-fase). `onlyFieldTypes`
 *  restringe aos tipos que a fase mexeu — um tipo que já estava abaixo e não
 *  foi tocado não é falha da fase. @pure */
export function fieldsBelowMin(items: readonly AssetGroupAssetItem[], onlyFieldTypes?: ReadonlySet<string>): string[] {
  const counts = countEnabledByFieldType(items);
  return MANAGED_FIELD_TYPES.filter(
    (ft) => (!onlyFieldTypes || onlyFieldTypes.has(ft)) && counts[ft] < PMAX_MANAGED_FIELD_LIMITS[ft].min,
  ).map(
    (ft) => `${ft}: ${counts[ft]} < mínimo ${PMAX_MANAGED_FIELD_LIMITS[ft].min}`,
  );
}

export interface SyncPlanReport {
  generatedAt: string;
  assetGroup: string;
  mode: "dry-run" | "phase1" | "phase2-dry-run" | "phase2";
  limits: typeof PMAX_MANAGED_FIELD_LIMITS;
  imagesCombinedMax: number;
  text: {
    headlines: readonly string[];
    longHeadlines: readonly string[];
    descriptions: readonly string[];
    /** Texto acima do limite / contagem fora do intervalo — nunca truncado. */
    errors: readonly string[];
  };
  images: { manifest: Partial<Record<ImageFieldType, readonly string[]>> | null; pending: readonly string[] };
  phase1: { steps: SyncStep[]; snapshots: CountSnapshot[]; capacityErrors: readonly string[] };
  /** Fase 2 projetada sobre o estado pós-Fase 1 (novos ASSUMIDOS aprovados no
   *  dry-run) ou, em `phase2*`, sobre o estado lido agora. */
  phase2: { basis: "projected-after-phase1" | "live"; plan: Phase2RemovalPlan; snapshot: CountSnapshot };
  current: { counts: FieldCounts; stale: number; keep: number; needsReview: Array<{ fieldType: string; assetId: string; label?: string }>; protected: number };
  violations: string[];
}

/** Monta o relatório JSON completo. @pure */
export function buildSyncPlanReport(input: {
  generatedAt: string;
  assetGroup: string;
  mode: SyncPlanReport["mode"];
  items: readonly AssetGroupAssetItem[];
  classification: AssetGroupClassification;
  text: SyncPlanReport["text"];
  images: SyncPlanReport["images"];
  phase1Plans: ReadonlyArray<FieldLinkPlan>;
  capacityErrors: readonly string[];
}): SyncPlanReport {
  const { items, classification } = input;
  const currentCounts = countEnabledByFieldType(items);
  const isPhase2Mode = input.mode === "phase2" || input.mode === "phase2-dry-run";
  const steps = isPhase2Mode ? [] : phase1StepsFromLinkPlans(input.phase1Plans, items);
  const snapshots = simulateSteps(currentCounts, steps);

  let phase2Items: readonly AssetGroupAssetItem[] = items;
  let phase2Stale = classification.stale;
  if (!isPhase2Mode) {
    phase2Items = projectItemsAfterPhase1(items, steps, true);
    const removedInPhase1 = new Set(steps.flatMap((s) => s.remove.map((r) => r.resourceName)));
    phase2Stale = classification.stale.filter((i) => !removedInPhase1.has(i.assetGroupAssetResourceName));
  }
  const phase2Plan = planPhase2Removal(phase2Items, { stale: phase2Stale });
  const ftByAga = new Map(phase2Items.map((i) => [i.assetGroupAssetResourceName, i.fieldType]));
  const afterPhase1Counts = snapshots.length > 0 ? snapshots[snapshots.length - 1].counts : currentCounts;
  const [phase2Snapshot] = simulateSteps(afterPhase1Counts, [
    {
      label: "Fase 2 — remoção dos antigos (com piso)",
      add: {},
      remove: phase2Plan.remove.map((rn) => ({ resourceName: rn, fieldType: ftByAga.get(rn) ?? "UNKNOWN" })),
    },
  ]);

  const violations = [
    ...input.text.errors,
    ...input.capacityErrors,
    ...snapshots.flatMap((s) => s.violations.map((v) => `${s.label}: ${v}`)),
    ...phase2Snapshot.violations.map((v) => `${phase2Snapshot.label}: ${v}`),
  ];

  return {
    generatedAt: input.generatedAt,
    assetGroup: input.assetGroup,
    mode: input.mode,
    limits: PMAX_MANAGED_FIELD_LIMITS,
    imagesCombinedMax: PMAX_IMAGE_COMBINED_MAX,
    text: input.text,
    images: input.images,
    phase1: { steps, snapshots, capacityErrors: input.capacityErrors },
    phase2: { basis: isPhase2Mode ? "live" : "projected-after-phase1", plan: phase2Plan, snapshot: phase2Snapshot },
    current: {
      counts: currentCounts,
      stale: classification.stale.length,
      keep: classification.keep.length,
      needsReview: classification.needsReview.map((i) => ({ fieldType: i.fieldType, assetId: i.assetId, label: i.text ?? i.imageName })),
      protected: classification.protectedItems.length,
    },
    violations,
  };
}
