#!/usr/bin/env node
/**
 * clarice-schedule-group.ts (#3228)
 *
 * Fecha o gap entre o caminho de GRUPOS NOMEADOS (`clarice-build-segment.ts`
 * + `clarice-import-waves.ts --group`, #2885/#2916 — que criam+importam a
 * LISTA no Brevo com sucesso) e a CAMPANHA que de fato dispara pra essa
 * lista. Até aqui, o único script que sabia criar+agendar uma campanha em
 * cima de um `--list-id` arbitrário era `publish-monthly.ts`
 * (`@deprecated` #2009 — fluxo legado de campanha única do digest mensal,
 * substituído pelo pipeline canônico multi-campanha
 * `clarice-build-edition-sends.ts` → `clarice-split-cells.ts` →
 * `clarice-schedule-sends.ts`). Esse pipeline canônico só sabe casar
 * campanha↔lista via `sends-summary.json` (dNN do plano de blocos/rampa) —
 * não tem `--list-id`/`--group`.
 *
 * Este script é o irmão dedicado sugerido na #3228: cobre exatamente o caso
 * "1 campanha por lista arbitrária" (grupo nomeado OU list-id cru), reusando
 * os MESMOS blocos do pipeline canônico em vez de duplicar lógica (raiz do
 * bug #3226 foi justamente duplicação entre close-poll.ts/publish-monthly.ts):
 *   - HTML:      mesmo `_internal/cloudflare-preview.html` (Stage 4 —
 *                já com imagens upadas pro Cloudflare KV; este script NÃO
 *                faz upload de imagem, mesma convenção de clarice-schedule-sends.ts)
 *   - guard É IA?: `checkEiaGuard` (importado de clarice-schedule-sends.ts)
 *   - GET-verify pós-schedule: `isScheduledStatus`/`applyVerifyResults` (idem)
 *   - transporte Brevo: brevoPost/brevoPut/brevoGetCampaign (lib/brevo-client.ts)
 *
 * Fases (mesmo padrão de clarice-schedule-sends.ts — cada uma exige flag
 * explícita; sem nenhuma, só imprime o plano):
 *   --create          cria a campanha como RASCUNHO (idempotente por --key).
 *                      Requer --subject. --schedule-at (data alvo, validada
 *                      no futuro) agora é OPCIONAL (#4347 G7/D7) — sem ela, o
 *                      rascunho é criado SEM data (destinado a --send-now,
 *                      disparo imediato); a validação "no futuro" só se
 *                      aplica quando a flag É passada. --preview-text "..."
 *                      opcional (paridade com publish-monthly.ts; sem a flag,
 *                      Brevo usa o snippet default derivado do HTML).
 *                      --update-existing N reusa uma campanha já existente
 *                      (PUT) em vez de criar nova (POST) — mesmo pre-check de
 *                      status terminal que publish-monthly.ts fazia.
 *   --update-html      re-aplica o HTML atual (cloudflare-preview.html) na
 *                      campanha em draft — propaga fix de render pós-create.
 *   --send-test        manda test email pro `brevo_monthly.test_email` do
 *                      platform.config.json.
 *   --schedule         agenda a campanha (PUT scheduledAt + GET-verify).
 *                      REQUER `scheduledAt` (criada com --schedule-at) e o
 *                      gabarito É IA? setado antes via
 *                        npx tsx scripts/close-poll.ts --brand clarice --cycle {cycle} --edition {AAMMDD} [--answer A|B]
 *                      --skip-eia-guard pula essa verificação (não recomendado).
 *                      Este caminho NÃO MUDA (#4347) — outros fluxos dependem dele.
 *   --send-now         #4347 G7/D7: dispara a campanha IMEDIATAMENTE (POST
 *                      /emailCampaigns/{id}/sendNow) — sem agendamento, sem
 *                      trava de janela. Mesmo guard É IA? do --schedule.
 *                      GET-verify pós-disparo confirma status terminal
 *                      ("sent"/"inProcess") antes de marcar sucesso — nunca
 *                      confia só no 2xx do POST. Idempotente: campanha já
 *                      `"sent"` é pulada.
 *
 * --content-cycle X    #4347: OPCIONAL — ciclo mensal do CONTEÚDO (HTML +
 *                      gabarito É IA?) quando diverge do --cycle de
 *                      contatos/segments (ex: /diaria-clarice-novos resolve a
 *                      edição pronta mais recente via resolveLatestMonthlyCycle,
 *                      que pode cair — D3 — num ciclo mensal ANTERIOR ao ciclo
 *                      Clarice corrente). Sem a flag, content = --cycle
 *                      (comportamento original, todo caller pré-#4347).
 *
 * Resolução da lista (--group XOR --list-id, uma delas obrigatória):
 *   --group NOME       resolve o listId via o registro escrito por
 *                      `clarice-import-waves.ts --group NOME --execute` em
 *                      `{ciclo}/segments/{NOME}-lists.json` (#3228). Se o
 *                      grupo foi rodado mais de uma vez (várias listas no
 *                      mesmo ciclo), usa a ÚLTIMA por padrão — `--list-index N`
 *                      (0-based) escolhe outra.
 *   --list-id N        lista Brevo arbitrária direta (não precisa ter
 *                      passado pelo fluxo --group — cobre lista criada por
 *                      outro caminho, ex: manual/legado).
 *   --key K            identifica a campanha entre invocações (idempotência
 *                      de --create/--schedule, mesmo papel do `key` em
 *                      campaigns-summary.json de clarice-schedule-sends.ts).
 *                      Default: --group (ou `list-{listId}` se só --list-id
 *                      foi passado). OBRIGATÓRIO informar explicitamente
 *                      quando o mesmo grupo tiver múltiplas listas/campanhas
 *                      no mesmo ciclo (senão a 2ª invocação de --create
 *                      colidiria com a 1ª sob a mesma key). A idempotência é
 *                      só por --key, NÃO por listId (#3354): se a mesma key
 *                      resolver pra um listId diferente do que já foi criado
 *                      (ex: --group ganhou lista nova mas --key foi
 *                      esquecido), --create ABORTA em vez de pular
 *                      silenciosamente — ver `checkListIdMismatch`.
 *
 * Uso típico (via --group):
 *   npx tsx scripts/clarice-build-segment.ts --group ramp-warm --cycle 2606-07 --budget 6403
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group ramp-warm --label "Ramp Jul/2026" --execute
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --group ramp-warm \
 *     --subject "Assunto da campanha" --schedule-at 2026-07-15T09:00:00Z --create
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --group ramp-warm --send-test
 *   npx tsx scripts/close-poll.ts --brand clarice --cycle 2606-07 --edition 260714 --answer A
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --group ramp-warm --schedule
 *
 * Uso típico (via --list-id direto, ex: 3 listas do mesmo grupo no mesmo ciclo):
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --list-id 69 --key ramp-warm-1 \
 *     --subject "Assunto A" --schedule-at 2026-07-15T09:00:00Z --create
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --list-id 70 --key ramp-warm-2 \
 *     --subject "Assunto A" --schedule-at 2026-07-16T09:00:00Z --create
 *
 * Estado em {ciclo}/segments/group-campaigns.json (idempotência: --create
 * pula campanhas já criadas pra a mesma --key; --schedule usa os IDs
 * gravados) — irmão de campaigns-summary.json (rampa) e {group}-lists.json
 * (registro de listas, #3228), todos em segments/.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoPut, brevoGetCampaign, brevoSendNow, isTerminalSendStatus, describeUncertainSendStatus } from "./lib/brevo-client.ts";
import { clariceSegmentsDir, ensureDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "./lib/mensal/monthly-paths.ts";
import { checkEiaGuard, applyVerifyResults } from "./clarice-schedule-sends.ts";
import { groupListsRegistryPath, type GroupListEntry } from "./clarice-import-waves.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Mesmo shape de CampaignEntry em clarice-schedule-sends.ts (não exportado lá —
// TS casa estruturalmente ao passar pra applyVerifyResults/isScheduledStatus,
// sem precisar de import de tipo) — EXCETO `scheduledAt`/`status`, que aqui
// são mais amplos (#4347 G7/D7): `scheduledAt` é OPCIONAL (uma campanha criada
// sem `--schedule-at` — pro caminho `--send-now` — não tem data alvo) e
// `status` ganha `"sent"` (disparo imediato via `brevoSendNow`). Ao chamar
// `applyVerifyResults`/`isScheduledStatus` (que só conhecem "draft"/"scheduled"
// e exigem `scheduledAt: string`), usar um cast de shape — mesmos objetos por
// REFERÊNCIA (a mutação `c.status = "scheduled"` continua visível aqui), só o
// tipo estático diverge nesse call site pontual (ver bloco `--schedule`).
export interface CampaignEntry {
  key: string;
  campaignId: number;
  listId: number;
  subject: string;
  scheduledAt?: string;
  status: "draft" | "scheduled" | "sent";
}

/** Shape exato que `applyVerifyResults`/`isScheduledStatus` (clarice-schedule-sends.ts)
 *  esperam — usado só pro cast de tipo no bloco `--schedule` (ver docstring de `CampaignEntry` acima). */
