/**
 * pr-checks-gate.ts (#6225)
 *
 * Lógica PURA/testável para a **condição 1** do gate de merge autônomo
 * (overnight/develop/continuo, #2210/#2222): "todos os checks do PR estão
 * verdes?". A formulação anterior, só em prosa na SKILL —
 *
 *   `gh pr checks {N} --json bucket --jq '[.[] | select(.bucket != "pass")] | length'`
 *
 * — não roda no `gh` 2.46.0 do `helios` (apt do Ubuntu): a flag `--json` só
 * chegou em `gh pr checks` em versão posterior. O comando falha em stderr
 * com `exit 1`, e dentro de `$(...)` isso vira **string vazia** — qualquer
 * comparação que trate "vazio" como "0 achados" (`[ -z "$X" ]`,
 * `${X:-0}`) inverte o gate pra falso-verde (achado ao vivo #6225, aplicado
 * ao PR #6212).
 *
 * Este módulo substitui a condição 1 por `gh pr view --json
 * statusCheckRollup`, que roda na versão instalada tanto no `helios` quanto
 * na máquina do editor (confirmado na própria issue #6225). O I/O (chamar
 * `gh`, tratar exit code/JSON malformado) fica no entrypoint CLI
 * (`scripts/check-pr-checks-gate.ts`) — mesmo padrão de
 * `scripts/lib/trade-off-label-gate.ts` / `scripts/check-trade-off-label-cleared.ts`.
 * Este arquivo só decide, a partir do payload já parseado, qual é o
 * veredito.
 *
 * ## Por que 4 estados, não 2 ("verde"/"vermelho")
 *
 * A condição 2 do mesmo gate (threads de review) já trata "a query falhou"
 * como caso distinto de "0 threads não-resolvidas" (ver
 * `.claude/skills/diaria-overnight/SKILL.md`, comentário "nunca tratar erro
 * como 0 threads"). A condição 1 não tinha esse guard — é o próprio bug
 * desta issue. Por isso o veredito distingue:
 *
 *   - `"pass"`    : todos os checks presentes estão `COMPLETED` com
 *                   conclusão de sucesso (`SUCCESS`/`NEUTRAL`/`SKIPPED`).
 *                   Único estado que autoriza a condição 1 do gate.
 *   - `"fail"`    : ao menos um check `COMPLETED` com conclusão que não é
 *                   de sucesso (`FAILURE`, `CANCELLED`, `TIMED_OUT`,
 *                   `ACTION_REQUIRED`, `STALE`, `STARTUP_FAILURE`, etc).
 *   - `"pending"` : nenhum check falhou, mas ao menos um ainda não é
 *                   `COMPLETED` (rodando/enfileirado) — **ou** o PR não tem
 *                   nenhum check registrado ainda (`statusCheckRollup`
 *                   vazio). Mesmo espírito do "exit 8 / lista vazia =
 *                   PENDENTE, nunca verde nem vermelho" já documentado na
 *                   SKILL pro `--watch`: um PR recém-criado, antes dos jobs
 *                   serem registrados pelo GitHub, não pode ler como "0
 *                   checks reprovados" só porque o array está vazio.
 *   - `"error"`   : o payload não tem o formato esperado (`statusCheckRollup`
 *                   ausente ou não é array) — sintoma de resposta malformada
 *                   do `gh`/API. Puro nunca lança; quem detecta falha de
 *                   *comando* (exit code != 0, JSON.parse jogando) é o
 *                   entrypoint CLI, que produz este mesmo veredito antes de
 *                   sequer chamar a função pura daqui.
 *   - `"blocked_by_conflict"` (#6768): nenhum check chegou a começar
 *                   (`statusCheckRollup` vazio, ou nenhuma entrada tem
 *                   `startedAt` — todas ainda `QUEUED`) **e** o PR está
 *                   `mergeable === "CONFLICTING"` contra a base. Quando o
 *                   GitHub não consegue computar o merge ref (branch em
 *                   conflito), o trigger `pull_request` nunca dispara — o
 *                   check-suite fica `queued` pra sempre, sem nunca virar
 *                   `workflow_run`. Reportar isso como `pending` genérico
 *                   (mesmo veredito de "CI ainda não teve tempo de rodar")
 *                   levava o coordenador a esperar o timeout de 30 min do
 *                   #2381 achando que era CI lento — medido ao vivo no PR
 *                   #6765 (rodada overnight 260829b). Distinto de `pending`:
 *                   nenhuma espera resolve isso, só um merge/rebase com a
 *                   base. `mergeable` é opcional (2º parâmetro de
 *                   `evaluatePrChecksGate`) — quando omitido (chamadores
 *                   antigos, testes existentes) este veredito nunca é
 *                   produzido, comportamento idêntico ao de antes do #6768.
 *
 * **Nenhum destes 4 estados equivale a "autorizado" exceto `"pass"`** — é
 * essa a garantia central: comando que falhou (seja na chamada ao `gh`, seja
 * num payload que não bate o formato esperado) nunca é lido como "0 checks
 * reprovados, logo pode mergear".
 */

