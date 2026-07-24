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
 *   - `stats:{edition}`            (decrementa total/voted_a/voted_b/correct_count
 *                                   pra refletir os votes apagados)
 *   - `leaderboard-snapshot:{slug}` (invalida snapshots dos meses afetados)
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
 */

// #2265: NÃO carregamos dotenv. O .env tem um CLOUDFLARE_API_TOKEN sem permissão
// de KV; se ele entrar no process.env, o wrangler filho o herda e usa ESSE token
// (401) em vez da auth OAuth global do CLI. Sem env de auth = wrangler usa OAuth.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
const BRAND = BRAND_ARG === "clarice" ? "clarice" : BRAND_ARG === "web" ? "web" : "diaria";
const BP = BRAND === "diaria" ? "" : `${BRAND}:`;

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

interface VoteRecord { choice: "A" | "B"; ts: string; correct: boolean | null }
interface StatsRecord { total: number; voted_a: number; voted_b: number; correct_count: number }

/**
 * Resolve a lista de emails a purgar a partir do modo selecionado.
 * - Modo --nickname: scan score-by-month:* + score:* por nickname match.
 * - Modo --email: o próprio email é o target (sem scan).
 */
async function resolveTargetEmails(sbmKeys: string[]): Promise<Set<string>> {
  const matched = new Set<string>();

  if (targetEmail) {
    matched.add(targetEmail);
    return matched;
  }

  // Modo --nickname: scan score-by-month:* primeiro
  for (const key of sbmKeys) {
    const m = key.match(new RegExp(`^${BP}score-by-month:(\\d{4}-\\d{2}):(.+)$`));
    if (!m) continue;
    const [, , email] = m;
    const raw = await kvGet(key);
    if (!raw) continue;
    let entry: { nickname?: string | null };
    try { entry = JSON.parse(raw); } catch { continue; }
    if ((entry.nickname ?? "").toLowerCase() === targetNickname) {
      matched.add(email);
    }
  }

  // Fallback: nickname pode ter sido seteado sem nenhum vote (entry score:*
  // sem score-by-month correspondente). Varre score:* também.
  if (matched.size === 0) {
    console.log("[purge] sem match em score-by-month:* — escaneando score:* tambem...");
    const scoreKeys = await kvList(`${BP}score:`);
    for (const key of scoreKeys) {
      const email = key.replace(new RegExp(`^${BP}score:`), "");
      const raw = await kvGet(key);
      if (!raw) continue;
      let entry: { nickname?: string | null };
      try { entry = JSON.parse(raw); } catch { continue; }
      if ((entry.nickname ?? "").toLowerCase() === targetNickname) {
        matched.add(email);
      }
    }
  }

  return matched;
}

