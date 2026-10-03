#!/usr/bin/env -S npx tsx
/**
 * clarice-consolidate-lists.ts (#9532)
 *
 * Libera espaço sob o teto de 300 listas da conta Brevo da Clarice
 * (`BREVO_CLARICE_API_KEY`) sem perder o histórico do guard por contato
 * (#7406/#3682). Decisão do editor na #9532 (caminho 1): consolidar as listas
 * de campanhas `sent` há mais de `min_age_days` numa lista de HISTÓRICO única
 * (`platform.config.json` → `clarice_list_history.list_id`, nome
 * `clarice-historico-envios`) e SÓ ENTÃO apagar as originais.
 *
 * Por que o guard continua valendo: `fetchQueuedAndCommittedCampaignListIds`
 * (scripts/lib/brevo-client.ts) soma o id de histórico ao Set `committed`.
 * O store (`brevo_list_ids`, sincronizado do `listIds` do contato) passa a
 * carregar o id de histórico no próximo sync. Janela entre DELETE e sync: o
 * id apagado some do `listIds` só no sync seguinte, e `min_age_days` (14) é
 * muito maior que o lag do `sends_count` (~1 dia) — quem recebeu uma campanha
 * de 14+ dias atrás já tem `sends_count > 0` no store, que é o outro eixo do
 * guard (`hasSendHistory`).
 *
 * Uso:
 *   npx tsx scripts/clarice-consolidate-lists.ts                 # dry-run (default): plano + JSON
 *   npx tsx scripts/clarice-consolidate-lists.ts --apply [--limit N]
 *   Opções: --root DIR (onde ler .env e gravar data/), --config PATH
 *           (default: platform.config.json deste checkout),
 *           --plan-out PATH, --protect 12,34 (ids extras a nunca apagar)
 *
 * Seleção de candidatas e a ordem snapshot → add → delete:
 * scripts/lib/clarice-list-consolidation.ts. Custo de cota: o dry-run faz ~1
 * GET a `/emailCampaigns` por 100 campanhas (sem filtro de status — UMA
 * varredura cobre sent/queued/draft/suspended/...), o resto é família
 * `/contacts` (quota folgada, docs/brevo-rate-limits.md).
 *
 * `--apply` é IRREVERSÍVEL na Brevo (DELETE de lista). Autorizado pelo editor
 * na #9532 SÓ nesse desenho (preservação antes da deleção). Exige
 * `clarice_list_history.list_id` configurado e a lista com o nome esperado.
 */

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  brevoGet,
  brevoGetList,
  brevoListContacts,
  brevoPost,
  brevoDelete,
} from "./lib/brevo-client.ts";
import { loadClariceListHistoryConfig } from "./lib/clarice-list-history-config.ts";
import {
  planListConsolidation,
  applyListConsolidation,
  type ConsolidationList,
  type ConsolidationCampaign,
  type ConsolidationClient,
  type ConsolidationPlan,
  type ListArchiveSnapshot,
} from "./lib/clarice-list-consolidation.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HISTORY_LIST_NAME = "clarice-historico-envios";

/** Todo `list_id`/`*_list_id` numérico do config — conservador: protege até ids de outras contas. */
export function collectConfiguredListIds(node: unknown, out = new Set<number>()): Set<number> {
  if (Array.isArray(node)) {
    for (const v of node) collectConfiguredListIds(v, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "list_id" || k.endsWith("_list_id")) && typeof v === "number" && Number.isInteger(v)) out.add(v);
      else collectConfiguredListIds(v, out);
    }
  }
  return out;
}

async function fetchAllListsWithCounts(apiKey: string): Promise<ConsolidationList[]> {
  const out: ConsolidationList[] = [];
  const limit = 50;
  for (let offset = 0; ; offset += limit) {
    const { body } = await brevoGet(apiKey, `/contacts/lists?limit=${limit}&offset=${offset}`);
    const lists = (body?.lists ?? []) as ConsolidationList[];
    for (const l of lists) {
      out.push({ id: l.id, name: l.name, totalSubscribers: l.totalSubscribers, uniqueSubscribers: l.uniqueSubscribers });
    }
    if (lists.length < limit) break;
  }
  return out;
}

/** UMA varredura de `/emailCampaigns` sem filtro de status (limit=100) — todos os status de uma vez. */
async function fetchAllCampaigns(apiKey: string): Promise<ConsolidationCampaign[]> {
  const out: ConsolidationCampaign[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const { body } = await brevoGet(apiKey, `/emailCampaigns?limit=${limit}&offset=${offset}&excludeHtmlContent=true`);
    const campaigns = (body?.campaigns ?? []) as ConsolidationCampaign[];
    for (const c of campaigns) {
      out.push({ id: c.id, name: c.name, status: c.status, sentDate: c.sentDate ?? null, recipients: c.recipients ?? null });
    }
    if (campaigns.length < limit) break;
  }
  return out;
}

function archiveDir(root: string): string {
  return resolve(root, "data", "clarice-subscribers", "list-archive");
}

export function makeBrevoConsolidationClient(apiKey: string, root: string): ConsolidationClient {
  const dir = archiveDir(root);
  return {
    listContacts: (listId) => brevoListContacts(apiKey, listId),
    async writeSnapshot(s: ListArchiveSnapshot) {
      mkdirSync(dir, { recursive: true });
      writeFileAtomic(resolve(dir, `${s.listId}.json`), JSON.stringify(s, null, 2) + "\n");
    },
    async readSnapshot(listId) {
      const p = resolve(dir, `${listId}.json`);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8")) as ListArchiveSnapshot;
    },
    async addToList(listId, emails) {
      const res = (await brevoPost(apiKey, `/contacts/lists/${listId}/contacts/add`, { emails })) as {
        contacts?: { success?: string[]; failure?: string[] };
      };
      return { success: res?.contacts?.success ?? [], failure: res?.contacts?.failure ?? [] };
    },
    async contactInList(email, listId) {
      const { status, body } = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
      if (status === 404) return false;
      return Array.isArray(body?.listIds) && body.listIds.includes(listId);
    },
    deleteList: (listId) => brevoDelete(apiKey, `/contacts/lists/${listId}`),
  };
}

