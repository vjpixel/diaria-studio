/**
 * scripts/lib/google-ads-pmax-sync-plan.ts (#8550)
 *
 * Plano auditável da troca de criativos do PMax "Max" — o que
 * `scripts/google-ads-swap-asset-group-creatives.ts` grava em JSON
 * (`--plan-out`) em toda execução que lê o estado do grupo, e usa como TRAVA:
 * qualquer item em `report.violations` faz `--send` recusar antes de mutar.
 *
 *   1. **Contagem por field_type passo a passo** (`simulateSteps`): estado
 *      lido → cada `assetGroupAssets:mutate` da Fase 1 (link dos novos, com a
 *      remoção atômica mínima do #9017/#9057/#9080) → Fase 2. Violação quando
 *      um passo deixa um tipo acima do máximo, o REMOVE abaixo do mínimo, ou
 *      remove um recurso de tipo não resolvido.
 *   2. **Piso na Fase 2** (`planPhase2Removal`): a remoção dos antigos nunca
 *      deixa um tipo abaixo do mínimo contando só `keep` (inclui os textos
 *      novos do swap) e imagens novas que o Google já APROVOU
 *      (`policy_summary.approval_status` APPROVED/APPROVED_LIMITED).
 *      `needsReview` (logos usados como marketing image, texto desconhecido)
 *      NÃO conta: é pendência humana, não criativo do swap. Também preserva a
 *      regra de comprimento do PMax: ≥1 DESCRIPTION ≤60 chars (exigida) e
 *      ≥1 HEADLINE ≤15 chars (premissa conservadora — fontes divergem entre
 *      "exigido" e "recomendado").
 *   3. **Releitura pós-mutação** (`verifyLinkedAfterApply`,
 *      `verifyRemovedAfterApply`, `fieldsBelowMin`): 2xx com a contagem certa
 *      de `results` não prova o estado do grupo (escrita silenciosa já
 *      aconteceu em outras plataformas de anúncio) — a CLI relê o grupo
 *      depois de cada fase e compara com o que pediu.
 *
 * Limitação conhecida (herdada do #9017, comportamento mantido): quando o
 * grupo já está no máximo de um tipo (LONG_HEADLINE/DESCRIPTION 5/5), a Fase
 * 1 troca o tipo INTEIRO no mesmo mutate — os antigos aprovados saem e ficam
 * só os novos, ainda em revisão do Google. Até a aprovação, esse tipo serve
 * apenas recursos pendentes. Registrado em `report.notes`.
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

/** Regra de comprimento por tipo: ≥1 recurso com até `maxChars`. DESCRIPTION
 *  ≤60 é exigência documentada do PMax; HEADLINE ≤15 é premissa conservadora
 *  (há fontes que tratam como exigência, outras como recomendação). */
export const PMAX_SHORT_TEXT_RULES: ReadonlyArray<{ fieldType: TextFieldType; maxChars: number }> = [
  { fieldType: "DESCRIPTION", maxChars: PMAX_TEXT_LIMITS.description.shortMaxChars },
  { fieldType: "HEADLINE", maxChars: 15 },
];

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
 * = o passo deixa um tipo acima do máximo; o tipo abaixo do mínimo PORQUE o
 * passo removeu dele (um tipo já abaixo antes e não tocado não é culpa do
 * passo); um remove de tipo não resolvido (fora dos 6 gerenciados — a
 * contagem não teria como refletir); ou, num passo que linka imagem, a soma
 * das imagens acima do teto combinado (`PMAX_IMAGE_COMBINED_MAX`). Um passo
 * só de remoção não é cobrado pelo teto: remover nunca piora o total.
 * @pure
 */
