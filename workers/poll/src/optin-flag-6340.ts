// Issue #6340 — Double opt-in no cadastro novo do Kit (#6340)
// Start of implementation: feature flag definition for double-opt-in rollout.
// Per decision 26/08/2026: cadastro novo passa a criar subscriber com state: "inactive"
// atrás de flag por worker (poll primeiro, menor volume), com Brevo entregando enquanto
// não confirmado. Base existente (589 active) fora de escopo.
// Dependências registradas: #6339 (promoção precisa apontar pro backend de publicação),
// #6318 (form e configuração de opt-in compartilhada).
export const DOUBLE_OPT_IN_FLAG = {
  enabledForWorkers: ["poll"], // rollout worker-a-worker (#6048 padrão)
  createState: "inactive" as const,
  confirmationSource: "kit-form", // mecanismo: form do Kit com confirmation ON
  brevoPendingSegment: true,
  scopeExcludesLegacyBase: true, // 589 active confirmados por herança Beehiiv — não retocados
};
