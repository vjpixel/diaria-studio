#!/usr/bin/env node
/**
 * scripts/aquisicao-reconcile-daily.ts (#8591)
 *
 * Wrapper agendável de `scripts/aquisicao-reconcile.ts` — fecha o item 3 da
 * issue #8591 ("Nada alarma quando o painel de ads descola dos cadastros
 * reais"): rodar `baseline` todo dia, sem depender de alguém lembrar de
 * invocar o comando manual.
 *
 * ## O que este script FAZ
 *
 * Roda `baseline` (`aggregateBaseline` + `fetchSubscribersByBackend`, ambos
 * de `aquisicao-reconcile.ts`, inalterados) para o dia BRT ANTERIOR ao
 * horário de execução, grava o JSON de sempre em
 * `data/aquisicao/reconcile-baseline-{dia}_{dia}.json` (idempotente por
 * dia — reexecução no mesmo dia sobrescreve o mesmo arquivo) e imprime a
 * coorte real por canal. Backend (Kit ou Beehiiv) resolvido por
 * `resolveNewsletterSubscriberBackend()` — mesmo dispatch do subcomando
 * manual; item 1 da #8591 ("baseline lê a fonte errada") já foi corrigido
 * no #7561 (06/09/2026), antes desta issue ter sido aberta — este script
 * não precisa (nem deveria) tocar nesse dispatch.
 *
 * ## O que este script DELIBERADAMENTE NÃO FAZ (item 2 da #8591, bloqueado)
 *
 * A issue propõe consumir "as conversões do painel" pelo mesmo caminho dos
 * ingests diários de gasto (`google-ads-ingest-spend.ts`,
 * `meta-ads-ingest-spend.ts`). Investigação: **nenhum dos dois ingests
 * busca conversões** — só `metrics.cost_micros`/`clicks`/`impressions`
 * (Google, GAQL) e o equivalente de gasto na Graph API (Meta). Buscar
 * conversões exigiria decidir, por plataforma, qual AÇÃO de conversão
 * conta como "cadastro" (Google: qual `conversion_action` entre os
 * cadastrados na conta; Meta: qual `action_type` do campo `actions` do
 * Insights — lead, complete_registration, ou o evento CAPI do #8572) e
 * confirmar que o token/escopo já concedido cobre ler esse metric — nenhuma
 * das duas é uma escolha mecânica, e nenhuma está documentada em lugar
 * nenhum do projeto. Inventar uma aqui seria "achar sozinho a resposta que
 * é trade-off editorial genuíno" (critério 2 de "Perguntar é exceção",
 * CLAUDE.md) — decisão do editor, não deste script.
 *
 * Por isso o `factor` (fator = painel/coorte real) permanece MANUAL: se
 * existir um arquivo de painel em `data/aquisicao/painel/{dia}.json` (mesmo
 * formato de `docs/aquisicao-reconcile-panel-template.json`) para o dia
 * processado, este script roda `factor` sobre ele e imprime o resultado
 * (log-only, nunca alarma — ver próxima seção). Se não existir, loga que o
 * passo foi pulado por falta de painel e segue — nunca trata isso como
 * erro.
 *
 * ## Log-only, sem inventar faixa de alarme (item 3 da #8591)
 *
 * A própria issue pede faixa medida em 2-3 semanas de dados limpos antes de
 * virar alarme de verdade ("por isso faixa, e por isso o limiar merece ser
 * medido... começar em log-only"). Este script só IMPRIME o fator quando
 * há painel — não decide "dentro/fora da faixa", não cria issue, não
 * manda e-mail. Um alarme de verdade (`ads-spend-ingest-alarm.ts` é o
 * precedente de forma) é trabalho FUTURO, depois da janela de medição, e
 * fica de fora deste script de propósito.
 *
 * ## Fail-soft
 *
 * Mesma disciplina de `google-ads-ingest-spend.ts`/`meta-ads-ingest-spend.ts`:
 * qualquer falha (MCP fora do ar, API fora do ar, `data/` não montada)
 * imprime o motivo e sai com **exit 0** — a task agendada nunca falha
 * ruidosamente por uma ingestão de observabilidade.
 *
 * Uso:
 *   npx tsx scripts/aquisicao-reconcile-daily.ts                # dia BRT anterior
 *   npx tsx scripts/aquisicao-reconcile-daily.ts --day AAAA-MM-DD  # override p/ teste/backfill
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { brtDateOf, shiftDate } from "./lib/ads-rolling-window.ts";
import {
  aggregateBaseline,
  computeFactor,
  fetchSubscribersByBackend,
  type BaselineFile,
  type PanelInput,
} from "./aquisicao-reconcile.ts";
import { resolveNewsletterSubscriberBackend } from "./lib/shared/newsletter-subscriber-source.ts";

/** Dia BRT a processar por default: o dia ANTERIOR ao instante de execução
 * (mesma lógica de "roda de manhã sobre o dia que já fechou" dos ingests de
 * gasto vizinhos). @pure em relação a `now`. */
export function defaultProcessingDay(now: Date): string {
  return shiftDate(brtDateOf(now), -1);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv).values;
  const day = typeof args.day === "string" && args.day ? args.day : defaultProcessingDay(new Date());

  console.log(`[aquisicao-reconcile-daily] dia ${day} — backend=${resolveNewsletterSubscriberBackend()}`);

  let baseline: BaselineFile;
  try {
    const subs = await fetchSubscribersByBackend(resolveNewsletterSubscriberBackend());
    baseline = aggregateBaseline(subs, day, day);
  } catch (e) {
    console.error(
      `[aquisicao-reconcile-daily] falha ao drenar a coorte real (${e instanceof Error ? e.message : String(e)}) — pulando o dia, sem alarmar (fail-soft, mesma disciplina dos ingests de gasto)`,
    );
    return 0;
  }

  const baselinePath = resolve("data", "aquisicao", `reconcile-baseline-${day}_${day}.json`);
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`[aquisicao-reconcile-daily] coorte real ${day}: ${baseline.total} cadastros`);
  for (const [channel, count] of Object.entries(baseline.per_channel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${channel}: ${count}`);
  }

  const panelPath = resolve("data", "aquisicao", "painel", `${day}.json`);
  if (!existsSync(panelPath)) {
    console.log(
      `[aquisicao-reconcile-daily] sem painel em ${panelPath} — fator não calculado hoje (ingestão automática de conversões do painel é bloqueio documentado da #8591, item 2: nenhum canal expõe conversões pelos ingests de gasto atuais)`,
    );
    return 0;
  }

  let panel: PanelInput;
  try {
    panel = JSON.parse(readFileSync(panelPath, "utf8")) as PanelInput;
  } catch (e) {
    console.error(
      `[aquisicao-reconcile-daily] painel em ${panelPath} não é JSON válido (${e instanceof Error ? e.message : String(e)}) — pulando o fator do dia, sem alarmar`,
    );
    return 0;
  }

  const result = computeFactor(baseline, panel);
  console.log(`[aquisicao-reconcile-daily] fator do dia ${day} (log-only — faixa de alarme ainda em medição, #8591):`);
  for (const row of result.rows) {
    const fator = row.fator_superestimacao == null ? "SEM COORTE" : `${row.fator_superestimacao.toFixed(2)}x`;
    console.log(`  ${row.channel.padEnd(12)} painel=${row.reported_conversions} real=${row.coorte_real} fator=${fator}`);
  }
  const fatorPath = resolve("data", "aquisicao", "painel", `${day}.fator.json`);
  writeFileSync(fatorPath, JSON.stringify(result, null, 2) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(0);
    });
}