export type PrChecksGateVerdict = "pass" | "fail" | "pending" | "error" | "blocked_by_conflict";

export interface PrCheckNode {
  name?: string;
  /** `CheckRun` (GitHub Actions). Ex: `"COMPLETED"`, `"IN_PROGRESS"`, `"QUEUED"`, `"PENDING"`. */
  status?: string | null;
  /** `CheckRun`. Ex: `"SUCCESS"`, `"FAILURE"`, `"NEUTRAL"`, `"SKIPPED"`, `null` (ainda rodando). */
  conclusion?: string | null;
  /** `StatusContext` (commit-status API legada — CI de terceiro, deploy
   * preview, etc). `statusCheckRollup` é uma UNION `CheckRun | StatusContext`
   * no GraphQL, e esse segundo membro não tem `status`/`conclusion`: tem
   * `state` (`"SUCCESS"`/`"FAILURE"`/`"ERROR"`/`"PENDING"`/`"EXPECTED"`).
   * Hoje este repo só produz `CheckRun`, mas basta alguém plugar um serviço
   * externo pra aparecer. Ver `evaluatePrChecksGate`. */
  state?: string | null;
  /** Discriminante da union, quando o `gh` o inclui. */
  __typename?: string;
  /** ISO 8601. Usado para desempatar runs SUPERSEDIDAS — ver
   * `keepLatestPerName`. Ausente em payloads antigos/parciais. */
  startedAt?: string | null;
}

/**
 * Um force-push NÃO substitui a entrada do check no `statusCheckRollup`: a run
 * antiga fica lá como `CANCELLED` e a nova entra ao lado, **com o mesmo
 * `name`**. Medido ao vivo no PR #6239 (rodada overnight 260826), logo depois
 * de um rebase:
 *
 * ```
 * Unused code check | CANCELLED | started=11:49:01
 * Unused code check | SUCCESS   | started=11:49:35
 * ```
 *
 * Sem desduplicar, `CANCELLED` (que não está em `PASSING_CONCLUSIONS`) faz o
 * gate reprovar um PR cuja run vigente está inteira verde. É falso-VERMELHO,
 * então nunca deixa passar merge ruim — mas trava merge legítimo, e trava
 * **para sempre**, porque a entrada cancelada não sai do rollup.
 *
 * Desduplica por `name`, mantendo a de `startedAt` mais recente — **e só
 * quando todas as entradas do grupo têm timestamp válido**.
 *
 * A 1ª versão deste fix desempatava com `""` para timestamp ausente, o que
 * fazia o lado SEM timestamp sempre perder, independente de qual run era a
 * mais nova. Achado no review (alta confiança, P1): um `FAILURE` novo sem
 * `startedAt` era descartado em favor de um `SUCCESS` antigo com timestamp, e
 * o gate devolvia `pass` — **falso-verde**, exatamente o que ele existe para
 * impedir. Sem timestamp em todas, não há como provar quem supersede quem, e
 * desempatar por posição descarta um check real com base em palpite: agora o
 * grupo inteiro é mantido, e o pior veredito prevalece.
 *
 * Node sem `name` não é desduplicável (não há chave) e passa inteiro.
 */