type ScheduleSendsShape = {
  key: string;
  campaignId: number;
  listId: number;
  subject: string;
  scheduledAt: string;
  status: "draft" | "scheduled";
};

/**
 * Resolve `{listId, listName}` do registro escrito por
 * `clarice-import-waves.ts --group NOME --execute` (#3228,
 * `{ciclo}/segments/{group}-lists.json`). `index` (0-based) escolhe qual
 * entrada usar quando o grupo tem múltiplas listas no ciclo; default = a
 * ÚLTIMA (mais recente).
 */
export function resolveGroupListId(
  segmentsDir: string,
  group: string,
  index?: number,
): { listId: number; listName: string } {
  const file = groupListsRegistryPath(segmentsDir, group);
  if (!existsSync(file)) {
    throw new Error(
      `registro de listas do grupo '${group}' não encontrado: ${file}\n` +
        `Rode 'clarice-import-waves.ts --cycle ... --group ${group} --execute' antes ` +
        `(ou passe --list-id N diretamente, se a lista já existe no Brevo por outro caminho).`,
    );
  }
  let parsed: { lists?: GroupListEntry[] };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} corrompido (JSON inválido): ${String(e)}`);
  }
  const lists = parsed.lists ?? [];
  if (lists.length === 0) {
    throw new Error(`registro de listas do grupo '${group}' está vazio: ${file}`);
  }
  const idx = index ?? lists.length - 1;
  const entry = lists[idx];
  if (!entry) {
    throw new Error(
      `--list-index ${idx} fora do range (grupo '${group}' tem ${lists.length} lista(s), 0..${lists.length - 1}).`,
    );
  }
  return { listId: entry.listId, listName: entry.listName };
}

/** Nome determinístico da campanha. Ex: "Clarice 2606 grupo:ramp-warm". */
export function campaignNameFor(cycle: string, key: string): string {
  return `Clarice ${cycleToYymm(cycle)} grupo:${key}`;
}

/**
 * #4449 item 3: gerador determinístico do nome de LISTA pro braço COM CÉLULA
 * do fluxo `--group` (teste A/B/C) — irmão de `campaignNameFor` acima, mas
 * pro lado da LISTA de destinatários, que é a ÚNICA fonte de ciclo+célula que
 * `parseAbcAudienceCampaign` (workers/brevo-dashboard/src/sections-core.ts)
 * consegue ler pra esse fluxo (#4447) — o nome da CAMPANHA não carrega nem
 * ciclo mensal "AAMM-MM" nem célula reconhecível.
 *
 * Até aqui (#4447/#4448) esse formato de nome de lista era digitado à mão pro
 * ciclo 2607-08 — a MESMA classe de fragilidade que já causou 3 incidentes
 * (#3081 → #3128 → #4447): uma variação de digitação (typo, acento, ordem)
 * quebra o parser em silêncio. Este helper elimina a digitação manual da
 * PARTE que decide célula: `key` precisa terminar em `-A`/`-B`/`-C` (mesmo
 * sufixo que a CAMPANHA já carrega via `campaignNameFor` — a célula da lista
 * é sempre DERIVADA desse sufixo, nunca um valor digitado à parte), então o
 * mismatch que o cross-check de `parseAbcAudienceCampaign` existe pra pegar
 * fica estruturalmente impossível quando o nome vem daqui.
 *
 * Formato gerado (round-trip testado contra `parseAbcAudienceCampaign` em
 * test/clarice-schedule-group.test.ts): "Clarice {cycle} {key} — célula {X}"
 * — `cycle` aqui é o ciclo MENSAL completo "AAMM-MM" (ex: "2607-08"), não o
 * `cycleToYymm` que `campaignNameFor` usa pro nome da campanha (a lista
 * carrega o ciclo completo — é dela que o parser extrai `cycle`).
 *
 * Lança se `key` não terminar em -A/-B/-C — uso incorreto (grupos SEM célula,
 * ex: sufixo "-interno", não usam este helper; nomeie a lista manualmente ou
 * via `listNameFor` de clarice-import-waves.ts).
 */
export function groupCellListNameFor(cycle: string, key: string): string {
  const m = /-([ABC])$/i.exec(key);
  if (!m) {
    throw new Error(
      `groupCellListNameFor: key "${key}" não termina em -A/-B/-C — não é uma célula de teste A/B/C ` +
        `(grupos sem célula não usam este helper).`,
    );
  }
  const cell = m[1].toUpperCase();
  return `Clarice ${cycle} ${key} — célula ${cell}`;
}

/**
 * #3354 — `--create` é idempotente por `--key`, mas até aqui NUNCA comparava
 * o `listId` já gravado (`existing.listId`, de uma criação anterior sob a
 * mesma key) contra o `listId` recém-resolvido nesta invocação (`--group`
 * pode ter uma lista nova mais recente no registro, ou `--list-id` pode ter
 * sido passado errado). Sem essa checagem, uma 2ª invocação `--create` sob a
 * mesma key silenciosamente "pula" (linha da campanha já existe) e a
 * campanha real no Brevo continua apontando pra lista ANTIGA — sem nenhum
 * sinal de erro, mesmo a campanha nunca tendo seu `recipients.listIds`
 * re-tocado por `--schedule` (só faz PUT de `scheduledAt`).
 *
 * Caso feliz de idempotência genuína (mesma key, mesma lista, re-run
 * legítimo — ex: retry após falha de rede) continua sendo no-op silencioso:
 * só sinaliza quando listId DIVERGE do que já foi criado.
 */
export function checkListIdMismatch(
  existing: CampaignEntry | undefined,
  resolvedListId: number,
): { ok: true } | { ok: false; message: string } {
  if (!existing) return { ok: true };
  if (existing.listId === resolvedListId) return { ok: true };
  return {
    ok: false,
    message:
      `\n❌  ERRO: --key '${existing.key}' já tem campanha #${existing.campaignId} criada apontando pra listId=${existing.listId}, ` +
      `mas esta invocação resolveu listId=${resolvedListId} — MISMATCH.\n` +
      `   --create é idempotente por --key, NÃO por listId: rodar de novo sob a mesma --key nunca re-aponta a campanha ` +
      `existente pra uma lista nova (--schedule também não toca recipients/listIds, só scheduledAt) — a campanha real ` +
      `no Brevo continuaria mandando pra listId=${existing.listId} silenciosamente.\n` +
      `   Se a intenção era criar uma campanha SEPARADA pra esta lista nova, use uma --key distinta ` +
      `(ex: --key ${existing.key}-2). Se a lista de fato deveria substituir a anterior nesta key, reconcilie manualmente ` +
      `(edite recipients.listIds da campanha #${existing.campaignId} direto no Brevo e o listId em ` +
      `group-campaigns.json) antes de re-rodar.\n`,
  };
}

