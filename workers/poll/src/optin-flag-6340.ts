// Issue #6340 — Double opt-in no cadastro novo do Kit (#6340)
// Feature flag de rollout double-opt-in, consumida por `subscribe.ts`
// (`resolveKitCreateState`/`vincularKitDoiForm`) desde a rodada que fechou
// #6339/#6318 — este arquivo deixou de ser um stub não-importado.
// Per decision 26/08/2026: cadastro novo passa a criar subscriber com state: "inactive"
// atrás de flag por worker (poll primeiro, menor volume), com Brevo entregando enquanto
// não confirmado. Base existente (589 active) fora de escopo.
// #6339/#6318 já resolvidos (ver PRs #6339, #6324). Pendência real: o editor
// precisa configurar o form do Kit (`KIT_DOI_FORM_ID`) com "Send confirmation
// email" ligado no dashboard — ação operacional fora do alcance deste repo.
export const DOUBLE_OPT_IN_FLAG = {
  enabledForWorkers: ["poll"], // rollout worker-a-worker (#6048 padrão)
  createState: "inactive" as const,
  confirmationSource: "kit-form", // mecanismo: form do Kit com confirmation ON
  brevoPendingSegment: true,
  scopeExcludesLegacyBase: true, // 589 active confirmados por herança Beehiiv — não retocados
};
