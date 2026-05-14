/**
 * leaderboard.ts (#1092, #1163, #1256)
 *
 * Pure helper para ranking de leitores no leaderboard do É IA?. Separado
 * do index.ts (Cloudflare Worker handler) pra ser testável via node --test
 * no top-level sem dependências de @cloudflare/workers-types.
 *
 * Ranking: dense style (1, 1, 2 — não competition 1, 1, 3). Dois leitores
 * empatados em `(correct, total)` compartilham o mesmo número e o próximo
 * grupo é +1 (não pula os ranks ocupados pelos empatados). Tiebreaker
 * dentro do empate: nickname/email ASC (determinístico, estável).
 *
 * Decisão #1256: trocamos de competition pra dense porque com 6 leitores
 * empatados em rank 3, o próximo grupo virava rank 9 — visualmente
 * estranho ("9." quando só 8 pessoas estão acima). Dense rank vira "4."
 * que reflete melhor a posição relativa.
 *
 * Critério editorial (#1163): acertos absolutos primeiro; em caso de
 * empate, mais tentativas vence (premia participação consistente). Taxa
 * de acerto (pct) deixou de ser critério — mantida no struct só pra
 * consumidores externos.
 */

export interface LeaderboardEntry {
  email: string;
  nickname: string | null;
  correct: number;
  total: number;
  pct: number;
  streak: number;
}

export interface RankedEntry extends LeaderboardEntry {
  rank: number;
  medal: string;
}

/** Display key usado pra tiebreaker estável dentro do empate. */
function displayKey(e: LeaderboardEntry): string {
  return (e.nickname || e.email).toLowerCase();
}

/**
 * Ordena scores e atribui rank competition-style.
 *
 * Sort key: (correct DESC, total DESC, displayKey ASC).
 * Tie key: (correct, total). Empate → mesmo rank.
 *
 * @param scores entries crus do KV
 * @returns array ordenado com `rank` + `medal` atribuídos
 */
export function rankEntries(scores: LeaderboardEntry[]): RankedEntry[] {
  const sorted = [...scores].sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    if (b.total !== a.total) return b.total - a.total;
    return displayKey(a).localeCompare(displayKey(b));
  });

  const ranked: RankedEntry[] = [];
  let currentRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    // Dense rank (#1256): avança +1 quando (correct, total) muda; senão herda.
    // Antes era competition rank (`currentRank = i + 1`), que pulava ranks
    // ocupados por empate — 6 empatados em rank 3 levavam ao próximo rank 9.
    if (!prev || prev.correct !== e.correct || prev.total !== e.total) {
      currentRank++;
    }
    ranked.push({ ...e, rank: currentRank, medal: medalFor(currentRank) });
  }
  return ranked;
}

/**
 * Medal por rank, não por índice. Rank 1 → 🥇 (mesmo se 2 pessoas empataram
 * em #1, ambas ganham ouro). Rank 2 → 🥈, rank 3 → 🥉. Demais → `${rank}.`.
 *
 * Com dense rank (#1256), empate em rank 1 leva ao próximo rank 2 — então
 * o pódio sempre tem ouro→prata→bronze contíguo (se houver pessoas
 * suficientes). 2 ouros + 1 prata + 1 bronze é cenário válido.
 */
export function medalFor(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${rank}.`;
}
