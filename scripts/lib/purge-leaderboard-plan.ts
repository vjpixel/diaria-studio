/**
 * scripts/lib/purge-leaderboard-plan.ts (#4433)
 *
 * Lógica PURA de resolução do plano de purge do leaderboard — extraída de
 * `scripts/purge-leaderboard.ts` pra ser testável sem tocar wrangler/KV real.
 * `purge-leaderboard.ts` faz parsing de CLI + `process.exit` no TOP-LEVEL do
 * módulo (fora de `main()`), o que inviabilizaria import direto em teste —
 * qualquer `import` do script principal executaria essa validação com o argv
 * do test runner e mataria o processo. Este módulo não tem nenhum efeito
 * colateral de import (sem `process.argv`, sem `process.exit`, sem chamada de
 * rede) — só funções puras/injetáveis.
 *
 * `PurgeKvOps` é o mesmo padrão de injeção de dependência já usado em
 * `sync-cursos-subscribers-kv.ts` (`KvSyncOps`) — os testes substituem por um
 * KV em memória, nunca invocam wrangler de verdade.
 */

export interface PurgeKvOps {
  list: (prefix: string) => Promise<string[]>;
  get: (key: string) => Promise<string | null>;
}

export interface PurgePlanEntry {
  email: string;
  scoreKey: string;
  scoreExists: boolean;
  sbmKeys: string[];
  voteKeys: string[];
  countedKeys: string[];
  /** #4433: presente quando esta entry foi resolvida via `identify-linked`
   * (não por match direto do `--email`/`--nickname`) — lista os e-mails de
   * origem que apontam pra ela, pra o plano deixar claro que esta chave NÃO
   * veio do target original. */
  linkedVia?: string[];
}

export interface PurgePlan {
  matchedEmails: string[];
  plans: PurgePlanEntry[];
  slugsTouched: string[];
  /** #4433: chaves `identify-linked:{email}:{anonEmail}` a apagar no fim —
   * ficam órfãs depois que a identidade ligada (e o próprio email) são
   * purgados; hoje o script nunca as tocava (4 remanescentes no KV na
   * auditoria de 260801). */
  identifyLinkedKeys: string[];
}

/**
 * Resolve a lista de emails a purgar a partir do modo selecionado.
 * - Modo email: o próprio email é o target (sem scan).
 * - Modo nickname: scan score-by-month:* + score:* por nickname match.
 */
export async function resolveTargetEmails(
  ops: PurgeKvOps,
  bp: string,
  sbmKeys: string[],
  targetEmail: string | null,
  targetNickname: string | null,
): Promise<Set<string>> {
  const matched = new Set<string>();

  if (targetEmail) {
    matched.add(targetEmail);
    return matched;
  }

  // Modo --nickname: scan score-by-month:* primeiro
  for (const key of sbmKeys) {
    const m = key.match(new RegExp(`^${bp}score-by-month:(\\d{4}-\\d{2}):(.+)$`));
    if (!m) continue;
    const [, , email] = m;
    const raw = await ops.get(key);
    if (!raw) continue;
    let entry: { nickname?: string | null };
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if ((entry.nickname ?? "").toLowerCase() === targetNickname) {
      matched.add(email);
    }
  }

  // Fallback: nickname pode ter sido seteado sem nenhum vote (entry score:*
  // sem score-by-month correspondente). Varre score:* também.
  if (matched.size === 0) {
    const scoreKeys = await ops.list(`${bp}score:`);
    for (const key of scoreKeys) {
      const email = key.replace(new RegExp(`^${bp}score:`), "");
      const raw = await ops.get(key);
      if (!raw) continue;
      let entry: { nickname?: string | null };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if ((entry.nickname ?? "").toLowerCase() === targetNickname) {
        matched.add(email);
      }
    }
  }

  return matched;
}

/**
 * #4433: resolve as identidades anônimas (`{uuid}@web.eia.diaria.local`)
 * ligadas a um e-mail real via `identify-linked:{email}:{anonEmail}` (ver
 * `workers/poll/src/magic-link.ts` `markIdentifyLinked`). O merge
 * (`performIdentifyMerge`, `workers/poll/src/identify.ts`) NUNCA apaga
 * `score:{anonEmail}`/`vote:{edition}:{anonEmail}` — só grava/mergeia em
 * `score:{email}`. Sem isso, um purge por `--email` apaga a casca
 * (`score:{email}`, muitas vezes com poucos/zero votos) e deixa os votos DE
 * VERDADE órfãos sob a identidade anônima, competindo no leaderboard público
 * (achado 260801, #4433).
 *
 * Não-recursivo por CONSTRUÇÃO, não por limitação de implementação: o lado
 * direito da chave (`anonEmail`) é sempre uma identidade
 * `{uuid}@web.eia.diaria.local` TERMINAL — `markIdentifyLinked` só é chamado
 * com o par (e-mail real confirmado, anonEmail da sessão atual); um
 * `anonEmail` nunca aparece como o lado ESQUERDO de outra `identify-linked:*`
 * (só e-mails reais confirmados via link mágico ficam do lado esquerdo). Não
 * existe cadeia anon→anon pra seguir — 1 nível de resolução é suficiente e
 * completo, não uma simplificação.
 */
