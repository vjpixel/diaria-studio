#!/usr/bin/env npx tsx
/**
 * scripts/lib/session-registry.ts (#5156)
 *
 * Registro compartilhado e leve de sessões ATIVAS — `/diaria-overnight`,
 * `/diaria-develop`, `/diaria-continuo`, e (desde #6168) sessões INTERATIVAS
 * comuns via o beacon automático (`.claude/hooks/session-beacon.mjs`).
 * (#6303 Finding Q: o texto anterior aqui listava só overnight/develop —
 * já estava impreciso antes do #6168 adicionar `continuo`, e o #6168 piorou
 * ao acrescentar o 4º kind sem atualizar este parágrafo.) Nasceu pela
 * "Direção sugerida" do #5156, que audita 11 colisões concretas entre as
 * skills coordenadoras rodando em paralelo (mesma máquina ou máquinas
 * diferentes sincronizadas pelo mesmo junction OneDrive `data/`).
 *
 * Um arquivo por sessão viva: `data/sessions/{kind}-{machineTag}-{sessionId}.json`.
 * `sessionId` é o `session_id` que o harness do Claude Code injeta no payload de
 * TODO hook `PreToolUse`/`PostToolUse` (confirmado contra a doc oficial,
 * `code.claude.com/docs/en/hooks`, ao desenhar este PR) — nunca exposto
 * diretamente à sessão rodando (não há env var `CLAUDE_SESSION_ID`, também
 * confirmado contra a doc). Por isso a ESCRITA deste registro nunca é feita
 * pelo coordenador "sabendo" o próprio session_id: o coordenador chama este CLI
 * SEM `--session-id`, e `.claude/hooks/inject-session-id.mjs` (novo, PreToolUse
 * sobre `Bash`) injeta `--session-id {payload.session_id}` no comando ANTES da
 * execução (`updatedInput.command`) — o mesmo mecanismo, aplicado também a
 * `scripts/overnight-session-marker.ts --start`/`--phase` (ver docblock de lá).
 *
 * **Coexistência deliberada com `data/overnight/.active-session-{tag}.json`
 * (item 10 do #5156):** o marker antigo, por-máquina, especializado no guard
 * de `AskUserQuestion` (#4450) e no desconto de effort do `/code-review`
 * (#3322), CONTINUA existindo e sendo escrito/lido exatamente como antes —
 * ver `scripts/overnight-session-marker.ts` e os dois hooks que o consomem.
 * Migrar esses dois mecanismos pra dentro deste registro foi avaliado e
 * descartado: a rodada `/diaria-overnight` que estava genuinamente ativa em
 * OUTRA máquina (`helios`) no momento em que este PR foi escrito usa o
 * formato antigo (sem `session_id`) — qualquer migração que exigisse reescrever
 * esse marker quebraria a rodada em voo. Este registro é aditivo: cobre os
 * itens 3/4/6/7/9 do #5156 (claim de issue, merge lock, teto de concorrência,
 * herança de plano em voo, cleanup de worktree), que não têm mecanismo prévio
 * nenhum — não substitui nada que já funcionava.
 *
 * **Staleness:** mesma janela de 24h usada por `isOvernightRoundActive`
 * (`pr-create-review.mjs`) e `shouldBlockAskUserQuestion`
 * (`block-askuserquestion-overnight-autonomous.mjs`) — uma rodada
 * crashada/abandonada não deve aparecer como "ativa" pra sempre.
 * `listActiveSessions` filtra por `lastHeartbeat` (ou `startedAt` se nunca
 * houve heartbeat) dentro de `[0, maxAgeMs]` — mesmo guard de clock-skew dos
 * dois hooks (idade negativa, ex: relógio adiantado gravando no futuro, nunca
 * conta como "ativa").
 *
 * **Merge lock (item 4):** `data/sessions/.merge-lock.json`, TTL curto (2 min —
 * a janela real é só `gh pr merge` + `git pull`, nunca deveria levar mais que
 * isso). Lock mais velho que o TTL é tratado como abandonado e liberado pro
 * próximo `acquireMergeLock` — nunca trava a máquina pra sempre por um
 * coordenador que crashou segurando o lock. **Nota (#6182): entre máquinas,
 * `O_CREAT|O_EXCL` sobre o mesmo junction OneDrive NÃO é garantia de exclusão
 * mútua real — o kernel vê inodes diferentes, cada máquina pode criar o arquivo
 * e ambas recebem `true`. O lock é **advisory** nesse cenário, não atômico.**
 *
 * **Claim de issue (item 3):** embutido no próprio registro de sessão
 * (`claimed_issues: number[]`) em vez de um arquivo `claims.jsonl` separado —
 * mais simples (a issue #5156 já sugeria essa opção como preferível), e o
 * dado morre junto com a sessão que fez o claim (staleness compartilhada).
 *
 * Uso CLI (chamado pelas skills — sempre SEM `--session-id`, injetado pelo
 * hook, ver acima):
 *   npx tsx scripts/lib/session-registry.ts register --kind overnight|develop|continuo [--pid N]
 *   npx tsx scripts/lib/session-registry.ts heartbeat --kind ... [--phase X] [--active-worktrees N]
 *   npx tsx scripts/lib/session-registry.ts end --kind ... [--tag MAQUINA] [--allow-dirty]
 *     (`--tag` opcional, #5797: default é o machineTag() local; passar o tag de
 *     OUTRA máquina permite encerrar daqui um registro que não é seu — ver
 *     "Defeito 4" do #5797. `end` também distingue "removeu de fato" de "não
 *     havia nada pra remover": esta última reporta `exit 1` e a mensagem
 *     "nothing to end", nunca "ended". #6922: `end` recusa (`exit 1`) só quando
 *     `repoRoot` tem mudanças não commitadas ATRIBUÍVEIS a esta sessão
 *     (interseção com touched_paths/dirty_paths do próprio registro) — ver
 *     `evaluateEndGuard`; sujeira de outra sessão concorrente no mesmo
 *     checkout compartilhado (#6168, a norma) nunca bloqueia, só avisa.
 *     `--allow-dirty` bypassa tudo explicitamente.)
 *   npx tsx scripts/lib/session-registry.ts claim-issue --kind ... --issue N [--force]
 *     (#6236: check-and-set — recusa (`exit 1`) quando outra sessão ATIVA já
 *     segura a issue, imprimindo quem/desde quando. `--force` toma o claim
 *     mesmo assim — escape hatch pra retomar issue de sessão morta sem
 *     esperar a staleness de 24h. Reivindicar o que a própria sessão já tem
 *     é sempre no-op de sucesso, nunca recusa. #6369: sessão sem registro
 *     prévio não vira mais no-op silencioso — o CLI auto-registra uma sessão
 *     mínima e tenta o claim de novo (ver `claimIssueAutoRegistering`),
 *     avisando na própria mensagem de sucesso quando isso acontece. #7003:
 *     quando a âncora sumiu com a sessão VIVA — e cópias de conflito órfãs
 *     dela ainda estão frescas — o registro é RECONSTRUÍDO a partir delas em
 *     vez de recriado zerado, com `[ALERTA: ...]` na mensagem.)
 *   npx tsx scripts/lib/session-registry.ts is-claimed --issue N
 *   npx tsx scripts/lib/session-registry.ts list-active
 *   npx tsx scripts/lib/session-registry.ts merge-lock-acquire --pr N
 *     (#6334: deixou de ser reentrante pra mesma sessão — uma 2ª chamada
 *     antes do `merge-lock-release` correspondente falha, mesmo sendo a
 *     mesma sessão. Ver `merge-lock-renew` pra estender o TTL de um hold
 *     que já é seu. **`--pr` não é opcional na prática (#7169/#7223,
 *     achado ao vivo na rodada helios/#7217):** o próprio `BLOCK_REASON`
 *     de `.claude/hooks/block-gh-pr-merge-subagent.mjs` já recomenda
 *     `merge-lock-acquire --pr N`/`merge-lock-release --pr N` — seguir o
 *     comando SEM `--pr` deixou `gh pr merge` bloqueado repetidamente pelo
 *     guard #5716 mesmo com lock genuinamente adquirido.)
 *   npx tsx scripts/lib/session-registry.ts merge-lock-release --pr N
 *   npx tsx scripts/lib/session-registry.ts merge-lock-renew
 *     (#6334 — renova o TTL de um lock que a PRÓPRIA sessão já detém; nunca
 *     concede um hold novo. Ver `renewMergeLock`.)
 *   npx tsx scripts/lib/session-registry.ts conflicts [--paths a.ts,b.ts] [--branch X]
 *     (#6168 Parte C — CONSULTA "quem mais está mexendo nisto?", nunca
 *     adquire nada nem cria arquivo; `exit 1` = sobreposição real com peer
 *     VIVO, `exit 0` = livre.)
 *   npx tsx scripts/lib/session-registry.ts grant-merge --kind ... --granted-to SESSION_ID [--pr N]
 *     (#6296 — só coordenadora concede, nunca a si mesma; TTL curto, uso
 *     único. Ver `grantMergeWindow`.)
 *   npx tsx scripts/lib/session-registry.ts check-merge-grant
 *     (#6296 — confirma se existe concessão viva pra esta sessão; `exit 1`
 *     quando não há. #6972: o JSON traz `source` ("real"/"backup") e
 *     `visible_to_merge_gate`, e um grant que só existe em cópia de conflito
 *     do OneDrive imprime aviso em stderr — o gate de merge NÃO o honra, e
 *     `granted: true` sozinho já mandou duas sessões investigarem a coisa
 *     errada. Ver `findLiveMergeGrant`.)
 *   npx tsx scripts/lib/session-registry.ts consume-merge-grant
 *     (#6296 — marca a concessão viva desta sessão como consumida, uso
 *     único; desde #6303 também disparado automaticamente por
 *     `.claude/hooks/consume-merge-grant-on-merge.mjs` após um `gh pr merge`
 *     bem-sucedido, sem depender de a sessão beneficiada lembrar de chamar
 *     isto à mão. Ver `consumeMergeGrant`. **#7171 — NUNCA rodar isto à mão
 *     ANTES do `gh pr merge`:** `consumedAt` é o carimbo que o MERGE deixa,
 *     não um passo que quem recebe a janela executa antes de usá-la —
 *     chamar isto antes do merge DESTRÓI a autorização que `gh pr merge` ia
 *     consultar (o comando responde `ok` mesmo assim, sem indicar que acabou
 *     de queimar a própria janela) e o merge seguinte é bloqueado pelo guard
 *     do #5716 mesmo com `check-merge-grant` tendo confirmado `granted:
 *     true` segundos antes. O caminho feliz não tem `consume-merge-grant`
 *     nele: `grant-merge` (coordenadora) → `check-merge-grant` →
 *     `merge-lock-acquire` → `gh pr merge` → `merge-lock-release`; o hook
 *     automático cuida do carimbo depois.)
 *   npx tsx scripts/lib/session-registry.ts gc [--max-age-days N] [--dry-run]
 * (`--session-id X` funciona também se passado explicitamente — o hook só
 * injeta quando a flag está AUSENTE, nunca sobrescreve um valor já presente.)
 *
 * **#6130 — conflitos de sync do OneDrive e GC de registros encerrados.**
 * `data/sessions/` vive numa junction OneDrive compartilhada entre máquinas
 * e pode bifurcar um arquivo de sessão em cópias de conflito com sufixo
 * `-safeBackup-NNNN` (ex: `continuo-predator-{uuid}-predator-safeBackup-0001.json`)
 * — o `#5427` já fazia `listActiveSessions` IGNORAR essas cópias pra não
 * ressuscitar sessão já encerrada (arquivo real removido, só o backup
 * sobrou). O `#6130` fecha o lado oposto: quando o arquivo REAL de uma
 * sessão AINDA VIVA coexiste com backups divergentes (conflito ocorreu
 * enquanto `claimed_issues` estava sendo escrito), um claim podia
 * desaparecer do registro efetivo se só existisse no backup — permitindo
 * duas sessões na mesma issue. `listActiveSessions`/`isIssueClaimedByOther`
 * agora leem a UNIÃO de `claimed_issues` do arquivo real + todo backup cujo
 * nome começa com o stem do real (ver `mergeSessionRecords`) — fail-safe:
 * preferir "está reivindicada" a "não está". Backup ÓRFÃO (sem arquivo real
 * correspondente — sessão já encerrada) continua ignorado, comportamento
 * do #5427 preservado.
 *
 * `gc` (novo, #6130) remove registros de sessão ENCERRADA — mas NUNCA por
 * staleness de heartbeat sozinha: uma sessão pode estar viva e só ter
 * parado de bater heartbeat (achado ao vivo do #6130 — `stale: true` com
 * processo `claude` ainda rodando no `helios`). Ver docstring de
 * `planSessionGc` pra árvore de decisão completa (checagem de PID vivo na
 * MESMA máquina, janela conservadora bem maior que qualquer heartbeat
 * esperado quando não há sinal de processo verificável).
 */

import { basename, dirname, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { parseArgs, isMainModule } from "./cli-args.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { withFileLock } from "./file-lock.ts";

/**
 * #6168: `interactive` é o 4º kind — sessão comum do editor, registrada
 * AUTOMATICAMENTE pelo hook `.claude/hooks/session-beacon.mjs` (nenhuma skill
 * chama `register` pra ela). Fecha o buraco 3 da issue: até aqui só as 3
 * skills coordenadoras se registravam, e a maioria das sessões reais —
 * interativas — era invisível ao registro (incidente #5751: o `helios` tinha
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
  /** Branch atual do checkout desta sessão (#6168 Parte A). Lido de
   * `.git/HEAD` pelo beacon — sem subprocesso. É o campo que responde "a
   * branch ainda é minha?" antes de um `git commit` (evidência 5 da issue:
   * outra sessão fez `checkout master` no meio, o commit caiu em master, e
   * `commit`/`push` reportaram sucesso). */
  branch?: string;
  /** Worktrees abertos por esta sessão (#6168 Parte A). */
  worktrees?: WorktreeRef[];
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
   * ativo pro guard de merge do #5716. Nenhum outro escritor deste módulo
   * seta este campo — não confundir com a remoção normal via `endSession`
   * (que APAGA o arquivo, não carimba nada).
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
export type ActiveSessionRecord = SessionRecord & { stale: boolean; claimed_issues_effective: number[] };

interface MergeLockRecord {
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
  authorizedAt: string;
}

/**
 * Tolerância de clock skew entre máquinas (#5161 fleet review item 2).
 * `listActiveSessions` e `acquireMergeLock` comparam timestamps ESCRITOS por
 * uma máquina contra o relógio de QUEM LÊ — se os relógios não estão
 * perfeitamente sincronizados (NTP), um timestamp genuinamente recente pode
 * parecer "no futuro" pra quem lê. Um delta pequeno (≤60s) é tratado como
 * jitter normal, nunca como sinal de corrupção/abandono. Um delta MAIOR que
 * isso ainda é tratado com segurança (nunca finge que um registro que parece
 * "do futuro" está abandonado/roubável), mas gera um warning em stderr — ver
 * `warnClockSkew` — porque não é mais jitter, pode ser skew real entre
 * máquinas que vale a pena investigar.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Loga (stderr, nunca lança) um aviso de possível clock skew — usado sempre
 * que um timestamp "no futuro" (relativo ao relógio de quem lê) influencia
 * uma decisão de staleness/freshness em `listActiveSessions`/
 * `acquireMergeLock`. Nunca silencioso: um relógio adiantado numa máquina
 * pode fazer sessões/locks genuinamente ativos desaparecerem/serem roubados
 * sem aviso nenhum se isto não for logado (#5161 item 2).
 */
function warnClockSkew(context: string, identifier: string, deltaMs: number): void {
  try {
    process.stderr.write(
      `session-registry: aviso de possível clock skew em ${context} — "${identifier}" tem timestamp ` +
        `~${Math.round(-deltaMs / 1000)}s no "futuro" relativo ao relógio de quem lê (delta=${deltaMs}ms). ` +
        "Se as máquinas envolvidas não estão sincronizadas via NTP, isto pode estar mascarando/excluindo " +
        "uma sessão ou lock genuinamente ativo. Ver CLOCK_SKEW_TOLERANCE_MS em scripts/lib/session-registry.ts.\n",
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho fail-soft principal.
  }
}

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — "unknown" em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

export function sessionsDir(repoRoot: string): string {
  return join(repoRoot, "data", "sessions");
}

export function sessionFilePath(repoRoot: string, kind: SessionKind, tag: string, sessionId: string): string {
  return join(sessionsDir(repoRoot), `${kind}-${tag}-${sessionId}.json`);
}

export function mergeLockPath(repoRoot: string): string {
  return join(sessionsDir(repoRoot), ".merge-lock.json");
}

/**
 * Loga (stderr, nunca lança) uma falha de I/O real lendo `path` — distinta de
 * "arquivo ausente" (ENOENT, silencioso — caso comum e esperado) ou "JSON
 * malformado" (também silencioso — arquivo de outra sessão só parcialmente
 * escrito, não é um sinal de bug). `data/` é uma junction OneDrive: erros
 * como EBUSY/EPERM/EACCES são REALISTAMENTE transitórios (sync em andamento),
 * não "o arquivo nunca existiu" — tratar os dois casos como indistinguíveis
 * (#5161 fleet review item 3) enfraquece tanto `listActiveSessions` quanto
 * `acquireMergeLock`: um lock/sessão de OUTRA sessão que falhou por I/O
 * transitório vira "ausente" e é ignorado/roubado sem aviso nenhum.
 */
function warnIoError(path: string, error: unknown): void {
  try {
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? String(error);
    process.stderr.write(
      `session-registry: falha de I/O lendo "${path}" (${code}) — tratando como ausente por segurança (fail-soft), ` +
        "mas isto pode ser TRANSITÓRIO (ex: OneDrive sincronizando o arquivo agora), não uma ausência real. " +
        "Se isto se repetir para o mesmo path, investigar antes de confiar na leitura.\n",
    );
  } catch {
    // Nunca deixar um log de warning quebrar o caminho fail-soft.
  }
}

function readJsonSafe<T>(path: string): T | null {
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT aqui (arquivo removido entre o existsSync e o readFileSync,
    // corrida benigna) é equivalente a "ausente" — silencioso, igual antes.
    // Qualquer OUTRO código (EBUSY/EPERM/EACCES/etc) é uma falha de I/O real
    // que merece ficar visível, não se disfarçar de "nunca existiu".
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") warnIoError(path, e);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // JSON malformado — comportamento pré-existente preservado (silencioso):
    // não é uma falha de I/O, é conteúdo genuinamente inválido.
    return null;
  }
}

/**
 * #6130 item 4 (reduzir a janela de conflito de escrita): write-then-rename
 * atômico (`writeFileAtomic`, já usado por outros outputs do pipeline) em
 * vez de `writeFileSync` in-place — elimina a classe "leitura vê arquivo
 * PARCIALMENTE escrito" (kill/crash/sync do OneDrive no meio de um write).
 * **Não elimina** a classe "lost update" de duas sessões fazendo
 * leitura→merge→escrita concorrente sobre o MESMO registro (ex: duas
 * chamadas de `claimIssue` pra sessões DIFERENTES nunca colidem — cada uma
 * escreve seu PRÓPRIO arquivo — mas duas chamadas concorrentes pra a MESMA
 * sessão, do tipo que só aconteceria por bug de dispatch, ainda podem
 * perder uma escrita) — isso exigiria locking/CAS por registro, avaliado
 * como refactor grande demais pra esta unidade (ver corpo da issue #6130,
 * item sem checkbox). `mkdirSync` continua incondicional antes do write —
 * `writeFileAtomic` não cria o diretório pai.
 */
function writeJsonSafe(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(value), { fsync: false });
}

/**
 * #6952 — read-modify-write do record de sessão sob lock exclusivo, em vez de
 * solto.
 *
 * `writeJsonSafe` torna a ESCRITA atômica (write-then-rename, #6130), mas a
 * leitura que a precede é separada — entre `readJsonSafe` e o
 * `writeFileAtomic` outro processo pode gravar o seu próprio registro, e a
 * nossa escrita (com `...current`) apaga esse update. É o lost-update
 * clássico:
 *
 *   t0  nós lemos current            (sem merge_grant)
 *   t1  outro processo lê current, grava current + merge_grant
 *   t2  nós gravamos NOSSO current  (de t0, sem merge_grant)   <- grant perdido
 *
 * O #6952 mediu isso ao vivo: o `grant-merge` concedeu a janela, a
 * beneficiária confirmou `granted: true`, e antes do `gh pr merge` o beacon
 * do concedente (que estava ativo trabalhando) reescreveu o registro a partir
 * de um `current` sem o grant — e o grant sumiu.
 *
 * Esta função fecha a classe inteira (não só o `merge_grant`):
 * `claimed_issues` (claimIssue/unclaimIssue) e os campos do beacon
 * (`touched_paths`/`dirty_paths`/`lastHeartbeat`) correm o mesmo risco hoje,
 * porque todos os escritores do record fazem read-modify-write com spread.
 *
 * Mecanismo: `withFileLock` em `{path}.lock` (criação exclusiva `wx`, spin
 * com timeout — mesmo mecanismo de `scripts/lib/file-lock.ts`, #4125, usado
 * já por `publish-facebook.ts`/`publish-linkedin.ts`). O lock serializa a
 * seção read-modify-write inteira: enquanto um processo tem o lock, nenhum
 * outro pode estar no meio da mesma seção, então o `merge(current)` lê um
 * `current` que NINGUÉM mais vai alterar antes da nossa escrita. A escrita
 * atômica (`writeJsonSafe`) então publica o resultado completo.
 *
 * `merge` é uma FUNÇÃO (não um objeto fixo) pra que o patch seja REFEITO a
 * cada retry contra o `current` fresco — um `patch` congelado na primeira
 * leitura repetiria exatamente o bug (preservaria o `current` STALE).
 *
 * `verify` roda DEPOIS da escrita, sob o mesmo lock: confirma que o que está
 * no disco agora é de fato a NOSSA escrita. É defesa em profundidade contra o
 * caso que o `wx` não cobre — entre máquinas via OneDrive o lock é
 * **advisory** (#6182, mesma limitação do merge lock): cada máquina vê um
 * inode distinto no junction e pode criar o `.lock` simultaneamente. No
 * caminho feliz (mesma máquina, lock real) o `verify` é só uma leitura a mais
 * e sempre passa.
 *
 * **O alcance do `verify` entre MÁQUINAS é limitado, e a limitação precisa
 * ficar escrita (achado do review da PR #6969).** Ele é uma leitura-após-
 * escrita feita na MESMA máquina que acabou de escrever: observa o próprio
 * write, não o da outra máquina — o sync do OneDrive não é instantâneo, então
 * no instante do `verify` a escrita remota simplesmente ainda não chegou.
 *
 * A autocura ("os dois lados detectam e refazem") vale quando o sync produz
 * **cópia de conflito** (`-safeBackup-*`), que é o comportamento observado na
 * prática — havia 15 delas em `data/sessions/` no dia em que isto foi
 * escrito, e é por isso que a união do `mergeSessionRecords` (#6952, 2ª
 * metade) é o que de fato recupera o dado nesse cenário: o `verify` não
 * recupera, a UNIÃO recupera.
 *
 * Se em vez disso houver last-writer-wins silencioso (sem cópia de
 * conflito), nem o `verify` nem a união ajudam: a escrita local seguinte da
 * concedente pode sobrescrever um `consumedAt` gravado do outro lado,
 * ressuscitando concessão já usada. Esse caminho NÃO foi reproduzido —
 * exigiria duas máquinas sincronizando ao vivo — e está registrado aqui como
 * limitação conhecida, não como cenário descartado.
 *
 * **Fail-closed quando não converge:** se `attempts` se esgotar, a função
 * LANÇA (re-propaga a última falha) em vez de silenciosamente gravar o
 * registro antigo. Um lost update que não foi resolvido é pior que um erro
 * visível — sem isto o grant desaparece e o diagnosticador acha que o
 * coordenador nunca concedeu (exatamente o diagnóstico errado do #6952).
 * O outro escritor é o beacon (`.claude/hooks/session-beacon.mjs`), que roda
 * a cada chamada de ferramenta mas só ESCREVE quando há novidade ou quando
 * passaram `MIN_WRITE_INTERVAL_MS` (5s) desde o último heartbeat — e desde o
 * #6952 ele adquire ESTA MESMA lock file, então os dois lados se serializam
 * de verdade em vez de cada um trancar consigo mesmo. Como cada tentativa
 * espera o lock por até 10s (`withFileLock`), o teto de `attempts` não é uma
 * janela de tempo fixa: é quantas vezes aceitamos perder a corrida do
 * `verify` antes de desistir, e só o caminho advisory cross-máquina (#6182)
 * faz o `verify` falhar.
 *
 * `attempts` é o teto de retries (default 50). Cada retry é uma leitura +
 * uma escrita atômica + uma verificação — 3 syscalls a mais, barato.
 */
/**
 * #6952 (achado do review): idade a partir da qual um `.lock` de registro de
 * sessão é considerado ÓRFÃO e quebrado à força.
 *
 * O `wx` não tem dono nem TTL: se o processo que segurava o lock morre sem
 * rodar o `finally` (SIGKILL, OOM, a máquina suspendendo, o binário do Claude
 * Code quebrando no meio — que aconteceu 5× num único dia), o arquivo fica no
 * disco PARA SEMPRE. Sem quebra por idade, todo escritor seguinte — os três
 * programas — passa a gastar o timeout inteiro e falhar, indefinidamente: um
 * grant perdido de vez em quando viraria uma parada total do registro.
 *
 * 60s é folgado por construção: a seção crítica é um read-modify-write de um
 * JSON pequeno (millissegundos), e o teto de espera de UMA tentativa é 10s.
 * Um lock com mais de 60s não está sendo usado por ninguém vivo.
 */
export const STALE_LOCK_MS = 60_000;

/**
 * Remove um `.lock` órfão (mais velho que `STALE_LOCK_MS`). Devolve `true` se
 * removeu. Fail-soft em tudo: lock inexistente, `stat` falhando, corrida com
 * outro quebrador — nada disso lança, porque quebrar lock é melhor-esforço e
 * nunca deve ser o motivo de uma falha.
 */
export function breakStaleLock(lockPath: string, now: number = Date.now()): boolean {
  try {
    const ageMs = now - statSync(lockPath).mtimeMs;
    if (ageMs < STALE_LOCK_MS) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function writeJsonSafeWithCas(
  path: string,
  merge: (current: SessionRecord | null) => SessionRecord,
  verify: (onDisk: SessionRecord | null) => boolean,
  attempts: number = 50,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      // Antes de esperar mais 10s por um lock, checa se ele é de um processo
      // que morreu segurando-o. Sem isto, um lock órfão wedgeia o registro
      // para sempre (ver `STALE_LOCK_MS`).
      breakStaleLock(lockPath);
      withFileLock(lockPath, () => {
        const current = readJsonSafe<SessionRecord>(path);
        const value = merge(current);
        writeJsonSafe(path, value);
        const onDisk = readJsonSafe<SessionRecord>(path);
        if (!verify(onDisk)) {
          // Outra sessão escreveu entre a nossa leitura e a nossa escrita, e
          // a nossa escrita atômica a sobrescreveu — lost update (só pode
          // acontecer no caminho advisory cross-máquina). Relê e retry.
          throw new Error("CAS verify failed: another writer overwrote our write");
        }
      });
      return;
    } catch (e) {
      // `withFileLock` lançou: ou verify falhou (lost update, retry), ou o
      // lock timeout estourou (outro processo segura há 10s+ — raro, mas o
      // beacon roda a cada ~1s então é só esperar), ou falha de I/O no
      // read/write interno. Todas as três são retry-áveis.
      lastErr = e;
    }
  }
  throw new Error(
    `writeJsonSafeWithCas: ${attempts} tentativas de CAS falharam em ${path} ` +
      `— outro processo (beacon) continua escrevendo o registro; última falha: ${(lastErr as Error)?.message ?? String(lastErr)}`,
  );
}

/**
 * Localiza, em `data/sessions/`, o arquivo de registro REAL (nunca backup)
 * de QUALQUER kind para `sessionId` — espelha `findExistingSessionFile` do
 * beacon (`.claude/hooks/session-beacon.mjs`), que cobre a ordem "register
 * primeiro, beacon depois" (enriquece o arquivo já existente em vez de criar
 * um `interactive-*` paralelo).
 *
 * `registerSession` usa isto pra cobrir a ordem INVERSA (#6326): o beacon
 * dispara no `PreToolUse`, ANTES de a skill rodar `register` — cria
 * `interactive-{tag}-{sessionId}.json` sem saber que a sessão vai virar
 * coordenadora minutos depois. Sem esta busca, `registerSession` escreveria
 * cego no path do kind novo (`sessionFilePath`), sem olhar se já existe um
 * arquivo de OUTRO kind pro mesmo `sessionId` — e sobrariam dois registros
 * pra uma sessão só, contando dobrado em `list-active` (achado ao vivo do
 * #6326: `overnight-helios-{uuid}.json` + `interactive-helios-{uuid}.json`
 * simultâneos, o 2º congelado a partir do momento em que o beacon passa a
 * enriquecer só o 1º).
 *
 * Match por SUFIXO `-{sessionId}.json`, nunca por tag/kind explícitos —
 * mesmo critério do irmão (cobre o caso raro de a sessão trocar de
 * `machineTag()` entre o beacon e o `register`, ex: hostname mudou no meio).
 * Ordena alfabeticamente e devolve o primeiro quando há mais de um
 * candidato (não deveria acontecer em operação normal — é exatamente o bug
 * que esta função corrige — mas nunca lança). **#6326 fleet review P3
 * (decisão registrada, não corrigida neste PR):** casa só por SUFIXO de
 * nome de arquivo, sem validar que o prefixo antes do sufixo é de fato um
 * `SessionKind` conhecido (`parseSessionFileName(): {kind,tag,sessionId} |
 * null` fecharia isso). Risco prático baixo — o `kind` usado no restante da
 * função sempre vem do parâmetro TIPADO, nunca é lido de volta do nome do
 * arquivo — e esta é a mesma ausência de validação de shape que já existia
 * em `listSessionJsonFiles`/`readMergedSessionGroups` antes deste PR, não
 * uma regressão introduzida aqui. **Fechado em #6338** — ver
 * `parseSessionFileName` abaixo, agora usada como filtro aqui.
 */
function findExistingSessionFileAnyKind(repoRoot: string, sessionId: string): string | null {
  const suffix = `-${sessionId}.json`;
  const names = listSessionJsonFiles(repoRoot)
    .filter((n) => n.endsWith(suffix) && !n.includes("-safeBackup-") && parseSessionFileName(n) !== null)
    .sort();
  return names.length > 0 ? join(sessionsDir(repoRoot), names[0]!) : null;
}

/**
 * Parseia um nome de arquivo de registro de sessão (`{kind}-{tag}-{sessionId}.json`)
 * validando que o PREFIXO é um `SessionKind` conhecido (#6338) — fecha a
 * lacuna documentada em `findExistingSessionFileAnyKind` acima, onde o
 * casamento por sufixo `-{sessionId}.json` nunca checava o que vinha antes.
 *
 * **Ambiguidade estrutural, documentada, não escondida:** tanto `tag`
 * (`machineTag()` — alfanumérico/`_`/`-`, hostname pode ter hífen) quanto
 * `sessionId` (tipicamente um UUID, também com hífens) podem conter `-`, então
 * o corte entre os dois a partir só da string é inerentemente ambíguo — não
 * há como este parser "adivinhar" onde a tag termina e o sessionId começa
 * quando ambos usam o mesmo separador do nome de arquivo. Por isso o campo
 * `tag`/`sessionId` retornados usam o corte ingênuo "primeiro `-` depois do
 * kind" e só devem ser tratados como confiáveis quando o chamador não precisa
 * distinguir os dois com certeza (o caso concreto que motivou a issue — só
 * validar que o `kind` é conhecido). Quem precisa casar um `sessionId`
 * ESPECÍFICO (como `findExistingSessionFileAnyKind`) deve continuar casando
 * pelo sufixo `-{sessionId}.json` conhecido, e usar este parser só pra validar
 * o prefixo — nunca para redescobrir o sessionId a partir do nome.
 *
 * `null` quando: não termina em `.json`, ou o prefixo não bate com nenhum dos
 * `ALL_SESSION_KINDS`, ou não sobra `tag-sessionId` suficiente depois do kind.
 *
 * **#6934 — casamento por prefixo MAIS LONGO, não pela ordem de declaração
 * de `ALL_SESSION_KINDS`.** Desde que `continuo-review` existe, `continuo` é
 * um prefixo verdadeiro dele (`"continuo-review-tag-id".startsWith("continuo-")`
 * também é `true`) — um `.find()` ingênuo na ordem do array casaria sempre
 * `continuo` primeiro e devolveria `tag: "review", sessionId: "tag-id"`,
 * errado em silêncio. Mesma técnica de desempate já usada por
 * `groupBackupsByRealStem` acima (mais longo = mais específico = vence):
 * ordena os candidatos por comprimento decrescente antes do `.find()`, então
 * o resultado nunca depende de qual kind foi declarado antes do outro.
 */
export function parseSessionFileName(
  name: string,
): { kind: SessionKind; tag: string; sessionId: string } | null {
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -".json".length);
  const kindsByLengthDesc = [...ALL_SESSION_KINDS].sort((a, b) => b.length - a.length);
  const kind = kindsByLengthDesc.find((k) => stem.startsWith(`${k}-`));
  if (!kind) return null;
  const rest = stem.slice(kind.length + 1);
  const sepIndex = rest.indexOf("-");
  if (sepIndex <= 0 || sepIndex >= rest.length - 1) return null; // sem tag/sessionId não-vazios dos dois lados
  return { kind, tag: rest.slice(0, sepIndex), sessionId: rest.slice(sepIndex + 1) };
}

/**
 * Agrupa cópias de conflito `-safeBackup-` de `names` (listagem CRUA de
 * `data/sessions/`, real+backup) por STEM do arquivo real "dono" mais
 * ESPECÍFICO — extraído de `readMergedSessionGroups` (#6130) e reusado por
 * `readMergedRecordForRealFile` (#6326 fleet review item 5a — a versão
 * anterior desta 2ª função tinha sua PRÓPRIA regra, mais fraca, que só
 * olhava pro stem-alvo isoladamente, sem competir contra outros stems reais
 * do diretório).
 *
 * Desempate: quando mais de um stem real é prefixo válido do mesmo nome de
 * backup (ex: stems `interactive-tag-X` e `interactive-tag-X-2` concorrendo
 * pelo backup `interactive-tag-X-2-tag-safeBackup-0001.json`), o STEM MAIS
 * LONGO (mais específico) vence — nunca o mais curto, que atribuiria o
 * backup à sessão ERRADA. Backup sem nenhum stem real correspondente
 * (órfão) não aparece no mapa devolvido.
 */
function groupBackupsByRealStem(names: readonly string[]): Map<string, string[]> {
  const realStems = names
    .filter((n) => !n.includes("-safeBackup-"))
    .map((n) => n.slice(0, -".json".length))
    .sort((a, b) => b.length - a.length);
  const backupsByRealStem = new Map<string, string[]>();
  for (const backup of names) {
    if (!backup.includes("-safeBackup-")) continue;
    const matchStem = realStems.find((stem) => backup.startsWith(`${stem}-`));
    if (!matchStem) continue; // órfão
    const list = backupsByRealStem.get(matchStem) ?? [];
    list.push(backup);
    backupsByRealStem.set(matchStem, list);
  }
  return backupsByRealStem;
}

/**
 * Lê o registro efetivo de um arquivo REAL de sessão já conhecido, mesclado
 * com seus próprios `-safeBackup-` do OneDrive (`mergeSessionRecords`) — usado
 * pela promoção de kind em `registerSession` (#6326) pra garantir que um
 * claim que só sobreviveu num backup do registro ANTIGO não se perca na
 * promoção. Reusa `groupBackupsByRealStem` (mesma disciplina fail-safe de
 * `readMergedSessionGroups`, com o mesmo desempate "stem mais específico
 * vence" — não uma versão mais fraca). `null` quando nem o arquivo real nem
 * nenhum backup dele foi legível.
 */
function readMergedRecordForRealFile(repoRoot: string, realPath: string): SessionRecord | null {
  const dir = sessionsDir(repoRoot);
  const realName = basename(realPath);
  const stem = realName.slice(0, -".json".length);
  const backupNames = groupBackupsByRealStem(listSessionJsonFiles(repoRoot)).get(stem) ?? [];
  const records = [realName, ...backupNames]
    .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
    .filter((r): r is SessionRecord => r !== null);
  if (records.length === 0) return null;
  return mergeSessionRecords(records);
}

