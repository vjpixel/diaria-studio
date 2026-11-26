/**
 * scripts/lib/sessions/types.ts (#14004)
 *
 * Tipos e constantes do registro: kinds de sessão, `SessionRecord`, TTLs e
 * janelas de staleness, formato do grant e do evento de ciclo de vida.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */



/**
 * #6168: `interactive` é o 4º kind — sessão comum do editor, registrada
 * AUTOMATICAMENTE pelo hook `.claude/hooks/session-beacon.mjs` (nenhuma skill
 * chama `register` pra ela). Fecha o buraco 3 da issue: até aqui só as 3
 * skills coordenadoras se registravam, e a maioria das sessões reais —
 * interativas — era invisível ao registro (incidente #5751: o `300` tinha
 * #5738 em `claimed_issues` enquanto uma sessão interativa a implementava e
 * mergeava em paralelo).
 *
 * **Não é coordenadora, e isso é deliberado.** `COORDINATOR_SESSION_KINDS`
 * (abaixo) NÃO a inclui: uma sessão interativa não despacha subagente
 * implementador nem decide quando entra merge, então promovê-la a
 * coordenadora por relabel furaria o guard do #5716. O caminho legítimo dela
 * pro merge é a concessão de janela (`merge_grant`, #6296), nunca o kind.
 */
/**
 * #6934: `continuo-review` é o 5º kind — `hermes/scripts/continuo-pr-review.sh`
 * (cron do Hermes, roda `gh pr merge` direto em bash, fora do harness do
 * Claude Code). Decisão registrada no comentário durável da issue #6934
 * (3 pontos, todos decididos lá — não repetir a discussão aqui):
 *
 * (a) **Kind NOVO, não reuso de `continuo`.** O tick do `hermes-diaria-
 * continuo` e este script de review são processos DIFERENTES que podem
 * estar vivos ao mesmo tempo (cadências distintas — ver `hermes cron list
 * --all`, nunca esta prosa). Reusar `continuo` tornaria `list-active`
 * ambíguo sobre "quem está segurando o quê" bem no meio de um incidente de
 * merge — o cenário em que essa resposta mais importa.
 *
 * (b) O `--session-id` estável-durante-o-tick/distinto-entre-ticks é
 * derivado do `RUN_ID` que o próprio script já gera para seu ciclo (mesmo
 * padrão `date+PID`, sem esquema novo).
 *
 * (c) TTL do merge lock (`MERGE_LOCK_TTL_MS`) não muda — a janela real
 * (`gh pr merge` → `git pull`) é a mesma do overnight/develop.
 *
 * **Não é coordenadora** (`COORDINATOR_SESSION_KINDS` abaixo não a inclui):
 * o script não despacha subagente implementador — só decide SE mergeia uma
 * PR já aberta por outro processo (o tick do contínuo), atrás de um portão
 * determinístico próprio (`scripts/check-continuo-merge-gate.ts`). O merge
 * lock em si (`acquireMergeLock`/`releaseMergeLock`) não exige `kind`
 * nenhum — usa só `sessionId` — então este kind existe pela mesma razão que
 * os demais: manter `data/sessions/*.json` legível sobre qual processo é
 * qual, não como pré-requisito mecânico do lock.
 */
export type SessionKind = "overnight" | "develop" | "continuo" | "interactive" | "continuo-review";

/** Os 5 valores de `SessionKind`, para validação/enumeração em runtime (#6338, #6934). */
export const ALL_SESSION_KINDS: readonly SessionKind[] = ["overnight", "develop", "continuo", "interactive", "continuo-review"];

/**
 * Os 3 kinds que rodam uma RODADA coordenada (`/diaria-overnight`,
 * `/diaria-develop`, `/diaria-continuo`) — despacham subagentes
 * implementadores e decidem quando um merge entra. `interactive` fica de
 * fora de propósito (ver `SessionKind`).
 *
 * Espelha `COORDINATOR_KINDS` de `.claude/hooks/block-gh-pr-merge-subagent.mjs`,
 * que é self-contained (`.mjs`, sem import de `.ts`) e por isso mantém a
 * própria cópia — `test/session-beacon-blast-radius.test.ts` trava que os
 * dois conjuntos não divergem.
 */
export const COORDINATOR_SESSION_KINDS: readonly SessionKind[] = ["overnight", "develop", "continuo"];

/** `true` quando `kind` é uma das 3 coordenadoras (#6168). */
export function isCoordinatorKind(kind: string): boolean {
  return (COORDINATOR_SESSION_KINDS as readonly string[]).includes(kind);
}

/**
 * Os kinds com AUTORIDADE DE MERGE (#7702) — subconjunto próprio de
 * `COORDINATOR_SESSION_KINDS`.
 *
 * A docstring de `COORDINATOR_SESSION_KINDS` acima justificava o conjunto
 * dizendo que os 3 kinds "despacham subagentes implementadores **e decidem
 * quando um merge entra**". A segunda metade nunca foi verdade pra
 * `continuo`: `hermes/skills/hermes-diaria-continuo/SKILL.md` — o skill que
 * o cron do Hermes de fato roda, e o único consumidor real do kind (nenhuma
 * skill deste repo o usa, ver CLAUDE.md) — diz em dois lugares que
 * `continuo-pr-review.sh` é a **única autoridade de merge**. O tick abre PR
 * e para.
 *
 * As duas perguntas, agora separadas:
 *   - `COORDINATOR_SESSION_KINDS` — *"há rodada ativa?"* Chamador sem
 *     registro é subagente dela → bloqueia (#5716). `continuo` continua
 *     aqui: ela despacha implementadores, e é este registro que impede o
 *     subagente dela de mergear o próprio PR.
 *   - `MERGE_AUTHORITY_SESSION_KINDS` — *"quem decide que um merge entra, e
 *     portanto pode conceder janela?"* `continuo` sai.
 *
 * Enquanto eram um conjunto só, o efeito era uma inversão: o kind que nunca
 * mergeia bloqueava o `gh pr merge` de todos, e o que de fato mergeia
 * (`continuo-review`) não bloqueia ninguém. Somado a `attended: false` do
 * cron, `continuo` era uma coordenadora que só bloqueia e nunca concede —
 * toda sessão interativa que quisesse mergear com o contínuo no ar era
 * empurrada pro escape hatch do #7303.
 *
 * **Não confundir com `onlyUnreachableCoordinatorsActive`/#7546:**
 * *inalcançável* é "não dá pra PEDIR janela"; *sem autoridade de merge* é
 * "não há a quem pedir". Uma `overnight --unattended` é a primeira sem ser a
 * segunda — continua com autoridade, continua bloqueando, e o hatch do #7303
 * continua sendo o caminho dela.
 *
 * `test/session-beacon-blast-radius.test.ts` trava que este conjunto não
 * diverge de `MERGE_AUTHORITY_KINDS` (`block-gh-pr-merge-subagent.mjs`).
 */
