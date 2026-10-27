#!/usr/bin/env tsx
/**
 * purge-leaderboard.ts
 *
 * Full-purge de uma conta do KV do Worker `poll` — útil pra limpar test
 * accounts que vazaram pro leaderboard. Suporta 2 modos de seleção:
 *
 *   --nickname <name>  Scaneia score-by-month:* e score:* (case-insensitive)
 *                      por nickname e coleta os emails que batem. Usar quando
 *                      a entrada aparece no leaderboard como "Teste" (sem
 *                      saber o email direto).
 *
 *   --email <email>    Targeting direto pelo email. Usar quando a entrada
 *                      aparece como email mascarado (`x@***`) — nickname é
 *                      null e nicknameNicknameScan não encontra.
 *
 * Em ambos os modos, deleta tudo relacionado:
 *
 *   - `score:{email}`              (global score + nickname)
 *   - `score-by-month:*:{email}`   (todos os meses)
 *   - `vote:{edition}:{email}`     (todos os votos individuais)
 *   - `counted:{edition}:{email}:{stats,score,month}` (#3976 — guard-keys
 *                                   idempotentes de incremento por voto; nunca
 *                                   eram purgados antes, ficavam órfãos no KV
 *                                   com TTL de 90 dias mesmo após o resto da
 *                                   conta ser apagado. Derivado deterministicamente
 *                                   da edition de cada `vote:*` encontrado —
 *                                   sem scan adicional)
 *   - `seq:{month}:{identity}`     (#4470 — agregado mensal edição→gabarito/
 *                                   resposta introduzido pelo #4443. Sem
 *                                   apagar isso junto, um usuário purgado que
 *                                   jogue de novo faz `handleJogarSeqState`
 *                                   ressuscitar respostas de edições
 *                                   supostamente purgadas via self-heal a
 *                                   partir desse agregado stale)
 *   - `stats:{edition}`            (decrementa total/voted_a/voted_b/correct_count
 *                                   pra refletir os votes apagados)
 *   - `leaderboard-snapshot:{slug}` (invalida snapshots dos meses afetados)
 *
 * #4433: no modo `--email`, resolve TAMBÉM as identidades anônimas
 * (`{uuid}@web.eia.diaria.local`, brand `web`) ligadas ao e-mail via
 * `identify-linked:{email}:{anonEmail}` — o jogo público (`/jogar`) joga a
 * partida real sob a identidade anônima e só vincula depois; o merge nunca
 * apaga `score:{anonEmail}`/`vote:{edition}:{anonEmail}`, então purgar só a
 * casca do e-mail deixava os votos de verdade competindo no leaderboard. Ver
 * `scripts/lib/purge-leaderboard-plan.ts` (`resolveLinkedAnonymousIdentities`)
 * pra lógica + rationale completo. As próprias chaves `identify-linked:*` são
 * apagadas no fim (ficariam órfãs).
 *
 * Auth do KV (#11253, revisa o #2265) — dois backends, escolhidos de forma
 * determinística e logada no início (`scripts/lib/purge-kv-backend.ts`):
 *   1. `wrangler` logado via OAuth (`wrangler whoami` com o env sanitizado,
 *      o mesmo de `scripts/check-wrangler-auth.ts`) → backend WRANGLER, o
 *      caminho de sempre do Neo. O #2265 tirou CLOUDFLARE_API_TOKEN/ACCOUNT_ID
 *      do env do wrangler porque o token avulso de então dava 401 sem
 *      permissão de KV; isso continua valendo para este backend.
 *   2. Sem login OAuth (servidor `300`: `wrangler login` precisa de
 *      navegador) e com CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID no env →
 *      backend REST: API REST do KV com `Authorization: Bearer` (cliente em
 *      `scripts/lib/cloudflare-kv-rest.ts`). Em 27/10/2026 o token do `.env`
 *      lia e gravava no POLL (probe manual, #11253); `--check-auth` refaz a prova.
 *   3. Nenhum dos dois → erro claro, exit 1.
 * `--kv-backend wrangler|rest` força um backend (default `auto`).
 * `--check-auth` resolve o backend, faz o probe de LEITURA e ESCRITA dele
 * (list + PUT/DELETE de uma chave sentinela, nos dois backends) e confere
 * que ADMIN_SECRET/POLL_ADMIN_SECRET está no env; sai 0 só se o `--execute`
 * tem tudo pra rodar — é o pré-check do §6h do Stage 6.
 *
 * Uso:
 *   npx tsx scripts/purge-leaderboard.ts --nickname Teste --brand clarice
 *   npx tsx scripts/purge-leaderboard.ts --email test@example.com --brand clarice
 *   # --brand web (#3976): jogo público standalone (/jogar) — mesma mecânica,
 *   # útil pra purgar tokens forjados/entradas fantasma do leaderboard do jogo:
 *   npx tsx scripts/purge-leaderboard.ts --email verify1840428@web.eia.diaria.local --brand web
 *
 *   # Dry-run é o default — só mostra o que seria apagado.
 *   # Pra executar de fato, passar --execute:
 *   npx tsx scripts/purge-leaderboard.ts --email test@example.com --brand clarice --execute
 *
 *   # Pré-check de auth do KV (§6h do Stage 6) — sai 0 se algum backend serve:
 *   npx tsx scripts/purge-leaderboard.ts --check-auth
 *
 *   # --edition-dir <dir> (#11311): grava o resultado do --check-auth e de cada
 *   # --email X --execute em <dir>/_internal/leaderboard-purge.json — o Resumo
 *   # final do Stage 6 lê via `scripts/lib/leaderboard-purge-state.ts --summary`.
 *
 * Variáveis de ambiente (#4474):
 *   ADMIN_SECRET (ou POLL_ADMIN_SECRET)  HMAC key pro endpoint
 *     /admin/purge-score-do — necessária SÓ em --execute (dry-run roda sem
 *     ela, só imprime o plano). Sem ela, --execute falha alto e claro em vez
 *     de seguir silenciosamente sem purgar o storage do DO ScoreCounter.
 *   POLL_WORKER_URL   override da URL base do Worker poll (default:
 *     https://eia.diar.ia.br — ver scripts/lib/canonical-urls.ts).
 */

