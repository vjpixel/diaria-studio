/**
 * scripts/lib/google-ads-conversion-action.ts (#8574)
 *
 * Núcleo puro/testável pra ler e mutar o campo `primary_for_goal` de uma
 * `conversion_action` via Google Ads REST API (`conversionActions:mutate`).
 * Mesma disciplina de `google-ads-enhanced-conversions.ts`: nenhuma função
 * aqui faz I/O — quem chama (`scripts/google-ads-set-conversion-primary.ts`)
 * injeta `fetch` e monta a auth a partir do ambiente.
 *
 * ## Contexto (#8574)
 *
 * Decisão do editor (20/09/2026, autorizada em 28/09/2026 via
 * `/diaria-desbloqueia` — ver `scripts/lib/issue-decisions.ts --issue 8574`):
 * rebaixar a ação de conversão `7758161410` ("Cadastro newsletter
 * (recuperação #7770)") de `primary_for_goal=true` para `false`, só depois
 * do fim da janela do teste 2608 (27/09/2026) — a ação sustenta ~1 conversão
 * em 30 dias, não carrega peso no lance inteligente, mas mexer nos
 * objetivos primários da conta DURANTE o teste contaminaria a comparação
 * entre braços.
 */

/** Forma mínima de uma linha `conversion_action` devolvida por
 *  `googleAds:search` — `primaryForGoal` pode vir ausente (nunca setado) em
 *  vez de `false` explícito; tratamos ausência como `false` na normalização
 *  (`parseConversionActionRow`), que é o default documentado da API. */
export interface ConversionActionApiRow {
  conversionAction?: {
    resourceName?: string;
    id?: string;
    name?: string;
    primaryForGoal?: boolean;
  };
}

export interface ConversionActionState {
  resourceName: string;
  id: string;
  name: string;
  primaryForGoal: boolean;
}

/**
 * Monta a query GAQL de leitura de uma `conversion_action` pelo id.
 * `id` é validado como sequência numérica — GAQL não aceita parâmetros
 * bind, então o valor vai interpolado direto na string; um id não-numérico
 * poderia quebrar a query ou (pior) injetar cláusulas extras.
 *
 * @pure
 */
export function buildConversionActionReadQuery(conversionActionId: string): string {
  if (!/^\d+$/.test(conversionActionId)) {
    throw new Error(`conversionActionId precisa ser numérico, recebido: "${conversionActionId}"`);
  }
  return (
    "SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, " +
    "conversion_action.primary_for_goal FROM conversion_action " +
    `WHERE conversion_action.id = ${conversionActionId}`
  );
}

/**
 * Normaliza a 1ª linha de `googleAds:search` pro shape canônico. `null`
 * quando a busca não achou a ação (id errado, ou id de outra conta).
 *
 * @pure
 */
export function parseConversionActionRow(rows: ConversionActionApiRow[]): ConversionActionState | null {
  const row = rows[0]?.conversionAction;
  if (!row?.resourceName || !row.id) return null;
  return {
    resourceName: row.resourceName,
    id: row.id,
    name: row.name ?? "",
    // Ausência (campo nunca setado) e `false` explícito são o MESMO estado
    // pro nosso propósito — a API não distingue os dois na leitura.
    primaryForGoal: row.primaryForGoal ?? false,
  };
}

export interface PrimaryForGoalDecision {
  /** `false` quando o estado atual já bate com o alvo — nada a mutar. */
  needsChange: boolean;
  current: boolean;
  target: boolean;
  message: string;
}

/**
 * Decide se `primary_for_goal` precisa mudar — separado da leitura/mutação
 * pra ser testável sem mock de rede. Idempotente: rodar 2x com o mesmo
 * `target` na 2ª vez sempre devolve `needsChange: false`.
 *
 * @pure
 */
export function decidePrimaryForGoalChange(current: boolean, target: boolean): PrimaryForGoalDecision {
  if (current === target) {
    return {
      needsChange: false,
      current,
      target,
      message: `primary_for_goal já está ${target} — nada a fazer.`,
    };
  }
  return {
    needsChange: true,
    current,
    target,
    message: `primary_for_goal vai mudar de ${current} para ${target}.`,
  };
}

/** Payload de `conversionActions:mutate` — `updateMask` restrito ao único
 *  campo que este script muta, pra nunca arriscar sobrescrever outro campo
 *  da ação em silêncio (#573 — mesma disciplina de mutação estreita do
 *  resto do projeto). @pure */
export function buildSetPrimaryForGoalPayload(
  resourceName: string,
  primaryForGoal: boolean,
): { operations: Array<{ update: { resourceName: string; primaryForGoal: boolean }; updateMask: string }> } {
  return {
    operations: [
      {
        update: { resourceName, primaryForGoal },
        updateMask: "primary_for_goal",
      },
    ],
  };
}
