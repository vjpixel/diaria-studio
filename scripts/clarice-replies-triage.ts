#!/usr/bin/env node
/**
 * clarice-replies-triage.ts (#12227) — triagem ASSISTIDA das respostas à
 * newsletter Clarice News ("Notícias do mês sobre IA"), que chegam em
 * `pixel@diar.ia.br` (reply-to de `brevo_monthly` no platform.config.json).
 *
 * Decisão do editor (05/11/2026): o script classifica, o editor confirma em
 * lote, nada é aplicado sem confirmação.
 *
 * Dois modos:
 *
 *   1. Listar (default, só lê): busca as respostas, classifica cada uma
 *      (quero / saída / suporte / ruído / ambíguo, regras em
 *      `lib/clarice-replies-classify.ts`), imprime o lote e o plano de ações e
 *      grava o plano em `data/clarice-replies/triage-{lote}.json`.
 *
 *        npx tsx scripts/clarice-replies-triage.ts [--days 30] [--input respostas.json]
 *
 *   2. Aplicar o plano JÁ MOSTRADO:
 *
 *        npx tsx scripts/clarice-replies-triage.ts --apply --confirm {lote}
 *
 *      - `quero`  → `priority_optin` (mesma gravação de `clarice-optin.ts add`);
 *      - `saída`  → supressão NA HORA no store (`unsubscribed` +
 *        `email_blacklisted`, `markSuppressedNow`) e recompute de
 *        `send_eligible`, depois blacklist na Brevo da Clarice
 *        (`PUT /contacts/{email}` com `emailBlacklisted: true`). A ordem é de
 *        propósito: o store suprime antes da chamada de rede, então uma falha
 *        da Brevo nunca deixa a pessoa elegível no nosso pipeline.
 *      - Exclusão LGPD = mesmo tratamento da saída; exclusão de DADOS, se
 *        pedida, só é listada (tratada à mão).
 *      - `suporte` vira lista de encaminhamento à Clarice (o script nunca
 *        encaminha); `ambíguo` fica pendente, sem ação; `ruído` é ignorado.
 *
 *      Reexecução segura: o estado de aplicação fica no próprio arquivo do
 *      plano (`applied`). Optin e supressão local são idempotentes; a Brevo
 *      só é chamada pra quem ainda não deu certo. Erro da Brevo num contato
 *      não aborta os demais: o script termina, lista quem falhou e sai com
 *      exit 1 — rodar o mesmo `--apply --confirm {lote}` de novo retenta só
 *      esses.
 *
 * O id do lote é o hash das respostas e suas classes: se chegou resposta nova
 * depois da listagem, o lote listado de novo tem outro id, e o `--confirm`
 * antigo só aplica o plano antigo (nunca o que o editor não viu).
 *
 * Leitura da caixa (`ReplyReader`, injetável):
 *   - default: Gmail REST (`gFetch`, `data/.credentials.json`, o mesmo OAuth
 *     de `dmarc-drain.ts`, cuja caixa recebe o `rua=mailto:pixel@diar.ia.br`).
 *     Busca `messages?q=to:pixel@diar.ia.br subject:"Notícias do mês sobre
 *     IA" newer_than:{N}d`. PREMISSA não verificada nesta sessão (sem
 *     credencial no ambiente): a conta autenticada recebe o que chega em
 *     `pixel@diar.ia.br`. Se não receber, a busca volta vazia (o script
 *     avisa) e falta configurar uma credencial OAuth da caixa
 *     `pixel@diar.ia.br` (`scripts/oauth-setup.ts`).
 *   - `--input arquivo.json`: lista de `ReplyMessage` (ver
 *     `lib/clarice-replies-classify.ts`), para triagem a partir de um export
 *     feito por outro caminho (ex.: conector Gmail numa sessão interativa).
 *
 * Flags: --days N (30), --max N (500), --to ENDEREÇO, --subject TEXTO,
 * --query Q (substitui a query inteira), --input P, --plan-dir P
 * (data/clarice-replies), --db P (store da Clarice), --apply, --confirm ID,
 * --skip E1,E2 (com --apply: exclui esses e-mails desta aplicação, #12283).
 *
 * Salvaguardas do --apply (#12265): o plano gravado é conferido contra os
 * próprios itens (id recalculado + ações refeitas; divergência recusa); um
 * contato que não existe na Brevo (404) é suprimido no store e listado à
 * parte para revisão manual, sem virar falha eterna; a listagem já mostra o
 * e-mail canônico do store que o --apply vai usar.
 *
 * Requer BREVO_CLARICE_API_KEY só no `--apply` com saída pendente na Brevo.
 * Stdout: JSON resumo. Stderr: lote legível.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { getArg, getIntArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  DEFAULT_DB_PATH,
  markSuppressedNow,
  openClariceDb,
  recomputeDerived,
} from "./lib/clarice-db.ts";
import {
  buildTriagePlan,
  diffEffectiveActions,
  gmailMessageToReply,
  validatePlanIntegrity,
  type GmailMessageLike,
  type ReplyMessage,
  type TriagePlan,
} from "./lib/clarice-replies-classify.ts";
import { addPriorityOptins, resolveOptinEmail } from "./clarice-optin.ts";
import { isTestAccount } from "./lib/cohorts.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_PLAN_DIR = resolve(ROOT, "data", "clarice-replies");
export const DEFAULT_REPLY_TO = "pixel@diar.ia.br";
export const DEFAULT_SUBJECT = "Notícias do mês sobre IA";
export const DEFAULT_DAYS = 30;
export const DEFAULT_MAX = 500;

export function buildDefaultQuery(opts: { to?: string; subject?: string; days?: number } = {}): string {
  const to = opts.to ?? DEFAULT_REPLY_TO;
  const subject = (opts.subject ?? DEFAULT_SUBJECT).replace(/"/g, "");
  const days = opts.days ?? DEFAULT_DAYS;
  return `to:${to} subject:"${subject}" newer_than:${days}d`;
}

export function planPath(planDir: string, batchId: string): string {
  if (!/^[0-9a-f]{12}$/.test(batchId)) throw new Error(`id de lote inválido: ${batchId}`);
  return resolve(planDir, `triage-${batchId}.json`);
}

// ---------------------------------------------------------------------------
// Leitura da caixa
// ---------------------------------------------------------------------------

export interface ReplyReader {
  list(query: string, max: number): Promise<ReplyMessage[]>;
}

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

export function makeGmailReader(): ReplyReader {
  return {
    async list(query, max) {
      const { gFetch } = await import("./google-auth.ts");
      const get = async <T>(path: string): Promise<T> => {
        const res = await gFetch(`${GMAIL_API}/${path}`);
        if (!res.ok) throw new Error(`Gmail ${path.split("?")[0]} falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
        return (await res.json()) as T;
      };
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max)) });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`messages?${params}`);
        for (const m of page.messages ?? []) ids.push(m.id);
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      const out: ReplyMessage[] = [];
      for (const id of ids.slice(0, max)) {
        out.push(gmailMessageToReply(await get<GmailMessageLike>(`messages/${id}?format=full`)));
      }
      return out;
    },
  };
}

export function makeFileReader(path: string): ReplyReader {
  return {
    async list() {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error(`${path}: esperado um array de respostas`);
      return raw as ReplyMessage[];
    },
  };
}

// ---------------------------------------------------------------------------
// Plano: gravar/ler
// ---------------------------------------------------------------------------

export function loadPlan(path: string): TriagePlan {
  const plan = JSON.parse(readFileSync(path, "utf8")) as TriagePlan;
  if (plan.schema !== 1 || !plan.batch_id || !plan.actions || !plan.applied) {
    throw new Error(`${path}: plano em formato inesperado`);
  }
  return plan;
}

/**
 * Grava o plano; se já existe plano do MESMO lote, preserva o estado de aplicação. Recusa (lança)
 * sobrescrever um plano de mesmo id cujas ações efetivas (optin/saída/exclusão/conflitos) sejam
 * outras: o `--confirm` do editor valeu para o plano gravado, não para um conteúdo novo (#12265).
 */