export function formatPlanSummary(plan: ConsolidationPlan): string {
  const v = plan.verdict_counts;
  return [
    `Plano de consolidação (#9532) — corte: sentDate < ${plan.cutoff} (min_age_days=${plan.min_age_days})`,
    `  listas na conta: ${plan.total_lists}/${plan.list_cap}`,
    `  candidatas a apagar: ${plan.candidates.length} (~${plan.candidate_contacts_estimate} contato(s) somando as listas, com repetição entre listas)`,
    `  após apagar todas: ${plan.lists_after} lista(s), ${plan.free_after} livre(s) sob o teto`,
    `  mantidas: recentes=${v["recent-sent"]}, ref. não-terminal=${v["non-terminal-ref"]}, só-exclusão=${v["exclusion-only"]}, ` +
      `sem sentDate=${v["sent-without-date"]}, protegidas=${v.protected}, histórico=${v.history}, sem campanha=${v["no-campaign"]}`,
    `  lista de histórico: ${plan.history_list_id ?? "NÃO configurada (clarice_list_history.list_id = null) — --apply recusa"}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = resolve(getStringArg(argv, "root") ?? REPO_ROOT);
  loadProjectEnv(root);
  const apply = hasFlag(argv, "apply");
  const limit = getIntArg(argv, "limit", { min: 1 });
  const protectArg = getStringArg(argv, "protect");
  const planOut = getStringArg(argv, "plan-out");

  // Config vem DESTE checkout (código e config andam juntos no git); `--root`
  // só aponta .env + data/. `--config` sobrepõe.
  const configPath = resolve(getStringArg(argv, "config") ?? resolve(REPO_ROOT, "platform.config.json"));
  const historyCfg = loadClariceListHistoryConfig(configPath); // lança alto se malformado
  const protectedIds = collectConfiguredListIds(JSON.parse(readFileSync(configPath, "utf8")));
  for (const s of (protectArg ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--protect: id inválido "${s}"`);
    protectedIds.add(n);
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) throw new Error("BREVO_CLARICE_API_KEY não definida.");
  if (apply && historyCfg.listId === null) {
    throw new Error(
      "--apply exige `clarice_list_history.list_id` em platform.config.json (#9532) — crie a lista " +
        `\`${HISTORY_LIST_NAME}\` na conta Brevo da Clarice e preencha o id antes. Nada foi apagado.`,
    );
  }
  // Snapshot é a cópia de segurança de um DELETE irreversível: nunca gravá-lo
  // num `data/` criado agora (worktree sem a junction → some com o worktree).
  // Checado ANTES de gravar o plano, que faria mkdir recursivo de data/.
  if (apply && !existsSync(resolve(root, "data"))) {
    throw new Error(`--apply: ${resolve(root, "data")} não existe — rode do checkout com data/ (ou --root). Nada foi apagado.`);
  }

  const lists = await fetchAllListsWithCounts(apiKey);
  const campaigns = await fetchAllCampaigns(apiKey);
  const plan = planListConsolidation({
    lists,
    campaigns,
    historyListId: historyCfg.listId,
    protectedListIds: protectedIds,
    minAgeDays: historyCfg.minAgeDays,
    now: new Date(),
  });

  const stamp = plan.generated_at.replace(/[-:]/g, "").slice(0, 13);
  const outPath = planOut
    ? resolve(planOut)
    : resolve(root, "data", "clarice-subscribers", "list-consolidation", `plan-${stamp}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, JSON.stringify({ ...plan, campaigns_seen: campaigns.length }, null, 2) + "\n");
  console.log(formatPlanSummary(plan));
  console.log(`  plano gravado em ${outPath}`);

  if (!apply) {
    console.log("\n(dry-run — nada escrito na Brevo. --apply [--limit N] executa snapshot → add → delete.)");
    return;
  }

  const historyListId = historyCfg.listId as number;
  const historyList = await brevoGetList(apiKey, historyListId);
  if (historyList.name !== HISTORY_LIST_NAME) {
    throw new Error(
      `lista ${historyListId} se chama "${historyList.name}", esperado "${HISTORY_LIST_NAME}" — config apontando pra lista errada? Nada foi apagado.`,
    );
  }
  const historyMembers = new Set((await brevoListContacts(apiKey, historyListId)).map((e) => e.trim().toLowerCase()));
  console.log(`\nlista de histórico ${historyListId}: ${historyMembers.size} membro(s) antes da rodada.`);

  const results = await applyListConsolidation(plan.candidates, makeBrevoConsolidationClient(apiKey, root), {
    historyListId,
    historyMembers,
    limit,
    now: () => new Date(),
    log: (m) => console.log(m),
  });
  const deleted = results.filter((r) => r.status === "deleted").length;
  const failed = results.length - deleted;
  const resultPath = outPath.replace(/\.json$/, "-apply.json");
  writeFileAtomic(resultPath, JSON.stringify({ history_list_id: historyListId, results }, null, 2) + "\n");
  console.log(`\nResultado: ${deleted} lista(s) apagada(s), ${failed} falha(s). Detalhe em ${resultPath}`);
  if (failed > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
