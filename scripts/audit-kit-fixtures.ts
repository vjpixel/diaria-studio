#!/usr/bin/env node
/**
// retrigger-ci-note
 * scripts/audit-kit-fixtures.ts (#6336)
 *
 * Varre a base Kit inteira por padrão de e-mail de FIXTURE de teste
 * (`kit-fixture-patterns.ts`) e falha se algum estiver `active` — o cenário
 * concreto que motivou a issue: `ana@example.com`, fixture usado em ~10
 * arquivos de `test/*.test.ts` (sempre com `fetchMock`, nunca toca rede),
 * ficou assinante REAL `active` na base de produção depois de uma
 * verificação ao vivo de funil (poll/cursos/reativar) — teria recebido a
 * próxima edição pelo Kit, e `example.com` é domínio reservado (RFC 2606):
 * hard bounce garantido.
 *
 * Barato e determinístico: 1 leitura paginada de `/v4/subscribers` (`status:
 * "all"`, pra reportar também os já cancelados/inativos — o achado de 13
 * resíduos com 2 ainda `active` na auditoria de 26/08/2026 incluiu os dois
 * estados) + comparação client-side contra os padrões conhecidos. Nenhuma
 * escrita — LEITURA apenas, seguro de rodar em qualquer ambiente com
 * `KIT_API_KEY` configurada, inclusive contra a base real (é auditoria, não
 * publicação — ver `context/overnight-dispatch-rules.md` item 1, que proíbe
 * só EXECUTAR publisher/mutação, não leitura).
 *
 * ## Convenção de probe ao vivo (item 3 da issue #6336 — documentação, não
 * código executável; nada aqui verifica ou impõe isto, é processo)
 *
 * Toda verificação ao vivo de funil (poll/cursos/reativar) contra a base Kit
 * REAL usa `vjpixel+probe-{issue}-{data}@gmail.com` — nunca o fixture dos
 * testes automatizados (`ana@example.com`, `teste-*@...`). O domínio real
 * garante que o teste prova o que precisa provar (entrega de verdade), e o
 * `+probe-{issue}-{data}` torna a intenção óbvia no dashboard do Kit pra
 * quem for limpar depois.
 *
 * ## Cancelar o probe faz parte do ROLLOUT, não é opcional (item 4 da issue)
 *
 * O probe ao vivo criado pra testar um funil deve ser CANCELADO
 * (`state: "cancelled"`, via `createOrUpdateSubscriber`/dashboard Kit) antes
 * de considerar a verificação concluída — não é um passo de limpeza
 * opcional "se sobrar tempo". A issue #6336 nasceu exatamente do padrão
 * oposto: o estado residual se RECONSTRÓI a cada rollout que testa um funil
 * ao vivo e esquece de cancelar o probe ao final.
 *
 * ## Uso
 *
 *   npx tsx scripts/audit-kit-fixtures.ts
 *
 * ## Exit codes
 *
 *   0 — limpo: nenhum fixture ativo (pode haver fixtures cancelados/
 *       inativos residuais — reportados, mas não bloqueiam).
 *   1 — pelo menos 1 assinante de fixture está `active` na base real.
 *   2 — infra indisponível: `KIT_API_KEY` ausente ou chamada à API falhou.
 *       Distinto do `1` de propósito (mesma disciplina do #6162 documentada
 *       em `kit-verify-click-fields.ts`) — "não consegui checar" e "chequei
 *       e achei problema" pedem ações diferentes (reconfigurar credencial
 *       vs. cancelar assinante).
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import { listAllKitSubscribers, type KitSubscriberSummary } from "./lib/kit-subscribers.ts";
import { auditKitFixtures, renderKitFixtureAuditReport } from "./lib/kit-fixture-audit.ts";

export interface AuditDeps {
  fetchSubscribers(config: KitConfig): Promise<KitSubscriberSummary[]>;
  log(line: string): void;
}

export function productionDeps(): AuditDeps {
  return {
    fetchSubscribers: (config) => listAllKitSubscribers(config, { status: "all" }),
    log: (line) => console.log(line),
  };
}

export type AuditRunResult =
  | { code: 0; report: string }
  | { code: 1; report: string }
  | { code: 2; reason: string };

export async function runAudit(deps: AuditDeps): Promise<AuditRunResult> {
  const configResult = resolveKitConfig();
  if (!configResult.ok) {
    return { code: 2, reason: configResult.reason };
  }

  let subscribers: KitSubscriberSummary[];
  try {
    subscribers = await deps.fetchSubscribers(configResult.config);
  } catch (e) {
    return { code: 2, reason: `GET /subscribers falhou: ${(e as Error).message}` };
  }

  const result = auditKitFixtures(subscribers);
  const report = renderKitFixtureAuditReport(result);
  deps.log(report);

  if (result.active.length > 0) {
    return { code: 1, report };
  }
  return { code: 0, report };
}

export async function main(): Promise<void> {
  loadProjectEnv();
  const result = await runAudit(productionDeps());
  if (result.code === 2) {
    console.error(`  FALHA — ${result.reason}`);
  }
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  await main();
}
