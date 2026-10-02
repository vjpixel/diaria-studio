#!/usr/bin/env npx tsx
/**
 * overnight-session-marker.ts (#3322, campo `phase` adicionado em #4450)
 *
 * Escreve/remove o marker determinístico que `.claude/hooks/pr-create-review.mjs`
 * (`isOvernightRoundActive`) usa pra detectar uma rodada `/diaria-overnight`
 * genuinamente em progresso NESTA máquina, independente de como PRs da rodada
 * nomeiam suas branches (#3321: convenção de naming `overnight/*` documentada em
 * SKILL.md mas nunca de fato instruída ao dispatch — o gating por branch nunca
 * disparou `low` numa rodada inteira). Path: `data/overnight/.active-session-{tag}.json`,
 * onde `{tag}` é o hostname sanitizado — cada máquina escreve/lê SÓ o próprio
 * arquivo, sem risco de colisão de escrita entre máquinas sincronizadas pelo
 * mesmo junction OneDrive `data/`.
 *
 * **Campo `phase` (#4450):** guard MECÂNICO contra o incidente da rodada
 * 260801/02 — o coordenador disparou um `AskUserQuestion` malformado/placeholder
 * no meio da Fase 1 (autônoma), violando a Regra 1 (HARD RULE, "zero perguntas
 * pós-briefing") de `.claude/skills/diaria-overnight/SKILL.md`. Diferente do
 * #3038 (decisão de raciocínio ruim, corrigida com reforço de prompt), aqui a
 * chamada em si foi anômala — reforçar o texto da regra não teria evitado uma
 * tool call que não seguiu nenhum raciocínio identificável. `phase` grava em
 * qual momento da rodada o coordenador está: `"briefing"` (Fase 0 — perguntar é
 * permitido e esperado) ou `"autonomous"` (Fase 1 em diante — perguntar é
 * proibido). `--start` sempre grava `phase: "briefing"` (toda rodada nova
 * começa no briefing); a skill chama `--phase autonomous` ao concluir a Fase 0
 * (passo 8, ao entrar na Fase 1) — esse é o gatilho que arma o hook
 * `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs`, que nega
 * qualquer `AskUserQuestion` enquanto `phase` for `"autonomous"` neste marker.
 * O hook duplica a lógica de path (mesmo padrão de `pr-create-review.mjs`) e
 * consome só leitura — nunca escreve o marker. **Resume (passo 0):** quando
 * `plan.json` já existe, a skill pula direto pra Fase 1/1.5/2 sem passar pelo
 * passo 8 — mas o passo 1 (`--start`) ainda roda nesse caminho e reseta
 * `phase` pra `"briefing"`. O passo 0 re-arma `--phase autonomous`
 * explicitamente logo depois, então uma rodada retomada nunca fica sem o
 * guard armado.
 *
 * Deliberadamente NÃO é `data/overnight/{AAMMDD}/plan.json` (documento de progresso
 * do coordenador, schema evoluindo, dono de uma feature não-relacionada — a
 * statusLine). Uma revisão anterior desta correção reusava `plan.json` e o
 * code-review consolidado do PR encontrou 3 gaps reais nessa abordagem: (1)
 * sem staleness — uma rodada travada/crashada ficava "ativa" pra sempre; (2)
 * `readTodayPlan` só olha o diretório MAIS RECENTE — se esse for de outra
 * máquina, a rodada ativa desta máquina nunca era vista; (3) direção de
 * fail-safe invertida herdada de `isTerminalForBar` (status desconhecido/ausente
 * = "ainda rodando", certo pra uma barra de progresso, errado pra um gate de
 * custo). Um marker dedicado, por máquina, com timestamp próprio, evita as 3
 * classes por construção — contrato inteiro é "existe + é recente + é meu".
 *
 * A lógica de path (`activeSessionPath`/`machineTag`) é DUPLICADA — não
 * importada — em `.claude/hooks/pr-create-review.mjs`: aquele hook roda num
 * caminho que nunca pode lançar (`gh pr create` não pode ser bloqueado por um
 * hook quebrado) e evita depender de qualquer `scripts/*.ts` pra isso (imports
 * estáticos de `.ts` num hook `.mjs` são um ponto de falha sensível a versão
 * de Node — ver comentário no topo do hook). Se o esquema de path mudar aqui,
 * mudar lá também — `test/pr-create-review-hook.test.ts` e
 * `test/overnight-session-marker.test.ts` cobrem os dois lados
 * independentemente, então uma divergência acidental quebra pelo menos um dos
 * dois test files.
 *
 * **Campo `session_id` (#5156, retrocompat obrigatória).** Marker novo pode
 * carregar `session_id` — o `session_id` do payload do hook, injetado
 * automaticamente por `.claude/hooks/inject-session-id.mjs` (a skill nunca
 * passa `--session-id` manualmente: ela não tem como saber o próprio
 * `session_id`, ver docblock desse hook). Com `session_id` gravado,
 * `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs` e
 * `.claude/hooks/pr-create-review.mjs` (`isOvernightRoundActive`) passam a
 * comparar o `session_id` da chamada ATUAL contra o do marker — só tratam
 * como "é esta rodada overnight" quando os dois batem, permitindo que uma
 * sessão `/diaria-develop` rodando em paralelo na MESMA máquina não seja
 * afetada pelo guard/desconto de effort do overnight (#5156 itens 1/2).
 * **Marker SEM `session_id` (formato antigo — inclusive o de qualquer rodada
 * overnight já em progresso no momento deste PR) preserva o comportamento
 * PRÉ-#5156 nos dois hooks: "ativo nesta máquina" já basta, independente de
 * quem chama** — nunca um requisito novo que quebraria uma rodada em voo.
 *
 * **Marker POR SESSÃO (#9347).** O path único por máquina deixou de bastar
 * quando duas rodadas overnight simultâneas na MESMA máquina viraram caso
 * suportado (#6328): o `--start` da 2ª sobrescrevia o marker da 1ª e o `--end`
 * dela o apagava, desarmando em silêncio o guard da Regra 1 e o desconto de
 * effort da 1ª, ainda viva (ocorrência 261001). Agora `--start` com
 * `session_id` grava `.active-session-{tag}.{sessionId}.json`, `--end` só
 * remove o marker desta sessão, e os hooks leem TODOS os markers da máquina
 * (legado + por-sessão). O legado `.active-session-{tag}.json` continua
 * existindo pra marker anônimo e é lido/migrado pra compatibilidade com
 * rodadas iniciadas antes desta mudança — ver `activeSessionPath`,
 * `endSession` e `listActiveSessionMarkerPaths`.
 *
 * Uso (chamado pela skill `/diaria-overnight` — Fase 0 passo 1, Fase 0 passo 8
 * e Fase 2 passo 0):
 *   npx tsx scripts/overnight-session-marker.ts --start
 *   npx tsx scripts/overnight-session-marker.ts --phase autonomous
 *   npx tsx scripts/overnight-session-marker.ts --end
 * (`--session-id X` é sempre injetado automaticamente pelo hook acima — nunca
 * precisa ser passado manualmente pela skill.)
 *
 * **`--start`/`--phase` sem `--session-id` (#6232):** falha alto por padrão
 * (`resolveSessionIdOrThrow`, ver docstring dela abaixo) — um marker anônimo
 * muda o escopo do bloqueio de `AskUserQuestion` de 1 sessão pra a máquina
 * inteira, sem aviso nenhum antes deste PR. A causa típica é o comando ter
 * sido chamado encadeado/pipado (`&&`/`;`/`|`/heredoc), o que faz
 * `inject-session-id.mjs` recusar a injeção de propósito (`context/
 * overnight-dispatch-rules.md` item 18) — a correção normal é chamar
 * standalone. Fora do harness (debug manual, script rodando sem sessão
 * Claude Code), passar `--allow-no-session-id` grava o marker no formato
 * antigo mesmo assim, mas sempre com aviso alto no stderr — nunca em
 * silêncio.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

/** Fases da rodada (#4450) — ver docblock do topo do arquivo. */
export type OvernightPhase = "briefing" | "autonomous";