export const MERGE_AUTHORITY_SESSION_KINDS: readonly SessionKind[] = ["overnight", "develop"];

/**
 * `true` quando `kind` decide merge — e portanto pode conceder janela (#7702).
 *
 * Type predicate (diferente de `isCoordinatorKind`, que devolve `boolean` cru):
 * depois de um `if (hasMergeAuthorityKind(k))` o TypeScript sabe que `k` é um
 * dos kinds com autoridade, em vez de seguir como `string`. Não muda call site
 * nenhum; só deixa de jogar fora a informação na saída.
 */
export function hasMergeAuthorityKind(
  kind: string,
): kind is (typeof MERGE_AUTHORITY_SESSION_KINDS)[number] {
  return (MERGE_AUTHORITY_SESSION_KINDS as readonly string[]).includes(kind);
}

/** Um worktree aberto por uma sessão (#6168 Parte A) — substitui e subsume o
 * `active_worktrees?: number`, que era só uma contagem e nunca foi populado
 * por skill nenhuma (#5156 item 6). */
export interface WorktreeRef {
  path: string;
  branch?: string;
  issue?: number;
}

/** Último verbo observado numa sessão + quando (#6168 Parte A). */
export interface SessionLastAction {
  verb: string;
  at: string;
}

export interface SessionRecord {
  kind: SessionKind;
  machineTag: string;
  sessionId: string;
  startedAt: string;
  lastHeartbeat: string;
  phase?: string;
  /**
   * **#6706 — NÃO é o PID da sessão Claude Code, apesar do nome e da
   * intenção original.** Gravado a partir de `process.ppid` no momento em
   * que o hook/beacon roda (ver `registerSession`/`heartbeat` acima) — a
   * premissa era que esse é o pid do processo PAI, persistente, da sessão.
   * Medição ao vivo (#6294, reconfirmada pelo #6706) mostrou o oposto: o pid
   * gravado é de um SUBPROCESSO EFÊMERO (o hook/tool-call em si), que já
   * morreu no instante em que qualquer leitor tenta checar `/proc`/`kill(pid,
   * 0)` — inclusive para sessões demonstravelmente vivas. Por isso
   * `decideSessionGc` (ver seu docblock, branch 3) só usa este campo pra
   * ESTENDER proteção quando aparenta vivo (nunca remove por ele estar
   * "morto" — decisão do #6294) — na prática esse branch quase nunca chega a
   * confirmar "vivo" de verdade, porque o valor gravado raramente corresponde
   * a um processo real. **Nunca tratar este campo como sinal de liveness em
   * NENHUM consumidor novo** — o sinal de liveness prático deste módulo é
   * `stale`/`SOFT_STALE_MS` (ver `listActiveSessions`), não `pid`. Mantido no
   * schema (não removido) porque `decideSessionGc` ainda o consulta como
   * proteção adicional best-effort e porque removê-lo exigiria coordenar a
   * mudança com `.claude/hooks/inject-session-id.mjs`/`session-beacon.mjs`
   * (fora deste módulo) — avaliado e adiado, não esquecido.
   */
  pid?: number;
  active_worktrees?: number;
  claimed_issues?: number[];
  /**
   * #6436 — timestamp (ISO) de quando cada issue de `claimed_issues` foi
   * reivindicada PELA PRIMEIRA VEZ por esta sessão. Chaveado pelo número da
   * issue como STRING (JSON não tem chave numérica). Escrito só em
   * `claimIssueCheckAndSet` no momento em que a issue passa a fazer parte de
   * `claimed_issues` (`reason: "claimed"`/`"forced-override"`) — uma
   * re-reivindicação da MESMA issue já claimed (`reason: "already-own"`,
   * o caso concreto do #6436: a sessão `continuo` re-chama `claim-issue` a
   * cada ciclo de 60min) NUNCA sobrescreve a entrada existente. Sem essa
   * distinção, o timestamp "refrescaria" a cada heartbeat e a idade do claim
   * nunca acumularia — exatamente o sintoma que fez #6051/#6185/#6186/#6431
   * ficarem `claimed-por-outra-sessao` indefinidamente, porque a sessão
   * `continuo` nunca solta (nem deixa "envelhecer") a claim. Usado por
   * `scripts/lib/claim-staleness.ts` pro teto de idade de claim sem PR
   * aberto. Ausente em registros anteriores ao #6436 — tratado como
   * "idade desconhecida", nunca como "acabou de reivindicar".
   */
  claimed_issues_at?: Record<string, string>;
  /** #8521 — HISTÓRICO: união de toda issue que esta sessão já reivindicou,
   * inclusive as depois liberadas por `unclaimIssue` (que só mexe em
   * `claimed_issues`/`claimed_issues_at`). Só cresce. Copiado pro evento de
   * lifecycle no `end` pro detector de fabricação distinguir "claim
   * liberada" de "claim nunca feita". Ausente em registros anteriores. */
  claimed_issues_ever?: number[];
  /**
   * #10618 (fatia 2) — claims de issue de OUTRO repo da allowlist
   * (`platform.config.json → issue_repos`, ex.: `vjpixel/diaria-design#21`),
   * na forma canônica `owner/repo#N`. Campo SEPARADO de `claimed_issues` de
   * propósito: `claimed_issues` é `number[]` e todo consumidor legado lê um
   * número pelado como `vjpixel/diaria-studio#N` — gravar `21` ali
   * reivindicaria o `diaria-studio#21` em silêncio. Nunca contém ref do repo
   * default (essa vai como número em `claimed_issues`, como sempre).
   * Mesma semântica de `claimed_issues` (união fail-safe entre cópias de
   * conflito, janela de retenção em `claimed_foreign_issues_effective`).
   */
  claimed_foreign_issues?: string[];
  /** #10618 — timestamp da 1ª reivindicação de cada ref de
   * `claimed_foreign_issues` (chave = `owner/repo#N`), mesma regra de
   * `claimed_issues_at` (#6436: nunca sobrescreve em `already-own`). */
  claimed_foreign_issues_at?: Record<string, string>;
  /** #10618 — histórico (só cresce) de `claimed_foreign_issues`, análogo a
   * `claimed_issues_ever` (#8521). */
  claimed_foreign_issues_ever?: string[];
  /** Branch atual do checkout ONDE O HOOK MORA (#6168 Parte A) — nunca a
   * branch de um worktree que a sessão só visitou via `cd` numa chamada de
   * Bash. Lido de `.git/HEAD` pelo beacon — sem subprocesso. É o campo que
   * responde "a branch ainda é minha?" antes de um `git commit` (evidência 5
   * da issue: outra sessão fez `checkout master` no meio, o commit caiu em
   * master, e `commit`/`push` reportaram sucesso).
   *
   * **#7722 — sessão que opera em worktrees via `cd` por chamada (o padrão
   * deste projeto: coordenadora rodando no checkout principal, `cd
   * <worktree> && …` dentro de CADA Bash) nunca vê essa realidade refletida
   * aqui.** Três sessões `overnight`/`develop`/`continuo` concorrentes, cada
   * uma num worktree com branch diferente, publicam TODAS a mesma `branch`
   * (a do checkout principal onde o hook do beacon mora) — comparar `branch`
   * entre peers pra decidir "quem está em qual branch" é enganoso nesse
   * caso. Usar `known_worktrees` (abaixo) pra saber, com precisão, qual
   * branch está em qual worktree AGORA. */
  branch?: string;
  /** Worktrees abertos POR ESTA SESSÃO (#6168 Parte A) — nunca populado até
   * hoje (nenhuma skill chama isto), mas o CONTRATO documentado é estreito
   * de propósito: `activeSessionWorktreePaths`
   * (`scripts/lib/shared-session-guard.ts`) trata qualquer path aqui como
   * "esta sessão está trabalhando exatamente aqui, nunca remover mesmo com
   * `--confirm-shared`". **#7722 item 2 considerou reaproveitar este campo
   * pra popular a foto GLOBAL de `git worktree list` — rejeitado no
   * self-review da própria PR**: teria alargado silenciosamente esse
   * contrato estreito pra "todo worktree que existe agora", esvaziando
   * `--confirm-shared` em `branch-cleanup.ts`. Ver `known_worktrees` abaixo
   * pro campo que de fato resolve o #7722 (semântica DIFERENTE, deixada
   * como campo distinto de propósito). */
  worktrees?: WorktreeRef[];
  /** Foto GLOBAL de todos os worktrees ATIVOS do repo — não só os desta
   * sessão (#7722 item 2; campo NOVO, distinto de `worktrees` acima de
   * propósito, ver o porquê no docblock dele). Escrito pelo beacon
   * (`resolveWorktreeBranches` em `.claude/hooks/session-beacon.mjs`, sem
   * spawnar processo — lê `.git/worktrees/<nome>/{HEAD,gitdir}`
   * diretamente), re-derivado do disco a CADA write (nunca faz merge com o
   * `known_worktrees` anterior — sempre a foto fresca, nunca acumula
   * entradas de worktrees já removidos). Consumido por
   * `selectInUseWorktreeNames` (`scripts/cleanup-merged-worktrees.ts`) só
   * como MAPA path→branch: protege um worktree (inclusive externo, fora de
   * `.claude/worktrees/`) quando ESTA sessão tocou um path dentro dele ou
   * reivindicou a issue da branch dele. **Nunca ler como "em uso"** — é a
   * foto global, e tratá-la assim protegia todo worktree do repo enquanto
   * houvesse qualquer sessão viva (#11317). */
  known_worktrees?: WorktreeRef[];
  /** Caminhos tocados nesta sessão, com teto (`TOUCHED_PATHS_CAP`) — colapsa
   * pra prefixo de diretório quando estoura. */
  touched_paths?: string[];
  /** Subconjunto de `touched_paths` ainda NÃO commitado — acumula em
   * Edit/Write e zera num `git commit`. É o campo com valor operacional real
   * (evidência 2 da issue: um tick terminou deixando 4 arquivos sem commit em
   * `master` num checkout compartilhado e reportou "concluído"; um beacon que
   * só dissesse `last_action: "commit"` não distinguiria isso de trabalho
   * fechado). */
  dirty_paths?: string[];
  /** Último verbo observado + timestamp (#6168 Parte A). */
  last_action?: SessionLastAction;
  /** Concessão de janela de merge EMITIDA por esta sessão coordenadora
   * (#6296). Campo no próprio record, deliberadamente NÃO um arquivo novo em
   * `data/sessions/` — o #6168 tem critério de aceite explícito de que nada
   * além de `.merge-lock.json` aparece ali, e a #6296 já admitia "arquivo
   * dedicado OU campo no próprio record". Ver `grantMergeWindow`. */
  merge_grant?: MergeGrant;
  /** Auto-autorização de merge REGISTRADA pela PRÓPRIA sessão bloqueada
   * (#7303) — escape hatch pro caso em que a(s) única(s) coordenadora(s)
   * ativa(s) é/são `continuo` (cron, não conversa) e por isso não há
   * ninguém pra pedir `grant-merge`. Vive no record da PRÓPRIA sessão
   * bloqueada (nunca no de uma coordenadora — ao contrário de `merge_grant`,
   * que é sempre emitido por quem concede), mesmo racional de "campo no
   * próprio record, não arquivo novo" do `merge_grant` acima. Ver
   * `selfAuthorizeMerge`. */
  self_authorized_merge?: SelfAuthorizedMerge;
  /**
   * #7546 — a sessão CONSEGUE receber um pedido (`SendMessage`/Remote
   * Control) de outra sessão? Existe pra corrigir um proxy errado em
   * `selfAuthorizeMerge`: o filtro de "coordenadora responsiva" usava
   * `kind !== "continuo"`, assumindo que todo `overnight`/`develop` é
   * alcançável e só `continuo` (cron) não conversa. Falso — um `overnight`
   * rodando como task agendada/dispatched (sem terminal interativo do outro
   * lado) tem exatamente a mesma propriedade de `continuo`: existe, está
   * ativo, mas não há como entregar mensagem nenhuma a ela. A pergunta certa
   * é "alcançável?", não "qual o kind?".
   *
   * Default quando ausente/`undefined` — decidido por `registerSession` a
   * partir do `kind` (`continuo` → `false`; qualquer outro → `true`) —
   * preserva o comportamento anterior a esta issue sem exigir que todo
   * call site existente passe o campo explicitamente. Um chamador que SABE
   * que está rodando desassistido (ex: um wrapper de scheduling que spawna
   * a sessão sem interlocutor) passa `--unattended` no CLI `register` pra
   * gravar `false` mesmo em kind `overnight`/`develop`.
   *
   * Não é auto-detectado a partir de sinais do harness (ex: variável de
   * ambiente de modo de execução) — nenhum sinal desses está confirmado
   * como estável/documentado no momento desta issue; inventar uma heurística
   * sobre um sinal não verificado seria pior que exigir o flag explícito.
   * Ver `selfAuthorizeMerge` pro consumidor.
   */
  attended?: boolean;
  /**
   * Campo COMPUTADO por `listActiveSessions` (#5474) — nunca persistido em
   * disco. `true` quando `now - lastHeartbeat > SOFT_STALE_MS`, sinalizando
   * que a sessão provavelmente está morta mesmo sem ter cruzado o teto
   * absoluto `MAX_SESSION_AGE_MS`. Ausente em registros lidos diretamente do
   * disco fora de `listActiveSessions`.
   */
  stale?: boolean;
  /**
   * #7028 — ISO timestamp de quando este registro deixou de representar uma
   * sessão viva. Só escrito por `registerSession` no registro ANTIGO durante
   * uma promoção de kind (ver seu docblock), como rede de segurança pro caso
   * de a remoção best-effort do arquivo antigo falhar (`outcome:
   * "promoted-orphan-left"`) — o conteúdo com claims/`merge_grant` migrados
   * fica em disco, mas marcado. `dedupeBySessionId` exclui registros com
   * `endedAt` da consideração de "sessão viva" antes de escolher a base do
   * grupo, então um órfão carimbado nunca volta a contar como coordenador
   * ativo pro guard de merge do #5716. O outro escritor é `endSession`
   * (#7002), que APAGA o arquivo real e carimba este campo nas cópias de
   * conflito do grupo. Se o sync depois ressuscitar o real com um heartbeat
   * ANTERIOR ao carimbo, o carimbo da cópia vence (#13114, ver
   * `endedAfterLastHeartbeat`).
   */
  endedAt?: string;
  [key: string]: unknown;
}