/**
 * Paths absolutos dos `-safeBackup-*` do MESMO grupo de um arquivo real de
 * sessão — mesma composição de `groupBackupsByRealStem` que
 * `readMergedRecordForRealFile` usa para o READ-path. Usada por
 * `unclaimIssue` (#6567) para propagar a remoção de uma issue a TODAS as
 * cópias do grupo, não só ao arquivo real: sem isto, `writeJsonSafe` no real
 * deixa `-safeBackup-*` órfãos ainda carregando a issue em `claimed_issues`,
 * e como o read-path (`readMergedSessionGroups`/`mergeSessionRecords`) faz
 * união real+backups por design fail-safe, a issue continua aparecendo como
 * reivindicada para `is-claimed`/`list-active` mesmo depois do
 * `unclaim-issue` reportar sucesso. Lista vazia quando não há backup do
 * grupo (caso comum) — nenhuma mudança de comportamento no caminho feliz.
 */
function sessionGroupBackupPaths(repoRoot: string, realPath: string): string[] {
  const dir = sessionsDir(repoRoot);
  const realName = basename(realPath);
  const stem = realName.slice(0, -".json".length);
  const backupNames = groupBackupsByRealStem(listSessionJsonFiles(repoRoot)).get(stem) ?? [];
  return backupNames.map((n) => join(dir, n));
}

/**
 * Um grupo de cópias de conflito do OneDrive (`-safeBackup-*`) que NÃO tem
 * arquivo real correspondente em `data/sessions/` (#7002/#7003).
 *
 * A identidade vem do CONTEÚDO (`kind`/`machineTag`/`sessionId`), nunca do
 * nome do arquivo: o nome do backup é `{stem-real}-{tag}-safeBackup-NNNN.json`
 * e o `-{tag}` que o cliente OneDrive intercala não é garantia de formato —
 * o conteúdo é, e é ele que reconstrói o path do arquivo real
 * (`sessionFilePath`, que é literalmente `{kind}-{tag}-{sessionId}.json`).
 */
interface OrphanBackupGroup {
  /** Stem do arquivo REAL que este grupo representa (o que sumiu do disco). */
  stem: string;
  kind: SessionKind;
  machineTag: string;
  sessionId: string;
  /** Paths absolutos das cópias que compõem o grupo. */
  files: string[];
  /** União (`mergeSessionRecords`) de todas as cópias legíveis do grupo. */
  record: SessionRecord;
  /** `true` se QUALQUER cópia carrega `endedAt` — ver `isOrphanBackupGroupLive`. */
  anyEnded: boolean;
}

/**
 * Nomes das cópias `-safeBackup-` de `names` que estão ÓRFÃS: nenhum arquivo
 * REAL existente é prefixo delas (#7002). Complemento exato de
 * `groupBackupsByRealStem` — deriva do mesmo mapa em vez de reimplementar a
 * regra de desempate ("stem mais longo vence"), pra as duas leituras nunca
 * discordarem sobre a que grupo um backup pertence.
 */
function orphanBackupNames(names: readonly string[]): string[] {
  const owned = new Set<string>();
  for (const list of groupBackupsByRealStem(names).values()) {
    for (const name of list) owned.add(name);
  }
  return names.filter((n) => n.includes("-safeBackup-") && !owned.has(n));
}

/**
 * Agrupa as cópias ÓRFÃS de `data/sessions/` por identidade de sessão
 * (`kind`/`machineTag`/`sessionId` lidos do conteúdo) e devolve a união de
 * cada grupo (#7002).
 *
 * Existe porque "backup órfão" tem DUAS causas indistinguíveis pela forma em
 * disco, e o read-path tratava as duas como a mesma:
 *   1. sessão encerrada limpo — `endSession` removeu o arquivo real de
 *      propósito e a cópia de conflito sobrou (o caso do #5427);
 *   2. **o arquivo real sumiu por lost-update enquanto a sessão seguia VIVA**
 *      — medido ao vivo no #7002 (a coordenadora perdeu o próprio arquivo com
 *      10 claims e um `merge_grant` íntegros nos backups, e passou a aparecer
 *      pras outras sessões com `claimed_issues: []`).
 *
 * Grupo ilegível/sem identidade não entra (mesma disciplina de
 * `readMergedSessionGroups`: nunca inventar sessão a partir de conteúdo que
 * não se conseguiu interpretar). `kind` fora de `ALL_SESSION_KINDS` também
 * não entra — um registro que este módulo não classifica nunca vira sessão
 * ativa por promoção.
 */
function readOrphanBackupGroups(repoRoot: string): OrphanBackupGroup[] {
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const byIdentity = new Map<string, { files: string[]; records: SessionRecord[] }>();
  for (const name of orphanBackupNames(names)) {
    const record = readJsonSafe<SessionRecord>(join(dir, name));
    if (!record || !record.sessionId || !record.kind || !record.machineTag) continue;
    if (!(ALL_SESSION_KINDS as readonly string[]).includes(record.kind)) continue;
    const stem = `${record.kind}-${record.machineTag}-${record.sessionId}`;
    const entry = byIdentity.get(stem) ?? { files: [], records: [] };
    entry.files.push(join(dir, name));
    entry.records.push(record);
    byIdentity.set(stem, entry);
  }

  const out: OrphanBackupGroup[] = [];
  for (const [stem, entry] of byIdentity) {
    const first = entry.records[0]!;
    // #7462: grupo órfão = SÓ `-safeBackup-*`, sem arquivo real. Passa
    // `realIndex = -1` pro `mergeSessionRecords` para que o `consumedAt` NUNCA
    // propague de um backup: sem real a testemunhar, o grant é considerado
    // vivo (mesma decisão do #6972 pro `merge_grant` inteiro). Antes, o
    // default 0 fazia o primeiro backup da lista atuar como se fosse o real.
    out.push({
      stem,
      kind: first.kind,
      machineTag: first.machineTag,
      sessionId: first.sessionId,
      files: entry.files,
      record: mergeSessionRecords(entry.records, -1),
      anyEnded: entry.records.some((r) => Boolean(r.endedAt)),
    });
  }
  return out;
}

/**
 * `true` quando um grupo órfão ainda representa uma sessão VIVA (#7002) — o
 * único caso em que ele volta a contar como sessão ativa no read-path.
 *
 * Duas condições, as duas necessárias:
 *   1. **Nenhuma** cópia do grupo carrega `endedAt`. `endSession` carimba esse
 *      campo em todas as cópias do grupo ANTES de remover o arquivo real
 *      (#7002), então um encerramento limpo fica marcado no próprio conteúdo
 *      — é o que separa a causa (1) da causa (2) descritas em
 *      `readOrphanBackupGroups` sem depender de heurística de tempo.
 *   2. O heartbeat mais recente do grupo está DENTRO da janela de liveness do
 *      kind (`softStaleMsForKind` — 90min pra coordenadora, 15min pra
 *      `interactive`). É exatamente o mesmo critério que `decideSessionGc` já
 *      usa pra NUNCA remover um backup órfão recente ("heartbeat recente …
 *      sessão claramente ativa"): o GC já tratava esse grupo como vivo
 *      enquanto o read-path o descartava, e é essa assimetria que o #7002
 *      mediu como falso-negativo de claim.
 *
 * Heartbeat no futuro além da tolerância de skew nunca conta como vivo —
 * mesma disciplina de `listActiveSessions`/`isMergeGrantLive`.
 */
function isOrphanBackupGroupLive(group: OrphanBackupGroup, now: number): boolean {
  if (group.anyEnded) return false;
  const record = group.record;
  const heartbeatMs = Date.parse(record.lastHeartbeat ?? record.startedAt ?? "");
  if (!Number.isFinite(heartbeatMs)) return false;
  const ageMs = now - heartbeatMs;
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= softStaleMsForKind(record.kind);
}

/**
 * Loga (stderr, nunca lança) que uma escrita no registro (`claim-issue`,
 * `grant-merge`) encontrou o PRÓPRIO arquivo-âncora ausente e o reconstruiu a
 * partir das cópias de conflito órfãs (#7003).
 *
 * O ponto da issue: o auto-registro do #6369 é razoável pra "sessão nunca
 * registrada", mas quando a âncora some NO MEIO de uma sessão viva ele
 * converte perda de ARQUIVO em perda SILENCIOSA de ESTADO — recria o registro
 * zerado e segue. Reproduzido ao vivo: 10 `claim-issue` sequenciais deixaram a
 * âncora com 3 claims. Aqui a recuperação é ruidosa de propósito: quem lê o
 * stderr (systemd/Task Scheduler/terminal) vê que houve competição de escrita,
 * não um registro novo nascendo.
 */
function warnAnchorRecoveredFromOrphanBackups(
  verb: string,
  sessionId: string,
  anchorPath: string,
  group: OrphanBackupGroup,
): void {
  try {
    process.stderr.write(
      `session-registry: ATENÇÃO — ${verb}: o arquivo-âncora da sessão sessionId="${sessionId}" ` +
        `("${anchorPath}") NÃO existe, mas ${group.files.length} cópia(s) de conflito do OneDrive dela sobrevivem ` +
        `com heartbeat recente. Isto NÃO é uma sessão nova: é a âncora sumindo sob escrita concorrente (#7002/#7003). ` +
        `O registro foi RECONSTRUÍDO a partir das cópias (claims recuperadas: ` +
        `${(group.record.claimed_issues ?? []).length}), nunca recriado zerado.\n`,
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho principal.
  }
}

/**
 * Reconstrói o arquivo-âncora de uma sessão a partir das cópias de conflito
 * ÓRFÃS dela (#7003), quando (e só quando) o arquivo real sumiu e o grupo
 * órfão ainda parece vivo. Devolve o grupo usado, ou `null` quando não há o
 * que recuperar (o caso comum: sessão genuinamente nova).
 *
 * **Por que reconstruir em vez de abortar.** A issue pede que um claim que
 * encontra o próprio record ausente seja RUIDOSO, não silencioso. Abortar o
 * claim seria ruidoso e deixaria a sessão viva SEM claim nenhuma — o
 * falso-negativo que a própria #7003 chama de "pior que falso-positivo".
 * Reconstruir + avisar alto preserva o estado (que é o dano real medido) e
 * mantém o sinal visível pra quem investiga.
 *
 * A escrita é um CAS (`writeJsonSafeWithCas`) como todas as outras deste
 * módulo, e a base é a UNIÃO do que estiver em disco no momento do lock com o
 * grupo órfão — nunca um `...record` congelado: se outro escritor recriou a
 * âncora enquanto esperávamos o lock, o conteúdo dele entra na união em vez de
 * ser sobrescrito.
 */
function recoverAnchorFromOrphanBackups(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  tag: string,
  now: string,
  nowMs: number = Date.parse(now),
): OrphanBackupGroup | null {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (existsSync(path)) return null;
  const stem = `${kind}-${tag}-${sessionId}`;
  const group = readOrphanBackupGroups(repoRoot).find((g) => g.stem === stem);
  if (!group) return null;
  if (!isOrphanBackupGroupLive(group, Number.isFinite(nowMs) ? nowMs : Date.now())) return null;

  writeJsonSafeWithCas(
    path,
    (current) => {
      // #7462: `group.record` é a união de um grupo ÓRFÃO (só backups, sem
      // arquivo real) — o seu `consumedAt` nunca é testemunha. Quando
      // `current` existe, ele é o arquivo REAL (outro escritor recriou a
      // âncora enquanto esperávamos o lock), então o real é a posição 1; quando
      // não existe, o grupo é só backups e não há real a consultar. O default
      // `realIndex=0` trataria o órfão como se fosse o real e podia propagar
      // um `consumedAt` que o real nunca teve — mesma classe de bug que a
      // issue #7462 relata.
      const merged = mergeSessionRecords(current ? [group.record, current] : [group.record], current ? 1 : -1);
      const record: SessionRecord = {
        ...merged,
        kind,
        machineTag: tag,
        sessionId,
        startedAt: merged.startedAt ?? now,
        lastHeartbeat: now,
      };
      // `stale` é campo COMPUTADO (nunca persistido) e `endedAt` nunca chega
      // aqui (grupo com `endedAt` não é "vivo"), mas remover explicitamente
      // impede que um deles vaze pro disco caso a origem já viesse sujo.
      delete record.stale;
      delete record.endedAt;
      // **`merge_grant` NÃO é recuperado — assimetria deliberada (#6972).**
      // Claim se recupera porque a direção segura é "preferir reivindicada";
      // concessão de merge NÃO, porque a direção segura é a oposta. Promover
      // pro arquivo real um grant que só existia em cópia de conflito faria o
      // gate do #5716 passar a honrá-lo — exatamente o que o review da PR
      // #6969 recusou ("grant é autorização, e autorização não se infere de
      // detrito"), só que pela porta dos fundos de um `claim-issue`. O
      // caminho correto continua sendo o que `check-merge-grant` manda fazer:
      // pedir RECONCESSÃO à coordenadora, que aí escreve o grant no arquivo
      // real deliberadamente (e `grantMergeWindow`, logo depois de recuperar
      // a âncora, faz precisamente isso).
      delete record.merge_grant;
      // Exceção estreita: se outro escritor recriou a âncora enquanto
      // esperávamos o lock e ELE gravou um grant no arquivo REAL, esse grant
      // é deliberado — preservá-lo é o oposto de promover detrito.
      if (current?.merge_grant) record.merge_grant = current.merge_grant;
      return record;
    },
    (onDisk) => onDisk?.lastHeartbeat === now && onDisk?.sessionId === sessionId,
  );
  return group;
}

/**
 * Loga (stderr, nunca lança) um aviso de que `registerSession` encontrou um
 * registro de OUTRO kind pra `sessionId` mas não conseguiu ler nem o arquivo
 * real nem nenhum backup dele (#6326 fleet review item 1) — cenário
 * documentado como NORMAL no OneDrive (sync no meio de um write), e mais
 * provável justamente quando o beacon escreve durante o sync. Complementa
 * (não substitui) o `outcome: "promotion-failed-unreadable"` do retorno de
 * `registerSession` — este aviso é o que fica visível a quem lê stderr
 * direto (ex: log de systemd/Task Scheduler), o `outcome` é o que fica
 * visível ao CÓDIGO que chama `registerSession` programaticamente.
 */
function warnUnreadablePromotionSource(sessionId: string, otherPath: string): void {
  try {
    process.stderr.write(
      `session-registry: aviso — encontrado um registro de OUTRO kind pra sessionId="${sessionId}" em ` +
        `"${otherPath}", mas nem o arquivo real nem nenhum backup dele foi legível (JSON corrompido/ ` +
        "parcialmente sincronizado pelo OneDrive) — a promoção NÃO pôde ler o conteúdo antigo. Um registro NOVO " +
        `foi criado do zero; "${otherPath}" continua em disco (outcome: "promotion-failed-unreadable").\n`,
    );
  } catch {
    // Nunca deixar um log de warning derrubar o caminho fail-soft principal.
  }
}

/**
 * Desfecho de `registerSession` (#6326 fleet review item — antes desta
 * mudança, o retorno era `SessionRecord` puro e o CLI (`main()`, case
 * `register`) imprimia a MESMA mensagem nos 4 caminhos genuinamente
 * distintos que a função pode tomar — inclusive `"promoted-orphan-left"`,
 * que é literalmente o bug que a #6326 existe pra consertar voltando em
 * silêncio caso o `rmSync` do arquivo antigo falhe). Mesmo padrão de
 * `ClaimIssueReason`/`claimIssueCheckAndSet` — união discriminada em vez de
 * um booleano ou só prosa no comentário.
 *
 * - `"created"` — nenhum registro existia (nem no path do kind atual, nem
 *   sob outro kind) pra este `sessionId`; registro novo do zero.
 * - `"reregistered"` — já havia registro no path do KIND ATUAL; caminho
 *   idempotente de sempre (#6294/#6303), sem promoção envolvida.
 * - `"promoted"` — encontrou e leu um registro de OUTRO kind, promoveu com
 *   sucesso (novo path gravado, antigo removido). O caso feliz do #6326.
 * - `"promoted-orphan-left"` — encontrou e leu um registro de OUTRO kind, o
 *   novo path foi gravado, mas a remoção do antigo FALHOU (I/O transitório
 *   do OneDrive, ou o arquivo persistiu depois do `rmSync` "bem-sucedido").
 *   O órfão fica em disco — `planSessionGc` recolhe depois, mas só quando
 *   ficar legível/o `pid` gravado nele não estiver mais vivo (ver ressalva
 *   no docblock de `registerSession`).
 * - `"promotion-failed-unreadable"` — encontrou um arquivo de OUTRO kind
 *   pelo NOME, mas nem ele nem nenhum backup dele foi legível — a promoção
 *   não pôde acontecer. Registro novo criado do zero mesmo assim (decisão:
 *   deixar a sessão sem registro nenhum seria pior — ver docblock de
 *   `warnUnreadablePromotionSource`). O arquivo ilegível antigo fica em
 *   disco, órfão.
 */
export type RegisterSessionOutcome =
  | "created"
  | "reregistered"
  | "promoted"
  | "promoted-orphan-left"
  | "promotion-failed-unreadable";

export interface RegisterSessionResult {
  record: SessionRecord;
  outcome: RegisterSessionOutcome;
  /** Path do arquivo de OUTRO kind encontrado pra este `sessionId` — presente
   * em `"promoted"`, `"promoted-orphan-left"` e `"promotion-failed-unreadable"`,
   * ausente em `"created"`/`"reregistered"`. */
  promotedFrom?: string;
}

/**
 * Primitiva de I/O usada só pela remoção do arquivo ANTIGO na promoção de
 * kind de `registerSession` (#6326 fleet review — teste obrigatório
 * "rmSync falhando"). Injetável pra teste, mesmo padrão de `MergeLockIo`
 * (usado por `acquireMergeLock` mais abaixo neste módulo) — sem isto não dá
 * pra simular uma falha de remoção de forma determinística e PORTÁVEL:
 * monkey-patchar `require("node:fs").rmSync` não intercepta o
 * `import { rmSync } from "node:fs"` que este módulo usa de verdade (são
 * bindings distintos — confirmado experimentalmente), e forçar uma falha
 * REAL de sistema operacional (lock de arquivo aberto, permissão) é frágil
 * entre plataformas — mesma classe de problema que já deixa o teste de
 * `checkSessionsScanHealth` via `chmod` quebrado no Windows (ver nota no
 * teste correspondente). O default (`REAL_PROMOTION_REMOVE_IO`) usa
 * `node:fs` de verdade; testes injetam um `remove` que lança.
 */
export interface PromotionRemoveIo {
  exists: (path: string) => boolean;
  remove: (path: string) => void;
}

const REAL_PROMOTION_REMOVE_IO: PromotionRemoveIo = {
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path),
};

/**
 * Registra uma sessão ativa. Idempotente — chamar de novo com o mesmo
 * kind/tag/sessionId atualiza o registro (mesmo padrão de `startSession` em
 * `overnight-session-marker.ts`).
 *
 * **#6294 — re-registrar NÃO apaga mais `claimed_issues`.** Até aqui esta
 * função montava o record do zero com `claimed_issues: []`, então não existia
 * caminho suportado pra corrigir um campo (`pid`, tipicamente) sem destruir as
 * claims em voo: uma sessão com 12 issues reivindicadas que rodasse `register`
 * de novo — que é literalmente o que `BLOCK_REASON` do #5716 sugere a quem se
 * vê bloqueado por engano — perdia as 12 em silêncio, liberando-as pra outras
 * sessões no meio do trabalho. Agora o re-registro PRESERVA `claimed_issues`,
 * `startedAt` e os campos de beacon do registro anterior, e só sobrescreve o
 * que foi passado explicitamente. Registro novo (nenhum arquivo anterior)
 * continua nascendo com `claimed_issues: []`, comportamento inalterado.
 *
 * **#6326 — PROMOVE um registro pré-existente de OUTRO kind pro kind novo,
 * quando consegue ler o conteúdo antigo.** Se não há arquivo no path do kind
 * sendo registrado, mas existe um registro REAL pra este `sessionId` sob
 * outro kind (tipicamente `interactive`, criado pelo beacon antes desta
 * chamada — ver `findExistingSessionFileAnyKind`), a sessão de fato VIROU
 * `kind` ao rodar `register`: o registro passa a viver no path do kind novo
 * (preservando `startedAt`/`claimed_issues`/campos de beacon já acumulados,
 * inclusive os que só existiam num `-safeBackup-` do registro antigo).
 *
 * **Garantia real (#6326 fleet review item 2 — a versão anterior deste
 * parágrafo prometia "nunca sobra um par", que o código não cumpria):** no
 * caminho feliz (arquivo antigo legível E remoção bem-sucedida — `outcome:
 * "promoted"`), de fato nunca sobra um par `{kind-antigo}-{tag}-{sessionId}.json`
 * + `{kind-novo}-{tag}-{sessionId}.json` simultâneo. Mas a remoção é
 * BEST-EFFORT (`rmSync` num `try/catch` — falha de I/O transitória do
 * OneDrive nunca lança) e a leitura do conteúdo antigo pode falhar (JSON
 * corrompido/parcialmente sincronizado) — os dois desfechos de falha
 * (`"promoted-orphan-left"`, `"promotion-failed-unreadable"`, ver
 * `RegisterSessionOutcome`) DEIXAM um arquivo órfão do kind antigo em disco,
 * com heartbeat congelado a partir de agora. Esse órfão é recolhido depois
 * por `planSessionGc`, mas só quando (a) ficar legível — GC nunca remove
 * estado que não consegue interpretar — E (b) o `pid` gravado nele (herdado
 * do registro antigo — ver #6326 fleet review item 5b) não estiver mais
 * vivo na máquina local, OU a checagem rodar de outra máquina, onde a janela
 * conservadora de 2h (`GC_INTERACTIVE_MAX_AGE_MS`) decide.
 *
 * Promover (e não só ignorar) importa porque é o que
 * `isCoordinatorKind`/`COORDINATOR_SESSION_KINDS` leem (guard do #5716) — o
 * kind precisa refletir que a sessão é coordenadora agora. O desfecho de
 * CADA chamada é observável via `RegisterSessionResult.outcome` — ver ali
 * pros 5 caminhos possíveis.
 */
export function registerSession(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  meta: { pid?: number; tag?: string; startedAt?: string } = {},
  removeIo: PromotionRemoveIo = REAL_PROMOTION_REMOVE_IO,
): RegisterSessionResult {
  const tag = meta.tag ?? machineTag();
  const now = meta.startedAt ?? new Date().toISOString();
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  let previous = readJsonSafe<SessionRecord>(path);
  const hadOwnFile = previous !== null;

  // #6326: sem registro no path do KIND ATUAL, procurar (e promover) um
  // registro pré-existente da MESMA sessão sob OUTRO kind — ver docstring
  // acima. `otherPath !== path` evita o caso degenerado de um arquivo
  // corrompido no PRÓPRIO path (readJsonSafe já devolveu null pra ele
  // acima) ser "promovido" pra si mesmo e depois removido por engano.
  let promotedFrom: string | null = null;
  let unreadablePromotionSource: string | null = null;
  if (!previous) {
    const otherPath = findExistingSessionFileAnyKind(repoRoot, sessionId);
    if (otherPath && otherPath !== path) {
      const merged = readMergedRecordForRealFile(repoRoot, otherPath);
      if (merged) {
        previous = merged;
        promotedFrom = otherPath;
      } else {
        // #6326 fleet review item 1: `otherPath` EXISTE (achado pelo NOME em
        // `findExistingSessionFileAnyKind`), mas nem ele nem nenhum backup
        // foi legível. Decisão (a), não (b): AVISAR alto e seguir criando o
        // registro novo do zero, em vez de recusar e deixar a sessão SEM
        // registro nenhum — (b) trocaria um bug de contagem dupla/órfão
        // (recuperável: o arquivo antigo pode ficar legível numa chamada
        // futura, ou o GC eventualmente o recolhe) por um buraco de
        // visibilidade TOTAL, estritamente pior pros consumidores que
        // dependem de `listActiveSessions` (claim de issue, merge lock,
        // exclusão overnight×contínuo).
        unreadablePromotionSource = otherPath;
        warnUnreadablePromotionSource(sessionId, otherPath);
      }
    }
  }

  // #6952: CAS em vez de read-modify-write solto. O beacon reescreve este
  // arquivo a cada chamada de ferramenta — um `...previous` congelado no
  // momento acima apagaria um `merge_grant`/`claimed_issues` que o beacon
  // gravou entre o read inicial e o write (lost update). Dentro do lock,
  // re-deriva `record` do estado FRESCO em disco (`current`), caindo pro
  // `previous` promovido só quando `current` é nulo (arquivo não existe na
  // janela de lock — caso de promoção).
  let record: SessionRecord = {} as SessionRecord;
  writeJsonSafeWithCas(
    path,
    (current) => {
      const base: Partial<SessionRecord> = current ?? previous ?? {};
      record = {
        ...base,
        kind,
        machineTag: tag,
        sessionId,
        // `startedAt` do registro ORIGINAL é preservado — re-registrar (ou
        // promover de outro kind) não rejuvenesce a sessão (senão um
        // `register` de correção zeraria a idade que
        // `planSessionGc`/`listActiveSessions` usam pra decidir staleness).
        startedAt: base.startedAt ?? now,
        lastHeartbeat: now,
        claimed_issues: base.claimed_issues ?? [],
      };
      if (meta.pid !== undefined) {
        record.pid = meta.pid;
      }
      // #6326 fleet review item 5b (decisão registrada, não "corrigida" — ambas
      // as opções são defensáveis, esta é a escolhida): quando a promoção
      // sucede e `--pid` NÃO foi passado a ESTA chamada, o `pid` do registro
      // ANTIGO (herdado via `...base` acima, tipicamente `process.ppid`
      // gravado pelo beacon — ver #6160) é PRESERVADO, não limpo.
      // Justificativa: é o pid da MESMA sessão Claude Code (beacon e skill
      // compartilham `process.ppid`/o processo pai), então continua correto —
      // e é exatamente o sinal que o branch 3 de `decideSessionGc` usa pra
      // nunca remover um registro de sessão viva (ver docblock acima). Limpar
      // aqui destruiria esse sinal de liveness sem necessidade.
      return record;
    },
    (onDisk) =>
      onDisk?.sessionId === sessionId &&
      onDisk?.kind === kind &&
      onDisk?.machineTag === tag &&
      onDisk?.lastHeartbeat === now,
  );

  if (unreadablePromotionSource) {
    return { record, outcome: "promotion-failed-unreadable", promotedFrom: unreadablePromotionSource };
  }

  if (promotedFrom) {
    // #7028: carimba `endedAt` no CONTEÚDO do registro antigo ANTES de
    // tentar removê-lo — belt-and-suspenders pro caso (best-effort, como o
    // `rmSync` abaixo) de a remoção falhar e o arquivo permanecer em disco.
    // Sem isto, um órfão `promoted-orphan-left` ficava indistinguível de uma
    // sessão genuinamente viva pros leitores (`dedupeBySessionId`,
    // `listActiveSessions`) até `SOFT_STALE_MS` (90min) expirar — achado ao
    // vivo #7028: uma sessão `overnight` promovida de volta pra `interactive`
    // (o `sessionId` sobrevive à mudança, o harness preserva a conversa)
    // deixou o registro `overnight` antigo congelado no heartbeat da
    // promoção, e ele continuou contando como COORDENADOR ATIVO — o guard do
    // #5716 lê exatamente esse sinal pra bloquear merge cross-máquina.
    // `writeJsonSafe` usa `node:fs` de verdade (não o `removeIo` injetável,
    // que só existe pra simular falha de `rmSync` em teste) — se a stampagem
    // em si falhar (I/O), cai no catch e segue pro rmSync normalmente; nunca
    // lança, nunca aborta a promoção.
    try {
      if (removeIo.exists(promotedFrom)) {
        writeJsonSafe(promotedFrom, { ...previous, endedAt: now });
      }
    } catch (e) {
      warnIoError(promotedFrom, e);
    }
    // Best-effort: o record novo já foi gravado com sucesso acima.
    // `existsSync` antes do `rmSync` (mesmo padrão de
    // `garbageCollectSessions` abaixo) evita um warning espúrio no caso
    // benigno de o arquivo já ter sumido entre a busca e aqui (ex: um `gc`
    // concorrente). Qualquer OUTRA falha de I/O (transitório do OneDrive) é
    // logada, nunca lançada — e o desfecho fica visível via `outcome:
    // "promoted-orphan-left"` (#6326 fleet review — antes disto o retorno
    // não distinguia isso de uma promoção limpa).
    let removed = true;
    try {
      if (removeIo.exists(promotedFrom)) removeIo.remove(promotedFrom);
      if (removeIo.exists(promotedFrom)) removed = false; // remove "teve sucesso" mas o arquivo persiste (raro, ex: lock de outro processo)
    } catch (e) {
      removed = false;
      warnIoError(promotedFrom, e);
    }
    return { record, outcome: removed ? "promoted" : "promoted-orphan-left", promotedFrom };
  }

  return { record, outcome: hadOwnFile ? "reregistered" : "created" };
}

/**
 * Atualiza `lastHeartbeat` (+ um patch opcional de `phase`/`active_worktrees`)
 * de uma sessão já registrada. Retorna `false`, nunca lança, quando não há
 * sessão pra atualizar (nunca registrada, já encerrada, ou JSON corrompido).
 *
 * **`overnight`/`develop` nunca chamam esta função diretamente — e isso é
 * esperado, não um buraco (#6327).** `lastHeartbeat` dessas duas sessões
 * coordenadoras é mantido por um mecanismo DIFERENTE: `.claude/hooks/
 * session-beacon.mjs` (`PreToolUse`, #6303) escreve no registro EXISTENTE da
 * sessão (via `findExistingSessionFile`) a cada chamada de ferramenta,
 * atualizando `lastHeartbeat` como efeito colateral — sem que a skill precise
 * chamar `heartbeat` em lugar nenhum. Só `continuo` chama este export direto
 * (2 call sites hoje). A garantia efetiva pras 3: `lastHeartbeat` de QUALQUER
 * sessão viva fica fresco enquanto ela roda QUALQUER ferramenta (Bash, Edit,
 * Write, NotebookEdit — o matcher do hook), automaticamente.
 *
 * **Isto era falso até o #6303, e uma docstring desatualizada (a versão
 * anterior deste comentário, e trechos de `decideSessionGc` acima) continuou
 * descrevendo o estado pré-#6303 depois que o beacon já tinha fechado o
 * buraco — o #6327 é a correção.** Medido ao vivo em 26/08/2026: uma sessão
 * `develop` com 171min de vida tinha heartbeat de 0min; uma `overnight` com
 * 246min tinha heartbeat de 4min — nenhuma das duas jamais chamou
 * `heartbeat` neste módulo.
 *
 * **O acoplamento é implícito e vale a pena nomear (contra-argumento honesto
 * do #6327, não varrido):** um mecanismo de OBSERVABILIDADE (o beacon) virou
 * pré-requisito de um mecanismo de CORREÇÃO (claim válida — `SOFT_STALE_MS`
 * só destrava issue de sessão morta se o heartbeat de fato parar). Isso
 * quebra em SILÊNCIO se o beacon for desligado (`.claude/settings.json`),
 * reduzido em frequência, ou não rodar por algum dos guards dele (worktree
 * vinculado, `data/` ausente) — nesses casos `lastHeartbeat` volta a
 * congelar em `startedAt` e `SOFT_STALE_MS` volta a ser o único sinal, exatamente
 * como era antes do #6303, sem nenhum alarme dedicado pra essa regressão.
 * `test/session-beacon-hook.test.ts` (describe "#6327") trava que o beacon
 * atualiza `lastHeartbeat` de um registro de kind COORDENADOR (não só
 * `interactive`) — é o que impede reduzir/desligar o beacon de virar uma
 * mudança silenciosamente perigosa.
 *
 * **Decisão registrada (#6327 critério de aceite 4) — sessão coordenadora
 * rodando de WORKTREE VINCULADO:** o beacon pula de propósito quando o
 * próprio processo está num worktree vinculado (`isLinkedWorktree`, #6303
 * blast radius 3 — existe pra não registrar SUBAGENTES implementadores, que
 * sempre rodam com `isolation: "worktree"`). Isso também bloquearia o
 * heartbeat de uma coordenadora que, por algum motivo, rodasse a partir de um
 * worktree em vez do checkout principal. **Decisão: aceitável ficar stale
 * nesse caso, sem heartbeat por caminho alternativo.** Três razões: (1) por
 * convenção do repo (`context/overnight-dispatch-rules.md` item 11, "o
 * coordenador precisa ver o diff FINAL... existe fora do worktree do
 * subagente de propósito" — item 3, "Bootstrap do worktree", descreve a
 * mesma premissa em prosa mais indireta), worktree é SEMPRE do subagente
 * implementador — a coordenadora roda no checkout principal; uma
 * coordenadora em worktree vinculado é configuração fora do padrão
 * documentado, não o caso comum a otimizar; (2) o fallback já existe e
 * é seguro: `SOFT_STALE_MS` (90min) volta a valer sozinho, exatamente como
 * antes do #6303 — nenhuma claim fica presa pra sempre, só demora até 90min
 * a mais pra destravar; (3) adicionar um call site de `heartbeat` só pra esse
 * caso reabriria o próprio argumento do #6168 que motivou o beacon existir
 * ("o que depende de skill lembrar, não acontece") — pra um cenário que hoje
 * não tem instância real conhecida.
 */