/** Parseia --subject: retorna o valor ou undefined. Mesma forma de clarice-schedule-sends.ts. */
export function parseSubjectArg(argv: string[]): string | undefined {
  const v = getArg(argv, "subject");
  return v || undefined;
}

/**
 * #4347 G7/D7 — resolve `--schedule-at` no `--create`. Pura/testável: extrai
 * a validação inline de `main()` pra permitir testar os 3 casos sem mockar
 * HTTP: (a) ausente → `{ scheduledAt: undefined }` (rascunho SEM data,
 * destinado a `--send-now`); (b) presente e no FUTURO → ISO normalizado; (c)
 * presente mas inválido/no passado → `{ error }` (NÃO regride o guard
 * existente — mesma mensagem/condição de antes da #4347, só extraída).
 */
/**
 * #4347: resolve `--content-cycle` (ver docstring de `CampaignEntry` no
 * topo) — pura/testável, extraída da linha inline em `main()` pra provar a
 * regra sem precisar de fixtures reais em `data/monthly/` (`monthlyDir` não
 * é injetável, mesma limitação documentada nos testes deste arquivo).
 */
export function resolveContentCycle(argv: string[], segmentsCycle: string): string {
  return getArg(argv, "content-cycle") || segmentsCycle;
}

export function resolveScheduleAtArg(
  raw: string | undefined,
  now: Date = new Date(),
): { scheduledAt: string | undefined } | { error: string } {
  if (!raw) return { scheduledAt: undefined };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { error: `--schedule-at não é ISO 8601 válido: "${raw}"` };
  }
  if (d.getTime() <= now.getTime()) {
    return {
      error: `--schedule-at deve estar no futuro. Recebido: ${d.toISOString()}, agora: ${now.toISOString()}`,
    };
  }
  return { scheduledAt: d.toISOString() };
}