/**
 * Um `SessionRecord` que JÁ PASSOU por `listActiveSessions` — `stale` está
 * computado, não é mais opcional.
 *
 * Existe porque a distinção importa e não estava expressa em lugar nenhum:
 * `stale` é OPCIONAL em `SessionRecord` (nunca é persistido em disco), e todo
 * consumidor que decide por `if (peer.stale) continue` trata `undefined`
 * exatamente como `false`. Passar records CRUS — saídos de `readJsonSafe`/
 * `readMergedSessionGroups` — para `findSessionConflicts`/
 * `isIssueClaimedByOther` faria **todos** contarem como vivos em silêncio,
 * ressuscitando claims de sessões mortas justamente nas funções que existem
 * pra respeitar staleness (#5474).
 *
 * Hoje todos os call sites de produção fazem a coisa certa. Exigir este tipo
 * na assinatura transforma isso de disciplina em garantia: o compilador
 * recusa a lista crua, e quem quiser consultá-la precisa ir por
 * `listActiveSessions` primeiro.
 *
 * `claimed_issues_effective` (#6623): `claimed_issues` bruto continua no
 * record (diagnóstico/histórico), mas quem só quer saber "quais issues esta
 * sessão segura DE VERDADE agora" lê este campo em vez de re-derivar —
 * mesmo princípio de `issue-decisions.ts`/`classifyExecTrack`, julgamento
 * feito uma vez aqui, nunca re-heurística por call site. Vazio quando
 * `ageMs > claimReleaseMsForKind(kind)` (a mesma regra que `is-claimed` já
 * aplica via `isIssueClaimedByOther` — ver docstring de `CLAIM_RELEASE_MS`).
 * **Desde o #7227, isto NÃO é mais o mesmo limiar que `stale`** (que continua
 * marcado a partir de `softStaleMsForKind`, 90min/15min): uma sessão pode
 * estar `stale: true` ("provavelmente ociosa", observável) e ainda assim ter
 * `claimed_issues_effective` populado, porque liberar o claim (autoriza
 * terceiro a tomar o trabalho) exige uma janela de silêncio bem mais
 * conservadora do que só marcar a sessão como não-obviamente-ativa (achado do
 * #7194/#7227: sessão viva presa num `AskUserQuestion`/sequência MCP longa
 * teve o claim liberado e o trabalho tomado por outra sessão). Igual a
 * `claimed_issues` quando dentro da janela de retenção.
 */