export function heartbeat(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {},
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (!readJsonSafe<SessionRecord>(path)) return false;
  // #6952: CAS em vez de read-modify-write solto — o beacon (mesmo arquivo)
  // pode reescrever o record enquanto este heartbeat tenta gravar, e um
  // `...current` congelado apagaria o `merge_grant`/`claimed_issues` dele.
  writeJsonSafeWithCas(
    path,
    (current) => {
      // Já confirmamos acima que o registro existe. Se ele sumiu entre aquela
      // leitura e o lock (`end` concorrente), LANÇAR é o certo: recriar aqui a
      // partir de um `{}` produziria um registro sem `kind`/`sessionId`, que é
      // pior que a falha visível.
      if (!current) throw new Error("heartbeat: sessão sumiu entre a leitura e a escrita");
      return { ...current, ...patch, lastHeartbeat: now };
    },
    (onDisk) => onDisk?.lastHeartbeat === now,
  );
  return true;
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
 */
export interface SessionLifecycleEvent {
  event: "ended" | "gc-removed-without-end";
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
}

function sessionLifecycleLogPath(repoRoot: string): string {
  return join(repoRoot, "data", "session-lifecycle.jsonl");
}

/** Best-effort, nunca lança — instrumentação não pode derrubar o caminho
 * principal de `endSession`/`garbageCollectSessions`. `data/` ausente (sessão
 * cloud/clone fresco) é um no-op silencioso, mesma disciplina fail-soft do
 * resto do módulo. */
function logSessionLifecycleEvent(repoRoot: string, event: SessionLifecycleEvent): void {
  try {
    const dataDir = join(repoRoot, "data");
    if (!existsSync(dataDir)) return;
    appendFileSync(sessionLifecycleLogPath(repoRoot), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // best-effort — nunca propaga.
  }
}

/**
 * Remove o registro de uma sessão. Idempotente — no-op se já ausente.
 *
 * Retorna `true` quando um registro de fato existia e foi removido, `false`
 * quando não havia nada pra remover (#5797) — distinção que o CLI (`main()`,
 * caso `end`) usa pra nunca reportar sucesso quando nada aconteceu. Antes do
 * #5797 o retorno era `void`: o CLI sempre imprimia "ended" mesmo quando
 * `--tag`/`--session-id` não batiam com nenhum arquivo em disco (ex: tentar
 * encerrar da máquina local o registro de outra máquina sem passar `--tag`
 * explicitamente — `tag` aqui default pra `machineTag()` local, então sem a
 * flag o path procurado nunca é o da outra máquina).
 *
 * #6624: quando `kind` é coordenador (`COORDINATOR_SESSION_KINDS`), registra
 * um evento `"ended"` no log de ciclo de vida — instrumentação, nunca afeta
 * o retorno nem lança.
 *
 * **#6952 (achado do review da PR): a remoção também entra no lock.** Todo
 * ESCRITOR do registro passou a serializar em `{path}.lock`, mas o REMOVEDOR
 * tinha ficado de fora — e remover é escrever. Sem o lock, esta sequência
 * ressuscita um registro encerrado de propósito:
 *
 *   t0  um CAS (heartbeat/claim/beacon) lê `current` DENTRO do lock
 *   t1  endSession apaga o arquivo, sem lock nenhum
 *   t2  o CAS grava — e recria o arquivo que acabou de ser encerrado
 *
 * O gatilho é banal: o beacon da sessão dispara a cada chamada de ferramenta,
 * inclusive na última antes de a sessão terminar, então o heartbeat final e o
 * `end` competem por construção. Um registro ressuscitado é pior que um
 * heartbeat perdido — ele volta a aparecer em `list-active`, segura as claims
 * dele, e só sai no GC seguinte.
 *
 * Um timeout de lock aqui PROPAGA (não vira `false`): "não consegui garantir
 * a remoção" e "não havia nada pra remover" são estados diferentes, e o CLI
 * distingue os dois — o `main()` transforma o throw em erro nomeado com exit
 * 1, em vez de imprimir "nothing to end" pra uma remoção que não aconteceu.
 *
 * **`breakStaleLock` ANTES de adquirir (achado do 4º review).** Pegar o lock
 * sem quebrar o órfão reabre, neste call site, exatamente o modo de falha que
 * `STALE_LOCK_MS` existe pra eliminar: com um `.lock` deixado por um processo
 * que morreu segurando-o, o `end` gasta o timeout inteiro e LANÇA, e o
 * registro da sessão sobrevive pra sempre. Reproduzido: 10s e `exit 1`, com o
 * arquivo intacto.
 *
 * Aqui isso é mais grave que nos outros escritores, e por isso a checagem é
 * obrigatória e não conveniência: `end` é a ÚLTIMA operação sobre este
 * arquivo. Os demais se autocurariam na escrita seguinte — aqui não há
 * escrita seguinte, e `end` é o passo final obrigatório de toda rodada
 * overnight/develop/contínuo. O gatilho também não é hipotético: o binário do
 * Claude Code quebrou 9× num único dia, e morrer segurando o lock é
 * precisamente como o órfão nasce.
 *
 * Sem laço de retry, diferente do `writeJsonSafeWithCas`: uma quebra de órfão
 * basta pro caso órfão, e contenção real com um escritor VIVO deve mesmo
 * esperar os 10s e falhar de forma visível — não há o que reconciliar numa
 * remoção.
 *
 * **Quem chama isto deve ter feito todas as recusas ANTES.** A primeira coisa
 * que esta função faz é quebrar lock órfão, que é destrutivo sobre estado
 * compartilhado; um guard avaliado depois já não tem como desfazer isso. Ver
 * o comentário de ordem no caso `end` do CLI.
 */
export function endSession(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  tag: string = machineTag(),
  // Só pra teste: o caso "lock VIVO é respeitado" precisa ESPERAR o timeout
  // estourar pra provar que a quebra é por IDADE e nunca incondicional, e
  // esperar os 10s de produção custava 10s de wall-clock na suíte — o
  // suficiente, somado aos outros testes de lock, pra estourar o orçamento de
  // 300s do batch do runner paralelo (medido: o batch de 150 arquivos que
  // contém estes testes passou a dar ETIMEDOUT). Produção nunca passa este
  // argumento.
  lockTimeoutMs: number = 10_000,
): boolean {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  if (!existsSync(path)) return false;
  // #7002: os paths das cópias de conflito do grupo são resolvidos ENQUANTO o
  // arquivo real ainda existe — `sessionGroupBackupPaths` casa backup→real por
  // stem REAL EXISTENTE, então depois do `rmSync` abaixo elas viram órfãs e o
  // mesmo cálculo devolveria lista vazia.
  const groupBackupPaths = sessionGroupBackupPaths(repoRoot, path);
  breakStaleLock(`${path}.lock`);
  // #6624 × #6952: a leitura do registro pra instrumentação acontece DENTRO
  // do lock, junto da remoção — lida fora, o `startedAt` poderia vir de um
  // registro que outro escritor já trocou entre a leitura e o `rmSync`. O
  // EVENTO é emitido depois de soltar o lock: é append num arquivo diferente,
  // não precisa da exclusão do registro, e prender o lock por ele alongaria a
  // janela da única operação que não tem escrita seguinte pra se autocurar.
  const outcome = withFileLock<{ removed: boolean; record: SessionRecord | null }>(`${path}.lock`, () => {
    // Re-checa DENTRO do lock: outro `end`/GC concorrente pode ter removido
    // entre o `existsSync` acima e a aquisição.
    if (!existsSync(path)) return { removed: false, record: null };
    const record = isCoordinatorKind(kind) ? readJsonSafe<SessionRecord>(path) : null;
    rmSync(path);
    return { removed: true, record };
  }, lockTimeoutMs);
  if (outcome.removed) {
    // #7002: carimba `endedAt` em cada cópia de conflito do grupo. É o que
    // torna "encerrada limpo" DISTINGUÍVEL de "o arquivo real sumiu com a
    // sessão viva" — as duas produzem a mesma forma em disco (backup sem
    // real), e `readMergedSessionGroups` promove a segunda de volta a sessão
    // ativa. Sem este carimbo, toda sessão que encerra com cópia de conflito
    // no disco ressuscitaria por até `SOFT_STALE_MS` (90min), com as claims
    // dela bloqueando outras sessões — o falso-POSITIVO simétrico ao bug que
    // a promoção conserta.
    //
    // Reescrita cirúrgica de UM campo por cópia (molde do `unclaimIssue`/
    // `consumeMergeGrant`), best-effort e isolada por cópia: uma que falhe
    // nunca impede o carimbo das demais, e o `end` em si já aconteceu.
    const endedAt = new Date().toISOString();
    for (const backupPath of groupBackupPaths) {
      try {
        if (!existsSync(backupPath)) continue;
        writeJsonSafeWithCas(
          backupPath,
          (current) => {
            if (!current) throw new Error("endSession: backup sumiu entre a leitura e a escrita");
            return { ...current, endedAt };
          },
          (onDisk) => Boolean(onDisk?.endedAt),
        );
      } catch {
        // Cópia ilegível/exaurida: o GC recolhe depois (`planSessionGc` já
        // trata backup órfão), e a promoção do #7002 só a ressuscitaria
        // enquanto o heartbeat dela ainda estivesse dentro da janela de
        // liveness — janela curta, dano limitado, nunca motivo pra `end`
        // falhar.
      }
    }
  }
  if (outcome.record) {
    const now = Date.now();
    const startedMs = Date.parse(outcome.record.startedAt ?? "");
    logSessionLifecycleEvent(repoRoot, {
      event: "ended",
      kind,
      machineTag: tag,
      sessionId,
      ts: new Date(now).toISOString(),
      ageMs: Number.isFinite(startedMs) ? now - startedMs : undefined,
    });
  }
  return outcome.removed;
}

/**
 * Resultado de `checkRepoTreeClean` — árvore limpa ou lista de linhas de
 * `git status --porcelain` (uma por caminho sujo).
 */
export interface RepoTreeCleanResult {
  clean: boolean;
  files: string[];
}

/**
 * Roda `git status --porcelain` em `repoRoot` e reporta se a árvore está
 * limpa (#6922). Existe pra dar ao CLI `end` (ver `evaluateEndGuard` abaixo)
 * um jeito MECÂNICO de checar a regra que já estava em prosa no `SKILL.md`
 * de `/diaria-continuo` ("nunca encerrar deixando trabalho não commitado em
 * `master` no checkout compartilhado") — a prosa sozinha não bastou: um tick
 * relatou "concluído" em 26/08 com trabalho solto no checkout, e a mesma
 * classe se repetiu em 01/09 (498 linhas da #6952 nunca commitadas, nunca
 * enviadas, sem PR — ver #6922, comentário de 01/09 21:45 BRT). Nas duas
 * ocorrências o `end` do tick não encontrou nenhum obstáculo — a única
 * defesa era o modelo lembrar de rodar `git status` por conta própria antes
 * de encerrar.
 *
 * Fail-soft: se o comando `git` falhar (não é repo git, git indisponível,
 * timeout) devolve `clean: true` — mesma direção de falha de
 * `resolveRepoRoot` acima (nunca bloquear por causa de uma checagem que não
 * rodou, só por uma que rodou e achou sujeira de verdade).
 */
export function checkRepoTreeClean(repoRoot: string): RepoTreeCleanResult {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (res.status !== 0) return { clean: true, files: [] };
    const files = (res.stdout ?? "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    return { clean: files.length === 0, files };
  } catch {
    return { clean: true, files: [] };
  }
}

/**
 * Resultado de `evaluateEndGuard` — se o `end` pode prosseguir, e a mensagem
 * de recusa (só presente quando `ok: false`) pro CLI imprimir. `warning`
 * carrega um aviso informativo (stderr) quando o `end` PROSSEGUE apesar de
 * sujeira alheia — nunca aborta, só avisa (#6922 reaberto).
 */
export interface EndGuardResult {
  ok: boolean;
  message?: string;
  warning?: string;
}

/**
 * Extrai o caminho de cada linha de `git status --porcelain` (formato
 * `XY caminho` ou `XY orig -> novo` pra renames — usa o lado NOVO). Best-effort:
 * uma linha em formato inesperado é devolvida como está, o pior caso é uma
 * interseção que não casa (fail-direction segura — vira "sujeira alheia" e
 * o `end` avisa em vez de recusar, nunca o contrário).
 */
function extractPorcelainPath(line: string): string {
  const body = line.slice(3); // remove "XY " (2 chars de status + 1 espaço)
  const arrowIdx = body.indexOf(" -> ");
  return arrowIdx === -1 ? body : body.slice(arrowIdx + 4);
}

/**
 * Guard chamado pelo CLI `end` ANTES de remover o registro da sessão
 * (#6922, revisado — ver comentário de 01/09 sobre a fail-direction
 * invertida). Recusa encerrar o tick **só quando a sujeira do checkout
 * compartilhado é atribuível à PRÓPRIA sessão** (interseção entre
 * `git status --porcelain` e os `touched_paths`/`dirty_paths` que o beacon
 * desta sessão já registrou) — força o commit/push/stash a acontecer (ou o
 * `--allow-dirty` explícito) só nesse caso.
 *
 * Sujeira que NÃO intersecta os caminhos da própria sessão é quase sempre de
 * OUTRA sessão viva no mesmo checkout compartilhado (#6168 é a norma
 * documentada, não a exceção) — recusar por ela agrava exatamente os
 * problemas que #6623/#6624 descrevem (sessões desassistidas sem quem digite
 * `--allow-dirty`, claims presas até a staleness). Nesse caso o `end`
 * PROSSEGUE e devolve `warning` (informativo, pro CLI imprimir em stderr) em
 * vez de abortar.
 *
 * `allowDirty: true` continua bypassando tudo, de propósito — escape
 * residual pro caso em que o operador quer confirmar manualmente que é
 * seguro seguir mesmo com sujeira própria.
 *
 * `ownPaths` — união de `touched_paths` e `dirty_paths` do PRÓPRIO registro
 * (já normalizados/coletados pelo chamador antes de `endSession` remover o
 * arquivo). Vazio/ausente (sessão sem beacon de paths, registros antigos
 * pré-#6168 Parte A) → nenhuma sujeira é atribuível à sessão → sempre avisa,
 * nunca recusa (mesma fail-direction: never bloquear por dado ausente).
 */
export function evaluateEndGuard(
  repoRoot: string,
  allowDirty: boolean,
  ownPaths: readonly string[] = [],
): EndGuardResult {
  if (allowDirty) return { ok: true };
  const { clean, files } = checkRepoTreeClean(repoRoot);
  if (clean) return { ok: true };

  const normalizedOwn = [...new Set(ownPaths.map(normalizeBeaconPath))].filter((p) => p !== "");
  const own: string[] = [];
  const foreign: string[] = [];
  for (const line of files) {
    const path = normalizeBeaconPath(extractPorcelainPath(line));
    const isOwn = path !== "" && normalizedOwn.some((op) => beaconPathsOverlap(op, path));
    (isOwn ? own : foreign).push(line);
  }

  if (own.length === 0) {
    const fileList = foreign.map((f) => `  ${f}`).join("\n");
    return {
      ok: true,
      warning:
        `session-registry: end prossegue com árvore suja em ${repoRoot} (${foreign.length} arquivo(s)) — ` +
        `nenhum casa com touched_paths/dirty_paths desta sessão, tratado como sujeira de OUTRA sessão no ` +
        `checkout compartilhado (#6168):\n${fileList}\n`,
    };
  }

  const ownList = own.map((f) => `  ${f}`).join("\n");
  const foreignSuffix =
    foreign.length > 0 ? ` (mais ${foreign.length} arquivo(s) de sujeira alheia, ignorados nesta checagem)` : "";
  return {
    ok: false,
    message:
      `session-registry: end RECUSADO — árvore suja em ${repoRoot} com ${own.length} arquivo(s) atribuível(is) ` +
      `a esta sessão (touched_paths/dirty_paths)${foreignSuffix}:\n${ownList}\n` +
      "Commitar, dar push, ou mover o trabalho pra fora do repo antes de encerrar o tick — nunca encerrar " +
      "deixando trabalho PRÓPRIO não commitado no checkout compartilhado (#6922). --allow-dirty bypassa " +
      "explicitamente se necessário.\n",
  };
}

/** Nomes de arquivo `.json` de sessão (real ou backup) em `data/sessions/` —
 * exclui dotfiles (`.merge-lock.json` etc). Fail-soft: diretório ausente ou
 * erro de leitura → array vazio, nunca lança. Ordem não é garantida
 * (`readdirSync` bruto). */
function listSessionJsonFiles(repoRoot: string): string[] {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch (e) {
    // #6277 (achado do review): este catch era VAZIO. Uma falha de I/O no
    // diretório inteiro (EBUSY/EPERM/EACCES — os mesmos transitórios de
    // OneDrive que `readJsonSafe` já loga por arquivo) colapsava para "nenhuma
    // sessão existe", sem uma linha de aviso. Pior que o caso por-arquivo, que
    // ao menos avisa. Isso virou crítico quando `findActiveSessionsOfKind`
    // passou a decidir "há overnight rodando?" em cima disso: falha de leitura
    // vira `active: false` e o contínuo volta a duplicar o trabalho do
    // overnight — exatamente o desperdício que o mecanismo existe pra evitar.
    warnIoError(dir, e);
    return [];
  }
}

/**
 * Resultado de `checkSessionsScanHealth` — se a varredura de `data/sessions/`
 * conseguiu de fato ler o diretório, ou se degradou para "vazio" por falha de
 * I/O. Existe porque o caminho fail-soft (correto para não derrubar a
 * pipeline) é indistinguível, no retorno, de "não há sessão nenhuma" — e para
 * uma decisão de EXCLUSÃO mútua essa ambiguidade é fail-open (#6277).
 */
export interface SessionsScanHealth {
  /** `false` só quando o diretório EXISTE mas não pôde ser lido. */
  ok: boolean;
  /** Código/mensagem do erro de I/O — presente só quando `ok: false`. */
  error?: string;
}

/**
 * Responde se `data/sessions/` está legível AGORA. Diretório ausente conta
 * como `ok: true` (é o estado normal de um clone fresco/sessão cloud — "não
 * há sessão" é resposta honesta, não degradação). Só um erro de leitura sobre
 * diretório existente devolve `ok: false`.
 *
 * O consumidor é o CLI `active-of-kind`, que expõe isso como `uncertain` no
 * JSON para o chamador poder fail-CLOSED: com `uncertain: true`, tratar como
 * "pode haver overnight rodando" em vez de confiar no `active: false`.
 */
export function checkSessionsScanHealth(repoRoot: string): SessionsScanHealth {
  const dir = sessionsDir(repoRoot);
  if (!existsSync(dir)) return { ok: true };
  try {
    readdirSync(dir);
    return { ok: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);
    return { ok: false, error: String(code) };
  }
}

/**
 * Une um grupo de registros (arquivo real + eventuais cópias de conflito do
 * MESMO sessionId, #6130) num único `SessionRecord` efetivo:
 *   - `claimed_issues`: UNIÃO de todos os arrays do grupo — fail-safe,
 *     preferir "está reivindicada" a "não está" (ver docstring do módulo).
 *   - `merge_grant`: UNIDO também, desde o #6952 — ver abaixo.
 *   - demais campos (phase, pid, active_worktrees, lastHeartbeat…): copiados
 *     do registro com o `lastHeartbeat` MAIS RECENTE do grupo — se qualquer
 *     cópia mostra atividade recente, o grupo inteiro é tratado como
 *     recente (mesmo princípio fail-safe: preferir "viva" a "stale").
 *
 * **#6952, segunda metade — por que `merge_grant` precisou entrar na união.**
 * Até aqui só `claimed_issues`/`claimed_issues_at` eram unidos; todo o resto
 * vinha de `...primary`, e `primary` é escolhido por heartbeat mais recente.
 * Um `merge_grant` gravado num record que PERDE essa disputa — uma cópia de
 * conflito do OneDrive com heartbeat mais novo, o cenário para o qual esta
 * função existe — era descartado em SILÊNCIO na leitura. Exatamente o oposto
 * do que o #6130/#6436 garantiram pra claim, e é essa assimetria que explica
 * o sintoma medido no #6952: a claim sobrevivia e o grant sumia.
 *
 * Isto é uma metade independente do lost update de ESCRITA (fechado pelo
 * `writeJsonSafeWithCas`): serializar toda escrita não ajuda em nada aqui,
 * porque as duas cópias são gravadas corretamente, cada uma no seu arquivo, e
 * a perda acontece depois, na hora de ler.
 *
 * Regra da união, e o cuidado que ela exige:
 *   1. Vence o grant de `grantedAt` MAIS RECENTE do grupo — não o do
 *      `primary`. Uma concessão nova nunca é ofuscada por uma velha só
 *      porque a velha está no arquivo com heartbeat mais alto.
 *   2. `consumedAt` PROPAGA — mas só do arquivo REAL, nunca de uma cópia
 *      `-safeBackup-` (#7462). Se o real mostra a concessão vencedora como
 *      consumida, o resultado sai consumido (com o `consumedAt` mais ANTIGO —
 *      a primeira consumação é a real). É a direção segura: sem isto, uma
 *      cópia velha sem `consumedAt` RESSUSCITA um grant já usado e o transforma
 *      em uso duplo — dano pior que a perda que esta função conserta. Um guard
 *      que erra para o lado do dano é pior que nenhum guard.
 *
 *   **Por que a fonte do `consumedAt` importa (#7462).** O #6952 fez a união
 *   para que uma concessão que sobrevivesse só num backup não sumisse na
 *   leitura — e é isso mesmo que causou o sintoma: o `consumedAt` também
 *   passou a vir de cópias de conflito, e o read-path (`findLiveMergeGrant` →
 *   `isMergeGrantLive`) passou a ver uma concessão como já usada mesmo quando
 *   o ARQUIVO REAL (o único que o gate de merge
 *   `.claude/hooks/block-gh-pr-merge-subagent.mjs` lê, que pula
 *   `-safeBackup-` nomes) nunca foi carimbado. Resultado: `check-merge-grant`
 *   dizia `granted: true` e o `gh pr merge` era bloqueado com
 *   `consumedAt` já presente, sem que nenhuma sessão tivesse chamado
 *   `consume-merge-grant` — exatamente o que a issue #7462 relata, reproduzido
 *   2×. O `consumedAt` é um carimbo de FATO, não um voto de maioria: só
 *   conta quando está no registro que o merge de fato escreveu.
 *
 *   A distinção é o que `mergeSessionRecords` recebe já resolvido — o caller
 *   passa os records com o real na posição 0 (ver `readMergedSessionGroups`,
 *   `readMergedRecordForRealFile`, `dedupeBySessionId`). Quando o real é
 *   ilegível/ausente, o grupo é de fato SÓ backups (órfão) e aí não há real a
 *   consultar — o grant é considerado vivo, como o #6972 já decide pro
 *   `merge_grant` inteiro (não se recupera um grant de órfão pro real).
 *
 * As duas identidades são comparadas por `(grantedBy, grantedTo, grantedAt)`:
 * é o que distingue "a mesma concessão em duas cópias do arquivo" de "duas
 * concessões diferentes".
 *
 * Pura — não lê disco. `records` não pode ser vazio.
 */
export function mergeSessionRecords(
  records: readonly SessionRecord[],
  // #7462: índice do arquivo REAL no array. `consumedAt` só propaga dele —
  // cópias `-safeBackup-` são detrito de sync, não prova de consumo. Default 0
  // porque os callers que passam records crus colocam o real em [0]
  // (`readMergedSessionGroups`, `readMergedRecordForRealFile`,
  // `decideClaimReconciliation`, `mergeGrantBlocksBackupCleanup`). `−1` = grupo
  // sem real (órfão): o grant é considerado vivo, como o #6972 decide pro
  // `merge_grant` inteiro. Callers que já mesclaram (ex: `dedupeBySessionId`)
  // passam o default — o `consumedAt` deles já reflete o real.
  realIndex: number = 0,
): SessionRecord {
  // #6130 (achado do fleet review, P3 alta confiança): o invariante "records
  // não pode ser vazio" só existia em comentário — um `records[0]!` mentia
  // pro type checker. Falha nomeada em vez de um TypeError opaco.
  if (records.length === 0) {
    throw new Error("mergeSessionRecords: records não pode ser vazio");
  }
  let primary = records[0]!;
  let primaryHb = Date.parse(primary.lastHeartbeat ?? primary.startedAt ?? "");
  for (const r of records.slice(1)) {
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && (!Number.isFinite(primaryHb) || hb > primaryHb)) {
      primary = r;
      primaryHb = hb;
    }
  }
  const claimedUnion = new Set<number>();
  for (const r of records) for (const issue of r.claimed_issues ?? []) claimedUnion.add(issue);
  // #6436 — une `claimed_issues_at` de todas as cópias do grupo, mantendo o
  // timestamp MAIS ANTIGO por issue (a claim "de verdade" começou lá, mesmo
  // que uma cópia de conflito do OneDrive tenha um valor mais recente por
  // ter sido escrita numa reivindicação subsequente ainda não deduplicada).
  const claimedAtUnion: Record<string, string> = {};
  for (const r of records) {
    for (const [key, at] of Object.entries(r.claimed_issues_at ?? {})) {
      const existing = claimedAtUnion[key];
      if (!existing || Date.parse(at) < Date.parse(existing)) {
        claimedAtUnion[key] = at;
      }
    }
  }
  // #6952 (2ª metade): `merge_grant` unido, não herdado do `primary`.
  const grants = records.map((r) => r.merge_grant).filter((g): g is MergeGrant => Boolean(g));
  let mergedGrant: MergeGrant | undefined;
  if (grants.length > 0) {
    let winner = grants[0]!;
    for (const g of grants.slice(1)) {
      const a = Date.parse(g.grantedAt ?? "");
      const b = Date.parse(winner.grantedAt ?? "");
      if (Number.isFinite(a) && (!Number.isFinite(b) || a > b)) winner = g;
    }
    // Só o ARQUIVO REAL testemunha um consumo de fato (#7462). Cópias
    // `-safeBackup-` são detrito de sync do OneDrive — uma concessão viva
    // nelas é sinal de que o real ficou pra trás, não de que alguém
    // consumiu. O `consumedAt` é um carimbo de FATO (o merge bem-sucedido
    // que o gravou), não um voto de maioria: quando o real é ilegível/ausente
    // (grupo órfão, `realIndex === -1`) não há quem testemunhe, e o grant
    // continua vivo — mesma decisão do #6972 pro `merge_grant` inteiro.
    //
    // O `consumedAt` vem SEMPRE do real, nunca do winner: o winner é o
    // grant de `grantedAt` mais recente do grupo, e pode ser um backup com
    // um `consumedAt` que o real nunca teve. `{ ...winner }` espalha o
    // `consumedAt` do próprio winner, então sem este `delete` o mesclado
    // sairia consumido de qualquer jeito quando o winner fosse um backup —
    // reproduzido ao vivo em #7462 com `realIndex=1` (real na posição 1) e
    // com `realIndex=-1` (grupo órfão, só backups).
    const realGrant = realIndex >= 0 ? records[realIndex]!.merge_grant : undefined;
    // #7462: o `consumedAt` vem SÓ do real, nunca do winner. O winner é o
    // grant de `grantedAt` mais recente do grupo, e pode ser um backup com
    // um `consumedAt` que o real nunca teve — `{ ...winner }` espalha o
    // `consumedAt` do próprio winner, então sem este `delete` o mesclado
    // sairia consumido de qualquer jeito quando o winner fosse um backup
    // (reproduzido ao vivo em #7462 com `realIndex=1` e `realIndex=-1`).
    // Retira o carimbo do winner ANTES de reconstruir: o grant mesclado só
    // leva `consumedAt` quando o real (a única fonte de verdade) o
    // testemunha para a MESMA identidade.
    const { consumedAt: _winnerConsumedAt, ...winnerClean } = winner;
    const consumedAt =
      realGrant &&
      realGrant.grantedBy === winner.grantedBy &&
      realGrant.grantedTo === winner.grantedTo &&
      realGrant.grantedAt === winner.grantedAt
        ? realGrant.consumedAt
        : undefined;
    // Só inclui `consumedAt` quando REALMENTE está presente. Um grant vivo
    // (não consumido) não tem o campo — e `assert.deepEqual` distingue
    // `{ ...grant, consumedAt: undefined }` de `grant` (o campo ausente).
    // Sem este spread condicional, o mesclado sairia com a CHAVE `consumedAt`
    // definida como `undefined` pra qualquer grant vivo, quebrando a
    // representação canônica do #6952/#6972 (um grant vivo é exatamente um
    // objeto SEM `consumedAt`). O `consumedAt` continua vindo SÓ do real
    // (#7462): cópias `-safeBackup-` nunca testemunham.
    mergedGrant = consumedAt ? { ...winnerClean, consumedAt } : winnerClean;
  }

  return {
    ...primary,
    ...(mergedGrant ? { merge_grant: mergedGrant } : {}),
    claimed_issues: [...claimedUnion].sort((a, b) => a - b),
    claimed_issues_at: claimedAtUnion,
  };
}

/**
 * Agrupa os arquivos de `data/sessions/` por identidade de sessão (stem do
 * arquivo REAL, sem sufixo `-safeBackup-`) e retorna 1 `SessionRecord`
 * mesclado (`mergeSessionRecords`) por identidade ANCORADA num arquivo real
 * existente. Backup ÓRFÃO (nenhum arquivo real cujo stem seja prefixo dele)
 * é ignorado aqui — mesmo comportamento do #5427: sessão já encerrada
 * (arquivo real removido por `endSession`) não ressuscita como ativa só
 * porque uma cópia de conflito antiga sobrou no disco. O match de backup →
 * real é por PREFIXO DE STRING (nunca assume formato de `sessionId`, que
 * pode ser um UUID em produção ou um id arbitrário em teste) — mais
 * específico (stem mais longo) vence em caso de ambiguidade.
 *
 * **#7002 — a exceção que o parágrafo acima não previa: o arquivo real pode
 * ter sumido com a sessão VIVA.** "Backup órfão" tem duas causas com a MESMA
 * forma em disco — `endSession` removeu o real de propósito (o caso do #5427,
 * acima), ou o real se perdeu num lost-update de escrita sobre o junction
 * OneDrive enquanto a sessão seguia trabalhando. Medido ao vivo em 01/09/2026:
 * a coordenadora de uma rodada `overnight` perdeu o próprio arquivo, os
 * backups guardaram as 10 claims e um `merge_grant` íntegros, e este read-path
 * os descartou — a sessão passou a aparecer pras outras com
 * `claimed_issues: []`. Falso-negativo de claim (issue reivindicada aparecendo
 * como livre) é exatamente o dano que `claim-issue` existe pra prevenir.
 *
 * Por isso um grupo órfão que ainda parece VIVO (`isOrphanBackupGroupLive`:
 * nenhuma cópia com `endedAt` + heartbeat dentro da janela de liveness do
 * kind) é PROMOVIDO de volta a sessão ativa, pela mesma união
 * (`mergeSessionRecords`) usada nos grupos ancorados. Grupo órfão stale, ou
 * carimbado por `endSession`, continua descartado exatamente como antes — o
 * invariante do #5427 não muda para a causa que ele descrevia.
 *
 * O critério é o MESMO que `decideSessionGc` já aplica ("heartbeat recente …
 * sessão claramente ativa" nunca é removido, mesmo órfão): a assimetria entre
 * um GC que preserva o grupo por considerá-lo vivo e um read-path que o
 * descarta por considerá-lo morto era o bug, não uma escolha.
 */
function readMergedSessionGroups(repoRoot: string, now: number = Date.now()): SessionRecord[] {
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !n.includes("-safeBackup-"));
  const backupNames = names.filter((n) => n.includes("-safeBackup-"));

  const realStems = realNames.map((n) => n.slice(0, -".json".length)).sort((a, b) => b.length - a.length);
  const backupsByRealStem = new Map<string, string[]>();
  for (const backup of backupNames) {
    const matchStem = realStems.find((stem) => backup.startsWith(`${stem}-`));
    if (!matchStem) continue; // órfão — ver docstring acima
    const list = backupsByRealStem.get(matchStem) ?? [];
    list.push(backup);
    backupsByRealStem.set(matchStem, list);
  }

  const dir = sessionsDir(repoRoot);
  const merged: SessionRecord[] = [];
  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const groupNames = [realName, ...(backupsByRealStem.get(stem) ?? [])];
    const records = groupNames
      .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
      .filter((r): r is SessionRecord => r !== null && !!r.sessionId && !!r.kind);
    if (records.length === 0) continue;
    merged.push(mergeSessionRecords(records));
  }

  // #7002: grupos ÓRFÃOS que ainda parecem vivos voltam pra leitura. Um grupo
  // cuja identidade coincide com um arquivo real existente (nome de backup que
  // o match por prefixo não alcançou) também entra aqui — `dedupeBySessionId`
  // funde os dois por `(machineTag, sessionId)` logo depois, unindo as claims
  // em vez de duplicar a sessão.
  for (const group of readOrphanBackupGroups(repoRoot)) {
    if (!isOrphanBackupGroupLive(group, now)) continue;
    merged.push(group.record);
  }
  return merged;
}

/**
 * Fecha o gap do READ-path documentado no #6481: `readMergedSessionGroups`
 * agrupa só por STEM de arquivo (arquivo real + suas cópias `-safeBackup-N`)
 * — nunca cruza entre um registro `overnight-*`/`develop-*`/`continuo-*` e um
 * `interactive-*` do MESMO `sessionId`, que são arquivos com STEMS distintos.
 * Essa é a mesma janela de corrida que `registerSession` (#6326) já cobre no
 * WRITE-path: o beacon (`.claude/hooks/session-beacon.mjs`) cria
 * `interactive-{tag}-{sessionId}.json` ANTES de a skill rodar `register
 * --kind overnight`, e a promoção subsequente é BEST-EFFORT — `rmSync` do
 * arquivo antigo pode falhar (I/O transitório do OneDrive), deixando os dois
 * arquivos coexistindo por tempo indeterminado (`outcome:
 * "promoted-orphan-left"`, ver `RegisterSessionOutcome`). Nesse intervalo,
 * `readMergedSessionGroups` devolvia os DOIS registros como sessões
 * distintas — e, pior, sem ordem determinística entre eles, `list-active`/
 * `is-claimed` podiam exibir o registro `interactive` (tipicamente com
 * `claimed_issues: []`, porque o beacon não escreve claims) no lugar do
 * `overnight`/`develop`/`continuo` real, escondendo claims genuínas (achado
 * ao vivo #6481: Triagem do Studio parou de mostrar 7 issues reivindicadas
 * porque o registro efetivamente listado para aquele `sessionId` era o
 * `interactive`).
 *
 * Aplica a MESMA regra que o write-path já usa (#6326, `isCoordinatorKind`):
 * quando mais de um registro do grupo já-mesclado-por-STEM compartilha
 * `sessionId`, o COORDENADOR (`overnight`/`develop`/`continuo`) vence sobre
 * `interactive` como base de campos (kind, phase, branch, etc.) — e, na
 * mesma disciplina fail-safe de `mergeSessionRecords`, `claimed_issues`/
 * `claimed_issues_at` são a UNIÃO de TODOS os registros do grupo (incluindo
 * o `interactive` descartado como base), nunca só os do vencedor — preferir
 * "está reivindicada" a "não está", mesmo princípio de sempre neste módulo.
 * Se por algum motivo dois registros COORDENADORES coexistirem pro mesmo
 * `sessionId` (não deveria acontecer — cada skill só registra 1 kind por
 * vez), o de heartbeat mais recente vence como base (mesmo critério de
 * `mergeSessionRecords`).
 *
 * **#6952: a chave de agrupamento é (`machineTag`, `sessionId`), não
 * `sessionId` sozinho.** O propósito descrito acima é sempre INTRA-máquina —
 * uma sessão promovida de `interactive` pra coordenadora mantém o
 * `sessionId` e troca o `kind`, no MESMO host. Dois registros com o mesmo
 * `sessionId` e `machineTag` DIFERENTE não são a mesma sessão; fundi-los
 * mistura duas sessões num record só.
 *
 * Antes do #6952 isso quase não tinha consequência: só `claimed_issues` era
 * unido e todo o resto vinha do `primary`, então um `merge_grant` só cruzava
 * a fronteira de máquina por coincidência de heartbeat. Com o `merge_grant`
 * entrando na união, o vazamento passaria a ser sistemático — uma concessão
 * gravada no registro de uma máquina apareceria viva no record fundido da
 * outra. `data/sessions/` é compartilhado via OneDrive entre as máquinas, e
 * é essa a fronteira que a chave preserva.
 *
 * Dormente na prática (nada num fluxo normal produz o mesmo `sessionId` sob
 * duas tags), e por isso o conserto é a chave + o teste de regressão, não
 * um mecanismo novo.
 *
 * Pura — opera sobre a lista já lida do disco, não lê nada sozinha.
 */
function dedupeBySessionId(records: readonly SessionRecord[]): SessionRecord[] {
  const bySessionId = new Map<string, SessionRecord[]>();
  for (const record of records) {
    // `\u0000` como separador: não pode aparecer em hostname nem em UUID de
    // sessão, então não há como uma tag terminada em "-" colidir com um
    // sessionId iniciado por outra coisa.
    const key = `${record.machineTag ?? ""}\u0000${record.sessionId}`;
    const group = bySessionId.get(key) ?? [];
    group.push(record);
    bySessionId.set(key, group);
  }

  const out: SessionRecord[] = [];
  for (const group of bySessionId.values()) {
    // #7028: registros com `endedAt` carimbado (promoção de kind cuja
    // remoção do arquivo antigo falhou — ver docblock do campo em
    // `SessionRecord`) não contam como sessão viva. Excluídos ANTES de
    // escolher base/kind — senão o órfão `overnight` (que só tem claims
    // MIGRADAS, já duplicadas no registro novo) continuaria vencendo sobre
    // um `interactive` genuinamente vivo só por `isCoordinatorKind`, o
    // sintoma medido ao vivo na #7028. Grupo inteiro encerrado (raro — só
    // aconteceria se TODAS as cópias tivessem sido carimbadas) não produz
    // nenhuma sessão ativa.
    const liveGroup = group.filter((r) => !r.endedAt);
    if (liveGroup.length === 0) continue;
    if (liveGroup.length === 1) {
      out.push(liveGroup[0]!);
      continue;
    }
    const claimsUnion = mergeSessionRecords(liveGroup);
    const coordinatorGroup = liveGroup.filter((r) => isCoordinatorKind(r.kind));
    const base = coordinatorGroup.length > 0 ? mergeSessionRecords(coordinatorGroup) : claimsUnion;
    out.push({
      ...base,
      claimed_issues: claimsUnion.claimed_issues,
      claimed_issues_at: claimsUnion.claimed_issues_at,
    });
  }
  return out;
}

/**
 * Lista as sessões ativas (não-stale) de `data/sessions/`, já com a UNIÃO
 * de claims de eventuais backups de conflito do OneDrive resolvida (#6130,
 * ver `readMergedSessionGroups`/`mergeSessionRecords`) E com registros de
 * kinds diferentes do MESMO `sessionId` deduplicados a favor do coordenador
 * (#6481, ver `dedupeBySessionId`). Fail-soft: diretório ausente ou erro de
 * leitura → array vazio, nunca lança.
 */
export function listActiveSessions(
  repoRoot: string,
  now: number = Date.now(),
  maxAgeMs: number = MAX_SESSION_AGE_MS,
): ActiveSessionRecord[] {
  const out: ActiveSessionRecord[] = [];
  for (const record of dedupeBySessionId(readMergedSessionGroups(repoRoot, now))) {
    const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
    const heartbeatMs = Date.parse(heartbeatIso ?? "");
    if (!Number.isFinite(heartbeatMs)) continue;
    const ageMs = now - heartbeatMs;
    // #5161 item 2: idade "no futuro" além da tolerância de clock skew é
    // excluída (nunca finge que uma sessão stale/corrompida está ativa) MAS
    // fica visível via warning — nunca um descarte silencioso. Idade
    // pequena no futuro (dentro da tolerância) é jitter normal entre
    // máquinas e conta como ativa normalmente, sem log.
    if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
      warnClockSkew("listActiveSessions", `${record.kind}-${record.machineTag}-${record.sessionId}`, ageMs);
      continue;
    }
    if (ageMs > maxAgeMs) continue;
    // #5474: `stale` é só um sinal computado — nunca remove a sessão da lista
    // (isso quebraria consumidores como `overnight-watchdog.ts`/
    // `cleanup-merged-worktrees.ts`, que dependem da lista completa).
    // #6168: a janela é POR KIND — `interactive` usa a sua, bem menor, porque
    // não emite heartbeat depois que a conversa acaba (ver
    // `INTERACTIVE_SOFT_STALE_MS`). Os 3 kinds coordenadores não mudam.
    const stale = ageMs > softStaleMsForKind(record.kind);
    // #7227: `claimed_issues_effective` não segue mais `stale` diretamente —
    // usa a janela dedicada e mais conservadora de `claimReleaseMsForKind`
    // (ver sua docstring pro porquê: `stale` sozinho mede só silêncio de
    // heartbeat, que não é sinal POSITIVO de morte, e liberar um claim
    // autoriza terceiro a mexer em trabalho de sessão possivelmente viva).
    // Entre as duas janelas, a sessão aparece `stale: true` (observável) mas
    // com `claimed_issues_effective` ainda populado — "provavelmente ociosa",
    // não "livre". Mesma regra de validade que `isIssueClaimedByOther`
    // aplica (abaixo), carregada aqui pra quem só lê `list-active`.
    const claimsReleased = ageMs > claimReleaseMsForKind(record.kind);
    out.push({ ...record, stale, claimed_issues_effective: claimsReleased ? [] : (record.claimed_issues ?? []) });
  }
  return out;
}