export function keepLatestPerName(nodes: readonly PrCheckNode[]): PrCheckNode[] {
  const porNome = new Map<string, PrCheckNode[]>();
  const ordem: string[] = [];
  const semNome: PrCheckNode[] = [];

  for (const node of nodes) {
    const name = typeof node?.name === "string" && node.name.length > 0 ? node.name : null;
    if (name === null) {
      semNome.push(node);
      continue;
    }
    if (!porNome.has(name)) {
      porNome.set(name, []);
      ordem.push(name);
    }
    porNome.get(name)!.push(node);
  }

  const out: PrCheckNode[] = [];
  for (const name of ordem) {
    const grupo = dropSupersededCancelled(porNome.get(name)!);
    if (grupo.length === 1) {
      out.push(grupo[0]);
      continue;
    }
    // Só desduplica quando TODAS as entradas do grupo têm timestamp válido —
    // aí dá pra provar qual supersede qual. Se qualquer uma não tiver, não há
    // como ordenar, e desempatar por posição descartaria um check real com
    // base em palpite: mantém TODAS, e o pior veredito do grupo prevalece
    // (falso-vermelho, nunca falso-verde).
    const todasComTimestamp = grupo.every((n) => parseStartedAt(n.startedAt) !== null);
    if (!todasComTimestamp) {
      out.push(...grupo);
      continue;
    }
    let maisNova = grupo[0];
    for (const n of grupo.slice(1)) {
      // `>=` mantém a última em caso de empate exato de timestamp.
      if (parseStartedAt(n.startedAt)! >= parseStartedAt(maisNova.startedAt)!) maisNova = n;
    }
    out.push(maisNova);
  }
  return [...out, ...semNome];
}

/**
 * #6768: um node "deu sinal" (algo do CI de fato aconteceu pra ele) quando:
 * - `CheckRun` já `COMPLETED` — passou ou falhou, não importa `startedAt`
 *   (um payload parcial/antigo pode não trazer o campo mesmo já concluído).
 * - `CheckRun` com `startedAt` válido — está rodando ou já rodou.
 * - `StatusContext` com `state` fora de `PENDING_STATES` — já resolveu.
 *
 * Sem isso (`nenhumComecou` calculado só por `startedAt` ausente, achado do
 * self-review do PR #6770), um `StatusContext` — que estruturalmente NUNCA
 * tem `startedAt` — ou um `CheckRun` `COMPLETED` de payload parcial sem o
 * campo eram lidos como "não começou", produzindo `blocked_by_conflict` por
 * cima de um check que na verdade já `FAILURE`/`SUCCESS`.
 */
function hasStartedSignal(node: PrCheckNode): boolean {
  if (typeof node.state === "string") return !PENDING_STATES.has(node.state);
  if (node.status === "COMPLETED") return true;
  return parseStartedAt(node.startedAt) !== null;
}

function isCancelledCheckRun(node: PrCheckNode): boolean {
  return node.status === "COMPLETED" && node.conclusion === "CANCELLED";
}

/**
 * #6766: um evento `labeled` no PR (ex: aplicar uma label depois de um
 * `gh run rerun`) pode disparar um 2º `workflow_run` separado do MESMO
 * workflow para o MESMO SHA — que o `concurrency: cancel-in-progress` do
 * workflow cancela quase na hora. O `statusCheckRollup` acumula as DUAS
 * entradas com o MESMO `name`: uma `CANCELLED` (do run cancelado) e uma
 * `SUCCESS`/`FAILURE` (do run que de fato terminou — o original, ou um
 * rerun de job dentro dele).
 *
 * `startedAt` **não** ordena essas duas de forma confiável — medido ao
 * vivo no PR #6764: o run cancelado tinha `startedAt` MAIS TARDE que o
 * run bem-sucedido (o job do run cancelado só chegou a ser agendado depois
 * que o outro já tinha COMEÇADO, mesmo terminando antes) — "manter a
 * entrada de `startedAt` mais recente" (o `keepLatestPerName` de baixo)
 * escolhia a `CANCELLED` errada e reportava `fail` com CI genuinamente
 * verde. Por isso este passo roda ANTES da comparação por timestamp: um
 * `CANCELLED` nunca compete por horário contra uma entrada não-cancelada
 * do mesmo nome — se existe qualquer substituta (`SUCCESS`, `FAILURE`, ou
 * ainda em andamento), a(s) `CANCELLED` são descartadas incondicionalmente.
 * Um `CANCELLED` **sozinho** (sem substituta, cancelamento humano de fato)
 * continua contando — ausência de sinal nunca é aprovação (ver teste
 * "CANCELLED SEM run mais nova continua reprovando").
 */
