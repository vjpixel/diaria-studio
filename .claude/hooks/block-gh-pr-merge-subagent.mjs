// PreToolUse hook — bloqueia `gh pr merge` quando a chamada vem de um
// SUBAGENTE implementador de `/diaria-overnight`/`/diaria-develop`/
// `/diaria-continuo`, nunca do coordenador top-level dessas rodadas (#5716).
//
// Incidente de origem (2ª ocorrência — a 1ª foi #4740, incidente 260806b):
// sessão `/diaria-develop 260819d`, PR #5713. O subagente implementador leu
// a Regra 11 de `context/overnight-dispatch-rules.md` ("nenhum subagente
// implementador espera CI, roda fleet review, ou chama `gh pr merge` por
// conta própria — isso é trabalho do coordenador top-level"), e a violou
// mesmo assim: mergeou o próprio PR enquanto um fixer despachado pelo
// coordenador ainda escrevia o teste de regressão que fechava o último
// achado do fleet review. O fix entrou em master sem cobertura. A regra
// existia só como prosa — nenhum hook impedia a chamada. Este hook fecha essa
// lacuna mecanicamente.
//
// Mecanismo: `scripts/lib/session-registry.ts` (write-side usado pelas 3
// skills via `register --kind overnight|develop|continuo`) grava um arquivo
// por sessão COORDENADORA ativa em `data/sessions/{kind}-{tag}-{sessionId}.json`.
// Subagentes implementadores despachados via `Agent` NUNCA chamam esse
// `register` (não são as skills `/diaria-overnight`/`/diaria-develop`/
// `/diaria-continuo` — são subagentes ad-hoc lendo um prompt de dispatch) e
// rodam com `session_id` PRÓPRIO, diferente do coordenador que os despachou
// (mesmo fato que `block-askuserquestion-overnight-autonomous.mjs` e
// `pr-create-review.mjs` já assumem ao comparar `payload.session_id` contra
// o `session_id` gravado por quem escreveu o marker/registro).
//
// Esse fato dá o discriminador: se existe pelo menos uma rodada
// overnight/develop/continuo ATIVA registrada (`data/sessions/*.json`) e o
// `session_id` da chamada ATUAL não é o de NENHUMA dessas sessões
// registradas, a chamada não pode ser do coordenador dessa(s) rodada(s) — só
// pode ser um subagente despachado por ela (ou, no pior caso, outra sessão
// interativa não-relacionada rodando em paralelo na mesma máquina, ver
// "Trade-off aceito" abaixo). Bloqueia.
//
// Nenhuma rodada ativa registrada → nunca bloqueia: é o caminho de uma sessão
// interativa comum, que o #5251 já autoriza a mergear sozinha sem confirmação
// (`gh pr merge` de sessão interativa nunca passa por `register`).
//
// `session_id` da chamada ATUAL bate com algum registro ativo → é o próprio
// coordenador mergeando (ex: overnight/develop encerrando um ciclo depois do
// Gate 2) → permite, **exceto duas exceções pós-#6296** (achado do fleet
// review #6303, Finding O — o resumo acima descrevia uma regra binária que o
// guard deixou de implementar):
//   - o merge lock (`data/sessions/.merge-lock.json`) está na mão de OUTRA
//     coordenadora → bloqueia mesmo sendo coordenadora registrada (há
//     contenção real entre duas rodadas, ver `shouldBlockGhPrMerge`);
//   - concessão de janela (`merge_grant`, #6296) viva pra uma sessão
//     NÃO-coordenadora → permite mesmo ela não batendo com nenhum registro
//     ativo — é o caminho legítimo da sessão interativa, ver
//     `readLiveMergeGrantFor` abaixo.
//

// Trade-off aceito (documentado, não escondido): este guard não distingue
// "subagente desta rodada" de "outra sessão interativa não-relacionada rodando
// em paralelo na mesma máquina enquanto uma rodada overnight/develop está
// ativa" — ambas têm `session_id` ausente do registro. Diferente dos hooks
// irmãos (que preferem fail-open sempre — permitir na dúvida), este guard
// prefere bloquear na dúvida: o custo de um falso positivo aqui é a PR ficar
// aberta esperando um merge manual (retomável, sem dano); o custo de um falso
// negativo é exatamente o incidente que gerou a #5716 (merge sem review do
// coordenador, dano real e mensurável). Ver item 2 da issue #5716 ("expor
// subagente ainda vivo") — não implementado aqui, seria mitigação
// complementar, não substituto deste guard.
//
// Fail-open só nos casos onde não dá pra avaliar o risco de forma alguma:
// `session_id` da chamada ausente do payload (não dá pra comparar contra
// nada — bloquear aqui seria travar QUALQUER Bash sem session_id, inclusive
// de sessões legítimas), leitura de `data/sessions/` falhando (diretório
// ausente, erro de I/O, JSON malformado — cai em "nenhuma rodada ativa
// detectada", que já é fail-open por construção), ou qualquer exceção neste
// hook.
//
// Self-contained (nenhum import de `scripts/*.ts`): mesma razão documentada
// em `pr-create-review.mjs` — um import estático de `.ts` quebra o hook
// inteiro, silenciosamente, num Node sem type-stripping nativo. A leitura de
// `data/sessions/*.json` é DUPLICADA (não importada) de
// `scripts/lib/session-registry.ts` (`listActiveSessions`) — versão mínima,
// só o necessário pra este guard (ignora `stale`/heartbeat soft-threshold,
// campos de fase, merge lock; usa só `kind`+`sessionId`+idade absoluta).
//
// Schema do hook `PreToolUse`: mesmo contrato dos hooks irmãos — JSON no
// stdin com `session_id`/`tool_name`/`tool_input`, saída
// `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision:
// "deny", permissionDecisionReason: "..." } }` em stdout com exit 0 pra
// bloquear; nenhuma saída pra permitir (equivalente a "defer").

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";

