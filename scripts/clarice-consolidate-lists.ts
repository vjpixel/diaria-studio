#!/usr/bin/env -S npx tsx
/**
 * clarice-consolidate-lists.ts (#9532)
 *
 * Libera espaço sob o teto de 300 listas da conta Brevo da Clarice
 * (`BREVO_CLARICE_API_KEY`) sem perder o histórico do guard por contato
 * (#7406/#3682). Decisão do editor na #9532 (caminho 1): consolidar as listas
 * de campanhas sent/archive há mais de `min_age_days` (piso 45, ciclo mensal
 * já fechado) numa lista de HISTÓRICO única (`platform.config.json` →
 * `clarice_list_history.list_id`, nome `clarice-historico-envios`) e SÓ
 * ENTÃO apagar as originais.
 *
 * Por que o guard continua valendo: `fetchQueuedAndCommittedCampaignListIds`
 * (scripts/lib/brevo-client.ts) soma o id de histórico ao Set `committed`.
 * O store (`brevo_list_ids`, sincronizado do `listIds` do contato) passa a
 * carregar o id de histórico no próximo sync. Janela entre DELETE e sync: o
 * id apagado some do `listIds` só no sync seguinte, e `min_age_days` (45) é
 * muito maior que o lag do `sends_count` (~1 dia) — quem recebeu uma campanha
 * dessas já tem `sends_count > 0` no store, que é o outro eixo do guard
 * (`hasSendHistory`). Isso pressupõe o sync diário do store rodando.
 *
 * Uso:
 *   npx tsx scripts/clarice-consolidate-lists.ts                 # dry-run (default): plano + JSON
 *   npx tsx scripts/clarice-consolidate-lists.ts --apply [--limit N]
 *   Opções: --root DIR (onde ler .env e gravar data/), --plan-out PATH,
 *           --protect 12,34 (ids extras a nunca apagar),
 *           --config PATH (SÓ dry-run; o --apply recusa — o guard lê o
 *           platform.config.json default deste checkout, e é esse que vale)
 *
 * Pré-condições do --apply (`checkApplyPreconditions`, todas obrigatórias):
 *   - `clarice_list_history.list_id` preenchido;
 *   - o id que o GUARD lê (`resolveClariceHistoryListIdForGuard`) == o do script;
 *   - platform.config.json sem mudança não commitada (`git diff --quiet`);
 *   - `origin/master:platform.config.json` com o MESMO list_id (após `git fetch`);
 *   - `data/` existente no --root (o snapshot não pode sumir com um worktree);
 *   - a lista se chama `clarice-historico-envios`.
 *
 * Proteção: só `list_id`/`*_list_id` numéricos do platform.config.json e
 * `--protect` são varridos como ids fixos (nada de grep no código); além
 * disso, só lista com NOME na allowlist de listas de campanha
 * (`CAMPAIGN_LIST_NAME_PATTERNS`) pode ser apagada.
 *
 * Custo de cota em `/emailCampaigns` (100 req/HORA/conta): o plano faz ~3
 * GETs (1 varredura sem filtro de status); o --apply re-checa as campanhas
 * não-terminais (5 status) a cada `RECHECK_EVERY` listas, e para se a reserva
 * de cota acabar (`assertCampaignQuotaHeadroom`). Prefira `--limit`.
 *
 * `--apply` é IRREVERSÍVEL na Brevo (DELETE de lista). Antes do 1º DELETE
 * grava `clarice_list_history.consolidated_at` no platform.config.json —
 * COMMITE essa mudança depois da rodada (o parser passa a recusar
 * `list_id: null`).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  assertCampaignQuotaHeadroom,
  brevoGet,
  brevoGetList,
  brevoListContacts,
  brevoPost,
  brevoDelete,
} from "./lib/brevo-client.ts";
import {
  loadClariceListHistoryConfig,
  parseClariceListHistoryConfig,
  insertConsolidatedAt,
  resolveClariceHistoryListIdForGuard,
  DEFAULT_PLATFORM_CONFIG_PATH,
} from "./lib/clarice-list-history-config.ts";
import {
  planListConsolidation,
  applyListConsolidation,
  checkApplyPreconditions,
  HISTORY_LIST_NAME,
  type ConsolidationList,
  type ConsolidationCampaign,
  type ConsolidationClient,
  type ConsolidationPlan,
  type ListArchiveSnapshot,
} from "./lib/clarice-list-consolidation.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

type BrevoGetFn = (path: string) => Promise<{ status: number; body: any }>;

/**
 * Varredura paginada COMPLETA: 404 lança (o `brevoGet` devolve 404 como
 * corpo vazio, o que pararia a paginação em silêncio) e o total coletado
 * precisa bater com `count` — divergência aborta antes de qualquer plano.
 */