/**
 * Motivo do resultado de `claimIssueCheckAndSet` (#6236). `ok: true` cobre
 * três casos de sucesso (`claimed`, `already-own`, `forced-override`);
 * `ok: false` cobre dois de falha (`no-op-session-missing`,
 * `blocked-by-other`) — `blockedBy` só é populado neste último.
 */
export type ClaimIssueReason =
  | "claimed"
  | "already-own"
  | "no-op-session-missing"
  | "blocked-by-other"
  | "forced-override";

export interface ClaimIssueResult {
  ok: boolean;
  reason: ClaimIssueReason;
  /** Registro da sessão que já segura a issue — presente só em `blocked-by-other`. */
  blockedBy?: ActiveSessionRecord;
}

export interface ClaimIssueOptions {
  /**
   * Escape hatch (#6236) — assume a issue mesmo que outra sessão ainda
   * segure o claim segundo `isIssueClaimedByOther` (#7227: isto NÃO é mais
   * o mesmo limiar que `stale`/`SOFT_STALE_MS` — ver `claimReleaseMsForKind`).
   * Existe pro caso legítimo de retomar issue de sessão que morreu sem
   * liberar o registro, mas AINDA dentro da janela de retenção do claim
   * (`claimReleaseMsForKind`, 24h pros 3 kinds coordenadores) — passada essa
   * janela, o claim já destrava sozinho sem `force` (ver `reason: "claimed"`
   * quando o dono anterior já não segura mais), então `force` só entra em
   * jogo contra dono cujo claim ainda vale.
   */
  force?: boolean;
}

/**
 * Faz check-and-set: adiciona `issueNumber` a `claimed_issues` da sessão SÓ
 * DEPOIS de confirmar que nenhuma OUTRA sessão ativa já a segura (#6236 —
 * antes desta mudança, `claimIssue` escrevia cego no próprio arquivo sem
 * nunca consultar os das outras sessões; a checagem vivia inteiramente no
 * chamador via `is-claimed`, com uma janela TOCTOU clássica entre os dois
 * comandos). Reusa `isIssueClaimedByOther` — a mesma função que o CLI
 * `is-claimed` já usa — em vez de reimplementar a consulta.
 *
 * Casos:
 * - Sessão do próprio `sessionId`/`tag` não existe (nunca registrada,
 *   encerrada, corrompida) → `{ ok: false, reason: "no-op-session-missing" }`.
 * - A PRÓPRIA sessão já segura a issue → no-op idempotente,
 *   `{ ok: true, reason: "already-own" }` (nunca recusa — usado em retomada).
 * - Outra sessão ainda segura o claim segundo `isIssueClaimedByOther`
 *   (#7227: dentro de `claimReleaseMsForKind`, não mais só "não-stale") e
 *   `force` não foi passado → recusa, `{ ok: false, reason: "blocked-by-other", blockedBy }`.
 * - Outra sessão ainda segura o claim e `force: true` → toma o claim
 *   mesmo assim, `{ ok: true, reason: "forced-override" }` (chamador deve
 *   avisar alto quem estava segurando, via `blockedBy` do retorno — este
 *   helper não loga por si, é puro).
 * - Ninguém segura (ou só uma sessão cujo claim já passou de
 *   `claimReleaseMsForKind` — `isIssueClaimedByOther` já ignora esse caso,
 *   #5474/#7227) → claim normal, `{ ok: true, reason: "claimed" }`, sem
 *   precisar de `force`.
 *
 * **Não fecha a janela TOCTOU entre MÁQUINAS diferentes** (mesma ressalva do
 * merge lock, #6182): a leitura de `isIssueClaimedByOther` e a escrita deste
 * claim não são atômicas entre si sobre o junction OneDrive — duas máquinas
 * podem, na mesma janela de poucos milissegundos, cada uma ler "ninguém
 * segura" e escrever seu próprio claim, porque `O_CREAT|O_EXCL`/leitura+escrita
 * sobre cópias sincronizadas via OneDrive não é uma transação atômica cross-
 * inode. Dentro da MESMA máquina (onde múltiplos processos Node leem/escrevem
 * o mesmo arquivo local, sem lag de sync) a janela fecha de fato — foi
 * exatamente aí que a colisão real do #6236 aconteceu (duas sessões,
 * `overnight` e `continuo`, na mesma máquina).
 */
export function claimIssueCheckAndSet(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): ClaimIssueResult {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const current = readJsonSafe<SessionRecord>(path);
  if (!current) return { ok: false, reason: "no-op-session-missing" };

  const alreadyOwn = (current.claimed_issues ?? []).includes(issueNumber);
  let reason: ClaimIssueReason = "claimed";
  let overriddenOwner: ActiveSessionRecord | undefined;
  if (alreadyOwn) {
    reason = "already-own";
  } else {
    const nowMs = Date.parse(now);
    const other = isIssueClaimedByOther(repoRoot, issueNumber, sessionId, Number.isFinite(nowMs) ? nowMs : Date.now());
    if (other) {
      if (!options.force) return { ok: false, reason: "blocked-by-other", blockedBy: other };
      reason = "forced-override";
      overriddenOwner = other;
    }
  }

  // #6952: CAS em vez de read-modify-write solto. O beacon (mesmo arquivo)
  // pode reescrever o record enquanto este claim tenta gravar, e um
  // `...current` congelado apagaria os campos dele (merge_grant,
  // touched_paths, etc.) — exatamente a mesma classe do #6952.
  const issueKey = String(issueNumber);
  writeJsonSafeWithCas(
    path,
    (current) => {
      if (!current) throw new Error("claimIssueCheckAndSet: sessão sumiu entre a leitura e a escrita");
      const claimed = new Set(current.claimed_issues ?? []);
      claimed.add(issueNumber);
      // #6436 — grava o timestamp da PRIMEIRA reivindicação, nunca sobrescreve
      // numa re-reivindicação da mesma issue (`already-own`) — ver docstring de
      // `claimed_issues_at` em `SessionRecord`.
      const claimedAt = { ...(current.claimed_issues_at ?? {}) };
      if (!(issueKey in claimedAt)) {
        claimedAt[issueKey] = now;
      }
      return {
        ...current,
        claimed_issues: [...claimed].sort((a, b) => a - b),
        claimed_issues_at: claimedAt,
        lastHeartbeat: now,
      };
    },
    (onDisk) => onDisk?.lastHeartbeat === now && (onDisk?.claimed_issues ?? []).includes(issueNumber),
  );
  return overriddenOwner ? { ok: true, reason, blockedBy: overriddenOwner } : { ok: true, reason };
}

/**
 * Resultado de `claimIssueAutoRegistering` — mesmo shape de `ClaimIssueResult`
 * mais o sinal de que a sessão precisou ser auto-registrada antes do claim.
 */
export interface ClaimIssueAutoRegisterResult extends ClaimIssueResult {
  /** `true` quando não havia registro de sessão pra `kind`/`sessionId` e este
   * helper criou um (via `registerSession`) antes de tentar o claim de novo. */
  autoRegistered: boolean;
  /**
   * #7003 — como o registro ausente foi resolvido, quando `autoRegistered`.
   *
   * - `"fresh"`: nenhum vestígio da sessão em disco → registro novo do zero
   *   (o caminho do #6369, sessão que de fato nunca registrou).
   * - `"recovered-from-orphan-backups"`: a âncora sumiu, mas cópias de
   *   conflito VIVAS dela sobreviveram → o registro foi RECONSTRUÍDO a partir
   *   delas (claims, `claimed_issues_at` e `merge_grant` preservados), nunca
   *   recriado zerado. É o modo 3 medido no #7003, e é ruidoso de propósito.
   *
   * Ausente quando `autoRegistered: false`.
   */
  autoRegisterMode?: "fresh" | "recovered-from-orphan-backups";
  /** #7003 — claims que a reconstrução trouxe de volta das cópias órfãs.
   * Presente só em `autoRegisterMode: "recovered-from-orphan-backups"`. */
  recoveredClaims?: number[];
  /** #7003 — quantas cópias de conflito alimentaram a reconstrução. */
  recoveredFromFiles?: number;
}

/**
 * Wrapper de `claimIssueCheckAndSet` que fecha o buraco do #6369: um
 * `no-op-session-missing` (sessão nunca registrada) deixava de ser tratado
 * como falha real por quem chama o CLI e virava um workaround em prosa (ex:
 * o ciclo `continuo` do cron Hermes registrou a reivindicação num `.md` que
 * nenhuma outra sessão lê — achado ao vivo 26/08/2026, quase causou trabalho
 * duplicado entre duas sessões na mesma issue).
 *
 * A issue propôs duas direções equivalentes: "ou o comando aborta o ciclo,
 * ou registra a sessão primeiro". Esta função implementa a 2ª — a única das
 * duas que fecha o buraco inteiramente DENTRO deste repo, sem depender de
 * uma skill externa (`hermes-diaria-continuo`, fora deste checkout — ver
 * CLAUDE.md "A infra do kind `continuo` tem um consumidor EXTERNO") tratar
 * corretamente um `exit 1`. Quando `claimIssueCheckAndSet` devolve
 * `no-op-session-missing`, registra uma sessão mínima (`registerSession`,
 * mesmos `kind`/`sessionId`/`tag` — idempotente, não pisa em registro
 * existente) e tenta o claim de novo. **Nunca finge que não aconteceu nada**:
 * o retorno sinaliza `autoRegistered: true` pra quem chama poder avisar alto
 * (o CLI abaixo imprime isso explicitamente na mensagem de sucesso) — a
 * intervenção fica visível, não é um passe silencioso.
 *
 * `claimIssueCheckAndSet` em si **não muda** — continua podendo devolver
 * `no-op-session-missing` pra quem quiser esse comportamento explícito (é o
 * que os testes existentes de `claimIssueCheckAndSet`/`unclaimIssue`
 * documentam, incluindo o caso "sessão nunca existiu"). Este wrapper é
 * aditivo, usado pelo CLI (`claim-issue`), não substitui a primitiva.
 *
 * **#7003 — "registro ausente" tem duas causas, e tratá-las igual é o bug.**
 * O auto-registro acima assume "sessão nova". A outra causa, medida ao vivo em
 * 01/09/2026, é a âncora SUMIR no meio de uma sessão VIVA (lost-update de
 * escrita sobre o junction OneDrive, #7002): ali o auto-registro converte
 * perda de ARQUIVO em perda SILENCIOSA de ESTADO — recria o registro zerado e
 * segue. A reprodução: 10 `claim-issue` sequenciais, cada um encontrando (ou
 * recriando) uma âncora vazia, terminaram com 3 das 10 claims — e as outras 7
 * sumiram do read-path enquanto a sessão seguia trabalhando nelas.
 *
 * Por isso, antes de registrar do zero, este wrapper procura cópias de
 * conflito ÓRFÃS e VIVAS da própria identidade
 * (`recoverAnchorFromOrphanBackups`) e RECONSTRÓI a âncora a partir delas —
 * claims, `claimed_issues_at` e `merge_grant` preservados. O desfecho fica
 * explícito em `autoRegisterMode` e num aviso alto em stderr: a sessão nunca
 * volta zerada, e a competição de escrita nunca passa silenciosa.
 *
 * **Por que não abortar o claim** (a leitura alternativa de "falhar alto"): um
 * `claim-issue` que aborta deixa uma sessão VIVA sem claim nenhuma — o
 * falso-negativo que a própria #7003 chama de pior que o falso-positivo, e o
 * caminho mais curto pra duas sessões na mesma issue. Ruído + preservação de
 * estado entrega o sinal sem criar o dano.
 */
export function claimIssueAutoRegistering(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): ClaimIssueAutoRegisterResult {
  const first = claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options);
  if (first.reason !== "no-op-session-missing") {
    return { ...first, autoRegistered: false };
  }
  // #7003: antes de criar um registro NOVO, checar se a âncora sumiu com a
  // sessão viva — ver `recoverAnchorFromOrphanBackups`. Reconstruir preserva
  // as claims anteriores; o auto-registro do #6369, sozinho, as apagava.
  const recovered = recoverAnchorFromOrphanBackups(repoRoot, kind, sessionId, tag, now);
  if (recovered) {
    warnAnchorRecoveredFromOrphanBackups(
      "claim-issue",
      sessionId,
      sessionFilePath(repoRoot, kind, tag, sessionId),
      recovered,
    );
    const retriedAfterRecovery = claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options);
    return {
      ...retriedAfterRecovery,
      autoRegistered: true,
      autoRegisterMode: "recovered-from-orphan-backups",
      recoveredClaims: [...(recovered.record.claimed_issues ?? [])],
      recoveredFromFiles: recovered.files.length,
    };
  }
  registerSession(repoRoot, kind, sessionId, { tag, startedAt: now });
  const retried = claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options);
  return { ...retried, autoRegistered: true, autoRegisterMode: "fresh" };
}

/**
 * Wrapper booleano de `claimIssueCheckAndSet` (#6236) — mantém a assinatura
 * histórica (`true`/`false`) pros chamadores que só precisam saber se o
 * claim colou, sem inspecionar o motivo. Ver `claimIssueCheckAndSet` para o
 * comportamento completo (check-and-set contra outras sessões ativas,
 * idempotência, `force`).
 */
export function claimIssue(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
  options: ClaimIssueOptions = {},
): boolean {
  return claimIssueCheckAndSet(repoRoot, kind, sessionId, issueNumber, tag, now, options).ok;
}

/**
 * Loga (stderr, nunca lança) que `unclaimIssue` achou o arquivo da PRÓPRIA
 * sessão em disco mas não conseguiu ler o conteúdo (#6337 fleet review item
 * 2 — mesma classe de bug que `warnUnreadablePromotionSource`/
 * `outcome: "promotion-failed-unreadable"` corrigiram em `registerSession`,
 * #6326). `readJsonSafe` devolve `null` tanto pra "arquivo ausente" quanto
 * pra "JSON malformado" — SEM logar o segundo caso (comentário no próprio
 * `readJsonSafe`: "comportamento pré-existente preservado, silencioso").
 * Colapsar os dois em `no-op-session-missing` faria o chamador (a skill)
 * tratar uma claim que está ATIVA no disco — só momentaneamente ilegível,
 * cenário recorrente de sync do OneDrive, ver #5161/#6130/#6326 — como se a
 * sessão nunca tivesse existido, seguindo em frente sem soltar nada e sem
 * nenhum sinal de que algo está errado.
 */
function warnUnclaimUnreadable(sessionId: string, path: string): void {
  try {
    process.stderr.write(
      `session-registry: aviso — unclaim-issue achou o registro de sessionId="${sessionId}" em "${path}" mas ` +
        "não conseguiu ler o conteúdo (JSON corrompido/parcialmente sincronizado pelo OneDrive). A claim pode " +
        'estar ATIVA no disco — isto NÃO é "sessão inexistente" (reason: "no-op-unreadable"); investigar antes de ' +
        "assumir que não há nada pra soltar.\n",
    );
  } catch {
    // Nunca deixar um log de warning quebrar o caminho fail-soft principal.
  }
}

/**
 * Motivo do resultado de `unclaimIssue` (#6317) — espelha `ClaimIssueReason`
 * no formato, mas o conjunto é o inverso: nenhum caso carrega `blockedBy`
 * (não existe "outra sessão bloqueando" pra soltar — só a própria sessão
 * pode `unclaim`, ver docstring de `unclaimIssue`). `no-op-unreadable`
 * (#6337 fleet review item 2) é distinto de `no-op-session-missing` de
 * propósito — ver `warnUnclaimUnreadable` acima pro racional.
 */
export type UnclaimIssueReason = "unclaimed" | "no-op-not-claimed" | "no-op-session-missing" | "no-op-unreadable";

export interface UnclaimIssueResult {
  ok: boolean;
  reason: UnclaimIssueReason;
}

/**
 * Inverso de `claimIssueCheckAndSet` (#6317) — remove `issueNumber` de
 * `claimed_issues` da PRÓPRIA sessão (`kind`+`tag`+`sessionId`) e regrava com
 * o mesmo `writeJsonSafe` atômico. Existe porque `claim-issue` não tinha
 * inverso: a única forma de soltar uma issue era `end`, que encerra a sessão
 * inteira e solta TODAS — inviável para uma sessão longa que termina uma
 * issue no meio de outras ainda em voo (#6317, evidência 1 do #6168
 * acontecendo de novo).
 *
 * **Só remove da própria sessão — nunca mexe na claim de outra** (mesma
 * disciplina de `releaseMergeLock`, que recusa liberar lock alheio). Não há
 * parâmetro `force`/`sessionId` alheio nesta função de propósito: não existe
 * caso de uso legítimo de uma sessão soltar a claim de outra — isso é
 * responsabilidade de `end` (a sessão dona morreu) ou de staleness
 * (`SOFT_STALE_MS`) destravando sozinha. **O que de fato garante "só a
 * própria sessão"** não é o TIPO de `sessionId` (é `string` crua, igual
 * `claimIssueCheckAndSet`/`registerSession`/`heartbeat` — deliberadamente não
 * branded aqui pra não criar inconsistência nova só neste ponto do módulo) —
 * é `.claude/hooks/inject-session-id.mjs` injetando o `session_id` REAL do
 * payload do harness antes do comando rodar; um chamador que forjasse
 * `--session-id` manualmente contornaria isso, mas nenhum call site
 * documentado faz isso (mesma confiança que todo o resto do módulo deposita
 * na injeção automática).
 *
 * Quatro desfechos, nenhum deles lança:
 * - Sessão do próprio `sessionId`/`tag` NUNCA existiu (arquivo ausente) →
 *   `{ ok: false, reason: "no-op-session-missing" }`.
 * - Arquivo EXISTE mas não pôde ser lido (JSON corrompido/parcial — comum
 *   durante sync do OneDrive) → `{ ok: false, reason: "no-op-unreadable" }`,
 *   com aviso em stderr (`warnUnclaimUnreadable`) — distinto do caso acima de
 *   propósito (#6337 fleet review item 2): a claim pode estar ATIVA no disco,
 *   só momentaneamente ilegível, e reportar "sessão inexistente" faria o
 *   chamador seguir em frente sem soltar nada e sem nenhum sinal de alerta —
 *   exatamente a classe de bug que `outcome: "promotion-failed-unreadable"`
 *   corrigiu em `registerSession` (#6326).
 * - Issue não estava em `claimed_issues` desta sessão → **no-op honesto**,
 *   `{ ok: false, reason: "no-op-not-claimed" }` — nunca finge sucesso (mesmo
 *   padrão que `endSession` adotou no #5797: distinguir "removeu" de "não
 *   havia o que remover", nunca reportar `ok: true` sem uma mudança real de
 *   estado em disco).
 * - Issue estava reivindicada → remove, regrava, `{ ok: true, reason:
 *   "unclaimed" }`.
 *
 * **Não é compare-and-swap** — herda a mesma limitação de lost-update já
 * documentada em `writeJsonSafe` (o beacon escreve neste MESMO arquivo a
 * cada chamada de ferramenta da sessão): entre a leitura e a escrita deste
 * `unclaimIssue`, um write concorrente do beacon pode perder campos. Mesmo
 * risco residual que o resto do módulo aceita nesse arquivo, não uma
 * regressão nova introduzida aqui.
 *
 * **#6481 — mescla com `-safeBackup-*` ANTES de checar `claimed_issues`,
 * mesma disciplina fail-safe do read-path.** Até aqui esta função lia só o
 * arquivo "real" (`readJsonSafe(path)`) — mas `data/sessions/` é uma junction
 * OneDrive, e um write concorrente (tipicamente o beacon batendo heartbeat no
 * MESMO arquivo entre o `claim-issue` e a tentativa de `unclaim-issue`) pode
 * bifurcar o arquivo em cópias de conflito `-safeBackup-N`, deixando o
 * arquivo "real" com uma versão do `claimed_issues` que NÃO inclui a issue
 * que uma cópia de conflito carrega. Sem merge, `unclaimIssue` devolvia
 * `no-op-not-claimed` — indistinguível de "esta sessão nunca reivindicou essa
 * issue" — mesmo com a issue genuinamente presente em disco (achado ao vivo
 * #6481: `unclaim-issue --issue 6431`/`--issue 6459` falharam assim 2× cada,
 * enquanto `list-active` mostrava as duas em `claimed_issues` da mesma
 * sessão). `readMergedRecordForRealFile` é a MESMA primitiva que
 * `registerSession` (#6326) já usa para não perder claim na promoção de
 * kind — reusada aqui, não reimplementada. Quando não há nenhum backup (caso
 * comum), o merge devolve exatamente o conteúdo do arquivo real — nenhuma
 * mudança de comportamento no caminho feliz.
 *
 * **#6567 — a remoção da issue é aplicada a TODOS os arquivos do grupo (real
 * + cada `-safeBackup-*`), não só ao real.** O merge acima resolve a LEITURA
 * (a issue aparece como reivindicada mesmo se só um backup a carrega), mas
 * sem isto a ESCRITA seguinte (`writeJsonSafe(path, ...)`) tocava só o
 * arquivo real — os backups continuavam em disco com `issueNumber` ainda em
 * `claimed_issues`, e como o read-path (`readMergedSessionGroups`) faz a
 * MESMA união real+backups, `is-claimed`/`list-active` seguiam reportando a
 * issue como reivindicada mesmo depois do `unclaim-issue` responder `{ok:
 * true}` — issue permanentemente inelegível até o GC eventualmente varrer o
 * backup (achado ao vivo #6567). Cada backup é reescrito CIRURGICAMENTE (só
 * `claimed_issues`/`claimed_issues_at` daquele próprio arquivo, preservando
 * o resto do seu conteúdo) — nunca sobrescrito com o registro MESCLADO, que
 * poderia introduzir campos de outra cópia num backup que nunca os teve.
 */
export function unclaimIssue(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  issueNumber: number,
  tag: string = machineTag(),
  now: string = new Date().toISOString(),
): UnclaimIssueResult {
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const rawCurrent = readJsonSafe<SessionRecord>(path);
  if (!rawCurrent) {
    if (existsSync(path)) {
      warnUnclaimUnreadable(sessionId, path);
      return { ok: false, reason: "no-op-unreadable" };
    }
    return { ok: false, reason: "no-op-session-missing" };
  }

  // #6481: mescla com eventuais `-safeBackup-*` do MESMO arquivo real antes de
  // checar `claimed_issues` — ver docstring acima. `readMergedRecordForRealFile`
  // nunca devolve `null` aqui porque `rawCurrent` já provou que o arquivo real
  // é legível (ela sempre inclui pelo menos o próprio arquivo real no merge).
  const current = readMergedRecordForRealFile(repoRoot, path) ?? rawCurrent;

  const claimed = current.claimed_issues ?? [];
  if (!claimed.includes(issueNumber)) return { ok: false, reason: "no-op-not-claimed" };

  // #6453 — limpa a entrada correspondente de `claimed_issues_at` junto com a
  // remoção de `claimed_issues`. Sem isto, uma re-reivindicação futura da
  // MESMA issue herda o timestamp da claim ANTERIOR (`claimIssueCheckAndSet`
  // nunca sobrescreve uma chave já presente, #6436) e nasce artificialmente
  // "envelhecida" para `findAgedClaims`/`check-block-staleness.ts` — o falso
  // positivo exato que o gate de staleness existe para evitar.
  const claimedAt = { ...(current.claimed_issues_at ?? {}) };
  delete claimedAt[String(issueNumber)];

  // #6952: CAS em vez de read-modify-write solto — mesmo risco que
  // `claimIssueCheckAndSet`/`grantMergeWindow`.
  writeJsonSafeWithCas(
    path,
    (fresh) => {
      if (!fresh) throw new Error("unclaimIssue: sessão sumiu entre a leitura e a escrita");
      // #6952: a base é o registro MESCLADO do grupo (real + backups), não o
      // arquivo real cru — igual ao `current` calculado fora do lock, e pelo
      // mesmo motivo (#6481: a claim pode existir só num backup).
      //
      // Reler só o arquivo real aqui foi regressão de verdade, pega por
      // `test/session-registry-reconcile-claims.test.ts`: o `unclaimIssue`
      // deixava de trazer as claims que existiam só nos backups, e o registro
      // real saía com MENOS issues do que o grupo tinha antes da operação.
      // "Re-derivar do estado fresco" continua valendo — o que muda é QUAL
      // leitura é a fresca: a do GRUPO, não a de um arquivo do grupo.
      const base = readMergedRecordForRealFile(repoRoot, path) ?? fresh;
      const claimed = base.claimed_issues ?? [];
      const claimedAt = { ...(base.claimed_issues_at ?? {}) };
      delete claimedAt[String(issueNumber)];
      return {
        ...base,
        claimed_issues: claimed.filter((n) => n !== issueNumber),
        claimed_issues_at: claimedAt,
        lastHeartbeat: now,
      };
    },
    (onDisk) =>
      onDisk?.lastHeartbeat === now &&
      !(onDisk?.claimed_issues ?? []).includes(issueNumber),
  );

  // #6567: propaga a remoção a cada `-safeBackup-*` do grupo que ainda carrega
  // a issue — ver docstring acima. Reescrita cirúrgica: só os dois campos de
  // claim daquele backup, nunca o registro mesclado inteiro.
  for (const backupPath of sessionGroupBackupPaths(repoRoot, path)) {
    const backupRecord = readJsonSafe<SessionRecord>(backupPath);
    if (!backupRecord) continue; // backup ilegível/parcialmente sincronizado — GC recolhe depois
    const backupClaimed = backupRecord.claimed_issues ?? [];
    if (!backupClaimed.includes(issueNumber)) continue;
    const backupClaimedAt = { ...(backupRecord.claimed_issues_at ?? {}) };
    delete backupClaimedAt[String(issueNumber)];
    // #6952 (4º review): esta PR promoveu este laço de `writeJsonSafe` (que
    // praticamente nunca lança) pra `writeJsonSafeWithCas` (que PODE exaurir).
    // Sem o try/catch, um backup que exaure interrompe o laço e os SEGUINTES
    // nunca são tentados — assimetria introduzida por esta PR entre dois laços
    // que ela mesma descreve como um modelado no outro (`consumeMergeGrant` já
    // isola cada cópia). A direção de falha é segura (a união favorece "ainda
    // reivindicada" e o retry se autocura), mas parar cedo é gratuito.
    try {
      writeJsonSafeWithCas(
        backupPath,
        (current) => {
          if (!current) throw new Error("unclaimIssue: backup sumiu entre a leitura e a escrita");
          const claimed = current.claimed_issues ?? [];
          const at = { ...(current.claimed_issues_at ?? {}) };
          delete at[String(issueNumber)];
          return {
            ...current,
            claimed_issues: claimed.filter((n) => n !== issueNumber),
            claimed_issues_at: at,
          };
        },
        (onDisk) => !(onDisk?.claimed_issues ?? []).includes(issueNumber),
      );
    } catch {
      // Um backup que falhou não impede limpar os outros. A remoção do
      // arquivo REAL (acima) já aconteceu e é a que manda na leitura; um
      // backup que ainda carregue a issue faz a união preferir "reivindicada",
      // que é a direção segura, e a próxima execução retenta.
    }
  }

  return { ok: true, reason: "unclaimed" };
}

/**
 * Retorna o registro da sessão ATIVA e DIFERENTE de `excludeSessionId` que já
 * reivindicou `issueNumber` — ou `null` se nenhuma outra sessão ativa a
 * reivindicou. Usado pelo coordenador antes de dispatchar um implementador
 * pra uma issue (item 3): "essa issue já está sendo trabalhada por outra
 * sessão ativa agora?".
 */
export function isIssueClaimedByOther(
  repoRoot: string,
  issueNumber: number,
  excludeSessionId: string,
  now: number = Date.now(),
): ActiveSessionRecord | null {
  for (const session of listActiveSessions(repoRoot, now)) {
    if (session.sessionId === excludeSessionId) continue;
    // #7227: lê `claimed_issues_effective` (já resolve a janela de retenção
    // de `claimReleaseMsForKind`) em vez de gatear por `session.stale` +
    // `claimed_issues` bruto. Antes do #7227 as duas coisas coincidiam
    // (`claimed_issues_effective` esvaziava exatamente quando `stale` virava
    // `true`) — desde o #7227 uma sessão `stale: true` pode continuar
    // segurando a issue (ainda dentro de `claimReleaseMsForKind`, "provavelmente
    // ociosa" mas não livre), e gatear por `stale` sozinho voltaria a liberar
    // cedo demais o que este helper existe pra proteger (#5751).
    if (session.claimed_issues_effective.includes(issueNumber)) return session;
  }
  return null;
}

/**
 * #7297 — variante de `isIssueClaimedByOther` acima, mas gateada pela janela
 * CURTA de staleness (`session.stale`/`SOFT_STALE_MS`, 90min), não pela janela
 * de RETENÇÃO de claim (`claimed_issues_effective`/`claimReleaseMsForKind`,
 * 24h pros 3 kinds coordenadores desde o #7227).
 *
 * Existe porque as duas perguntas são genuinamente diferentes, com custos de
 * erro em direções opostas:
 * - `isIssueClaimedByOther` — "alguém ainda pode reivindicar este trabalho
 *   sem roubar de uma sessão viva?" (usada por `claim-issue`/`is-claimed`
 *   antes de uma sessão NOVA pegar uma issue). Errar cedo demais rouba
 *   trabalho de uma sessão viva presa numa chamada lenta (#7194) — por isso
 *   #7227 alargou a janela pra 24h.
 * - Esta função — "esta issue parece estar sendo trabalhada AGORA, ou o
 *   bloqueio (`pulada`/`claimed-por-outra-sessao`) já caducou e merece
 *   reavaliação?" (consumida só por `check-block-staleness.ts`, #6259, cujo
 *   propósito desde a origem é reabrir RÁPIDO — não deixar a rodada ociosa
 *   esperando uma sessão que já não dá sinal de vida). Errar tarde demais
 *   (esperar 24h) desperdiça a fila inteira por até um dia — o oposto do
 *   erro que #7227 existe para evitar.
 *
 * O #7227 desacoplou as duas sem querer: antes dele `isIssueClaimedByOther`
 * já usava `session.stale` diretamente, então `check-block-staleness.ts`
 * herdava a janela de 90min por tabela. Esta função restaura esse
 * comportamento de propósito, como consumidor dedicado — em vez de
 * reacoplar o gate de 24h a esta pergunta, ou (a alternativa descartada)
 * afrouxar `isIssueClaimedByOther` de volta e reabrir o incidente do #7194.
 *
 * Usa `claimed_issues_effective` (não `claimed_issues` bruto) só porque é o
 * campo já computado — quando `!session.stale`, os dois são idênticos por
 * construção (`SOFT_STALE_MS`, 90min, é sempre menor que
 * `claimReleaseMsForKind`, 24h/15min, então uma sessão não-stale nunca teve
 * o claim liberado).
 */
export function isIssueClaimedByActiveSession(
  repoRoot: string,
  issueNumber: number,
  excludeSessionId: string,
  now: number = Date.now(),
): ActiveSessionRecord | null {
  for (const session of listActiveSessions(repoRoot, now)) {
    if (session.sessionId === excludeSessionId) continue;
    if (session.stale) continue;
    if (session.claimed_issues_effective.includes(issueNumber)) return session;
  }
  return null;
}

/**
 * Sessões ATIVAS (não-stale) de um `kind` específico — a pergunta "há uma
 * rodada `/diaria-overnight` acontecendo agora?" respondida de forma
 * determinística, sem o consumidor precisar reimplementar o filtro de
 * staleness sobre `listActiveSessions` (#6277 item 3).
 *
 * Motivação: o `hermes-diaria-continuo` roda de hora em hora e drena a MESMA
 * fila que o overnight. O check-and-set do #6236 fecha a corrida de ESCRITA no
 * claim, mas não evita o desperdício de duas sessões analisarem a mesma fila.
 * Caso real em 260826: a #6232 reivindicada às 11:20 pelo overnight, com
 * subagente já implementando, e às 11:27 pelo contínuo — os DOIS claims
 * sucederam, porque `claimIssue` escrevia só no próprio arquivo sem consultar
 * os das outras sessões (foi esse achado que gerou o #6236/#6242). Hoje a 2ª
 * tentativa é recusada, mas a recusa chega DEPOIS de a sessão já ter lido,
 * classificado e planejado a issue — o trabalho de análise se perde igual. A
 * exclusão precisa acontecer ANTES do claim, e é isso que este helper permite:
 * o tick do contínuo consulta antes de reivindicar issue nova e se limita a
 * processar a própria fila de PRs enquanto houver overnight ativo.
 *
 * Usa `session.stale` (`SOFT_STALE_MS`) diretamente — **não** a janela mais
 * longa de `claimReleaseMsForKind` que `isIssueClaimedByOther` passou a usar
 * desde o #7227 (as duas divergem agora, de propósito: a pergunta aqui é
 * "há uma RODADA deste kind acontecendo?", não "esta issue específica ainda
 * está reivindicada?" — um overnight silencioso há 3h já não conta como
 * "rodada ativa" pro contínuo decidir se pode processar issue nova, mesmo que
 * as claims dele ainda protejam trabalho específico por mais tempo). Sessão
 * com heartbeat morto há mais de `SOFT_STALE_MS` NÃO conta como ativa aqui —
 * um overnight que morreu sem chamar `end` não pode bloquear o contínuo para
 * sempre. Sessões stale saem do retorno principal, mas continuam visíveis via
 * `findStaleSessionsOfKind` para o chamador poder reportá-las.
 *
 * `excludeSessionId` permite a uma sessão perguntar "há OUTRA sessão deste
 * kind?" sem se enxergar (o contínuo consultando por `continuo`, por exemplo).
 *
 * Fail-soft por herança: `listActiveSessions` nunca lança (diretório ausente,
 * JSON corrompido → lista vazia), então este helper também não.
 */
export function findActiveSessionsOfKind(
  repoRoot: string,
  kind: SessionKind,
  excludeSessionId?: string,
  now: number = Date.now(),
): SessionRecord[] {
  return listActiveSessions(repoRoot, now).filter(
    (session) => session.kind === kind && !session.stale && session.sessionId !== excludeSessionId,
  );
}

/**
 * Contraparte de `findActiveSessionsOfKind` — sessões do mesmo `kind` que
 * estão dentro do teto absoluto (`MAX_SESSION_AGE_MS`) mas com heartbeat
 * morto (`stale: true`). Não bloqueiam ninguém; existem para o chamador poder
 * dizer "não há overnight ativo, mas há 1 registro stale de X" em vez de
 * silenciar o registro órfão (mesma disciplina de nunca descartar em silêncio
 * do `warnClockSkew`).
 */
export function findStaleSessionsOfKind(
  repoRoot: string,
  kind: SessionKind,
  excludeSessionId?: string,
  now: number = Date.now(),
): SessionRecord[] {
  return listActiveSessions(repoRoot, now).filter(
    (session) => session.kind === kind && session.stale === true && session.sessionId !== excludeSessionId,
  );
}

/**
 * Predicado booleano sobre `findActiveSessionsOfKind` — o formato que o
 * caminho de decisão do contínuo consome ("há overnight ativo? então não
 * reivindico issue nova neste tick").
 */
export function hasActiveSessionOfKind(
  repoRoot: string,
  kind: SessionKind,
  excludeSessionId?: string,
  now: number = Date.now(),
): boolean {
  return findActiveSessionsOfKind(repoRoot, kind, excludeSessionId, now).length > 0;
}

/**
 * Primitivas de I/O usadas por `acquireMergeLock` — injetáveis pra teste
 * (mesmo padrão de `execFn` em `.claude/hooks/pr-create-review.mjs`). O
 * default (`REAL_MERGE_LOCK_IO`) usa `node:fs` de verdade; testes injetam um
 * "disco" fake em memória pra simular INTERCALAÇÃO real entre duas sessões
 * concorrentes (coisa que chamadas sequenciais dentro de um único processo
 * Node — de propósito single-threaded — não conseguem exercitar sozinhas).
 */
export interface MergeLockIo {
  /**
   * Cria `path` com `data` de forma EXCLUSIVA — só sucede se `path` ainda não
   * existir. Retorna `true` em criação, `false` em `EEXIST` (path já existe).
   * Qualquer outro erro de I/O deve ser relançado (o caller decide).
   */
  tryCreateExclusive: (path: string, data: string) => boolean;
  /** Lê e parseia `path`; `null` em qualquer falha (ausente/corrompido). */
  readCurrent: (path: string) => MergeLockRecord | null;
  /** Sobrescreve `path` com `data`, sem exclusividade. */
  overwrite: (path: string, data: string) => void;
}