// Mesmo valor usado em `session-registry.ts`/`pr-create-review.mjs`/
// `block-askuserquestion-overnight-autonomous.mjs` — uma rodada
// abandonada/crashada não deve manter este guard armado pra sempre.
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

// #5787 Defeito 1: janela de liveness PRÁTICA (não só a janela absoluta de
// 24h). Uma sessão coordenadora VIVA bata heartbeat de minutos em minutos —
// 90 min de silêncio já é morte para efeito deste guard. O custo de errar
// pra permissivo aqui é limitado: sessão sem heartbeat há 90 min não tem
// subagente ativo pra proteger.
const SOFT_STALE_MS = 90 * 60 * 1000;

// #6168: o kind `interactive` (escrito automaticamente pelo beacon,
// `.claude/hooks/session-beacon.mjs`) NÃO entra aqui, e isso é uma decisão,
// não um esquecimento — uma sessão interativa não despacha subagente
// implementador nem decide quando entra merge, então promovê-la a
// coordenadora por relabel furaria exatamente o que este guard protege.
// O caminho legítimo dela pro merge é a concessão de janela (#6296, ver
// `readLiveMergeGrantFor` abaixo). `test/session-beacon-blast-radius.test.ts`
// trava que este conjunto continua com 3 kinds.
export const COORDINATOR_KINDS = new Set(["overnight", "develop", "continuo"]);

/** TTL da concessão de janela (#6296) — duplicado de `MERGE_GRANT_TTL_MS` em
 * session-registry.ts, porque este hook é self-contained (sem import de `.ts`). */
export const MERGE_GRANT_TTL_MS = 10 * 60 * 1000;

/** TTL do merge lock (#5156 item 4) — duplicado de `MERGE_LOCK_TTL_MS`. */
export const MERGE_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Tolerância de clock skew entre máquinas — duplicado de
 * `CLOCK_SKEW_TOLERANCE_MS` em `scripts/lib/session-registry.ts` (mesmo
 * racional: `data/sessions/` é compartilhado via OneDrive entre `Neo` e
 * `helios`, e relógios não perfeitamente sincronizados podem fazer um
 * timestamp genuinamente recente, escrito por OUTRA máquina, parecer "no
 * futuro" pra quem lê). **A cópia deste valor aqui era a lacuna real do
 * fleet review #6303 Finding A:** `isMergeGrantLive`/`findLiveMergeGrant` (o
 * módulo irmão) já toleravam esse skew (`ageMs < -CLOCK_SKEW_TOLERANCE_MS`),
 * mas `readLiveMergeGrantFor` abaixo — a função que de fato alimenta a
 * decisão de bloquear `gh pr merge` — comparava contra `0` puro. Uma
 * concessão emitida por uma coordenadora com o relógio poucos segundos
 * adiantado tinha `ageMs < 0` na máquina que lê, e era descartada em
 * silêncio — reproduzindo, por outro mecanismo, o mesmo "conversa chegou a
 * acordo e o merge foi bloqueado assim mesmo" que a #6296 existe pra
 * consertar. O VALOR das duas cópias (aqui e em `session-registry.ts`) é
 * comparado de verdade (as duas constantes importadas lado a lado) em
 * `test/session-conflicts-and-merge-grant.test.ts`; o COMPORTAMENTO da
 * tolerância (concessão poucos segundos no futuro ainda vale, muito no
 * futuro não) tem cobertura direta em
 * `test/block-gh-pr-merge-subagent-hook.test.ts`.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/**
 * Sentinela pra "o arquivo do merge lock EXISTE mas o conteúdo é
 * ilegível/inválido" (#6303 Finding C) — tratado pelo guard exatamente como
 * "alguém segura o lock" (o branch `typeof holder === "string"` de
 * `shouldBlockGhPrMerge` já bloqueia qualquer string que não seja
 * `callerSessionId`, e esta nunca é). A correlação com posse é forte, não
 * coincidência: `acquireMergeLock` (session-registry.ts) grava com
 * `writeFileSync(path, data, { flag: "wx" })` no fast path — a ÚNICA escrita
 * NÃO-atômica daquele módulo. Um crash bem no meio dela é o que deixa o
 * arquivo com conteúdo truncado/inválido, e conteúdo corrompido correlaciona
 * com uma aquisição MUITO recente, não com "ninguém segura". Tratar os dois
 * mecanismos como concordes (`acquireMergeLock` já trata "corrompido" como
 * CONTESTÁVEL, não como "livre") é o ponto do fix — antes dele, `undefined`
 * (indeterminado → permite) e "recém-adquirido por um crash" eram
 * indistinguíveis, e o guard honrava o pior dos dois. Nunca colide com um
 * `sessionId` real: contém `\0`, proibido em identificadores de sessão.
 */
export const LOCK_HOLDER_CORRUPTED = "\u0000corrupted-merge-lock";