// #2265+#4474: dotenv AGORA é carregado (import "dotenv/config" abaixo) — o
// risco original (CLOUDFLARE_API_TOKEN sem permissão de KV vazando pro
// wrangler filho e forçando 401) continua fechado porque `wrangler()`
// abaixo SEMPRE deleta CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID do env do
// FILHO antes de invocar, incondicionalmente — não importa como essas vars
// chegaram em `process.env` deste processo (dotenv, shell export,
// .env), o strip acontece do mesmo jeito. (#11253: o token do `.env` agora
// também alimenta o backend REST, usado só quando o wrangler não tem login
// OAuth — ver o docstring do topo.) dotenv passou a ser
// necessário porque #4474 introduziu um 2º caminho de auth neste script —
// ADMIN_SECRET/POLL_ADMIN_SECRET (mesmas vars que `close-poll.ts` já lê do
// .env) — pra assinar `POST /admin/purge-score-do` e apagar o storage do DO
// ScoreCounter. Sem dotenv, esse 2º caminho não teria como ler o secret do
// .env (só de env var já exportada no shell), quebrando --execute pra quem
// segue o setup documentado no README/CLAUDE.md.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildPurgePlan, type PurgeKvOps } from "./lib/purge-leaderboard-plan.ts";
import { purgeScoreCounterDo } from "./lib/purge-score-counter-do.ts"; // #4474
import { dohFetch } from "./lib/doh-fetch.ts"; // #4474
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts"; // #4474
import { summarizePurgeDoResults, type PurgeDoStepResult } from "./lib/purge-leaderboard-do-summary.ts"; // #4477 achado 1
import type { Brand } from "../workers/poll/src/lib.ts"; // #4477 achado 3
import { sanitizedCloudflareOAuthEnv } from "./lib/cloudflare-oauth-env.ts"; // #6900
import { resolveWranglerBin } from "./lib/resolve-wrangler-bin.ts"; // #7117
import { checkWranglerAuth } from "./check-wrangler-auth.ts"; // #11253
import { createKvRestOps, KV_PROBE_SENTINEL_KEY, type KvOps } from "./lib/cloudflare-kv-rest.ts"; // #11253
import {
  checkPurgeAuth,
  isWranglerKvNotFound,
  readKvBackendFlag,
  resolvePurgeKvBackend,
  type PurgeKvBackendChoice,
  type PurgeKvBackendOverride,
} from "./lib/purge-kv-backend.ts"; // #11253
import { deleteVotesAndAdjustStats } from "./lib/purge-vote-stats.ts"; // #11253 review A2
import {
  applyCheckAuth,
  applyEmailResult,
  LEADERBOARD_PURGE_STATE_RELPATH,
  readStateForUpsert,
  writeLeaderboardPurgeState,
} from "./lib/leaderboard-purge-state.ts"; // #11311