export function simulateSteps(initial: FieldCounts, steps: readonly SyncStep[]): CountSnapshot[] {
  let counts: FieldCounts = { ...initial };
  const snapshots: CountSnapshot[] = [];
  for (const step of steps) {
    const next: FieldCounts = { ...counts };
    const removedFrom = new Set<ManagedFieldType>();
    const violations: string[] = [];
    for (const [ft, n] of Object.entries(step.add) as Array<[ManagedFieldType, number]>) next[ft] += n;
    for (const r of step.remove) {
      if (!isManaged(r.fieldType)) {
        violations.push(`remove de tipo não resolvido (${r.fieldType}): ${r.resourceName}`);
        continue;
      }
      next[r.fieldType]--;
      removedFrom.add(r.fieldType);
    }
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

/** Converte o plano de link da Fase 1 (um mutate por fieldType) em passos.
 *  Recurso removido que não está em `items` vira tipo "UNKNOWN" — e
 *  `simulateSteps` acusa isso como violação. */
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
  /** ENABLED não-stale, não-needsReview, com aprovação confirmada. */
  confirmedPermanent: number;
  /** ENABLED não-stale, não-needsReview, ainda sem aprovação confirmada. */
  unconfirmedPermanent: number;
  /** ENABLED `needsReview` — nunca removidos, mas fora do piso. */
  needsReview: number;
  staleEnabled: number;
  remove: string[];
  /** Stale mantidos pelo piso (contagem e/ou regra de comprimento). */
  retain: string[];
  /** Regra de comprimento deste tipo (se houver) e como foi atendida. */
  shortRule?: { maxChars: number; status: "permanent" | "retained" | "unmet" };
}

export interface Phase2RemovalPlan {
  remove: string[];
  fields: Phase2FieldPlan[];
  /** Stale de tipo fora dos 6 gerenciados — nunca removido aqui (não há
   *  piso conhecido pra ele); reportado. */
  unmanagedStale: string[];
}

/**
 * Plano da Fase 2 com piso. Por tipo, conta como "garantido" só o ENABLED
 * não-stale e não-`needsReview` com aprovação confirmada; mantém do stale o
 * necessário pra (a) a contagem chegar ao mínimo e (b) a regra de comprimento
 * (`PMAX_SHORT_TEXT_RULES`) seguir atendida — mantendo o stale aprovado mais
 * curto que cabe. Se os novos ainda estão em revisão, o stale necessário
 * fica; rodar a Fase 2 de novo depois da aprovação remove o resto.
 * @pure
 */
export function planPhase2Removal(
  items: readonly AssetGroupAssetItem[],
  classification: Pick<AssetGroupClassification, "stale" | "needsReview">,
): Phase2RemovalPlan {
  const staleSet = new Set(classification.stale.map((i) => i.assetGroupAssetResourceName));
  const reviewSet = new Set(classification.needsReview.map((i) => i.assetGroupAssetResourceName));
  const fields: Phase2FieldPlan[] = [];
  const remove: string[] = [];
  for (const ft of MANAGED_FIELD_TYPES) {
    const enabled = items.filter((i) => i.status === "ENABLED" && i.fieldType === ft);
    const stale = enabled.filter((i) => staleSet.has(i.assetGroupAssetResourceName));
    const needsReview = enabled.filter((i) => reviewSet.has(i.assetGroupAssetResourceName)).length;
    const permanent = enabled.filter((i) => !staleSet.has(i.assetGroupAssetResourceName) && !reviewSet.has(i.assetGroupAssetResourceName));
    const confirmed = permanent.filter(isApprovalConfirmed);
    const { min } = PMAX_MANAGED_FIELD_LIMITS[ft];
    const retainCount = Math.min(stale.length, Math.max(0, min - confirmed.length));
    // Mantém primeiro os stale JÁ aprovados — são os que de fato servem.
    const ordered = [...stale].sort((a, b) => Number(isApprovalConfirmed(b)) - Number(isApprovalConfirmed(a)));
    const retained = ordered.slice(0, retainCount);
    let removable = ordered.slice(retainCount);

    let shortRule: Phase2FieldPlan["shortRule"];
    const rule = PMAX_SHORT_TEXT_RULES.find((r) => r.fieldType === ft);
    if (rule) {
      const isShort = (i: AssetGroupAssetItem) => i.text !== undefined && i.text.length <= rule.maxChars;
      if (confirmed.some(isShort)) {
        shortRule = { maxChars: rule.maxChars, status: "permanent" };
      } else if (retained.some((i) => isShort(i) && isApprovalConfirmed(i))) {
        shortRule = { maxChars: rule.maxChars, status: "retained" };
      } else {
        const candidate = removable
          .filter((i) => isShort(i) && isApprovalConfirmed(i))
          .sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0))[0];
        if (candidate) {
          retained.push(candidate);
          removable = removable.filter((i) => i !== candidate);
          shortRule = { maxChars: rule.maxChars, status: "retained" };
        } else {
          shortRule = { maxChars: rule.maxChars, status: "unmet" };
        }
      }
    }

    const removeFt = removable.map((i) => i.assetGroupAssetResourceName);
    remove.push(...removeFt);
    fields.push({
      fieldType: ft,
      min,
      confirmedPermanent: confirmed.length,
      unconfirmedPermanent: permanent.length - confirmed.length,
      needsReview,
      staleEnabled: stale.length,
      remove: removeFt,
      retain: retained.map((i) => i.assetGroupAssetResourceName),
      ...(shortRule ? { shortRule } : {}),
    });
  }
  const unmanagedStale = classification.stale
    .filter((i) => i.status === "ENABLED" && !isManaged(i.fieldType))
    .map((i) => i.assetGroupAssetResourceName);
  return { remove, fields, unmanagedStale };
}

/**
 * Estado PROJETADO depois da Fase 1: tira o que sai no mesmo mutate do link e
 * acrescenta os novos como ENABLED (com o texto, quando `newTexts` traz). Com
 * `assumeNewApproved` os novos entram como APPROVED — premissa otimista e
 * explícita do dry-run (`report.phase2.assumedNewApproved`); a Fase 2 de
 * verdade relê a aprovação ao vivo.
 * @pure
 */