/**
 * Lê `data/sessions/.merge-lock.json` e devolve quem o segura AGORA (#6296
 * defeito 1; estados refinados no #6303 Finding C).
 *
 * QUATRO retornos distintos, e a distinção é o miolo da correção:
 *   - `string` (sessionId real) — segura o lock, dentro do TTL;
 *   - `string` (`LOCK_HOLDER_CORRUPTED`) — arquivo EXISTE, conteúdo
 *     ilegível/inválido (JSON malformado, shape sem `heldBy`, ou
 *     `acquiredAt` ilegível) — tratado como POSSE DESCONHECIDA, não como
 *     "ninguém segura" (ver docstring da constante acima pro racional);
 *   - `null` — o arquivo NÃO existe, OU existe mas está expirado pelo TTL
 *     (abandonado) — ninguém segura, estado CONHECIDO;
 *   - `undefined` — não deu pra nem determinar se o arquivo existe, ou existe
 *     e a LEITURA falhou por I/O (erro que não é "ausente") — estado
 *     INDETERMINADO. **Nunca** é tratado como `null`.
 *
 * Por que a distinção `null`/`undefined` importa: o critério de aceite da
 * #6296 diz "coordenadora sem lock não mergeia", mas ler isso literalmente
 * sobre um estado INDETERMINADO transformaria uma falha transitória do
 * OneDrive (EBUSY/EPERM, que `session-registry.ts` já documenta como
 * realista aqui) em bloqueio de merge legítimo. Estado desconhecido nunca
 * bloqueia; estado conhecido (ausente/expirado, OU corrompido), sim — cada um
 * pela razão oposta (ausente/expirado = sabidamente livre; corrompido =
 * sabidamente perigoso demais pra tratar como livre).
 */
export function readMergeLockHolder(repoRoot, now = Date.now()) {
  const path = join(sessionsDir(repoRoot), ".merge-lock.json");

  let exists;
  try {
    exists = existsSync(path);
  } catch {
    return undefined; // nem deu pra determinar se existe — indeterminado
  }
  if (!exists) return null; // ausente — ninguém segura, estado conhecido

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Existe mas a LEITURA falhou (EBUSY/EPERM do OneDrive, plausivelmente
    // transitório) — indeterminado, nunca vira bloqueio por si só.
    return undefined;
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return LOCK_HOLDER_CORRUPTED; // conteúdo ilegível — sinal forte de posse
  }
  if (!record || typeof record.heldBy !== "string" || record.heldBy === "") {
    return LOCK_HOLDER_CORRUPTED; // JSON válido mas shape inválido — mesmo tratamento
  }
  const acquiredMs = Date.parse(record.acquiredAt);
  if (!Number.isFinite(acquiredMs)) return LOCK_HOLDER_CORRUPTED; // campo ilegível — mesmo tratamento

  const ageMs = now - acquiredMs;
  // Expirado (TTL) = ninguém segura de fato; `session-registry.ts` já trata
  // lock além do TTL como abandonado e roubável.
  if (ageMs > MERGE_LOCK_TTL_MS) return null;
  return record.heldBy;
}

/**
 * Procura, entre as sessões COORDENADORAS ativas desta máquina, uma concessão
 * de janela de merge viva emitida para `sessionId` (#6296).
 *
 * Duplicado (não importado) de `findLiveMergeGrant`/`isMergeGrantLive` de
 * `scripts/lib/session-registry.ts` — mesma razão self-contained do resto
 * deste arquivo. **Precisão sobre o que é testado (#6303 Finding L — a
 * afirmação anterior aqui, "as duas cópias são travadas por teste", era
 * falsa: zero import cruzado existia):** esta função tem cobertura DIRETA,
 * com arquivos reais em disco, em
 * `test/block-gh-pr-merge-subagent-hook.test.ts` (grant válido/expirado/
 * consumido/auto-concedido/de-outra-sessão/no-futuro-dentro-e-além-da-
 * tolerância/concedente-stale). O que ainda NÃO existe é um teste que
 * importe `isMergeGrantLive`/`findLiveMergeGrant` do módulo `.ts` E esta
 * função lado a lado pra provar que as duas cópias concordam bit a bit — a
 * concordância de comportamento (inclusive a tolerância de clock skew do
 * Finding A) é mantida por disciplina manual, não por um teste cruzado.
 *
 * Invariantes que NÃO podem afrouxar aqui:
 *   - só coordenadora concede (`COORDINATOR_KINDS`);
 *   - `grantedTo === grantedBy` nunca vale, mesmo gravado à mão — auto-
 *     concessão é justamente o contorno que esta feature existe pra não abrir;
 *   - concessão consumida (`consumedAt`) não vale: uso único;
 *   - fora do TTL não vale;
 *   - **coordenadora STALE (heartbeat morto há mais de `SOFT_STALE_MS`) não
 *     concede** (#6303 Finding A, item relacionado) — espelha o filtro
 *     `session.stale` que `findLiveMergeGrant` (session-registry.ts) já
 *     aplica via `listActiveSessions`. Hoje é defesa em profundidade, não um
 *     bug vivo: conceder (`grantMergeWindow`) reescreve `lastHeartbeat` no
 *     mesmo write, e o TTL da concessão (10 min) é bem menor que
 *     `SOFT_STALE_MS` (90 min) — uma concessão viva nunca sobrevive tempo
 *     suficiente pra sua coordenadora ficar stale por outro motivo. Mas essa
 *     é uma premissa sobre OUTRO módulo (o TTL vive em `session-registry.ts`,
 *     não aqui), e a asserção explícita custa pouco — melhor que documentar
 *     "por que não precisa" e confiar que a premissa nunca muda.
 */
export function readLiveMergeGrantFor(repoRoot, sessionId, now = Date.now()) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const dir = sessionsDir(repoRoot);
  let entries;
  try {
    if (!existsSync(dir)) return null;
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".") || name.includes("-safeBackup-")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (!record || !COORDINATOR_KINDS.has(record.kind)) continue;
      const grantorHeartbeatMs = Date.parse(record.lastHeartbeat ?? record.startedAt ?? "");
      if (Number.isFinite(grantorHeartbeatMs) && now - grantorHeartbeatMs > SOFT_STALE_MS) continue;
      const grant = record.merge_grant;
      if (!grant || grant.grantedTo !== sessionId) continue;
      if (grant.consumedAt) continue;
      if (grant.grantedTo === grant.grantedBy) continue;
      const grantedMs = Date.parse(grant.grantedAt);
      if (!Number.isFinite(grantedMs)) continue;
      const ageMs = now - grantedMs;
      // #6303 Finding A: tolera clock skew (ver `CLOCK_SKEW_TOLERANCE_MS`
      // acima) — era `ageMs < 0` puro, e uma concessão emitida por máquina
      // com relógio poucos segundos adiantado era descartada em silêncio.
      if (ageMs < -CLOCK_SKEW_TOLERANCE_MS || ageMs > MERGE_GRANT_TTL_MS) continue;
      return grant;
    } catch {
      // Entrada corrompida — ignora só ela, segue as demais.
    }
  }
  return null;
}