const REAL_MERGE_LOCK_IO: MergeLockIo = {
  tryCreateExclusive: (path, data) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw e;
    }
  },
  readCurrent: (path) => readJsonSafe<MergeLockRecord>(path),
  overwrite: (path, data) => writeJsonSafe(path, JSON.parse(data)),
};

/**
 * Limiar de "cadência de heartbeat esperada" pra sinalizar sync cross-máquina
 * potencialmente degradado (#7169) — deliberadamente bem menor que
 * `SOFT_STALE_MS` (90min, sinal de "sessão morta"). O incidente de origem
 * (02/09/2026): `data/sessions/` do `helios` ficou congelado por 1h13
 * (`onedrive.service` morto às 18:37, sem alarme) enquanto uma coordenadora
 * seguia genuinamente ativa lá — 73min < 90min, então o registro dela nunca
 * cruzou `SOFT_STALE_MS` e continuou contando como "ativa" em
 * `listActiveSessions`/`readActiveCoordinatorScan`. O merge lock e o
 * `merge_grant` moram no MESMO diretório sincronizado — se o registro leva
 * 1h+ pra atravessar, os dois levam também, e nada no caminho quente avisava
 * disso.
 *
 * Este limiar não tenta ser preciso sobre a cadência real de heartbeat (não é
 * documentada como constante em lugar nenhum) — só precisa ser um múltiplo
 * generoso dela pra nunca disparar em sync saudável, e ainda assim MUITO
 * menor que `SOFT_STALE_MS` pra dar sinal bem antes da janela de 1h13
 * observada. 10min: heartbeat normal é de minuto a minuto: 10min sem
 * atualização de uma coordenadora que a varredura ainda considera "ativa" (
 * não cruzou `SOFT_STALE_MS`) já é anômalo o bastante pra merecer aviso.
 */
export const CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS = 10 * 60 * 1000;

/**
 * Direção (c) da #7169 — "guard de frescor": não impede nada (o lock
 * continua sendo advisory entre máquinas, #6182, e esta função não muda
 * isso — só torna VISÍVEL um sinal que hoje é mudo), mas transforma o modo
 * de falha SILENCIOSO em RUIDOSO, que é a fatia mais barata recomendada no
 * corpo da issue: "(c) Guard de frescor... degrada para 'não mergeie agora'
 * em vez de mergear cego" — aqui implementado como aviso explícito no
 * caminho de `merge-lock-acquire` (ver o CLI abaixo), não como bloqueio
 * mecânico: um bloqueio duro sobre esta heurística arriscaria false
 * positive em sync genuinamente lento mas vivo, e a decisão de arquitetura
 * mais funda (mover o lock pra um substrato com semântica real — direção
 * (b) da issue) segue em aberto, não decidida.
 *
 * Devolve as sessões COORDENADORAS ativas (`!session.stale`) de OUTRA
 * máquina cujo `lastHeartbeat` está mais velho que
 * `CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS` — candidatas a "sync pode estar
 * degradado, este registro pode não refletir o estado real daquela
 * máquina agora". Sessões da PRÓPRIA máquina nunca entram (leitura local,
 * sem sync no caminho — não há o que avisar).
 *
 * ─── Existe um SEGUNDO detector de sync degradado (#7300) ──────────────
 *
 * `scripts/lib/onedrive-sync-alarm.ts` cobre a mesma classe de falha por
 * outro caminho. Os dois são úteis e NÃO devem ser fundidos — mas quem
 * investigar "o sync estava fora?" precisa saber que há duas fontes, e por
 * que elas podem discordar sobre a mesma janela de tempo:
 *
 * | | esta função | `onedrive-sync-alarm.ts` |
 * |---|---|---|
 * | quando roda | síncrono, no `merge-lock-acquire` | agendado, independente de sessão |
 * | o que observa | `lastHeartbeat` de sessão de OUTRA máquina | `systemctl is-active` + mtime de um canário |
 * | limiar | 10min (`CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS`) | 6h (`--tolerance-hours`, default) |
 * | efeito | aviso no terminal de quem vai mergear | e-mail/issue |
 *
 * **A discordância esperada vem do fator ~36 entre os limiares**, e é
 * assimétrica: uma janela de 20min de sync morto acende ESTE aviso e deixa
 * o alarme em silêncio (ainda dentro da tolerância de 6h). O inverso —
 * alarme aceso e este aviso mudo — acontece quando não há sessão de outra
 * máquina registrada, porque esta função só enxerga sync através de
 * heartbeat alheio: sem peer, ela não tem o que medir.
 *
 * Nenhum dos dois é "o certo": este é sensível e local à decisão de merge;
 * o outro é lento e independente de haver alguém trabalhando. Um silêncio
 * aqui NUNCA é evidência de que o sync está saudável.
 */
export function assessCrossMachineSyncFreshness(
  sessions: readonly ActiveSessionRecord[],
  now: number = Date.now(),
  myMachineTag: string = machineTag(),
): { stale: boolean; staleSessions: ActiveSessionRecord[] } {
  const staleSessions = sessions.filter((session) => {
    if (session.machineTag === myMachineTag) return false;
    if (!isCoordinatorKind(session.kind)) return false;
    if (session.stale) return false; // já é sinalizada por outro caminho (GC-eligible)
    const heartbeatMs = Date.parse(session.lastHeartbeat);
    if (!Number.isFinite(heartbeatMs)) return false; // ilegível — não inventa idade
    const ageMs = now - heartbeatMs;
    if (ageMs < 0) return false; // "no futuro" é clock skew, não sync degradado — não é o sinal que esta função procura
    return ageMs > CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS;
  });
  return { stale: staleSessions.length > 0, staleSessions };
}

/**
 * Adquire o lock global de merge (item 4 do #5156) — serializa `gh pr merge` +
 * `git pull` entre sessões concorrentes (mesma máquina é atômico via
 * `O_EXCL`; entre máquinas via OneDrive o lock é **advisory** — ver o
 * docblock do módulo e o #6182). TTL curto: um lock mais velho que
 * `MERGE_LOCK_TTL_MS` é tratado como abandonado (coordenador crashou
 * segurando o lock) e liberado automaticamente pro próximo adquirente —
 * nunca trava a máquina pra sempre.
 *
 * **#6334 — deixou de ser reentrante para a MESMA sessão.** Até aqui, uma
 * 2ª chamada da mesma `sessionId` enquanto o lock que ELA MESMA segurava
 * ainda estava dentro do TTL só renovava o `acquiredAt` e retornava `true`
 * na hora, sem esperar nada — pensado como "idempotência segura" pro caso
 * sequencial normal (acquire → merge → release, #5156 item 4). O #6299
 * (fan-out em onda) tornou isso perigoso: a MESMA sessão overnight passou a
 * poder ter 2-3 unidades chegando em "pronto pra mergear" ao mesmo tempo, e
 * a reentrância deixava um 2º `gh pr merge` da mesma sessão passar "ao
 * mesmo tempo" que o 1º sem nenhuma serialização real entre eles — quebrando
 * o invariante de "master recebe um squash por vez" (#636) bem no cenário
 * que o lock existe pra proteger. Nenhum caminho de produção hoje chama
 * `acquireMergeLock` uma 2ª vez pela mesma sessão ANTES de liberar a 1ª —
 * `mergeSoloPr`/`mergeTrainBatch` (`scripts/lib/merge-train-live.ts`) sempre
 * fazem acquire→merge→release num único `try/finally`, e o loop de retry por
 * lock negado (`runMergeTrain`) só tenta de novo DEPOIS que essa `finally` já
 * rodou — então blindar a reentrância não regride nenhum fluxo real. Quem
 * precisa genuinamente estender o TTL de um hold que já é seu (operação
 * longa, mesmo lock, nunca liberado) usa `renewMergeLock` — uma função
 * separada, que só aceita renovar o que a própria sessão já detém, nunca
 * concede um hold novo. Ver `test/session-registry.test.ts` (#6334) pros
 * dois caminhos: renovação explícita ✅ vs. 2ª aquisição concorrente ❌.
 *
 * **#5161 fleet review item 1 (CRÍTICO):** a versão anterior fazia
 * read→check→write sem NENHUMA primitiva atômica — duas sessões podiam ler
 * "sem lock" simultaneamente e ambas escreverem, ambas recebendo `true`,
 * quebrando a exclusão mútua NA MESMA MÁQUINA, que é o mínimo esperado
 * deste mecanismo. (O #5161 descrevia esse bug como sendo "o cenário
 * cross-máquina via `data/` OneDrive que o #5156 existe pra proteger" — o
 * #6182 corrigiu essa parte: o fix abaixo resolve a corrida entre processos
 * do MESMO filesystem; entre máquinas o lock segue advisory, e nenhuma das
 * duas partes muda isso.) Fix em duas partes:
 *   1. **Fast path (mesma máquina — nenhuma concorrência com outro inode):**
 *      criação exclusiva atômica (`writeFileSync(path, data, { flag: "wx" })`,
 *      que mapeia pra `O_CREAT | O_EXCL`). Entre processos DIFERENTES no
 *      MESMO kernel/filesystem, no máximo UMA chamada com o MESMO path
 *      ausente pode suceder. **Entre máquinas via OneDrive, NÃO é atômica:**
 *      cada máquina vê um inode distinto no mesmo junction, ambas podem
 *      criar o arquivo e receber `true`. O lock é advisory nesse caso (#6182).
 *      Nenhuma coordenação em memória deste arquivo entra nessa garantia.
 *   2. **Caso raro — lock existe mas expirou (TTL, coordenador crashou):**
 *      plain `fs` não oferece um "substituir só se o conteúdo não mudou
 *      desde que eu li" (compare-and-swap) sem uma lib de lock externa que
 *      este repo não usa. Mitigação: sobrescrever e então RELER
 *      imediatamente pra verificar se a escrita que está no disco agora é
 *      de fato a NOSSA (`heldBy === sessionId`) — se não for, outra sessão
 *      venceu a corrida, retorna `false`. Isto fecha o caso mais comum do
 *      bug original (nenhuma verificação pós-escrita nenhuma — sempre
 *      retornava `true` incondicionalmente). Continua existindo uma janela
 *      residual estreita (o ciclo inteiro de OUTRA sessão completar entre a
 *      nossa PRÓPRIA leitura de decisão e a nossa PRÓPRIA escrita) — dado
 *      que este é o caminho raro (requer um crash prévio E uma corrida bem
 *      no instante de expiração do TTL), a mitigação abaixo é
 *      deliberadamente proporcional ao risco, não uma prova de CAS perfeito.
 *
 * Retorna `true` quando o lock foi adquirido (ninguém o detinha, ou detinha
 * mas já estava STALE — TTL expirado, tratado como abandonado), `false`
 * quando alguém o segura e ainda está dentro do TTL — **inclusive quando
 * esse "alguém" é a PRÓPRIA sessão chamadora** (#6334): uma 2ª chamada da
 * mesma `sessionId` enquanto o hold dela ainda está fresco NÃO é mais
 * reentrante — é tratada como uma tentativa concorrente de aquisição, e
 * falha como qualquer outra. Isso é deliberado: é exatamente o caso que o
 * #6299 tornou possível (mesma sessão com 2-3 merges "prontos" ao mesmo
 * tempo) e que a reentrância antiga deixava passar sem serialização real.
 * Quem precisa estender o TTL de um hold que genuinamente já é seu (nunca
 * liberado, operação mais longa que o TTL) usa `renewMergeLock`, não uma 2ª
 * chamada a esta função.
 */
export function acquireMergeLock(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = MERGE_LOCK_TTL_MS,
  io: MergeLockIo = REAL_MERGE_LOCK_IO,
): boolean {
  const path = mergeLockPath(repoRoot);
  const data = JSON.stringify({ heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord);

  // Fast path: nenhum lock existia — criação exclusiva atômica (ver docblock).
  try {
    if (io.tryCreateExclusive(path, data)) return true;
  } catch {
    // Erro de I/O inesperado (não-EEXIST) — nunca assumir que adquirimos o
    // lock sobre um estado que não conseguimos nem determinar.
    return false;
  }

  const current = io.readCurrent(path);
  if (current) {
    const acquiredMs = Date.parse(current.acquiredAt);
    if (Number.isFinite(acquiredMs)) {
      const ageMs = now - acquiredMs;
      // #5161 item 2: idade negativa (lock "no futuro" pro nosso relógio) NUNCA
      // é tratada como "abandonado" — um clock adiantado em OUTRA máquina não
      // pode fazer um lock genuinamente fresco parecer roubável. Só logamos
      // quando o delta passa da tolerância de jitter normal (potencial skew
      // real entre máquinas, vale investigar); dentro da tolerância é
      // silencioso, é só o lock sendo tratado como fresco mesmo.
      if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) warnClockSkew("acquireMergeLock", `lock de ${current.heldBy}`, ageMs);
      // #6334: este teto vale IGUALMENTE quando `current.heldBy === sessionId`
      // — um hold fresco da própria sessão bloqueia uma 2ª aquisição dela
      // tanto quanto bloquearia a de outra sessão. Ver docblock da função.
      if (ageMs <= ttlMs) return false; // ainda dentro do TTL (com folga de tolerância) — alguém (possivelmente nós mesmos) segura de verdade
    }
    // acquiredAt ilegível (campo corrompido, mas JSON válido) — cai pro
    // tratamento de "stale" abaixo, mesma política de antes.
  }

  // Stale (TTL expirado) ou corrompido/ilegível: contesta. Não-atômico — ver
  // docblock acima pro racional e a janela residual aceita.
  io.overwrite(path, data);
  const verify = io.readCurrent(path);
  return verify?.heldBy === sessionId;
}

/**
 * Estende o TTL de um lock de merge que a PRÓPRIA sessão já detém (#6334) —
 * o caminho correto pra "operação mais longa que o TTL, mesmo hold, nunca
 * liberado", que antes era coberto (incorretamente, ver #6334) pela
 * reentrância de `acquireMergeLock`. Só renova o que a sessão chamadora já
 * segura: `false` se não há lock, ou se o lock pertence a OUTRA sessão —
 * nunca cria um hold novo, nunca rouba lock alheio. Diferente de
 * `acquireMergeLock`, não checa staleness do TTL antes de renovar — se o
 * arquivo ainda diz `heldBy === sessionId`, ninguém mais contestou o lock
 * ainda, então renovar é seguro independente de quanto tempo se passou desde
 * o último `acquiredAt`.
 */
export function renewMergeLock(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
  io: MergeLockIo = REAL_MERGE_LOCK_IO,
): boolean {
  const path = mergeLockPath(repoRoot);
  const current = io.readCurrent(path);
  if (!current || current.heldBy !== sessionId) return false;
  const data = JSON.stringify({ heldBy: sessionId, acquiredAt: new Date(now).toISOString() } satisfies MergeLockRecord);
  io.overwrite(path, data);
  return true;
}

/**
 * Libera o lock de merge. Retorna `true` quando já estava livre ou foi
 * liberado por quem o segurava; `false` quando outra sessão é a dona atual
 * (nunca libera lock alheio por engano).
 */
export function releaseMergeLock(repoRoot: string, sessionId: string): boolean {
  const path = mergeLockPath(repoRoot);
  const current = readJsonSafe<MergeLockRecord>(path);
  if (!current) return true;
  if (current.heldBy !== sessionId) return false;
  if (existsSync(path)) rmSync(path);
  return true;
}

// ─── GC de registros encerrados (#6130) ────────────────────────────────────

/**
 * Janela CONSERVADORA usada quando não é possível confirmar liveness de
 * processo (sessão registrada por OUTRA máquina, ou sem `pid` gravado) — bem
 * maior que qualquer heartbeat esperado (`SOFT_STALE_MS` = 90min,
 * `MAX_SESSION_AGE_MS` = 24h), de propósito: sem sinal de processo, GC por
 * tempo sozinho é chute (ver "Ressalva importante" do #6130 — um registro
 * `stale: true` correspondeu a uma sessão VIVA que só parou de bater
 * heartbeat). 7 dias é a mesma ordem de grandeza do achado ao vivo da issue
 * (arquivo mais velho encontrado tinha 10 dias) — folgado o bastante pra
 * nunca remover algo que ainda pode estar em uso, curto o bastante pra
 * `data/sessions/` não crescer pra sempre.
 */
export const GC_CONSERVATIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Janela conservadora do kind `interactive` (#6168) — 2 horas, contra os 7
 * DIAS dos kinds coordenadores. Sem isto, a Parte B da issue pioraria o
 * problema que ela existe pra resolver: o beacon registra toda sessão
 * interativa automaticamente, e sessão interativa termina sem chamar `end`
 * (não há skill nenhuma pra chamar) — com a janela de 7 dias, `data/sessions/`
 * encheria de registros mortos, cada um segurando as claims dele contra
 * overnight/develop até a staleness resolver.
 *
 * 2h é folgado frente à janela de liveness de 15 min
 * (`INTERACTIVE_SOFT_STALE_MS`) — dá 8× de margem pra uma sessão que só parou
 * de chamar ferramenta por um tempo longo — e curto frente ao dano de um
 * registro órfão. O branch de PID vivo continua vencendo os dois: uma sessão
 * interativa com processo confirmadamente vivo na máquina local nunca é
 * removida, por mais stale que o heartbeat esteja.
 */
export const GC_INTERACTIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Margem de segurança aplicada à janela de liveness do KIND (`SOFT_STALE_MS`/
 * `INTERACTIVE_SOFT_STALE_MS`, via `softStaleMsForKind`) pra decidir remoção
 * de um BACKUP ÓRFÃO — sem arquivo real correspondente (#6595).
 *
 * Por que um limiar distinto da janela conservadora de 7 dias
 * (`GC_CONSERVATIVE_MAX_AGE_MS`): os 7 dias existem pra cobrir a
 * possibilidade de uma sessão estar viva em OUTRA máquina, sem arquivo local
 * pra provar liveness (ver docstring de `GC_CONSERVATIVE_MAX_AGE_MS`). Um
 * backup órfão não tem essa ambiguidade — ausência de arquivo real +
 * heartbeat do backup além da janela de liveness do próprio kind significa que
 * a sessão que o gerou não existe mais, em NENHUMA máquina.
 *
 * **Ressalva do #7002 (a premissa original desta docstring era mais forte do
 * que a realidade):** dizia-se aqui que "por construção, uma sessão viva bate
 * heartbeat no arquivo REAL, nunca só no backup". Isso foi FALSIFICADO ao
 * vivo em 01/09/2026 — o arquivo real de uma coordenadora ativa desapareceu
 * num lost-update sobre o junction OneDrive e as únicas cópias com estado
 * fresco eram os backups. A janela × margem continua correta e o valor não
 * muda; o que não vale mais é o "nunca". Um backup órfão com heartbeat DENTRO
 * da janela pode, sim, ser sessão viva — e é justamente por isso que ele nunca
 * chega a este limiar (branch 1 de `decideSessionGc` o preserva) e que
 * `readMergedSessionGroups` passou a promovê-lo de volta ao read-path. Não é limiar novo/arbitrário:
 * é a mesma janela que `decideSessionGc` já usa pra "claramente ativa"
 * (branch 1), só deixando de ser sobreposta pela janela conservadora no caso
 * em que o conservadorismo não protege nada real.
 *
 * 4× foi escolhido porque ainda deixa folga generosa sobre falhas
 * transitórias de heartbeat (ex: rate limit, hiccup de I/O do OneDrive) sem
 * se aproximar da ordem de grandeza de `GC_CONSERVATIVE_MAX_AGE_MS` — pro
 * kind `overnight` (`SOFT_STALE_MS` = 90min) dá 6h; medição ao vivo do #6595
 * encontrou 27 órfãos `overnight`, o mais novo já 6,5× além dos 90min, então
 * 4× segue conservador mesmo frente ao caso real que motivou a issue.
 */
export const GC_ORPHAN_LIVENESS_MARGIN = 4;

/**
 * Checa se `pid` corresponde a um processo vivo — padrão "kill -0"
 * (`process.kill(pid, 0)` nunca envia sinal de verdade, só testa
 * existência; funciona em POSIX e Windows). `ESRCH` (processo não existe)
 * → `false`; `EPERM` (existe, mas sem permissão de sinalizar) → `true`
 * (existe é o que importa aqui, não permissão); qualquer outro erro →
 * `false` por segurança de INTERPRETAÇÃO (nunca finge "vivo" sobre um erro
 * que não sabemos classificar) — mas ver `decideSessionGc`: um resultado
 * `false` por si só só remove o registro se TAMBÉM estiver na mesma máquina
 * E além de `SOFT_STALE_MS`, nunca por PID sozinho.
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface SessionGcOptions {
  now?: number;
  /** Default `GC_CONSERVATIVE_MAX_AGE_MS`. */
  conservativeMaxAgeMs?: number;
  /** Injetável pra teste — default `defaultIsPidAlive`. */
  isPidAlive?: (pid: number) => boolean;
  /** Default `machineTag()` local. */
  localMachineTag?: string;
}

export type SessionGcAction = "removed" | "kept";

export interface SessionGcResult {
  /** Rótulo legível da identidade avaliada — `{kind}-{machineTag}-{sessionId}`
   * pro grupo ancorado num arquivo real, ou `orphan-backup:{arquivo}` pra um
   * backup sem arquivo real correspondente. */
  identity: string;
  /** Paths ABSOLUTOS de todo arquivo pertencente a esta identidade (arquivo
   * real + backups do grupo, ou só o próprio arquivo pra um órfão). */
  files: string[];
  action: SessionGcAction;
  /** Explicação legível da decisão — sempre populada, inclusive pra `"kept"`
   * (auditabilidade: por que este registro NÃO foi removido). */
  reason: string;
}

/**
 * Árvore de decisão pura (sem I/O) usada tanto pro grupo ancorado num
 * arquivo real quanto pra um backup órfão avaliado sozinho — ver docstring
 * de `planSessionGc`.
 *
 * **Nunca remove por staleness de heartbeat sozinha** (ressalva do #6130):
 *   1. Heartbeat mais recente do grupo dentro de `SOFT_STALE_MS` (90min) →
 *      mantém — claramente ativa.
 *   2. Heartbeat "no futuro" (clock skew) → mantém — nunca trata como
 *      abandonado.
 *   3. Além de `SOFT_STALE_MS`: se ALGUM registro do grupo foi escrito pela
 *      MÁQUINA LOCAL e carrega `pid`, `pid` CONFIRMADO VIVO mantém —
 *      INDEPENDENTE de quão velho o heartbeat esteja (é exatamente o
 *      cenário da ressalva: sessão viva que parou de bater heartbeat).
 *      **`pid` "morto" NÃO remove mais na hora (#6294)** — ver nota abaixo;
 *      cai pro branch 4 junto com "sem pid".
 *   4. Sem sinal de VIVO verificável (máquina diferente, nenhum registro do
 *      grupo tem `pid`, ou `pid` reportado morto) → só remove além da
 *      janela conservadora `conservativeMaxAgeMs` (default 7 dias) — chute
 *      deliberadamente caro de errar pro lado seguro.
 *
 * **#6294 — "`pid` morto → remove na hora" foi RETIRADO do branch 3.**
 * `--pid` é sempre preenchido a partir de `process.ppid` (hook
 * `inject-session-id.mjs` e beacon `session-beacon.mjs`), sob a premissa de
 * que esse é o pid do processo da sessão Claude Code corrente porque o
 * harness spawna o hook/beacon como filho direto dela a cada `PreToolUse`.
 * Medição ao vivo (#6294) CONTRADISSE essa premissa: numa sessão
 * `overnight` demonstravelmente viva (heartbeat fresco, gates de PR
 * rodando), o `pid` gravado já não correspondia a processo nenhum —
 * `process.ppid`, neste harness, aponta pra um processo efêmero que morre
 * quase imediatamente após gravar o registro, não pro processo persistente
 * da sessão. Não há como este módulo (nem o hook/beacon) confirmar a partir
 * do repo se isso é sempre assim ou só numa topologia específica do
 * harness — camada opaca, não verificável daqui. Enquanto essa incerteza
 * não for resolvida, tratar "`pid` morto" como sinal positivo de remoção é
 * a mesma classe de risco que motivou a ressalva do #6130 em primeiro
 * lugar: erra pro lado caro (perde `claimed_issues`/registro de uma sessão
 * genuinamente viva) só pra economizar dias de espera na janela
 * conservadora. `pid` VIVO continua um sinal ÚTIL de manter (falso-positivo
 * de "vivo" — outro processo reaproveitando o mesmo pid — só estende
 * proteção, nunca causa remoção indevida); `pid` morto deixou de ser um
 * sinal confiável de remoção e por isso não empurra mais o veredito sozinho
 * — some no branch 4, exatamente como "sem pid".
 *
 * **Limitação do #6130 fechada pelo #6160:** o branch 3 (PID vivo protege
 * incondicionalmente) era alcançável só pro kind `continuo` — `overnight`/
 * `develop` chamavam `register --kind {overnight|develop}` SEM `--pid` (e
 * nenhum dos dois chama `heartbeat`), colapsando a árvore inteira no branch
 * 4 pra eles. Fechado sem exigir mudança nas skills: `.claude/hooks/
 * inject-session-id.mjs` (o mesmo hook que já injeta `--session-id`
 * automaticamente, #5156) agora também injeta `--pid {process.ppid}` em
 * toda chamada standalone de `register` sem a flag — `process.ppid` do
 * hook É o PID da sessão Claude Code corrente, porque o harness spawna o
 * hook como filho direto dela a cada `PreToolUse`. `overnight`/`develop`
 * ainda nunca chamam `heartbeat` DIRETAMENTE — mas **isto não significa
 * `lastHeartbeat === startedAt` a sessão inteira** (correção do #6327: o
 * texto desta seção, até aqui, afirmava exatamente isso, e a medição ao vivo
 * mostrou o oposto — ver a docstring de `heartbeat` acima pro mecanismo
 * completo). Na prática o branch 3 (PID vivo) raramente chega a ser
 * exercitado pra esses 2 kinds porque o branch 1 (heartbeat recente) já
 * resolve primeiro — o beacon mantém `lastHeartbeat` fresco o tempo todo que
 * a sessão está ativa chamando QUALQUER ferramenta, então o branch 3
 * continua existindo como rede de segurança (heartbeat MESMO ASSIM stale —
 * beacon desligado, worktree vinculado, `data/` ausente), não como o
 * caminho comum que este texto descrevia antes — e é nesse caminho de rede
 * de segurança que a checagem de `pid` continua rodando independente de
 * quão stale o heartbeat esteja (só que, desde #6294, só o lado VIVO desse
 * branch pesa sozinho na decisão — "pid morto" não é mais sinal positivo de
 * remoção, ver docstring de `decideSessionGc` abaixo).
 *
 * **`isOrphan` (#6595)** — quando `true` (backup sem arquivo real
 * correspondente), a janela final do branch 4 deixa de ser
 * `conservativeMaxAgeMs` (7 dias, pensada pra "pode estar viva em outra
 * máquina") e passa a ser `softStaleMsForKind(kind) * GC_ORPHAN_LIVENESS_MARGIN`
 * — ver docstring de `GC_ORPHAN_LIVENESS_MARGIN` pro porquê. Sessão COM
 * arquivo real (`isOrphan` ausente/`false`) não muda: os 7 dias continuam
 * valendo integralmente, inclusive pro branch 3 (PID vivo), que nenhum dos
 * dois casos altera.
 */
function decideSessionGc(
  records: readonly SessionRecord[],
  now: number,
  conservativeMaxAgeMs: number,
  isPidAlive: (pid: number) => boolean,
  localTag: string,
  isOrphan = false,
): { action: SessionGcAction; reason: string } {
  let maxHeartbeatMs = -Infinity;
  for (const r of records) {
    const hb = Date.parse(r.lastHeartbeat ?? r.startedAt ?? "");
    if (Number.isFinite(hb) && hb > maxHeartbeatMs) maxHeartbeatMs = hb;
  }
  if (!Number.isFinite(maxHeartbeatMs)) {
    return { action: "kept", reason: "timestamp ilegível em todos os arquivos do grupo — GC nunca remove sem sinal de idade confiável" };
  }

  // #6168: janela de liveness E janela conservadora são POR KIND —
  // `interactive` usa as suas, bem menores, porque nasce do beacon
  // automático e nunca chama `end` (ver INTERACTIVE_SOFT_STALE_MS /
  // GC_INTERACTIVE_MAX_AGE_MS). Kind ausente/desconhecido cai nos valores
  // dos coordenadores, que são os conservadores — nunca remove mais cedo
  // sobre um registro que não se conseguiu classificar.
  const groupKind = records[0]?.kind ?? "";
  const softStaleMs = softStaleMsForKind(groupKind);
  // #6595: órfão (sem arquivo real) usa a janela de liveness do próprio
  // kind × margem, não a janela conservadora de 7 dias — ver docstring de
  // `GC_ORPHAN_LIVENESS_MARGIN`. Sessão ancorada num arquivo real
  // (`isOrphan === false`) preserva o comportamento anterior sem alteração.
  // Restrito a `kind` CONHECIDO (`ALL_SESSION_KINDS`) — igual ao comentário
  // acima sobre kind ausente/desconhecido: um `kind` que este módulo não
  // reconhece não pode se beneficiar da janela mais curta (achado do review
  // do #6595 — sem essa guarda, um registro corrompido/futuro com `kind`
  // vazio cairia em `softStaleMsForKind("") = SOFT_STALE_MS` × margem em vez
  // da janela conservadora, o oposto do "nunca remove mais cedo sobre um
  // registro que não se conseguiu classificar").
  const isKnownKind = (ALL_SESSION_KINDS as readonly string[]).includes(groupKind);
  const effectiveMaxAgeMs =
    isOrphan && isKnownKind
      ? softStaleMs * GC_ORPHAN_LIVENESS_MARGIN
      : groupKind === "interactive"
        ? Math.min(conservativeMaxAgeMs, GC_INTERACTIVE_MAX_AGE_MS)
        : conservativeMaxAgeMs;

  const ageMs = now - maxHeartbeatMs;
  if (ageMs < 0) {
    return { action: "kept", reason: "heartbeat no futuro (possível clock skew) — nunca tratado como abandonado" };
  }
  if (ageMs <= softStaleMs) {
    return {
      action: "kept",
      reason:
        `heartbeat recente (${Math.round(ageMs / 60000)}min, dentro da janela de liveness de ` +
        `${Math.round(softStaleMs / 60000)}min pro kind "${groupKind || "desconhecido"}") — sessão claramente ativa`,
    };
  }

  // #6294: só o lado VIVO deste branch decide sozinho. `pid` reportado
  // MORTO não é mais tratado como sinal positivo de remoção — a fonte do
  // pid (`process.ppid`, ver docstring acima) foi medida ao vivo gravando
  // o pid de um processo efêmero, não o da sessão real, então "morto" aqui
  // pode só significar "a fonte estava errada", nunca "a sessão acabou".
  // Cai pro branch 4 (janela conservadora), igual a "sem pid".
  for (const r of records) {
    if (r.machineTag === localTag && typeof r.pid === "number" && isPidAlive(r.pid)) {
      return {
        action: "kept",
        reason:
          `heartbeat stale (${Math.round(ageMs / 60000)}min) mas processo pid=${r.pid} confirmado VIVO na máquina ` +
          `local (${localTag}) — nunca remove registro de sessão viva (ressalva #6130)`,
      };
    }
  }

  const orphanWindowApplies = isOrphan && isKnownKind;

  if (ageMs > effectiveMaxAgeMs) {
    if (orphanWindowApplies) {
      // #6595 + #7002: `claimed_issues` deste órfão não fazem parte da união
      // que `isIssueClaimedByOther`/`listActiveSessions`/Triagem leem — não
      // porque órfão nunca entre no read-path (desde o #7002 ele ENTRA, se o
      // grupo ainda parecer vivo), mas porque este branch só é alcançado
      // muito DEPOIS disso: aqui o heartbeat já passou de
      // `GC_ORPHAN_LIVENESS_MARGIN`× a janela de liveness do kind, então
      // `isOrphanBackupGroupLive` já respondia `false` havia bastante tempo.
      // Não é isso que a remoção "libera": o que muda é só a existência EM
      // DISCO destes números, pra qualquer consumidor que leia
      // `data/sessions/` diretamente, sem passar pela união.
      const claimedIssues = Array.from(new Set(records.flatMap((r) => r.claimed_issues ?? []))).sort((a, b) => a - b);
      const claimsNote =
        claimedIssues.length > 0
          ? ` — leva junto ${claimedIssues.length} claim(s) que estavam registrados neste arquivo órfão: #${claimedIssues.join(", #")}`
          : " — sem claimed_issues";
      return {
        action: "removed",
        reason:
          `#6595: backup ÓRFÃO (sem arquivo real correspondente) — heartbeat stale há ${Math.round(ageMs / 60_000)}min, ` +
          `além de ${GC_ORPHAN_LIVENESS_MARGIN}× a janela de liveness do kind "${groupKind || "desconhecido"}" ` +
          `(${Math.round(softStaleMs / 60_000)}min × ${GC_ORPHAN_LIVENESS_MARGIN} = ${Math.round(effectiveMaxAgeMs / 60_000)}min). ` +
          "Sem arquivo real E sem heartbeat dentro da janela de liveness, não há sessão viva por trás (#7002: o " +
          "backup órfão RECENTE pode ser sessão viva que perdeu a âncora, e por isso é preservado no branch 1 e " +
          "promovido no read-path — este aqui já passou muito dessa janela) — removível sem o conservadorismo de " +
          `7 dias, que só se justifica quando o real pode existir noutra máquina${claimsNote}`,
      };
    }
    return {
      action: "removed",
      reason:
        `heartbeat stale há ${Math.round(ageMs / 60_000)}min, sem sinal de processo VIVO verificável ` +
        `(máquina diferente, sem pid registrado, ou pid reportado morto — #6294: um pid "morto" não é mais ` +
        `tratado como sinal de remoção, a fonte não é confiável o suficiente) — além da janela conservadora de ` +
        `${Math.round(effectiveMaxAgeMs / 60_000)}min pro kind "${groupKind || "desconhecido"}"`,
    };
  }
  return {
    action: "kept",
    reason: orphanWindowApplies
      ? `#6595: backup ÓRFÃO com heartbeat stale (${Math.round(ageMs / 60000)}min) mas ainda dentro da janela de ` +
        `liveness do kind × ${GC_ORPHAN_LIVENESS_MARGIN} (${Math.round(effectiveMaxAgeMs / 60_000)}min pro kind ` +
        `"${groupKind || "desconhecido"}") — GC não arrisca remover cedo demais`
      : isOrphan
        ? `backup ÓRFÃO de kind não reconhecido ("${groupKind || "desconhecido"}") — cai na janela conservadora ` +
          "por segurança de interpretação, mesmo sendo órfão (#6595: só kind conhecido usa a janela mais curta)"
        : `heartbeat stale (${Math.round(ageMs / 60000)}min) mas sem sinal de processo VIVO verificável e ainda dentro ` +
          "da janela conservadora — GC não arrisca remover sessão que pode estar viva",
  };
}

/**
 * Plano PURO (sem tocar disco) de GC de `data/sessions/` (#6130) — avalia
 * todo grupo ancorado num arquivo real (arquivo real + seus backups, ver
 * `readMergedSessionGroups`) e todo backup ÓRFÃO (sem arquivo real
 * correspondente — o caso canônico de "sessão encerrada, sobrou o
 * straggler") via `decideSessionGc`. Arquivo(s) ilegível(is)/corrompido(s)
 * nunca são removidos (mantém por segurança de interpretação — GC nunca
 * remove estado que não consegue entender).
 */
