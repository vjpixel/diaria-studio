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
  /**
   * #1383: ISO 8601 timestamp do voto mais recente do leitor no mês. Usado
   * como 3º critério de tiebreaker (voto mais recente vence empate de
   * correct+total). Opcional pra compat com entries pré-#1383 — quando
   * ausente, cai pra displayKey ASC.
   */
  last_vote_ts?: string;
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
 * Ordena scores e atribui rank dense-style.
 *
 * Sort key: (correct DESC, total DESC, last_vote_ts DESC, displayKey ASC).
 * Tie key (rank grouping): (correct, total). Empate em acertos+tentativas →
 * mesmo rank, mas dentro do grupo a ordem de exibição prioriza voto mais
 * recente (#1383). Editor decisão: dense rank visual preserva, apenas
 * ORDEM no grupo muda — quem entrou na disputa mais recente fica na frente.
 *
 * @param scores entries crus do KV
 * @returns array ordenado com `rank` + `medal` atribuídos
 */
export function rankEntries(scores: LeaderboardEntry[]): RankedEntry[] {
  const sorted = [...scores].sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct;
    if (b.total !== a.total) return b.total - a.total;
    // #1383: voto mais recente vence empate.
    // ISO 8601 strings ordenam lexicograficamente igual a timestamps reais.
    // Entries sem last_vote_ts (pré-#1383 ou recém-migradas) caem por último
    // (empty string < qualquer ISO timestamp).
    const aTs = a.last_vote_ts ?? "";
    const bTs = b.last_vote_ts ?? "";
    if (bTs !== aTs) return bTs.localeCompare(aTs); // DESC
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
    // #3113: medalha exige correct >= 1. Sem isso, o tiebreak "mais tentativas
    // vence" (#1163) podia dar 🥉 pra quem tem 0 acertos (ex: 0/2 rankeia acima
    // de 0/1) — pódio degenerado. O RANK numérico não muda (a ordem continua
    // refletindo o critério editorial de participação); só o GLIFO da medalha
    // é gateado — quem não acertou nenhuma nunca aparece com 🥇/🥈/🥉, mesmo
    // ocupando rank 1/2/3.
    const medal = e.correct >= 1 ? medalFor(currentRank) : `${currentRank}.`;
    ranked.push({ ...e, rank: currentRank, medal });
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
 *
 * Pura por rank — NÃO sabe sobre `correct` (o gate de #3113 "medalha exige
 * correct >= 1" é aplicado pelo caller, `rankEntries`, que tem o dado).
 */
export function medalFor(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${rank}.`;
}

// ── Cauda de baixo-engajamento (#4008 item 2) ───────────────────────────────

/**
 * #4008 item 2: nº mínimo de tentativas (`total`) pra um leitor aparecer
 * LISTADO linha-a-linha no leaderboard público. Uma cauda grande de entries
 * 0/N (quem votou 1-2× e nunca acertou) desmotiva quem olha o ranking — sem
 * nenhum sinal de progresso, só "perdedor" exposto publicamente. Abaixo do
 * mínimo, o leitor continua PONTUANDO normalmente (nunca perde o voto nem o
 * rank interno) — só não aparece como linha própria, vira parte do agregado
 * "+ N jogadores {período}" (ver `partitionLeaderboardForDisplay`).
 */
export const MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING = 3;

/**
 * #4008 item 2: separa `ranked` (já ordenado por `rankEntries`) em entries
 * "visíveis" (>= `minAttempts` tentativas) e a CONTAGEM do resto (cauda de
 * baixo-engajamento — nunca exibida linha-a-linha, só como agregado).
 *
 * Fallback anti-leaderboard-vazio: se NINGUÉM atinge o mínimo (baixa
 * participação — início de mês/ano, brand novo, amostra pequena), não
 * esconde ninguém — mostrar a cauda inteira é preferível a um leaderboard
 * vazio. Nesse caso `hiddenCount` retorna 0 (sinaliza "nenhum corte
 * aplicado", não "ninguém escondido apesar de existir cauda").
 */
export function partitionLeaderboardForDisplay(
  ranked: RankedEntry[],
  minAttempts: number = MIN_ATTEMPTS_FOR_LEADERBOARD_LISTING,
): { visible: RankedEntry[]; hiddenCount: number } {
  const qualifying = ranked.filter((e) => e.total >= minAttempts);
  if (qualifying.length === 0) return { visible: ranked, hiddenCount: 0 };
  return { visible: qualifying, hiddenCount: ranked.length - qualifying.length };
}