export type ActiveSessionRecord = SessionRecord & {
  stale: boolean;
  claimed_issues_effective: number[];
  /** #10618 — análogo de `claimed_issues_effective` para
   * `claimed_foreign_issues` (refs `owner/repo#N` de outro repo). Opcional só
   * pra não quebrar fixtures de teste montadas à mão; `listActiveSessions`
   * sempre preenche. */
  claimed_foreign_issues_effective?: string[];
  /** #11299 — só no `list-active` do CLI: a MESMA sessão foi coordenadora até
   * pouco antes (ver `annotatePreviousCoordinator`). Ausente no caso comum. */
  previous_coordinator?: PreviousCoordinatorNote;
};

/**
 * #11299 — "esta sessão `interactive` era uma rodada coordenadora que acabou de
 * chamar `end`". Achado da rodada 261027c: a 261027b (Neo, sessão 150a0611)
 * registrou `overnight` às 04:59Z, reivindicou 10 issues, mergeou a última às
 * 12:48:17Z e chamou `end` às 12:48:25Z (evento `ended` em
 * `data/session-lifecycle.jsonl`). Três segundos depois, a próxima chamada de
 * ferramenta da MESMA conversa fez o beacon (`session-beacon.mjs`) criar
 * `interactive-Neo-150a0611…json` do zero — correto: a conversa seguia viva e
 * já não era coordenadora. A 261027c começou às 12:50:39Z, viu a sessão como
 * `interactive` sem `claimed_issues` e leu isso como "o register não valeu na
 * Neo" ou "o beacon rebaixou o registro". Nenhum dos dois aconteceu; o que
 * faltava era o `list-active` dizer de onde aquele registro vinha. Esta nota
 * vem do log de lifecycle (o arquivo coordenador já foi apagado por
 * `endSession`) e é só diagnóstico: não muda claim, liveness nem guard.
 */