export async function paginateComplete<T>(
  get: BrevoGetFn,
  basePath: string,
  key: "lists" | "campaigns",
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  let count: number | undefined;
  for (let offset = 0; ; offset += limit) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = `${basePath}${sep}limit=${limit}&offset=${offset}`;
    const { status, body } = await get(path);
    if (status === 404) throw new Error(`Brevo GET ${path} devolveu 404 — varredura incompleta, abortando.`);
    const page = (body?.[key] ?? []) as T[];
    if (typeof body?.count === "number") count = body.count;
    out.push(...page);
    if (page.length < limit) break;
  }
  // Página vazia de um status sem itens pode vir sem `count` — só aí 0 é aceito.
  if (count === undefined && out.length === 0) return out;
  if (count === undefined) throw new Error(`Brevo GET ${basePath}: resposta sem \`count\` — não dá pra provar varredura completa.`);
  if (out.length !== count) {
    throw new Error(`Brevo GET ${basePath}: coletados ${out.length} ≠ count ${count} — paginação divergente, abortando.`);
  }
  return out;
}

async function fetchAllListsWithCounts(apiKey: string): Promise<ConsolidationList[]> {
  const raw = await paginateComplete<ConsolidationList>((p) => brevoGet(apiKey, p), "/contacts/lists", "lists", 50);
  return raw.map((l) => ({ id: l.id, name: l.name, totalSubscribers: l.totalSubscribers, uniqueSubscribers: l.uniqueSubscribers }));
}

/** UMA varredura de `/emailCampaigns` sem filtro de status (limit=100) — todos os status de uma vez. */
async function fetchAllCampaigns(apiKey: string): Promise<ConsolidationCampaign[]> {
  const raw = await paginateComplete<ConsolidationCampaign>(
    (p) => brevoGet(apiKey, p),
    "/emailCampaigns?excludeHtmlContent=true",
    "campaigns",
    100,
  );
  return raw.map((c) => ({ id: c.id, name: c.name, status: c.status, sentDate: c.sentDate ?? null, recipients: c.recipients ?? null }));
}

/** Status não-terminais re-checados antes de apagar (filtro do GET da Brevo). */
const NON_TERMINAL_FILTERS = ["queued", "draft", "suspended", "inProcess", "inReview"] as const;

function archiveDir(root: string): string {
  return resolve(root, "data", "clarice-subscribers", "list-archive");
}

export function makeBrevoConsolidationClient(apiKey: string, root: string, configPath: string): ConsolidationClient {
  const dir = archiveDir(root);
  return {
    async getListCount(listId) {
      return (await brevoGetList(apiKey, listId)).totalSubscribers;
    },
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
      if (!res || typeof res !== "object" || !res.contacts) {
        throw new Error(`resposta do add sem \`contacts\`: ${JSON.stringify(res)}`);
      }
      return { success: res.contacts.success ?? [], failure: res.contacts.failure ?? [] };
    },
    async contactInList(email, listId) {
      // `brevoGet` NÃO lança em 404 — devolve `{status: 404, body: {}}` (contato
      // inexistente). Os outros erros lançam e viram falha em "verify".
      const { status, body } = await brevoGet(apiKey, `/contacts/${encodeURIComponent(email)}`);
      if (status === 404) return false;
      return Array.isArray(body?.listIds) && body.listIds.includes(listId);
    },
    async fetchNonTerminalListRefs() {
      assertCampaignQuotaHeadroom(); // consumidor que não é o caminho de escrita da onda: respeita a reserva
      const ids = new Set<number>();
      for (const status of NON_TERMINAL_FILTERS) {
        const camps = await paginateComplete<ConsolidationCampaign>(
          (p) => brevoGet(apiKey, p),
          `/emailCampaigns?status=${status}&excludeHtmlContent=true`,
          "campaigns",
          100,
        );
        for (const c of camps) {
          for (const id of c.recipients?.lists ?? []) ids.add(id);
          for (const id of c.recipients?.exclusionLists ?? []) ids.add(id);
        }
      }
      return ids;
    },
    async markConsolidated(iso) {
      const text = readFileSync(configPath, "utf8");
      const next = insertConsolidatedAt(text, iso);
      if (next !== text) writeFileAtomic(configPath, next);
      const back = parseClariceListHistoryConfig(
        (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>).clarice_list_history,
      );
      if (back.consolidatedAt === null) throw new Error("consolidated_at não aparece no config relido.");
    },
    deleteList: (listId) => brevoDelete(apiKey, `/contacts/lists/${listId}`),
  };
}

