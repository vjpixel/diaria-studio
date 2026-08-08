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
 *                      Pula (idempotente) se a campanha JÁ está scheduled/sent
 *                      — pra CORRIGIR o horário de uma campanha já agendada,
 *                      use --reschedule (abaixo), nunca PUT manual na API.
 *   --reschedule       #4668: REAGENDA uma campanha que já está `scheduled`
 *                      (corrige `scheduledAt`, nunca toca recipients/HTML).
 *                      Requer `--schedule-at <ISO com hora>` (o novo alvo) e o
 *                      mesmo gabarito É IA? do --schedule. Guards, nesta ordem:
 *                        1. recusa se o registro LOCAL nunca foi agendado
 *                           (status "draft" — use --schedule) ou já foi
 *                           disparado (status "sent" — terminal).
 *                        2. GET ao vivo na Brevo ANTES do PUT: se o status
 *                           real não for "queued"/"scheduled" (ex: entrou em
 *                           "in_review", ou já disparou entre invocações),
 *                           recusa mesmo que o registro local diga "scheduled"
 *                           — o local pode estar defasado.
 *                        3. PUT do novo `scheduledAt`, depois GET-verify
 *                           comparando por INSTANTE (`Date.parse`), nunca por
 *                           string — a Brevo devolve `scheduledAt` com OFFSET
 *                           (ex: "...-03:00"), não com "Z", e dois valores do
 *                           MESMO instante têm strings diferentes.
 *                        4. `group-campaigns.json` só é gravado DEPOIS do
 *                           GET-verify confirmar o novo horário — nunca antes.
 *                      ⚠️  Incerteza documentada, não confirmada ao vivo: não
 *                      se sabe se a Brevo RE-CONGELA o snapshot de
 *                      destinatários no reagendamento (a memória do projeto —
 *                      `brevo-recipients-snapshot` — só cobre o AGENDAMENTO
 *                      inicial). Se re-congelar, uma mudança de lista feita
 *                      entre o agendamento original e o reagendamento passaria
 *                      a valer — se NÃO re-congelar, o snapshot antigo
 *                      permanece. Confirmar ao vivo e documentar aqui quando
 *                      alguém rodar `--reschedule` de verdade pela 1ª vez.
 *   --send-now         #4347 G7/D7: dispara a campanha IMEDIATAMENTE (POST
 *                      /emailCampaigns/{id}/sendNow) — sem agendamento, sem
 *                      trava de janela. Mesmo guard É IA? do --schedule.
 *                      GET-verify pós-disparo (com retry+backoff curto,
 *                      #4718 item 1 — "queued" costuma resolver em segundos)
 *                      confirma status terminal ("sent"/"inProcess") antes
 *                      de marcar sucesso — nunca confia só no 2xx do POST.
 *                      Idempotente por estado AO VIVO da Brevo (#4718 —
 *                      GET antes de qualquer POST via `checkSendNowGuard`),
 *                      NÃO só pelo registro local: campanha já
 *                      `"sent"`/`"inProcess"`/`"queued"` na Brevo nunca leva
 *                      a um novo POST, mesmo que o registro local (que pode
 *                      ficar defasado justo quando o GET-verify anterior
 *                      pegou a campanha em "queued") ainda diga "draft".
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
 *                      mesmo ciclo), a resolução é por `--key` (#4576 —
 *                      cada entrada do registro carrega o `wave.key` que a
 *                      gerou): sem match e sem `--list-index` explícito,
 *                      ABORTA em vez de cair silenciosamente na última (era
 *                      o bug do #4576 — um teste A/B/C com 3 listas/3 keys
 *                      resolvia sempre a célula C, mesmo pra `--key`
 *                      A ou B). Registros gravados ANTES do #4576 (sem `key`
 *                      em nenhuma entrada) continuam resolvendo pelo
 *                      comportamento antigo — default = última. `--list-index N`
 *                      (0-based) sempre escolhe explicitamente, ignorando `--key`.
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
 * Corrigir o horário de uma campanha JÁ agendada (#4668 — nunca PUT manual):
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --group ramp-warm \
 *     --schedule-at 2026-07-15T13:00:00Z --reschedule
 *
 * Uso típico (via --list-id direto, ex: 3 listas do mesmo grupo no mesmo ciclo):
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --list-id 69 --key ramp-warm-1 \
 *     --subject "Assunto A" --schedule-at 2026-07-15T09:00:00Z --create
 *   npx tsx scripts/clarice-schedule-group.ts --cycle 2606-07 --list-id 70 --key ramp-warm-2 \
 *     --subject "Assunto A" --schedule-at 2026-07-16T09:00:00Z --create
 *
 * Estado em {ciclo}/segments/group-campaigns.json (idempotência: --create
 * pula campanhas já criadas pra a mesma --key; --schedule usa os IDs
 * gravados; --reschedule sobrescreve `scheduledAt` da mesma entrada só após
 * GET-verify confirmar, #4668) — irmão de campaigns-summary.json (rampa) e
 * {group}-lists.json (registro de listas, #3228), todos em segments/.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoPut, brevoGetCampaign, brevoSendNow, isTerminalSendStatus, describeUncertainSendStatus, pollTerminalSendStatus } from "./lib/brevo-client.ts";
import { clariceSegmentsDir, ensureDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "./lib/mensal/monthly-paths.ts";
import { checkEiaGuard, applyVerifyResults, isScheduledStatus } from "./clarice-schedule-sends.ts";
// #4662: fonte única do horário canônico de envio (09:00 UTC = 06:00 BRT) —
// usada só pra COMPOR a sugestão no erro de --schedule-at só-data (nunca
// duplicar "09:00:00Z" aqui) e pra validar calendário (2026-02-31 etc).
import { scheduledAtForDate } from "./lib/clarice-wave-plan.ts";
import { groupListsRegistryPath, type GroupListEntry } from "./clarice-import-waves.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

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
 * `{ciclo}/segments/{group}-lists.json`).
 *
 * `index` (0-based), quando informado (`--list-index`), sempre vence —
 * escolhe a entrada explicitamente, ignorando `key`.
 *
 * Sem `index`:
 *   - registro com 1 única lista → resolve ela direto, sem checar `key`
 *     (não há ambiguidade a resolver).
 *   - registro com >1 lista → casa por `key` (#4576 — cada entrada nova
 *     carrega o `wave.key` que a gerou, ver `GroupListEntry`). SEM match →
 *     ABORTA em vez de cair silenciosamente na última: era exatamente o bug
 *     do #4576 — um teste A/B/C com 3 listas/3 keys resolvia sempre a
 *     última (célula C), mesmo pra `--key` da célula A ou B, fazendo as 3
 *     campanhas apontarem pro mesmo público. Se MAIS DE UMA entrada casa
 *     com a mesma `key` (grupos sem célula, ex: `ramp-warm`/`engajados` —
 *     `clarice-build-segment.ts` grava `wave.key === group` em toda
 *     re-execução do mesmo grupo, então re-rodar com budgets diferentes
 *     produz várias entradas com a MESMA key), resolve a ÚLTIMA dentre as
 *     que casaram — preserva o "default = mais recente" que já era correto
 *     pra esse caso (cenário real 260710: 3 budgets do mesmo grupo,
 *     #69/#70/#71). EXCEÇÃO retroativa: se NENHUMA entrada do registro
 *     carrega `key` (registro gravado antes do #4576), preserva o
 *     comportamento antigo — default = última — pra não quebrar leitura de
 *     registros já gravados em produção.
 */
export function resolveGroupListId(
  segmentsDir: string,
  group: string,
  key: string,
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

  // --list-index explícito sempre vence (override manual) — ignora `key`.
  if (index !== undefined) {
    const entry = lists[index];
    if (!entry) {
      throw new Error(
        `--list-index ${index} fora do range (grupo '${group}' tem ${lists.length} lista(s), 0..${lists.length - 1}).`,
      );
    }
    return { listId: entry.listId, listName: entry.listName };
  }

  // 1 única lista: sem ambiguidade, resolve ela — `key` não importa aqui.
  if (lists.length === 1) {
    return { listId: lists[0].listId, listName: lists[0].listName };
  }

  // #4576: >1 lista, sem --list-index — só é seguro resolver por `key`.
  // Compat retroativa: se o registro é do formato ANTIGO (nenhuma entrada
  // carrega `key`), preserva o comportamento pré-#4576 (default = última).
  const hasKeyField = lists.some((e) => typeof e.key === "string" && e.key.length > 0);
  if (!hasKeyField) {
    const entry = lists[lists.length - 1];
    return { listId: entry.listId, listName: entry.listName };
  }

  // #4576 (self-review): grupos SEM célula (ramp-warm, engajados, ...) usam
  // `wave.key === group` pra TODA lista importada — clarice-build-segment.ts
  // não varia o key entre re-runs do mesmo grupo com budgets diferentes (só
  // o A/B/C varia, via sufixo -A/-B/-C). Isso significa que o caso "múltiplas
  // listas do MESMO grupo não-célula" (cenário real 260710: 3 budgets,
  // #69/#70/#71) tem as 3 entradas com a MESMA `key` — `find` pegaria a
  // PRIMEIRA (mais antiga), regredindo o "default = última" que era correto
  // aí. `filter` + pegar a ÚLTIMA ocorrência preserva os dois casos: A/B/C
  // (cada key aparece 1x → filter devolve 1 match) e grupo não-célula
  // re-rodado (todas as entradas compartilham a mesma key → filter devolve
  // todas, e a última é a mais recente — igual ao comportamento pré-#4576).
  // #4753 (achado do fleet review da PR #4758): quando `--key` é OMITIDO, o
  // caller cai em `key = group` (o nome do grupo). Antes do #4753 isso era um
  // acidente feliz — TODA entrada de grupo sem célula tinha `key === group`,
  // então o filtro casava todas e "última vence" acertava a mais recente.
  //
  // Depois do #4753, só as entradas LEGADAS carregam o nome do grupo como key;
  // as novas carregam key de campanha. Então o mesmo default passa a casar
  // apenas as ANTIGAS e resolve uma lista obsoleta EM SILÊNCIO — campanha
  // criada contra a lista errada, sem erro nenhum. O bug que o #4753 corrigiu
  // falhava alto; este caminho residual falharia calado, que é pior.
  //
  // Registro MISTO + key == nome do grupo é exatamente a assinatura de "--key
  // não foi passado num registro que já tem key de campanha". Aborta.
  const outrasKeys = [...new Set(lists.map((e) => e.key).filter((k) => k && k !== group))];
  if (key === group && outrasKeys.length > 0) {
    throw new Error(
      `registro do grupo '${group}' tem lista(s) com key de campanha (${outrasKeys.join(", ")}), ` +
        `mas nenhuma --key foi informada — o default cairia numa entrada legada e resolveria a lista ERRADA em silêncio. ` +
        `Passe --key correspondente à campanha desta rodada, ou --list-index N (0..${lists.length - 1}) pra escolher explicitamente.`,
    );
  }

  const matches = lists.filter((e) => e.key === key);
  if (matches.length === 0) {
    throw new Error(
      `--key '${key}' não corresponde a nenhuma lista registrada pro grupo '${group}' ` +
        `(${lists.length} listas — keys conhecidas: ${lists.map((e) => e.key ?? "(sem key)").join(", ")}).\n` +
        `   Passe --key correspondente a uma das listas acima, ou --list-index N ` +
        `(0..${lists.length - 1}) pra escolher explicitamente.`,
    );
  }
  const matched = matches[matches.length - 1];
  return { listId: matched.listId, listName: matched.listName };
}

/** Nome determinístico da campanha. Ex: "Clarice 2606 grupo:ramp-warm". */
export function campaignNameFor(cycle: string, key: string): string {
  return `Clarice ${cycleToYymm(cycle)} grupo:${key}`;
}

/**
 * #4449 item 3 / #4471: `groupCellListNameFor` (gerador determinístico do
 * nome de LISTA pro braço COM CÉLULA do fluxo `--group`) MOROU aqui, mas
 * nunca foi ligada ao ponto real de criação da lista — quem de fato cria a
 * lista Brevo do fluxo `--group` é `clarice-import-waves.ts` (`buildPlan`),
 * não este script (que só cria CAMPANHAS apontando pra uma lista já
 * existente). Movida pra lá (#4471), junto de `listNameFor` e
 * `resolveListName` — que decide entre os dois formatos — e agora
 * efetivamente usada por `buildPlan`. Re-exportada aqui só por
 * compatibilidade com quem já importava deste arquivo.
 */
export { groupCellListNameFor } from "./clarice-import-waves.ts";

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
 * #4576 — resolve `--list-index` via `getIntArg` em vez do `getArg(...) +
 * Number(...)` anterior, que colapsava "--list-index" SEM valor (fim do
 * argv, ou seguido de outra `--flag`) em `""` → `Number("") = 0` →
 * `undefined` só quando string vazia era tratada à parte — na prática o
 * bug caiu justo nessa flag: `--list-index` sem valor virava `undefined` e
 * o default silencioso (última lista) tomava conta, exatamente o caso que
 * `--list-index` existe pra evitar (mesma classe do #4542/#4568). Pura/
 * testável: mesmo padrão de `resolveScheduleAtArg` abaixo — extrai a
 * validação inline de `main()` pra permitir testar sem mockar `process.exit`.
 */
export function resolveListIndexArg(argv: string[]): { listIndex: number | undefined } | { error: string } {
  try {
    return { listIndex: getIntArg(argv, "list-index", { min: 0 }) };
  } catch (e) {
    return { error: (e as Error).message };
  }
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

/** Regex de data ISO simples (YYYY-MM-DD) — mesmo formato de ISO_DATE_RE em clarice-wave-plan.ts. */
const ONLY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 8601 completo, sufixado em "Z" OU offset explícito ("+HH:MM"/"-HH:MM")
 * — #4680 (achado 2 do silent-failure-hunter): a versão original só casava
 * "Z" (convenção interna deste projeto), mas o editor digitando um horário
 * BRT com offset explícito ("...T09:00:00-03:00") é a forma NATURAL de
 * escrever — e o `Date` do JS faz o MESMO rollover silencioso de calendário
 * (2026-02-31 vira 2026-03-03) independente de offset. Captura h/m/s
 * separadamente do offset porque o round-trip abaixo usa `Date.UTC` com os
 * componentes CRUS (não `d.toISOString()`, que já aplicou o offset e
 * mudaria de dia em horários próximos da virada — ex: 23:00-03:00 vira
 * 02:00Z do dia seguinte mesmo sendo uma data válida).
 */
const FULL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function resolveScheduleAtArg(
  raw: string | undefined,
  now: Date = new Date(),
): { scheduledAt: string | undefined } | { error: string } {
  if (!raw) return { scheduledAt: undefined };

  // #4662 (incidente 260805, campanha #119): "YYYY-MM-DD" sem hora era
  // interpretado pelo `Date` do JS como MEIA-NOITE UTC (21:00 BRT do dia
  // ANTERIOR) — nenhuma onda deste projeto sai nesse horário, e a campanha
  // ficou agendada 9h adiantada. Alternativa conservadora escolhida na
  // issue: abortar com erro claro (guard determinístico, nunca warning) em
  // vez de "adivinhar" um horário em silêncio — quem quer o canônico digita
  // a hora explícita. `scheduledAtForDate` também é a fonte que valida o
  // calendário (2026-02-31 etc.) — se `raw` for uma data inexistente, o erro
  // sai daqui, sem duplicar a lógica de round-trip.
  if (ONLY_DATE_RE.test(raw)) {
    let suggestion: string;
    try {
      suggestion = scheduledAtForDate(raw);
    } catch (e) {
      return { error: `--schedule-at: ${(e as Error).message}` };
    }
    return {
      error:
        `--schedule-at "${raw}" não tem hora — seria interpretado como meia-noite UTC ` +
        `(21:00 BRT do dia anterior), o que quase causou um envio 9h adiantado (incidente #4662). ` +
        `Informe a hora explícita: "${suggestion}" pro horário canônico da Clarice News ` +
        `(09:00 UTC = 06:00 BRT), ou outro horário ISO 8601 com "Z"/offset se for intencional.`,
    };
  }

  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { error: `--schedule-at não é ISO 8601 válido: "${raw}"` };
  }

  // #4662/#4680: mesmo com hora explícita, o `Date` do JS "conserta" em
  // silêncio um dia de calendário inexistente (2026-02-31 vira 2026-03-03)
  // — mesma técnica de round-trip de `scheduledAtForDate`
  // (clarice-wave-plan.ts). Cobre tanto "Z" quanto offset explícito
  // (+HH:MM/-HH:MM) — ver docstring de `FULL_ISO_RE`. O round-trip usa
  // `Date.UTC` com os componentes CRUS do input (não `d.toISOString()`),
  // porque a conversão de offset pra UTC pode mudar de dia mesmo em datas
  // válidas (ex: 23:00-03:00 vira 02:00Z do dia seguinte).
  const isoMatch = FULL_ISO_RE.exec(raw);
  if (isoMatch) {
    const [, y, mo, day, hh, mm, ss] = isoMatch;
    const roundTrip = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(day), Number(hh), Number(mm), Number(ss || 0)),
    );
    const back =
      `${roundTrip.getUTCFullYear()}-${String(roundTrip.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(roundTrip.getUTCDate()).padStart(2, "0")}`;
    if (back !== `${y}-${mo}-${day}`) {
      return { error: `--schedule-at "${raw}" é uma data inexistente no calendário.` };
    }
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
  /**
   * #4680 (achado 2 do silent-failure-hunter sobre #4662/#4668/#4663): o
   * `scheduledAt` atual da campanha desta invocação — permite ao caller
   * (e ao teste) confirmar o horário sem re-consultar a Brevo. Sempre
   * incluído quando a campanha existe, não só na fase reschedule — o
   * campo é barato e útil em qualquer fase que toque agendamento.
   */
  scheduledAt?: string | null;
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
  flags: { create: boolean; updateHtml: boolean; sendTest: boolean; schedule: boolean; sendNow?: boolean; reschedule?: boolean },
  campaign: CampaignEntry | undefined,
  allCampaigns: CampaignEntry[],
): InvocationSummary {
  const phase = [
    flags.create && "create",
    flags.updateHtml && "update-html",
    flags.sendTest && "send-test",
    flags.schedule && "schedule",
    flags.sendNow && "send-now",
    flags.reschedule && "reschedule",
  ]
    .filter((p): p is string => typeof p === "string")
    .join("+");
  return {
    key,
    listId,
    campaignId: campaign?.campaignId,
    phase,
    status: campaign?.status,
    scheduledAt: campaign?.scheduledAt ?? null,
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
      // #4718 (item 3): "queued" tem encerramento próprio — não é incerteza,
      // é progresso (a Brevo já aceitou o disparo). Repetir "re-tente
      // --send-now" pra esse caso especificamente era a instrução que levou
      // ao 2º POST sendNow no incidente de origem — para os demais status
      // (in_review, draft residual, etc.) o retry continua sendo a
      // orientação certa, agora protegido pelo guard ao vivo em `main()`.
      const followUp =
        verified.status === "queued"
          ? `Status local NÃO atualizado — reconsulte a Brevo em instantes, NÃO re-dispare.`
          : `Status local NÃO atualizado — re-tente --send-now após checar o Brevo.`;
      logFn(
        `⚠ GET-verify pós-sendNow ${c.key} (campanha #${c.campaignId}): status="${verified.status}" ` +
          `(esperado "sent"/"inProcess" após POST sendNow) — o 2xx do POST não é suficiente. ` +
          `${describeUncertainSendStatus(verified.status)} ` +
          `${followUp}`,
      );
      continue;
    }

    c.status = "sent";
    writeFn(campaignsPath, JSON.stringify(campaigns, null, 2));
    logFn(`✓ ${c.key} disparada AGORA (campanha #${c.campaignId}, GET-verify: status=${verified.status})`);
  }
}