export function savePlan(planDir: string, plan: TriagePlan): string {
  mkdirSync(planDir, { recursive: true });
  const path = planPath(planDir, plan.batch_id);
  let toWrite = plan;
  if (existsSync(path)) {
    let prev: TriagePlan | null = null;
    try {
      prev = loadPlan(path);
    } catch {
      // plano anterior ilegível: sobrescreve com o novo (estado de aplicação perdido é seguro — tudo é idempotente)
    }
    if (prev) {
      const diff = diffEffectiveActions(plan.actions, prev.actions);
      if (diff.length > 0) {
        throw new Error(
          `${path} já existe com o mesmo id e ações diferentes (${diff.join("; ")}). ` +
            `Nada gravado: confira o arquivo antes de apagá-lo ou mover.`,
        );
      }
      toWrite = { ...plan, created_at: prev.created_at, applied: prev.applied };
    }
  }
  writeFileAtomic(path, JSON.stringify(toWrite, null, 2) + "\n");
  return path;
}

/** Endereço resolvido no store, por e-mail do plano (só os que mudam ou têm aviso). */
export type CanonicalMap = Map<string, { email: string; warning?: string }>;

/**
 * Resolve, já na listagem, o e-mail que o `--apply` vai de fato usar (forma canônica do Gmail no
 * store, #2861) — o editor confirma o alvo exato que vai pra Brevo (#12265).
 */