/**
 * Mesmo teto de staleness dos dois hooks consumidores (`MAX_SESSION_AGE_MS`
 * em `pr-create-review.mjs`/`block-askuserquestion-overnight-autonomous.mjs`).
 * Usado aqui por `readPhase` (agregação multi-marker, #9347) e pela poda de
 * markers por-sessão abandonados em `startSession`.
 */
export const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

/** Sanitiza o hostname pra um nome de arquivo seguro. Nunca lança — string vazia em falha. */
export function machineTag(): string {
  try {
    return (hostname() || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

/** Sanitiza um `session_id` pra segmento de nome de arquivo (mesmo alfabeto do `machineTag`). */
export function sessionFileSegment(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Path do marker (#3322). **#9347 — marker POR SESSÃO:** com `sessionId`, o
 * path é `.active-session-{tag}.{sessionId}.json` — duas rodadas overnight
 * simultâneas na MESMA máquina (caso suportado desde o #6328: planos
 * `261001b`, `261001c`...) gravam arquivos distintos, e o `--start`/`--end`
 * de uma nunca sobrescreve nem apaga o marker da outra. Sem `sessionId`, o
 * path é o LEGADO por máquina `.active-session-{tag}.json` (marker anônimo,
 * `--allow-no-session-id`, ou o de uma rodada iniciada antes do #9347 — que
 * continua sendo lido pelos hooks, ver `listActiveSessionMarkerPaths`).
 *
 * Separador `.` (não `-`) entre tag e sessão de propósito: o tag sanitizado
 * só contém `[a-zA-Z0-9_-]`, então `.` nunca aparece nele — com `-`, o marker
 * por-sessão do host `host` seria indistinguível do legado de um host chamado
 * `host-{algo}`.
 */
export function activeSessionPath(repoRoot: string, tag: string = machineTag(), sessionId?: string): string {
  const name = sessionId
    ? `.active-session-${tag}.${sessionFileSegment(sessionId)}.json`
    : `.active-session-${tag}.json`;
  return join(repoRoot, "data", "overnight", name);
}

/**
 * (#9347) Todos os markers desta máquina — o legado `.active-session-{tag}.json`
 * (se existir) + cada `.active-session-{tag}.{sessionId}.json`. Nunca lança:
 * diretório ausente/ilegível → `[]`. Os dois hooks consumidores DUPLICAM esta
 * lógica (self-contained, ver docblock do topo) — mudar aqui = mudar lá.
 */
export function listActiveSessionMarkerPaths(repoRoot: string, tag: string = machineTag()): string[] {
  const dir = join(repoRoot, "data", "overnight");
  const legacyName = `.active-session-${tag}.json`;
  const prefix = `.active-session-${tag}.`;
  try {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === legacyName) {
        out.push(join(dir, name));
        continue;
      }
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const middle = name.slice(prefix.length, name.length - ".json".length);
      if (/^[a-zA-Z0-9_-]+$/.test(middle)) out.push(join(dir, name));
    }
    return out.sort();
  } catch {
    return [];
  }
}

function readMarkerFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isFresh(marker: Record<string, unknown>, now: number): boolean {
  const startedAtMs = Date.parse(String(marker.started_at));
  if (!Number.isFinite(startedAtMs)) return false;
  const ageMs = now - startedAtMs;
  return ageMs >= 0 && ageMs <= MAX_SESSION_AGE_MS;
}

/**
 * Grava o marker de sessão ativa. Idempotente — sobrescreve `started_at` se já
 * existir. **Sempre grava `phase: "briefing"` (#4450)** — `--start` roda tanto
 * numa rodada genuinamente nova (segue pro briefing normal, arma
 * `--phase autonomous` no passo 8) quanto no Resume de uma rodada existente
 * (passo 1, sempre executado de novo mesmo quando o passo 0 pula direto pra
 * Fase 1/1.5/2) — e nos dois casos o valor logo após `--start` É "briefing"
 * até o passo seguinte decidir o contrário. **Isto NÃO significa que uma
 * rodada retomada fica desprotegida**: o passo 0 (Resume) re-arma
 * `--phase autonomous` explicitamente, imediatamente após este `--start`,
 * exatamente porque `--start` sempre reseta pra "briefing" — os dois passos
 * são um par deliberado, não uma coincidência de ordem.
 *
 * `sessionId` (#5156, opcional) grava o campo `session_id` no marker quando
 * fornecido — omitido, o marker sai no formato antigo (sem o campo), que os
 * dois hooks consumidores tratam como "comportamento pré-#5156" (ver docblock
 * do topo do arquivo).
 *
 * **#9347:** com `sessionId`, grava no arquivo POR SESSÃO (ver
 * `activeSessionPath`) — nunca toca o marker de outra rodada viva nesta
 * máquina. Duas limpezas, ambas restritas ao que comprovadamente não é de
 * outra rodada viva: (1) migração — um marker LEGADO cujo `session_id` é o
 * desta mesma sessão (rodada iniciada antes do #9347 e retomada agora) é
 * removido, pra não sobrar cópia duplicada; (2) markers por-sessão de OUTRAS
 * sessões já stale (>24h, sem `started_at` válido, ou JSON corrompido) são
 * podados — uma rodada que crashou sem `--end` nunca mais teria o arquivo
 * sobrescrito, ao contrário do legado.
 */
export function startSession(repoRoot: string, startedAtIso: string, sessionId?: string): void {
  const tag = machineTag();
  const path = activeSessionPath(repoRoot, tag, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const marker: Record<string, unknown> = { started_at: startedAtIso, phase: "briefing" };
  if (sessionId) marker.session_id = sessionId;
  writeFileSync(path, JSON.stringify(marker), "utf8");
  if (!sessionId) return;
  const legacyPath = activeSessionPath(repoRoot, tag);
  const now = Date.parse(startedAtIso);
  for (const other of listActiveSessionMarkerPaths(repoRoot, tag)) {
    if (other === path) continue;
    try {
      const m = readMarkerFile(other);
      if (other === legacyPath) {
        if (m && m.session_id === sessionId) rmSync(other, { force: true });
        continue;
      }
      if (Number.isFinite(now) && (!m || !isFresh(m, now))) rmSync(other, { force: true });
    } catch {
      // Poda é best-effort — nunca derruba o --start.
    }
  }
}

/** Resultado de `endSession` (#9347) — o que foi removido e o que foi preservado. */
export interface EndSessionResult {
  removed: string[];
  /** Marker legado preservado por pertencer a OUTRA sessão (ou não ser atribuível a esta). */
  keptForeign: string | null;
}

/**
 * Remove o marker de sessão ativa. Idempotente — no-op se já ausente.
 *
 * **#9347 — só remove o que é DESTA sessão.** Com `sessionId`: remove o
 * arquivo por-sessão dela e o marker legado SÓ se o `session_id` gravado nele
 * for o desta sessão (rodada pré-#9347). O legado de OUTRA sessão — ou
 * anônimo, que não dá pra atribuir — nunca é apagado por um `--end` alheio:
 * era exatamente o bug (a 2ª rodada encerrava e desarmava em silêncio o guard
 * da Regra 1 da 1ª, ainda viva). Sem `sessionId` (chamada anônima): remove só
 * um legado também anônimo — nunca um marker que declara dono.
 */
export function endSession(repoRoot: string, sessionId?: string): EndSessionResult {
  const tag = machineTag();
  const removed: string[] = [];
  let keptForeign: string | null = null;
  if (sessionId) {
    const own = activeSessionPath(repoRoot, tag, sessionId);
    if (existsSync(own)) {
      rmSync(own, { force: true });
      removed.push(own);
    }
  }
  const legacyPath = activeSessionPath(repoRoot, tag);
  if (existsSync(legacyPath)) {
    const owner = readMarkerFile(legacyPath)?.session_id;
    const isOwn = sessionId ? owner === sessionId : owner === undefined || owner === null;
    if (isOwn) {
      rmSync(legacyPath, { force: true });
      removed.push(legacyPath);
    } else {
      keptForeign = legacyPath;
    }
  }
  return { removed, keptForeign };
}

/**
 * (#9451) `--end` SEM `--session-id` só remove um legado anônimo — nunca um
 * marker por-sessão. Se há marker por-sessão nesta máquina, a causa quase
 * certa é a injeção do `--session-id` ter falhado (comando encadeado/pipado,
 * `inject-session-id.mjs` recusa de propósito): o marker da rodada sobrevive
 * (até 24h travando o `AskUserQuestion` dela e mascarando stall de outra
 * rodada no watchdog) enquanto o CLI dizia "removido: nada" com exit 0.
 * Devolve a mensagem de erro nesse caso (o CLI sai com exit 1), `null` caso
 * contrário. `--allow-no-session-id` preserva o comportamento antigo.
 */
export function anonymousEndError(
  repoRoot: string,
  sessionId: string | undefined,
  allowAnonymous: boolean,
  tag: string = machineTag(),
): string | null {
  if (sessionId || allowAnonymous) return null;
  const legacyPath = activeSessionPath(repoRoot, tag);
  const perSession = listActiveSessionMarkerPaths(repoRoot, tag).filter((p) => p !== legacyPath);
  if (perSession.length === 0) return null;
  return (
    `--end sem --session-id não remove marker por-sessão, e há ${perSession.length} nesta máquina ` +
    `(${perSession.join(", ")}). Provável injeção de --session-id recusada (comando encadeado/pipado — ` +
    "context/overnight-dispatch-rules.md item 18). Rode `npx tsx scripts/overnight-session-marker.ts --end` " +
    "STANDALONE, ou passe --session-id explicitamente (#9451)."
  );
}

/**
 * (#9347) Resolve QUAL arquivo de marker `setPhase` deve atualizar:
 *   - com `sessionId`: o por-sessão, se existir; senão o legado, se ele for
 *     desta sessão ou anônimo (rodada pré-#9347, ou `--start` anônimo seguido
 *     de `--phase` já com o id — contrato #5156); senão nenhum.
 *   - sem `sessionId`: o legado, se existir; senão o ÚNICO por-sessão desta
 *     máquina (2+ → nenhum: ambíguo, nunca chuta qual rodada mexer).
 */
function resolvePhaseTarget(repoRoot: string, sessionId?: string): string | null {
  const tag = machineTag();
  const legacyPath = activeSessionPath(repoRoot, tag);
  if (sessionId) {
    const own = activeSessionPath(repoRoot, tag, sessionId);
    if (existsSync(own)) return own;
    if (existsSync(legacyPath)) {
      const owner = readMarkerFile(legacyPath)?.session_id;
      if (owner === undefined || owner === null || owner === sessionId) return legacyPath;
    }
    return null;
  }
  if (existsSync(legacyPath)) return legacyPath;
  const perSession = listActiveSessionMarkerPaths(repoRoot, tag).filter((p) => p !== legacyPath);
  return perSession.length === 1 ? perSession[0]! : null;
}

/**
 * Lê o `phase` atual do marker, sem mutar nada — #8174. Consumido por
 * `overnight-watchdog.ts` pra distinguir "coordenador legitimamente bloqueado
 * esperando o `AskUserQuestion` do briefing" (que não tem teto de tempo — o
 * editor pode demorar o quanto quiser pra responder, ver §"Briefing" da
 * SKILL.md) de "morreu no meio do loop autônomo" (aí sim, stall real).
 *
 * Fail-soft TOTAL, mesmo espírito de `setPhase`: marker ausente (nenhuma
 * rodada overnight ativa nesta máquina), JSON corrompido, ou campo `phase`
 * ausente/de tipo inesperado — tudo isso devolve `null`, nunca lança. `null`
 * é tratado pelo caller como "não sei dizer" — não é o mesmo que `"briefing"`
 * nem que `"autonomous"`, então nunca suprime um alarme por engano quando o
 * marker simplesmente não existe (rodada que nunca chamou `--start`, ou já
 * foi encerrada via `--end`).
 *
 * **#9347 — agregação multi-marker:** com várias rodadas vivas nesta máquina
 * (um marker por sessão), `sessionId` seleciona o dessa sessão. Sem ele (caso
 * do watchdog, que não conhece o `session_id` da rodada): com um único marker,
 * devolve o `phase` dele (comportamento pré-#9347, sem filtro de staleness);
 * com vários, considera só os não-stale (≤24h) e devolve `"briefing"` se
 * QUALQUER um está em briefing, senão `"autonomous"` se algum está, senão
 * `null`. Trade-off aceito: uma rodada em briefing mascara o stall de outra,
 * autônoma, na mesma máquina — mesmo escopo amplo já aceito no #8174, e o
 * cenário (2 rodadas simultâneas, uma travada) é raro.
 */
export function readPhase(
  repoRoot: string,
  tag: string = machineTag(),
  sessionId?: string,
  now: number = Date.now(),
): OvernightPhase | null {
  const pick = (m: Record<string, unknown> | null | undefined): OvernightPhase | null =>
    m?.phase === "briefing" || m?.phase === "autonomous" ? (m.phase as OvernightPhase) : null;
  const markers = listActiveSessionMarkerPaths(repoRoot, tag)
    .map(readMarkerFile)
    .filter((m): m is Record<string, unknown> => m !== null);
  if (sessionId) return pick(markers.find((m) => m.session_id === sessionId));
  if (markers.length === 1) return pick(markers[0]);
  const phases = markers.filter((m) => isFresh(m, now)).map((m) => pick(m));
  if (phases.includes("briefing")) return "briefing";
  if (phases.includes("autonomous")) return "autonomous";
  return null;
}

/**
 * Atualiza SÓ o campo `phase` do marker já existente — preserva `started_at`
 * (e qualquer outro campo futuro) intacto (#4450). Retorna `false`, sem
 * lançar, quando não há marker pra atualizar: `--start` nunca rodou nesta
 * rodada, o marker já foi removido por `--end`, ou o JSON está corrompido no
 * disco — falha graciosa, o caller (CLI abaixo) decide como reportar (aviso +
 * exit code, nunca stack trace). Retorna `true` em sucesso.
 *
 * `sessionId` (#5156, opcional) grava/atualiza `session_id` no marker junto
 * da mudança de fase — útil quando `--start` rodou sem a flag (ex: resume de
 * uma rodada iniciada antes do #5156) mas o `session_id` já está disponível
 * agora. Omitido, preserva o `session_id` já presente (se houver) intocado —
 * mesmo espírito de "preserva campos que não conhece".
 *
 * **#9347:** qual arquivo é atualizado sai de `resolvePhaseTarget` — nunca o
 * marker de OUTRA sessão viva.
 */
export function setPhase(repoRoot: string, phase: OvernightPhase, sessionId?: string): boolean {
  const path = resolvePhaseTarget(repoRoot, sessionId);
  if (!path) return false;
  try {
    const current = JSON.parse(readFileSync(path, "utf8"));
    const updated = { ...current, phase };
    if (sessionId) updated.session_id = sessionId;
    writeFileSync(path, JSON.stringify(updated), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * (#6232) Resolve o `session_id` a gravar/atualizar no marker antes de
 * `--start`/`--phase` rodarem — nunca deixa passar em silêncio o caso que
 * causou o incidente de origem: um marker gravado SEM `session_id` muda o
 * ESCOPO do bloqueio de `AskUserQuestion` de "esta sessão" pra "a máquina
 * inteira" (fallback pré-#5156 em
 * `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs`), e nada
 * sinalizava essa degradação até agora — o script gravava com sucesso e
 * seguia calado (achado ao vivo #6232: as duas causas raiz, chamadas
 * encadeadas/pipadas que `.claude/hooks/inject-session-id.mjs` recusa de
 * propósito, não injetaram `--session-id`, e nada avisou).
 *
 * Três caminhos, mutuamente exclusivos:
 *   1. `sessionId` presente → devolve ele, sem aviso — caminho normal
 *      (chamada standalone, injeção automática funcionou).
 *   2. `sessionId` ausente + `allowAnonymous` (`--allow-no-session-id`) →
 *      devolve `undefined` (marker sai no formato antigo, pré-#5156) MAS
 *      avisa ALTO no stderr — opt-in explícito, nunca silencioso. Existe pra
 *      não travar um caminho legítimo fora do harness (chamada manual de
 *      debug, script rodando fora de uma sessão Claude Code) — mas quem
 *      escolhe isso precisa VER que escolheu.
 *   3. `sessionId` ausente sem o opt-in → lança. **Decisão deste PR:** falha
 *      dura, simétrica ao `requireSessionId` de
 *      `scripts/lib/session-registry.ts` (que já lança sem opt-in nenhum) —
 *      a assimetria entre os dois scripts, um falhando alto e o outro
 *      degradando em silêncio pra exatamente a mesma causa (comando
 *      encadeado/pipado que `inject-session-id.mjs` recusa), foi o próprio
 *      achado da issue. Falhar duro aqui não quebra nenhum fluxo de
 *      resume/skill documentado: toda chamada de `--start`/`--phase` das
 *      skills overnight é standalone (nunca `&&`/`;`/pipe/heredoc — a skill
 *      já instrui isso pra `session-registry.ts`, ver `context/
 *      overnight-dispatch-rules.md` item 18) e roda dentro do harness, onde
 *      `payload.session_id` está disponível pro hook injetar. Só quebra
 *      exatamente o padrão que já era o bug (chamada encadeada) — e quebrar
 *      ALTO nesse caso é o comportamento correto: melhor um `exit 1`
 *      explícito no passo 1 da Fase 0 do que um marker anônimo silencioso
 *      travando `AskUserQuestion` pra máquina inteira horas depois.
 */
export function resolveSessionIdOrThrow(
  sessionId: string | undefined,
  allowAnonymous: boolean,
): string | undefined {
  if (sessionId) return sessionId;
  if (allowAnonymous) {
    process.stderr.write(
      "overnight-session-marker: AVISO — gravando marker SEM session_id (--allow-no-session-id). " +
        "Isso muda o escopo do guard de AskUserQuestion de 1 SESSÃO pra a MÁQUINA INTEIRA " +
        "(fallback pré-#5156 em .claude/hooks/block-askuserquestion-overnight-autonomous.mjs) — " +
        "qualquer outra sessão nesta máquina também será bloqueada durante a Fase autônoma. " +
        "Use só quando você sabe que é isso que quer (#6232).\n",
    );
    return undefined;
  }
  throw new Error(
    "--session-id ausente. Normalmente injetado automaticamente por .claude/hooks/inject-session-id.mjs " +
      "quando este comando roda STANDALONE (nunca em &&/;/pipe/heredoc — ver context/overnight-dispatch-rules.md " +
      "item 18). Um marker sem session_id muda o escopo do bloqueio de AskUserQuestion de 1 sessão pra a " +
      "MÁQUINA INTEIRA, sem aviso nenhum antes deste PR (#6232) — por isso este script agora falha alto em vez " +
      "de degradar em silêncio. Corrija a chamada pra standalone (deixa a injeção automática funcionar), passe " +
      "--session-id explicitamente, ou — só se for essa a intenção — passe --allow-no-session-id.",
  );
}

if (isMainModule(import.meta.url)) {
  const repoRoot = process.cwd();
  const argv = process.argv.slice(2);
  const arg = argv[0];
  const parsed = parseArgs(argv);
  // #5156: --session-id normalmente chega injetado por .claude/hooks/inject-session-id.mjs
  // (a skill nunca sabe o próprio session_id pra passar manualmente) — parseado via
  // parseArgs pra não depender de posição fixa relativa a --phase <valor>.
  const rawSessionId = parsed.values["session-id"];
  const allowAnonymous = parsed.flags.has("allow-no-session-id");
  if (arg === "--start") {
    try {
      const sessionId = resolveSessionIdOrThrow(rawSessionId, allowAnonymous);
      startSession(repoRoot, new Date().toISOString(), sessionId);
      process.stdout.write(
        `overnight session marker: started, phase=briefing${sessionId ? `, session_id=${sessionId}` : ""} (${activeSessionPath(repoRoot, undefined, sessionId)})\n`,
      );
    } catch (err) {
      process.stderr.write(`overnight-session-marker: erro — ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
  } else if (arg === "--end") {
    // #9347: --end só remove o marker DESTA sessão. Sem --session-id (chamada
    // anônima) só remove um legado também anônimo — nunca o de outra rodada.
    const { removed, keptForeign } = endSession(repoRoot, rawSessionId);
    process.stdout.write(
      `overnight session marker: ended${rawSessionId ? `, session_id=${rawSessionId}` : ""} ` +
        `(removido: ${removed.length ? removed.join(", ") : "nada — já ausente"})\n`,
    );
    if (keptForeign) {
      process.stderr.write(
        `overnight session marker: preservado ${keptForeign} — pertence a OUTRA sessão (ou não é atribuível a ` +
          "esta chamada); um --end alheio nunca apaga o marker de outra rodada viva (#9347).\n",
      );
    }
    const anonErr = anonymousEndError(repoRoot, rawSessionId, allowAnonymous);
    if (anonErr) {
      process.stderr.write(`overnight-session-marker: erro — ${anonErr}\n`);
      process.exitCode = 1;
    }
  } else if (arg === "--phase") {
    const phase = argv[1];
    if (phase !== "briefing" && phase !== "autonomous") {
      process.stderr.write("uso: npx tsx scripts/overnight-session-marker.ts --phase <briefing|autonomous>\n");
      process.exitCode = 1;
    } else {
      try {
        const sessionId = resolveSessionIdOrThrow(rawSessionId, allowAnonymous);
        if (setPhase(repoRoot, phase, sessionId)) {
          process.stdout.write(
            `overnight session marker: phase=${phase}${sessionId ? `, session_id=${sessionId}` : ""}\n`,
          );
        } else {
          process.stderr.write(
            `overnight session marker: nenhum marker desta sessão em ${activeSessionPath(repoRoot, undefined, sessionId)} ` +
              "(nem legado atribuível a ela) — rode --start antes de --phase\n",
          );
          process.exitCode = 1;
        }
      } catch (err) {
        process.stderr.write(`overnight-session-marker: erro — ${(err as Error).message}\n`);
        process.exitCode = 1;
      }
    }
  } else {
    process.stderr.write("uso: npx tsx scripts/overnight-session-marker.ts --start | --end | --phase <briefing|autonomous>\n");
    process.exitCode = 1;
  }
}