/**
 * #4718 — decide se um POST `sendNow` pode ser emitido, dado o status LOCAL
 * (`CampaignEntry.status`, sempre "draft"/"scheduled"/"sent") e o status AO
 * VIVO da Brevo (string livre — inclui "queued"/"inProcess"/"in_review", que
 * o tipo local não expressa). Pura/testável, mesmo padrão de
 * `checkRescheduleAllowed` abaixo.
 *
 * Causa raiz do bug original: o guard de idempotência só olhava
 * `c.status === "sent"` — campo que `applySendNowVerifyResults` só grava
 * quando o GET-verify pós-`sendNow` confirma status TERMINAL (#4347). Se
 * esse GET pegar a campanha em `"queued"` (disparo ACEITO pela Brevo, ainda
 * processando a fila — não é falha), a entrada local fica presa em "draft"
 * PARA SEMPRE mesmo com o disparo real já em curso — e a mensagem de erro
 * da invocação anterior instruía "re-tente --send-now", levando direto a um
 * 2º POST na mesma campanha (incidente ao vivo 260806, campanha #121: o 1º
 * disparo funcionou desde o início — 88 entregues, 0 bounce — mas o
 * registro local nunca soube).
 *
 * `"queued"`/`"inProcess"`/`"sent"` AO VIVO → NUNCA emitir POST, mesmo que o
 * local diga "draft"/"scheduled"-nunca-chega-aqui (o `--send-now` guard
 * anterior já barra "scheduled" antes de chamar esta função). `syncLocalAsSent`
 * sinaliza quando vale corrigir o registro local NESTA invocação — só quando
 * o status AO VIVO já é TERMINAL; "queued" ainda pode virar outra coisa (ex:
 * "in_review"), então não persiste sucesso ainda, só recusa o reenvio.
 */