function dropSupersededCancelled(grupo: PrCheckNode[]): PrCheckNode[] {
  if (grupo.length <= 1) return grupo;
  const cancelados = grupo.filter(isCancelledCheckRun);
  if (cancelados.length === 0 || cancelados.length === grupo.length) return grupo;
  return grupo.filter((n) => !isCancelledCheckRun(n));
}

/**
 * `startedAt` utilizável para ordenar, ou `null`.
 *
 * Rejeita ausente, não-string, não-parseável e o placeholder de "sem valor"
 * que o GitHub emite (`0001-01-01T00:00:00Z`, observado em `completedAt` de
 * run em andamento) — tratá-lo como data real o colocaria como o MAIS ANTIGO
 * de qualquer grupo, o que é uma afirmação que o payload não fez.
 */
function parseStartedAt(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("0001-01-01")) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * #7105: `opts.now` utilizável em ms desde epoch, ou `null` se malformado.
 * Aceita ISO 8601 (mesmo parser de `parseStartedAt`) ou epoch ms direto.
 * Omitido → `Date.now()` (não-determinístico de propósito: chamador real
 * quer "agora" de verdade; testes sempre passam um valor fixo).
 */
function resolveNowMs(raw: string | number | undefined): number | null {
  if (raw === undefined) return Date.now();
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  return parseStartedAt(raw);
}