// #2265: NAMESPACE_ID do POLL (KV). Acesso pelo WRANGLER (OAuth) quando há login,
// senão pela API REST com CLOUDFLARE_API_TOKEN (#11253) — ver o docstring do topo.
const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace (KV)

// Roda o wrangler via `node <bin>` (sem npx/shell) — args como array, então
// chaves com chars especiais (ex: `{{+contact.email+}}`) passam literais, sem
// inferno de quoting. cwd=workers/poll p/ achar a config/auth. O binário é
// resolvido via `resolveWranglerBin` (#7117) — desde que `workers/` virou
// npm workspace, `wrangler` é hoistado pro node_modules da RAIZ, não mais
// `workers/poll/node_modules` (que não existe mais).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_DIR = resolve(ROOT, "workers", "poll");

// #7610 (review P2): resolvido LAZILY dentro de `wrangler`, não no import —
// igual o `check-wrangler-auth.ts` (#7606). `wrangler` é hoistado pro
// node_modules da raiz (#7117); um node_modules desatualizado onde ele não
// está hoistado até hoje matava o processo no import com stack trace bruto.
// Este script roda como `npx tsx scripts/purge-leaderboard.ts`, então o
// crash dava exit != 0 — aceitável por si só —, mas é o MESMO pattern do
// guard e o MESMO risco de regressão se o hoist mudar de novo.
function resolveWranglerBinLazy(): string {
  return resolveWranglerBin(import.meta.url);
}

