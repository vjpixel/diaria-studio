#!/usr/bin/env node
/**
 * scripts/send-monthly-apoiadores.ts (#4521)
 *
 * Motor da skill `/diaria-mensal-apoiadores` — envio EXTRA do digest mensal
 * (`data/monthly/{ciclo}/draft.md`) por e-mail via Beehiiv pros apoiadores
 * dos níveis Mantenedor/Patrono. Ver `.claude/skills/diaria-mensal-apoiadores/SKILL.md`
 * pro fluxo completo e `scripts/lib/mensal/monthly-apoiadores-state.ts` pra
 * semântica do dedup.
 *
 * ## Relação com #4482
 *
 * A issue #4482 ("digest mensal também pra base Beehiiv") já entregou e
 * fechou (merge #4510) a MAIOR parte do que #4521 pede: mesma decisão de
 * plataforma (Beehiiv), mesmo segmento-alvo (só Mantenedor/Patrono), mesmo
 * módulo de render (`render-monthly-beehiiv.ts` /
 * `scripts/lib/mensal/monthly-beehiiv-render.ts`). O que #4482 deixou
 * como follow-up explícito ("só o primeiro envio, semi-manual... automação
 * completa é follow-up") e que #4521 cobra especificamente:
 *
 *   1. Skill MANUAL SEPARADA (não uma etapa dentro de `/diaria-mensal`) —
 *      este script + `.claude/skills/diaria-mensal-apoiadores/SKILL.md`.
 *   2. Mecanismo de audiência multi-segmento resolvido de verdade: pesquisado
 *      via `mcp__claude_ai_Beehiiv__search_documentation`/`read_documentation`
 *      ("Options on the Audience page of the post flow") — a Beehiiv aceita
 *      nativamente incluir/excluir até 5 segmentos combinados por post. Não
 *      precisa criar um 7º segmento combinado "Mantenedor ou Patrono" — a
 *      hipótese de precisar disso (texto original do #4482) está descartada.
 *   3. Idempotência/dedup real — ver `monthly-apoiadores-state.ts`.
 *
 * ## Conteúdo: NÃO reintroduz boxes tipo `newsletter-patronos.ts`
 *
 * A issue #4521 sugere reusar/estender os snippets Patronos da diária
 * (`data/snippets/patronos-*.md`) pro espaço deixado vazio pelas seções
 * `CLARICE — DIVULGAÇÃO`/`CLARICE — TUTORIAL` removidas. Essa MESMA pergunta
 * já foi decidida ao vivo pelo editor no #4482 (comentário 260803, decisão
 * 3): "remover DIVULGAÇÃO/TUTORIAL sem substituir por nada — mais simples,
 * espaço reservado fica vazio." Este script mantém essa decisão já tomada
 * (via `renderMonthlyBeehiivEmail`/`filterDraftForBeehiiv`, inalterados) em
 * vez de reabri-la unilateralmente — não há editor presente nesta sessão pra
 * confirmar uma mudança de rumo, e os snippets Patronos são específicos do
 * nível Patrono (não Mantenedor), então "extRendê-los pro mensal" também
 * arrastaria uma decisão de conteúdo por nível que ninguém tomou ainda. Sinalizado
 * como discrepância pro editor decidir (ver corpo do PR), não resolvido aqui.
 *
 * ## Guard de publicação (INVARIANTE)
 *
 * Este script NUNCA chama a API de escrita da Beehiiv — só lê `draft.md` +
 * `public-images.json` local e escreve HTML/estado locais. `--mark-sent` só
 * atualiza o JSON de estado local a partir de uma confirmação MANUAL do
 * editor (que já enviou de verdade pela UI) — nunca dispara nada sozinho.
 *
 * Uso:
 *   npx tsx scripts/send-monthly-apoiadores.ts --cycle 2607-08              # prepara (idempotente)
 *   npx tsx scripts/send-monthly-apoiadores.ts --cycle 2607-08 --force      # re-prepara mesmo se já 'sent'
 *   npx tsx scripts/send-monthly-apoiadores.ts --cycle 2607-08 --mark-sent  # confirma envio manual já feito
 */
import { requireMonthlyCycleArg, monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import { hasFlag } from "./lib/cli-args.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { renderMonthlyBeehiivEmail, printManualPublishInstructions } from "./render-monthly-beehiiv.ts";
import {
  readApoiadoresState,
  writeApoiadoresState,
  decidePrepareAction,
  decideMarkSentAction,
  buildPreparedState,
  buildSentState,
  type ApoiadoresState,
} from "./lib/mensal/monthly-apoiadores-state.ts";
import { APOIO_SEGMENTS_CANONICAL } from "./lib/apoio-segments-canonical.ts";

/** Segmentos-alvo do envio extra (decisão 2 do #4482 — só Mantenedor/Patrono, nunca a base inteira). */
export const APOIADORES_TARGET_SEGMENT_NAMES: readonly string[] = APOIO_SEGMENTS_CANONICAL.filter(
  (s) => s.name === "Apoio — Mantenedor" || s.name === "Apoio — Patrono",
).map((s) => s.name);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const monthlyDir = resolveMonthlyDir(cycle);
  const force = hasFlag(argv, "force");
  const markSent = hasFlag(argv, "mark-sent");

  const state = readApoiadoresState(monthlyDir);

  if (markSent) {
    const decision = decideMarkSentAction(state);
    if (decision.action === "error") {
      console.error(`[send-monthly-apoiadores] ${decision.reason}`);
      process.exit(1);
      return;
    }
    if (decision.action === "noop") {
      console.log(`[send-monthly-apoiadores] ${decision.reason}`);
      return;
    }
    // #4572/#4593 self-review: extraído pra buildSentState (pura, testada em
    // monthly-apoiadores-state.test.ts) em vez de montar o objeto ad hoc aqui
    // — preserva brevoCampaignId (e qualquer campo futuro) por construção,
    // não por disciplina de manter o spread atualizado a cada novo campo.
    const updated: ApoiadoresState = buildSentState(decision.state, new Date().toISOString());
    writeApoiadoresState(monthlyDir, updated);
    console.log(`[send-monthly-apoiadores] Registrado: ciclo ${cycle} marcado como ENVIADO em ${updated.sentAt}.`);
    return;
  }

  const decision = decidePrepareAction(state, force);
  if (decision.action === "blocked") {
    console.error(`[send-monthly-apoiadores] ${decision.reason}`);
    process.exit(1);
    return;
  }

  const rendered = renderMonthlyBeehiivEmail(cycle);

  const newState: ApoiadoresState = buildPreparedState(
    cycle,
    new Date().toISOString(),
    rendered.htmlPath,
    rendered.subject,
    APOIADORES_TARGET_SEGMENT_NAMES,
    // #4572/#4593: preserva o brevoCampaignId de um Passo 2 já rodado — este
    // Passo 1 (fluxo Beehiiv legado) não pode apagar o registro de que já
    // existe uma campanha Brevo criada pro ciclo (ver docstring de
    // buildPreparedState).
    state?.brevoCampaignId ?? null,
  );
  writeApoiadoresState(monthlyDir, newState);

  console.log(
    JSON.stringify(
      {
        cycle,
        yymm: rendered.yymm,
        subject: rendered.subject,
        preview_text: rendered.previewText,
        html_path: rendered.htmlPath,
        segments: newState.segments,
        state: "draft_prepared",
      },
      null,
      2,
    ),
  );
  printManualPublishInstructions();
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[send-monthly-apoiadores] ${(e as Error).message}`);
    process.exit(1);
  });
}