/**
 * Resolve a raiz do checkout PRINCIPAL do repo — nunca a raiz de um worktree
 * vinculado. Mesmo racional/implementação dos hooks irmãos: `data/sessions/`
 * mora na junction compartilhada, só visível a partir da raiz principal.
 */
export function resolveMainRepoRoot(execFn = execFileSync) {
  try {
    const gitDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    return dirname(resolvePath(gitDir));
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

export function sessionsDir(repoRoot) {
  return join(repoRoot, "data", "sessions");
}

/**
 * Varredura de `data/sessions/*.json` (#6303 Finding B) — devolve os
 * `sessionId` de sessões COORDENADORAS ativas (mesmos critérios (a)/(b) de
 * `readActiveCoordinatorSessionIds` abaixo) **e** um sinal `degraded`
 * distinguindo "varredura CONFIRMADA" de "varredura possivelmente incompleta".
 *
 * Por que isso importa: `shouldBlockGhPrMerge` usa `activeCoordinatorSessionIds.size`
 * pra decidir a leniência "sou a única coordenadora, posso mergear sem lock"
 * (`holder === null && size <= 1` → permite). Esse `size` só é confiável na
 * medida em que a varredura que o produziu for confiável — e
 * `data/sessions/` mora numa junction OneDrive onde EBUSY/EPERM transitório é
 * realista (`session-registry.ts` já documenta isso pro merge lock). Uma
 * falha lendo UMA entre DUAS coordenadoras reais desta máquina fazia `size`
 * valer 1 quando era 2: a sobrevivente se achava sozinha e mergeava sem lock
 * — a corrida de merge duplo que este guard inteiro existe pra evitar.
 *
 * `degraded: true` quando:
 *   - a listagem do DIRETÓRIO falhou (não dá nem pra saber quantos arquivos
 *     existem);
 *   - a LEITURA de uma entrada falhou por erro que não é "arquivo removido
 *     entre o readdir e a leitura" (ENOENT — corrida benigna, arquivo de
 *     verdade não existia mais, não é degradação);
 *   - o CONTEÚDO de uma entrada não parseou como JSON, ou o processamento de
 *     uma entrada lançou por qualquer outro motivo — JSON malformado aqui
 *     pode ser tanto "outra sessão escrevendo por cima agora" (benigno)
 *     quanto corrupção genuína; não dá pra distinguir com segurança, então os
 *     dois casos contam como degradação (preferir "não confio na contagem" a
 *     "confio errado").
 *
 * `degraded: false` quando o diretório está simplesmente AUSENTE (estado
 * CONHECIDO — "nenhuma sessão registrada ainda", não incerteza) ou quando a
 * varredura inteira completou sem nenhuma falha individual.
 */
export function readActiveCoordinatorScan(repoRoot, now = Date.now()) {
  const dir = sessionsDir(repoRoot);
  const ids = new Set();
  let entries;
  try {
    if (!existsSync(dir)) return { ids, degraded: false };
    entries = readdirSync(dir);
  } catch {
    return { ids, degraded: true }; // não deu nem pra listar — contagem não confiável
  }
  const myTag = machineTag();
  let degraded = false;
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".") || name.includes("-safeBackup-")) continue;
    let raw;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch (e) {
      // ENOENT = arquivo removido entre o readdir e a leitura, corrida
      // benigna (equivalente a "nunca existiu de fato"); qualquer OUTRO
      // código (EBUSY/EPERM/EACCES do OneDrive) é falha de I/O real — a
      // varredura pode estar subcontando coordenadoras genuinamente vivas.
      if (e?.code !== "ENOENT") degraded = true;
      continue;
    }
    try {
      const record = JSON.parse(raw);
      if (!record || typeof record !== "object") continue;
      if (!COORDINATOR_KINDS.has(record.kind)) continue;
      if (typeof record.sessionId !== "string" || record.sessionId === "") continue;
      // #5787 Defeito 2: ignora sessões de outras máquinas — `data/sessions/`
      // é compartilhado via OneDrive, e um coordenador em outra máquina não
      // pode despachar subagente deste checkout.
      if (typeof record.machineTag !== "string" || record.machineTag !== myTag) continue;
      const heartbeatIso = record.lastHeartbeat ?? record.startedAt;
      const heartbeatMs = Date.parse(heartbeatIso ?? "");
      if (!Number.isFinite(heartbeatMs)) continue;
      const ageMs = now - heartbeatMs;
      if (ageMs < 0 || ageMs > MAX_SESSION_AGE_MS) continue;
      // #5787 Defeito 1: janela de liveness prática (90 min). Uma sessão que
      // não bateu heartbeat há mais de SOFT_STALE_MS está morta para efeito
      // deste guard — não tem subagente ativo pra proteger.
      if (ageMs > SOFT_STALE_MS) continue;
      ids.add(record.sessionId);
    } catch {
      // JSON malformado (pode ser outra sessão escrevendo agora, ou
      // corrupção genuína — não dá pra distinguir com segurança) OU qualquer
      // outra falha processando esta entrada específica: ignora só ela, mas
      // marca a varredura como degradada — não confiamos mais no `size`
      // final pra decidir "sou a única coordenadora".
      degraded = true;
    }
  }
  return { ids, degraded };
}

