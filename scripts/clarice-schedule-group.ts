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
 *                      Requer --subject e --schedule-at (data alvo, validada
 *                      no futuro). --preview-text "..." opcional (paridade
 *                      com publish-monthly.ts; sem a flag, Brevo usa o
 *                      snippet default derivado do HTML). --update-existing N
 *                      reusa uma campanha já existente (PUT) em vez de criar
 *                      nova (POST) — mesmo pre-check de status terminal que
 *                      publish-monthly.ts fazia.
 *   --update-html      re-aplica o HTML atual (cloudflare-preview.html) na
 *                      campanha em draft — propaga fix de render pós-create.
 *   --send-test        manda test email pro `brevo_monthly.test_email` do
 *                      platform.config.json.
 *   --schedule         agenda a campanha (PUT scheduledAt + GET-verify).
 *                      REQUER o gabarito É IA? setado antes via
 *                        npx tsx scripts/close-poll.ts --brand clarice --cycle {cycle} --edition {AAMMDD} [--answer A|B]
 *                      --skip-eia-guard pula essa verificação (não recomendado).
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
 *                      colidiria com a 1ª sob a mesma key).
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
import { brevoPost, brevoPut, brevoGetCampaign } from "./lib/brevo-client.ts";
import { clariceSegmentsDir, ensureDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { monthlyDir as resolveMonthlyDir, cycleToYymm } from "./lib/mensal/monthly-paths.ts";
import { checkEiaGuard, applyVerifyResults } from "./clarice-schedule-sends.ts";
import { groupListsRegistryPath, type GroupListEntry } from "./clarice-import-waves.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Mesmo shape de CampaignEntry em clarice-schedule-sends.ts (não exportado lá —
// TS casa estruturalmente ao passar pra applyVerifyResults/isScheduledStatus,
// sem precisar de import de tipo).
export interface CampaignEntry {
  key: string;
  campaignId: number;
  listId: number;
  subject: string;
  scheduledAt: string;
  status: "draft" | "scheduled";
}

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

/** Parseia --subject: retorna o valor ou undefined. Mesma forma de clarice-schedule-sends.ts. */
export function parseSubjectArg(argv: string[]): string | undefined {
  const v = getArg(argv, "subject");
  return v || undefined;
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
  const skipEiaGuard = hasFlag(argv, "skip-eia-guard");

  // HTML render: mesma fonte que clarice-schedule-sends.ts (Stage 4 já subiu
  // as imagens pro Cloudflare KV — nada de upload aqui, ver docstring do topo).
  const htmlPath = resolve(resolveMonthlyDir(cycle), "_internal", "cloudflare-preview.html");
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
  if (!doCreate && !doUpdateHtml && !doTest && !doSchedule) {
    console.error(`\ndry-run — use --create, depois --send-test, depois --schedule.`);
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
      console.error(`↷ ${key} já criada (#${existing.campaignId}) — pulando`);
    } else {
      const subject = parseSubjectArg(argv);
      if (!subject) throw new Error("--create requer --subject \"Assunto da campanha\".");
      // #3228: opcional (paridade com publish-monthly.ts, que sempre mandava
      // previewText) — sem a flag, omitido do body (Brevo aceita sem ele,
      // cai no snippet default derivado do próprio HTML).
      const previewText = getArg(argv, "preview-text") || undefined;
      const scheduleAtRaw = getArg(argv, "schedule-at");
      if (!scheduleAtRaw) throw new Error("--create requer --schedule-at <ISO> (data alvo do agendamento).");
      const scheduledAtDate = new Date(scheduleAtRaw);
      if (Number.isNaN(scheduledAtDate.getTime())) {
        throw new Error(`--schedule-at não é ISO 8601 válido: "${scheduleAtRaw}"`);
      }
      if (scheduledAtDate.getTime() <= Date.now()) {
        throw new Error(
          `--schedule-at deve estar no futuro. Recebido: ${scheduledAtDate.toISOString()}, agora: ${new Date().toISOString()}`,
        );
      }
      const scheduledAt = scheduledAtDate.toISOString();

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
    if (c.status === "scheduled") {
      console.error(`⚠️  ${key} já agendada — html NÃO atualizado (desagende primeiro)`);
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
    const eiaCheck = checkEiaGuard(cycle, skipEiaGuard, undefined);
    if (!eiaCheck.ok) {
      console.error(eiaCheck.message);
      process.exit(1);
    }
    console.error(skipEiaGuard ? `⚠  --skip-eia-guard ativo — verificação de gabarito É IA? ignorada.` : `✓ Gabarito É IA? verificado`);

    const c = byKey.get(key);
    if (!c) throw new Error(`campanha '${key}' não criada — rode --create antes.`);
    if (c.status === "scheduled") {
      console.error(`↷ ${key} já agendada — pulando`);
    } else {
      if (new Date(c.scheduledAt) <= new Date()) {
        throw new Error(
          `--schedule: ${key} (campanha #${c.campaignId}) tem scheduledAt no passado/presente ` +
            `(${c.scheduledAt}). Atualize o group-campaigns.json ou recrie com --create --schedule-at novo.`,
        );
      }
      await brevoPut(apiKey, `/emailCampaigns/${c.campaignId}`, { scheduledAt: c.scheduledAt });
      const verifySettled = await Promise.allSettled([brevoGetCampaign(apiKey, c.campaignId)]);
      applyVerifyResults(verifySettled, [c], campaigns, campaignsPath);
    }
  }

  console.log(
    JSON.stringify(
      { created: campaigns.length, scheduled: campaigns.filter((c) => c.status === "scheduled").length },
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