/** Shape do JSON impresso ao final de `main()` — ver `buildInvocationSummary` (#4202). */
export interface InvocationSummary {
  key: string;
  listId: number;
  campaignId?: number;
  phase: string;
  status?: CampaignEntry["status"];
  cycleTotals: { created: number; scheduled: number; sent: number };
}

/**
 * #4202 — monta o resumo impresso ao final de `main()`. Antes disso, o JSON
 * de saída era só `{ created: campaigns.length, scheduled: N }`: o
 * ACUMULADO do state file do ciclo inteiro (todas as invocações --create já
 * feitas neste ciclo), não o resultado da invocação ATUAL — `created: 2` logo
 * após criar 1 campanha lia como "criei duas por engano", quando na verdade
 * havia 1 campanha desta invocação + 1 de uma invocação anterior sob outra
 * --key. Puro/testável: recebe as flags de fase resolvidas, a entrada
 * (possivelmente recém-criada/atualizada) da campanha desta --key, e a lista
 * completa de campanhas do ciclo (só pra computar `cycleTotals`, que continua
 * disponível — só não é mais confundido com o resultado da invocação).
 */
export function buildInvocationSummary(
  key: string,
  listId: number,
  flags: { create: boolean; updateHtml: boolean; sendTest: boolean; schedule: boolean; sendNow?: boolean },
  campaign: CampaignEntry | undefined,
  allCampaigns: CampaignEntry[],
): InvocationSummary {
  const phase = [
    flags.create && "create",
    flags.updateHtml && "update-html",
    flags.sendTest && "send-test",
    flags.schedule && "schedule",
    flags.sendNow && "send-now",
  ]
    .filter((p): p is string => typeof p === "string")
    .join("+");
  return {
    key,
    listId,
    campaignId: campaign?.campaignId,
    phase,
    status: campaign?.status,
    cycleTotals: {
      created: allCampaigns.length,
      scheduled: allCampaigns.filter((c) => c.status === "scheduled").length,
      sent: allCampaigns.filter((c) => c.status === "sent").length,
    },
  };
}

