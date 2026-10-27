/**
 * purge-vote-stats.ts (#11253 review A2)
 *
 * Apaga os `vote:{edition}:{email}` de uma purga e ajusta `stats:{edition}`
 * SÓ pelos votos que foram de fato apagados.
 *
 * Antes, `purge-leaderboard.ts` decrementava todos os `stats:*` primeiro e só
 * depois apagava os votos. Se um DELETE falhasse no meio, o voto ficava no KV
 * com o stats já decrementado; re-rodar a purga (o próprio script sugere re-
 * rodar) achava o voto de novo e decrementava uma 2ª vez.
 *
 * Agora a ordem é: ler o voto → apagar → acumular o delta. Uma falha de
 * DELETE interrompe os deletes, os stats são ajustados pelo que já saiu e o
 * erro é relançado. Re-rodar depois disso não desconta duas vezes: os votos
 * apagados não são mais encontrados, e os que ficaram ainda não foram
 * descontados.
 *
 * Risco residual, assumido: se a leitura ou o PUT de um `stats:*` falhar
 * DEPOIS dos votos dele já apagados, aquele stats fica alto (conta votos que
 * não existem mais) e re-rodar não corrige — os votos já não estão lá para
 * gerar o delta. É o erro do lado inofensivo (stats de votação de uma edição,
 * não o leaderboard). As demais edições seguem sendo ajustadas, e no fim sai
 * UM erro listando cada chave que falhou com o valor-alvo (ou o desconto, se
 * a leitura falhou), pro operador ajustar à mão.
 */

import type { KvOps } from "./cloudflare-kv-rest.ts";

export type VoteStatsOps = Pick<KvOps, "get" | "put" | "delete">;

interface VoteRecord { choice?: "A" | "B"; correct?: boolean | null }
interface StatsRecord { total: number; voted_a: number; voted_b: number; correct_count: number }
interface Delta { dTotal: number; dA: number; dB: number; dCorrect: number }

export interface DeleteVotesResult {
  /** Chaves de voto apagadas (inclui as que já não existiam). */
  deleted: string[];
  /** `stats:{edition}` reescritos. */
  statsAdjusted: string[];
}

/**
 * @param voteKeys chaves `{bp}vote:{AAMMDD}:{email}` a apagar.
 * @param bp       prefixo de marca (`""`, `"clarice:"`, `"web:"`).
 */
export async function deleteVotesAndAdjustStats(
  ops: VoteStatsOps,
  voteKeys: readonly string[],
  bp: string,
  log: (line: string) => void = () => {},
): Promise<DeleteVotesResult> {
  const deltas = new Map<string, Delta>();
  const deleted: string[] = [];
  const voteRe = new RegExp(`^${bp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}vote:(\\d{6}):`);

  let deleteFailure: unknown = null;
  try {
    for (const vk of voteKeys) {
      const raw = await ops.get(vk);
      await ops.delete(vk);
      deleted.push(vk);
      log(`  [del] ${vk}`);
      const m = vk.match(voteRe);
      if (!m || !raw) continue;
      let v: VoteRecord;
      try { v = JSON.parse(raw) as VoteRecord; } catch { continue; }
      const cur = deltas.get(m[1]) ?? { dTotal: 0, dA: 0, dB: 0, dCorrect: 0 };
      cur.dTotal += 1;
      if (v.choice === "A") cur.dA += 1;
      if (v.choice === "B") cur.dB += 1;
      if (v.correct === true) cur.dCorrect += 1;
      deltas.set(m[1], cur);
    }
  } catch (e) {
    deleteFailure = e;
  }

  // Percorre TODAS as edições mesmo se uma falhar: os votos já saíram, então
  // um stats pulado aqui não é recuperável por re-run. As falhas viram um erro
  // único no fim, listando cada chave (com o alvo, quando a leitura deu certo).
  const statsAdjusted: string[] = [];
  const statsFailures: string[] = [];
  log(`\n[purge] ajustando stats:{edition} pra ${deltas.size} edition(s) (só votos apagados)...`);
  for (const [edition, delta] of deltas) {
    const sKey = `${bp}stats:${edition}`;
    let raw: string | null;
    try {
      raw = await ops.get(sKey);
    } catch (e) {
      statsFailures.push(
        `${sKey}: leitura falhou (${(e as Error).message}) — descontar à mão total-${delta.dTotal} ` +
          `a-${delta.dA} b-${delta.dB} correct-${delta.dCorrect}`,
      );
      continue;
    }
    if (!raw) { log(`  [skip] ${sKey} não existe`); continue; }
    let s: StatsRecord;
    try { s = JSON.parse(raw) as StatsRecord; } catch { log(`  [skip] ${sKey} parse error`); continue; }
    s.total = Math.max(0, s.total - delta.dTotal);
    s.voted_a = Math.max(0, s.voted_a - delta.dA);
    s.voted_b = Math.max(0, s.voted_b - delta.dB);
    s.correct_count = Math.max(0, s.correct_count - delta.dCorrect);
    try {
      await ops.put(sKey, JSON.stringify(s));
    } catch (e) {
      statsFailures.push(
        `${sKey}: gravação falhou (${(e as Error).message}) — gravar à mão total=${s.total} a=${s.voted_a} ` +
          `b=${s.voted_b} correct=${s.correct_count}`,
      );
      continue;
    }
    statsAdjusted.push(sKey);
    log(`  [adj]  ${sKey} → total=${s.total} a=${s.voted_a} b=${s.voted_b} correct=${s.correct_count}`);
  }

  if (statsFailures.length > 0) {
    throw new Error(
      `ajuste de ${statsFailures.length} stats:* falhou depois dos votos já apagados — esses stats ficaram ` +
        `altos e re-rodar NÃO corrige:\n  ${statsFailures.join("\n  ")}`,
      { cause: deleteFailure ?? undefined },
    );
  }
  if (deleteFailure) throw deleteFailure;
  return { deleted, statsAdjusted };
}