function wrangler(wargs: string[]): string {
  // Tira CLOUDFLARE_API_TOKEN (auth) E CLOUDFLARE_ACCOUNT_ID (seleção de conta)
  // do env do filho — força o wrangler a resolver tudo pela auth OAuth do CLI.
  // Sem isso: o TOKEN avulso do .env dava 401; um ACCOUNT_ID errado no shell
  // daria 404. Conta única na auth OAuth → resolvida automaticamente (#2265).
  // Helper compartilhado com o guard `wrangler whoami` de §6h (#6900) — os
  // dois lados nunca podem divergir sobre qual env conta como "autenticado".
  const childEnv = sanitizedCloudflareOAuthEnv(process.env);
  return execFileSync(process.execPath, [resolveWranglerBinLazy(), ...wargs], {
    cwd: POLL_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
}

const args = process.argv.slice(2);
const execute = args.includes("--execute");

function flagValue(name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) return null;
  return args[idx + 1];
}

const checkAuthOnly = args.includes("--check-auth"); // #11253

const targetNickname = flagValue("--nickname")?.toLowerCase() ?? null;
const targetEmail = flagValue("--email")?.toLowerCase() ?? null;

// #11311: com `--edition-dir`, o resultado do `--check-auth` e de cada
// `--email X --execute` vai pra `{edition-dir}/_internal/leaderboard-purge.json`
// (§6h do Stage 6), que o Resumo final lê via
// `scripts/lib/leaderboard-purge-state.ts --summary`. Cada passo grava
// "não concluiu" ANTES de trabalhar, então timeout/kill no meio fica PENDENTE.
// Falha ao gravar é warn: nunca muda o exit code da purga em si.
const STATE_EDITION_DIR = flagValue("--edition-dir");

function recordState(write: () => void): void {
  if (!STATE_EDITION_DIR) return;
  try {
    write();
  } catch (e) {
    console.error(`[warn] não gravou ${LEADERBOARD_PURGE_STATE_RELPATH}: ${(e as Error).message}`);
  }
}

function recordCheckAuth(ok: boolean, backend: string | null, motivo: string | null): void {
  recordState(() => writeLeaderboardPurgeState(STATE_EDITION_DIR!, applyCheckAuth({ ok, backend, motivo }, new Date())));
}

function recordEmailResult(ok: boolean, keysDeleted: number | null, motivo: string | null): void {
  if (!targetEmail || !execute) return; // dry-run e --nickname não são o §6h
  recordState(() =>
    writeLeaderboardPurgeState(
      STATE_EDITION_DIR!,
      applyEmailResult(readStateForUpsert(STATE_EDITION_DIR!), targetEmail, { ok, keys_deleted: keysDeleted, motivo }, new Date()),
    ),
  );
}

let KV_BACKEND_OVERRIDE: PurgeKvBackendOverride = "auto";
try {
  KV_BACKEND_OVERRIDE = readKvBackendFlag(args);
} catch (e) {
  console.error(`[purge] ${(e as Error).message}`);
  process.exit(2);
}

if (checkAuthOnly) recordCheckAuth(false, null, "pré-check --check-auth não concluiu (timeout ou interrompido)");
else recordEmailResult(false, null, "purga não concluiu (timeout ou interrompida)");

if (!checkAuthOnly && (targetNickname === null) === (targetEmail === null)) {
  console.error(
    "Uso: purge-leaderboard.ts (--nickname <name> | --email <email>) [--brand diaria|clarice|web] " +
      "[--kv-backend auto|wrangler|rest] [--execute] [--edition-dir <dir>]",
  );
  console.error("     ou:  purge-leaderboard.ts --check-auth [--kv-backend auto|wrangler|rest] [--edition-dir <dir>]");
  console.error("     passe exatamente UM de --nickname ou --email");
  process.exit(2);
}

// #1905: namespace por marca. Vazio p/ diaria (chaves legadas), "clarice:" p/
// Clarice News, "web:" p/ o jogo público standalone (#3976 — leaderboard do
// jogo em /jogar também precisa de purge, ex: token forjado/entrada fantasma).
// Todas as chaves de KV (score/vote/stats/snapshot/counted) usam o prefixo.
const BRAND_ARG = flagValue("--brand");
const BRAND: Brand = BRAND_ARG === "clarice" ? "clarice" : BRAND_ARG === "web" ? "web" : "diaria";
const BP = BRAND === "diaria" ? "" : `${BRAND}:`;

// #4474: HMAC key pro endpoint /admin/purge-score-do (purga do storage
// interno do DO ScoreCounter). Mesma variável que close-poll.ts já lê
// (ADMIN_SECRET canônico, POLL_ADMIN_SECRET como alias usado em alguns
// ambientes). Ausente é OK em dry-run (só imprime o plano); --execute falha
// alto e claro logo abaixo, antes de fazer qualquer trabalho de rede.
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET ?? null;
const POLL_WORKER_URL = process.env.POLL_WORKER_URL ?? DIARIA_EIA_URL;

if (execute && !checkAuthOnly && !ADMIN_SECRET) {
  console.error(
    "[purge] ADMIN_SECRET (ou POLL_ADMIN_SECRET) não definido — necessário em --execute pra assinar " +
    "/admin/purge-score-do e apagar o storage do DO ScoreCounter (#4474). Ver .env.",
  );
  recordEmailResult(false, null, "ADMIN_SECRET (ou POLL_ADMIN_SECRET) não definido");
  process.exit(1);
}

// #2265: backend WRANGLER. `kv key list` já pagina internamente (retorna
// todas as chaves do prefixo). get/put/delete recebem a chave como arg literal.
// #11253: tipado pelo mesmo `KvOps` do backend REST — os dois contratos são
// checados em compilação.
const wranglerKv: KvOps = {
  async list(prefix) {
    const out = wrangler(["kv", "key", "list", "--namespace-id", NAMESPACE_ID, "--remote", "--prefix", prefix]);
    const arr = JSON.parse(out) as Array<{ name: string }>;
    return arr.map((k) => k.name);
  },
  async get(key) {
    try {
      // wrangler imprime o valor cru no stdout (banners vão p/ stderr); trim do \n final.
      return wrangler(["kv", "key", "get", "--namespace-id", NAMESPACE_ID, "--remote", key]).replace(/\n$/, "");
    } catch (e) {
      // chave inexistente → wrangler sai !=0 com "- 404: Not Found" no stderr.
      // Auth/rede (401/500) NÃO casam → re-lança (não engole como "vazio").
      // Só stderr/stdout: err.message carrega a chave (#11253 review A1).
      if (isWranglerKvNotFound(e)) return null;
      throw e;
    }
  },
  async put(key, value) {
    wrangler(["kv", "key", "put", "--namespace-id", NAMESPACE_ID, "--remote", key, value]);
  },
  async delete(key) {
    try {
      wrangler(["kv", "key", "delete", "--namespace-id", NAMESPACE_ID, "--remote", key]);
    } catch (e) {
      // 404 = já apagada; idempotente. Outros erros propagam.
      if (!isWranglerKvNotFound(e)) throw e;
    }
  },
  async probe() {
    // Leitura + escrita, como o probe REST: list de um prefixo que não casa com
    // nada + PUT/DELETE da sentinela. Lança (execFileSync) se qualquer um falhar.
    await wranglerKv.list(KV_PROBE_SENTINEL_KEY);
    await wranglerKv.put(KV_PROBE_SENTINEL_KEY, new Date().toISOString());
    await wranglerKv.delete(KV_PROBE_SENTINEL_KEY);
  },
};

// #11253: backend escolhido uma vez, no início de main() (ou em --check-auth).
let kv: KvOps | null = null;

function resolveBackend(): PurgeKvBackendChoice {
  return resolvePurgeKvBackend({
    env: process.env,
    checkWrangler: () => checkWranglerAuth(),
    override: KV_BACKEND_OVERRIDE,
  });
}

function restOpsFor(choice: Extract<PurgeKvBackendChoice, { backend: "rest" }>) {
  return createKvRestOps({ accountId: choice.accountId, token: choice.token, namespaceId: NAMESPACE_ID });
}

function opsFor(choice: Exclude<PurgeKvBackendChoice, { backend: "none" }>): KvOps {
  return choice.backend === "rest" ? restOpsFor(choice) : wranglerKv;
}

function activeKv(): KvOps {
  if (!kv) throw new Error("backend de KV não inicializado (bug: main() não resolveu o backend)");
  return kv;
}

async function kvList(prefix: string): Promise<string[]> {
  return activeKv().list(prefix);
}

async function kvGet(key: string): Promise<string | null> {
  return activeKv().get(key);
}

async function kvPut(key: string, value: string): Promise<void> {
  if (!execute) {
    console.log(`[dry-run] PUT ${key} (${value.length} bytes)`);
    return;
  }
  await activeKv().put(key, value);
}

async function kvDelete(key: string): Promise<void> {
  if (!execute) {
    console.log(`[dry-run] DELETE ${key}`);
    return;
  }
  await activeKv().delete(key);
}

/**
 * #11253: `--check-auth`. Exit 0 = o `--execute` tem tudo pra rodar: há
 * backend de KV, o probe dele LÊ e GRAVA no namespace (list + PUT/DELETE da
 * chave sentinela `__purge_probe__`, nos dois backends — inclusive com
 * `--kv-backend wrangler` forçado) e ADMIN_SECRET/POLL_ADMIN_SECRET está no
 * env. A única escrita é a sentinela, apagada em seguida. Lógica em
 * `checkPurgeAuth` (lib, testada).
 */
async function checkAuth(): Promise<void> {
  const choice = resolveBackend();
  const r = await checkPurgeAuth({ choice, opsFor, adminSecretPresent: Boolean(ADMIN_SECRET) });
  for (const line of r.err) console.error(line);
  for (const line of r.out) console.log(line);
  // #11311: motivo = 1a linha `[purge]` do stderr (o `[warn]` de fallback vem depois e não é a causa).
  const motivo = r.ok ? null : (r.err.find((l) => l.startsWith("[purge]")) ?? r.err[0] ?? "pré-check falhou").replace(/^\[purge\]\s*/, "");
  recordCheckAuth(r.ok, choice.backend === "none" ? null : choice.backend, motivo);
  if (!r.ok) process.exitCode = 1;
}

/**
 * #4474: purga o storage interno do DO ScoreCounter da identidade
 * `{BRAND}:{email}` via `POST /admin/purge-score-do` (ver rationale completo
 * em `scripts/lib/purge-score-counter-do.ts` e `workers/poll/src/
 * score-counter.ts`). Mesmo padrão dry-run de `kvPut`/`kvDelete` acima — só
 * imprime em dry-run, sem chamar rede nenhuma. SEMPRE usa o `BRAND` já
 * resolvido pro script inteiro (uma invocação = 1 brand só) — nunca itera
 * sobre os 3 brands.
 *
 * #4477 (fleet review #4383, achado 1): retorna `boolean` (sucesso/falha) em
 * vez de `void` — antes, uma falha aqui só virava um `console.error` isolado
 * por identidade, sem ser agregada pelo caller. `main()` coleta esse retorno
 * pra decidir `process.exitCode` no final (ver `summarizePurgeDoResults`).
 * Dry-run nunca fala com rede — sempre `true` (não há falha real pra
 * reportar; simular uma falha aqui seria inventar dado que a rede nunca
 * produziu).
 */
async function purgeScoreCounterDoStep(email: string): Promise<boolean> {
  if (!execute) {
    console.log(`[dry-run] PURGE DO score-counter para ${BRAND}:${email}`);
    return true;
  }
  // ADMIN_SECRET já foi validado (fail-fast acima) antes de qualquer trabalho
  // de rede acontecer — não-nulo aqui por construção.
  const result = await purgeScoreCounterDo(email, BRAND, ADMIN_SECRET!, POLL_WORKER_URL, dohFetch);
  if (result.ok) {
    console.log(`  [del] DO score-counter ${BRAND}:${email} (purged)`);
  } else {
    console.error(`  [warn] DO score-counter ${BRAND}:${email} purge falhou (status ${result.status}): ${result.error}`);
  }
  return result.ok;
}

// #4433: implementação real das operações de KV que buildPurgePlan (lib pura,
// testável sem wrangler) consome via injeção — mesmo padrão de KvSyncOps em
// sync-cursos-subscribers-kv.ts.
const kvOps: PurgeKvOps = { list: kvList, get: kvGet };

async function main(): Promise<void> {
  const target = targetEmail ? `email: "${targetEmail}"` : `nickname: "${targetNickname}"`;
  console.log(`[purge] mode: ${execute ? "EXECUTE" : "DRY-RUN"} — target ${target}`);

  // #11253: escolha do backend de KV, logada. Sem backend → falha alta antes
  // de qualquer leitura (o §6h do Stage 6 lista a purga como PENDENTE).
  const choice = resolveBackend();
  if (choice.backend === "none") {
    console.error(`[purge] ERRO: sem backend de KV — ${choice.reason}`);
    recordEmailResult(false, null, `sem backend de KV — ${choice.reason}`);
    process.exitCode = 1;
    return;
  }
  if (choice.backend === "rest" && choice.fallbackWarning) console.error(`[warn] ${choice.fallbackWarning}`);
  kv = opsFor(choice);
  console.log(`[purge] kv backend: ${choice.backend} — ${choice.reason}`);

  console.log(`[purge] brand: ${BRAND}${BP ? ` (prefixo "${BP}")` : ""}`);
  console.log("[purge] resolvendo plano (score-by-month, identify-linked, vote)...");

  // #4433: buildPurgePlan já resolve, num plano único, os e-mails-alvo + as
  // identidades anônimas ligadas via identify-linked (modo --email) — ver
  // scripts/lib/purge-leaderboard-plan.ts.
  const plan = await buildPurgePlan(kvOps, BP, targetEmail, targetNickname);

  if (plan.matchedEmails.length === 0) {
    console.log(`[purge] nada pra apagar — ${target} não existe no KV`);
    recordEmailResult(true, 0, null);
    return;
  }

  console.log(`[purge] ${plan.matchedEmails.length} email(s) match:`);
  for (const p of plan.plans) {
    console.log(`  - ${p.email}${p.linkedVia ? `  (identidade ligada via identify-linked de ${p.linkedVia.join(", ")}, não match direto)` : ""}`);
  }
  if (plan.identifyLinkedKeys.length > 0) {
    console.log(`[purge] identify-linked keys a apagar no fim (${plan.identifyLinkedKeys.length}):`);
    for (const k of plan.identifyLinkedKeys) console.log(`    - ${k}`);
  }

  // Print plano
  let totalKeys = 0;
  for (const p of plan.plans) {
    console.log(`\n[plan] ${p.email}`);
    console.log(`  score:        ${p.scoreKey} ${p.scoreExists ? "(exists)" : "(not found)"}`);
    console.log(`  score-by-month (${p.sbmKeys.length}):`);
    for (const k of p.sbmKeys) console.log(`    - ${k}`);
    console.log(`  vote (${p.voteKeys.length}):`);
    for (const k of p.voteKeys) console.log(`    - ${k}`);
    console.log(`  counted (${p.countedKeys.length}):`);
    for (const k of p.countedKeys) console.log(`    - ${k}`);
    console.log(`  seq (${p.seqKeys.length}):`);
    for (const k of p.seqKeys) console.log(`    - ${k}`);
    totalKeys += (p.scoreExists ? 1 : 0) + p.sbmKeys.length + p.voteKeys.length + p.countedKeys.length + p.seqKeys.length;
  }
  totalKeys += plan.identifyLinkedKeys.length;

  console.log(`\n[purge] snapshots a invalidar: ${plan.slugsTouched.join(", ") || "(nenhum)"}`);
  console.log(`[purge] total de keys a deletar: ${totalKeys}`);

  if (totalKeys === 0) {
    console.log("[purge] nada pra apagar.");
    recordEmailResult(true, 0, null);
    return;
  }

  // #4474: purga o storage interno do DO ScoreCounter de CADA identidade do
  // plano (target + identidades anônimas ligadas via #4433) — sempre sob o
  // MESMO BRAND já resolvido pro script inteiro (nunca itera os 3 brands).
  // Roda em AMBOS os modos (dry-run só imprime, execute chama de fato) —
  // diferente da purga de KV abaixo, que só roda dentro do ramo `execute`
  // (aqui é o único jeito do dry-run sinalizar que o storage do DO também
  // seria tocado).
  console.log(`\n[purge] storage do DO ScoreCounter (${plan.plans.length} identidade(s)):`);
  // #4477 achado 1: coleta o resultado de CADA identidade (não só imprime)
  // pra poder agregar falhas parciais no final — ver bloco de erro logo
  // antes do fim de main().
  const doStepResults: PurgeDoStepResult[] = [];
  for (const p of plan.plans) {
    const ok = await purgeScoreCounterDoStep(p.email);
    doStepResults.push({ email: p.email, ok });
  }
  const doSummary = summarizePurgeDoResults(doStepResults);

  if (!execute) {
    console.log("\n[purge] DRY-RUN — passe --execute pra apagar de fato.");
    return;
  }

  // #11253 review A2: votos ANTES dos stats, e os stats só descontam o que foi
  // de fato apagado — uma falha de DELETE no meio + re-run não desconta duas
  // vezes (ver scripts/lib/purge-vote-stats.ts).
  console.log("\n[purge] deletando votos...");
  await deleteVotesAndAdjustStats(
    { get: kvGet, put: kvPut, delete: kvDelete },
    plan.plans.flatMap((p) => p.voteKeys),
    BP,
    (line) => console.log(line),
  );

  console.log("\n[purge] deletando keys...");
  for (const p of plan.plans) {
    if (p.scoreExists) { await kvDelete(p.scoreKey); console.log(`  [del] ${p.scoreKey}`); }
    for (const k of p.sbmKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
    // #3976: counted:* são guard-keys idempotentes (podem já ter expirado via
    // TTL de 90 dias) — kvDelete já é 404-safe/idempotente, mesmo tratamento
    // dos demais deletes acima.
    for (const k of p.countedKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
    // #4470: agregado seq:{month}:{identity} (#4443) — sem apagar isso junto,
    // o self-heal de handleJogarSeqState ressuscita respostas/gabarito de
    // edições supostamente purgadas se essa identidade jogar de novo.
    for (const k of p.seqKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
  }

  // #4433: chaves identify-linked:{email}:{anonEmail} ficam órfãs depois que
  // a identidade ligada (e o próprio e-mail) são purgados — apagadas por
  // último, depois de tudo que elas apontavam já ter sido removido.
  if (plan.identifyLinkedKeys.length > 0) {
    console.log("\n[purge] deletando identify-linked keys...");
    for (const k of plan.identifyLinkedKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
  }

  console.log("\n[purge] invalidando snapshots...");
  for (const slug of plan.slugsTouched) {
    await kvDelete(`${BP}leaderboard-snapshot:${slug}`);
    console.log(`  [del] ${BP}leaderboard-snapshot:${slug}`);
  }

  console.log(`\n[purge] done — ${totalKeys} keys apagadas, ${plan.slugsTouched.length} snapshots invalidados.`);

  // #4477 (fleet review #4383, achado 1): reportado DEPOIS da linha "done" de
  // sucesso do KV, de propósito — a purga de KV nunca é abortada por causa
  // disso (filosofia fail-soft preservada). Mas se a purga do storage do DO
  // falhou pra qualquer identidade, isso precisa ficar CLARO e DISTINTO (via
  // console.error, não console.log) e setar exit code != 0 — sem isso, o
  // único consumidor documentado deste script
  // (.claude/skills/diaria-remover-votos-pixel/SKILL.md) confirma sucesso só
  // olhando o leaderboard, nunca lendo warnings no meio do output, e o
  // cenário que o #4474 existe pra fechar (identidade purgada ressuscita
  // voto) continuaria acontecendo silenciosamente.
  if (doSummary.shouldFailExitCode) {
    console.error(
      `\n[purge] ERRO: a purga do storage do DO ScoreCounter FALHOU para ${doSummary.failures.length} de ` +
      `${plan.plans.length} identidade(s). O KV foi limpo, mas o storage interno do DO ScoreCounter NÃO — ` +
      `essas identidades continuam vulneráveis ao cenário do #4474 (voto ressuscitado se votarem de novo no ` +
      `mesmo mês civil) até uma nova execução bem-sucedida deste script (re-rodar não desconta stats:* de novo — ` +
      `só votos ainda presentes entram no ajuste).`,
    );
    for (const email of doSummary.failures) {
      console.error(`  [FALHOU] DO score-counter ${BRAND}:${email}`);
    }
    recordEmailResult(
      false,
      totalKeys,
      `KV limpo, mas a purga do DO ScoreCounter falhou para ${doSummary.failures.length} identidade(s)`,
    );
    process.exitCode = 1;
  } else {
    recordEmailResult(true, totalKeys, null);
  }
}

(checkAuthOnly ? checkAuth() : main()).catch((e) => {
  console.error("[purge] erro:", e);
  const motivo = `erro: ${(e as Error)?.message ?? String(e)}`.split("\n")[0];
  if (checkAuthOnly) recordCheckAuth(false, null, motivo);
  else recordEmailResult(false, null, motivo);
  process.exit(1);
});