/**
 * Wrapper de compatibilidade sobre `readActiveCoordinatorScan` — devolve só
 * o `Set` de `sessionId`s, descartando o sinal `degraded`. Mantido para os
 * chamadores que só precisam da lista (ex: comparação de igualdade de
 * `sessionId`, fora do cálculo de leniência "solo"); `shouldBlockGhPrMerge`
 * usa `readActiveCoordinatorScan` diretamente, via `ctx.scanDegraded` no
 * entrypoint CLI abaixo, exatamente pra não perder esse sinal na chamada que
 * mais precisa dele.
 *
 * Fail-soft em qualquer ponto: diretório ausente, erro de leitura, JSON
 * malformado, ou entrada sem os campos esperados são simplesmente ignorados —
 * nunca lança.
 */
export function readActiveCoordinatorSessionIds(repoRoot, now = Date.now()) {
  return readActiveCoordinatorScan(repoRoot, now).ids;
}

/** Resolve a tag de máquina atual — mesma função usada em `session-registry.ts`
 * (`machineTag()`), duplicada aqui porque o hook é self-contained (sem import
 * de `.ts`). #5787 Defeito 2: preciso comparar `record.machineTag` contra a
 * máquina onde o hook roda, já que `data/sessions/` é compartilhado via
 * OneDrive entre helios/Neo.
 */
