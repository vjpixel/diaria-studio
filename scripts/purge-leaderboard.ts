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
 * Auth (#2265): usa o WRANGLER (auth global do CLI — a mesma do `wrangler deploy`),
 * NÃO mais CLOUDFLARE_API_TOKEN/ACCOUNT_ID (o token avulso dava 401 sem perm de KV).
 * Pré-requisito: `wrangler` logado (`npx wrangler whoami` deve funcionar).
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
// .env.local), o strip acontece do mesmo jeito. dotenv passou a ser
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

// #2265: NAMESPACE_ID do POLL (KV). Auth e acesso ao KV vão pelo WRANGLER (auth
// global do CLI), não mais pela CF REST API com CLOUDFLARE_API_TOKEN — o token
// avulso vivia dando 401 (sem permissão de KV) e quebrava purge + /diaria-remover-votos-pixel.
const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace (KV)

// Roda o wrangler instalado em workers/poll via `node <bin>` (sem npx/shell) —
// args como array, então chaves com chars especiais (ex: `{{+contact.email+}}`)
// passam literais, sem inferno de quoting. cwd=workers/poll p/ achar a config/auth.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_DIR = resolve(ROOT, "workers", "poll");
const WRANGLER_BIN = resolve(POLL_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

function wrangler(wargs: string[]): string {
  // Tira CLOUDFLARE_API_TOKEN (auth) E CLOUDFLARE_ACCOUNT_ID (seleção de conta)
  // do env do filho — força o wrangler a resolver tudo pela auth OAuth do CLI.
  // Sem isso: o TOKEN avulso do .env dava 401; um ACCOUNT_ID errado no shell
  // daria 404. Conta única na auth OAuth → resolvida automaticamente (#2265).
  const childEnv = { ...process.env };
  delete childEnv.CLOUDFLARE_API_TOKEN;
  delete childEnv.CLOUDFLARE_ACCOUNT_ID;
  return execFileSync(process.execPath, [WRANGLER_BIN, ...wargs], {
    cwd: POLL_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
}

function wranglerErrText(e: unknown): string {
  const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  return [err.stderr, err.stdout, err.message].map((x) => x?.toString() ?? "").join(" ");
}

const args = process.argv.slice(2);
const execute = args.includes("--execute");

function flagValue(name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) return null;
  return args[idx + 1];
}

const targetNickname = flagValue("--nickname")?.toLowerCase() ?? null;
const targetEmail = flagValue("--email")?.toLowerCase() ?? null;

if ((targetNickname === null) === (targetEmail === null)) {
  console.error("Uso: purge-leaderboard.ts (--nickname <name> | --email <email>) [--brand diaria|clarice|web] [--execute]");
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

if (execute && !ADMIN_SECRET) {
  console.error(
    "[purge] ADMIN_SECRET (ou POLL_ADMIN_SECRET) não definido — necessário em --execute pra assinar " +
    "/admin/purge-score-do e apagar o storage do DO ScoreCounter (#4474). Ver .env.",
  );
  process.exit(1);
}

// #2265: helpers via wrangler. `kv key list` já pagina internamente (retorna
// todas as chaves do prefixo). get/put/delete recebem a chave como arg literal.
async function kvList(prefix: string): Promise<string[]> {
  const out = wrangler(["kv", "key", "list", "--namespace-id", NAMESPACE_ID, "--remote", "--prefix", prefix]);
  const arr = JSON.parse(out) as Array<{ name: string }>;
  return arr.map((k) => k.name);
}

async function kvGet(key: string): Promise<string | null> {
  try {
    // wrangler imprime o valor cru no stdout (banners vão p/ stderr); trim do \n final.
    return wrangler(["kv", "key", "get", "--namespace-id", NAMESPACE_ID, "--remote", key]).replace(/\n$/, "");
  } catch (e) {
    // chave inexistente → wrangler sai !=0 com "404: Not Found" no stderr (verificado).
    // Auth/rede (401/500) NÃO casam → re-lança (não engole como "vazio").
    if (/not found|404|could not find/i.test(wranglerErrText(e))) return null;
    throw e;
  }
}

async function kvPut(key: string, value: string): Promise<void> {
  if (!execute) {
    console.log(`[dry-run] PUT ${key} (${value.length} bytes)`);
    return;
  }
  wrangler(["kv", "key", "put", "--namespace-id", NAMESPACE_ID, "--remote", key, value]);
}

async function kvDelete(key: string): Promise<void> {
  if (!execute) {
    console.log(`[dry-run] DELETE ${key}`);
    return;
  }
  try {
    wrangler(["kv", "key", "delete", "--namespace-id", NAMESPACE_ID, "--remote", key]);
  } catch (e) {
    // 404 = já apagada; idempotente. Outros erros propagam.
    if (!/not found|404|could not find/i.test(wranglerErrText(e))) throw e;
  }
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

interface VoteRecord { choice: "A" | "B"; ts: string; correct: boolean | null }
interface StatsRecord { total: number; voted_a: number; voted_b: number; correct_count: number }

// #4433: implementação real das operações de KV que buildPurgePlan (lib pura,
// testável sem wrangler) consome via injeção — mesmo padrão de KvSyncOps em
// sync-cursos-subscribers-kv.ts.
const kvOps: PurgeKvOps = { list: kvList, get: kvGet };

async function main(): Promise<void> {
  const target = targetEmail ? `email: "${targetEmail}"` : `nickname: "${targetNickname}"`;
  console.log(`[purge] mode: ${execute ? "EXECUTE" : "DRY-RUN"} — target ${target}`);

  console.log(`[purge] brand: ${BRAND}${BP ? ` (prefixo "${BP}")` : ""}`);
  console.log("[purge] resolvendo plano (score-by-month, identify-linked, vote)...");

  // #4433: buildPurgePlan já resolve, num plano único, os e-mails-alvo + as
  // identidades anônimas ligadas via identify-linked (modo --email) — ver
  // scripts/lib/purge-leaderboard-plan.ts.
  const plan = await buildPurgePlan(kvOps, BP, targetEmail, targetNickname);

  if (plan.matchedEmails.length === 0) {
    console.log(`[purge] nada pra apagar — ${target} não existe no KV`);
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

  // Ajustar stats:{edition} antes de deletar (precisa do choice + correct)
  const statsAdjust = new Map<string, { dTotal: number; dA: number; dB: number; dCorrect: number }>();
  for (const p of plan.plans) {
    for (const vk of p.voteKeys) {
      const m = vk.match(new RegExp(`^${BP}vote:(\\d{6}):`));
      if (!m) continue;
      const edition = m[1];
      const raw = await kvGet(vk);
      if (!raw) continue;
      let v: VoteRecord;
      try { v = JSON.parse(raw); } catch { continue; }
      const cur = statsAdjust.get(edition) ?? { dTotal: 0, dA: 0, dB: 0, dCorrect: 0 };
      cur.dTotal += 1;
      if (v.choice === "A") cur.dA += 1;
      if (v.choice === "B") cur.dB += 1;
      if (v.correct === true) cur.dCorrect += 1;
      statsAdjust.set(edition, cur);
    }
  }

  console.log(`\n[purge] ajustando stats:{edition} pra ${statsAdjust.size} edition(s)...`);
  for (const [edition, delta] of statsAdjust) {
    const sKey = `${BP}stats:${edition}`;
    const raw = await kvGet(sKey);
    if (!raw) { console.log(`  [skip] ${sKey} não existe`); continue; }
    let s: StatsRecord;
    try { s = JSON.parse(raw); } catch { console.log(`  [skip] ${sKey} parse error`); continue; }
    s.total = Math.max(0, s.total - delta.dTotal);
    s.voted_a = Math.max(0, s.voted_a - delta.dA);
    s.voted_b = Math.max(0, s.voted_b - delta.dB);
    s.correct_count = Math.max(0, s.correct_count - delta.dCorrect);
    await kvPut(sKey, JSON.stringify(s));
    console.log(`  [adj]  ${sKey} → total=${s.total} a=${s.voted_a} b=${s.voted_b} correct=${s.correct_count}`);
  }

  console.log("\n[purge] deletando keys...");
  for (const p of plan.plans) {
    if (p.scoreExists) { await kvDelete(p.scoreKey); console.log(`  [del] ${p.scoreKey}`); }
    for (const k of p.sbmKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
    for (const k of p.voteKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
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
      `mesmo mês civil) até uma nova execução bem-sucedida deste script (idempotente — seguro re-rodar).`,
    );
    for (const email of doSummary.failures) {
      console.error(`  [FALHOU] DO score-counter ${BRAND}:${email}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[purge] erro:", e);
  process.exit(1);
});
