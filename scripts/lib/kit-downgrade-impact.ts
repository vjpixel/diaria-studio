/**
 * scripts/lib/kit-downgrade-impact.ts (#7365)
 *
 * Miolo puro (sem I/O) do checklist de 5 passos da issue #7365 — verifica se
 * o downgrade do plano Kit `creator` → `free` (agendado, `cancels_at:
 * 2026-09-07T17:30:58Z`, confirmado ao vivo em 03/09/2026) removeu algum dos
 * 5 recursos que a diária depende: sending address com DMARC, sequence de
 * boas-vindas, tag `rampa-kit`, custom fields `KIT_UTM_*`/`referring_site`, e
 * acesso à API de broadcasts.
 *
 * ## Por que a comparação é pura e a busca do estado atual não
 *
 * `compareKitDowngradeImpact` recebe DOIS objetos já montados (baseline +
 * estado atual) e devolve um veredito determinístico — testável com
 * fixtures, sem rede, sem `KIT_API_KEY`. `fetchCurrentKitDowngradeState`
 * (em `scripts/verify-kit-downgrade-impact.ts`, não aqui) é quem faz as 4
 * chamadas REST reais contra a API v4 do Kit para montar o "estado atual".
 * Separação = mesmo padrão de `kit-subscriber-limit-alarm.ts` (#7362):
 * módulo `lib/` só decide, o script na raiz só busca e imprime.
 *
 * ## Baseline capturada em 03/09/2026 (ANTES da virada de plano)
 *
 * Os valores abaixo são os citados no corpo da issue #7365 — confirmados ao
 * vivo via `get_current_account`/`list_sequences`/`list_tags`/
 * `list_custom_fields` no mesmo dia (ver `KIT_DOWNGRADE_BASELINE_20260903`).
 * `subscriber_count` da sequence é INFORMATIVO só — aparece no detail do
 * check "ok" mas nunca faz parte do veredito (`compareKitDowngradeImpact`
 * só olha `active`/`email_count`; não há guard de "virou 0"). Deliberadamente
 * omitido da baseline (nem comparado) — ver comentário na constante abaixo.
 * A CONTAGEM de assinantes por tag não é lida por este módulo (só existência
 * da tag em si, `KitDowngradeCurrentTag` não tem esse campo) — fora do
 * escopo dos 5 passos da issue.
 *
 * ## Por que "custom fields ausentes" é enumerado, não só contado
 *
 * `list_custom_fields` não devolve nenhum agrupamento por origem — os 4
 * campos que este checklist cobre (`utm_source`, `utm_medium`,
 * `utm_campaign`, `referring_site`, ver `workers/poll/wrangler.toml:115-118`)
 * são só uma fatia dos custom fields da conta (a conta tem outros:
 * `utm_channel`, `utm_term`, `utm_content`, `origem_cadastro`,
 * `apoio_nivel`, `atribuicao_fonte` — fora do escopo desta issue, que cita
 * especificamente as linhas 116-119 do wrangler.toml do worker `poll`).
 * Comparar por CHAVE (`key`), não por `id` (o id não está documentado na
 * issue e pode mudar entre ambientes).
 */

export interface KitDowngradeSendingAddressBaseline {
  email_address: string;
  is_default: boolean;
  is_verified: boolean;
  is_dmarc_configured: boolean;
}

export interface KitDowngradeSequenceBaseline {
  id: number;
  name: string;
  email_count: number;
  active: boolean;
}

export interface KitDowngradeBaseline {
  capturedAt: string;
  planType: string;
  sendingAddress: KitDowngradeSendingAddressBaseline;
  sequence: KitDowngradeSequenceBaseline;
  requiredTagName: string;
  requiredCustomFieldKeys: string[];
}

/** Baseline citada no corpo da issue #7365, capturada 03/09/2026 — ver
 *  docstring do módulo. `subscriber_count`/contagem da tag são deliberadamente
 *  OMITIDOS do baseline: são informativos, não fazem parte do veredito
 *  pass/fail (ver `compareKitDowngradeImpact`). */