export function planSessionGc(repoRoot: string, opts: SessionGcOptions = {}): SessionGcResult[] {
  const now = opts.now ?? Date.now();
  const conservativeMaxAgeMs = opts.conservativeMaxAgeMs ?? GC_CONSERVATIVE_MAX_AGE_MS;
  // #6130 (achado do fleet review, P2): a validação de positividade existia
  // só no parser da CLI (`main()`, case "gc") — um caller programático
  // passando 0/negativo/NaN derrubava em silêncio a janela conservadora que
  // é a rede de segurança inteira do branch 4 de `decideSessionGc` (sem
  // sinal de processo verificável). Falha alto e cedo em vez de degradar.
  if (!Number.isFinite(conservativeMaxAgeMs) || conservativeMaxAgeMs <= 0) {
    throw new Error(
      `planSessionGc: conservativeMaxAgeMs precisa ser finito e positivo (recebido: ${conservativeMaxAgeMs})`,
    );
  }
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const localTag = opts.localMachineTag ?? machineTag();

  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !n.includes("-safeBackup-"));
  const backupNames = names.filter((n) => n.includes("-safeBackup-"));
  const realStems = realNames.map((n) => n.slice(0, -".json".length)).sort((a, b) => b.length - a.length);

  const backupsByRealStem = new Map<string, string[]>();
  const orphanBackups: string[] = [];
  for (const backup of backupNames) {
    const matchStem = realStems.find((stem) => backup.startsWith(`${stem}-`));
    if (matchStem) {
      const list = backupsByRealStem.get(matchStem) ?? [];
      list.push(backup);
      backupsByRealStem.set(matchStem, list);
    } else {
      orphanBackups.push(backup);
    }
  }

  const results: SessionGcResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const groupNames = [realName, ...(backupsByRealStem.get(stem) ?? [])];
    const groupPaths = groupNames.map((n) => join(dir, n));
    const records = groupNames
      .map((n) => readJsonSafe<SessionRecord>(join(dir, n)))
      .filter((r): r is SessionRecord => r !== null && !!r.sessionId && !!r.kind);
    if (records.length === 0) {
      results.push({
        identity: stem,
        files: groupPaths,
        action: "kept",
        reason: "arquivo(s) ilegível(is)/corrompido(s) — GC nunca remove estado que não consegue interpretar",
      });
      continue;
    }
    const decision = decideSessionGc(records, now, conservativeMaxAgeMs, isPidAlive, localTag);
    results.push({
      identity: `${records[0]!.kind}-${records[0]!.machineTag}-${records[0]!.sessionId}`,
      files: groupPaths,
      ...decision,
    });
  }

  for (const backup of orphanBackups) {
    const path = join(dir, backup);
    const record = readJsonSafe<SessionRecord>(path);
    if (!record) {
      results.push({
        identity: `orphan-backup:${backup}`,
        files: [path],
        action: "kept",
        reason: "backup órfão ilegível/corrompido — GC nunca remove estado que não consegue interpretar",
      });
      continue;
    }
    const decision = decideSessionGc([record], now, conservativeMaxAgeMs, isPidAlive, localTag, /* isOrphan */ true);
    results.push({ identity: `orphan-backup:${backup}`, files: [path], ...decision });
  }

  return results;
}

/**
 * Aplica `planSessionGc` — remove (best-effort, `rmSync` por arquivo, nunca
 * lança) todo arquivo de todo grupo com `action: "removed"`. Fail-soft por
 * arquivo: se um `rmSync` individual falhar (ex: I/O transitório do
 * OneDrive), os demais arquivos do plano continuam sendo processados — a
 * próxima execução retenta o que sobrou.
 *
 * #6624: quando o grupo removido tem ARQUIVO REAL coordenador (não é
 * `orphan-backup:*` — esse é resíduo de uma sessão que já chamou `end`
 * corretamente) e `kind` está em `COORDINATOR_SESSION_KINDS`, registra
 * `"gc-removed-without-end"` no log de ciclo de vida — é o sinal direto de
 * "esta sessão nunca chamou `end`", a pergunta que a issue faz.
 */
export function garbageCollectSessions(repoRoot: string, opts: SessionGcOptions = {}): SessionGcResult[] {
  const plan = planSessionGc(repoRoot, opts);
  const now = opts.now ?? Date.now();
  for (const entry of plan) {
    if (entry.action !== "removed") continue;
    // #6624: lê o record ANTES de remover, só pra grupos coordenadores com
    // arquivo real (identity sem o prefixo "orphan-backup:") — instrumentação,
    // nunca afeta a decisão de remoção em si.
    const isOrphanGroup = entry.identity.startsWith("orphan-backup:");
    let lifecycleRecord: SessionRecord | null = null;
    if (!isOrphanGroup) {
      const realFile = entry.files.find((f) => !f.includes("-safeBackup-"));
      lifecycleRecord = realFile ? readJsonSafe<SessionRecord>(realFile) : null;
    }
    // #6130 (achado HIGH do fleet review): antes disto, uma falha de rmSync
    // era engolida em silêncio E a entry continuava reportando "removed" —
    // o operador via "removido" no output do CLI mesmo com o arquivo ainda
    // no disco. Agora: loga a falha (mesmo padrão de `warnIoError`) e
    // rebaixa a entry pra "kept" quando pelo menos 1 arquivo do grupo não
    // foi confirmadamente removido — próxima execução do GC retenta.
    let allRemoved = true;
    for (const file of entry.files) {
      try {
        if (existsSync(file)) rmSync(file);
        if (existsSync(file)) allRemoved = false; // rmSync "teve sucesso" mas o arquivo persiste (raro, ex: lock de outro processo)
      } catch (e) {
        allRemoved = false;
        warnIoError(file, e);
      }
    }
    if (!allRemoved) {
      entry.action = "kept";
      entry.reason = `${entry.reason} [remoção falhou parcialmente — reportado como "kept", próxima execução retenta]`;
      continue;
    }
    if (lifecycleRecord && isCoordinatorKind(lifecycleRecord.kind)) {
      const startedMs = Date.parse(lifecycleRecord.startedAt ?? "");
      logSessionLifecycleEvent(repoRoot, {
        event: "gc-removed-without-end",
        kind: lifecycleRecord.kind,
        machineTag: lifecycleRecord.machineTag,
        sessionId: lifecycleRecord.sessionId,
        ts: new Date(now).toISOString(),
        ageMs: Number.isFinite(startedMs) ? now - startedMs : undefined,
      });
    }
  }
  return plan;
}

// ─── Reconciliação de claims presos em backup (#6581) ──────────────────────
//
// O #6567 (PR #6571) consertou o WRITE-path de `unclaimIssue`: a remoção de
// uma issue passou a propagar para todos os `-safeBackup-*` do grupo, não só
// o arquivo real. Isso impede o problema de CRESCER dali pra frente, mas não
// tocou o ESTOQUE anterior — um claim que só sobrevive num backup porque o
// arquivo REAL ainda existe mas divergiu (escrita pré-#6567 que só tocou o
// real, deixando um `-safeBackup-*` mais antigo/bifurcado com issues que o
// real nunca chegou a carregar) fica preso: o read-path
// (`readMergedSessionGroups`/`mergeSessionRecords`) continua reportando a
// issue como reivindicada via união fail-safe, mesmo sem nenhuma escrita
// pendente que a resolva. **Isto é distinto do caso "sessão encerrou e o
// arquivo real foi removido"** (`endSession`/GC) — aí o backup fica ÓRFÃO,
// não faz parte de grupo nenhum, e este reconciliador explicitamente não o
// toca (ver "Por que backup órfão... nunca vira arquivo real novo" no CLI).
// `planClaimReconciliation`/`reconcileClaims` fecham o caso do real ainda
// vivo: para cada grupo (arquivo real + seus `-safeBackup-*`), a união de
// `claimed_issues` é calculada e gravada de volta no arquivo REAL. Isso não
// muda quando o GC pode remover os backups — `planSessionGc`/`decideSessionGc`
// decidem por liveness do GRUPO (heartbeat/pid), nunca por `claimed_issues`,
// e removem real+backups sempre juntos, atomicamente; o benefício real desta
// reconciliação é o arquivo real virar a fonte de verdade AUTOSSUFICIENTE da
// claim (não depende mais de nenhum backup sobreviver) — não "destravar" o GC.

export type ClaimReconciliationAction =
  | "reconciled"
  | "no-change"
  | "skipped-unreadable-real"
  | "orphan-backups-only"
  | "write-failed";

export interface ClaimReconciliationResult {
  /** `{kind}-{tag}-{sessionId}` (stem do arquivo real) pro grupo ancorado num
   * real, ou `orphan-backup:{arquivo}` pra um backup sem real correspondente. */
  identity: string;
  /** Path absoluto do arquivo real do grupo — `null` só pra `orphan-backups-only`. */
  realPath: string | null;
  /** Paths absolutos de todo `-safeBackup-*` do grupo (ou o próprio arquivo,
   * pra um órfão). */
  backupPaths: string[];
  /** Issues presentes em algum backup do grupo mas ausentes do real —
   * ADICIONADAS ao real quando `action === "reconciled"`. Nunca uma remoção. */
  addedIssues: number[];
  /** Entradas NOVAS de `claimed_issues_at` a mesclar (só para `addedIssues`) —
   * usado por `reconcileClaims` na escrita; nunca sobrescreve uma entrada já
   * existente no real. Vazio quando `addedIssues` é vazio. */
  addedClaimedIssuesAt: Record<string, string>;
  /** Quantos `-safeBackup-*` do grupo estavam ilegíveis/corrompidos e por isso
   * ficaram de fora da união — as claims deles, se houver, ficam
   * irrecuperáveis por esta reconciliação (não é erro nem bloqueia o resto do
   * grupo, mas é informação que o CLI agrega no resumo final). */
  unreadableBackupCount: number;
  action: ClaimReconciliationAction;
  /** Explicação legível — sempre populada, inclusive pra `"no-change"`
   * (auditabilidade, mesmo padrão de `SessionGcResult.reason`). */
  reason: string;
}

export interface ClaimReconciliationDecision {
  /** Issues presentes em algum backup mas ausentes do real — a acrescentar
   * (união fail-safe, nunca remoção — mesma direção do read-path #6130 e do
   * write-path de `unclaimIssue` #6567). Ordenadas. */
  addedIssues: number[];
  /** Entradas NOVAS de `claimed_issues_at` (só para `addedIssues`) — nunca
   * sobrescreve uma entrada já existente no real. */
  addedClaimedIssuesAt: Record<string, string>;
}

/**
 * Decisão PURA (sem I/O) de reconciliação de um único grupo: dado o registro
 * REAL e os registros LEGÍVEIS de seus `-safeBackup-*` (backup ilegível já
 * deve ter sido filtrado pelo chamador — não participa da união, mas também
 * não bloqueia o resto do grupo), calcula o que FALTA no real via a mesma
 * primitiva de união do read-path (`mergeSessionRecords`).
 *
 * **#6698 — nunca ressuscita uma claim já removida por um `unclaimIssue`
 * PRÉ-#6567.** Antes desta mudança, esta função era unidirecional puro: TUDO
 * que sobrava só em backup virava `addedIssues`, sem distinguir dois cenários
 * que produzem exatamente a mesma forma em disco (issue presente no backup,
 * ausente do real):
 *   (a) claim genuinamente viva que só sobreviveu no backup (escrita
 *       concorrente do OneDrive perdeu a issue no real) — ressuscitar é
 *       correto, é o caso que o #6581 existe pra resolver;
 *   (b) claim já removida de propósito por um `unclaimIssue` ANTERIOR ao
 *       #6567 (que só tocava o arquivo real, deixando o backup com um
 *       resíduo da issue) — ressuscitar aqui é um BUG: a #6581 devolve ao
 *       real uma claim que o dono já soltou.
 *
 * Distinção usada (a mesma sugerida na issue): uma issue só é adicionada
 * quando `claimed_issues_at` do BACKUP para aquela issue existe E é
 * POSTERIOR ao `lastHeartbeat` do real — evidência de que o REAL ficou pra
 * trás (não recebeu uma escrita que já aconteceu depois da claim), não de que
 * o backup preserva algo que o real removeu de propósito depois. Sem essa
 * evidência (timestamp ausente — claim anterior ao #6436, quando
 * `claimed_issues_at` passou a existir — ou timestamp mais antigo/igual ao
 * heartbeat do real, sinal de que o real teve chance de refletir a claim e
 * genuinamente não a tem), cai no comportamento ANTERIOR — adiciona mesmo
 * assim — porque não há como comprovar a hipótese (b) sem o timestamp:
 * suprimir a adição sem essa evidência trocaria o bug conhecido do #6698 por
 * outro (claim (a) genuína nunca reconciliada, o próprio motivo do #6581).
 */
export function decideClaimReconciliation(
  realRecord: SessionRecord,
  backupRecords: readonly SessionRecord[],
): ClaimReconciliationDecision {
  if (backupRecords.length === 0) return { addedIssues: [], addedClaimedIssuesAt: {} };
  const merged = mergeSessionRecords([realRecord, ...backupRecords]);
  const currentClaimed = new Set(realRecord.claimed_issues ?? []);
  const realHeartbeatMs = Date.parse(realRecord.lastHeartbeat ?? realRecord.startedAt ?? "");
  const candidateIssues = (merged.claimed_issues ?? []).filter((n) => !currentClaimed.has(n)).sort((a, b) => a - b);

  const addedIssues: number[] = [];
  const addedClaimedIssuesAt: Record<string, string> = {};
  for (const issue of candidateIssues) {
    const at = merged.claimed_issues_at?.[String(issue)];
    const atMs = at ? Date.parse(at) : NaN;
    // #6698: com evidência de timestamp disponível (`at` presente e parseável
    // + heartbeat do real parseável), só ressuscita quando o backup é
    // POSTERIOR ao real — nunca quando é anterior/igual (evidência de remoção
    // deliberada pré-#6567). Sem evidência (qualquer um dos dois lados
    // ilegível/ausente), preserva o comportamento anterior: adiciona.
    if (at && Number.isFinite(atMs) && Number.isFinite(realHeartbeatMs) && atMs <= realHeartbeatMs) continue;
    addedIssues.push(issue);
    if (at) addedClaimedIssuesAt[String(issue)] = at;
  }
  return { addedIssues, addedClaimedIssuesAt };
}

/**
 * Plano PURO (não escreve nada — só lê) de reconciliação de `data/sessions/`
 * (#6581): agrupa real+backups via `groupBackupsByRealStem` (mesma primitiva
 * do read-path, reusada aqui em vez de reimplementada) e roda
 * `decideClaimReconciliation` por grupo. Backup ÓRFÃO (sem arquivo real
 * correspondente) nunca vira arquivo real novo — só é reportado com action
 * `"orphan-backups-only"`; quem decide o destino dele é o GC, com os
 * critérios de liveness dele (`planSessionGc`), não este reconciliador.
 * Arquivo real ilegível/corrompido nunca é sobrescrito (`"skipped-unreadable-real"`)
 * — fail-soft, mesma disciplina de `planSessionGc` sobre registro ilegível.
 */
export function planClaimReconciliation(repoRoot: string): ClaimReconciliationResult[] {
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !n.includes("-safeBackup-")).sort();
  const backupsByRealStem = groupBackupsByRealStem(names);
  const claimedBackupNames = new Set<string>();
  const results: ClaimReconciliationResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const backupNames = (backupsByRealStem.get(stem) ?? []).sort();
    for (const b of backupNames) claimedBackupNames.add(b);
    const realPath = join(dir, realName);
    const backupPaths = backupNames.map((n) => join(dir, n));

    const realRecord = readJsonSafe<SessionRecord>(realPath);
    if (!realRecord) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        addedIssues: [],
        addedClaimedIssuesAt: {},
        unreadableBackupCount: 0,
        action: "skipped-unreadable-real",
        reason: "arquivo real ilegível/corrompido — grupo pulado (fail-soft: nunca escreve por cima do que não conseguiu entender)",
      });
      continue;
    }

    const backupRecords: SessionRecord[] = [];
    let unreadableCount = 0;
    for (const b of backupNames) {
      const r = readJsonSafe<SessionRecord>(join(dir, b));
      if (r) backupRecords.push(r);
      else unreadableCount++;
    }

    const { addedIssues, addedClaimedIssuesAt } = decideClaimReconciliation(realRecord, backupRecords);
    const unreadableNote = unreadableCount > 0 ? ` (${unreadableCount} backup(s) ilegível(is) do grupo ignorado(s))` : "";
    results.push({
      identity: stem,
      realPath,
      backupPaths,
      addedIssues,
      addedClaimedIssuesAt,
      unreadableBackupCount: unreadableCount,
      action: addedIssues.length > 0 ? "reconciled" : "no-change",
      reason:
        addedIssues.length > 0
          ? `${addedIssues.length} claim(s) presos em backup — issue(s) [${addedIssues.join(", ")}]${unreadableNote}`
          : `nenhum claim exclusivo de backup${unreadableNote}`,
    });
  }

  const orphanBackups = names.filter((n) => n.includes("-safeBackup-") && !claimedBackupNames.has(n)).sort();
  for (const orphan of orphanBackups) {
    results.push({
      identity: `orphan-backup:${orphan}`,
      realPath: null,
      backupPaths: [join(dir, orphan)],
      addedIssues: [],
      addedClaimedIssuesAt: {},
      unreadableBackupCount: 0,
      action: "orphan-backups-only",
      reason:
        "backup sem arquivo real correspondente — nunca cria arquivo real do zero pra reconciliar (decisão #6581); " +
        "o GC (`planSessionGc`) decide o destino dele com os critérios de liveness dele",
    });
  }

  return results;
}

/**
 * Aplica `planClaimReconciliation` de fato: para cada grupo com
 * `action === "reconciled"`, RELÊ tanto o arquivo real quanto cada backup do
 * grupo (podem ter mudado entre o plano e a escrita — mesma corrida que
 * `writeJsonSafe` já aceita em todo o resto do módulo) e RECOMPUTA
 * `decideClaimReconciliation` contra esse estado FRESCO, em vez de reaplicar
 * o `addedIssues` congelado no plano.
 *
 * **Por que recomputar em vez de reusar o plano (achado do fleet review do
 * #6583, confirmado por 3 revisores independentes):** se `entry.addedIssues`
 * do plano fosse aplicado cegamente sobre o `current` relido, uma issue que
 * foi LEGITIMAMENTE removida via `unclaimIssue` no intervalo entre o plano e
 * esta escrita (unclaim já propaga pra backups desde #6567, mas isso não
 * ajuda aqui — o `addedIssues` já tinha sido calculado ANTES da remoção)
 * seria silenciosamente re-adicionada — o próprio script de limpeza
 * ressuscitando uma claim que acabara de ser corretamente encerrada.
 * Recomputar contra o par (real, backups) lido NESTE instante fecha essa
 * janela: se a issue já não aparece em nenhum backup (ou já está no real),
 * `decideClaimReconciliation` simplesmente não a inclui em `addedIssues` de
 * novo, e o grupo vira `"no-change"` sem nenhuma escrita.
 *
 * Escreve só `claimed_issues`/`claimed_issues_at` sobre o `current` ATUAL —
 * nunca sobrescreve com o registro MESCLADO inteiro (que poderia introduzir
 * campos de um backup que o real nunca teve, mesma disciplina cirúrgica de
 * `unclaimIssue` #6567). Escrita atômica (`writeJsonSafe` → `writeFileAtomic`).
 * Nunca remove nenhum backup — quem remove é o GC. Falha de escrita (I/O
 * transitório do OneDrive) rebaixa a entry pra `"write-failed"` — DISTINTO de
 * `"no-change"` (que significa "nada a fazer", não "tentou e não conseguiu")
 * — com o motivo anexado; mesmo espírito de `garbageCollectSessions`
 * rebaixar pra `"kept"` em falha, mas com uma action própria em vez de
 * reusar o valor do caminho feliz — a próxima execução retenta.
 */
export function reconcileClaims(repoRoot: string): ClaimReconciliationResult[] {
  const plan = planClaimReconciliation(repoRoot);
  for (const entry of plan) {
    if (entry.action !== "reconciled" || !entry.realPath) continue;

    const current = readJsonSafe<SessionRecord>(entry.realPath);
    if (!current) {
      entry.action = "skipped-unreadable-real";
      entry.reason = `${entry.reason} [ficou ilegível entre o plano e a escrita — pulado, próxima execução retenta]`;
      continue;
    }

    const freshBackupRecords: SessionRecord[] = [];
    for (const backupPath of entry.backupPaths) {
      const r = readJsonSafe<SessionRecord>(backupPath);
      if (r) freshBackupRecords.push(r);
    }
    const fresh = decideClaimReconciliation(current, freshBackupRecords);
    entry.addedIssues = fresh.addedIssues;
    entry.addedClaimedIssuesAt = fresh.addedClaimedIssuesAt;

    if (fresh.addedIssues.length === 0) {
      entry.action = "no-change";
      entry.reason = `${entry.reason} [nada a adicionar contra o estado relido no momento da escrita — provavelmente já reconciliado, ou a claim foi legitimamente removida entre o plano e a escrita]`;
      continue;
    }

    try {
      // #6952: CAS em vez de read-modify-write solto — o beacon pode
      // reescrever o record enquanto este `reconcileClaims` tenta gravar, e um
      // `...current` congelado apagaria os campos dele.
      writeJsonSafeWithCas(
        entry.realPath,
        (current) => {
          if (!current) throw new Error("reconcileClaims: sessão sumiu entre a leitura e a escrita");
          const set = new Set(current.claimed_issues ?? []);
          for (const issue of fresh.addedIssues) set.add(issue);
          const at = { ...(current.claimed_issues_at ?? {}), ...fresh.addedClaimedIssuesAt };
          return {
            ...current,
            claimed_issues: [...set].sort((a, b) => a - b),
            claimed_issues_at: at,
          };
        },
        // `verify` checa PERTINÊNCIA das issues que este reconcile veio
        // adicionar, nunca igualdade do array inteiro contra um snapshot.
        // Comparar com um `expectedClaimed` congelado ANTES do lock seria o
        // mesmo bug que esta PR conserta, do lado do `verify`: um escritor
        // concorrente que adicione OUTRA issue deixa o disco correto (o
        // `merge` acima relê fresco e produz o superconjunto) e mesmo assim a
        // igualdade nunca casaria — as 50 tentativas se esgotariam e o
        // reconcile reportaria `write-failed` para uma escrita que funcionou.
        (onDisk) => {
          const claimedOnDisk = new Set(onDisk?.claimed_issues ?? []);
          return fresh.addedIssues.every((issue) => claimedOnDisk.has(issue));
        },
      );
    } catch (e) {
      entry.action = "write-failed";
      entry.reason = `${entry.reason} [escrita falhou: ${(e as Error)?.message ?? String(e)} — próxima execução retenta]`;
    }
  }
  return plan;
}

// ─── Recolhimento de -safeBackup- já reconciliados (#6970) ─────────────────
//
// `reconcileClaims` (#6581, acima) já funde `claimed_issues` de um grupo no
// arquivo REAL, mas DELIBERADAMENTE nunca remove os `-safeBackup-*` — "quem
// remove é o GC", e `planSessionGc` só recolhe backup ÓRFÃO (sessão já
// ENCERRADA, arquivo real ausente). O caso que fica de fora dos dois
// mecanismos: uma sessão VIVA cujo real já reflete tudo que os backups do
// grupo carregam (reconciliação em dia), mas os backups continuam em disco
// para sempre — o #6970 mediu 15 arquivos `-safeBackup-` em `data/sessions/`
// do helios, um criado no mesmo dia da medição.
//
// **Restrição de `merge_grant`, reavaliada no #6573 pós-#6952.** Até o
// #6952 (PR #6969, mergeada), `mergeSessionRecords` NÃO unia `merge_grant`
// entre os arquivos do grupo — um `merge_grant` que sobrevivesse só num
// backup podia ser descartado em SILÊNCIO na leitura, então este planejador
// bloqueava qualquer grupo com QUALQUER backup carregando `merge_grant`,
// sem distinguir vivo de morto. Essa premissa ficou obsoleta ANTES mesmo de
// ser escrita em prosa aqui: o commit da união (`353f73f1`, #6969) mergeou
// ~2h antes do commit que introduziu esta restrição (`887abfe5`, #7005),
// mesma madrugada — achado do review consolidado da rodada 260901.
//
// Com a união em vigor, `mergeGrantBlocksBackupCleanup` (abaixo) substitui o
// bloqueio incondicional por um mais estreito, que protege só os dois riscos
// que sobram depois que a leitura já une corretamente:
//   1. **Perda** — a concessão AGREGADA (real + backups) ainda está viva
//      (não consumida, dentro do TTL) e o real sozinho não a reproduz.
//      Remover os backups apagaria a única cópia utilizável.
//   2. **Ressurreição** — a concessão agregada já está CONSUMIDA (o carimbo
//      só existe em algum backup), mas o real sozinho, sem esse carimbo,
//      ainda pareceria viva (dentro do TTL). Remover o backup apagaria a
//      PROVA de consumo e a concessão voltaria a parecer usável — o mesmo
//      tipo de dano que a união do #6952 fechou do lado da leitura, agora do
//      lado da remoção física.
// Uma concessão já morta por QUALQUER outro motivo (TTL expirado — nunca
// "desexpira" — ou consumida com o real já refletindo o carimbo) nunca
// bloqueia: nenhuma leitura futura voltaria a tratá-la como usável, união ou
// não, então perder a única cópia física dela não muda nada.
export type SafeBackupCleanupAction =
  | "removable"
  | "pending-reconciliation"
  | "has-merge-grant"
  | "skipped-unreadable-real"
  | "orphan-backups-only";

export interface SafeBackupCleanupResult {
  /** Stem do arquivo real (mesma identidade de `ClaimReconciliationResult`), ou
   * `orphan-backup:{arquivo}` pra um backup sem real correspondente. */
  identity: string;
  /** Path absoluto do arquivo real do grupo — `null` só pra `orphan-backups-only`. */
  realPath: string | null;
  backupPaths: string[];
  action: SafeBackupCleanupAction;
  reason: string;
}

/**
 * Verdadeiro quando remover TODOS os backups de um grupo perderia
 * informação de `merge_grant` que nenhum arquivo remanescente (só o real,
 * depois da remoção) reproduziria — os dois riscos descritos na docstring
 * acima ("Perda"/"Ressurreição"). Pura.
 *
 * `winner` é a concessão da UNIÃO do grupo inteiro (`mergeSessionRecords`,
 * que já sabe escolher o `grantedAt` mais recente e propagar `consumedAt` de
 * qualquer cópia — #6952) — a verdade atual, com os backups ainda no disco.
 * `realGrant` é o que o arquivo REAL carrega SOZINHO — o que sobra depois
 * que os backups são removidos. As duas únicas formas de perder algo que
 * importa:
 *
 *   1. **Perda**: `winner` ainda está viva e o real sozinho não reproduz a
 *      MESMA concessão (identidade `grantedBy`+`grantedTo`+`grantedAt`) —
 *      union só existe enquanto os backups existem; apagá-los apagaria a
 *      única cópia legível de uma concessão ainda utilizável.
 *   2. **Ressurreição**: `winner` já está CONSUMIDA, mas o real sozinho — sem
 *      esse carimbo — ainda estaria dentro do TTL e pareceria viva. Uma
 *      concessão já usada não pode voltar a parecer disponível só porque a
 *      prova de consumo morava só no arquivo que foi removido.
 *
 *   **#7462 corrigiu o que conta como "já está consumida".** Antes, o
 *   `consumedAt` vinha de QUALQUER cópia do grupo (`mergeSessionRecords`
 *   propagueava de backups), então o caso 2 se disparava com o carimbo no
 *   backup mesmo com o real vivo — exatamente o cenário que a issue relata:
 *   o backup carregava um `consumedAt` que nunca foi escrito por um merge.
 *   Agora o carimbo conta só quando está no real, e o caso 2 só dispara de
 *   fato quando o real está consumido.
 *
 * Uma concessão sem nenhum dos dois riscos (já morta por TTL de qualquer
 * jeito, ou já integralmente reproduzida no real, carimbo de consumo
 * incluso) nunca bloqueia — é exatamente o volume que este relaxamento (#6573,
 * pós-#6952) existe para liberar: backups antigos carregando concessões de
 * TTL 10min havia muito expiradas.
 */
function mergeGrantBlocksBackupCleanup(
  realRecord: SessionRecord,
  backupRecords: readonly SessionRecord[],
  now: number,
): boolean {
  // #7462: o `consumedAt` é um carimbo de FATO, não um voto de maioria — só
  // testemunha quando está no arquivo REAL. Cópias `-safeBackup-` são detrito
  // de sync do OneDrive: um `consumedAt` nelas é um resíduo, não prova de
  // consumo. Por isso esta função consulta o grant DO REAL (nunca o mesclado
  // pela união, que pode herdar um `consumedAt` de backup e dizer "morto"
  // sem que o real tenha sido consumido).
  const real = realRecord.merge_grant;

  if (!real) {
    // O real nem carrega o grant — a concessão vive só nos backups. A
    // pergunta é se a união (só backups) ainda está VIVA: se sim, remover
    // perde a única cópia legível (#6573); se não (consumida ou TTL
    // expirado), nada se perde em remover.
    //
    // #7462: a união aqui NÃO é usada como testemunha de consumo. Um backup
    // pode carregar um `consumedAt` que o real nunca teve (resíduo de sync
    // do OneDrive) — e o `mergeSessionRecords` mescla esse `consumedAt` no
    // grant vencedor, fazendo `isMergeGrantLive` dizer "morto" sem que
    // NINGUÉM tenha consumido. O grant vivo é aquele SEM `consumedAt`:
    // se a concessão não foi consumida de fato, ela morre sozinha pelo
    // TTL, e até lá remover o backup perderia a única cópia legível.
    const winner = mergeSessionRecords([realRecord, ...backupRecords]).merge_grant;
    if (!winner) return false;
    const liveGrant: MergeGrant = { ...winner, consumedAt: undefined };
    return isMergeGrantLive(liveGrant, liveGrant.grantedTo, now);
  }

  // O real carrega o grant. Se o real já mostra MORTO (consumido ou TTL
  // expirado), o backup não acrescenta informação que mude o desfecho —
  // remover é seguro. O #6573 ("nunca remover while alive") já não se
  // aplica: a morte foi atestada pela única fonte de verdade.
  if (!isMergeGrantLive(real, real.grantedTo, now)) return false;

  // O real tem o grant VIVO. Verifica se algum backup carrega a MESMA
  // concessão:
  for (const backup of backupRecords) {
    const bg = backup.merge_grant;
    if (
      bg &&
      bg.grantedBy === real.grantedBy &&
      bg.grantedTo === real.grantedTo &&
      bg.grantedAt === real.grantedAt
    ) {
      // O backup reproduz a mesma concessão que o real, e o real já está
      // vivo. Se o backup NÃO tem `consumedAt`, ele não acrescenta
      // informação: o real sozinho já mostra o mesmo estado (caso #6952:
      // "já integralmente reproduzido no real") — nada a proteger.
      // Se o backup TEM `consumedAt` que o real não tem, há uma
      // divergência: o backup diz "morto", o real diz "vivo". #7462: o
      // carimbo do backup não testemunha o real, então o real continua
      // vivo — e remover o backup deixaria o real como única cópia com a
      // concessão viva (risco de ressurreição). Preserva o backup até o
      // TTL expirar, quando a janela morre sozinha.
      return bg.consumedAt ? true : false;
    }
  }

  // O real tem um grant VIVO que NENHUM backup carrega como mesma identidade.
  // Remover os backups perde a única cópia legível dele (#6573).
  return true;
}

/**
 * Plano PURO (sem I/O) de quais grupos de `-safeBackup-*` já reconciliados
 * podem ser removidos com segurança. Reusa `groupBackupsByRealStem` e
 * `decideClaimReconciliation` — a MESMA primitiva de união que
 * `planClaimReconciliation` já usa, evitando uma 2ª regra de merge que
 * divergiria da 1ª (mesmo princípio citado na issue #6970).
 *
 * Grupo sem nenhum backup nunca aparece no resultado (nada a fazer). Backup
 * ÓRFÃO (sem arquivo real correspondente — sessão já encerrada, GC ainda não
 * passou) é reportado com `action: "orphan-backups-only"` — mesma
 * observabilidade que `planClaimReconciliation` já dá pro caso irmão
 * (#7005 self-review finding 2): este planejador nunca toca esses backups
 * (quem decide o destino deles é `planSessionGc`, pela liveness do grupo),
 * mas omiti-los do output silenciosamente sugeria "nada a revisar" quando na
 * verdade pode haver estado importante ali (achado ao vivo #7002).
 *
 * `opts.now` — injeção pra teste (mesmo padrão de `planSessionGc`); default
 * `Date.now()`. Só importa pra decidir liveness/TTL de `merge_grant`
 * (`mergeGrantBlocksBackupCleanup`) — claims não têm noção de tempo aqui.
 */
export function planSafeBackupCleanup(repoRoot: string, opts: { now?: number } = {}): SafeBackupCleanupResult[] {
  const now = opts.now ?? Date.now();
  const dir = sessionsDir(repoRoot);
  const names = listSessionJsonFiles(repoRoot);
  const realNames = names.filter((n) => !n.includes("-safeBackup-")).sort();
  const backupsByRealStem = groupBackupsByRealStem(names);
  const claimedBackupNames = new Set<string>();
  const results: SafeBackupCleanupResult[] = [];

  for (const realName of realNames) {
    const stem = realName.slice(0, -".json".length);
    const backupNames = (backupsByRealStem.get(stem) ?? []).sort();
    for (const b of backupNames) claimedBackupNames.add(b);
    if (backupNames.length === 0) continue; // sem backup — nada a recolher

    const realPath = join(dir, realName);
    const backupPaths = backupNames.map((n) => join(dir, n));
    const realRecord = readJsonSafe<SessionRecord>(realPath);
    if (!realRecord) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        action: "skipped-unreadable-real",
        reason: "arquivo real ilegível/corrompido — grupo pulado (fail-soft, mesma disciplina de planClaimReconciliation)",
      });
      continue;
    }

    const backupRecords: SessionRecord[] = [];
    for (const b of backupNames) {
      const r = readJsonSafe<SessionRecord>(join(dir, b));
      if (r) backupRecords.push(r);
    }

    const { addedIssues } = decideClaimReconciliation(realRecord, backupRecords);
    if (addedIssues.length > 0) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        action: "pending-reconciliation",
        reason: `${addedIssues.length} claim(s) do grupo ainda não estão no real — rode reconcileClaims primeiro`,
      });
      continue;
    }

    if (mergeGrantBlocksBackupCleanup(realRecord, backupRecords, now)) {
      results.push({
        identity: stem,
        realPath,
        backupPaths,
        action: "has-merge-grant",
        reason:
          "claims reconciliadas, mas um backup do grupo carrega merge_grant que a união (#6952) mostra ainda " +
          "utilizável e o real sozinho não reproduz — remover perderia a única cópia legível dele; preservado",
      });
      continue;
    }

    results.push({
      identity: stem,
      realPath,
      backupPaths,
      action: "removable",
      reason: `claims já reconciliadas no real, nenhum backup carrega merge_grant — ${backupPaths.length} backup(s) removível(is)`,
    });
  }

  const orphanBackups = names.filter((n) => n.includes("-safeBackup-") && !claimedBackupNames.has(n)).sort();
  for (const orphan of orphanBackups) {
    results.push({
      identity: `orphan-backup:${orphan}`,
      realPath: null,
      backupPaths: [join(dir, orphan)],
      action: "orphan-backups-only",
      reason:
        "backup sem arquivo real correspondente — este planejador nunca toca backup órfão; " +
        "o GC (`planSessionGc`) decide o destino dele com os critérios de liveness dele",
    });
  }

  return results;
}

/**
 * Aplica `planSafeBackupCleanup`: para cada grupo `"removable"`, RELÊ o real
 * e os backups no momento da escrita e RECOMPUTA a decisão contra esse
 * estado FRESCO — mesma disciplina de `reconcileClaims` (evita remover um
 * backup que recebeu uma claim ou um merge_grant NOVO entre o plano e a
 * execução; a corrida é real, `data/sessions/` é escrito por sessões
 * concorrentes o tempo todo). Remoção é best-effort (`rmSync`, nunca lança)
 * — mesmo idioma de `garbageCollectSessions`: uma falha rebaixa a entry pra
 * `"kept"` com o motivo anexado, e a próxima execução retenta.
 *
 * Nunca escreve no arquivo real — só remove backups já subsumidos por ele.
 * Idempotente por construção: rodar duas vezes sobre o mesmo estado não
 * remove nada na 2ª vez (os backups já não existem).
 *
 * `opts.now` — mesma injeção de `planSafeBackupCleanup`, propagada tanto pro
 * plano inicial quanto pra RECOMPUTAÇÃO fresca de `mergeGrantBlocksBackupCleanup`
 * logo abaixo (mesmo instante lógico das duas checagens — nunca um relógio
 * congelado do plano contra um "agora" resolvido de novo na escrita).
 */
export function cleanupReconciledSafeBackups(repoRoot: string, opts: { now?: number } = {}): SafeBackupCleanupResult[] {
  const now = opts.now ?? Date.now();
  const plan = planSafeBackupCleanup(repoRoot, { now });
  for (const entry of plan) {
    if (entry.action !== "removable" || !entry.realPath) continue; // "removable" nunca tem realPath null (só "orphan-backups-only" tem)

    const freshReal = readJsonSafe<SessionRecord>(entry.realPath);
    if (!freshReal) {
      entry.action = "skipped-unreadable-real";
      entry.reason = `${entry.reason} [ficou ilegível entre o plano e a remoção — pulado, próxima execução retenta]`;
      continue;
    }
    const freshBackupRecords: SessionRecord[] = [];
    const freshBackupPaths: string[] = [];
    for (const backupPath of entry.backupPaths) {
      const r = readJsonSafe<SessionRecord>(backupPath);
      if (r) {
        freshBackupRecords.push(r);
        freshBackupPaths.push(backupPath);
      }
      // backup que sumiu entre o plano e agora (removido por outra execução
      // concorrente) simplesmente não entra na releitura — nada a remover ali.
    }
    if (freshBackupPaths.length === 0) {
      entry.action = "removable"; // nada restava — já recolhido por outra execução
      entry.reason = `${entry.reason} [já não havia backup(s) no momento da remoção — outra execução chegou primeiro]`;
      continue;
    }

    const { addedIssues } = decideClaimReconciliation(freshReal, freshBackupRecords);
    if (addedIssues.length > 0) {
      entry.action = "pending-reconciliation";
      entry.reason = `${entry.reason} [claim nova apareceu num backup entre o plano e a remoção — pulado, retenta depois de reconciliar]`;
      continue;
    }
    if (mergeGrantBlocksBackupCleanup(freshReal, freshBackupRecords, now)) {
      entry.action = "has-merge-grant";
      entry.reason = `${entry.reason} [merge_grant utilizável apareceu/persistiu num backup entre o plano e a remoção — pulado]`;
      continue;
    }

    let allRemoved = true;
    for (const backupPath of freshBackupPaths) {
      try {
        rmSync(backupPath, { force: true });
      } catch {
        allRemoved = false;
      }
    }
    if (!allRemoved) {
      entry.reason = `${entry.reason} [remoção falhou parcialmente — próxima execução retenta o que sobrou]`;
    }
  }
  return plan;
}

