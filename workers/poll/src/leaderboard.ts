/**
 * leaderboard.ts (#1092)
 *
 * Pure helper para ranking de leitores no leaderboard do É IA?. Separado
 * do index.ts (Cloudflare Worker handler) pra ser testável via node --test
 * no top-level sem dependências de @cloudflare/workers-types.
 *
 * Ranking: competition style (1, 1, 3 — não dense 1, 1, 2). Dois leitores
 * empatados em `(correct, pct)` compartilham o mesmo número. Tiebreaker
 * dentro do empate: nickname/email ASC (determinístico, estável).
 *
 * Por que `(correct, pct)` é a tie key (não só `pct`): dois leitores com
 * mesmo pct mas correct diferente (ex: 5/5 vs 1/1) têm participação
 * meaningfully diferente. Tratar como empate seria confuso. A sort key
 * é a mesma — então o rank reflete exatamente a ordem visual.
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
 * Sort key: (correct DESC, pct DESC, displayKey ASC).
 * Tie key: (correct, pct). Empate → mesmo rank.
 *
 * @param scores entries crus do KV
 * @returns array ordenado com `rank` + `medal` atribuídos
 */
export function rankEntries(scores: LeaderboardEntry[]): RankedEntry[] {
  const sorted = [...scores].sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    if (b.pct !== a.pct) return b.pct - a.pct;
    return displayKey(a).localeCompare(displayKey(b));
  });

  const ranked: RankedEntry[] = [];
  let currentRank = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    // Competition rank: avança quando (correct, pct) muda; senão herda.
    if (!prev || prev.correct !== e.correct || prev.pct !== e.pct) {
      currentRank = i + 1;
    }
    ranked.push({ ...e, rank: currentRank, medal: medalFor(currentRank) });
  }
  return ranked;
}

/**
 * Medal por rank, não por índice. Rank 1 → 🥇 (mesmo se 2 pessoas empataram
 * em #1, ambas ganham ouro). Rank 2 → 🥈, rank 3 → 🥉. Demais → `${rank}.`.
 *
 * Se o pódio tem empate (1, 1, 3), o rank 2 simplesmente não existe — não
 * há prata. O leitor vai do ouro direto pro bronze. É a interpretação
 * editorial mais clara do "competition rank" do issue #1092.
 */
export function medalFor(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${rank}.`;
}