export const KIT_DOWNGRADE_BASELINE_20260903: KitDowngradeBaseline = {
  capturedAt: "2026-09-03",
  planType: "creator",
  sendingAddress: {
    email_address: "oi@news.diar.ia.br",
    is_default: true,
    is_verified: true,
    is_dmarc_configured: true,
  },
  sequence: {
    id: 2876508,
    name: "Boas-vindas",
    email_count: 3,
    active: true,
  },
  requiredTagName: "rampa-kit",
  requiredCustomFieldKeys: ["utm_source", "utm_medium", "utm_campaign", "referring_site"],
};

// ---------------------------------------------------------------------------
// Estado atual — shape mínimo que `fetchCurrentKitDowngradeState` precisa
// preencher (campos confirmados ao vivo contra a API v4 real em 03/09/2026,
// ver comentário de execução do #7365).
// ---------------------------------------------------------------------------

export interface KitDowngradeCurrentSendingAddress {
  email_address: string;
  is_default: boolean;
  is_verified: boolean;
  is_dmarc_configured: boolean;
}

export interface KitDowngradeCurrentSequence {
  id: number;
  name: string;
  email_count: number;
  active: boolean;
  subscriber_count: number;
}

export interface KitDowngradeCurrentTag {
  id: number;
  name: string;
}

export interface KitDowngradeCurrentCustomField {
  id: number;
  key: string;
}

export interface KitDowngradeCurrentState {
  fetchedAt: string;
  planType: string;
  subscriberLimit: number;
  sendingAddresses: KitDowngradeCurrentSendingAddress[];
  sequences: KitDowngradeCurrentSequence[];
  tags: KitDowngradeCurrentTag[];
  customFields: KitDowngradeCurrentCustomField[];
  /** `false` = a chamada de broadcasts falhou (erro capturado pelo
   *  caller, ver `broadcastsError`); `true` = a API respondeu (mesmo que
   *  com uma lista vazia). */
  broadcastsAccessible: boolean;
  /** Mensagem de erro da chamada de broadcasts, se `broadcastsAccessible`
   *  for `false` — carregada pro relatório, nunca descartada em silêncio. */
  broadcastsError?: string;
}

export type KitDowngradeCheckStatus = "ok" | "missing" | "changed" | "error";

export interface KitDowngradeCheckResult {
  key: string;
  label: string;
  status: KitDowngradeCheckStatus;
  detail: string;
}

export interface KitDowngradeComparison {
  overallOk: boolean;
  checks: KitDowngradeCheckResult[];
}

/**
 * Compara o estado atual contra a baseline dos 5 passos da issue #7365.
 * PURA — nenhuma chamada de rede, nenhum `Date.now()` (o timestamp de
 * comparação vem do caller via `current.fetchedAt`, já resolvido).
 */
