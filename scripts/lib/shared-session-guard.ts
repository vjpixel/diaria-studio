/**
 * scripts/lib/shared-session-guard.ts (#7044)
 *
 * Guard reusável de "varredura destrutiva num checkout compartilhado" —
 * generalizado do #5156 item 9 (que só existia dentro de
 * `scripts/cleanup-merged-worktrees.ts`) pro P0 do review da PR #7044:
 * `scripts/branch-cleanup.ts` (#6802) remove o MESMO tipo de recurso
 * (worktrees + branches) no MESMO checkout compartilhado e nunca consultava
 * `session-registry.ts` — regressão de padrão dentro do próprio repo, já que
 * o script irmão já resolvia exatamente este problema. Este módulo é a fonte
 * ÚNICA da lógica; `cleanup-merged-worktrees.ts` re-exporta
 * `shouldSkipForSharedSession` daqui pra manter os imports existentes
 * (`test/session-beacon-blast-radius.test.ts`,
 * `test/cleanup-merged-worktrees.test.ts`) funcionando sem mudança.
 *
 * Dois guards complementares, checados em momentos diferentes do chamador:
 *
 * 1. `shouldSkipForSharedSession` — pula a varredura INTEIRA quando existe
 *    ≥1 sessão COORDENADORA (`overnight`/`develop`/`continuo`,
 *    `isCoordinatorKind`) ativa e não-stale, a menos que `confirmShared`
 *    seja `true`. Mesmos limites do #6168 (só coordenadora conta — sessão
 *    `interactive` registrada por todo mundo via beacon tornaria isto um
 *    `return true` permanente) e do #6706 (só NÃO-stale conta — `stale` é
 *    o único sinal de liveness prático disponível, `pid` gravado nunca
 *    corresponde a processo real neste harness).
 *
 * 2. `activeSessionWorktreePaths` — proteção mais ESTREITA e por isso mais
 *    segura de aplicar incondicionalmente, mesmo com `--confirm-shared`:
 *    dado um worktree cujo PATH exato já consta em `worktrees` de QUALQUER
 *    sessão ativa (não só coordenadora — uma sessão `interactive` também
 *    não pode ter o worktree dela sumindo sob os pés), não há cenário
 *    legítimo de remover, mesmo com árvore limpa e branch já mergeada. É
 *    exatamente o cenário que `git status --porcelain` sozinho não cobre:
 *    sessão viva que por acaso está com a árvore limpa (ex: acabou de
 *    commitar/pushar e está em wrap-up — comentar na issue, reivindicar a
 *    próxima, escrever relatório).
 */
import { isCoordinatorKind, listActiveSessions, type SessionRecord } from "./session-registry.ts";

/**
 * Decide se a varredura destrutiva deve ser pulada por segurança (#5156 item
 * 9) — pura, testável sem tocar `data/sessions/` real. Pula quando existe
 * ≥1 sessão COORDENADORA ativa registrada E `confirmShared` não foi passado.
 * Registro vazio (nenhuma outra sessão rodando) nunca pula — comportamento
 * idêntico ao pré-#5156.
 *
 * **#6168 — só sessão COORDENADORA conta.** Antes desta issue a checagem era
 * "qualquer sessão ativa", o que estava certo enquanto só as 3 skills se
 * registravam. Com o beacon (`.claude/hooks/session-beacon.mjs`) registrando
 * TODA sessão interativa automaticamente, "qualquer sessão ativa" passaria a
 * ser verdade praticamente sempre — o guard viraria um `return true`
 * permanente e a limpeza de worktree nunca mais rodaria, em silêncio. É o
 * item 1 do blast radius que a Parte B da issue nomeia explicitamente.
 *
 * O que o guard protege é worktree em uso por um IMPLEMENTADOR despachado —
 * e só coordenadora despacha implementador. Uma sessão interativa não abre
 * worktree em `.claude/worktrees/` por conta própria; quando ela abre um à
 * mão, quem o remove é ela mesma. (`activeSessionWorktreePaths`, abaixo,
 * cobre esse caso pontual separadamente — path exato registrado, qualquer
 * `kind`.)
 *
 * **#6706 — só conta sessão coordenadora NÃO-stale.** Antes desta mudança,
 * o filtro considerava qualquer registro `SessionRecord` cujo `kind` fosse
 * coordenador, ignorando o campo computado `stale` que `listActiveSessions`
 * já popula (heartbeat morto há mais de `SOFT_STALE_MS`/90min, ver
 * `scripts/lib/session-registry.ts`). Como o campo `pid` gravado no registro
 * nunca corresponde ao processo real da sessão neste harness (achado #6294,
 * reconfirmado pelo #6706 — nenhum PID de registro é resolvível em `/proc`
 * mesmo pra sessão genuinamente viva), `stale` é o ÚNICO sinal de liveness
 * prático disponível aqui; sem filtrar por ele, uma sessão overnight/develop
 * morta há 20h (dentro do teto absoluto de 24h que `listActiveSessions` usa
 * pra decidir se inclui o registro na lista, mas muito além da janela de
 * liveness de 90min) contava como "ativa" pra sempre — achado ao vivo: o
 * script recusou rodar reportando 15 sessões "ativas" quando só 2 estavam de
 * fato vivas. `s.stale` pode ser `undefined` num `SessionRecord` cru fora de
 * `listActiveSessions` (nunca persistido em disco) — `!s.stale` trata
 * `undefined` como "não-stale", preservando o comportamento de quem passar
 * uma lista sem essa checagem computada (nenhum call site real faz isso hoje;
 * `listActiveSessionsSafe` sempre passa por `listActiveSessions`).
 */
export function shouldSkipForSharedSession(activeSessions: SessionRecord[], confirmShared: boolean): boolean {
  const coordinators = activeSessions.filter((s) => isCoordinatorKind(s.kind) && !s.stale);
  return coordinators.length > 0 && !confirmShared;
}

/** `listActiveSessions` fail-soft — qualquer exceção (data/ ausente,
 * permissão, JSON corrompido) vira lista vazia + warning, nunca trava o
 * chamador. `logPrefix` identifica o script no log (cada chamador tem o
 * próprio, ex: `[branch-cleanup]`/`[cleanup-merged-worktrees]`). */
export function listActiveSessionsSafe(repoRoot: string, logPrefix: string): SessionRecord[] {
  try {
    return listActiveSessions(repoRoot);
  } catch (e) {
    console.warn(`${logPrefix} listActiveSessions lançou (fail-soft, tratando como vazio): ${(e as Error).message}`);
    return [];
  }
}

/** Normaliza separador de path (`\\` → `/`) e remove barra final — mesma
 * forma usada por `filterUnderWorktreesDir`/`parseWorktreePorcelain` em
 * `cleanup-merged-worktrees.ts`, pra comparação robusta entre plataformas
 * (registro gravado no Windows, lido no Linux, ou vice-versa). */
export function normalizeWorktreePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Conjunto (paths normalizados) de todo worktree registrado por QUALQUER
 * sessão ATIVA (não-stale) — não filtra por `kind`, ver docstring do topo
 * do arquivo (item 2). Sessão `stale` não contribui paths — coerente com
 * `shouldSkipForSharedSession`, que também ignora `stale` como sinal de
 * "em uso". */
export function activeSessionWorktreePaths(activeSessions: readonly SessionRecord[]): Set<string> {
  const paths = new Set<string>();
  for (const session of activeSessions) {
    if (session.stale) continue;
    for (const wt of session.worktrees ?? []) {
      if (wt?.path) paths.add(normalizeWorktreePath(wt.path));
    }
  }
  return paths;
}
