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
 *   - `stats:{edition}`            (decrementa total/voted_a/voted_b/correct_count
 *                                   pra refletir os votes apagados)
 *   - `leaderboard-snapshot:{slug}` (invalida snapshots dos meses afetados)
 *
 * Uso:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=5d15d8303325211d6976d73051f4b002 \
 *     npx tsx scripts/purge-leaderboard.ts --nickname Teste
 *     npx tsx scripts/purge-leaderboard.ts --email test@example.com
 *
 *   # Dry-run é o default — só mostra o que seria apagado.
 *   # Pra executar de fato, passar --execute:
 *   npx tsx scripts/purge-leaderboard.ts --email test@example.com --execute
 */

import "dotenv/config";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6"; // POLL namespace

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Erro: CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN obrigatórios no env");
  process.exit(1);
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
  console.error("Uso: purge-leaderboard.ts (--nickname <name> | --email <email>) [--brand diaria|clarice] [--execute]");
  console.error("     passe exatamente UM de --nickname ou --email");
  process.exit(2);
}

// #1905: namespace por marca. Vazio p/ diaria (chaves legadas), "clarice:" p/
// Clarice News. Todas as chaves de KV (score/vote/stats/snapshot) usam o prefixo.
const BRAND = flagValue("--brand") === "clarice" ? "clarice" : "diaria";
const BP = BRAND === "diaria" ? "" : `${BRAND}:`;

const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${NAMESPACE_ID}`;

async function kvList(prefix: string): Promise<string[]> {
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ prefix, limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${KV_BASE}/keys?${params}`, {
      headers: { "Authorization": `Bearer ${API_TOKEN}` },
    });
    if (!res.ok) throw new Error(`KV list failed: ${res.status} ${await res.text()}`);
    const json = await res.json() as { result: Array<{ name: string }>; result_info: { cursor?: string; count: number } };
    all.push(...json.result.map((k) => k.name));
    cursor = json.result_info.cursor || undefined;
  } while (cursor);
  return all;
}

async function kvGet(key: string): Promise<string | null> {
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get ${key} failed: ${res.status}`);
  return await res.text();
}

async function kvPut(key: string, value: string): Promise<void> {
  if (!execute) {
    console.log(`[dry-run] PUT ${key} (${value.length} bytes)`);
    return;
  }
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
    body: value,
  });
  if (!res.ok) throw new Error(`KV put ${key} failed: ${res.status} ${await res.text()}`);
}

async function kvDelete(key: string): Promise<void> {
  if (!execute) {
    console.log(`[dry-run] DELETE ${key}`);
    return;
  }
  const res = await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${API_TOKEN}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`KV delete ${key} failed: ${res.status} ${await res.text()}`);
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
  type Plan = { email: string; scoreKey: string; sbmKeys: string[]; voteKeys: string[]; scoreExists: boolean };
  const plans: Plan[] = [];
  const slugsTouched = new Set<string>();

  for (const email of matchedEmails) {
    const plan: Plan = {
      email,
      scoreKey: `${BP}score:${email}`,
      sbmKeys: sbmKeys.filter((k) => k.endsWith(`:${email}`)),
      voteKeys: [],
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

  // Print plano
  let totalKeys = 0;
  for (const p of plans) {
    console.log(`\n[plan] ${p.email}`);
    console.log(`  score:        ${p.scoreKey} ${p.scoreExists ? "(exists)" : "(not found)"}`);
    console.log(`  score-by-month (${p.sbmKeys.length}):`);
    for (const k of p.sbmKeys) console.log(`    - ${k}`);
    console.log(`  vote (${p.voteKeys.length}):`);
    for (const k of p.voteKeys) console.log(`    - ${k}`);
    totalKeys += (p.scoreExists ? 1 : 0) + p.sbmKeys.length + p.voteKeys.length;
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