export interface PrChecksGateResult {
  verdict: PrChecksGateVerdict;
  /** Nomes dos checks com conclusão que não é sucesso (só quando `verdict === "fail"`). */
  failingChecks: string[];
  /** Nomes dos checks ainda não `COMPLETED` (só quando `verdict === "pending"` por check em andamento). */
  pendingChecks: string[];
  /** Motivo legível — sempre presente, útil pra log/halt banner. */
  reason: string;
}

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** `StatusContext.state` — o vocabulário é outro e menor que o de `CheckRun`. */
const PASSING_STATES = new Set(["SUCCESS"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

/**
 * #7060: janela (ms) dentro da qual um check que começou logo após o push
 * do commit HEAD é tratado como suspeito, não como veredito confiável — o
 * GitHub recalcula o merge ref (`refs/pull/{N}/merge`) de forma
 * ASSÍNCRONA depois de um push; um run que dispara antes desse recálculo
 * terminar carrega `head_sha` novo mas árvore VELHA (achado ao vivo:
 * commit pushado às 02:13:53, run criado às 02:14:00 — 7s de gap — reprovou
 * uma asserção que o próprio commit já tinha removido). Grosseiro (não
 * confirma o que o run de fato checou — ver direção 2 da issue), mas
 * barato e erra pro lado seguro: dentro da janela, o veredito (fail OU
 * pass) vira `"pending"`, nunca autoriza um merge nem dispara um fixer
 * pra um bug que não existe. Default generoso (~3x o gap medido) porque o
 * custo de errar pra "espera mais um pouco" é baixo — o próximo poll do
 * chamador (que já espera "pending" significar "tenta de novo") resolve
 * sozinho assim que os checks genuínos aparecerem.
 *
 * **#7105: essa última frase só ficou verdadeira depois deste fix.** A 1ª
 * versão (#7060) comparava só dois timestamps FIXOS — `startedAt` do check
 * e `headCommittedAt` — e nenhum dos dois muda depois que o rollup se
 * estabiliza: um run cujo `startedAt` caísse dentro da janela deixava o
 * veredito `pending` em TODA chamada futura, mesmo horas depois com o CI já
 * concluído e verde — nada no código fazia "o próximo poll resolver
 * sozinho". O fix introduziu `opts.now` (ver `EvaluatePrChecksGateOptions`)
 * — a janela só se aplica enquanto a AVALIAÇÃO em si acontece perto do
 * push, não só o `startedAt` do check.
 */
export const DEFAULT_RACE_WINDOW_MS = 20_000;

/** Segundo parâmetro opcional de `evaluatePrChecksGate` — ver `"blocked_by_conflict"` acima. */
export interface EvaluatePrChecksGateOptions {
  /** `gh pr view --json mergeable` → `"MERGEABLE" | "CONFLICTING" | "UNKNOWN"`. */
  mergeable?: string | null;
  /**
   * #7060: ISO 8601 de quando o commit HEAD atual foi pushado/commitado
   * (ex: `committedDate` do último item de `gh pr view --json commits`).
   * Quando fornecido, habilita a heurística de janela de corrida — ver
   * `DEFAULT_RACE_WINDOW_MS`/`raceWindowMs`. Omitido (chamadores antigos,
   * testes existentes, `merge-train-live.ts`): nenhuma mudança de
   * comportamento, idêntico ao pré-#7060.
   */
  headCommittedAt?: string | null;
  /** Sobrescreve `DEFAULT_RACE_WINDOW_MS` — só tem efeito com `headCommittedAt` presente. */
  raceWindowMs?: number;
  /**
   * #7105: instante (ISO 8601 ou epoch ms) em que o veredito está sendo
   * AVALIADO — "agora" pra decidir se a janela de corrida do #7060 ainda
   * vale. Sem isso, a heurística comparava só dois timestamps FIXOS
   * (`startedAt` do check × `headCommittedAt`) — nenhum dos dois muda
   * depois que o rollup se estabiliza, então uma vez que o run mais antigo
   * tivesse começado dentro da janela, o veredito ficava `"pending"` PARA
   * SEMPRE, em toda chamada subsequente, mesmo horas depois com o CI já
   * concluído e verde. Só tem efeito com `headCommittedAt` presente. Quando
   * omitido, usa `Date.now()` — testes devem sempre passar um valor fixo
   * pra determinismo (ver `test/pr-checks-gate.test.ts`).
   */
  now?: string | number;
}

/**
 * Decide o veredito da condição 1 do gate a partir do `statusCheckRollup`
 * já parseado de `gh pr view --json statusCheckRollup`. Puro, sem rede;
 * nunca lança — payload malformado vira `verdict: "error"`, nunca uma
 * exceção que o chamador precisaria capturar pra não confundir com "pass".
 *
 * `opts.mergeable`, quando fornecido, habilita o veredito
 * `"blocked_by_conflict"` (#6768) — ver docstring do tipo acima.
 * `opts.headCommittedAt`, quando fornecido, habilita a heurística de janela
 * de corrida (#7060) — ver docstring de `DEFAULT_RACE_WINDOW_MS`.
 */
export function evaluatePrChecksGate(
  statusCheckRollup: unknown,
  opts: EvaluatePrChecksGateOptions = {},
): PrChecksGateResult {
  if (!Array.isArray(statusCheckRollup)) {
    return {
      verdict: "error",
      failingChecks: [],
      pendingChecks: [],
      reason: "statusCheckRollup ausente ou não é um array — payload malformado, nunca tratar como 0 checks reprovados.",
    };
  }

  // #6768: rollup vazio (nem check nenhum registrado) + PR CONFLICTING com a
  // base é o caso mais claro — o GitHub não computa o merge ref pra rodar
  // `pull_request` neste SHA, então nem check-suite chega a existir. Checar
  // isto ANTES do early-return de array vazio abaixo, que senão produziria
  // `pending` pra este caso. O caso "checks existem mas nenhum começou"
  // (todos `QUEUED` sem `startedAt`) é resolvido mais abaixo, depois da
  // dedup — ver comentário perto de `pendingChecks`.
  if (statusCheckRollup.length === 0) {
    if (opts.mergeable === "CONFLICTING") {
      return {
        verdict: "blocked_by_conflict",
        failingChecks: [],
        pendingChecks: [],
        reason:
          "PR está CONFLICTING com a base e nenhum check chegou a ser registrado — o GitHub não computa o " +
          "merge ref pra rodar `pull_request` neste SHA. Esperar CI aqui é inútil; resolver o conflito (merge/rebase com a base) primeiro.",
      };
    }
    return {
      verdict: "pending",
      failingChecks: [],
      pendingChecks: [],
      reason: "nenhum check registrado ainda no PR (statusCheckRollup vazio) — pendente, não é aprovação por ausência.",
    };
  }

  const failingChecks: string[] = [];
  const pendingChecks: string[] = [];

  // Descarta runs supersedidas por force-push antes de julgar — ver
  // `keepLatestPerName`.
  const vigentes = keepLatestPerName(statusCheckRollup as PrCheckNode[]);

  for (const raw of vigentes) {
    const node = (raw ?? {}) as PrCheckNode;
    const label = typeof node.name === "string" && node.name.length > 0 ? node.name : "(sem nome)";

    // `statusCheckRollup` é uma union `CheckRun | StatusContext`. O 2º membro
    // (commit-status API legada: CI de terceiro, deploy preview) não tem
    // `status`/`conclusion` — tem `state`. Tratar os dois shapes.
    const hasCheckRunShape = typeof node.status === "string";
    const hasStatusContextShape = typeof node.state === "string";

    if (!hasCheckRunShape && !hasStatusContextShape) {
      // Shape desconhecido: nem `CheckRun` nem `StatusContext`. Classificar
      // como `pending` faria o gate travar em pendente PARA SEMPRE, sem nada
      // dizendo por quê — silencioso, e é justamente o que esta issue existe
      // pra impedir. `error` é ruidoso e distinguível, e continua nunca
      // sendo `pass`.
      return {
        verdict: "error",
        failingChecks: [],
        pendingChecks: [],
        reason:
          `check "${label}" tem shape desconhecido (sem \`status\` de CheckRun nem \`state\` de StatusContext) — ` +
          "não dá pra decidir aprovado/reprovado, e pendente-para-sempre seria silencioso.",
      };
    }

    if (hasStatusContextShape && !hasCheckRunShape) {
      const state = node.state as string;
      if (PENDING_STATES.has(state)) pendingChecks.push(label);
      else if (!PASSING_STATES.has(state)) failingChecks.push(label);
      continue;
    }

    if (node.status !== "COMPLETED") {
      pendingChecks.push(label);
      continue;
    }
    const conclusion = typeof node.conclusion === "string" ? node.conclusion : null;
    if (!conclusion || !PASSING_CONCLUSIONS.has(conclusion)) {
      failingChecks.push(label);
    }
  }

  // #7060: só relevante pros 2 veredictos DEFINITIVOS (fail/pass) — "pending"
  // já é conservador por si, "error"/"blocked_by_conflict" já são estados
  // próprios que não afirmam nada sobre o conteúdo checado.
  const raceWindowVerdict = (names: string[]): PrChecksGateResult | null => {
    if (typeof opts.headCommittedAt !== "string") return null;
    const pushedAtMs = parseStartedAt(opts.headCommittedAt);
    if (pushedAtMs === null) return null;
    const windowMs = opts.raceWindowMs ?? DEFAULT_RACE_WINDOW_MS;

    // #7105: a janela só vale enquanto a AVALIAÇÃO em si acontece perto do
    // push — não só o `startedAt` do check. `startedAt` e `headCommittedAt`
    // são timestamps FIXOS que nunca mudam depois que o rollup se
    // estabiliza; sem checar `now`, uma vez que o gap coubesse na janela,
    // TODA chamada futura (minutos, horas depois) reavaliava o mesmo gap
    // pequeno e ficava presa em `pending` para sempre — o próprio defeito
    // desta issue. `now >= pushedAtMs + windowMs` significa "essa avaliação
    // já não é mais próxima o bastante do push pra desconfiar" — usa o
    // veredito bruto dali em diante, mesmo sem nenhum check novo aparecer.
    const nowMs = resolveNowMs(opts.now);
    if (nowMs === null || nowMs - pushedAtMs >= windowMs) return null;

    const startedTimestamps = vigentes.map((n) => parseStartedAt(n?.startedAt)).filter((t): t is number => t !== null);
    if (startedTimestamps.length === 0) return null; // sem nenhum startedAt utilizável, não há como julgar — nunca fica mais rígido que antes do #7060
    const earliestStartedAtMs = Math.min(...startedTimestamps);

    // #7105: só um gap PRA FRENTE (run começou DEPOIS do push) é sinal de
    // corrida real — `Math.abs` da versão anterior também suspeitava de um
    // run que começou ANTES do push (run supersedido de um commit anterior
    // ainda presente no rollup), outra fonte de `pending` permanente que
    // nenhuma espera resolvia.
    const gapMs = earliestStartedAtMs - pushedAtMs;
    if (gapMs < 0 || gapMs >= windowMs) return null;

    return {
      verdict: "pending",
      failingChecks: [],
      pendingChecks: names,
      reason:
        `check(s) começaram ${Math.round(gapMs / 1000)}s após o push do commit HEAD, dentro da janela de ` +
        `corrida de ${Math.round(windowMs / 1000)}s (#7060) — o merge ref pode não ter sido recalculado ainda; ` +
        "tratando como pendente em vez de aceitar o veredito bruto (nunca aprova, nunca reprova nesta janela); " +
        "expira conforme `now` avança (#7105), mesmo sem nenhum check novo aparecer.",
    };
  };

  if (failingChecks.length > 0) {
    const race = raceWindowVerdict(failingChecks);
    if (race) return race;
    return {
      verdict: "fail",
      failingChecks,
      pendingChecks,
      reason: `${failingChecks.length} check(s) reprovado(s): ${failingChecks.join(", ")}`,
    };
  }

  if (pendingChecks.length > 0) {
    // #6768, 2º caso: o rollup TEM entradas (diferente do early-return de
    // array vazio acima), mas nenhuma delas deu qualquer sinal real ainda
    // (todas `QUEUED` sem `startedAt`, nenhuma `StatusContext` fora de
    // PENDING/EXPECTED). Calculado sobre `vigentes` (pós-dedup #6766) — não
    // sobre o rollup cru — pra não confundir um `CANCELLED` já descartado
    // com sinal de que "algo rodou". Também calculado sobre TODAS as
    // vigentes, não só as que caíram em `pendingChecks`: se qualquer uma já
    // é `COMPLETED` (passou, e por isso não foi empurrada pra nenhum
    // array), isso já é sinal de que o `pull_request` disparou — nunca
    // `blocked_by_conflict` nesse caso, mesmo que outro check ainda não
    // tenha começado.
    const nenhumComecou = vigentes.every((n) => !hasStartedSignal((n ?? {}) as PrCheckNode));
    if (nenhumComecou && opts.mergeable === "CONFLICTING") {
      return {
        verdict: "blocked_by_conflict",
        failingChecks: [],
        pendingChecks,
        reason:
          "PR está CONFLICTING com a base e nenhum check registrado chegou a começar (todos ainda sem " +
          "`startedAt`) — o GitHub não computa o merge ref pra rodar `pull_request` neste SHA. Esperar CI " +
          "aqui é inútil; resolver o conflito (merge/rebase com a base) primeiro.",
      };
    }
    return {
      verdict: "pending",
      failingChecks: [],
      pendingChecks,
      reason: `${pendingChecks.length} check(s) ainda não concluído(s): ${pendingChecks.join(", ")}`,
    };
  }

  const passRace = raceWindowVerdict(vigentes.map((n) => (typeof n?.name === "string" && n.name.length > 0 ? n.name : "(sem nome)")));
  if (passRace) return passRace;

  return {
    verdict: "pass",
    failingChecks: [],
    pendingChecks: [],
    // Conta as VIGENTES, não o rollup cru: com runs supersedidas por
    // force-push, o cru inclui entradas CANCELLED, e dizer "N checks, todos
    // com sucesso" sobre um número que inclui canceladas é afirmar algo
    // falso. Medido no PR #6239: 11 entradas cruas, 6 vigentes, 5 canceladas.
    reason:
      vigentes.length === statusCheckRollup.length
        ? `${vigentes.length} check(s), todos concluídos com sucesso.`
        : `${vigentes.length} check(s) vigente(s), todos concluídos com sucesso ` +
          `(${statusCheckRollup.length - vigentes.length} entrada(s) de run supersedida por force-push ignorada(s)).`,
  };
}

/** Açúcar pro chamador que só quer o booleano de autorização da condição 1. */
export function isPrChecksGateGreen(result: PrChecksGateResult): boolean {
  return result.verdict === "pass";
}