// ─── Beacon: caminhos tocados (#6168 Parte A) ──────────────────────────────

/**
 * Normaliza um caminho pra comparação entre sessões: separadores POSIX, sem
 * `./` inicial, sem barra final. `data/` é compartilhado entre Windows
 * (`Neo`) e Linux (`helios`), então um caminho gravado com `\` por uma máquina
 * precisa casar com o mesmo caminho gravado com `/` pela outra — sem isto, a
 * detecção de sobreposição seria cega justamente no cenário cross-máquina que
 * a issue chama de caso normal.
 */
export function normalizeBeaconPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Aplica o teto de `TOUCHED_PATHS_CAP` colapsando caminhos pra prefixo de
 * DIRETÓRIO em vez de truncar. Truncar perderia a informação de que a sessão
 * mexeu naquela área; o prefixo preserva o sinal de sobreposição (que é o que
 * `findSessionConflicts` consome) num espaço menor.
 *
 * Colapsa um nível por passada, do mais fundo pro mais raso, até caber ou até
 * não haver mais o que colapsar. Pura, determinística (saída sempre ordenada).
 */
export function collapseTouchedPaths(paths: readonly string[], cap: number = TOUCHED_PATHS_CAP): string[] {
  let current = [...new Set(paths.map(normalizeBeaconPath))].filter((p) => p !== "");
  if (current.length <= cap) return current.sort();

  // Colapsa progressivamente: a cada passada, todo caminho com mais de `depth`
  // segmentos vira o prefixo de `depth` segmentos.
  const maxDepth = Math.max(...current.map((p) => p.split("/").length));
  for (let depth = maxDepth - 1; depth >= 1; depth--) {
    current = [
      ...new Set(
        current.map((p) => {
          const parts = p.split("/");
          return parts.length > depth ? parts.slice(0, depth).join("/") : p;
        }),
      ),
    ];
    if (current.length <= cap) break;
  }
  // Ainda acima do teto mesmo colapsado ao 1º segmento (repo com muitos
  // diretórios de topo): corta, mas de forma determinística e ordenada.
  return current.sort().slice(0, cap);
}

/**
 * `true` quando dois caminhos se sobrepõem — iguais, ou um é prefixo de
 * DIRETÓRIO do outro. O teste de prefixo exige a barra (`a/b` cobre `a/b/c`,
 * mas `a/b` NÃO cobre `a/bc`) — sem isso, o colapso de `collapseTouchedPaths`
 * geraria falso positivo entre diretórios de nome parecido.
 */
export function beaconPathsOverlap(a: string, b: string): boolean {
  const x = normalizeBeaconPath(a);
  const y = normalizeBeaconPath(b);
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// ─── `conflicts`: consulta, nunca aquisição (#6168 Parte C) ────────────────

/**
 * Union DISCRIMINADA por `kind` — a correlação entre o tipo do conflito e os
 * campos que ele carrega é garantia de compilador, não convenção:
 *
 *   - `branch-drift` NUNCA tem `peer` (é sobre o próprio registro);
 *   - `branch-shared` e `path-overlap` SEMPRE têm;
 *   - só `path-overlap` carrega `paths`.
 *
 * Declarar isso como um shape único com campos opcionais deixaria
 * `{ kind: "path-overlap", peer: undefined }` representável — semanticamente
 * absurdo, e o consumidor precisaria re-checar `kind` antes de tocar `peer`.
 * A Parte D da #6168 prevê consumidores que vão querer `conflict.peer.sessionId`
 * pra abrir conversa com quem colidiu; a union dá exhaustiveness a eles de graça.
 */
export type SessionConflict =
  | { kind: "branch-drift"; detail: string }
  | { kind: "branch-shared"; peer: ActiveSessionRecord; detail: string }
  | { kind: "path-overlap"; peer: ActiveSessionRecord; detail: string; paths: string[] };

export interface FindSessionConflictsOptions {
  /** `sessionId` de quem pergunta — sempre excluído dos peers. */
  sessionId: string;
  /** Caminhos que esta sessão está prestes a tocar. */
  paths?: readonly string[];
  /** Branch atual do checkout de quem pergunta (`git branch --show-current`). */
  branch?: string;
  /** Registro da PRÓPRIA sessão, quando disponível — habilita `branch-drift`. */
  ownRecord?: SessionRecord | null;
  /** Tag da máquina de quem pergunta — `branch-shared` só compara peers da MESMA máquina. */
  machineTag?: string;
}

/**
 * Consulta PURA: "quem mais está mexendo nisto agora?" (#6168 Parte C).
 *
 * **Não adquire nada e não cria arquivo nenhum** — é o critério de aceite
 * explícito da issue ("nenhum arquivo de lock NOVO"). Responde e devolve o
 * peer; o que fazer com a resposta é decisão de quem chamou (Parte D:
 * conversar; Parte F: ordenar o merge).
 *
 * Três conflitos, e o primeiro é o que a evidência 5 da issue pedia:
 *
 * - **`branch-drift`** — a branch registrada por ESTA sessão no beacon não é
 *   mais a branch do checkout. Significa que outra sessão trocou o checkout
 *   embaixo (`sync-code.ts` faz `git checkout master` quando `branch !=
 *   master`, e é o Passo 0 de toda edição/rodada). Não envolve peer: é a
 *   checagem barata de "a branch ainda é minha?" antes de um `git commit`,
 *   que teria pego no ato o incidente em que `commit`/`push` reportaram
 *   sucesso e o commit foi parar em `master`.
 * - **`branch-shared`** — um peer vivo da MESMA máquina declara a mesma
 *   branch. Só faz sentido intra-máquina: máquinas diferentes têm checkouts
 *   diferentes, e homônimos de branch ali não colidem.
 * - **`path-overlap`** — caminhos desta sessão sobrepõem `touched_paths`/
 *   `dirty_paths` de um peer vivo. `dirty_paths` (não-commitado) é reportado
 *   à parte porque é o sinal mais forte: trabalho em voo, sem branch ainda.
 *
 * **Sessão `stale` nunca conflita** — usa `session.stale` (janela por kind,
 * #6168 — uma sessão interativa morta há 15 min já não bloqueia), a mesma
 * janela CURTA que `isIssueClaimedByOther` usava até o #7227. As duas
 * divergem desde então: conflito de PATH é sobre edição concorrente de
 * arquivo (silêncio curto já é sinal suficiente pra não bloquear alguém de
 * editar o mesmo arquivo), enquanto liberar uma CLAIM autoriza terceiro a
 * assumir o trabalho inteiro de outra sessão — blast radius maior, exige a
 * janela mais longa de `claimReleaseMsForKind` (ver sua docstring).
 */
export function findSessionConflicts(
  sessions: readonly ActiveSessionRecord[],
  opts: FindSessionConflictsOptions,
): SessionConflict[] {
  const conflicts: SessionConflict[] = [];
  const myPaths = (opts.paths ?? []).map(normalizeBeaconPath).filter((p) => p !== "");

  // 1. branch-drift — sobre o PRÓPRIO registro, não sobre peer.
  const knownBranch = opts.ownRecord?.branch;
  if (opts.branch && knownBranch && knownBranch !== opts.branch) {
    conflicts.push({
      kind: "branch-drift",
      detail:
        `a branch registrada por esta sessão era "${knownBranch}" e o checkout está agora em "${opts.branch}" — ` +
        "outra sessão provavelmente trocou o checkout no meio (sync-code.ts faz `git checkout master` quando a " +
        "branch não é master). Commitar agora pode cair na branch errada, com `commit`/`push` reportando sucesso.",
    });
  }

  for (const peer of sessions) {
    if (peer.sessionId === opts.sessionId) continue;
    if (peer.stale) continue;

    // 2. branch-shared — só intra-máquina (ver docstring).
    if (
      opts.branch &&
      peer.branch === opts.branch &&
      (opts.machineTag === undefined || peer.machineTag === opts.machineTag)
    ) {
      conflicts.push({
        kind: "branch-shared",
        peer,
        detail: `${peer.kind}@${peer.machineTag} declara a MESMA branch "${opts.branch}" no mesmo checkout`,
      });
    }

    // 3. path-overlap — dirty (não-commitado) é o sinal mais forte.
    if (myPaths.length > 0) {
      const peerDirty = (peer.dirty_paths ?? []).map(normalizeBeaconPath);
      const peerTouched = (peer.touched_paths ?? []).map(normalizeBeaconPath);
      const hitsDirty = myPaths.filter((mine) => peerDirty.some((theirs) => beaconPathsOverlap(mine, theirs)));
      const hitsTouched = myPaths.filter((mine) => peerTouched.some((theirs) => beaconPathsOverlap(mine, theirs)));
      const hits = [...new Set([...hitsDirty, ...hitsTouched])].sort();
      if (hits.length > 0) {
        conflicts.push({
          kind: "path-overlap",
          peer,
          paths: hits,
          detail:
            `${peer.kind}@${peer.machineTag} já tocou ${hits.length} caminho(s) em comum` +
            (hitsDirty.length > 0
              ? ` — ${hitsDirty.length} deles com edição NÃO COMMITADA (${hitsDirty.slice(0, 5).join(", ")})`
              : ""),
        });
      }
    }
  }

  return conflicts;
}

// ─── Concessão de janela de merge (#6296) ──────────────────────────────────

export type SelfAuthorizeMergeReason =
  | "authorized"
  | "reason-required"
  | "no-active-coordinator"
  | "responsive-coordinator-active"
  | "caller-is-coordinator"
  | "session-not-registered";

export interface SelfAuthorizeMergeResult {
  ok: boolean;
  reason: SelfAuthorizeMergeReason;
  record?: SelfAuthorizedMerge;
  /** Populado só em `responsive-coordinator-active` — os kinds das
   * coordenadoras que NÃO são `continuo` e por isso continuam alcançáveis
   * via `grant-merge` normal. */
  coordinatorKinds?: SessionKind[];
}

/**
 * Auto-autoriza UM merge quando a sessão chamadora está bloqueada pelo guard
 * do #5716 e não há NENHUMA coordenadora ativa capaz de conceder `grant-merge`
 * (#7303) — só `continuo` (cron, não conversa) está ativa.
 *
 * Escopo deliberadamente ESTREITO — as 4 recusas existem pra nunca abrir mão
 * de nenhuma proteção que já vale pra uma rodada supervisionada normal:
 *
 * - **`no-active-coordinator`** — sem coordenadora nenhuma ativa, `gh pr
 *   merge` nem seria bloqueado pelo guard (#5716 só bloqueia havendo rodada
 *   ativa) — não há nada pra contornar.
 * - **`caller-is-coordinator`** — quem chama já É uma coordenadora
 *   registrada, já tem direito de mergear por si (via `isCoordinator` no
 *   guard); auto-autorizar seria decorativo.
 * - **`responsive-coordinator-active`** — existe pelo menos UMA coordenadora
 *   `overnight`/`develop` ativa (kind que CONVERSA). O caminho normal
 *   (`grant-merge` dela) continua sendo o único — este mecanismo não é um
 *   atalho pra evitar pedir, é a saída só quando pedir é estruturalmente
 *   impossível. Isto também é o que impede uma sessão bloqueada por uma
 *   rodada `develop` normal (o caso que o #5716 protege) de se
 *   auto-autorizar só porque, entre várias coordenadoras ativas, uma delas
 *   por acaso é `continuo`.
 * - **`session-not-registered`** — a auto-autorização é gravada no PRÓPRIO
 *   record da sessão chamadora (nunca no de uma coordenadora — inverso de
 *   `grantMergeWindow`), e ela precisa já ter um arquivo em
 *   `data/sessions/` (escrito pelo beacon na 1ª chamada de ferramenta desta
 *   sessão). Praticamente sempre verdade no momento em que `gh pr merge` já
 *   foi tentado (o próprio comando bloqueado já passou pelo beacon antes) —
 *   registrado como recusa explícita, não suposto.
 *
 * `reason` é OBRIGATÓRIO (não-vazio) — nunca uma auto-autorização silenciosa,
 * conforme a Direção 2 da issue ("registro explícito de que agiu sem
 * concessão"). O guard mecânico (`.claude/hooks/block-gh-pr-merge-subagent.mjs`)
 * trata a auto-autorização viva exatamente como `merge_grant`: destrava
 * IDENTIDADE, nunca TEMPO — quem a usa ainda precisa adquirir o merge lock
 * antes de `gh pr merge` de fato suceder (`merge-lock-acquire`), então a
 * serialização com um merge que a própria `continuo` esteja fazendo naquele
 * instante continua garantida pelo lock.
 */
export function selfAuthorizeMerge(
  repoRoot: string,
  sessionId: string,
  opts: { reason: string; pr?: number; now?: string },
): SelfAuthorizeMergeResult {
  const reason = (opts.reason ?? "").trim();
  if (reason === "") return { ok: false, reason: "reason-required" };

  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const coordinators = listActiveSessions(repoRoot, Number.isFinite(nowMs) ? nowMs : Date.now()).filter(
    (s) => isCoordinatorKind(s.kind) && !s.stale,
  );
  if (coordinators.length === 0) return { ok: false, reason: "no-active-coordinator" };
  if (coordinators.some((s) => s.sessionId === sessionId)) return { ok: false, reason: "caller-is-coordinator" };
  const responsiveKinds = [...new Set(coordinators.filter((s) => s.kind !== "continuo").map((s) => s.kind))];
  if (responsiveKinds.length > 0) {
    return { ok: false, reason: "responsive-coordinator-active", coordinatorKinds: responsiveKinds };
  }

  const path = findExistingSessionFileAnyKind(repoRoot, sessionId);
  if (!path) return { ok: false, reason: "session-not-registered" };

  const record: SelfAuthorizedMerge = { reason, authorizedAt: now, ...(opts.pr !== undefined ? { pr: opts.pr } : {}) };
  writeJsonSafeWithCas(
    path,
    (current) => {
      if (!current) throw new Error("selfAuthorizeMerge: sessão sumiu entre a leitura e a escrita");
      return { ...current, self_authorized_merge: record, lastHeartbeat: now };
    },
    (onDisk) => onDisk?.self_authorized_merge?.authorizedAt === record.authorizedAt,
  );
  return { ok: true, reason: "authorized", record };
}

export type GrantMergeReason =
  | "granted"
  | "self-grant-refused"
  | "not-a-coordinator"
  | "grantee-is-coordinator-refused"
  | "no-op-session-missing"
  | "live-grant-would-be-overwritten"
  | "pr-already-granted-elsewhere";

export interface GrantMergeResult {
  ok: boolean;
  reason: GrantMergeReason;
  grant?: MergeGrant;
}

/**
 * Concede a janela de merge a OUTRA sessão (#6296) — gravada como campo
 * `merge_grant` no record da coordenadora que concede, nunca num arquivo
 * novo.
 *
 * Motivação medida (260826, `helios`): o protocolo da Parte F foi executado à
 * mão e cada passo funcionou — `ListAgents` achou o peer, `SendMessage`
 * entregou, o peer conferiu colisão por arquivo nos 3 PRs dele, concedeu a
 * janela, e o `merge-lock-acquire` deu ok. **E o `gh pr merge` foi bloqueado
 * assim mesmo**, porque o guard do #5716 compara `session_id` contra
 * `data/sessions/` e sessão interativa não está lá. A conversa chegou a
 * acordo e não teve efeito nenhum sobre o mecanismo. Esta função é o que dá
 * ao acordo uma representação que o guard consegue ler.
 *
 * Duas recusas, ambas estruturais:
 * - **`self-grant-refused`** — ninguém concede a si mesmo. É o que preserva a
 *   propriedade que o #5716 protege (a coordenadora decide quando entra
 *   merge) em vez de contorná-la; sem isso, "conceder a si mesma" seria só um
 *   relabel com outro nome.
 * - **`not-a-coordinator`** — só overnight/develop/continuo concedem.
 */
export function grantMergeWindow(
  repoRoot: string,
  kind: SessionKind,
  sessionId: string,
  grantedTo: string,
  meta: { pr?: number; tag?: string; now?: string; force?: boolean } = {},
): GrantMergeResult {
  if (!isCoordinatorKind(kind)) return { ok: false, reason: "not-a-coordinator" };
  if (grantedTo === sessionId || grantedTo.trim() === "") return { ok: false, reason: "self-grant-refused" };

  // #6303 review cruzado (P1·a): recusa conceder a OUTRA COORDENADORA.
  //
  // Até aqui só o CONCEDENTE era validado (`isCoordinatorKind(kind)`) e só a
  // auto-concessão era barrada. O kind de `grantedTo` nunca era olhado —
  // então `grant-merge --granted-to {sessionId de outra coordenadora}`
  // sucedia. Combinado com o ramo de concessão que, no guard, saía ANTES da
  // checagem de lock, isso deixava a coordenadora beneficiada pular a
  // serialização. Concessão cruzada (A→B, B→A) e ambas mergeavam sem lock.
  //
  // A concessão existe pra dar caminho a quem NÃO tem identidade de
  // coordenadora — tipicamente uma sessão interativa. Coordenadora já tem o
  // direito por si; o que ela precisa respeitar é o merge lock, e conceder
  // entre pares seria justamente um jeito de contorná-lo.
  //
  // Defesa em profundidade, não redundância: esta recusa responde "quem pode
  // receber"; a reordenação no guard responde "quando pode usar". Fechar só
  // uma das duas deixaria a outra metade aberta a um `merge_grant` gravado
  // por outro caminho.
  const grantee = listActiveSessions(repoRoot).find((s) => s.sessionId === grantedTo);
  if (grantee && isCoordinatorKind(grantee.kind)) {
    return { ok: false, reason: "grantee-is-coordinator-refused" };
  }

  const tag = meta.tag ?? machineTag();
  const path = sessionFilePath(repoRoot, kind, tag, sessionId);
  const now = meta.now ?? new Date().toISOString();
  let existingRecord = readJsonSafe<SessionRecord>(path);
  if (!existingRecord) {
    // #6999 (fix 2): a leitura CRUA do arquivo real não é a pergunta certa —
    // a concedente pode ter perdido a âncora num lost-update com a sessão
    // viva (#7002) e ter o estado inteiro só nas cópias de conflito. Recusar
    // aqui devolvia `no-op (sessão inexistente)` pra uma coordenadora ATIVA,
    // com o agravante de a mensagem não dizer QUAL das duas sessões em jogo
    // (concedente × beneficiária) não foi encontrada — ver a mensagem
    // dedicada no CLI. Reconstrói pelo mesmo caminho do `claim-issue`
    // (#7003); só recusa quando não há nem âncora nem cópia viva.
    const recovered = recoverAnchorFromOrphanBackups(repoRoot, kind, sessionId, tag, now);
    if (!recovered) return { ok: false, reason: "no-op-session-missing" };
    warnAnchorRecoveredFromOrphanBackups("grant-merge", sessionId, path, recovered);
    existingRecord = readJsonSafe<SessionRecord>(path);
  }

  const grant: MergeGrant = { grantedTo, grantedBy: sessionId, grantedAt: now };
  if (meta.pr !== undefined) grant.pr = meta.pr;

  // #7043 achado 1 (1º caminho) — `merge_grant` é campo ÚNICO no record da
  // concedente: uma 2ª chamada de `grant-merge` (outro beneficiário e/ou
  // outro PR) SOBRESCREVE a concessão anterior em silêncio. Medido ao vivo:
  // concedi janela pra PR #6955 e, em seguida, pra #6959, à mesma sessão — o
  // registro ficou só com a 2ª, e `grant-merge` devolveu `ok` NAS DUAS vezes.
  // A beneficiária original nunca soube que perdeu a janela. Recusa (a menos
  // que `meta.force`) quando a concessão que SERIA sobrescrita ainda está
  // viva e tem IDENTIDADE DIFERENTE da nova (outro `grantedTo` e/ou outro
  // `pr`) — reconceder a MESMA identidade (só renovar `grantedAt`) não perde
  // informação nenhuma e continua permitido sem `--force`.
  const priorGrant = existingRecord?.merge_grant;
  const nowMs = Date.parse(now);
  if (
    !meta.force &&
    priorGrant &&
    isMergeGrantLive(priorGrant, priorGrant.grantedTo, nowMs) &&
    (priorGrant.grantedTo !== grantedTo || priorGrant.pr !== grant.pr)
  ) {
    return { ok: false, reason: "live-grant-would-be-overwritten", grant: priorGrant };
  }

  // #7043 achado 1 (2º caminho) — duas coordenadoras concedendo janela pra a
  // MESMA PR não se enxergam: cada concessão mora no record de QUEM concede,
  // nunca num lugar comparável entre coordenadoras. Medido ao vivo: duas
  // coordenadoras concederam janela pra a mesma PR (#6988) com 20s de
  // diferença — nenhuma soube da outra, e `grant-merge` respondeu `ok` nas
  // duas. Recusa (a menos que `meta.force`) quando OUTRA coordenadora ativa
  // já tem concessão viva pra este mesmo PR — só se aplica quando `meta.pr`
  // foi informado (concessão genérica, sem PR, não tem identidade de PR pra
  // colidir).
  if (!meta.force && meta.pr !== undefined) {
    const clashing = listActiveSessions(repoRoot).find(
      (s) =>
        s.sessionId !== sessionId &&
        isCoordinatorKind(s.kind) &&
        s.merge_grant?.pr === meta.pr &&
        isMergeGrantLive(s.merge_grant, s.merge_grant?.grantedTo ?? "", nowMs),
    );
    if (clashing) {
      return { ok: false, reason: "pr-already-granted-elsewhere", grant: clashing.merge_grant };
    }
  }

  // #6952: CAS em vez de read-modify-write solto. O concedente é uma sessão
  // ATIVA e o beacon reescreve este registro a cada chamada de ferramenta —
  // sem isto o grant é apagado pelo próprio concedente antes de a
  // beneficiária consome-lo (exato sintoma do #6952).
  writeJsonSafeWithCas(
    path,
    (current) => {
      if (!current) throw new Error("grant-merge: sessão sumiu entre a leitura e a escrita");
      return { ...current, merge_grant: grant, lastHeartbeat: now };
    },
    (onDisk) => onDisk?.merge_grant?.grantedAt === grant.grantedAt,
  );
  return { ok: true, reason: "granted", grant };
}

/**
 * `true` quando `grant` ainda vale em `now`: não consumida, dentro do TTL, e
 * emitida para `sessionId`. Pura. Timestamp ilegível nunca vale (nunca
 * concede sobre estado que não se conseguiu interpretar).
 */
export function isMergeGrantLive(
  grant: MergeGrant | undefined,
  sessionId: string,
  now: number = Date.now(),
  ttlMs: number = MERGE_GRANT_TTL_MS,
): boolean {
  if (!grant || grant.grantedTo !== sessionId) return false;
  if (grant.consumedAt) return false;
  if (grant.grantedTo === grant.grantedBy) return false; // auto-concessão nunca vale, mesmo se gravada à mão
  const grantedMs = Date.parse(grant.grantedAt);
  if (!Number.isFinite(grantedMs)) return false;
  const ageMs = now - grantedMs;
  // Idade negativa além da tolerância de skew: não trata como válida por
  // tempo indefinido, mas também não rouba — mesma disciplina do merge lock.
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= ttlMs;
}

/**
 * Espelha `isMergeGrantLive` para `SelfAuthorizedMerge` (#7303) — dentro do
 * TTL (mesmo `MERGE_GRANT_TTL_MS`, com a mesma tolerância de clock skew).
 * Sem checagem de `consumedAt`/identidade cruzada porque não existem aqui
 * (ver docblock de `SelfAuthorizedMerge`: não há terceiro a proteger contra).
 * Pura.
 */
export function isSelfAuthorizedMergeLive(
  record: SelfAuthorizedMerge | undefined,
  now: number = Date.now(),
  ttlMs: number = MERGE_GRANT_TTL_MS,
): boolean {
  if (!record) return false;
  const authorizedMs = Date.parse(record.authorizedAt);
  if (!Number.isFinite(authorizedMs)) return false;
  const ageMs = now - authorizedMs;
  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) return false;
  return ageMs <= ttlMs;
}

/**
 * De ONDE veio a concessão vencedora da união do #6952 (#6972).
 *
 * - `"real"` — existe num arquivo REAL de `data/sessions/` (sem sufixo
 *   `-safeBackup-`). É o único caso que o gate de merge
 *   (`.claude/hooks/block-gh-pr-merge-subagent.mjs`) enxerga e honra.
 * - `"backup"` — vive SÓ em cópia(s) de conflito do OneDrive. `check-merge-grant`
 *   responde `granted: true` (a união do #6952 a encontra) e o gate bloqueia
 *   assim mesmo — de propósito, ver abaixo.
 */
export type MergeGrantSource = "real" | "backup";

/** Duas cópias da MESMA concessão — tripla de identidade do #6952. */
function isSameMergeGrant(a: MergeGrant | undefined, b: MergeGrant): boolean {
  return (
    a !== undefined && a.grantedBy === b.grantedBy && a.grantedTo === b.grantedTo && a.grantedAt === b.grantedAt
  );
}

/**
 * Responde a pergunta do #6972: esta concessão existe em algum arquivo REAL —
 * isto é, o gate de merge vai enxergá-la?
 *
 * Varre `data/sessions/` com a MESMA regra do gate (ignora todo nome que
 * contenha `-safeBackup-`), em vez de derivar o path do record mesclado: o
 * gate não sabe de kind nem de identidade fundida, ele lê arquivo por arquivo.
 * Reproduzir a regra dele é o que faz esta resposta valer alguma coisa.
 */
function mergeGrantLivesInRealFile(repoRoot: string, grant: MergeGrant): boolean {
  const dir = sessionsDir(repoRoot);
  for (const name of listSessionJsonFiles(repoRoot)) {
    if (name.includes("-safeBackup-")) continue;
    const record = readJsonSafe<SessionRecord>(join(dir, name));
    if (isSameMergeGrant(record?.merge_grant, grant)) return true;
  }
  return false;
}

/**
 * Procura, entre as sessões COORDENADORAS ativas, uma concessão viva emitida
 * pra `sessionId` (#6296). Retorna a concessão + quem concedeu + a PROVENIÊNCIA
 * dela (#6972), ou `null`.
 *
 * **#6972 — por que a proveniência precisa sair daqui.** Desde o #6952,
 * `mergeSessionRecords` UNE o `merge_grant` entre o arquivo real e as cópias de
 * conflito do OneDrive, então uma concessão que vive só numa cópia passou a ser
 * ENCONTRADA — e `check-merge-grant` responde `granted: true`. Mas o gate
 * (`block-gh-pr-merge-subagent.mjs`) continua cego a `-safeBackup-` por decisão
 * deliberada do review da PR #6969: *grant é autorização, e autorização não se
 * infere de detrito* — uma cópia de conflito é artefato de uma corrida de sync,
 * não algo que alguém escreveu. Resultado: a beneficiária lê `granted: true`,
 * tenta o merge e é bloqueada, e o diagnóstico natural ("a coordenadora não
 * concedeu" / "expirou") é falso nas duas leituras. Custou o tempo de duas
 * sessões em 01/09/2026.
 *
 * O conserto alinha o diagnóstico PARA BAIXO — quem afirma a concessão avisa
 * que ela não será honrada. O gate **não muda**; esta função só passa a dizer
 * de onde o grant veio, e `check-merge-grant` transforma isso no aviso
 * acionável ("peça reconcessão à coordenadora").
 */
export function findLiveMergeGrant(
  repoRoot: string,
  sessionId: string,
  now: number = Date.now(),
): { grant: MergeGrant; grantedBy: ActiveSessionRecord; source: MergeGrantSource } | null {
  for (const session of listActiveSessions(repoRoot, now)) {
    if (!isCoordinatorKind(session.kind)) continue;
    if (session.stale) continue;
    if (isMergeGrantLive(session.merge_grant, sessionId, now)) {
      const grant = session.merge_grant!;
      return {
        grant,
        grantedBy: session,
        source: mergeGrantLivesInRealFile(repoRoot, grant) ? "real" : "backup",
      };
    }
  }
  return null;
}

/**
 * Marca a concessão como consumida (uso único, #6296). Chamado logo após o
 * `gh pr merge` que a janela autorizou. Retorna `false` quando não havia
 * concessão viva pra consumir — nunca lança.
 */
export function consumeMergeGrant(repoRoot: string, sessionId: string, now: number = Date.now()): boolean {
  const found = findLiveMergeGrant(repoRoot, sessionId, now);
  if (!found) return false;
  const owner = found.grantedBy;
  const path = sessionFilePath(repoRoot, owner.kind, owner.machineTag, owner.sessionId);
  const consumedAt = new Date(now).toISOString();
  const grant = found.grant;

  // #6952 (achado do review INDEPENDENTE da PR): consumir percorre o GRUPO
  // inteiro — arquivo real + toda cópia `-safeBackup-*` —, não só o real.
  //
  // Por que isto passou a ser obrigatório NESTA PR e não era antes: a 2ª
  // metade fez `mergeSessionRecords` UNIR o `merge_grant`, então uma concessão
  // que vive só numa cópia de conflito do OneDrive passou a ser ENCONTRADA por
  // `findLiveMergeGrant`. Consertar a leitura sem consertar a escrita cria um
  // estado novo e pior que o bug original: um grant **encontrável e
  // inconsumível**, vivo pelo TTL inteiro, porque o `consumedAt` era gravado
  // só no arquivo real — que nesse cenário nem carrega o grant. Reproduzido ao
  // vivo: `findLiveMergeGrant` acha, `consumeMergeGrant` devolve `false`, e o
  // grant continua vivo na leitura seguinte.
  //
  // O molde é o do `unclaimIssue` (#6567) logo acima, pelo mesmo motivo e com
  // a mesma disciplina: reescrita cirúrgica de UM campo por cópia, nunca o
  // registro mesclado inteiro por cima de um arquivo do grupo.
  //
  // O retorno passa a afirmar a PÓS-CONDIÇÃO, não o número de escritas: só é
  // `true` se a concessão de fato deixou de estar viva. Um `true` com o grant
  // ainda vivo seria exatamente a mentira que abre uso duplo — o chamador
  // acredita que a janela fechou e ela não fechou.
  // Type guard (não só boolean): os dois call sites precisam do estreitamento
  // pra mexer no grant sem `!`.
  const identityMatches = (g: MergeGrant | undefined): g is MergeGrant =>
    g !== undefined &&
    g.grantedTo === grant.grantedTo &&
    g.grantedBy === grant.grantedBy &&
    g.grantedAt === grant.grantedAt;

  let stamped = false;
  for (const groupPath of [path, ...sessionGroupBackupPaths(repoRoot, path)]) {
    const record = readJsonSafe<SessionRecord>(groupPath);
    // Nada a fazer neste arquivo: ilegível, sem grant, com OUTRA concessão, ou
    // já consumido. Nenhum dos casos é erro — a concessão pode viver em
    // qualquer subconjunto das cópias.
    if (!record || !identityMatches(record.merge_grant) || record.merge_grant?.consumedAt) continue;
    try {
      writeJsonSafeWithCas(
        groupPath,
        (current) => {
          // RECONFERE a identidade DENTRO do lock. O `identityMatches` acima
          // roda antes de pedir o lock, e entre uma coisa e outra a concessão
          // pode ter sido trocada por OUTRA — viva, legítima e de outro
          // beneficiário. Sem esta checagem, carimbamos `consumedAt` na janela
          // alheia e a matamos em silêncio, devolvendo `ok`: o mesmo dano que
          // esta função existe pra evitar, por outra porta.
          //
          // Não basta `if (!current?.merge_grant)`: "existe UMA concessão" não
          // é "existe A concessão que eu vim consumir".
          const onDiskGrant = current?.merge_grant;
          if (!current || !identityMatches(onDiskGrant)) {
            throw new Error(
              "consumeMergeGrant: a concessão neste arquivo mudou entre a conferência e o lock — não é a que veio ser consumida",
            );
          }
          return { ...current, merge_grant: { ...onDiskGrant, consumedAt } };
        },
        // `verify` também confere identidade: só `consumedAt` presente diria
        // "alguma coisa foi carimbada", não "a NOSSA foi".
        (onDisk) =>
          identityMatches(onDisk?.merge_grant) && onDisk?.merge_grant?.consumedAt === consumedAt,
      );
      stamped = true;
    } catch {
      // Uma cópia que falhou não impede consumir as outras — e são as OUTRAS
      // que mantêm a concessão viva na leitura. A pós-condição abaixo é quem
      // decide o desfecho.
    }
  }

  // Fail-open no contrato ("nunca lança"), mas honesto no valor. As DUAS
  // condições são necessárias, e cada uma cobre uma mentira diferente:
  //
  // - `stamped`: carimbamos de fato pelo menos uma cópia da NOSSA concessão.
  //   Sem isto, o caso "a concessão foi trocada por outra enquanto
  //   esperávamos o lock" devolveria `true` — `findLiveMergeGrant` para ESTE
  //   sessionId volta `null` (a janela viva agora é de outro beneficiário), e
  //   reportaríamos "janela consumida" sem ter consumido nada.
  // - a releitura: a janela realmente fechou. Sem isto, uma cópia que falhou
  //   de gravar deixaria a concessão viva e ainda assim diríamos `ok`.
  //
  // Um `true` em qualquer dos dois casos é a mentira que abre uso duplo: o
  // chamador acredita que a janela fechou e age sobre isso.
  return stamped && findLiveMergeGrant(repoRoot, sessionId, now) === null;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

/**
 * Exportado só para teste direto (#5293) — o CLI (main(), abaixo) é o único
 * chamador em produção.
 */
export function requireKind(value: string | undefined): SessionKind {
  if (value === undefined || !(ALL_SESSION_KINDS as readonly string[]).includes(value)) {
    throw new Error(
      `--kind deve ser "overnight", "develop", "continuo", "interactive" ou "continuo-review", recebido "${value}"`,
    );
  }
  return value as SessionKind;
}

/**
 * Como `requireKind`, mas recusa `interactive` (#6168) — usada nos
 * subcomandos que só fazem sentido pra uma coordenadora. Hoje: `grant-merge`
 * (só coordenadora concede janela, #6296).
 */
export function requireCoordinatorKind(value: string | undefined): SessionKind {
  const kind = requireKind(value);
  if (!isCoordinatorKind(kind)) {
    throw new Error(
      `--kind "${kind}" não é uma sessão coordenadora — só overnight/develop/continuo podem executar esta operação. ` +
        "Uma sessão interativa nunca concede janela de merge (nem a si mesma): peça à coordenadora registrada (#6296).",
    );
  }
  return kind;
}

function requireSessionId(values: Record<string, string>): string {
  const sessionId = values["session-id"];
  if (!sessionId) {
    throw new Error(
      "--session-id ausente — normalmente injetado automaticamente por " +
        ".claude/hooks/inject-session-id.mjs a partir do payload do hook PreToolUse. " +
        "Se você está chamando este script fora do harness do Claude Code, passe --session-id explicitamente.",
    );
  }
  return sessionId;
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repositório (#6372) — nunca
 * `process.cwd()` nem `git rev-parse --show-toplevel`, os dois candidatos
 * óbvios que devolvem o WORKTREE atual em vez do checkout principal.
 *
 * `data/` é uma junction/symlink OneDrive que só existe no checkout
 * principal — um `git worktree` vinculado (`.claude/worktrees/agent-*`,
 * onde TODO subagente implementador de overnight/develop/continuo roda,
 * `isolation: "worktree"`) não a herda. Antes deste fix, `main()` resolvia
 * `repoRoot` via `process.cwd()`: uma sessão cujo cwd persistisse dentro de
 * um worktree (`cd` num Bash anterior — o cwd persiste entre chamadas
 * Bash, ver docstring do harness) fazia TODO comando deste CLI
 * (`register`, `claim-issue`, `is-claimed`, `merge-lock-acquire`,
 * `list-active`) criar/ler um `data/sessions/` NOVO e VAZIO dentro do
 * worktree, silenciosamente — exit 0 sempre, sem aviso. Isso desarmava, em
 * silêncio, exatamente os 3 mecanismos que existem pra impedir 2 sessões
 * colidirem na mesma issue/merge.
 *
 * `git rev-parse --path-format=absolute --git-common-dir` aponta pro `.git`
 * REAL compartilhado entre o checkout principal e TODO worktree vinculado
 * do mesmo repositório (mesmo mecanismo de `resolveSharedLockPath` em
 * `scripts/lib/git-sync.ts`, #3430 — verificado empiricamente ali: rodar o
 * comando tanto do checkout principal quanto de dentro de
 * `.claude/worktrees/agent-*` devolve o EXATO mesmo path absoluto). Para o
 * checkout principal, `.git` é um diretório real direto na raiz do repo —
 * `dirname()` desse path é a raiz. `--show-toplevel`, ao contrário, devolve
 * o toplevel do PRÓPRIO worktree (o mesmo bug que `resolveSharedLockPath`
 * já descartou por esse motivo) — não usar.
 *
 * Fail-soft: se o comando git falhar (não é repo git, git indisponível,
 * versão de git anterior a 2.31 sem `--path-format`), cai pra `cwd` —
 * comportamento pré-#6372, correto pro caso comum (processo já rodando na
 * raiz do checkout principal), só reabrindo o gap de worktree quando o git
 * não está disponível pra desambiguar.
 *
 * `cwd` (default `process.cwd()`) existe como parâmetro explícito — não só
 * pra deixar `git rev-parse` correr no diretório certo, mas pra tornar a
 * função testável sem precisar mutar o cwd real do processo de teste
 * (`process.chdir` afetaria QUALQUER outro teste rodando no mesmo processo).
 */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  try {
    const res = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return dirname(res.stdout.trim());
    }
  } catch {
    // git indisponível/timeout — fail-soft pro cwd, ver docstring acima.
  }
  return cwd;
}