/**
 * #4347 G7/D7 — aplica os resultados do GET-verify pós-`brevoSendNow` ao
 * `campaigns` array. Mesmo padrão de `applyVerifyResults`
 * (clarice-schedule-sends.ts), mas o status terminal aceito é `isTerminalSendStatus`
 * ("sent"/"inProcess", não "queued"/"scheduled") — NUNCA confia só no 2xx do
 * POST `sendNow`: se o GET não confirmar status terminal, a entrada NÃO é
 * marcada como `"sent"` (fica como estava — próxima invocação re-tenta).
 */
export function applySendNowVerifyResults(
  settled: PromiseSettledResult<{ status: string }>[],
  toVerify: CampaignEntry[],
  campaigns: CampaignEntry[],
  campaignsPath: string,
  writeFn: (path: string, content: string) => void = (p, c) => writeFileAtomic(p, c),
  logFn: (msg: string) => void = (m) => console.error(m),
): void {
  if (settled.length !== toVerify.length) {
    throw new Error(
      `applySendNowVerifyResults: invariante quebrada — settled.length (${settled.length}) !== toVerify.length (${toVerify.length})`,
    );
  }
  for (let i = 0; i < toVerify.length; i++) {
    const c = toVerify[i];
    const result = settled[i];

    if (result.status === "rejected") {
      logFn(
        `⚠ GET-verify pós-sendNow ${c.key} (campanha #${c.campaignId}) falhou: ${String(result.reason)}. ` +
          `Status local NÃO atualizado — re-tente --send-now.`,
      );
      continue;
    }

    const verified = result.value;
    if (!isTerminalSendStatus(verified.status)) {
      logFn(
        `⚠ GET-verify pós-sendNow ${c.key} (campanha #${c.campaignId}): status="${verified.status}" ` +
          `(esperado "sent"/"inProcess" após POST sendNow) — o 2xx do POST não é suficiente. ` +
          `${describeUncertainSendStatus(verified.status)} ` +
          `Status local NÃO atualizado — re-tente --send-now após checar o Brevo.`,
      );
      continue;
    }

    c.status = "sent";
    writeFn(campaignsPath, JSON.stringify(campaigns, null, 2));
    logFn(`✓ ${c.key} disparada AGORA (campanha #${c.campaignId}, GET-verify: status=${verified.status})`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }

  const groupArg = getArg(argv, "group") || undefined;
  const listIdArg = getArg(argv, "list-id") || undefined;
  if (!groupArg && !listIdArg) {
    console.error("--group NOME ou --list-id N é obrigatório (ver docstring do topo do arquivo).");
    process.exit(1);
  }
  if (groupArg && listIdArg) {
    console.error("--group e --list-id são mutuamente exclusivos — use um ou outro.");
    process.exit(1);
  }

  const segmentsDir = clariceSegmentsDir(cycle);
  let listId: number;
  let listNameHint: string | undefined;
  if (groupArg) {
    const listIndexRaw = getArg(argv, "list-index");
    const listIndex = listIndexRaw !== "" ? Number(listIndexRaw) : undefined;
    if (listIndex !== undefined && (!Number.isInteger(listIndex) || listIndex < 0)) {
      console.error(`--list-index inválido: "${listIndexRaw}" (esperado inteiro >= 0).`);
      process.exit(1);
    }
    const resolved = resolveGroupListId(segmentsDir, groupArg, listIndex);
    listId = resolved.listId;
    listNameHint = resolved.listName;
  } else {
    const n = Number(listIdArg);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`--list-id inválido: "${listIdArg}" (esperado inteiro > 0).`);
      process.exit(1);
    }
    listId = n;
  }

  const key = getArg(argv, "key") || groupArg || `list-${listId}`;

  const doCreate = hasFlag(argv, "create");
  const doUpdateHtml = hasFlag(argv, "update-html");
  const doTest = hasFlag(argv, "send-test");
  const doSchedule = hasFlag(argv, "schedule");
  const doSendNow = hasFlag(argv, "send-now"); // #4347 G7/D7
  const skipEiaGuard = hasFlag(argv, "skip-eia-guard");

  // #4347: --content-cycle é OPCIONAL — o ciclo do CONTEÚDO/edição mensal a
  // redistribuir pode DIVERGIR do --cycle de contatos/segments (ex: a skill
  // /diaria-clarice-novos resolve a edição mais recente PRONTA via
  // resolveLatestMonthlyCycle, que pode cair — D3 — num ciclo mensal anterior
  // ao ciclo Clarice corrente de cadastros novos). Sem a flag, comportamento
  // ORIGINAL preservado: content = segments = --cycle (todo caller pré-#4347
  // — ramp-warm/engajados/reativação/ramp — sempre usou o mesmo ciclo pros
  // dois papéis).
  const contentCycle = resolveContentCycle(argv, cycle);

  // HTML render: mesma fonte que clarice-schedule-sends.ts (Stage 4 já subiu
  // as imagens pro Cloudflare KV — nada de upload aqui, ver docstring do topo).
  const htmlPath = resolve(resolveMonthlyDir(contentCycle), "_internal", "cloudflare-preview.html");
  if (!existsSync(htmlPath)) throw new Error(`HTML render não existe: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");

  const campaignsPath = resolve(segmentsDir, "group-campaigns.json");
  let campaigns: CampaignEntry[] = [];
  if (existsSync(campaignsPath)) {
    try {
      campaigns = JSON.parse(readFileSync(campaignsPath, "utf8"));
    } catch (e) {
      throw new Error(`group-campaigns.json corrompido (JSON inválido): ${campaignsPath}\n${String(e)}`);
    }
  }
  const byKey = new Map(campaigns.map((c) => [c.key, c]));
  const existing = byKey.get(key);

  // --- Plano (sempre imprime) ---
  console.error(
    `\n📋 Campanha grupo — key='${key}'  listId=${listId}` +
      `${listNameHint ? `  (lista: "${listNameHint}")` : ""}` +
      `${existing ? `  [campanha #${existing.campaignId} ${existing.status}]` : "  [ainda não criada]"}`,
  );
  if (!doCreate && !doUpdateHtml && !doTest && !doSchedule && !doSendNow) {
    console.error(`\ndry-run — use --create, depois --send-test, depois --schedule (ou --send-now pra disparo imediato).`);
    return;
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const brevo = cfg.brevo_monthly;
  if (!brevo?.sender_email) throw new Error("brevo_monthly.sender_email ausente no platform.config.json");

  // --- create (rascunho ou reuso via --update-existing; idempotente por --key) ---
  if (doCreate) {
    if (existing) {
      // #3354: idempotência por --key só é segura se a lista não mudou —
      // senão a campanha real no Brevo fica presa na lista antiga pra
      // sempre (--schedule nunca re-toca recipients/listIds). Aborta em vez
      // de só avisar: blast radius é envio real pra audiência errada (P1).
      const mismatch = checkListIdMismatch(existing, listId);
      if (!mismatch.ok) {
        console.error(mismatch.message);
        process.exit(1);
      }
      console.error(`↷ ${key} já criada (#${existing.campaignId}) — pulando`);
    } else {
      const subject = parseSubjectArg(argv);
      if (!subject) throw new Error("--create requer --subject \"Assunto da campanha\".");
      // #3228: opcional (paridade com publish-monthly.ts, que sempre mandava
      // previewText) — sem a flag, omitido do body (Brevo aceita sem ele,
      // cai no snippet default derivado do próprio HTML).
      const previewText = getArg(argv, "preview-text") || undefined;
      // #4347 G7/D7: --schedule-at agora é OPCIONAL — --create sem ela cria o
      // rascunho SEM data (destinado a --send-now, disparo imediato). A
      // validação "no futuro" só se aplica quando a flag É passada — não
      // regride o guard existente pro caminho --schedule (D7 não mexe nele).
      const scheduleAtResolved = resolveScheduleAtArg(getArg(argv, "schedule-at") || undefined);
      if ("error" in scheduleAtResolved) throw new Error(scheduleAtResolved.error);
      const scheduledAt = scheduleAtResolved.scheduledAt;

      const updateExistingRaw = getArg(argv, "update-existing");
      let campaignId: number;
      if (updateExistingRaw) {
        const n = Number(updateExistingRaw);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--update-existing inválido: "${updateExistingRaw}"`);
        // Pre-check: campanha existe e não está em status terminal (mesmo guard de publish-monthly.ts).
        const prev = await brevoGetCampaign(apiKey, n);
        const TERMINAL_STATUSES = new Set(["sent", "archive"]);
        if (TERMINAL_STATUSES.has(prev.status)) {
          throw new Error(
            `campanha ${n} está em status "${prev.status}" e não pode ser reusada. ` +
              `Crie uma campanha nova (omitir --update-existing) ou use uma diferente.`,
          );
        }
        await brevoPut(apiKey, `/emailCampaigns/${n}`, {
          name: campaignNameFor(cycle, key),
          subject,
          ...(previewText ? { previewText } : {}),
          sender: { name: brevo.sender_name, email: brevo.sender_email },
          recipients: { listIds: [listId] },
          htmlContent: html,
        });
        campaignId = n;
        console.error(`✓ ${key} → campanha #${campaignId} reusada (--update-existing)`);
      } else {
        const resp = (await brevoPost(apiKey, "/emailCampaigns", {
          name: campaignNameFor(cycle, key),
          subject,
          ...(previewText ? { previewText } : {}),
          sender: { name: brevo.sender_name, email: brevo.sender_email },
          recipients: { listIds: [listId] },
          htmlContent: html,
        })) as { id?: number };
        if (typeof resp?.id !== "number") throw new Error(`/emailCampaigns shape inesperado: ${JSON.stringify(resp)}`);
        campaignId = resp.id;
        console.error(`✓ ${key} → campanha #${campaignId} (rascunho)`);
      }

      const c: CampaignEntry = { key, campaignId, listId, subject, scheduledAt, status: "draft" };
      campaigns.push(c);
      byKey.set(key, c);
      // #3228: segmentsDir já existe no fluxo --group (criado por
      // clarice-build-segment.ts antes de escrever {group}-manifest.json —
      // pré-condição pra resolveGroupListId ter chegado até aqui), mas no
      // fluxo --list-id direto pode ser a 1ª escrita neste ciclo/segments/
      // (ex: cycle nunca passou por clarice-build-segment.ts). writeFileAtomic
      // não cria diretórios faltantes (documentado em lib/atomic-write.ts) —
      // sem ensureDir aqui, --create com --list-id puro falharia com ENOENT.
      ensureDir(segmentsDir);
      writeFileAtomic(campaignsPath, JSON.stringify(campaigns, null, 2));
    }
  }

  // --- update-html (propaga fix de render pra campanha em draft) ---
  if (doUpdateHtml) {
    const c = byKey.get(key);
    if (!c) throw new Error(`campanha '${key}' não criada — rode --create antes.`);
    if (c.status === "scheduled" || c.status === "sent") {
      console.error(`⚠️  ${key} já ${c.status === "sent" ? "disparada" : "agendada"} — html NÃO atualizado`);
    } else {
      await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { htmlContent: html });
      console.error(`✓ ${key} html atualizado (campanha #${c.campaignId})`);
    }
  }

  // --- send-test ---
  if (doTest) {
    const c = byKey.get(key);
    if (!c) throw new Error(`campanha '${key}' não criada — rode --create antes.`);
    await brevoPost(apiKey, `/emailCampaigns/${c.campaignId}/sendTest`, { emailTo: [brevo.test_email] });
    console.error(`✓ test email ${key} (campanha #${c.campaignId}) → ${brevo.test_email}`);
  }

  // --- schedule (PUT scheduledAt + GET-verify) ---
  if (doSchedule) {
    // #2009/#3228: mesmo guard de gabarito É IA? do pipeline canônico.
    const eiaCheck = checkEiaGuard(contentCycle, skipEiaGuard, undefined);
    if (!eiaCheck.ok) {
      console.error(eiaCheck.message);
      process.exit(1);
    }
    console.error(skipEiaGuard ? `⚠  --skip-eia-guard ativo — verificação de gabarito É IA? ignorada.` : `✓ Gabarito É IA? verificado`);

    const c = byKey.get(key);
    if (!c) throw new Error(`campanha '${key}' não criada — rode --create antes.`);
    if (c.status === "scheduled" || c.status === "sent") {
      console.error(`↷ ${key} já ${c.status === "sent" ? "disparada" : "agendada"} — pulando`);
    } else if (!c.scheduledAt) {
      throw new Error(
        `--schedule: ${key} (campanha #${c.campaignId}) foi criada SEM --schedule-at — não tem data alvo pra agendar. ` +
          `Recrie com --create --schedule-at <ISO>, ou use --send-now pra disparo imediato.`,
      );
    } else {
      if (new Date(c.scheduledAt) <= new Date()) {
        throw new Error(
          `--schedule: ${key} (campanha #${c.campaignId}) tem scheduledAt no passado/presente ` +
            `(${c.scheduledAt}). Atualize o group-campaigns.json ou recrie com --create --schedule-at novo.`,
        );
      }
      await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { scheduledAt: c.scheduledAt });
      const verifySettled = await Promise.allSettled([brevoGetCampaign(apiKey, c.campaignId)]);
      // Cast de shape — ver docstring de `CampaignEntry`/`ScheduleSendsShape`
      // no topo do arquivo: mesmos objetos por REFERÊNCIA, só o tipo estático
      // diverge (scheduledAt já foi confirmado string neste ponto do branch).
      applyVerifyResults(
        verifySettled,
        [c as unknown as ScheduleSendsShape],
        campaigns as unknown as ScheduleSendsShape[],
        campaignsPath,
      );
    }
  }

  // --- send-now (POST sendNow + GET-verify) — #4347 G7/D7: disparo
  // IMEDIATO, sem agendamento. Mesmo guard É IA? do --schedule (o gate
  // editorial independe de "quando" o envio dispara).
  if (doSendNow) {
    const eiaCheck = checkEiaGuard(contentCycle, skipEiaGuard, undefined);
    if (!eiaCheck.ok) {
      console.error(eiaCheck.message);
      process.exit(1);
    }
    console.error(skipEiaGuard ? `⚠  --skip-eia-guard ativo — verificação de gabarito É IA? ignorada.` : `✓ Gabarito É IA? verificado`);

    const c = byKey.get(key);
    if (!c) throw new Error(`campanha '${key}' não criada — rode --create antes.`);
    if (c.status === "sent") {
      console.error(`↷ ${key} já disparada — pulando (idempotente)`);
    } else if (c.status === "scheduled") {
      throw new Error(`--send-now: ${key} (campanha #${c.campaignId}) já está AGENDADA — não faz sentido disparar imediato também. Desagende antes ou não use --send-now nesta campanha.`);
    } else {
      await brevoSendNow(apiKey, c.campaignId);
      // #4347: NUNCA confiar só no 2xx do POST — GET-verify pós-disparo
      // confirmando status terminal antes de declarar sucesso (mesmo
      // racional de applyVerifyResults pro --schedule).
      const verifySettled = await Promise.allSettled([brevoGetCampaign(apiKey, c.campaignId)]);
      applySendNowVerifyResults(verifySettled, [c], campaigns, campaignsPath);
      // #4347: sem gate humano (D6), a skill /diaria-clarice-novos precisa de
      // um sinal MÁQUINA-VERIFICÁVEL de "disparo não confirmado" — não só o
      // texto de warning que applySendNowVerifyResults já loga. process.exitCode
      // (não process.exit — deixa o JSON de resumo abaixo imprimir normalmente,
      // útil pro diagnóstico) sinaliza a um caller automatizado que este
      // --send-now NÃO deve ser tratado como sucesso, mesmo com stdout válido.
      // Cast: TS estreitou c.status pra "draft" neste branch (os `if`s acima
      // já excluíram "sent"/"scheduled") e não enxerga que
      // applySendNowVerifyResults pode MUTAR c.status pra "sent" por
      // referência — sem o cast, a comparação vira "sempre true" pro
      // typechecker, mascarando o próprio propósito do guard.
      if ((c.status as CampaignEntry["status"]) !== "sent") {
        console.error(`❌ ${key}: sendNow disparado mas GET-verify não confirmou status terminal — NÃO declare sucesso. Re-tente --send-now.`);
        process.exitCode = 2;
      }
    }
  }

  console.log(
    JSON.stringify(
      buildInvocationSummary(
        key,
        listId,
        { create: doCreate, updateHtml: doUpdateHtml, sendTest: doTest, schedule: doSchedule, sendNow: doSendNow },
        byKey.get(key),
        campaigns,
      ),
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