export function checkSendNowGuard(
  localStatus: CampaignEntry["status"],
  liveStatus: string,
): { send: true } | { send: false; reason: string; syncLocalAsSent: boolean } {
  if (localStatus === "sent") {
    return { send: false, reason: `já disparada (registro local)`, syncLocalAsSent: false };
  }
  if (isTerminalSendStatus(liveStatus)) {
    return {
      send: false,
      reason: `já disparada na Brevo — status ao vivo="${liveStatus}" (registro local dizia "${localStatus}", estava defasado)`,
      syncLocalAsSent: true,
    };
  }
  if (liveStatus === "queued") {
    return {
      send: false,
      reason: `disparo já ACEITO e na fila da Brevo (status ao vivo="queued") — NÃO re-dispare, só reconsulte em instantes`,
      syncLocalAsSent: false,
    };
  }
  return { send: true };
}

/**
 * #4668 — decide se uma campanha pode ser REAGENDADA, dado o status LOCAL
 * (`CampaignEntry.status`, sempre "draft"/"scheduled"/"sent") e o status AO
 * VIVO da Brevo (string livre — inclui "in_review"/"queued", que o tipo
 * local não expressa). Pura/testável: extrai a decisão de `main()` pra provar
 * os casos terminais (local "sent", ao-vivo "in_review") sem mockar HTTP.
 *
 * Terminal ao vivo vence sobre o local: o registro local pode estar
 * defasado (campanha entrou em revisão da Brevo, ou disparou entre
 * invocações) — só o GET recém-feito é confiável pra essa decisão.
 */