async function main(): Promise<void> {
  const target = targetEmail ? `email: "${targetEmail}"` : `nickname: "${targetNickname}"`;
  console.log(`[purge] mode: ${execute ? "EXECUTE" : "DRY-RUN"} — target ${target}`);

  console.log(`[purge] brand: ${BRAND}${BP ? ` (prefixo "${BP}")` : ""}`);
  console.log("[purge] listando score-by-month:* keys...");
  const sbmKeys = await kvList(`${BP}score-by-month:`);
  console.log(`[purge] ${sbmKeys.length} score-by-month entries no KV`);

  const matchedEmails = await resolveTargetEmails(sbmKeys);

  if (matchedEmails.size === 0) {
    console.log(`[purge] nada pra apagar — ${target} não existe no KV`);
    return;
  }

  console.log(`[purge] ${matchedEmails.size} email(s) match:`);
  for (const e of matchedEmails) console.log(`  - ${e}`);

  // Pra cada email, listar todas as keys relacionadas
  type Plan = { email: string; scoreKey: string; sbmKeys: string[]; voteKeys: string[]; countedKeys: string[]; scoreExists: boolean };
  const plans: Plan[] = [];
  const slugsTouched = new Set<string>();

  for (const email of matchedEmails) {
    const plan: Plan = {
      email,
      scoreKey: `${BP}score:${email}`,
      sbmKeys: sbmKeys.filter((k) => k.endsWith(`:${email}`)),
      voteKeys: [],
      countedKeys: [],
      scoreExists: (await kvGet(`${BP}score:${email}`)) !== null,
    };
    plans.push(plan);
    for (const k of plan.sbmKeys) {
      const sm = k.match(new RegExp(`^${BP}score-by-month:(\\d{4}-\\d{2}):`));
      if (sm) slugsTouched.add(sm[1]);
    }
  }

  console.log("[purge] listando vote:* keys...");
  const voteKeys = await kvList(`${BP}vote:`);
  for (const plan of plans) {
    plan.voteKeys = voteKeys.filter((k) => k.endsWith(`:${plan.email}`));
  }

  // #3976: guard-keys idempotentes de incremento (counted:{edition}:{email}:
  // {stats,score,month}, ver handleVote em vote.ts) — nunca eram purgados
  // antes desta issue, mesmo já sabendo a EDITION de cada vote:* encontrado.
  // Derivado por slice de string (não regex) — email já validado sem ":" no
  // charset (#3279), então prefix/suffix bastam pra isolar a edition no meio.
  const votePrefix = `${BP}vote:`;
  for (const plan of plans) {
    const suffix = `:${plan.email}`;
    for (const vk of plan.voteKeys) {
      if (!vk.startsWith(votePrefix) || !vk.endsWith(suffix)) continue;
      const edition = vk.slice(votePrefix.length, vk.length - suffix.length);
      for (const kind of ["stats", "score", "month"] as const) {
        plan.countedKeys.push(`${BP}counted:${edition}:${plan.email}:${kind}`);
      }
    }
  }

  // Print plano
  let totalKeys = 0;
  for (const p of plans) {
    console.log(`\n[plan] ${p.email}`);
    console.log(`  score:        ${p.scoreKey} ${p.scoreExists ? "(exists)" : "(not found)"}`);
    console.log(`  score-by-month (${p.sbmKeys.length}):`);
    for (const k of p.sbmKeys) console.log(`    - ${k}`);
    console.log(`  vote (${p.voteKeys.length}):`);
    for (const k of p.voteKeys) console.log(`    - ${k}`);
    console.log(`  counted (${p.countedKeys.length}):`);
    for (const k of p.countedKeys) console.log(`    - ${k}`);
    totalKeys += (p.scoreExists ? 1 : 0) + p.sbmKeys.length + p.voteKeys.length + p.countedKeys.length;
  }
  console.log(`\n[purge] snapshots a invalidar: ${[...slugsTouched].join(", ") || "(nenhum)"}`);
  console.log(`[purge] total de keys a deletar: ${totalKeys}`);

  if (totalKeys === 0) {
    console.log("[purge] nada pra apagar.");
    return;
  }

  if (!execute) {
    console.log("\n[purge] DRY-RUN — passe --execute pra apagar de fato.");
    return;
  }

  // Ajustar stats:{edition} antes de deletar (precisa do choice + correct)
  const statsAdjust = new Map<string, { dTotal: number; dA: number; dB: number; dCorrect: number }>();
  for (const plan of plans) {
    for (const vk of plan.voteKeys) {
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
  for (const p of plans) {
    if (p.scoreExists) { await kvDelete(p.scoreKey); console.log(`  [del] ${p.scoreKey}`); }
    for (const k of p.sbmKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
    for (const k of p.voteKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
    // #3976: counted:* são guard-keys idempotentes (podem já ter expirado via
    // TTL de 90 dias) — kvDelete já é 404-safe/idempotente, mesmo tratamento
    // dos demais deletes acima.
    for (const k of p.countedKeys) { await kvDelete(k); console.log(`  [del] ${k}`); }
  }

  console.log("\n[purge] invalidando snapshots...");
  for (const slug of slugsTouched) {
    await kvDelete(`${BP}leaderboard-snapshot:${slug}`);
    console.log(`  [del] ${BP}leaderboard-snapshot:${slug}`);
  }

  console.log(`\n[purge] done — ${totalKeys} keys apagadas, ${slugsTouched.size} snapshots invalidados.`);
}

main().catch((e) => {
  console.error("[purge] erro:", e);
  process.exit(1);
});