export function machineTag() {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/**
 * Remove o CONTEÚDO de spans entre aspas (simples ou duplas), preservando
 * tudo fora deles — inclusive newlines. Usado para que `gh pr merge`
 * aparecendo dentro de uma string entre aspas (single-line OU multi-line,
 * ex: um `--body "...\ngh pr merge...\n..."`) nunca seja visto pelo matcher
 * de separadores de comando (#5805 — ver docstring de `isGhPrMergeCommand`).
 *
 * Aspas simples: sem escape interno (semântica de shell — `\` dentro de
 * `'...'` é literal). Aspas duplas: `\"` escapada não fecha o span. Aspa não
 * fechada até o fim da string: tudo dali em diante é tratado como dentro do
 * span (mesmo trade-off de "comando malformado degrada pra fail-closed
 * nessa cauda" já aceito pelo restante do guard — ver topo do arquivo).
 */
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/** `true` se `command` contém `gh pr merge` como um comando REAL — só no
 * início da string ou depois de separador de comando (`&&`/`;`/`|`/`||`/
 * newline).
 *
 * #5787 Defeito 3: o regex antigo `/\\bgh\\s+pr\\s+merge\\b/` rodava sobre a
 * string inteira e casava com a CITAÇÃO da mensagem de erro dentro do corpo
 * de uma issue — qualquer comando que MENCIONASSE a expressão era negado.
 * O fix casou só no início do comando ou depois de um separador, quando é de
 * fato um comando que o shell executaria.
 *
 * #5805: o conjunto de separadores declarado no comentário ("&& ; | ||
 * newline") nunca incluiu newline no regex — `^` sem a flag `m` ancora só no
 * início da STRING inteira, não de cada linha, então um comando Bash
 * multi-linha cuja 1ª linha não é `gh pr merge` mas contém a chamada numa
 * linha posterior (ex: heredoc, `cmd1\ncmd2`) passava direto pelo guard.
 * Adicionar `\n` à alternação de separadores sozinho reabriria o Defeito 3
 * em variante multi-linha: um `--body` com newline LITERAL dentro das aspas
 * (`--body "linha1\ngh pr merge citado\nlinha3"`) teria a citação vista como
 * comando real, porque o regex não entende quoting.
 *
 * Por isso o matcher roda sobre `stripQuotedSpans(command)`, não sobre
 * `command` bruto: todo conteúdo entre aspas (single-line OU multi-line) é
 * removido antes do regex de separadores rodar, então `gh pr merge` citado
 * dentro de um `--body`/`--title`/string nunca é visto como comando real —
 * independente de ter newline dentro das aspas ou não — e um `gh pr merge`
 * genuíno depois de um separador (incluindo `\n`) fora de qualquer aspas
 * continua detectado normalmente.
 */
export function isGhPrMergeCommand(command) {
  if (typeof command !== "string") return false;
  const stripped = stripQuotedSpans(command);
  return /^\s*gh\s+pr\s+merge\b|(?:&&|;|\|\||\||\n)\s*gh\s+pr\s+merge\b/.test(stripped);
}

/**
 * Extrai o número do PR alvo de um comando `gh pr merge` real (#6303 Finding
 * S). `undefined` quando não dá pra determinar — inclusive o caso legítimo em
 * que `gh pr merge` roda SEM número (infere o PR pela branch corrente) e o
 * caso de comando malformado/sem `gh pr merge` real nenhum.
 *
 * Roda sobre `stripQuotedSpans(command)` pela mesma razão de
 * `isGhPrMergeCommand`: dígitos dentro de uma string entre aspas (ex: um
 * `--body` citando "aconteceu depois de 100 dias") já saem removidos antes do
 * parsing, então nunca viram um número de PR por engano.
 *
 * Pega a ÚLTIMA ocorrência real de `gh pr merge` no comando (mesmos
 * separadores de `isGhPrMergeCommand`) e o primeiro token TODO-dígitos dentro
 * do segmento até o próximo separador — cobre tanto `gh pr merge 123 --squash`
 * quanto `gh pr merge --squash 123`.
 */
export function extractGhPrMergeTargetPr(command) {
  if (typeof command !== "string") return undefined;
  const stripped = stripQuotedSpans(command);
  const invocationRe = /(?:^\s*|(?:&&|;|\|\||\||\n)\s*)gh\s+pr\s+merge\b/g;
  let end = -1;
  let m;
  while ((m = invocationRe.exec(stripped))) end = m.index + m[0].length;
  if (end === -1) return undefined;
  const segment = /^[^\n;&|]*/.exec(stripped.slice(end))?.[0] ?? "";
  const numMatch = /(?:^|\s)(\d+)(?=\s|$)/.exec(segment);
  if (!numMatch) return undefined;
  const n = Number(numMatch[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Função pura — decide se um `gh pr merge` deve ser bloqueado, dado o
 * conjunto de `sessionId`s de coordenadores ativos já lido e o `session_id`
 * da chamada ATUAL. Sem I/O, 100% testável.
 *
 * Bloqueia quando: existe ≥1 rodada coordenadora ativa registrada E o
 * `session_id` da chamada não é o de nenhuma delas. Ver docblock do topo do
 * arquivo pro racional completo (inclui o trade-off aceito de bloquear, não
 * permitir, na ambiguidade — direção oposta da maioria dos hooks irmãos, de
 * propósito, porque aqui o custo de um falso negativo é maior que o de um
 * falso positivo).
 *
 * `ctx` (todos opcionais, todos aditivos desde #6296/#6303):
 *   - `hasLiveGrant` / `grantPr` — existência e escopo (opcional) da
 *     concessão de janela viva pra este `callerSessionId` (ver Finding S
 *     abaixo);
 *   - `targetPr` — número do PR que ESTE `gh pr merge` está de fato
 *     mergeando (extraído por `extractGhPrMergeTargetPr`), `undefined`
 *     quando indeterminado;
 *   - `mergeLockHolder` — resultado de `readMergeLockHolder`;
 *   - `scanDegraded` — `true` quando a varredura que produziu
 *     `activeCoordinatorSessionIds` não é confiável (ver
 *     `readActiveCoordinatorScan`, Finding B).
 */
export function shouldBlockGhPrMerge(activeCoordinatorSessionIds, callerSessionId, ctx = {}) {
  if (callerSessionId === undefined || callerSessionId === null || callerSessionId === "") return false;

  const coordinators = activeCoordinatorSessionIds ?? new Set();

  // #6303 review cruzado (P1·b): NENHUMA coordenadora identificada tem DUAS
  // leituras opostas, e antes desta correção as duas colapsavam em "permite".
  //
  //   - varredura CONFIÁVEL e vazia → de fato não há rodada ativa: permite,
  //     que é o caminho de uma sessão interativa comum (#5251);
  //   - varredura DEGRADADA (o `readdirSync` lançou, ou TODA entrada falhou
  //     no parse) → não dá pra saber se há rodada. É o PIOR caso de
  //     degradação, e era justamente o que escapava: o fix do Finding B só
  //     consultava `scanDegraded` no ramo `holder === null`, que exige
  //     `size > 0` — inalcançável quando a varredura não identificou
  //     ninguém. Uma rodada real, ilegível por um soluço de I/O do OneDrive
  //     naquele instante, era tratada igual a "não há rodada".
  //
  // Bloquear aqui é o que o docblock deste arquivo promete ("prefere
  // bloquear na dúvida") — o custo de um falso positivo é uma PR esperando
  // merge manual; o de um falso negativo é o incidente do #5716.
  if (coordinators.size === 0) return ctx.scanDegraded === true;

  const holder = ctx.mergeLockHolder;

  // #6303 review cruzado (P1·a): o LOCK É AVALIADO PRIMEIRO, e vale pra todo
  // mundo — inclusive pra quem tem concessão de janela.
  //
  // Antes desta correção o ramo da concessão dava `return false` ANTES da
  // checagem de lock, e `grantMergeWindow` nunca validava o kind de
  // `grantedTo`. Somados: `grant-merge --granted-to {sessionId de OUTRA
  // coordenadora}` sucedia, e o `gh pr merge` seguinte dela pulava a
  // composição com o lock — reabrindo exatamente a corrida de merge duplo
  // que o §DEFEITO 1 desta mesma unidade fecha. Com concessão cruzada
  // (A→B e B→A), as duas mergeavam sem lock.
  //
  // A separação que corrige: **a concessão destrava IDENTIDADE ("quem pode
  // mergear"), nunca TEMPO ("quando pode")**. Quem serializa continua sendo
  // o lock, para todos.
  if (typeof holder === "string" && holder !== callerSessionId) return true;

  // #6296 — DEFEITO 2: a janela concedida por conversa ganha representação
  // mecânica. Medido ao vivo em 260826: o protocolo inteiro da Parte F do
  // #6168 rodou (peer achado, SendMessage entregue, colisão por arquivo
  // conferida nos 3 PRs dele, janela concedida, merge lock adquirido) e o
  // `gh pr merge` foi bloqueado assim mesmo, porque este guard só olhava
  // `session_id` contra o registro. A conversa chegou a acordo e não teve
  // efeito nenhum sobre o mecanismo.
  //
  // A concessão NÃO afrouxa o guard: continua sendo a COORDENADORA quem
  // decide que um merge entra (ela é a única que concede, e nunca a si
  // mesma), com TTL curto e uso único. O que muda é que a decisão dela agora
  // é legível por este hook em vez de existir só no transcript de duas
  // sessões.
  //
  // #6303 Finding S: até aqui `hasLiveGrant === true` bypassava o guard
  // INCONDICIONALMENTE — uma concessão emitida "pro PR #100, depois de
  // conferir colisão por arquivo contra os PRs abertos da rodada" virava,
  // mecanicamente, permissão em branco pra mergear QUALQUER PR durante o TTL
  // inteiro. A conferência que justifica a concessão virava decorativa.
  // Agora ela só bypassa quando:
  //   - `grantPr` é `undefined` — concessão GENÉRICA (retrocompat: toda
  //     concessão emitida antes do #6303, ou emitida sem `--pr`, continua
  //     valendo pra qualquer merge, exatamente como sempre valeu);
  //   - `grantPr === targetPr` — concessão ESCOPADA que bate com o PR sendo
  //     mergeado agora.
  // Concessão escopada que NÃO bate (inclusive `targetPr` INDETERMINADO,
  // `undefined`) não bypassa — cai pro resto da lógica normal abaixo. A
  // dúvida fecha aqui, não abre: nunca honra uma concessão escopada sobre um
  // alvo que não deu pra determinar.
  const grantCoversTarget =
    ctx.hasLiveGrant === true && (ctx.grantPr === undefined || ctx.grantPr === ctx.targetPr);

  const isCoordinator = coordinators.has(callerSessionId);
  // Duas portas de identidade, e só duas. Note que isto NÃO é mais um
  // `return false` — passar aqui só significa "tem direito de mergear"; se
  // pode mergear AGORA é o bloco de lock abaixo que decide (P1·a).
  if (!grantCoversTarget && !isCoordinator) return true; // comportamento pré-#6296

  // #6296 — DEFEITO 1: dois mecanismos governavam a mesma ação sem se
  // compor. `grep -c 'mergeLock\|merge-lock\|\.merge-lock'` neste arquivo
  // devolvia 0: o guard nunca consultava o lock, então "quem tem direito de
  // mergear" e "a janela de merge está livre agora" eram perguntas
  // respondidas por mecanismos que não se falavam.
  //
  // Leitura deliberadamente mais ESTREITA que a letra do critério de aceite
  // ("coordenadora sem lock não mergeia"), e o motivo é a direção do
  // fail-safe:
  //   - lock seguro por OUTRA sessão (inclusive o sentinela
  //     `LOCK_HOLDER_CORRUPTED`, #6303 Finding C — conteúdo ilegível é POSSE
  //     desconhecida, não "livre")   → bloqueia (é o dano real: dois merges
  //     concorrentes em master);
  //   - lock ausente E a varredura de coordenadoras é DEGRADADA (#6303
  //     Finding B) → bloqueia. A leniência "solo" abaixo depende de confiar
  //     em `activeCoordinatorSessionIds.size` — uma varredura que não
  //     conseguiu ler/parsear uma entrada pode estar SUBCONTANDO
  //     coordenadoras reais, e a sobrevivente se achar sozinha quando não
  //     está é exatamente a corrida de merge duplo que este guard existe pra
  //     evitar;
  //   - lock ausente E há OUTRA coordenadora ativa (varredura confiável) →
  //     bloqueia (há contenção de verdade; pegar o lock deixa de depender de
  //     a skill lembrar);
  //   - lock ausente E esta é a ÚNICA coordenadora (varredura confiável) →
  //     PERMITE. Não há com quem serializar, e bloquear aqui quebraria toda
  //     rodada solo — que é o caso comum — sem prevenir dano nenhum;
  //   - estado do lock INDETERMINADO (`undefined`: I/O do OneDrive) →
  //     PERMITE. Nunca transformar falha transitória de leitura em bloqueio
  //     de merge legítimo — distinto do conteúdo CORROMPIDO acima, que é
  //     estado CONHECIDO (arquivo existe, não parseia).
  // Lock AUSENTE (`null`) ou INDETERMINADO (`undefined`): só permite quando
  // não há contenção real. O caso `undefined` entrou aqui no review cruzado
  // do #6303 (P2): `.merge-lock.json` mora no MESMO diretório sincronizado
  // que os arquivos de sessão, então um soluço de I/O do OneDrive degrada os
  // dois sinais junto — permitir sobre lock ilegível E varredura degradada
  // seria confiar em dois estados que ninguém conseguiu ler.
  // Varredura DEGRADADA bloqueia independente do estado do lock — inclusive
  // com o lock INDETERMINADO (P2 do review cruzado): `.merge-lock.json` mora
  // no MESMO diretório sincronizado que os arquivos de sessão, então um
  // soluço de I/O do OneDrive degrada os dois sinais junto, e permitir aí
  // seria confiar em dois estados que ninguém conseguiu ler.
  if (ctx.scanDegraded === true) return true;

  // A regra de CONTENÇÃO exige saber que o lock está ausente. Ela NÃO se
  // aplica a `undefined` (não deu pra ler): "estado indeterminado nunca
  // bloqueia" é o fail-safe declarado desta função desde o #6296, e o que o
  // review cruzado pediu foi cruzar `undefined` com `scanDegraded` (feito
  // acima), não transformar toda leitura falha em bloqueio.
  if (holder === null) {
    // Duas ou mais coordenadoras ativas e ninguém segurando o lock: pegar o
    // lock deixou de depender de a skill lembrar.
    if (coordinators.size > 1) return true;
    // Uma coordenadora só, mas quem chama NÃO é ela — logo é uma sessão com
    // concessão, e há duas sessões em jogo. Isso é contenção por definição:
    // a beneficiada também passa pelo lock. Corolário direto de "a concessão
    // destrava identidade, não tempo" (P1·a).
    if (!isCoordinator) return true;
  }
  return false;
}

/**
 * Mensagem mostrada ao subagente/sessão quando a chamada é negada (#5716,
 * reescrita no #6303 Finding K).
 *
 * Achado do fleet review da #6303: a versão anterior deste texto era o que a
 * sessão bloqueada de fato LÊ em produção, e terminava recomendando
 * `register --kind {overnight|develop|continuo}` pra QUALQUER um que se
 * visse bloqueado — inclusive uma sessão interativa comum, que é justamente
 * quem esta PR (#6296) existe pra desbloquear por outro caminho. Rodar
 * `register` ali fabrica identidade de coordenadora e FURA o guard — o
 * antipadrão exato que este hook existe pra fechar. Agora o texto distingue
 * os dois casos reais pós-#6296.
 */
export const BLOCK_REASON =
  "gh pr merge bloqueado pelo guard mecânico do overnight/develop (#5716): há uma rodada " +
  "/diaria-overnight, /diaria-develop ou /diaria-continuo ativa nesta máquina (data/sessions/*.json) " +
  "e esta chamada não pertence à sessão coordenadora registrada. Regra 11 de " +
  "context/overnight-dispatch-rules.md: nenhum subagente implementador espera CI, roda fleet review, " +
  "ou mergeia o próprio PR — isso é trabalho exclusivo do coordenador top-level, depois do fleet review " +
  "pré-merge e do Gate 2. Se você é o subagente implementador: pare aqui, faça o self-review (regra 7), " +
  "e retorne o número do PR + \"self-review: N findings\" ao coordenador — nunca chame gh pr merge você " +
  "mesmo. Se você É a coordenadora e está vendo este bloqueio por engano (ex: seu próprio registro " +
  "expirou por staleness), rode `npx tsx scripts/lib/session-registry.ts register --kind " +
  "{overnight|develop|continuo}` pra RENOVAR o registro que já era seu, e tente de novo — isto nunca " +
  "cria uma identidade nova. Se você NÃO é coordenadora (ex: sessão interativa, #6296): NUNCA rode " +
  "`register` — isso fabrica identidade de coordenadora e fura este guard. O caminho correto é pedir a " +
  "janela de merge à coordenadora ativa (ela concede via `session-registry.ts grant-merge --granted-to " +
  "{seu session_id}`), confirmar com `session-registry.ts check-merge-grant`, e só então tentar `gh pr " +
  "merge` de novo dentro do TTL da concessão.";

/**
 * Complemento ao `BLOCK_REASON` explicando POR QUE uma concessão de merge
 * ESCOPADA (`--pr N`) não cobriu esta chamada (#6322 achado 2).
 *
 * Cenário que motivou: a coordenadora concede `grant-merge --granted-to X
 * --pr 105`; a sessão `X` roda `gh pr merge` SEM número explícito (uso
 * normal — o `gh` infere pela branch corrente). `extractGhPrMergeTargetPr`
 * devolve `undefined`, `grantCoversTarget` fica `false` (a dúvida fecha, não
 * abre — ver `shouldBlockGhPrMerge`), e o merge é bloqueado mesmo com
 * concessão válida em mãos, sem que `BLOCK_REASON` mencionasse essa exigência
 * em nenhum lugar — a sessão beneficiada via um bloqueio inexplicável.
 */
export const SCOPED_GRANT_HINT =
  "Você tem uma concessão de merge ATIVA, mas ela é ESCOPADA a um PR específico (--pr N) e este `gh pr " +
  "merge` não informou o número do PR explicitamente (o `gh` estava inferindo pela branch corrente) — ou " +
  "informou um número diferente do PR concedido. Concessão escopada só cobre o PR exato dela: rode `gh pr " +
  "merge <número-do-PR-concedido> ...` com o número explícito e tente de novo.";

/**
 * Monta a mensagem de bloqueio final. Quando existe concessão ESCOPADA para
 * quem está chamando (`ctx.hasLiveGrant && ctx.grantPr !== undefined`) mas
 * ela não cobriu esta chamada (`ctx.grantPr !== ctx.targetPr` — inclusive
 * `targetPr` indeterminado), acrescenta `SCOPED_GRANT_HINT` ao final do
 * `BLOCK_REASON` genérico, nomeando a exigência real em vez de deixar a
 * sessão beneficiada sem explicação.
 */
export function buildBlockReason(ctx = {}) {
  const hasScopedGrant = ctx.hasLiveGrant === true && ctx.grantPr !== undefined;
  const grantMissedTarget = hasScopedGrant && ctx.grantPr !== ctx.targetPr;
  return grantMissedTarget ? `${BLOCK_REASON} ${SCOPED_GRANT_HINT}` : BLOCK_REASON;
}

// #2019-style CLI guard — só roda o corpo do hook quando este arquivo é o
// entrypoint (nunca ao ser importado por test/block-gh-pr-merge-subagent-hook.test.ts).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      const payload = JSON.parse(data || "{}");
      if (payload.tool_name && payload.tool_name !== "Bash") return;
      const command = payload.tool_input?.command;
      if (!isGhPrMergeCommand(command)) return;
      const repoRoot = resolveMainRepoRoot();
      // #6303 Finding B: usa a varredura completa (ids + degraded), não só o
      // Set — `shouldBlockGhPrMerge` precisa do sinal de degradação pra
      // decidir a leniência "solo".
      const scan = readActiveCoordinatorScan(repoRoot);
      const grant = readLiveMergeGrantFor(repoRoot, payload.session_id);
      const ctx = {
        // #6296: os dois sinais que o guard passou a compor — a janela
        // concedida por uma coordenadora, e quem segura o merge lock agora.
        // #6303 Finding S: `grantPr`/`targetPr` escopam a concessão ao PR
        // real sendo mergeado, em vez de bypassar o guard incondicionalmente.
        hasLiveGrant: grant !== null,
        grantPr: grant?.pr,
        targetPr: extractGhPrMergeTargetPr(command),
        mergeLockHolder: readMergeLockHolder(repoRoot),
        // #6303 Finding B: varredura degradada não pode alimentar a
        // leniência "sou a única coordenadora, posso sem lock".
        scanDegraded: scan.degraded,
      };
      if (shouldBlockGhPrMerge(scan.ids, payload.session_id, ctx)) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: buildBlockReason(ctx),
            },
          }),
        );
      }
      // Sem bloqueio: não emitir nada — cai no fluxo normal de permissão.
    } catch {
      // Fail-open, sempre: um hook quebrado não pode travar `gh pr merge`
      // legítimo de uma sessão coordenadora ou interativa comum.
    }
  });
}