export function checkRescheduleAllowed(
  localStatus: CampaignEntry["status"],
  liveStatus: string,
): { ok: true } | { ok: false; reason: string } {
  if (localStatus === "draft") {
    return { ok: false, reason: "nunca foi agendada (registro local) — use --schedule (não --reschedule) pra agendar pela primeira vez." };
  }
  if (localStatus === "sent") {
    return { ok: false, reason: "já foi DISPARADA (registro local) — status terminal, não pode ser reagendada." };
  }
  if (!isScheduledStatus(liveStatus)) {
    const terminal = isTerminalSendStatus(liveStatus) || liveStatus === "in_review";
    return {
      ok: false,
      reason:
        `está em status "${liveStatus}" na Brevo (esperado "queued"/"scheduled") — ` +
        (terminal
          ? "status terminal AO VIVO, não pode ser reagendada (o registro local pode estar defasado)."
          : "recuse e investigue antes de reagendar."),
    };
  }
  return { ok: true };
}

/**
 * #4668 — compara dois `scheduledAt` por INSTANTE (`Date.parse`), nunca por
 * igualdade de string. A Brevo devolve `scheduledAt` com OFFSET (ex:
 * "2026-08-06T06:00:00.000-03:00"), não com "Z" — dois valores que
 * representam o MESMO instante têm strings diferentes, e comparação por
 * string dá falso negativo num reagendamento que na verdade funcionou
 * (aconteceu ao vivo na 1ª verificação do fix do #4662).
 */
