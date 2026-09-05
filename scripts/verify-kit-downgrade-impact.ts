#!/usr/bin/env node
/**
 * scripts/verify-kit-downgrade-impact.ts (#7365)
 *
 * Automatiza os 5 passos de "O que fazer em 08/09" do corpo da issue #7365:
 * confirmar que o downgrade do plano Kit `creator` → `free` (agendado,
 * `cancels_at: 2026-09-07T17:30:58Z`, confirmado ao vivo em 03/09/2026) não
 * removeu nenhum dos 5 recursos que a diária depende — sending address com
 * DMARC, sequence de boas-vindas, tag `rampa-kit`, custom fields
 * `KIT_UTM_*`/`referring_site`, e acesso à API de broadcasts.
 *
 * ## REST, não MCP — por design, não por limitação de ambiente
 *
 * A issue nomeia os 5 passos pelas ferramentas MCP do Kit
 * (`get_current_account`, `list_sequences`, `list_tags`,
 * `list_custom_fields`, `list_broadcasts`). Este script chama os MESMOS 5
 * endpoints, mas via REST direto (`kitFetch`/`KIT_API_KEY`) — o padrão que
 * TODO script Kit deste repo já segue (`kit-client.ts`, `kit-broadcasts.ts`,
 * `kit-subscriber-limit-alarm.ts`): um script `npx tsx` roda como processo
 * Node headless, fora do runtime do Claude Code, e não tem como invocar uma
 * tool MCP — só a sessão interativa tem esse acesso. REST evita depender de
 * uma sessão MCP ativa: este script roda sozinho, inclusive de uma task
 * agendada, sem precisar de um agente colando JSON de chamadas MCP num
 * arquivo antes.
 *
 * Os 5 shapes de resposta abaixo (`GET /account`, `/sequences`, `/tags`,
 * `/custom_fields`, `/broadcasts`) foram confirmados AO VIVO contra a conta
 * de produção em 03/09/2026 (mesmo dia da baseline da issue) — ver
 * `KIT_DOWNGRADE_BASELINE_20260903` em `scripts/lib/kit-downgrade-impact.ts`
 * para a baseline capturada, e o corpo desta issue/comentário de execução
 * para o payload bruto que confirmou os 5 shapes.
 *
 * ## Uso
 *
 *   npx tsx scripts/verify-kit-downgrade-impact.ts             # busca + compara + imprime
 *   npx tsx scripts/verify-kit-downgrade-impact.ts --json       # imprime o JSON completo em vez do relatório em texto
 *
 * Exit code 1 se qualquer check não for "ok" (útil pra task agendada
 * detectar regressão sem precisar parsear o texto) — 0 se tudo OK ou se
 * a chamada de rede falhar antes da comparação (nesse caso a falha já
 * aparece no stderr; não é um "tudo OK" disfarçado).
 *
 * ## Quando rodar de verdade
 *
 * O plano só vira em 07/09/2026 17:30 UTC (`cancels_at` na baseline) — a
 * issue marca `<!-- aguardando-ate: 2026-09-08 -->`. Rodar este script
 * ANTES dessa data só reconfirma o estado pago (baseline ainda intacta);
 * o veredito que importa é o de 08/09 em diante.
 *
 * Requer `KIT_API_KEY` no ambiente (mesma var de todo script Kit deste
 * repo, `scripts/lib/kit-config.ts`).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { kitFetch } from "./lib/kit-client.ts";
import { listTags } from "./lib/kit-broadcasts.ts";
import {
  KIT_DOWNGRADE_BASELINE_20260903,
  compareKitDowngradeImpact,
  formatKitDowngradeReport,
  type KitDowngradeCurrentState,
  type KitDowngradeCurrentSequence,
  type KitDowngradeCurrentSendingAddress,
  type KitDowngradeCurrentCustomField,
} from "./lib/kit-downgrade-impact.ts";

loadProjectEnv();

interface RawAccountResponse {
  account?: {
    plan_type?: string;
    plan?: { plan_type?: string; subscriber_limit?: number };
    subscriber_limit?: number;
    sending_addresses?: KitDowngradeCurrentSendingAddress[];
  };
}

interface RawSequencesResponse {
  sequences?: Array<{
    id: number;
    name: string;
    email_count: number;
    active: boolean;
    subscriber_count: number;
  }>;
}

interface RawCustomFieldsResponse {
  custom_fields?: Array<{ id: number; key: string }>;
}

interface RawBroadcastsResponse {
  broadcasts?: unknown[];
}

/**
 * Busca o estado atual dos 5 recursos via REST puro contra a API v4 do Kit.
 * Impura de propósito — a decisão (o que conta como "quebrou") fica toda em
 * `compareKitDowngradeImpact`, testável sem rede.
 *
 * Cada uma das 4 primeiras chamadas propaga o erro (fail-fast — se
 * `get_current_account` falhar, por exemplo, não faz sentido fingir que o
 * sending address "sumiu": o script todo aborta e o operador vê o erro de
 * rede real). Só a 5ª chamada (`listBroadcasts`, passo 4 do checklist —
 * "acesso à API") é capturada: falhar em LER broadcasts É o próprio sinal
 * que este check existe para detectar, não uma falha de infraestrutura do
 * script.
 */