function main(): void {
  const argv = process.argv.slice(2);
  const { positional, values, flags } = parseArgs(argv);
  const command = positional[0];
  const repoRoot = resolveRepoRoot();

  try {
    switch (command) {
      case "register": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const pid = values.pid ? Number(values.pid) : undefined;
        const result = registerSession(repoRoot, kind, sessionId, { pid });
        const path = sessionFilePath(repoRoot, kind, result.record.machineTag, sessionId);
        // #6326 fleet review — o CLI precisa IMPRIMIR o desfecho, não só o
        // código carregar o tipo: os 2 casos de falha parcial
        // ("promoted-orphan-left"/"promotion-failed-unreadable") são
        // exatamente o bug que esta issue existe pra consertar voltando em
        // silêncio se o operador só vir "registered {path}" nos 5 casos.
        let suffix = "";
        if (result.outcome === "promoted") {
          suffix = ` (promoted from ${result.promotedFrom})`;
        } else if (result.outcome === "promoted-orphan-left") {
          suffix =
            ` (ATENÇÃO: promovido de ${result.promotedFrom}, mas não foi possível remover o registro antigo — ` +
            "órfão deixado em disco, será recolhido pelo GC)";
        } else if (result.outcome === "promotion-failed-unreadable") {
          suffix =
            ` (ATENÇÃO: registro de outro kind encontrado em ${result.promotedFrom} mas ILEGÍVEL — promoção ` +
            "não aconteceu, registro novo criado do zero)";
        } else if (result.outcome === "reregistered") {
          suffix = " (reregistered)";
        }
        process.stdout.write(`session-registry: registered ${path}${suffix}\n`);
        break;
      }
      case "heartbeat": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const patch: Partial<Pick<SessionRecord, "phase" | "active_worktrees">> = {};
        if (values.phase) patch.phase = values.phase;
        if (values["active-worktrees"]) patch.active_worktrees = Number(values["active-worktrees"]);
        const ok = heartbeat(repoRoot, kind, sessionId, patch);
        process.stdout.write(`session-registry: heartbeat ${ok ? "ok" : "no-op (sessão inexistente)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      case "end": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        // #5797: `--tag` opcional — default `machineTag()` local (comportamento
        // pré-#5797 preservado) permite encerrar o registro de OUTRA máquina
        // (data/sessions/ é compartilhado via OneDrive) sem exigir rodar o
        // comando fisicamente naquela máquina.
        const tag = values.tag ?? machineTag();
        // #6922 (revisado): recusa encerrar o tick só quando a sujeira é
        // ATRIBUÍVEL à própria sessão (interseção com touched_paths/
        // dirty_paths do próprio registro, lido ANTES de endSession remover
        // o arquivo) — ver docstring de `evaluateEndGuard` acima.
        // `--allow-dirty` bypassa de propósito (mesmo em sujeira própria).
        const ownRecordPath = sessionFilePath(repoRoot, kind, tag, sessionId);
        const ownRecord = readJsonSafe<SessionRecord>(ownRecordPath);
        const ownPaths = [...(ownRecord?.touched_paths ?? []), ...(ownRecord?.dirty_paths ?? [])];
        const endGuard = evaluateEndGuard(repoRoot, flags.has("allow-dirty"), ownPaths);
        if (!endGuard.ok) {
          process.stdout.write(endGuard.message ?? "session-registry: end recusado (árvore suja)\n");
          process.exitCode = 1;
          break;
        }
        if (endGuard.warning) process.stderr.write(endGuard.warning);
        // ORDEM IMPORTANTE, e o motivo não é legibilidade (#6952): o guard
        // acima é LEITURA PURA (`git status` + interseção de paths) e é o
        // único dos dois passos que pode dizer "não prossiga". O `endSession`
        // abaixo começa quebrando `.lock` órfão — AÇÃO DESTRUTIVA sobre
        // estado compartilhado, porque outro processo pode estar prestes a
        // adquirir aquele lock legitimamente.
        //
        // Invertendo (quebrar o lock e só então avaliar o guard), uma recusa
        // deixa o sistema PIOR do que se ninguém tivesse tentado: lock de
        // terceiro quebrado e nada encerrado. Como o guard não tem efeito
        // colateral, adiá-lo não compra nada.
        //
        // A regra geral: **ação destrutiva por último, depois de todas as
        // recusas possíveis.**
        const removed = endSession(repoRoot, kind, sessionId, tag);
        if (removed) {
          process.stdout.write("session-registry: ended\n");
        } else {
          process.stdout.write(
            "session-registry: nothing to end (registro não encontrado — tag/session-id conferem?)\n",
          );
          process.exitCode = 1;
        }
        break;
      }
      case "claim-issue": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const force = flags.has("force");
        // #6369: sessão sem registro prévio (ex: ciclo `continuo` do cron
        // Hermes chamando `claim-issue` antes de qualquer `register`) não
        // vira mais no-op silencioso — `claimIssueAutoRegistering` registra
        // uma sessão mínima e tenta de novo, sinalizando isso na mensagem.
        const result = claimIssueAutoRegistering(repoRoot, kind, sessionId, issue, undefined, undefined, { force });
        // #7003: as duas causas de "registro ausente" imprimem mensagens
        // DIFERENTES. A antiga ("não tinha registro prévio") descrevia a
        // sessão nova; usá-la também pro caso da âncora sumindo com a sessão
        // viva foi o que fez a perda de 7 claims passar como rotina.
        const autoRegisterSuffix = !result.autoRegistered
          ? ""
          : result.autoRegisterMode === "recovered-from-orphan-backups"
            ? ` [ALERTA: a ÂNCORA desta sessão SUMIU do disco com a sessão VIVA — reconstruída de ` +
              `${result.recoveredFromFiles} cópia(s) de conflito do OneDrive, ` +
              `${(result.recoveredClaims ?? []).length} claim(s) recuperada(s)` +
              `${(result.recoveredClaims ?? []).length > 0 ? `: #${(result.recoveredClaims ?? []).join(", #")}` : ""}` +
              ". Isto é escrita concorrente, não sessão nova — ver #7002/#7003]"
            : " [ATENÇÃO: sessão não tinha registro prévio — auto-registrada agora antes do claim, ver #6369]";
        switch (result.reason) {
          case "claimed":
            process.stdout.write(
              `session-registry: claim-issue ok (claimed)${autoRegisterSuffix} [repoRoot=${repoRoot}]\n`,
            );
            break;
          case "already-own":
            process.stdout.write(
              `session-registry: claim-issue ok (already-own, no-op)${autoRegisterSuffix} [repoRoot=${repoRoot}]\n`,
            );
            break;
          case "forced-override": {
            const owner = result.blockedBy;
            process.stdout.write(
              `session-registry: claim-issue ok (FORCED — tomado de ${owner?.kind}-${owner?.sessionId} ` +
                `desde ${owner?.startedAt}, heartbeat ${owner?.lastHeartbeat})${autoRegisterSuffix} [repoRoot=${repoRoot}]\n`,
            );
            break;
          }
          case "no-op-session-missing":
            // Não deveria mais acontecer depois do auto-registro acima — só
            // sobra se o próprio `registerSession` falhar em silêncio (não
            // deveria: `writeJsonSafe` lança em erro de I/O real). Mantido
            // como rede de segurança — nunca finge sucesso.
            process.stdout.write(
              "session-registry: claim-issue no-op (sessão inexistente mesmo após tentativa de auto-registro)\n",
            );
            process.exitCode = 1;
            break;
          case "blocked-by-other": {
            const owner = result.blockedBy;
            process.stdout.write(
              `session-registry: claim-issue RECUSADO — issue #${issue} já está reivindicada por ` +
                `${owner?.kind}-${owner?.machineTag}-${owner?.sessionId} (desde ${owner?.startedAt}, ` +
                `último heartbeat ${owner?.lastHeartbeat}). Use --force para tomar mesmo assim.\n`,
            );
            process.exitCode = 1;
            break;
          }
        }
        break;
      }
      case "unclaim-issue": {
        const kind = requireKind(values.kind);
        const sessionId = requireSessionId(values);
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const result = unclaimIssue(repoRoot, kind, sessionId, issue);
        switch (result.reason) {
          case "unclaimed":
            process.stdout.write(`session-registry: unclaim-issue ok (issue #${issue} liberada)\n`);
            break;
          case "no-op-not-claimed":
            process.stdout.write(
              `session-registry: unclaim-issue no-op (issue #${issue} não estava reivindicada por esta sessão)\n`,
            );
            process.exitCode = 1;
            break;
          case "no-op-session-missing":
            process.stdout.write("session-registry: unclaim-issue no-op (sessão inexistente)\n");
            process.exitCode = 1;
            break;
          case "no-op-unreadable":
            process.stdout.write(
              "session-registry: unclaim-issue no-op — registro EXISTE mas está ILEGÍVEL agora (JSON corrompido/" +
                "parcialmente sincronizado pelo OneDrive). A claim pode estar ATIVA — isto NÃO é 'sessão " +
                "inexistente'; investigar antes de assumir que não há nada pra soltar (aviso já emitido em " +
                "stderr).\n",
            );
            process.exitCode = 1;
            break;
        }
        break;
      }
      case "is-claimed": {
        const issue = Number(values.issue);
        if (!Number.isInteger(issue)) throw new Error("--issue deve ser um inteiro");
        const excludeSessionId = values["session-id"] ?? "";
        const owner = isIssueClaimedByOther(repoRoot, issue, excludeSessionId);
        process.stdout.write(JSON.stringify({ claimed: owner !== null, by: owner }) + "\n");
        break;
      }
      case "list-active": {
        const sessions = listActiveSessions(repoRoot);
        process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
        break;
      }
      case "active-of-kind": {
        // #6277 item 3 — "há uma rodada deste kind acontecendo agora?".
        // Sempre exit 0 (mesmo padrão de `is-claimed`): a resposta é o JSON,
        // não o exit code — "não há overnight ativo" é resposta válida, não erro.
        const kind = requireKind(values.kind);
        const excludeSessionId = values["session-id"];
        // `uncertain` vem ANTES da varredura: se `data/sessions/` existe mas
        // não pôde ser lido, `active: false` significa "não deu pra saber",
        // não "não há sessão". O chamador deve fail-CLOSED nesse caso —
        // tratar como se houvesse overnight rodando (#6277, achado do review).
        const health = checkSessionsScanHealth(repoRoot);
        const sessions = findActiveSessionsOfKind(repoRoot, kind, excludeSessionId);
        const stale = findStaleSessionsOfKind(repoRoot, kind, excludeSessionId);
        process.stdout.write(
          JSON.stringify(
            {
              kind,
              active: hasActiveSessionOfKind(repoRoot, kind, excludeSessionId),
              uncertain: !health.ok,
              ...(health.ok ? {} : { ioError: health.error }),
              sessions,
              stale,
            },
            null,
            2,
          ) + "\n",
        );
        break;
      }
      case "merge-lock-acquire": {
        const sessionId = requireSessionId(values);
        const ok = acquireMergeLock(repoRoot, sessionId);
        process.stdout.write(
          `session-registry: merge-lock-acquire ${ok ? "ok" : "denied (held by another session)"} [repoRoot=${repoRoot}]\n`,
        );
        const activeSessions = listActiveSessions(repoRoot);
        // #7169 direção (c) — "guard de frescor": nunca muda o resultado do
        // `ok` acima (o lock continua advisory entre máquinas, #6182), só
        // torna VISÍVEL um sinal hoje mudo. Aviso em stderr (nunca stdout,
        // que é lido por script) quando alguma coordenadora de OUTRA máquina
        // parece com o registro sincronizado desatualizado — `ok: true` aqui
        // pode não significar "de fato livre", só "livre segundo dados que
        // podem estar até 1h+ velhos" (incidente de origem: onedrive.service
        // morto por 1h13 sem alarme).
        const freshness = assessCrossMachineSyncFreshness(activeSessions, Date.now());
        if (freshness.stale) {
          const names = freshness.staleSessions
            .map((s) => `${s.kind}-${s.machineTag}-${s.sessionId} (heartbeat de ${s.lastHeartbeat})`)
            .join(", ");
          process.stderr.write(
            `session-registry: ATENÇÃO (#7169) — registro de coordenadora de OUTRA máquina parece DESATUALIZADO ` +
              `(mais de ${Math.round(CROSS_MACHINE_HEARTBEAT_LAG_WARN_MS / 60000)}min sem heartbeat, mas ainda dentro ` +
              `do limiar de 90min que a marcaria stale): ${names}. Isto pode significar sync cross-máquina ` +
              `degradado (data/sessions/ mora em junction OneDrive) — o resultado acima (${ok ? "ok" : "denied"}) ` +
              "pode não refletir o estado real daquela máquina agora. Mitigação: `git fetch origin master` e " +
              "conferir se o head mudou antes de confiar no merge lock/grant cross-máquina.\n",
          );
        }
        // #7043 achado 2 — o lock É advisory entre máquinas (#6182: cada
        // máquina vê um inode distinto no mesmo junction OneDrive, `O_EXCL`
        // não é exclusão mútua real ali), mas até aqui `acquire` respondia
        // `ok` IDÊNTICO esteja ou não em cenário cross-máquina — quem lê não
        // tinha como saber que a garantia era fraca. Diferente do aviso de
        // frescor acima (que só dispara com heartbeat DESATUALIZADO), este
        // aviso é sobre a garantia em si: dispara sempre que `ok` e existe
        // QUALQUER coordenadora ativa (mesmo fresca) numa máquina diferente
        // — porque mesmo com dado fresco, a exclusão entre máquinas não é
        // atômica.
        const myTag = machineTag();
        if (ok) {
          const peers = activeSessions.filter(
            (s) => !s.stale && isCoordinatorKind(s.kind) && s.machineTag !== myTag,
          );
          if (peers.length > 0) {
            const names = [...new Set(peers.map((s) => s.machineTag))].join(", ");
            process.stderr.write(
              `session-registry: AVISO (#7043) — lock adquirido, mas há coordenadora ativa em outra(s) máquina(s) ` +
                `(${names}): a exclusão entre máquinas é ADVISORY, não garantida (#6182) — ambas podem ter recebido ` +
                '"ok" pro mesmo lock. Confie no lock sozinho só na mesma máquina; entre máquinas, combine por ' +
                "outro canal (mensagem direta) antes de mergear.\n",
            );
          }
        }
        if (!ok) process.exitCode = 1;
        break;
      }
      case "merge-lock-release": {
        const sessionId = requireSessionId(values);
        // #7043 achado 2 — lê QUEM detém o lock ANTES de tentar liberar, pra
        // poder distinguir (depois de `releaseMergeLock` recusar) "esperado,
        // advisory" de erro de verdade. `releaseMergeLock` já recusa liberar
        // lock alheio (nunca lança) — a leitura aqui é só pra mensagem, sem
        // mudar essa decisão.
        const heldByBefore = readJsonSafe<MergeLockRecord>(mergeLockPath(repoRoot))?.heldBy;
        const ok = releaseMergeLock(repoRoot, sessionId);
        if (ok) {
          process.stdout.write("session-registry: merge-lock-release ok\n");
          break;
        }
        // Achou o dono atual entre as sessões ativas pra saber se é uma
        // corrida cross-máquina (esperada, advisory — #6182) ou algo que não
        // deveria acontecer (mesma máquina, onde `O_EXCL` é exclusão real).
        const holder = heldByBefore ? listActiveSessions(repoRoot).find((s) => s.sessionId === heldByBefore) : undefined;
        const crossMachine = holder !== undefined && holder.machineTag !== machineTag();
        if (crossMachine) {
          // Erro é o sinal ERRADO pra comportamento documentado e esperado
          // (#6182 já prevê isto) — treina quem opera a ignorar a saída do
          // comando. `exit 0`: não é uma falha desta chamada, é o desfecho
          // correto de uma corrida cross-máquina que o próprio desenho
          // admite como possível.
          process.stdout.write(
            `session-registry: merge-lock-release no-op — lock já pertence a outra sessão de OUTRA máquina ` +
              `(${holder.kind}-${holder.machineTag}-${holder.sessionId}), corrida cross-máquina ESPERADA (advisory, ` +
              "#6182/#7043) — não é erro. Se o merge que este release protegia já saiu, confira `git log` antes de " +
              "reagir.\n",
          );
        } else {
          process.stdout.write(
            "session-registry: merge-lock-release denied (held by another session)" +
              (holder ? ` — ${holder.kind}-${holder.machineTag}-${holder.sessionId}` : "") +
              "\n",
          );
          process.exitCode = 1;
        }
        break;
      }
      case "merge-lock-renew": {
        // #6334: renova o TTL de um hold que a PRÓPRIA sessão já detém —
        // nunca concede um hold novo (ver docblock de `renewMergeLock`).
        const sessionId = requireSessionId(values);
        const ok = renewMergeLock(repoRoot, sessionId);
        process.stdout.write(`session-registry: merge-lock-renew ${ok ? "ok" : "denied (not held by this session)"}\n`);
        if (!ok) process.exitCode = 1;
        break;
      }
      case "conflicts": {
        // #6168 Parte C — CONSULTA, nunca aquisição: não cria arquivo nenhum.
        // exit 1 = sobreposição real com peer VIVO; exit 0 = livre (inclusive
        // quando o único peer sobreposto está stale).
        const sessionId = values["session-id"] ?? "";
        const paths = (values.paths ?? "")
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "");
        const branch = values.branch;
        const tag = values.tag ?? machineTag();
        const sessions = listActiveSessions(repoRoot);
        const ownRecord = sessions.find((s) => s.sessionId === sessionId) ?? null;
        const opts: FindSessionConflictsOptions = { sessionId, paths, ownRecord, machineTag: tag };
        if (branch) opts.branch = branch;
        const conflicts = findSessionConflicts(sessions, opts);
        process.stdout.write(JSON.stringify({ conflicts, count: conflicts.length }, null, 2) + "\n");
        if (conflicts.length > 0) process.exitCode = 1;
        break;
      }
      case "grant-merge": {
        // #6296 — só coordenadora concede, e nunca a si mesma.
        // #6331: `--kind` é da sessão CONCEDENTE (a própria, coordenadora),
        // nunca da beneficiária em `--granted-to` — mensagem dedicada aqui
        // porque este é o único subcomando com dois sujeitos de sessão, e a
        // leitura errada ("--kind é da beneficiária") sucede em silêncio.
        if (values.kind === undefined) {
          throw new Error(
            '--kind ausente — é o kind da sessão CONCEDENTE (a SUA, a coordenadora que está chamando grant-merge), ' +
              'nunca da beneficiária em --granted-to. Deve ser "overnight", "develop" ou "continuo". ' +
              "Ex: grant-merge --kind develop --granted-to <sessionId-do-beneficiario> [--pr N] [--force].",
          );
        }
        const kind = requireCoordinatorKind(values.kind);
        const sessionId = requireSessionId(values);
        const grantedTo = values["granted-to"];
        if (!grantedTo) throw new Error("--granted-to (sessionId de quem recebe a janela) é obrigatório");
        const pr = values.pr ? Number(values.pr) : undefined;
        const force = flags.has("force");
        const result = grantMergeWindow(repoRoot, kind, sessionId, grantedTo, {
          ...(pr !== undefined ? { pr } : {}),
          ...(force ? { force } : {}),
        });
        switch (result.reason) {
          case "granted":
            process.stdout.write(
              `session-registry: grant-merge ok — janela concedida a ${grantedTo}` +
                `${pr !== undefined ? ` (PR #${pr})` : ""}, TTL ${Math.round(MERGE_GRANT_TTL_MS / 60000)}min, uso único\n`,
            );
            break;
          case "self-grant-refused":
            process.stdout.write(
              "session-registry: grant-merge RECUSADO — uma sessão nunca concede janela a si mesma (#6296). " +
                "É isso que preserva a propriedade do #5716 em vez de contorná-la.\n",
            );
            process.exitCode = 1;
            break;
          case "not-a-coordinator":
            process.stdout.write("session-registry: grant-merge RECUSADO — só overnight/develop/continuo concedem\n");
            process.exitCode = 1;
            break;
          case "grantee-is-coordinator-refused":
            process.stdout.write(
              `session-registry: grant-merge RECUSADO — ${grantedTo} é uma sessão COORDENADORA ativa (#6303). ` +
                "Coordenadora já tem direito de mergear por si; o que ela precisa respeitar é o merge lock, e " +
                "conceder entre pares seria justamente um jeito de contorná-lo. A concessão existe pra quem NÃO " +
                "tem identidade de coordenadora (tipicamente uma sessão interativa). Se as duas rodadas precisam " +
                "mergear, elas se serializam pelo merge-lock-acquire, não por concessão.\n",
            );
            process.exitCode = 1;
            break;
          case "no-op-session-missing":
            // #6999 (fix 2): `grant-merge` é o único subcomando com DOIS
            // sujeitos de sessão, e "sessão inexistente" mandava o operador
            // conferir a errada — a leitura natural é a beneficiária, que
            // acabou de ser digitada, quando a não-encontrada é sempre a
            // CONCEDENTE (a beneficiária nem precisa estar registrada).
            process.stdout.write(
              "session-registry: grant-merge no-op — a sessão CONCEDENTE (a SUA, não a de --granted-to) não foi " +
                `encontrada em data/sessions/. Procurado: kind="${kind}", sessionId="${sessionId}", arquivo ` +
                `"${sessionFilePath(repoRoot, kind, machineTag(), sessionId)}". A beneficiária ` +
                `"${grantedTo}" NÃO é o problema aqui (ela nem precisa estar registrada). Causas típicas: ` +
                "--session-id de outra sessão, --kind diferente do que foi registrado, ou a âncora sumiu sem " +
                `nenhuma cópia de conflito viva pra reconstruir (#7002). Registre a concedente ("register --kind ${kind}") antes de conceder.\n`,
            );
            process.exitCode = 1;
            break;
          case "live-grant-would-be-overwritten":
            // #7043 achado 1 (1º caminho).
            process.stdout.write(
              "session-registry: grant-merge RECUSADO — você já tem uma concessão VIVA e NÃO-CONSUMIDA pra outra " +
                `identidade (grantedTo="${result.grant?.grantedTo}"${result.grant?.pr !== undefined ? `, PR #${result.grant.pr}` : ""}). ` +
                "`merge_grant` é campo único: conceder esta agora apagaria aquela em silêncio, sem a beneficiária " +
                "original nunca saber que perdeu a janela (#7043). Se a concessão anterior de fato não é mais " +
                "necessária, repita com --force pra sobrescrever deliberadamente.\n",
            );
            process.exitCode = 1;
            break;
          case "pr-already-granted-elsewhere":
            // #7043 achado 1 (2º caminho).
            process.stdout.write(
              `session-registry: grant-merge RECUSADO — o PR #${pr} já tem concessão viva emitida por OUTRA ` +
                `coordenadora (grantedTo="${result.grant?.grantedTo}"). Duas concessões pro mesmo PR não se ` +
                "enxergam entre records — a 2ª sobrescreveria a 1ª em silêncio (#7043). Confirme com a outra " +
                "coordenadora antes de reconceder, ou repita com --force se for deliberado.\n",
            );
            process.exitCode = 1;
            break;
        }
        break;
      }
      case "check-merge-grant": {
        const sessionId = requireSessionId(values);
        const found = findLiveMergeGrant(repoRoot, sessionId);
        // #6972: `source` e `visible_to_merge_gate` são ADITIVOS — `granted`/
        // `grant`/`grantedBy` seguem com a mesma forma pra quem já consome
        // este JSON.
        //
        // O nome é `visible_`, não `honored_`, de propósito: `false` afirma
        // com certeza que o gate NÃO vai honrar (ele nem enxerga o arquivo),
        // mas `true` só diz que ESTA causa de bloqueio não se aplica — o gate
        // ainda checa escopo de PR (#6322), staleness e identidade. Prometer
        // "será honrado" reintroduziria, invertida, a confusão que a #6972
        // existe pra remover.
        process.stdout.write(
          JSON.stringify({
            granted: found !== null,
            grant: found?.grant ?? null,
            grantedBy: found?.grantedBy ?? null,
            source: found?.source ?? null,
            visible_to_merge_gate: found === null ? null : found.source === "real",
          }) + "\n",
        );
        if (found && found.source === "backup") {
          // Aviso em stderr (nunca no stdout, que é JSON consumido por script):
          // a janela EXISTE na união do #6952 mas o gate do #5716 é cego a
          // cópia de conflito por decisão deliberada e NÃO vai honrá-la.
          process.stderr.write(
            "session-registry: ATENÇÃO — janela encontrada, mas SÓ em cópia de conflito do OneDrive " +
              "(-safeBackup-): o gate de merge NÃO a honra e o `gh pr merge` será bloqueado assim mesmo. " +
              "Isto não é 'a coordenadora não concedeu' nem 'expirou' — peça RECONCESSÃO à coordenadora " +
              `(${found.grantedBy.kind}-${found.grantedBy.sessionId}) pra que o grant volte a existir no ` +
              "arquivo real (#6972).\n",
          );
        }
        if (!found) process.exitCode = 1;
        break;
      }
      case "consume-merge-grant": {
        // #7171: este subcomando SÓ deveria ser chamado pelo hook automático
        // `.claude/hooks/consume-merge-grant-on-merge.mjs`, DEPOIS que
        // `gh pr merge` sucede — nunca à mão, e nunca antes. Rodar isto antes
        // do merge queima a própria janela e o `gh pr merge` seguinte é
        // bloqueado pelo guard do #5716, mesmo com `check-merge-grant` tendo
        // confirmado `granted: true` segundos antes (o "ok" abaixo não
        // distingue os dois casos — por isso o aviso explícito aqui).
        const sessionId = requireSessionId(values);
        const ok = consumeMergeGrant(repoRoot, sessionId);
        // #7223 review — o aviso vai pro STDERR, nunca stdout: stdout é lido
        // como payload por script (mesmo padrão de merge-lock-acquire acima),
        // e a linha "ok/no-op" sozinha já é o contrato de saída esperado.
        process.stdout.write(
          `session-registry: consume-merge-grant ${ok ? "ok (janela consumida — uso único)" : "no-op (nenhuma janela viva)"}\n`,
        );
        process.stderr.write(
          "session-registry: ATENÇÃO (#7171) — chamar isto ANTES do `gh pr merge` queima a janela e o merge " +
            "seguinte será bloqueado. O caminho feliz nunca inclui `consume-merge-grant` explícito: " +
            "grant-merge (coordenadora) → check-merge-grant → merge-lock-acquire → gh pr merge → " +
            "merge-lock-release. `consumedAt` é o carimbo que o MERGE bem-sucedido deixa (automaticamente, " +
            "via .claude/hooks/consume-merge-grant-on-merge.mjs) — não um passo prévio.\n",
        );
        if (!ok) process.exitCode = 1;
        break;
      }
      case "self-authorize-merge": {
        // #7303: escape hatch pro caso em que `gh pr merge` está bloqueado
        // pelo guard do #5716 e a ÚNICA coordenadora ativa é `continuo`
        // (cron, não conversa) — pedir `grant-merge` a ela é estruturalmente
        // impossível. Ver docstring de `selfAuthorizeMerge` pro escopo
        // completo (as 4 recusas existem pra nunca abrir mão de proteção
        // nenhuma que já vale pra uma rodada supervisionada normal).
        const sessionId = requireSessionId(values);
        const reasonArg = values.reason;
        if (!reasonArg || reasonArg.trim() === "") {
          throw new Error(
            "--reason (não-vazio) é obrigatório — nunca uma auto-autorização silenciosa (#7303). " +
              'Ex: self-authorize-merge --reason "única coordenadora ativa é continuo, sem interlocutor" [--pr N].',
          );
        }
        const pr = values.pr ? Number(values.pr) : undefined;
        const result = selfAuthorizeMerge(repoRoot, sessionId, { reason: reasonArg, ...(pr !== undefined ? { pr } : {}) });
        switch (result.reason) {
          case "authorized":
            process.stdout.write(
              `session-registry: self-authorize-merge ok — auto-autorizado${pr !== undefined ? ` (PR #${pr})` : ""}, ` +
                `TTL ${Math.round(MERGE_GRANT_TTL_MS / 60000)}min. Isto NÃO dispensa o merge lock: rode ` +
                "merge-lock-acquire --pr N ANTES do gh pr merge — a auto-autorização destrava identidade, " +
                "nunca tempo, mesmo princípio de grant-merge (#6303 P1·a).\n",
            );
            break;
          case "reason-required":
            process.stdout.write("session-registry: self-authorize-merge RECUSADO — --reason vazio\n");
            process.exitCode = 1;
            break;
          case "no-active-coordinator":
            process.stdout.write(
              "session-registry: self-authorize-merge no-op — nenhuma coordenadora ativa registrada. gh pr merge " +
                "provavelmente já não está bloqueado pelo guard do #5716 (ele só bloqueia havendo rodada ativa) — " +
                "não há nada pra contornar aqui.\n",
            );
            process.exitCode = 1;
            break;
          case "responsive-coordinator-active":
            process.stdout.write(
              `session-registry: self-authorize-merge RECUSADO — há coordenadora(s) ativa(s) que CONVERSA(M): ` +
                `${result.coordinatorKinds?.join(", ")}. O caminho normal continua sendo o único: peça a janela via ` +
                "grant-merge dela. Este comando só existe pro caso em que NENHUMA coordenadora ativa consegue " +
                "responder (só continuo).\n",
            );
            process.exitCode = 1;
            break;
          case "caller-is-coordinator":
            process.stdout.write(
              "session-registry: self-authorize-merge no-op — você já é uma coordenadora REGISTRADA e ativa; já " +
                "tem direito de mergear por si (o guard te reconhece via isCoordinator), sem precisar deste " +
                "comando.\n",
            );
            process.exitCode = 1;
            break;
          case "session-not-registered":
            process.stdout.write(
              "session-registry: self-authorize-merge RECUSADO — esta sessão ainda não tem registro em " +
                "data/sessions/ (o beacon cria um na 1ª chamada de ferramenta). Rode qualquer outro comando " +
                "(ex: git status) e tente de novo.\n",
            );
            process.exitCode = 1;
            break;
        }
        break;
      }
      case "gc": {
        const maxAgeDaysRaw = values["max-age-days"];
        const conservativeMaxAgeMs =
          maxAgeDaysRaw !== undefined ? Number(maxAgeDaysRaw) * 24 * 60 * 60 * 1000 : undefined;
        if (maxAgeDaysRaw !== undefined && (!Number.isFinite(conservativeMaxAgeMs) || conservativeMaxAgeMs! <= 0)) {
          throw new Error(`--max-age-days deve ser um número positivo, recebido "${maxAgeDaysRaw}"`);
        }
        const opts = conservativeMaxAgeMs !== undefined ? { conservativeMaxAgeMs } : {};
        const isDryRun = flags.has("dry-run");
        const plan = isDryRun ? planSessionGc(repoRoot, opts) : garbageCollectSessions(repoRoot, opts);
        for (const entry of plan) {
          const verb = isDryRun && entry.action === "removed" ? "would-remove" : entry.action;
          process.stdout.write(`session-registry: gc ${verb} ${entry.identity} (${entry.files.length} arquivo(s)) — ${entry.reason}\n`);
        }
        const removedCount = plan.filter((e) => e.action === "removed").length;
        process.stdout.write(
          `session-registry: gc ${isDryRun ? "--dry-run: " : ""}${removedCount}/${plan.length} identidade(s) ${isDryRun ? "seriam removidas" : "removidas"}\n`,
        );
        break;
      }
      default:
        process.stderr.write(
          "uso: npx tsx scripts/lib/session-registry.ts <register|heartbeat|end|claim-issue|unclaim-issue|is-claimed|" +
            "list-active|active-of-kind|conflicts|grant-merge|check-merge-grant|consume-merge-grant|self-authorize-merge|" +
            "merge-lock-acquire|merge-lock-release|merge-lock-renew|gc> [--kind overnight|develop|continuo|interactive|continuo-review] [--session-id X] [--tag MAQUINA] ...\n" +
            "  unclaim-issue --issue N: inverso de claim-issue (#6317) — remove a issue de claimed_issues da PRÓPRIA " +
            "sessão; nunca mexe na claim de outra. No-op honesto (exit 1) se a issue não estava reivindicada por ela.\n" +
            "  active-of-kind --kind K [--session-id X]: JSON {kind, active, sessions, stale} — há sessão ATIVA " +
            "(não-stale) do kind K? `--session-id` exclui a própria sessão da resposta (#6277).\n" +
            "  --tag (só \"end\"): machineTag() da sessão a encerrar (default: machineTag() local) — necessário " +
            "pra encerrar da máquina local o registro de OUTRA máquina em data/sessions/ (#5797).\n" +
            "  --allow-dirty (só \"end\"): bypassa a recusa (#6922) — a recusa em si já só dispara quando a " +
            "sujeira intersecta touched_paths/dirty_paths da PRÓPRIA sessão; sujeira alheia de outra sessão " +
            "concorrente no mesmo checkout prossegue com aviso, nunca exit 1.\n" +
            "  conflicts [--paths a,b] [--branch X]: CONSULTA (#6168) — quem mais está mexendo nisto agora. " +
            "exit 1 = sobreposição com peer VIVO; exit 0 = livre. Nunca cria arquivo nem adquire nada.\n" +
            "  grant-merge --kind {overnight|develop|continuo} --granted-to X [--pr N] [--force]: concede janela de " +
            "merge a OUTRA sessão (#6296) — --kind é da sessão CONCEDENTE (a sua, obrigatório, #6331), nunca da " +
            "beneficiária em --granted-to; só coordenadora concede, nunca a si mesma; TTL curto, uso único. " +
            "Recusa (#7043) sobrescrever uma concessão VIVA de OUTRA identidade (sua própria ou de outra " +
            "coordenadora pro mesmo PR) — --force força a sobrescrita deliberada. " +
            "check-merge-grant é o lado de quem recebeu, pra CONFIRMAR a concessão antes de mergear. " +
            "consume-merge-grant NÃO é um passo do beneficiário (#7171) — quem carimba consumedAt é o " +
            "gh pr merge bem-sucedido, automaticamente via .claude/hooks/consume-merge-grant-on-merge.mjs; " +
            "chamar consume-merge-grant à mão ANTES do merge queima a janela e o merge seguinte é bloqueado. " +
            "Ordem correta: grant-merge (coordenadora) -> check-merge-grant -> merge-lock-acquire --pr N -> " +
            "gh pr merge N -> merge-lock-release --pr N. --pr nao e opcional na pratica (#7169/#7223) — " +
            "sem ele, gh pr merge foi bloqueado repetidamente pelo guard #5716 mesmo com lock adquirido.\n" +
            "  self-authorize-merge --reason \"...\" [--pr N] (#7303): escape hatch pra quando gh pr merge está " +
            "bloqueado e a ÚNICA coordenadora ativa é continuo (cron, não conversa — grant-merge normal é " +
            "estruturalmente inalcançável). Recusa se houver coordenadora overnight/develop ativa (peça " +
            "grant-merge dela) ou se você já for coordenadora. --reason é obrigatório. Mesma composição com o " +
            "merge lock de grant-merge — ainda precisa de merge-lock-acquire --pr N antes do gh pr merge.\n" +
            "  gc [--max-age-days N] [--dry-run]: remove registro de sessão ENCERRADA — nunca por staleness de " +
            "heartbeat sozinha, ver docstring de decideSessionGc/planSessionGc (#6130).\n",
        );
        process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write(`session-registry: erro — ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