export function formatPlanSummary(plan: ConsolidationPlan): string {
  const v = plan.verdict_counts;
  const lines = [
    `Plano de consolidação (#9532) — corte: sentDate < ${plan.cutoff} (min_age_days=${plan.min_age_days}), ciclo corrente ${plan.current_cycle}`,
    `  listas na conta: ${plan.total_lists}/${plan.list_cap}`,
    `  candidatas a apagar: ${plan.candidates.length} (~${plan.candidate_contacts_estimate} contato(s) somando as listas, com repetição entre listas)`,
    `  após apagar todas: ${plan.lists_after} lista(s), ${plan.free_after} livre(s) sob o teto`,
    `  mantidas: recentes=${v["recent-sent"]}, ciclo aberto=${v["open-cycle"]}, ref. não-terminal=${v["non-terminal-ref"]}, ` +
      `só-exclusão=${v["exclusion-only"]}, sem sentDate=${v["sent-without-date"]}, nome fora da allowlist=${v["unmatched-name"]}, ` +
      `protegidas=${v.protected}, histórico=${v.history}, sem campanha=${v["no-campaign"]}`,
    `  lista de histórico: ${plan.history_list_id ?? "NÃO configurada (clarice_list_history.list_id = null) — --apply recusa"}`,
  ];
  for (const u of plan.unmatched_names) lines.push(`    nome fora da allowlist (não apagada): ${u.listId} "${u.name}"`);
  return lines.join("\n");
}

function git(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

/** `list_id` do bloco no `origin/master` (após fetch). undefined = não foi possível ler. */
function readMasterListId(): number | null | undefined {
  if (!git(["fetch", "--quiet", "origin", "master"]).ok) return undefined;
  const shown = git(["show", "origin/master:platform.config.json"]);
  if (!shown.ok) return undefined;
  try {
    return parseClariceListHistoryConfig((JSON.parse(shown.out) as Record<string, unknown>).clarice_list_history).listId;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = resolve(getStringArg(argv, "root") ?? REPO_ROOT);
  loadProjectEnv(root);
  const apply = hasFlag(argv, "apply");
  const limit = getIntArg(argv, "limit", { min: 1 });
  const protectArg = getStringArg(argv, "protect");
  const planOut = getStringArg(argv, "plan-out");
  const configArg = getStringArg(argv, "config");
  if (apply && configArg !== undefined) {
    throw new Error("--config não vale com --apply: o guard lê o platform.config.json default deste checkout, e é ele que o --apply usa.");
  }

  const configPath = configArg !== undefined ? resolve(configArg) : DEFAULT_PLATFORM_CONFIG_PATH;
  const historyCfg = loadClariceListHistoryConfig(configPath); // lança alto se malformado
  const protectedIds = collectConfiguredListIds(JSON.parse(readFileSync(configPath, "utf8")));
  for (const s of (protectArg ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--protect: id inválido "${s}"`);
    protectedIds.add(n);
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) throw new Error("BREVO_CLARICE_API_KEY não definida.");

  if (apply) {
    // Checado ANTES de gravar o plano (que faria mkdir recursivo de data/).
    const pre = {
      configListId: historyCfg.listId,
      guardListId: resolveClariceHistoryListIdForGuard(),
      configDirty: !git(["diff", "--quiet", "--", "platform.config.json"]).ok,
      masterListId: readMasterListId(),
      dataDirExists: existsSync(resolve(root, "data")),
    };
    let errs = checkApplyPreconditions(pre);
    if (errs.length === 0) {
      const historyList = await brevoGetList(apiKey, historyCfg.listId as number);
      errs = checkApplyPreconditions({ ...pre, historyListName: historyList.name });
    }
    if (errs.length > 0) {
      throw new Error(`--apply recusado (#9532), nada foi apagado:\n  - ${errs.join("\n  - ")}`);
    }
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
  const historyMembers = new Set((await brevoListContacts(apiKey, historyListId)).map((e) => e.trim().toLowerCase()));
  console.log(`\nlista de histórico ${historyListId} (${HISTORY_LIST_NAME}): ${historyMembers.size} membro(s) antes da rodada.`);

  const resultPath = outPath.replace(/\.json$/, "-apply.jsonl");
  const results = await applyListConsolidation(plan.candidates, makeBrevoConsolidationClient(apiKey, root, configPath), {
    historyListId,
    historyMembers,
    protectedListIds: protectedIds,
    limit,
    now: () => new Date(),
    log: (m) => console.log(m),
    onResult: (r) => appendFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), ...r }) + "\n"),
  });
  const deleted = results.filter((r) => r.status === "deleted").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  console.log(`\nResultado: ${deleted} apagada(s), ${skipped} pulada(s), ${failed} falha(s). Detalhe em ${resultPath}`);
  if (deleted > 0) {
    console.log("⚠️  platform.config.json ganhou `consolidated_at` — commite e mergeie essa mudança.");
  }
  if (failed > 0) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