export async function resolveLinkedAnonymousIdentities(
  ops: PurgeKvOps,
  bp: string,
  email: string,
): Promise<{ linkKeys: string[]; anonEmails: string[] }> {
  const prefix = `${bp}identify-linked:${email}:`;
  const linkKeys = await ops.list(prefix);
  const anonEmails = linkKeys.map((k) => k.slice(prefix.length)).filter((s) => s.length > 0);
  return { linkKeys, anonEmails };
}

/**
 * Monta o plano completo de purge: resolve os e-mails-alvo + identidades
 * anônimas ligadas (#4433, só no modo `--email`), lista `score-by-month`/
 * `vote` pra cada um, e deriva as `counted:*` guard-keys (#3976) sem scan
 * adicional.
 *
 * Resolvido NUM PLANO ÚNICO (nunca paralelizado por identidade) — várias
 * identidades que votaram nas mesmas edições disputam o read-modify-write de
 * `web:stats:{edition}`; resolver tudo aqui, sequencialmente, evita essa
 * corrida de concorrência (#4433 — rodar N invocações do script em paralelo
 * continua inseguro, mas dentro de UMA invocação o plano cobre tudo de uma
 * vez).
 */
export async function buildPurgePlan(
  ops: PurgeKvOps,
  bp: string,
  targetEmail: string | null,
  targetNickname: string | null,
): Promise<PurgePlan> {
  const sbmKeys = await ops.list(`${bp}score-by-month:`);
  const matchedEmails = await resolveTargetEmails(ops, bp, sbmKeys, targetEmail, targetNickname);

  // #4433: só no modo --email — nickname já passa por um scan mais amplo e
  // não tem uma identidade única de origem pra resolver o `identify-linked`.
  const linkedVia = new Map<string, string[]>();
  const identifyLinkedKeys: string[] = [];
  if (targetEmail) {
    for (const email of [...matchedEmails]) {
      const { linkKeys, anonEmails } = await resolveLinkedAnonymousIdentities(ops, bp, email);
      identifyLinkedKeys.push(...linkKeys);
      for (const anon of anonEmails) {
        matchedEmails.add(anon);
        const via = linkedVia.get(anon) ?? [];
        via.push(email);
        linkedVia.set(anon, via);
      }
    }
  }

  const plans: PurgePlanEntry[] = [];
  const slugsTouched = new Set<string>();
  for (const email of matchedEmails) {
    const scoreKey = `${bp}score:${email}`;
    const entrySbmKeys = sbmKeys.filter((k) => k.endsWith(`:${email}`));
    const scoreExists = (await ops.get(scoreKey)) !== null;
    for (const k of entrySbmKeys) {
      const m = k.match(new RegExp(`^${bp}score-by-month:(\\d{4}-\\d{2}):`));
      if (m) slugsTouched.add(m[1]);
    }
    plans.push({
      email,
      scoreKey,
      scoreExists,
      sbmKeys: entrySbmKeys,
      voteKeys: [],
      countedKeys: [],
      linkedVia: linkedVia.get(email),
    });
  }

  const voteKeys = await ops.list(`${bp}vote:`);
  const votePrefix = `${bp}vote:`;
  for (const plan of plans) {
    plan.voteKeys = voteKeys.filter((k) => k.endsWith(`:${plan.email}`));
    const suffix = `:${plan.email}`;
    // #3976: guard-keys idempotentes de incremento (counted:{edition}:{email}:
    // {stats,score,month}) derivadas por slice de string (não regex) — email
    // já validado sem ":" no charset (#3279), então prefix/suffix bastam pra
    // isolar a edition no meio.
    for (const vk of plan.voteKeys) {
      if (!vk.startsWith(votePrefix) || !vk.endsWith(suffix)) continue;
      const edition = vk.slice(votePrefix.length, vk.length - suffix.length);
      for (const kind of ["stats", "score", "month"] as const) {
        plan.countedKeys.push(`${bp}counted:${edition}:${plan.email}:${kind}`);
      }
    }
  }

  return {
    matchedEmails: [...matchedEmails],
    plans,
    slugsTouched: [...slugsTouched],
    identifyLinkedKeys,
  };
}