export function resolveCanonicalTargets(db: DatabaseSync, plan: TriagePlan): CanonicalMap {
  const out: CanonicalMap = new Map();
  for (const email of new Set([...plan.actions.optin, ...plan.actions.saida])) {
    const r = resolveOptinEmail(db, email);
    if (r.email !== email || r.warning) out.set(email, { email: r.email, ...(r.warning ? { warning: r.warning } : {}) });
  }
  return out;
}

function withCanonical(email: string, canonical?: CanonicalMap): string {
  const c = canonical?.get(email);
  if (!c) return email;
  if (c.email !== email) return `${email} → ${c.email} (no store)`;
  return `${email} (⚠️  ${c.warning ?? "sem resolução no store"})`;
}

export function renderPlanSummary(plan: TriagePlan, canonical?: CanonicalMap): string {
  const a = plan.actions;
  const c = plan.counts;
  const lines: string[] = [];
  lines.push(`Lote ${plan.batch_id} — ${plan.items.length} resposta(s): ` +
    `quero ${c.quero} · saída ${c.saida} · suporte ${c.suporte} · ruído ${c.ruido} · ambíguo ${c.ambiguo}`);
  lines.push("");
  for (const i of plan.items) {
    lines.push(`  [${i.kind}] ${i.email} — ${i.reason}`);
    if (i.snippet) lines.push(`      "${i.snippet}"`);
  }
  lines.push("");
  lines.push("Plano:");
  const list = (emails: string[]) => emails.map((e) => withCanonical(e, canonical)).join(", ");
  lines.push(`  priority_optin (+40): ${a.optin.length ? list(a.optin) : "(nenhum)"}`);
  lines.push(`  saída (blacklist Brevo + store): ${a.saida.length ? list(a.saida) : "(nenhuma)"}`);
  if (a.data_deletion.length) lines.push(`  ⚠️  exclusão de DADOS pedida (tratar à mão): ${a.data_deletion.join(", ")}`);
  if (a.conflitos.length) lines.push(`  ⚠️  quero E saída do mesmo e-mail (saída prevalece): ${a.conflitos.join(", ")}`);
  if (a.suporte.length) {
    lines.push("  encaminhar à Clarice (o script não encaminha):");
    for (const s of a.suporte) lines.push(`    - ${s.email} · ${s.date} · "${s.snippet}"`);
  }
  if (a.pendentes.length) {
    lines.push("  pendentes (ambíguos, sem ação):");
    for (const p of a.pendentes) lines.push(`    - ${p.email} · ${p.reason}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Aplicação
// ---------------------------------------------------------------------------

export interface ApplyDeps {
  db: DatabaseSync;
  /**
   * Coloca o contato na blacklist da Brevo da Clarice. Lança em erro; devolve `"not_found"` quando o
   * contato não existe na Brevo (#12265).
   */
  blacklist: (email: string) => Promise<void | "not_found">;
  /** E-mails do plano que o editor excluiu desta aplicação (`--skip`, #12283). Nada é feito com eles. */
  skip?: ReadonlySet<string>;
  now?: string;
  log?: (msg: string) => void;
}

/**
 * Aplica o plano (muta e devolve `plan.applied`). Ordem: optin → supressão
 * local + recompute → Brevo. `failures` reflete só esta execução.
 */
export async function applyTriagePlan(plan: TriagePlan, deps: ApplyDeps): Promise<TriagePlan> {
  const now = deps.now ?? new Date().toISOString();
  const log = deps.log ?? (() => {});
  const applied = plan.applied;
  applied.failures = [];
  applied.saida_brevo_not_found ??= [];
  const notFound = applied.saida_brevo_not_found;
  const skip = deps.skip ?? new Set<string>();
  for (const e of skip) log(`⏭️  ${e}: excluído desta aplicação (--skip)`);

  const optinTodo = plan.actions.optin.filter((e) => !applied.optin_done.includes(e) && !skip.has(e));
  for (const email of optinTodo) {
    try {
      addPriorityOptins(deps.db, [email], now, log);
      applied.optin_done.push(email);
    } catch (err) {
      applied.failures.push({ email, step: "optin", error: (err as Error).message });
    }
  }

  // email informado → email canônico do store (normalização Gmail, #2861).
  const canonical = new Map<string, string>();
  const skipped = new Set<string>();
  const saidaTodo = plan.actions.saida.filter((e) => !skip.has(e));
  for (const email of saidaTodo) {
    const r = resolveOptinEmail(deps.db, email);
    if (r.notice) log(r.notice);
    canonical.set(email, r.email);
    if (applied.saida_store_done.includes(email)) continue;
    try {
      // Conta de teste do editor (ou e-mail vazio): o store a ignora, e ela nunca vai pra blacklist da Brevo (review da PR #12261).
      if (!markSuppressedNow(deps.db, r.email, now)) {
        skipped.add(email);
        log(`⏭️  ${r.email}: conta de teste — ignorada (store e Brevo)`);
        continue;
      }
      applied.saida_store_done.push(email);
    } catch (err) {
      applied.failures.push({ email, step: "store", error: (err as Error).message });
    }
  }
  if (optinTodo.length > 0 || saidaTodo.length > 0) recomputeDerived(deps.db);

  for (const email of saidaTodo) {
    if (applied.saida_brevo_done.includes(email) || notFound.includes(email) || skipped.has(email)) continue;
    const target = canonical.get(email) ?? email;
    try {
      if ((await deps.blacklist(target)) === "not_found") {
        notFound.push(email);
        log(`🔎 Brevo: ${target} não existe na Brevo — suprimido no store; revise à mão o endereço que recebe a newsletter`);
        continue;
      }
      applied.saida_brevo_done.push(email);
      log(`🚫 Brevo: ${target} na blacklist`);
    } catch (err) {
      applied.failures.push({ email, step: "brevo", error: (err as Error).message });
      log(`❌ Brevo: ${target} falhou — ${(err as Error).message}`);
    }
  }

  applied.last_applied_at = now;
  return plan;
}

export function pendingBrevoCount(plan: TriagePlan, skip: ReadonlySet<string> = new Set()): number {
  // Conta de teste nunca vai pra Brevo (#12261): não exige a chave só por ela.
  const notFound = plan.applied.saida_brevo_not_found ?? [];
  return plan.actions.saida.filter(
    (e) => !plan.applied.saida_brevo_done.includes(e) && !notFound.includes(e) && !isTestAccount(e) && !skip.has(e),
  ).length;
}

export interface BrevoBlacklistIo {
  put: (path: string, body: unknown) => Promise<unknown>;
  /** GET que devolve o status (404 não lança), como `brevoGet`. */
  get: (path: string) => Promise<{ status: number }>;
}

/**
 * Blacklist via `PUT /contacts/{email}`. Se o PUT falha, um GET do mesmo contato separa "não existe
 * na Brevo" (404 → `"not_found"`, fora de `failures`) de erro de verdade (relança o erro do PUT) —
 * sem isso o 404 de um alias falhava para sempre a cada reexecução (#12265). O GET só roda depois de
 * uma falha, então o caminho feliz segue com 1 chamada.
 */
export function blacklisterFromIo(io: BrevoBlacklistIo): (email: string) => Promise<void | "not_found"> {
  return async (email) => {
    const path = `/contacts/${encodeURIComponent(email)}`;
    try {
      await io.put(path, { emailBlacklisted: true });
    } catch (err) {
      let status: number | null = null;
      try {
        status = (await io.get(path)).status;
      } catch {
        // GET também falhou: o erro que vale é o do PUT.
      }
      if (status === 404) return "not_found";
      throw err;
    }
  };
}

async function makeBrevoBlacklister(apiKey: string): Promise<(email: string) => Promise<void | "not_found">> {
  const { brevoPut, brevoGet } = await import("./lib/brevo-client.ts");
  return blacklisterFromIo({
    put: (path, body) => brevoPut(apiKey, path, body),
    get: (path) => brevoGet(apiKey, path),
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(
  argv: string[] = process.argv.slice(2),
  overrides: { reader?: ReplyReader; blacklist?: (email: string) => Promise<void | "not_found"> } = {},
): Promise<number> {
  const planDir = getArg(argv, "plan-dir") || DEFAULT_PLAN_DIR;
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;

  if (hasFlag(argv, "apply")) {
    const batchId = getArg(argv, "confirm");
    if (!batchId) {
      console.error("❌ --apply exige --confirm {lote} (o id impresso na listagem). Nada aplicado.");
      return 1;
    }
    const path = planPath(planDir, batchId);
    if (!existsSync(path)) {
      console.error(`❌ plano ${path} não existe — liste o lote antes (sem --apply). Nada aplicado.`);
      return 1;
    }
    const plan = loadPlan(path);
    if (plan.batch_id !== batchId) {
      console.error(`❌ plano ${path} tem id ${plan.batch_id}, não ${batchId}. Nada aplicado.`);
      return 1;
    }
    // O arquivo é o que o editor viu na listagem; se foi editado/corrompido depois, o id ou as ações
    // não batem mais com os itens, e aplicar seria executar algo que ninguém confirmou (#12265).
    const integrity = validatePlanIntegrity(plan);
    if (integrity.length > 0) {
      console.error(`❌ plano ${path} não confere com os próprios itens — liste o lote de novo. Nada aplicado.`);
      for (const p of integrity) console.error(`  - ${p}`);
      return 1;
    }
    // --skip a@x,b@y: tira da aplicação itens que o editor viu classificados errado (#12283). O plano
    // fica como está (o id não muda); quem foi pulado não é marcado como feito.
    const skip = new Set(
      (getArg(argv, "skip") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    const known = new Set([...plan.actions.optin, ...plan.actions.saida]);
    const unknown = [...skip].filter((e) => !known.has(e));
    if (unknown.length > 0) {
      console.error(`❌ --skip cita e-mail(s) sem ação neste lote: ${unknown.join(", ")}. Nada aplicado.`);
      return 1;
    }
    let blacklist = overrides.blacklist;
    if (!blacklist && pendingBrevoCount(plan, skip) > 0) {
      loadProjectEnv();
      const apiKey = process.env.BREVO_CLARICE_API_KEY;
      if (!apiKey) {
        console.error("❌ BREVO_CLARICE_API_KEY ausente no env — saída pendente na Brevo não pode ser aplicada. Nada aplicado.");
        return 1;
      }
      blacklist = await makeBrevoBlacklister(apiKey);
    }
    const db = openClariceDb(dbPath);
    try {
      await applyTriagePlan(plan, {
        db,
        blacklist: blacklist ?? (async () => {}),
        skip,
        log: (m) => console.error(m),
      });
    } finally {
      db.close();
      writeFileAtomic(path, JSON.stringify(plan, null, 2) + "\n");
    }
    const a = plan.applied;
    const summary = {
      batch_id: plan.batch_id,
      plan_path: path,
      optin_done: a.optin_done.length,
      saida_store_done: a.saida_store_done.length,
      saida_brevo_done: a.saida_brevo_done.length,
      saida_brevo_not_found: a.saida_brevo_not_found ?? [],
      skipped: [...skip].sort(),
      failures: a.failures,
      data_deletion_manual: plan.actions.data_deletion,
      suporte_encaminhar: plan.actions.suporte.length,
      pendentes: plan.actions.pendentes.length,
    };
    console.log(JSON.stringify(summary, null, 2));
    if ((a.saida_brevo_not_found ?? []).length > 0) {
      console.error(
        `\n🔎 fora da Brevo (suprimidos no store, revisar à mão o endereço que recebe a newsletter): ` +
          `${(a.saida_brevo_not_found ?? []).join(", ")}`,
      );
    }
    if (a.failures.length > 0) {
      console.error(`\n❌ ${a.failures.length} falha(s):`);
      for (const f of a.failures) console.error(`  - ${f.email} [${f.step}]: ${f.error}`);
      console.error(`Reexecute \`--apply --confirm ${plan.batch_id}\` para retentar só esses.`);
      return 1;
    }
    console.error(
      `\n✅ Lote ${plan.batch_id} aplicado${skip.size ? ` (exceto ${[...skip].sort().join(", ")}, pulados com --skip)` : ""}.`,
    );
    return 0;
  }

  const inputPath = getArg(argv, "input");
  const days = getIntArg(argv, "days", { min: 1 }) ?? DEFAULT_DAYS;
  const max = getIntArg(argv, "max", { min: 1 }) ?? DEFAULT_MAX;
  const query =
    getArg(argv, "query") ||
    buildDefaultQuery({ to: getArg(argv, "to") || undefined, subject: getArg(argv, "subject") || undefined, days });
  const reader = overrides.reader ?? (inputPath ? makeFileReader(inputPath) : makeGmailReader());
  const messages = await reader.list(query, max);
  if (messages.length === 0) {
    console.error(
      `⚠️  nenhuma resposta encontrada (query: ${inputPath ? `--input ${inputPath}` : query}). ` +
        `Se esperava respostas, confira se a conta OAuth de data/.credentials.json recebe ${DEFAULT_REPLY_TO}.`,
    );
  }
  const plan = buildTriagePlan(messages, { query: inputPath ? null : query });
  const path = savePlan(planDir, plan);
  // Store presente: mostra já o endereço canônico que o --apply vai usar (#12265). Sem store, a
  // listagem segue sem o mapeamento; só abre o store se o arquivo já existe (não cria um vazio).
  let canonical: CanonicalMap | undefined;
  if ((plan.actions.optin.length > 0 || plan.actions.saida.length > 0) && existsSync(dbPath)) {
    const db = openClariceDb(dbPath);
    try {
      canonical = resolveCanonicalTargets(db, plan);
    } finally {
      db.close();
    }
  }
  console.error(renderPlanSummary(plan, canonical));
  console.error(`\nPlano gravado em ${path}. Nada foi aplicado.`);
  console.error(`Para aplicar: npx tsx scripts/clarice-replies-triage.ts --apply --confirm ${plan.batch_id} [--skip e-mail1,e-mail2]`);
  console.log(JSON.stringify({ batch_id: plan.batch_id, plan_path: path, counts: plan.counts }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`❌ ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
