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
 * ## ⚠️ `--mark-sent` é opcional na prática, e isso já custou um mês (#7655)
 *
 * O ciclo 2607-08 foi ENVIADO de verdade em 04/08/2026 (campanha Brevo 12,
 * 10 entregues) e o state ficou em `draft_prepared` até hoje, porque o envio
 * saiu pela UI e ninguém rodou `--mark-sent`. Três documentos e um punhado de
 * docstrings passaram a afirmar que aquele canal nunca tinha enviado nada,
 * cada um citando o anterior.
 *
 * Consequência para quem lê este state depois: `status` responde "o que os
 * scripts registraram", nunca "o que o ESP fez". Para a segunda pergunta,
 * consultar o ESP — e é por isso que `--mark-sent` existe, embora nada o
 * force.
 *
 * O erro inverso também aconteceu (#12739): o ciclo 2609-10 ficou `sent` com
 * o broadcast Kit 26211180 em rascunho, porque o `--mark-sent` rodou 15s
 * depois de o rascunho ser criado, sem envio nenhum. Por isso o `--mark-sent`
 * agora relê o broadcast no Kit antes de gravar (ver `runMarkSent`).
 *
 * ## #7633 — render trocado de Brevo pra Kit
 *
 * Mesma troca que o #7121 abaixo fez (Beehiiv → Brevo), agora Brevo → Kit, e
 * pelo mesmo motivo estrutural: este Passo 1 deve renderizar o MESMO HTML que
 * o Passo 2 vai publicar, senão o `htmlPath` gravado no state aponta pro
 * preview de um canal que não é o que envia. O canal atual é o Kit
 * (`publish-monthly-apoiadores-kit.ts`) — ver `.claude/skills/diaria-mensal-apoiadores/SKILL.md`.
 * Os scripts Brevo continuam no repo até o 1º envio Kit real (#7633).
 *
 * ## #7121 (260902) — render trocado de Beehiiv pra Brevo
 *
 * Este script (Passo 1 — "prepare") historicamente renderizava a variante
 * BEEHIIV (`renderMonthlyBeehiivEmail`, `render-monthly-beehiiv.ts`) só pelo
 * lado de EFEITO DE ESTADO (`htmlPath`/`subject` gravados no state local) —
 * o canal Beehiiv nunca chegou a enviar nada ao vivo (#4572). O Passo 2
 * (`publish-monthly-apoiadores-brevo.ts`) já é quem de fato cria a campanha
 * e já grava `status: draft_prepared` sozinho (`decidePublishBrevoAction`
 * aceita `state: null` — não depende deste Passo 1 ter rodado antes), então
 * a única função remanescente deste Passo 1 é permitir preparar/registrar o
 * ciclo ANTES de rodar o Passo 2 (ex: pra inspecionar o HTML localmente
 * primeiro). Trocado pra renderizar via `renderMonthlyApoiadoresBrevoEmail`
 * (`render-monthly-apoiadores-brevo.ts`, o MESMO render que o Passo 2 usa)
 * em vez do Beehiiv, que foi removido por não ter consumidor de runtime.
 *
 * ## Relação com #4482
 *
 * A issue #4482 ("digest mensal também pra base Beehiiv") já entregou e
 * fechou (merge #4510) a MAIOR parte do que #4521 pede: mesmo segmento-alvo
 * (só Mantenedor/Patrono), mesma origem de conteúdo (`draft.md`). O que
 * #4482 deixou como follow-up explícito ("só o primeiro envio, semi-manual...
 * automação completa é follow-up") e que #4521 cobra especificamente:
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
 * (via `renderMonthlyApoiadoresBrevoEmail`/`filterDraftForApoiadores`,
 * inalterados) em vez de reabri-la unilateralmente — não há editor presente
 * nesta sessão pra confirmar uma mudança de rumo, e os snippets Patronos são específicos do
 * nível Patrono (não Mantenedor), então "extRendê-los pro mensal" também
 * arrastaria uma decisão de conteúdo por nível que ninguém tomou ainda. Sinalizado
 * como discrepância pro editor decidir (ver corpo do PR), não resolvido aqui.
 *
 * ## Guard de publicação (INVARIANTE)
 *
 * Este script NUNCA chama a API de escrita da Beehiiv — só lê `draft.md` +
 * `public-images.json` local e escreve HTML/estado locais. `--mark-sent` só
 * atualiza o JSON de estado local — nunca dispara nada sozinho. Desde o
 * #12739, com `kitBroadcastId` no state ele RELÊ o broadcast no Kit (GET,
 * somente leitura) e só grava `sent` se o Kit devolver
 * `scheduled`/`sending`/`completed`; rascunho recusa (`runMarkSent`).
 *
 * Uso:
 *   npx tsx scripts/send-monthly-apoiadores.ts --cycle 2607-08              # prepara (idempotente)
 *   npx tsx scripts/send-monthly-apoiadores.ts --cycle 2607-08 --force      # re-prepara mesmo se já 'sent'
 *   npx tsx scripts/send-monthly-apoiadores.ts --cycle 2607-08 --mark-sent  # confirma envio manual já feito
 */
import { requireMonthlyCycleArg, monthlyDir as resolveMonthlyDir } from "./lib/mensal/monthly-paths.ts";
import { hasFlag } from "./lib/cli-args.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { renderMonthlyApoiadoresKitEmail } from "./render-monthly-apoiadores-kit.ts";
import {
  readApoiadoresState,
  writeApoiadoresState,
  decidePrepareAction,
  decideMarkSentAction,
  buildPreparedState,
  buildSentState,
  type ApoiadoresState,
} from "./lib/mensal/monthly-apoiadores-state.ts";
import { APOIO_SEGMENTS_CANONICAL_KIT } from "./lib/apoio-segments-canonical-kit.ts";
import { APOIADORES_MENSAL_NIVEIS } from "./lib/mensal/apoiadores-kit-channel.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import {
  confirmKitBroadcastSent,
  type KitBroadcastSendSnapshot,
} from "./lib/mensal/apoiadores-kit-sent-confirmation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Audiência-alvo do envio extra (decisão 2 do #4482 — só Mantenedor/Patrono,
 * nunca a base inteira), gravada no state só como METADADO de auditoria.
 *
 * #7633: derivada do catálogo de segmentos do KIT (era o da Beehiiv), pra que
 * o registro cite a plataforma em que o envio de fato acontece. Continua sendo
 * descrição de audiência, não o mecanismo: quem de fato define quem recebe é a
 * TAG `kit_apoiadores.audience_tag`, porque a membresia de segmento do Kit não
 * é legível pela API (ver `lib/mensal/apoiadores-kit-channel.ts`).
 */
export const APOIADORES_TARGET_SEGMENT_NAMES: readonly string[] = APOIO_SEGMENTS_CANONICAL_KIT.filter(
  (s) => s.nivel !== null && APOIADORES_MENSAL_NIVEIS.includes(s.nivel),
).map((s) => s.name);

export interface MarkSentDeps {
  readState: (dir: string) => ApoiadoresState | null;
  writeState: (dir: string, state: ApoiadoresState) => void;
  /** Releitura do broadcast no Kit. `null` = sem credencial (`KIT_API_KEY` ausente). */
  getBroadcast: ((id: number) => Promise<KitBroadcastSendSnapshot>) | null;
  now: () => Date;
}

export type MarkSentResult = { action: "written" | "noop"; message: string } | { action: "error"; reason: string };

/**
 * `--mark-sent` (#12739): com `kitBroadcastId` no state, só grava `sent`
 * depois de RELER o broadcast no Kit e ver `scheduled`/`sending`/`completed`
 * (`confirmKitBroadcastSent`). Rascunho, status ausente, releitura que falha ou
 * credencial ausente recusam sem tocar o state: o ciclo 2609-10 ficou `sent`
 * com o broadcast 26211180 em rascunho porque esta confirmação era só a
 * palavra de quem rodava o comando. `sentAt` vem do `send_at` relido quando o
 * Kit o devolve (horário real do envio/agendamento), senão do relógio.
 *
 * Sem `kitBroadcastId` (state legado Beehiiv/Brevo, ex. 2607-08 enviado pela UI
 * da Brevo, #7655) não há broadcast Kit para reler: segue a confirmação manual
 * de antes, avisando que ela não foi conferida no ESP.
 */
export async function runMarkSent(opts: { cycle: string; monthlyDir: string; deps: MarkSentDeps }): Promise<MarkSentResult> {
  const { cycle, monthlyDir, deps } = opts;
  const decision = decideMarkSentAction(deps.readState(monthlyDir));
  if (decision.action === "error") return { action: "error", reason: decision.reason };
  if (decision.action === "noop") return { action: "noop", message: decision.reason };

  const broadcastId = decision.state.kitBroadcastId;
  let sentAt = deps.now().toISOString();
  let note: string;
  if (broadcastId != null) {
    if (!deps.getBroadcast) {
      return {
        action: "error",
        reason:
          `o ciclo ${cycle} tem o broadcast Kit id=${broadcastId}, e marcar 'sent' exige reler o broadcast no Kit ` +
          "(#12739), mas KIT_API_KEY não está no ambiente. Nada gravado.",
      };
    }
    let live: KitBroadcastSendSnapshot;
    try {
      live = await deps.getBroadcast(broadcastId);
    } catch (e) {
      return {
        action: "error",
        reason:
          `a releitura do broadcast Kit id=${broadcastId} falhou (${(e as Error).message}) — sem ela não há como ` +
          "saber se o e-mail saiu. Nada gravado (#12739).",
      };
    }
    const confirmation = confirmKitBroadcastSent(live, broadcastId);
    if (!confirmation.ok) return { action: "error", reason: `${confirmation.reason} Nada gravado.` };
    if (confirmation.sendAt) sentAt = confirmation.sendAt;
    note = ` (conferido no Kit: broadcast ${broadcastId} "${confirmation.status}")`;
  } else {
    note =
      " (sem broadcast Kit no state — confirmação MANUAL, não conferida no ESP; confira na API do ESP antes de " +
      "afirmar que saiu, #7655)";
  }
  // #4572/#4593 self-review: extraído pra buildSentState (pura, testada em
  // monthly-apoiadores-state.test.ts) em vez de montar o objeto ad hoc aqui
  // — preserva brevoCampaignId (e qualquer campo futuro) por construção,
  // não por disciplina de manter o spread atualizado a cada novo campo.
  const updated: ApoiadoresState = buildSentState(decision.state, sentAt);
  deps.writeState(monthlyDir, updated);
  return { action: "written", message: `Registrado: ciclo ${cycle} marcado como ENVIADO em ${updated.sentAt}${note}.` };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cycle = requireMonthlyCycleArg(argv);
  const monthlyDir = resolveMonthlyDir(cycle);
  const force = hasFlag(argv, "force");
  const markSent = hasFlag(argv, "mark-sent");

  if (markSent) {
    loadProjectEnv(ROOT);
    const kitConfigResult = resolveKitConfig();
    const result = await runMarkSent({
      cycle,
      monthlyDir,
      deps: {
        readState: readApoiadoresState,
        writeState: writeApoiadoresState,
        getBroadcast: kitConfigResult.ok ? (id) => getBroadcast(id, kitConfigResult.config) : null,
        now: () => new Date(),
      },
    });
    if (result.action === "error") {
      console.error(`[send-monthly-apoiadores] ${result.reason}`);
      process.exit(1);
      return;
    }
    console.log(`[send-monthly-apoiadores] ${result.message}`);
    return;
  }

  const state = readApoiadoresState(monthlyDir);

  const decision = decidePrepareAction(state, force);
  if (decision.action === "blocked") {
    console.error(`[send-monthly-apoiadores] ${decision.reason}`);
    process.exit(1);
    return;
  }

  const rendered = renderMonthlyApoiadoresKitEmail(cycle);

  const newState: ApoiadoresState = buildPreparedState(
    cycle,
    new Date().toISOString(),
    rendered.htmlPath,
    rendered.subject,
    APOIADORES_TARGET_SEGMENT_NAMES,
    // #4572/#4593 (Brevo) e #7633 (Kit): preserva os ids de um Passo 2 já
    // rodado — este Passo 1 não pode apagar o registro de que já existe
    // rascunho criado pro ciclo (ver docstring de buildPreparedState).
    { brevoCampaignId: state?.brevoCampaignId ?? null, kitBroadcastId: state?.kitBroadcastId ?? null },
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
  console.log(
    `\nPróximo passo: npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle ${cycle} --dry-run`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[send-monthly-apoiadores] ${(e as Error).message}`);
    process.exit(1);
  });
}