export async function fetchCurrentKitDowngradeState(fetchedAt: string): Promise<KitDowngradeCurrentState> {
  const accountData = await kitFetch<RawAccountResponse | undefined>("/account");
  const account = accountData?.account;
  if (!account) {
    throw new Error("[verify-kit-downgrade-impact] GET /account respondeu sem o envelope \"account\" esperado");
  }
  const planType = account.plan_type ?? account.plan?.plan_type ?? "";
  const subscriberLimit = account.subscriber_limit ?? account.plan?.subscriber_limit ?? 0;
  const sendingAddresses = account.sending_addresses ?? [];

  const sequencesData = await kitFetch<RawSequencesResponse | undefined>("/sequences?per_page=100");
  const sequences: KitDowngradeCurrentSequence[] = (sequencesData?.sequences ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    email_count: s.email_count,
    active: s.active,
    subscriber_count: s.subscriber_count,
  }));

  const { tags } = await listTags({ perPage: 100 });

  const customFieldsData = await kitFetch<RawCustomFieldsResponse | undefined>("/custom_fields?per_page=100");
  const customFields: KitDowngradeCurrentCustomField[] = (customFieldsData?.custom_fields ?? []).map((f) => ({
    id: f.id,
    key: f.key,
  }));

  let broadcastsAccessible = true;
  let broadcastsError: string | undefined;
  try {
    await kitFetch<RawBroadcastsResponse | undefined>("/broadcasts?per_page=1");
  } catch (e) {
    broadcastsAccessible = false;
    broadcastsError = (e as Error).message;
  }

  return {
    fetchedAt,
    planType,
    subscriberLimit,
    sendingAddresses,
    sequences,
    tags: tags.map((t) => ({ id: t.id, name: t.name })),
    customFields,
    broadcastsAccessible,
    broadcastsError,
  };
}

async function main(): Promise<void> {
  const asJson = hasFlag(process.argv.slice(2), "json");
  const fetchedAt = new Date().toISOString();
  const current = await fetchCurrentKitDowngradeState(fetchedAt);
  const comparison = compareKitDowngradeImpact(KIT_DOWNGRADE_BASELINE_20260903, current);

  if (asJson) {
    console.log(JSON.stringify({ baseline: KIT_DOWNGRADE_BASELINE_20260903, current, comparison }, null, 2));
  } else {
    console.log(formatKitDowngradeReport(comparison, current));
  }

  if (!comparison.overallOk) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[verify-kit-downgrade-impact] falhou: ${(e as Error).message}`);
    process.exitCode = 2;
  });
}