export interface PreviousCoordinatorNote {
  kind: SessionKind;
  event: SessionLifecycleEventType;
  /** `ts` do evento de lifecycle (momento do `end`/remoção). */
  endedAt: string;
  startedAt?: string | null;
  claimed_issues_ever?: number[];
}

/** Janela em que um fim de rodada coordenadora ainda explica um registro
 * `interactive` da mesma sessão (#11299). 24h = `MAX_SESSION_AGE_MS`. */
export const PREVIOUS_COORDINATOR_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MergeLockRecord {
  heldBy: string;
  acquiredAt: string;
}

/**
 * Teto ABSOLUTO de segurança contra dado corrompido/clock skew — mesma janela
 * de staleness dos dois hooks irmãos (#3322/#4450). NÃO é um sinal de
 * liveness prático: uma sessão pode estar morta havia horas e ainda cair
 * dentro desta janela de 24h. `SOFT_STALE_MS` abaixo é o sinal de liveness
 * real (#5474) — `MAX_SESSION_AGE_MS` só existe para não deixar uma sessão
 * abandonada aparecer como "ativa" para sempre.
 */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Sinal de liveness prático (#5474, sugestão 1/3 da issue) — distinto do teto
 * absoluto `MAX_SESSION_AGE_MS` acima. Investigação ao vivo em 16/08/2026
 * achou 2 sessões com heartbeat visivelmente morto (~3h e ~10h stale) ainda
 * listadas como "ativas" porque o único critério existente era o TTL de 24h.
 * Causas raiz: `/diaria-develop` só chama `session-registry.ts end` na Fase 2
 * (crash antes disso deixa o registro órfão até o TTL); `/diaria-continuo`
 * pausa (não encerra) ao colidir com edição em curso e nada chama `end` nesse
 * estado se o processo morrer pausado.
 *
 * 90 minutos — mesma ordem de grandeza do threshold de stall já usado em
 * outros lugares do repo (#2768/#2896; `OVERNIGHT_STALL_THRESHOLD_MIN`, 60
 * min quando esta constante foi escolhida, 45 desde o #5568), com folga
 * extra para a latência de sync do OneDrive entre máquinas (que o TTL de 24h
 * não precisava considerar por ser tão folgado).
 *
 * `listActiveSessions` continua usando `MAX_SESSION_AGE_MS` como corte
 * absoluto (sessão > 24h simplesmente não aparece na lista) — `SOFT_STALE_MS`
 * NÃO remove a sessão da lista, só marca o campo computado `stale: true` em
 * cada registro retornado, para visibilidade sem quebrar consumidores que
 * dependem da lista completa (`overnight-watchdog.ts`,
 * `cleanup-merged-worktrees.ts`). **#7227: `isIssueClaimedByOther` (consumida
 * pelo CLI `is-claimed`) NÃO trata mais `stale: true` sozinho como sinal
 * não-bloqueante** — lê `claimed_issues_effective`, que só esvazia na janela
 * de `claimReleaseMsForKind` (24h pros 3 kinds coordenadores; ver sua
 * docstring pro porquê de ser mais longa que `SOFT_STALE_MS`). Uma claim de
 * sessão com heartbeat morto há mais de `SOFT_STALE_MS` mas menos que
 * `claimReleaseMsForKind` CONTINUA impedindo outra sessão de reivindicar a
 * mesma issue.
 *
 * **`SOFT_STALE_MS` é rede de segurança, não o sinal primário de liveness na
 * prática (#6327).** Desde o beacon (`.claude/hooks/session-beacon.mjs`,
 * #6303), `lastHeartbeat` de QUALQUER sessão viva — coordenadora ou não —
 * normalmente já vem fresco por outro caminho, a cada chamada de ferramenta,
 * sem a skill precisar chamar nada. Este teto de 90min só é o que decide na
 * prática quando esse caminho falha (beacon desligado, worktree vinculado,
 * `data/` ausente) — ver a docstring de `heartbeat()` abaixo pro mecanismo
 * completo e o que quebra em silêncio se o beacon for reduzido/desligado.
 */
export const SOFT_STALE_MS = 90 * 60 * 1000;

/**
 * Janela de liveness do kind `interactive` (#6168) — MUITO menor que os 90
 * min de `SOFT_STALE_MS`, e a razão é a objeção que quase derrubou a Parte B
 * da issue: uma sessão interativa **não emite heartbeat depois que a conversa
 * termina**. O beacon é hook `PreToolUse`, então o heartbeat é automático
 * *enquanto a sessão está viva* — sem nenhuma skill precisar lembrar de nada —
 * mas quando o editor fecha a conversa as chamadas simplesmente param, e o
 * registro sobrevive.
 *
 * Com a janela de 90 min compartilhada, registrar interativas trocaria risco
 * de COLISÃO por risco de CLAIM ÓRFÃ — que é pior, porque não se resolve
 * sozinha: overnight/develop pulariam issues por até 1h30 por causa de uma
 * sessão que já morreu (é literalmente a evidência 1 da issue, com uma sessão
 * develop segurando #6128/#6181 depois de terminada).
 *
 * 15 minutos: folgado o bastante pra cobrir o editor lendo/pensando entre duas
 * chamadas de ferramenta, curto o bastante pra uma conversa encerrada liberar
 * as claims dela dentro de um ciclo de rodada, não de uma hora e meia.
 */
export const INTERACTIVE_SOFT_STALE_MS = 15 * 60 * 1000;

/**
 * Janela de liveness aplicável a `kind` (#6168) — `interactive` tem a sua
 * própria (ver `INTERACTIVE_SOFT_STALE_MS`); os 3 kinds coordenadores mantêm
 * `SOFT_STALE_MS` sem nenhuma mudança de comportamento.
 */
export function softStaleMsForKind(kind: string): number {
  return kind === "interactive" ? INTERACTIVE_SOFT_STALE_MS : SOFT_STALE_MS;
}

/**
 * #7227 — janela que decide quando `claimed_issues_effective` de fato esvazia
 * (libera a issue pra outra sessão reivindicar/tomar). **Decoupled de
 * `softStaleMsForKind`** de propósito: `stale`/`SOFT_STALE_MS` continuam
 * exatamente como eram (sinal OBSERVACIONAL — "não vejo heartbeat há X min",
 * visível em `session.stale` pra quem monitora), mas deixaram de ser,
 * sozinhos, o critério que autoriza um terceiro a assumir trabalho reivindicado.
 *
 * ## Por que não usar `pid` (a sugestão original da issue)
 *
 * A #7227 propõe checar `pid` (`register --pid`, #6160) como sinal POSITIVO de
 * morte antes de esvaziar o claim. **Este módulo já mediu essa premissa como
 * falsa (#6294/#6706, ver a docstring do campo `pid` em `SessionRecord`):** o
 * valor gravado é o PID de um subprocesso EFÊMERO do hook (`process.ppid` no
 * momento da chamada), não o processo persistente da sessão — na prática o
 * campo raramente confirma "vivo" de verdade, e um `pid` "morto" não indica
 * sessão morta, só que a fonte do dado é ruim. Por isso o #6294 já revogou
 * "pid morto → remove" em `decideSessionGc`, e a docstring do campo é
 * explícita: "nunca tratar como sinal de liveness em NENHUM consumidor novo".
 * Repetir o padrão aqui reintroduziria exatamente o risco que o #6294 fechou —
 * só que na decisão de MAIOR blast radius deste módulo (autorizar terceiro a
 * mexer em trabalho alheio), não na de menor (apagar um arquivo de registro).
 *
 * ## A resposta conservadora sem sinal positivo confiável disponível
 *
 * Sem um sinal de morte em que dá pra confiar, a via seguindo o princípio
 * "errar pro lado de não liberar é preferível" (#7227) é alongar a janela de
 * SILÊNCIO exigida antes de liberar — nunca encurtar. Reusa o valor de
 * `MAX_SESSION_AGE_MS` (24h) — não um número novo: é o único ponto onde este
 * módulo já tratava uma sessão como certamente ausente (ela some da lista
 * inteira em `listActiveSessions`, então `isIssueClaimedByOther` já não a
 * enxergaria de qualquer forma). Entre `SOFT_STALE_MS`/`softStaleMsForKind`
 * (90min, ou 15min pra `interactive`) e esta janela, a sessão aparece com
 * `stale: true` — "provavelmente ociosa", visível pra quem observa — mas
 * `claimed_issues_effective` continua com a issue: ninguém pode assumir o
 * trabalho antes disso. Cobre o incidente concreto do #7194/#7227 (sessão
 * `develop` presa ~2-3h num `AskUserQuestion`/sequência MCP) com folga.
 *
 * `interactive` é a ÚNICA exceção — mantém a janela CURTA (`INTERACTIVE_SOFT_STALE_MS`,
 * 15min) mesmo pra claim, sem mudança de comportamento (ver
 * `claimReleaseMsForKind`). Uma conversa interativa que terminou não emite
 * heartbeat nunca mais e não chama `end` — alongar a retenção de claim dela
 * pra 24h reabriria exatamente a "claim órfã" que o #6168 (que introduziu
 * `INTERACTIVE_SOFT_STALE_MS`) foi desenhado pra evitar: overnight/develop
 * pulando issue livre por até 1 dia inteiro por causa de uma sessão que já
 * terminou. Sessões coordenadoras (`overnight`/`develop`/`continuo`) SEMPRE
 * chamam `end` ao encerrar de propósito (ou ficam órfãs só por crash — o caso
 * que esta janela protege) — a assimetria de risco entre os dois grupos é
 * real, não um descuido.
 *
 * @alias de `MAX_SESSION_AGE_MS`, de propósito (tag lida pelo knip, que senão
 * acusa "Duplicate exports" no `export const X = Y`, #14004).
 */
export const CLAIM_RELEASE_MS = MAX_SESSION_AGE_MS;

/**
 * Janela de retenção de claim aplicável a `kind` (#7227) — `interactive`
 * mantém a janela curta de sempre (`INTERACTIVE_SOFT_STALE_MS`, idêntica à de
 * `softStaleMsForKind`, comportamento inalterado); os 3 kinds coordenadores
 * usam `CLAIM_RELEASE_MS` (24h), bem mais longa que `SOFT_STALE_MS` (90min) —
 * ver a docstring de `CLAIM_RELEASE_MS` pro porquê da divergência.
 */

export function claimReleaseMsForKind(kind: string): number {
  return kind === "interactive" ? INTERACTIVE_SOFT_STALE_MS : CLAIM_RELEASE_MS;
}

/** TTL do merge lock (item 4) — merge + pull não deveria levar mais que isso. */
export const MERGE_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * TTL da concessão de janela de merge (#6296). Maior que `MERGE_LOCK_TTL_MS`
 * de propósito: o lock cobre só `gh pr merge` → `git pull` (segundos), mas a
 * concessão nasce de uma CONVERSA entre sessões — o peer confere colisão por
 * arquivo nos PRs abertos dele antes de conceder, e quem recebeu ainda vai
 * rodar o gate de 2 condições antes de mergear. 10 minutos cobre esse
 * intervalo sem virar permissão semi-permanente.
 */
export const MERGE_GRANT_TTL_MS = 10 * 60 * 1000;

/**
 * Teto de `touched_paths`/`dirty_paths` por sessão (#6168 Parte A). Acima
 * disso, `collapseTouchedPaths` troca os caminhos por prefixos de diretório —
 * o beacon roda em TODA chamada de ferramenta, e um registro que cresce sem
 * limite num diretório sincronizado por OneDrive é exatamente o tipo de
 * arquivo que gera cópia de conflito `-safeBackup-NNNN` (#5427/#6130).
 */
export const TOUCHED_PATHS_CAP = 200;

/**
 * Concessão de janela de merge (#6296) — emitida por uma sessão COORDENADORA
 * registrada para uma outra sessão (tipicamente interativa) que negociou a
 * janela por conversa (Parte F do #6168).
 *
 * Uso único e TTL curto: morre no primeiro merge (`consumedAt`) ou em
 * `MERGE_GRANT_TTL_MS`, o que vier antes. Nunca é permissão permanente, e
 * **ninguém concede a si mesmo** (ver `grantMergeWindow`) — é isso que
 * preserva a propriedade que o #5716 protege (o coordenador decide quando
 * entra merge) em vez de contorná-la.
 */
export interface MergeGrant {
  /** `sessionId` de quem recebeu a janela. */
  grantedTo: string;
  /** `sessionId` da coordenadora que concedeu. */
  grantedBy: string;
  /** PR que a janela autoriza — informativo/auditoria. */
  pr?: number;
  /**
   * #10618: repo do `pr` (`owner/name`). Ausente = `vjpixel/diaria-studio`
   * (todo grant anterior ao #10618). O guard do #5716 só aceita a janela
   * quando bate com o repo do `gh pr merge` — o PR #23 do diaria-design não
   * é o #23 do diaria-studio.
   */
  repo?: string;
  grantedAt: string;
  /** Preenchido quando a janela é consumida; concessão consumida não vale mais. */
  consumedAt?: string;
}

/**
 * Registro de auto-autorização de merge (#7303) — a saída de escape quando o
 * guard do #5716 bloqueia `gh pr merge` e a(s) única(s) coordenadora(s) ativa(s)
 * é/são `continuo`: um cron não lê `SendMessage` nem concede `grant-merge`, e a
 * saída documentada (pedir a janela à coordenadora ativa) fica inalcançável.
 *
 * Diferente de `MergeGrant` — que é emitido por UMA sessão (a coordenadora)
 * PARA OUTRA (a beneficiária) — este registro é a PRÓPRIA sessão bloqueada
 * se autorizando, de forma explícita e auditável ("registro explícito de que
 * agiu sem concessão", conforme a Direção 2 da issue). `reason` é obrigatório
 * — nunca uma auto-autorização silenciosa. Uso único de fato via TTL curto
 * (mesmo `MERGE_GRANT_TTL_MS` de `MergeGrant`) — não há campo `consumedAt`
 * porque o consumo de uma auto-autorização não precisa de contabilidade: ela
 * expira sozinha e uma nova auto-autorização sempre pode ser emitida (ao
 * contrário de `MergeGrant`, cujo uso único protege contra um TERCEIRO
 * consumir a concessão de outra sessão — aqui não há terceiro, é a própria
 * sessão se autorizando).
 *
 * Ver `selfAuthorizeMerge` — só emite quando NENHUMA coordenadora ativa tem
 * kind diferente de `continuo` (havendo uma `overnight`/`develop` ativa, o
 * caminho normal de `grant-merge` continua sendo o único, porque ali SIM há
 * um interlocutor). O guard mecânico
 * (`.claude/hooks/block-gh-pr-merge-subagent.mjs`) trata uma auto-autorização
 * viva exatamente como uma concessão — ela destrava IDENTIDADE, nunca TEMPO
 * (mesmo princípio do #6303 P1·a): quem tem uma auto-autorização ainda passa
 * pela composição com o merge lock antes de poder mergear de fato, então a
 * serialização com um `gh pr merge` que a coordenadora `continuo` esteja
 * rodando naquele instante continua garantida pelo lock, não pela
 * auto-autorização.
 */
export interface SelfAuthorizedMerge {
  /** Motivo declarado pela sessão — obrigatório, nunca vazio (#7303: nunca
   * uma auto-autorização silenciosa). */
  reason: string;
  /** PR que a auto-autorização cobre — informativo/auditoria, e escopo
   * (mesma semântica de `MergeGrant.pr`: ausente = cobre qualquer PR). */
  pr?: number;
  /** #10618: mesmo papel de `MergeGrant.repo` (ausente = diaria-studio). */
  repo?: string;
  authorizedAt: string;
}

/**
 * Evento de instrumentação do ciclo de vida de uma sessão COORDENADORA
 * (#6624) — JSONL append-only em `data/session-lifecycle.jsonl`, mesmo
 * padrão de `data/run-log.jsonl`. Existe pra responder, com DADO em vez de
 * suposição, a pergunta que a issue faz: "sessões coordenadoras terminam sem
 * chamar `end` com que frequência?".
 *
 *   - `"ended"` — `endSession` de fato removeu um registro coordenador (fim
 *     limpo, o caminho que a skill percorre normalmente ao terminar).
 *   - `"gc-removed-without-end"` — o GC (`garbageCollectSessions`) removeu o
 *     arquivo REAL de um grupo coordenador por staleness (não um backup
 *     órfão de um grupo já sem real — esse é resíduo de uma sessão que JÁ
 *     tinha chamado `end`, não o caso que esta issue investiga). É o sinal
 *     direto de "esta sessão nunca chamou `end`" — só o GC (que decide por
 *     heartbeat/PID morto) chega a remover um arquivo real coordenador vivo
 *     o bastante pra nunca ter passado pela Fase 2 de encerramento da skill.
 *   - `"swept-without-end"` (#10020) — o sweep de ticks órfãos do contínuo
 *     (`scripts/sweep-continuo-orphan-sessions.ts`, #10002) encerrou o
 *     registro de um tick que morreu sem chamar `end`. Mesma classe de
 *     `"gc-removed-without-end"` (a sessão NUNCA chamou `end`), só que
 *     removida por outro caminho — antes do #10020 o sweep usava
 *     `endSession` com o evento default `"ended"` e a falha sumia do
 *     relatório (`session-lifecycle-report.ts`) justamente nas noites em que
 *     dezenas de ticks morrem por cota.
 */
export type SessionLifecycleEventType = "ended" | "gc-removed-without-end" | "swept-without-end";

export interface SessionLifecycleEvent {
  event: SessionLifecycleEventType;
  kind: SessionKind;
  machineTag: string;
  sessionId: string;
  /** ISO — momento em que o evento foi registrado (nunca o `lastHeartbeat`
   * do record removido, que é outra coisa). */
  ts: string;
  /** Idade da sessão (`ts` do evento menos `startedAt` do record removido),
   * em ms — `undefined` quando `startedAt` não foi legível. Só contexto pra
   * quem for analisar o log depois; não entra em nenhuma decisão. */
  ageMs?: number;
  /** `startedAt`/`lastHeartbeat` do record removido, capturados ANTES da
   * remoção (#8378) — existem pra reconstruir a JANELA `[startedAt,
   * lastHeartbeat]` da sessão depois que o arquivo real já sumiu de
   * `data/sessions/`. Sem isto, `endSession` apagando o arquivo (`rmSync`)
   * torna TODA sessão `kind=continuo` que termina limpo invisível pra
   * `continuo-session-registration-check.ts` — o checker roda depois,
   * hora em hora, e por essa hora o registro já não existe mais; o alarme
   * "sem sessão registrada" nesse caso é falso-positivo estrutural, não
   * evidência de que `register` não rodou. `null` quando o campo não era
   * legível no record; ambos `undefined` só em eventos gravados antes desta
   * mudança (log histórico, nunca reescrito). */
  startedAt?: string | null;
  lastHeartbeat?: string | null;
  /** #8521 — snapshot das issues reivindicadas pela sessão no momento da
   * remoção (`record.claimed_issues`). Permite ao detector de fabricação do
   * contínuo (`hermes/scripts/detect-tick-claim-fabrication.py`) comparar as
   * issues ALEGADAS no relatório com as claims REALMENTE registradas mesmo
   * depois que `endSession` apagou o arquivo da sessão (caso: coordenador
   * roda `end` de verdade mas fabrica uma claim específica). Ausente só em
   * eventos gravados antes desta mudança (retrocompatível: o detector cai no
   * comportamento antigo); `[]` = a sessão terminou sem nenhuma claim. */
  claimed_issues?: number[];
  /** #8521 — HISTÓRICO de claims da sessão (`claimed_issues_ever` do record ∪
   * claims finais), inclusive liberadas antes do `end`. É o que o detector usa
   * pra decidir "claim nunca feita"; `claimed_issues` (estado final) sozinho
   * daria falso positivo pra claim liberada por unclaim. Ausente em eventos
   * legados (=> detector: indeterminate). Limitação transitória: sessão
   * registrada antes desta mudança que liberou uma claim antes do deploy não
   * a tem no histórico. */
  claimed_issues_ever?: number[];
  /** #10618 (fatia 2) — snapshot de `claimed_foreign_issues` (claims de OUTRO
   * repo, `owner/repo#N`) no momento da remoção. Presente só quando a sessão
   * teve alguma claim de outro repo (shape legado intacto no resto). */
  claimed_foreign_issues?: string[];
  /** #10618 — histórico (ever ∪ finais) das claims de outro repo. */
  claimed_foreign_issues_ever?: string[];
}