export function compareKitDowngradeImpact(
  baseline: KitDowngradeBaseline,
  current: KitDowngradeCurrentState,
): KitDowngradeComparison {
  const checks: KitDowngradeCheckResult[] = [];

  // 1. Sending address com DMARC configurado.
  const addr = current.sendingAddresses.find((a) => a.email_address === baseline.sendingAddress.email_address);
  if (!addr) {
    checks.push({
      key: "sending_address",
      label: `Sending address ${baseline.sendingAddress.email_address}`,
      status: "missing",
      detail: `Endereço "${baseline.sendingAddress.email_address}" não aparece mais em sending_addresses — remetente provavelmente caiu para o e-mail pessoal do editor.`,
    });
  } else {
    const drifts: string[] = [];
    if (baseline.sendingAddress.is_default && !addr.is_default) drifts.push("deixou de ser is_default");
    if (baseline.sendingAddress.is_verified && !addr.is_verified) drifts.push("is_verified virou false");
    if (baseline.sendingAddress.is_dmarc_configured && !addr.is_dmarc_configured) {
      drifts.push("is_dmarc_configured virou false — entregabilidade em risco, rampa Gmail (#6504) volta à estaca zero");
    }
    checks.push({
      key: "sending_address",
      label: `Sending address ${baseline.sendingAddress.email_address}`,
      status: drifts.length === 0 ? "ok" : "changed",
      detail:
        drifts.length === 0
          ? `is_default=${addr.is_default}, is_verified=${addr.is_verified}, is_dmarc_configured=${addr.is_dmarc_configured} — igual à baseline de ${baseline.capturedAt}.`
          : drifts.join("; "),
    });
  }

  // 2. Sequence de boas-vindas.
  const seq =
    current.sequences.find((s) => s.id === baseline.sequence.id) ??
    current.sequences.find((s) => s.name === baseline.sequence.name);
  if (!seq) {
    checks.push({
      key: "sequence_boas_vindas",
      label: `Sequence "${baseline.sequence.name}"`,
      status: "missing",
      detail: `Nenhuma sequence com id ${baseline.sequence.id} ou nome "${baseline.sequence.name}" encontrada — o cadastro novo não recebe mais o único contato pós-inscrição.`,
    });
  } else {
    const drifts: string[] = [];
    if (baseline.sequence.active && !seq.active) drifts.push("active virou false");
    if (seq.email_count < baseline.sequence.email_count) {
      drifts.push(`email_count caiu de ${baseline.sequence.email_count} para ${seq.email_count}`);
    }
    checks.push({
      key: "sequence_boas_vindas",
      label: `Sequence "${baseline.sequence.name}"`,
      status: drifts.length === 0 ? "ok" : "changed",
      detail:
        drifts.length === 0
          ? `active=${seq.active}, email_count=${seq.email_count}, subscriber_count=${seq.subscriber_count} (informativo).`
          : drifts.join("; "),
    });
  }

  // 3. Tag rampa-kit.
  const tag = current.tags.find((t) => t.name === baseline.requiredTagName);
  checks.push({
    key: "tag_rampa_kit",
    label: `Tag "${baseline.requiredTagName}"`,
    status: tag ? "ok" : "missing",
    detail: tag
      ? `Presente (id ${tag.id}) — subscriber_filter do disparo diário (#7357) segue funcionando.`
      : `Tag "${baseline.requiredTagName}" não aparece mais em list_tags — o subscriber_filter do disparo diário (#7357) provavelmente quebrou.`,
  });

  // 4. Custom fields KIT_UTM_*/referring_site.
  const currentKeys = new Set(current.customFields.map((f) => f.key));
  const missingKeys = baseline.requiredCustomFieldKeys.filter((k) => !currentKeys.has(k));
  checks.push({
    key: "custom_fields_utm",
    label: `Custom fields ${baseline.requiredCustomFieldKeys.join(", ")}`,
    status: missingKeys.length === 0 ? "ok" : "missing",
    detail:
      missingKeys.length === 0
        ? "Todas as chaves KIT_UTM_*/referring_site (workers/poll/wrangler.toml:115-118) seguem presentes."
        : `Ausentes: ${missingKeys.join(", ")} — a atribuição de canal pago (#7359) some para essas chaves.`,
  });

  // 5. Broadcasts + acesso à API.
  checks.push({
    key: "broadcasts_api_access",
    label: "Acesso à API de broadcasts",
    status: current.broadcastsAccessible ? "ok" : "error",
    detail: current.broadcastsAccessible
      ? "listBroadcasts respondeu normalmente — o dispatch da diária (Stage 5) segue com acesso à API."
      : `listBroadcasts falhou${current.broadcastsError ? `: ${current.broadcastsError}` : ""} — o dispatch da diária (Stage 5) pode estar quebrado.`,
  });

  const overallOk = checks.every((c) => c.status === "ok");
  return { overallOk, checks };
}

/** Formata o resultado como texto simples pra terminal/e-mail — sem
 *  markdown pesado, uma linha por check + resumo no topo. */
export function formatKitDowngradeReport(comparison: KitDowngradeComparison, current: KitDowngradeCurrentState): string {
  const lines: string[] = [];
  lines.push(`Verificação do downgrade Kit (#7365) — ${current.fetchedAt}`);
  lines.push(`plan_type atual: ${current.planType} (subscriber_limit: ${current.subscriberLimit})`);
  lines.push(comparison.overallOk ? "RESULTADO: tudo OK, nada quebrou." : "RESULTADO: pelo menos 1 item quebrou.");
  lines.push("");
  for (const check of comparison.checks) {
    const marker = check.status === "ok" ? "[OK]" : check.status === "error" ? "[ERRO]" : `[${check.status.toUpperCase()}]`;
    lines.push(`${marker} ${check.label} — ${check.detail}`);
  }
  return lines.join("\n");
}