export function isSameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  return Number.isFinite(ma) && Number.isFinite(mb) && ma === mb;
}

/**
 * #4668 — aplica o resultado do GET-verify pós-PUT de `--reschedule`.
 * Mesmo padrão de `applySendNowVerifyResults`: só persiste em disco (e só
 * marca sucesso) quando (a) o GET não rejeitou, (b) o status devolvido é
 * "queued"/"scheduled" E (c) o `scheduledAt` devolvido bate por INSTANTE
 * (`isSameInstant`, nunca string) com o alvo desta invocação. Qualquer um
 * dos três falhando: warn, `c.scheduledAt`/`c.status` NÃO mudam, e a
 * próxima invocação de `--reschedule` re-tenta (nada fica "meio aplicado").
 */
export function applyRescheduleVerifyResults(
  settled: PromiseSettledResult<{ status: string; scheduledAt?: string | null }>[],
  toVerify: CampaignEntry[],
  newScheduledAts: string[],
  campaigns: CampaignEntry[],
  campaignsPath: string,
  writeFn: (path: string, content: string) => void = (p, c) => writeFileAtomic(p, c),
  logFn: (msg: string) => void = (m) => console.error(m),
): void {
  if (settled.length !== toVerify.length || toVerify.length !== newScheduledAts.length) {
    throw new Error(
      `applyRescheduleVerifyResults: invariante quebrada — settled.length (${settled.length}), ` +
        `toVerify.length (${toVerify.length}), newScheduledAts.length (${newScheduledAts.length}) devem ser iguais.`,
    );
  }
  for (let i = 0; i < toVerify.length; i++) {
    const c = toVerify[i];
    const result = settled[i];
    const target = newScheduledAts[i];
    const previous = c.scheduledAt;

    if (result.status === "rejected") {
      logFn(
        `⚠ GET-verify pós-reschedule ${c.key} (campanha #${c.campaignId}) falhou: ${String(result.reason)}. ` +
          `Status local NÃO atualizado — re-tente --reschedule.`,
      );
      continue;
    }

    const verified = result.value;
    if (!isScheduledStatus(verified.status)) {
      logFn(
        `⚠ GET-verify pós-reschedule ${c.key} (campanha #${c.campaignId}): status="${verified.status}" ` +
          `(esperado "queued"/"scheduled" após PUT scheduledAt="${target}"). ` +
          `Status local NÃO atualizado — re-tente --reschedule após checar o Brevo.`,
      );
      continue;
    }
    if (!isSameInstant(verified.scheduledAt, target)) {
      logFn(
        `⚠ GET-verify pós-reschedule ${c.key} (campanha #${c.campaignId}): scheduledAt devolvido ` +
          `("${verified.scheduledAt ?? "ausente"}") NÃO confere com o alvo ("${target}") — comparação por ` +
          `INSTANTE (Date.parse), não string (a Brevo pode responder com offset em vez de "Z"). ` +
          `Status local NÃO atualizado — re-tente --reschedule.`,
      );
      continue;
    }

    c.scheduledAt = target;
    c.status = "scheduled";
    writeFn(campaignsPath, JSON.stringify(campaigns, null, 2));
    logFn(`✓ ${c.key} REAGENDADA: ${previous ?? "(sem data anterior)"} → ${target} (GET-verify: status=${verified.status})`);
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

  // #4576: `--key` precisa ser resolvida ANTES do listId no braço `--group`
  // — é ela quem desambigua QUAL lista, quando o registro tem mais de uma
  // (ver resolveGroupListId). No braço `--list-id`, key continua dependendo
  // do listId resolvido (fallback `list-{listId}`, comportamento inalterado).
  const keyArg = getArg(argv, "key") || undefined;

  const segmentsDir = clariceSegmentsDir(cycle);
  let listId: number;
  let listNameHint: string | undefined;
  let key: string;
  if (groupArg) {
    const listIndexResolved = resolveListIndexArg(argv);
    if ("error" in listIndexResolved) {
      console.error(`❌ ${listIndexResolved.error}`);
      process.exit(1);
    }
    key = keyArg || groupArg;
    const resolved = resolveGroupListId(segmentsDir, groupArg, key, listIndexResolved.listIndex);
    listId = resolved.listId;
    listNameHint = resolved.listName;
  } else {
    const n = Number(listIdArg);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`--list-id inválido: "${listIdArg}" (esperado inteiro > 0).`);
      process.exit(1);
    }
    listId = n;
    key = keyArg || `list-${listId}`;
  }

  const doCreate = hasFlag(argv, "create");
  const doUpdateHtml = hasFlag(argv, "update-html");
  const doTest = hasFlag(argv, "send-test");
  const doSchedule = hasFlag(argv, "schedule");
  const doSendNow = hasFlag(argv, "send-now"); // #4347 G7/D7
  const doReschedule = hasFlag(argv, "reschedule"); // #4668
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
  if (!doCreate && !doUpdateHtml && !doTest && !doSchedule && !doSendNow && !doReschedule) {
    console.error(`\ndry-run — use --create, depois --send-test, depois --schedule (ou --send-now pra disparo imediato; --reschedule pra corrigir uma campanha já agendada).`);
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
      // #4718 (item 2 — o que fecha o buraco): idempotência por estado AO
      // VIVO, não local. O registro local pode estar defasado exatamente
      // pelo motivo que este guard cobre — ver docstring de
      // `checkSendNowGuard` acima. Sem esta consulta, a orientação de retry
      // da mensagem de erro anterior levava direto a um 2º POST sendNow na
      // mesma campanha (incidente ao vivo 260806, campanha #121).
      const live = await brevoGetCampaign(apiKey, c.campaignId);
      const guard = checkSendNowGuard(c.status, live.status);
      if (!guard.send) {
        console.error(`↷ ${key} (campanha #${c.campaignId}): ${guard.reason} — sem novo POST sendNow.`);
        // #4718: `c.status` só chega até aqui como "draft" (os `if`s acima já
        // excluíram "sent"/"scheduled") — `guard.syncLocalAsSent` sozinho já
        // basta pra decidir se vale corrigir o registro local, sem checar
        // `c.status !== "sent"` de novo (redundante e o TS estreita o tipo
        // pra "draft" aqui, marcando essa comparação como sempre-verdadeira).
        if (guard.syncLocalAsSent) {
          c.status = "sent";
          writeFileAtomic(campaignsPath, JSON.stringify(campaigns, null, 2));
          console.error(`   (registro local corrigido pra "sent" — estava defasado)`);
        }
      } else {
        await brevoSendNow(apiKey, c.campaignId);
        // #4347: NUNCA confiar só no 2xx do POST. #4718 (item 1): re-verifica
        // com retry+backoff curto (pollTerminalSendStatus) em vez de um único
        // GET imediato — "queued" costuma resolver em segundos, e um GET
        // cedo demais era o próprio motivo do falso alarme reportado.
        const verified = await pollTerminalSendStatus(apiKey, c.campaignId);
        applySendNowVerifyResults(
          [{ status: "fulfilled", value: verified }],
          [c],
          campaigns,
          campaignsPath,
        );
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
          console.error(
            `❌ ${key}: sendNow disparado mas GET-verify (com retry) não confirmou status terminal — NÃO declare sucesso. ` +
              `Reconsulte a Brevo antes de agir de novo — o guard ao vivo acima (#4718) já impede um 2º POST enquanto ` +
              `o status real for "queued"/"inProcess"/"sent", então re-rodar --send-now é seguro, mas provavelmente redundante.`,
          );
          process.exitCode = 2;
        }
      }
    }
  }

  // --- reschedule (PUT do NOVO scheduledAt numa campanha JÁ agendada +
  // GET-verify por INSTANTE) — #4668. Mesmo guard É IA? do --schedule: a
  // campanha já passou pelo gate editorial, reagendar só muda "quando".
  if (doReschedule) {
    const eiaCheck = checkEiaGuard(contentCycle, skipEiaGuard, undefined);
    if (!eiaCheck.ok) {
      console.error(eiaCheck.message);
      process.exit(1);
    }
    console.error(skipEiaGuard ? `⚠  --skip-eia-guard ativo — verificação de gabarito É IA? ignorada.` : `✓ Gabarito É IA? verificado`);

    const c = byKey.get(key);
    if (!c) throw new Error(`campanha '${key}' não criada — rode --create antes.`);

    // #4668: checa o status AO VIVO na Brevo ANTES de tocar em qualquer
    // coisa — o registro local (c.status) pode estar defasado (a campanha
    // pode ter entrado em "in_review" ou já disparado desde a última
    // sincronização). checkRescheduleAllowed decide os dois níveis (local +
    // ao vivo) numa função pura/testável.
    const live = await brevoGetCampaign(apiKey, c.campaignId);
    const allowed = checkRescheduleAllowed(c.status, live.status);
    if (!allowed.ok) {
      throw new Error(`--reschedule: ${key} (campanha #${c.campaignId}) ${allowed.reason}`);
    }

    const scheduleAtResolved = resolveScheduleAtArg(getArg(argv, "schedule-at") || undefined);
    if ("error" in scheduleAtResolved) throw new Error(scheduleAtResolved.error);
    const newScheduledAt = scheduleAtResolved.scheduledAt;
    if (!newScheduledAt) {
      throw new Error(`--reschedule requer --schedule-at com a NOVA data/hora (ex: --schedule-at 2026-08-06T10:00:00Z).`);
    }

    const previousScheduledAt = c.scheduledAt ?? live.scheduledAt ?? null;
    console.error(`↻ Reagendando ${key} (campanha #${c.campaignId}): ${previousScheduledAt ?? "(sem data anterior)"} → ${newScheduledAt}`);

    await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { scheduledAt: newScheduledAt });
    // #4668: `group-campaigns.json` só é gravado DEPOIS deste GET-verify
    // confirmar por INSTANTE — nunca antes do PUT ser confirmado (ver
    // docstring de `applyRescheduleVerifyResults`).
    const verifySettled = await Promise.allSettled([brevoGetCampaign(apiKey, c.campaignId)]);
    applyRescheduleVerifyResults(verifySettled, [c], [newScheduledAt], campaigns, campaignsPath);
    // #4680 (achado 1 do silent-failure-hunter): mesmo racional do guard de
    // --send-now acima (linhas ~962-970) — `applyRescheduleVerifyResults`
    // só faz `console.error` + `continue` nos 3 modos de falha do
    // GET-verify (rejeitado, status≠scheduled/queued, scheduledAt não bate
    // por instante); sem isto, `main()` terminava com exit 0 mesmo quando o
    // PUT foi aceito mas o reagendamento NÃO foi confirmado — o
    // `--send-now` do mesmo arquivo já resolvia essa classe de bug,
    // `--reschedule` reabria ela pelo lado oposto. `process.exitCode` (não
    // `process.exit`) deixa o JSON de resumo abaixo imprimir normalmente.
    if (!isSameInstant(c.scheduledAt, newScheduledAt)) {
      console.error(
        `❌ ${key}: reschedule PUT enviado mas GET-verify não confirmou o novo scheduledAt — NÃO declare sucesso. Re-tente --reschedule.`,
      );
      process.exitCode = 2;
    }
  }

  console.log(
    JSON.stringify(
      buildInvocationSummary(
        key,
        listId,
        { create: doCreate, updateHtml: doUpdateHtml, sendTest: doTest, schedule: doSchedule, sendNow: doSendNow, reschedule: doReschedule },
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