export function projectItemsAfterPhase1(
  items: readonly AssetGroupAssetItem[],
  steps: readonly SyncStep[],
  assumeNewApproved: boolean,
  newTexts: Partial<Record<ManagedFieldType, readonly string[]>> = {},
): AssetGroupAssetItem[] {
  const removed = new Set(steps.flatMap((s) => s.remove.map((r) => r.resourceName)));
  const out = items.filter((i) => !removed.has(i.assetGroupAssetResourceName));
  for (const step of steps) {
    for (const [ft, n] of Object.entries(step.add) as Array<[ManagedFieldType, number]>) {
      for (let k = 1; k <= n; k++) {
        const name = `(novo) ${ft} #${k}`;
        const text = newTexts[ft]?.[k - 1];
        out.push({
          assetGroupAssetResourceName: name,
          assetResourceName: name,
          assetId: name,
          fieldType: ft,
          status: "ENABLED",
          assetType: (IMAGE_TYPES as readonly string[]).includes(ft) ? "IMAGE" : "TEXT",
          ...(text !== undefined ? { text } : {}),
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

export const KNOWN_LIMITATION_FULL_TYPE_SWAP =
  "Fase 1 (herdado do #9017): tipo já no máximo (LONG_HEADLINE/DESCRIPTION 5/5) é trocado INTEIRO no mesmo mutate — " +
  "os antigos aprovados saem e o tipo fica só com os novos, ainda em revisão do Google, até a aprovação.";

export interface SyncPlanReport {
  generatedAt: string;
  assetGroup: string;
  /** `dry-run`/`phase1`: Fase 2 PROJETADA sobre o pós-Fase 1.
   *  `phase2-dry-run`/`phase2`: Fase 2 sobre o estado lido agora. */
  mode: "dry-run" | "phase1" | "phase2-dry-run" | "phase2";
  limits: typeof PMAX_MANAGED_FIELD_LIMITS;
  shortTextRules: typeof PMAX_SHORT_TEXT_RULES;
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
  phase2: {
    /** true = a projeção trata os novos da Fase 1 como já APROVADOS
     *  (otimista; a Fase 2 real relê a aprovação). */
    assumedNewApproved: boolean;
    plan: Phase2RemovalPlan;
    snapshot: CountSnapshot;
  };
  current: { counts: FieldCounts; stale: number; keep: number; needsReview: Array<{ fieldType: string; assetId: string; label?: string }>; protected: number };
  notes: string[];
  /** Não-vazio = `--send` recusa antes de qualquer mutação. */
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
    phase2Items = projectItemsAfterPhase1(items, steps, true, {
      HEADLINE: input.text.headlines,
      LONG_HEADLINE: input.text.longHeadlines,
      DESCRIPTION: input.text.descriptions,
    });
    const removedInPhase1 = new Set(steps.flatMap((s) => s.remove.map((r) => r.resourceName)));
    phase2Stale = classification.stale.filter((i) => !removedInPhase1.has(i.assetGroupAssetResourceName));
  }
  const phase2Plan = planPhase2Removal(phase2Items, { stale: phase2Stale, needsReview: classification.needsReview });
  const ftByAga = new Map(phase2Items.map((i) => [i.assetGroupAssetResourceName, i.fieldType]));
  const afterPhase1Counts = snapshots.length > 0 ? snapshots[snapshots.length - 1].counts : currentCounts;
  const [phase2Snapshot] = simulateSteps(afterPhase1Counts, [
    {
      label: isPhase2Mode
        ? "Fase 2 — remoção dos antigos (com piso)"
        : "Fase 2 PROJETADA — remoção dos antigos (com piso; assume os novos já APROVADOS)",
      add: {},
      remove: phase2Plan.remove.map((rn) => ({ resourceName: rn, fieldType: ftByAga.get(rn) ?? "UNKNOWN" })),
    },
  ]);

  const fullTypeSwap = steps.some((s) => {
    const ft = Object.keys(s.add)[0] as ManagedFieldType | undefined;
    return ft !== undefined && s.remove.length > 0 && currentCounts[ft] - s.remove.length === 0;
  });
  const notes = fullTypeSwap ? [KNOWN_LIMITATION_FULL_TYPE_SWAP] : [];
  for (const f of phase2Plan.fields) {
    if (f.shortRule?.status === "unmet") {
      notes.push(`${f.fieldType}: nenhum recurso aprovado com ≤${f.shortRule.maxChars} chars no grupo — regra de comprimento não atendida (nada a preservar).`);
    }
  }

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
    shortTextRules: PMAX_SHORT_TEXT_RULES,
    imagesCombinedMax: PMAX_IMAGE_COMBINED_MAX,
    text: input.text,
    images: input.images,
    phase1: { steps, snapshots, capacityErrors: input.capacityErrors },
    phase2: { assumedNewApproved: !isPhase2Mode, plan: phase2Plan, snapshot: phase2Snapshot },
    current: {
      counts: currentCounts,
      stale: classification.stale.length,
      keep: classification.keep.length,
      needsReview: classification.needsReview.map((i) => ({ fieldType: i.fieldType, assetId: i.assetId, label: i.text ?? i.imageName })),
      protected: classification.protectedItems.length,
    },
    notes,
    violations,
  };
}
