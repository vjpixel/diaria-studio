/**
 * scripts/lib/alarm-issues.ts (#5112)
 *
 * Helper COMPARTILHADO que fecha o loop "achado de alarme agendado vira
 * issue automaticamente, e o e-mail linka a issue" — hoje todo alarme deste
 * repo (#4320/#4382/#4485/#4557/#4750/#4910/etc.) é sensor puro: detecta
 * drift, manda e-mail, avança o cursor de idempotência e para aí. Nenhum
 * cria issue, nenhum comenta em nada — o achado morre na caixa de entrada
 * do editor e, se ele não agir na hora, o guard de idempotência garante que
 * NUNCA MAIS chega outro e-mail sobre o MESMO drift.
 *
 * Escopo desta unidade: implementar só pra `home-meta-check.ts`
 * (ver wiring em `scripts/home-meta-check.ts`). Os outros 8 alarmes
 * do projeto (`hub-drift-check.ts`, `robots-txt-drift-check.ts`,
 * `worker-drift-check.ts`, `apoios-diff-alarm.ts`, `clarice-envio-alarm.ts`,
 * `clarice-guardrail-alarm.ts`, `clarice-opens-catchup-alarm.ts`,
 * `cursos-error-alarm.ts`, `geo-citation-staleness-alarm.ts`) ficam de fora
 * — follow-up futuro — mas a API nasce genérica de propósito (recebe
 * `{check, fingerprint, title, body, labels}`, devolve `{issueNumber, url,
 * action}`) pra não precisar de reescrita quando algum desses migrar.
 *
 * ─── Design: pure decision + I/O injetável (mesmo padrão do resto do repo) ──
 *
 * `planAlarmReconciliation` é PURA — decide o que fazer (ensure/comment/
 * close) só olhando pending findings + estado local, sem tocar rede.
 * `applyAlarmReconciliation` faz o I/O (chama `gh` via `GhRunFn` injetável,
 * mesmo padrão de `scripts/lib/shared/gh-run.ts`) e devolve o próximo estado
 * + o outcome por achado (pro e-mail citar a issue).
 *
 * ─── Dedup em 2 camadas (#5112 item 2) ──────────────────────────────────────
 *
 *   1. MAPA LOCAL (`AlarmIssuesState`, `data/{check}/alarm-issues.json` —
 *      path decidido pelo script chamador): fingerprint -> {issueNumber,
 *      url, missingStreak, closedAt}. Cache RÁPIDO pra família `"evento"` e
 *      pra `"estado"` já com `closedAt` setado — reusa a entry sem round-trip
 *      pro GitHub. `"estado"` com `closedAt: null` paga 1 round-trip extra
 *      (`gh issue view`) no cache-hit desde o #5989, pra confirmar que a
 *      issue não foi fechada por fora deste módulo — ver `fetchAlarmIssueState`
 *      e a docstring de `ensureAlarmIssue`.
 *   2. MARCADOR no corpo da issue (`<!-- alarm-finding: {check}:{fingerprint} -->`,
 *      `alarmFindingMarker`), buscado via `gh issue list --search` — usado
 *      SÓ quando o cache local não tem a entry (cache perdido/apagado,
 *      1ª execução depois de um `git clone` fresco, etc.). É a fonte de
 *      verdade que sobrevive à perda do cache: `data/` é local/gitignored,
 *      o marcador vive no GitHub.
 *
 * ─── Fail-soft (#5112 item 6) ───────────────────────────────────────────────
 *
 * Se `gh issue create` falhar (sem `gh` autenticado, rate limit, offline),
 * `ensureAlarmIssue` retorna `action: "failed"` com `error` — NUNCA fabrica
 * issueNumber/url. `applyAlarmReconciliation` deixa o estado daquele achado
 * INALTERADO nesse caso (não avança como se tivesse sido tratado — próxima
 * execução tenta de novo). O caller (script) é responsável por incluir o
 * motivo no e-mail mesmo assim — o e-mail NUNCA é suprimido por falha de
 * criação de issue, só perde a citação da issue pra aquele achado.
 *
 * ─── Allowlist de achados aceitos como limitação permanente (#5364) ────────
 *
 * Alguns achados nunca vão parar de reproduzir por design — não são bug,
 * são limitação de PLATAFORMA sem alavanca do lado do código (ex: #5364 —
 * merge tag nativo da Beehiiv que não localiza, sem fix possível no plano
 * Launch/free). O mecanismo de auto-close (`missingStreak`/
 * `CLOSE_ALARM_ISSUE_AFTER_RUNS` acima) só cobre o caso OPOSTO — achado que
 * PARA de reproduzir — então um achado permanente nunca fecha sozinho, e
 * fechar a issue manualmente sem mais nada faz o achado seguinte recriá-la
 * (mesmo fingerprint, sem issue aberta -> `ensureAlarmIssue` cria de novo).
 *
 * `AlarmAllowlist` resolve isso: uma lista, declarada em código pelo script
 * chamador (`check`/`fingerprint`/`reason`/`accepted_at`/`ref_issue` — nunca
 * um array de strings sem contexto, cf. requisito de auditabilidade), que
 * `planAlarmReconciliation` consulta pra pular TODA ação (`ensure`,
 * `comment_resolved`, `advance_streak`, `close`) sobre um fingerprint
 * aceito — tanto do lado `pending` (nunca cria/reabre) quanto do lado
 * `state` (uma entry de issue já existente pra esse fingerprint fica
 * congelada, sem mais comentário/fechamento automático). Isso já cobre
 * "reabrir issue fechada manualmente" sem lógica extra: o achado nunca
 * tenta criar/reabrir issue pra um fingerprint aceito, então fechar a
 * issue manualmente (ou via `Closes #NNNN` no PR que adiciona a entry) é
 * definitivo.
 *
 * Match é sempre EXATO (`check` + `fingerprint` iguais, nunca prefixo/regex)
 * — fail-safe: se o texto do achado mudar (o `message` que compõe o
 * fingerprint em checks como `home-meta-check.ts` muda), o
 * fingerprint muda, e a entry da allowlist para de casar automaticamente.
 * Silenciar por acidente um achado NOVO/diferente por causa de um match
 * frouxo seria pior que o problema que este mecanismo resolve.
 *
 * ─── Família ESTADO × EVENTO (#5553) ────────────────────────────────────────
 *
 * `AlarmFinding.family` (obrigatório, ver docstring do tipo) resolve um
 * problema estruturalmente igual ao da allowlist acima, mas na direção
 * OPOSTA: um achado de `family: "evento"` (ex: `campaign-{id}` em
 * `clarice-guardrail-alarm.ts`) desaparece de `pending` assim que o script
 * PARA de reavaliar aquele ID específico — não porque alguém consertou nada.
 * Sem tratamento, isso aciona o MESMO streak de ausência que fecha achados
 * `"estado"` de verdade resolvidos, fechando a issue sozinha com o problema
 * intocado (#5525). `planAlarmReconciliation` trata uma entry `"evento"`
 * exatamente como uma allowlisted: congelada, sem `comment_resolved`/
 * `advance_streak`/`close` — só um humano fecha. Isso também resolve de
 * graça a preocupação de "reabrir depois de fechado": como a entry nunca
 * ganha `closedAt` setado por este módulo (só um `gh issue close` manual do
 * lado de fora), e `ensureAlarmIssue` sempre confere o cache/marcador ANTES
 * de criar, o pior caso de um achado de evento reaparecer em `pending` é
 * `action: "reused"` apontando pra uma issue que já pode estar fechada — o
 * mesmo comportamento (documentado acima) que já existe pro caso "issue
 * fechada manualmente + fingerprint ainda casa" da allowlist, nunca uma
 * issue nova duplicada. `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`)
 * usa a label companheira `ALARM_EVENT_LABEL` pra rotear esses achados pro
 * `overnight` (revisão humana) em vez de `fora-de-rodada`.
 */
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";

/** Label que este módulo aplica a toda issue de alarme (#5338: precisa
 * existir no repo — nunca existiu antes desta unidade, então `gh issue
 * create` falhava em TODA execução com "'alarm' not found" e zero achado
 * virava issue desde o #5112). Usada tanto pelo self-heal em
 * `ensureLabelExists` (chamado ao detectar o erro "not found" pra essa
 * label especificamente) quanto pelo setup manual documentado. */
export const ALARM_LABEL = "alarm";
const ALARM_LABEL_COLOR = "5319e7";
const ALARM_LABEL_DESCRIPTION = "Achado de alarme agendado criou/reusa esta issue automaticamente (#5112)";

/**
 * #5553 — label aplicada SÓ a achados de família `"evento"` (ver `AlarmFamily`
 * abaixo), além de `ALARM_LABEL`. Existe pra `classifyExecTrack`
 * (`scripts/lib/issue-exec-track.ts`) distinguir os dois: `alarm` sozinho
 * classifica `fora-de-rodada` (o achado se auto-resolve); `alarm` +
 * `alarm-evento` classifica `overnight` (precisa de revisão humana — o achado
 * NUNCA se auto-resolve, só sai da janela de observação do alarme com o
 * tempo). Nunca aplicada sozinha — sempre junto de `ALARM_LABEL`, pra
 * convivência com `gh issue list --label alarm`/dashboards existentes que já
 * filtram por ela.
 */
export const ALARM_EVENT_LABEL = "alarm-evento";
const ALARM_EVENT_LABEL_COLOR = "b60205";
const ALARM_EVENT_LABEL_DESCRIPTION =
  // GitHub label description tem teto de 100 chars — validado ao vivo
  // (#5553): a 1ª tentativa (104 chars) deu HTTP 422 "description is too
  // long" tanto no self-heal quanto na criação manual do label real.
  "Alarme de EVENTO PASSADO (#5553) — não se auto-resolve, precisa de revisão humana";

/** Metadados de toda label que este módulo sabe AUTO-CRIAR via self-heal
 * (#5338, generalizado no #5553) — usado tanto por `ensureLabelExists` quanto
 * pelo setup manual documentado. Adicionar uma label nova ao mecanismo de
 * self-heal é só adicionar uma entry aqui. */
const SELF_HEALABLE_LABELS: Record<string, { color: string; description: string }> = {
  [ALARM_LABEL]: { color: ALARM_LABEL_COLOR, description: ALARM_LABEL_DESCRIPTION },
  [ALARM_EVENT_LABEL]: { color: ALARM_EVENT_LABEL_COLOR, description: ALARM_EVENT_LABEL_DESCRIPTION },
};

export type AlarmPriority = "P0" | "P1" | "P2" | "P3";

/**
 * Família do achado (#5553) — decide se o alarme SE AUTO-RESOLVE ou não.
 *
 *   - `"estado"`: condição RE-CHECÁVEL a cada execução (arquivo existe?
 *     drift sumiu? painel voltou a registrar?) — quando a condição observada
 *     muda pra "ok", o achado simplesmente para de aparecer em `pending` e o
 *     mecanismo de streak comenta/fecha a issue sozinho. Comportamento
 *     pré-#5553, inalterado.
 *   - `"evento"`: achado ancorado a um ID IMUTÁVEL (campanha, envio, post)
 *     que descreve um FATO já ocorrido — nunca "para de reproduzir" por
 *     alguém ter consertado algo; a checagem seguinte simplesmente para de
 *     reavaliar aquele ID específico (ex: `markEvaluated` em
 *     `clarice-guardrail-alarm.ts`) e o achado desaparece de `pending` sem
 *     que nada tenha sido resolvido. Sem tratamento especial, isso dispara o
 *     MESMO mecanismo de streak e fecha a issue sozinha com o achado real
 *     intocado (#5525) — daí `planAlarmReconciliation` abaixo nunca gerar
 *     `comment_resolved`/`advance_streak`/`close` pra uma entry `"evento"`.
 *
 * Explícito e OBRIGATÓRIO por decisão do #5553, não derivado do
 * `fingerprint`: a correlação "fingerprint embute um ID imutável → evento"
 * NÃO se sustenta em todos os alarmes já existentes —
 * `linkedin-weekly-staleness-alarm.ts` embute o CICLO (`26w33`, um ID) no
 * fingerprint e ainda assim é `"estado"` (a condição observada é "o artefato
 * existe pra ESTE ciclo?", re-checada toda semana; #5497 é o caso confirmado
 * de auto-close correto). Só quem EMITE o achado sabe se a condição pode
 * voltar a ficar "ok", então a declaração é do script chamador — errar aqui
 * devolve o problema original em silêncio (issue nasce invisível pro
 * classificador E se auto-fecha sozinha).
 */
export type AlarmFamily = "estado" | "evento";

export interface AlarmFinding {
  /** Eixo/categoria do achado (ex: "english-labels", "port-in-url") — o
   * mesmo `check` de uma execução pode ter no máximo 1 finding pendente por
   * fingerprint distinto. */
  check: string;
  /** Identificador estável do achado especifico (independente de quando
   * ele foi detectado) — normalmente `${check}:${detalhe}`. Usado tanto pro
   * marcador quanto pra chave do estado local. */
  fingerprint: string;
  /** Título da issue, usado só quando `action: "created"`. */
  title: string;
  /** Corpo markdown da issue (o marcador de dedup é ANEXADO automaticamente
   * por `ensureAlarmIssue` — não incluir aqui). */
  body: string;
  /** #5553 — `"estado"` (auto-resolve) ou `"evento"` (fato histórico, nunca
   * auto-resolve) — ver `AlarmFamily` acima. Obrigatório: toda issue de
   * alarme precisa desta declaração explícita do script emissor. */
  family: AlarmFamily;
  /** Labels extras além de "alarm" (+ "alarm-evento" se `family === "evento"`)
   * e a prioridade resolvida — tipicamente o tipo (`bug`/`enhancement`). */
  labels?: string[];
  /** Default `"P2"` (CLAUDE.md: toda issue nasce com label de prioridade). */
  priority?: AlarmPriority;
  /** #6572 — chave de agrupamento OPCIONAL pro modo de estreia (ver
   * `aggregateFindingsOnDebut` abaixo). Findings sem `group` nunca são
   * candidatos a agregação, independente do volume — comportamento
   * pré-#6572, inalterado. Generaliza o cap de estreia introduzido no #6564
   * só pra `session-registry-safebackup` (#6562): qualquer check pode optar
   * declarando `group` (tipicamente igual a `check`, mas não precisa ser —
   * fica a critério do emissor). */
  group?: string;
}

export interface AlarmIssueResult {
  issueNumber: number | null;
  url: string | null;
  /** `"reopened"` (#5978): a issue localizada (via cache OU marcador) estava
   * `CLOSED` no GitHub — reaberta + comentada em vez de tratada como reuse
   * silencioso (ver docstring de `ensureAlarmIssue`). */
  action: "created" | "reused" | "reopened" | "failed";
  error?: string;
}

// ─── Allowlist de achados aceitos como limitação permanente (#5364) ────────
// Ver docstring do módulo, seção "Allowlist de achados aceitos" — mecanismo
// genérico, entries declaradas por script chamador.

export interface AlarmAllowlistEntry {
  /** Eixo/categoria do achado — mesmo valor de `AlarmFinding.check`. */
  check: string;
  /** Fingerprint EXATO aceito — mesmo valor de `AlarmFinding.fingerprint`.
   * Match nunca é prefixo/regex (fail-safe: ver docstring do módulo). */
  fingerprint: string;
  /** Motivo da aceitação (texto livre, obrigatório) — por que este achado é
   * uma limitação permanente/sem-fix, não um bug a corrigir. */
  reason: string;
  /** Data (ISO `YYYY-MM-DD`) em que a decisão de aceitar foi tomada. */
  accepted_at: string;
  /** Issue de referência onde a investigação/decisão está documentada
   * (ex: `"#5364"`). */
  ref_issue: string;
}

export type AlarmAllowlist = readonly AlarmAllowlistEntry[];

/** Pura — `true` se `check`+`fingerprint` casa EXATAMENTE (nunca por
 * prefixo/regex) com alguma entry da allowlist. */
export function isAllowlisted(check: string, fingerprint: string, allowlist: AlarmAllowlist): boolean {
  return allowlist.some((e) => e.check === check && e.fingerprint === fingerprint);
}

// ─── Agrupamento genérico de achados na ESTREIA (#6572) ────────────────────
// Generaliza o cap de estreia introduzido no #6564 exclusivamente pra
// `session-registry-safebackup` (#6562) — qualquer check opta declarando
// `AlarmFinding.group`. Ver docstring de `AlarmFinding.group` acima.

/**
 * Opções de `aggregateFindingsOnDebut` — o script chamador injeta
 * `stateIsEmpty` (o MESMO sinal usado pelo `session-registry-safebackup`
 * original: `Object.keys(alarmIssuesState).length === 0`, ou seja "esta é a
 * 1ª execução deste alarme nesta máquina/checkout") e `threshold` (teto por
 * GRUPO acima do qual agrega). `buildAggregate` é injetado pelo chamador
 * porque o título/corpo agregado é sempre texto de domínio específico do
 * check — não dá pra generalizar sem perder a qualidade da mensagem (mesmo
 * trade-off já aceito por `buildAggregatedSafeBackupFinding`).
 */
export interface AggregateOnDebutOptions {
  /** Teto (exclusivo) por grupo — acima disto, agrega quando `stateIsEmpty`.
   * Um grupo com `threshold` ou menos findings NUNCA agrega, mesmo em
   * estreia — 1 issue por finding continua o padrão pra volume baixo. */
  threshold: number;
  /** `true` só na 1ª execução (estado local de dedup vazio) — mesmo
   * gatilho do #6562/#6564: a partir da 2ª execução (já existe pelo menos
   * 1 entry no estado), a agregação nunca dispara de novo, mesmo que o
   * volume continue acima do teto (o modo granular 1-por-finding volta a
   * valer, e a issue agregada se auto-fecha por não reaparecer mais). */
  stateIsEmpty: boolean;
  /** Constrói o `AlarmFinding` agregado a partir do nome do grupo e da
   * lista de findings originais que caíram nele (já ordenados por
   * fingerprint) — cada check decide seu próprio título/corpo/fingerprint
   * agregado. O `check` retornado deve corresponder ao(s) `check` dos
   * findings originais pra `alarm-issues.ts` conseguir rastrear/fechar a
   * MESMA issue entre execuções (mesmo padrão de
   * `buildAggregatedSafeBackupFinding`). */
  buildAggregate: (group: string, findings: readonly AlarmFinding[]) => AlarmFinding;
}

/**
 * Pura — agrupa `findings` por `AlarmFinding.group` e substitui cada grupo
 * cujo tamanho excede `opts.threshold` por 1 único achado agregado (via
 * `opts.buildAggregate`), quando `opts.stateIsEmpty`. Findings sem `group`
 * (`undefined`) NUNCA são candidatos a agregação — passam direto,
 * preservando o comportamento 1-por-finding de todo check que ainda não
 * declarou `group` (retrocompatível por padrão: nenhum check existente
 * muda de comportamento sem opt-in explícito). Fora de `stateIsEmpty`
 * (regime estacionário) ou com o grupo dentro do teto, também passa direto.
 *
 * Ordem do output não é preservada entre grupos diferentes — o chamador
 * (`planAlarmReconciliation`) trata `pending` como um conjunto, não uma
 * lista ordenada relevante.
 */
export function aggregateFindingsOnDebut(
  findings: readonly AlarmFinding[],
  opts: AggregateOnDebutOptions,
): AlarmFinding[] {
  const ungrouped = findings.filter((f) => !f.group);
  if (!opts.stateIsEmpty) return findings.slice();

  const byGroup = new Map<string, AlarmFinding[]>();
  for (const f of findings) {
    if (!f.group) continue;
    const list = byGroup.get(f.group) ?? [];
    list.push(f);
    byGroup.set(f.group, list);
  }

  const out: AlarmFinding[] = [...ungrouped];
  for (const [group, groupFindings] of byGroup) {
    if (groupFindings.length > opts.threshold) {
      const sorted = [...groupFindings].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      out.push(opts.buildAggregate(group, sorted));
    } else {
      out.push(...groupFindings);
    }
  }
  return out;
}

// ─── Marcador de dedup (puro) ───────────────────────────────────────────────

/** Pura — marcador de dedup embutido no corpo da issue (#5112 item 2). */
export function alarmFindingMarker(check: string, fingerprint: string): string {
  return `<!-- alarm-finding: ${check}:${fingerprint} -->`;
}

// ─── Estado local (cache, NÃO autoritativo — #5112 item 2) ─────────────────

export interface AlarmIssueStateEntry {
  issueNumber: number;
  url: string;
  /** Execuções CONSECUTIVAS em que o achado esteve ausente do conjunto
   * pendente — reseta pra 0 sempre que o achado reaparece. */
  missingStreak: number;
  /** `null` enquanto a issue segue tratada como aberta pelo tracking local;
   * ISO timestamp de quando `closeAlarmIssue` teve sucesso. **`null` não é
   * garantia de estado real "aberta"** — uma issue fechada por fora deste
   * módulo (auto-close alheio, fechamento manual) mantém `closedAt: null`
   * aqui pra sempre; desde o #5989, `ensureAlarmIssue` confirma via
   * `fetchAlarmIssueState` antes de confiar nesse `null` pra achados de
   * família `"estado"` (ver docstring de `fetchAlarmIssueState`). */
  closedAt: string | null;
  /** #5553 — família do achado no momento do último `ensure` (ver
   * `AlarmFamily`). `undefined` em entries persistidas ANTES do #5553 —
   * tratado como `"estado"` em `planAlarmReconciliation` (comportamento
   * pré-existente preservado pro `state.json` já em disco; só entries criadas
   * a partir desta mudança carregam o valor de verdade). */
  family?: AlarmFamily;
}

/** Chave do mapa de estado — `check:fingerprint` (fingerprint já inclui o
 * check normalmente, mas a chave explícita evita colisão entre eixos
 * diferentes que por acaso gerem o mesmo fingerprint). */
export type AlarmIssuesState = Record<string, AlarmIssueStateEntry>;

export function emptyAlarmIssuesState(): AlarmIssuesState {
  return {};
}

export function alarmIssueStateKey(check: string, fingerprint: string): string {
  return `${check}:${fingerprint}`;
}

// ─── `gh` CLI (I/O, injetável — reusa scripts/lib/shared/gh-run.ts) ─────

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

/** Produção: `gh` de verdade, com o mesmo teto de tempo de
 * `scripts/lib/shared/gh-run.ts` (nunca trava o event loop indefinidamente
 * se `gh auth` expirou ou a API do GitHub degradou). */
export function defaultAlarmGhRun(args: string[], cwd: string): GhSpawnResult {
  return spawnGhSync(args, cwd);
}

/**
 * Busca (fallback do cache local, #5112 item 2) uma issue — aberta OU
 * fechada, `--state all` — que já carregue o marcador exato deste
 * check+fingerprint. A query de busca do GitHub é best-effort (full-text
 * search pode não indexar bem pontuação de comentário HTML) — o filtro
 * EXATO acontece client-side via `body.includes(marker)`, então um miss no
 * server-side search no pior caso custa uma issue nova (não uma adoção
 * errada). `run.status !== 0` (gh indisponível/erro) vira "não encontrado"
 * — o caller decide se cria (fail-soft já cobre falha de criação
 * separadamente).
 */
export function findExistingAlarmIssue(
  check: string,
  fingerprint: string,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): { issueNumber: number; url: string; state: "OPEN" | "CLOSED" } | null {
  const marker = alarmFindingMarker(check, fingerprint);
  const res = run(
    [
      "issue",
      "list",
      "--search",
      `${check} ${fingerprint}`,
      "--state",
      "all",
      "--json",
      "number,url,body,state",
      "--limit",
      "30",
    ],
    cwd,
  );
  if (res.status !== 0) return null;
  let issues: { number: number; url: string; body: string; state?: string }[];
  try {
    issues = JSON.parse(res.stdout) as { number: number; url: string; body: string; state?: string }[];
  } catch {
    return null;
  }
  const match = issues.find((i) => (i.body ?? "").includes(marker));
  if (!match) return null;
  // `state` ausente (mock antigo/gh degradado) trata como OPEN — nunca
  // fabrica um "CLOSED" que dispararia reopen sem necessidade.
  const state: "OPEN" | "CLOSED" = match.state === "CLOSED" ? "CLOSED" : "OPEN";
  return { issueNumber: match.number, url: match.url, state };
}

/** Erro de `gh issue create`/`gh label create` quando uma label passada em
 * `--label` não existe no repo — formato observado ao vivo (#5338):
 * `could not add label: 'alarm' not found`. Captura o nome entre aspas
 * simples; `g` pra achar todas as ocorrências se `gh` reportar mais de uma
 * label ausente na mesma mensagem. */
const LABEL_NOT_FOUND_PATTERN = /could not add label: '([^']+)' not found/gi;

/** Nomes de label extraídos de uma mensagem de erro "not found" do `gh` —
 * lista vazia se o erro não é dessa classe (caller distingue "falha por
 * label ausente, retentável" de qualquer outra falha, que não deve mascarar
 * o motivo real). */
function extractMissingLabels(stderr: string): string[] {
  const names: string[] = [];
  const re = new RegExp(LABEL_NOT_FOUND_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) names.push(match[1]);
  return names;
}

/** Self-heal (#5338 item 1, generalizado no #5553) — best-effort, nunca
 * lança: tenta criar `labelName` no repo (`--force` o torna idempotente caso
 * já exista com cor/descrição diferentes de uma criação manual). `false` sem
 * tocar `gh` se `labelName` não é uma das `SELF_HEALABLE_LABELS` conhecidas —
 * só `alarm`/`alarm-evento` são auto-criáveis por este módulo. Chamada só no
 * caminho de retry (vale a pena tentar 1x quando `gh issue create` já falhou
 * por essa label especificamente) — não em toda execução, pra não gastar uma
 * chamada `gh` extra quando a label já existe (caso comum após a 1ª
 * auto-criação). */
function ensureLabelExists(labelName: string, cwd: string, run: GhRunFn): boolean {
  const meta = SELF_HEALABLE_LABELS[labelName];
  if (!meta) return false;
  const res = run(["label", "create", labelName, "--color", meta.color, "--description", meta.description, "--force"], cwd);
  return res.status === 0;
}

function parseIssueCreateUrl(res: GhSpawnResult): { issueNumber: number; url: string } | { error: string } {
  const url = res.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const numMatch = url.match(/\/issues\/(\d+)\s*$/);
  if (!numMatch) {
    return {
      error: `não foi possível extrair o número da issue da URL retornada por 'gh issue create': "${url}"`,
    };
  }
  return { issueNumber: Number(numMatch[1]), url };
}

/**
 * Cria a issue via `gh issue create` — com retry não-fatal (#5338 item 2)
 * quando a falha é EXATAMENTE "label não encontrada": tenta self-heal de
 * toda label ausente que este módulo sabe auto-criar (`ensureLabelExists`,
 * generalizado no #5553 — hoje `alarm`/`alarm-evento`) e retenta mantendo
 * cada uma que curou com sucesso, ou sem ela (e sem qualquer outra label que o
 * `gh` também tenha acusado como ausente) caso contrário. Perder um rótulo é
 * aceitável; perder o rastreio do achado inteiro não é — nunca deixa uma
 * falha de label genuína, sem retry, virar o único motivo de a issue nunca
 * existir. Qualquer outra classe de falha (rate limit, offline, `gh` não
 * autenticado) passa direto pro fail-soft de sempre, sem retry.
 */
function createAlarmIssueWithLabelRetry(
  title: string,
  body: string,
  labels: string[],
  cwd: string,
  run: GhRunFn,
): AlarmIssueResult {
  const attempt = (attemptLabels: string[]) =>
    run(
      attemptLabels.length > 0
        ? ["issue", "create", "--title", title, "--body", body, "--label", attemptLabels.join(",")]
        : ["issue", "create", "--title", title, "--body", body],
      cwd,
    );

  const res = attempt(labels);
  if (res.status === 0) {
    const parsed = parseIssueCreateUrl(res);
    if ("error" in parsed) return { issueNumber: null, url: null, action: "failed", error: parsed.error };
    return { issueNumber: parsed.issueNumber, url: parsed.url, action: "created" };
  }

  const missing = extractMissingLabels(res.stderr);
  if (missing.length === 0) {
    // Falha que não é (só) de label ausente — nunca mascarar com retry.
    return {
      issueNumber: null,
      url: null,
      action: "failed",
      error: res.stderr.trim() || `gh issue create falhou (status ${res.status})`,
    };
  }

  const healed = missing.filter((l) => ensureLabelExists(l, cwd, run));
  const stillMissing = missing.filter((l) => !healed.includes(l));
  const retryLabels = labels.filter((l) => !stillMissing.includes(l));

  const retryRes = attempt(retryLabels);
  if (retryRes.status !== 0) {
    return {
      issueNumber: null,
      url: null,
      action: "failed",
      error: `label(s) ausente(s) no repo (${missing.join(", ")}) — retry sem ela(s) também falhou: ${retryRes.stderr.trim() || `status ${retryRes.status}`}`,
    };
  }
  const parsed = parseIssueCreateUrl(retryRes);
  if ("error" in parsed) return { issueNumber: null, url: null, action: "failed", error: parsed.error };
  return { issueNumber: parsed.issueNumber, url: parsed.url, action: "created" };
}

/**
 * #5989 — consulta o estado REAL de uma issue via `gh issue view --json
 * state`, usada pelo caminho de CACHE-HIT de `ensureAlarmIssue` (ver
 * docstring lá) pra achados de família `"estado"`: `cachedEntry.closedAt`
 * só é setado por `closeAlarmIssue` (auto-close DESTE módulo) — uma issue
 * fechada por fora dele (ex: PR merge com `Closes #N`) nunca passa por lá,
 * então o cache nunca aprende que ela fechou e `closedAt` fica `null` pra
 * sempre, mesmo com a issue já `CLOSED` no GitHub. Devolve `"OPEN"` |
 * `"CLOSED"` | `null` — `null` sempre que `gh` falhar (offline, rate limit,
 * JSON malformado, campo ausente): fail-soft, "não sei", NUNCA "assumo
 * fechado" sem confirmação positiva.
 */
export function fetchAlarmIssueState(
  issueNumber: number,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): "OPEN" | "CLOSED" | null {
  const res = run(["issue", "view", String(issueNumber), "--json", "state"], cwd);
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { state?: string };
    if (parsed.state === "OPEN" || parsed.state === "CLOSED") return parsed.state;
    return null;
  } catch {
    return null;
  }
}

/**
 * Reabre (#5978) uma issue de achado localizada `CLOSED` — via `gh issue
 * reopen --comment`, nunca silenciosamente tratada como "reused". Fail-soft
 * na mesma linha do resto do módulo: se `gh issue reopen` falhar, devolve
 * `action: "failed"` (NUNCA fabrica `issueNumber`/`url` de sucesso) pra que
 * `applyAlarmReconciliation` não avance o estado local como se a issue
 * estivesse reaberta quando na verdade continua fechada no GitHub — a
 * próxima execução tenta de novo.
 */
function reopenAlarmIssue(
  issueNumber: number,
  url: string,
  finding: AlarmFinding,
  cwd: string,
  run: GhRunFn,
): AlarmIssueResult {
  const comment =
    `Achado voltou a reproduzir (fingerprint \`${finding.fingerprint}\`) — ` +
    "reabrindo automaticamente em vez de tratar como registrado (#5978).";
  const res = run(["issue", "reopen", String(issueNumber), "--comment", comment], cwd);
  if (res.status !== 0) {
    return {
      issueNumber: null,
      url: null,
      action: "failed",
      error: `gh issue reopen falhou pra #${issueNumber}: ${res.stderr.trim() || `status ${res.status}`}`,
    };
  }
  return { issueNumber, url, action: "reopened" };
}

/**
 * Garante que existe uma issue pro achado `finding` — reusa via `cachedEntry`
 * (fast path pra família `"evento"`, sem tocar rede; família `"estado"`
 * confirma o estado real via `fetchAlarmIssueState` antes de reusar, ver
 * #5989 abaixo) OU via busca por marcador (`findExistingAlarmIssue`,
 * fallback quando o cache não tem a entry) OU cria uma nova (com retry
 * fail-soft de label ausente — ver `createAlarmIssueWithLabelRetry`).
 * **NUNCA** fabrica `issueNumber`/`url` — se toda tentativa de `gh issue
 * create` falhar, devolve `action: "failed"` com `error` populado.
 *
 * **#5978 — issue localizada `CLOSED` nunca é "reused" silenciosamente.**
 * Achado #5978: `ensureAlarmIssue` tratava uma issue fechada (por auto-close
 * do próprio mecanismo, OU fechada manualmente e o achado voltou a
 * reproduzir) exatamente como uma aberta — o achado ficava "registrado" num
 * lugar que ninguém olha. Duas fontes de "está fechada" são checadas: (1)
 * `cachedEntry.closedAt` (o tracking local já sabe, porque foi este módulo
 * quem fechou via `closeAlarmIssue`), (2) `findExistingAlarmIssue(...).state`
 * (fallback por marcador — cobre fechamento manual/fora do tracking local).
 * Qualquer uma das duas dispara `reopenAlarmIssue` em vez do caminho de
 * reuse — a issue é reaberta + comentada, preservando o histórico do achado
 * (razão de existir do marcador), nunca uma issue nova duplicada.
 *
 * **#5989 — cache-hit com `closedAt: null` NÃO é garantia de "aberta".**
 * O #5978/#5982 cobriu as duas fontes acima, mas `cachedEntry.closedAt` só é
 * setado por `closeAlarmIssue` (auto-close DESTE módulo) — uma issue fechada
 * por fora dele (PR merge com `Closes #N`, fechamento manual sem o achado
 * ter reproduzido de novo antes) nunca passa por lá, então o cache nunca
 * aprende que ela fechou e `closedAt` fica `null` pra sempre mesmo com a
 * issue já `CLOSED` no GitHub — reproduzindo o bug original do #5978 pelo
 * caminho de cache-hit. O fix é escopado ao sub-caso `closedAt: null`: pra
 * achados de família `"estado"` (única família que se auto-fecha —
 * `"evento"` nunca fecha sozinha, sempre um humano, ver `AlarmFamily`) COM
 * `cachedEntry.closedAt` falsy, o cache-hit agora confirma o estado real via
 * `fetchAlarmIssueState` antes de decidir `"reused"` vs `"reopened"`. O
 * sub-caso `closedAt` truthy (setado pelo #5978/#5982) continua reabrindo
 * direto, sem essa confirmação — `cachedEntry.closedAt` deixa de ser,
 * sozinho, a fonte de verdade só no `null`; onde já está setado, segue
 * sendo (assimetria aceita: um `closedAt` truthy só existe se este módulo o
 * escreveu, então já é confiável por construção). Custo aceito: 1 chamada
 * `gh` extra por achado pendente com cache-hit `closedAt: null` de família
 * `"estado"` — preço de fechar o silêncio real que já causou 2 dias de
 * rampa Clarice parada (#5989). Família `"evento"` segue sem checagem
 * nenhuma no cache-hit (comportamento intocado, nunca reabre sozinha).
 */
export function ensureAlarmIssue(
  finding: AlarmFinding,
  cachedEntry: { issueNumber: number; url: string; closedAt?: string | null } | undefined,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): AlarmIssueResult {
  if (cachedEntry) {
    if (cachedEntry.closedAt) {
      return reopenAlarmIssue(cachedEntry.issueNumber, cachedEntry.url, finding, cwd, run);
    }
    if (finding.family === "estado") {
      const realState = fetchAlarmIssueState(cachedEntry.issueNumber, cwd, run);
      if (realState === "CLOSED") {
        return reopenAlarmIssue(cachedEntry.issueNumber, cachedEntry.url, finding, cwd, run);
      }
      // realState === "OPEN", ou null (gh falhou/indisponível) -> fail-soft,
      // nunca reabre às cegas sem confirmação POSITIVA de CLOSED.
    }
    return { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url, action: "reused" };
  }

  const existing = findExistingAlarmIssue(finding.check, finding.fingerprint, cwd, run);
  if (existing) {
    if (existing.state === "CLOSED") {
      return reopenAlarmIssue(existing.issueNumber, existing.url, finding, cwd, run);
    }
    return { issueNumber: existing.issueNumber, url: existing.url, action: "reused" };
  }

  const priority = finding.priority ?? "P2";
  // #5553 — `ALARM_EVENT_LABEL` ANEXADA (nunca substitui `ALARM_LABEL`): a
  // issue de evento continua achável por `gh issue list --label alarm`, e
  // `classifyExecTrack` checa `alarm-evento` ANTES de tratar `alarm` como
  // "se auto-resolve" (ver docstring de `RESOLVED_BY_PROSE_LABELS` lá).
  const familyLabels = finding.family === "evento" ? [ALARM_EVENT_LABEL] : [];
  const labels = [...new Set([...(finding.labels ?? []), ALARM_LABEL, ...familyLabels, priority])];
  const marker = alarmFindingMarker(finding.check, finding.fingerprint);
  const body = `${finding.body}\n\n${marker}\n`;

  return createAlarmIssueWithLabelRetry(finding.title, body, labels, cwd, run);
}

/** Comenta "não reproduz mais" numa issue — `true` em sucesso, `false` se
 * `gh` falhar (caller não avança o streak nesse caso, fail-soft). */
export function commentAlarmIssueResolved(
  issueNumber: number,
  resolvedAt: Date,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): boolean {
  const body = `Não reproduz mais desde ${resolvedAt.toISOString()}.`;
  const res = run(["issue", "comment", String(issueNumber), "--body", body], cwd);
  return res.status === 0;
}

/** Fecha a issue com um comentário explicando o motivo automático — `true`
 * em sucesso, `false` se `gh` falhar. */
export function closeAlarmIssue(
  issueNumber: number,
  closeAfterRuns: number,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): boolean {
  const comment = `Fechada automaticamente: achado não reproduz há ${closeAfterRuns} execuções consecutivas.`;
  const res = run(["issue", "close", String(issueNumber), "--comment", comment], cwd);
  return res.status === 0;
}

// ─── Reconciliação (plan = puro, apply = I/O) ───────────────────────────────

export type AlarmReconcileAction =
  | { kind: "ensure"; finding: AlarmFinding }
  | { kind: "comment_resolved"; key: string; issueNumber: number }
  | { kind: "advance_streak"; key: string }
  | { kind: "close"; key: string; issueNumber: number };

/**
 * Pura — decide as ações necessárias pra reconciliar `pending` (achados
 * DESTA execução) contra `state` (achados rastreados de execuções
 * anteriores):
 *
 *   - todo achado em `pending` ganha uma ação `ensure` (cria ou reusa).
 *   - todo achado em `state` que NÃO está em `pending` e ainda não foi
 *     fechado (`closedAt === null`) teve o streak de ausência incrementado
 *     hipoteticamente: na 1ª ausência (streak chega a 1) vira
 *     `comment_resolved`; ao atingir `closeAfterRuns` vira `close`; entre os
 *     dois (streak > 1 e < closeAfterRuns) vira `advance_streak` — sem I/O,
 *     só avança o contador em `state`, senão `missingStreak` nunca passaria
 *     de 1 e `closeAfterRuns > 2` nunca fecharia nada (#5172: `apply` só
 *     escrevia `missingStreak` dentro dos ramos `comment_resolved`/`close`,
 *     então o meio da faixa ficava sem NENHUMA ação e o streak persistido
 *     travava pra sempre em 1, fazendo `nextStreak` recalcular 2 do zero a
 *     cada execução seguinte).
 *
 * `allowlist` (#5364, default `[]`) remove TODA ação sobre um fingerprint
 * aceito como limitação permanente — nem `ensure` do lado `pending` (nunca
 * cria/reabre issue pra ele), nem `comment_resolved`/`advance_streak`/
 * `close` do lado `state` (uma entry já existente pra esse fingerprint fica
 * congelada, tratada como fora do escopo de reconciliação a partir daqui).
 *
 * **#5553 — achado de família `"evento"` nunca entra no ramo `state` acima.**
 * Pra um achado `"estado"`, sumir de `pending` significa "a condição voltou
 * a ficar ok" — o streak de ausência é o sinal CORRETO de resolução. Pra
 * `"evento"`, sumir de `pending` só significa "o script parou de reavaliar
 * este ID específico" (ex: `markEvaluated` em `clarice-guardrail-alarm.ts`
 * nunca reavalia a MESMA campanha) — não que alguém tenha corrigido nada.
 * Sem esta exceção, o mesmo mecanismo de streak comenta "não reproduz mais"
 * e fecha a issue automaticamente com o achado real intocado (#5525: o
 * guardrail furado da campanha 146 nunca teve fix nem investigação — só
 * "parou de aparecer" porque a campanha já foi avaliada). Uma entry
 * `"evento"` fica CONGELADA (mesmo tratamento da allowlist acima) até um
 * humano fechar a issue manualmente — nunca por streak.
 */
export function planAlarmReconciliation(
  pending: readonly AlarmFinding[],
  state: AlarmIssuesState,
  closeAfterRuns: number,
  allowlist: AlarmAllowlist = [],
): AlarmReconcileAction[] {
  const actions: AlarmReconcileAction[] = [];
  const activePending = pending.filter((f) => !isAllowlisted(f.check, f.fingerprint, allowlist));
  const pendingKeys = new Set(activePending.map((f) => alarmIssueStateKey(f.check, f.fingerprint)));
  const allowlistedKeys = new Set(allowlist.map((e) => alarmIssueStateKey(e.check, e.fingerprint)));

  for (const finding of activePending) {
    actions.push({ kind: "ensure", finding });
  }

  for (const [key, entry] of Object.entries(state)) {
    if (allowlistedKeys.has(key)) continue;
    if (pendingKeys.has(key)) continue;
    if (entry.closedAt) continue;
    // #5553 — entries sem `family` persistida (state.json pré-#5553) tratam
    // como "estado", preservando o comportamento de auto-close de antes.
    if ((entry.family ?? "estado") === "evento") continue;
    const nextStreak = entry.missingStreak + 1;
    if (nextStreak >= closeAfterRuns) {
      actions.push({ kind: "close", key, issueNumber: entry.issueNumber });
    } else if (nextStreak === 1) {
      actions.push({ kind: "comment_resolved", key, issueNumber: entry.issueNumber });
    } else {
      actions.push({ kind: "advance_streak", key });
    }
  }

  return actions;
}

export interface AlarmFindingOutcome extends AlarmIssueResult {
  check: string;
  fingerprint: string;
}

export interface ApplyAlarmReconciliationOptions {
  cwd: string;
  closeAfterRuns: number;
  run?: GhRunFn;
  now?: Date;
  /** #5364 — achados aceitos como limitação permanente; default `[]`
   * (comportamento inalterado quando o caller não passa nada). */
  allowlist?: AlarmAllowlist;
}

export interface ApplyAlarmReconciliationResult {
  nextState: AlarmIssuesState;
  /** Um outcome por achado PENDENTE desta execução (pra o e-mail citar a
   * issue) — resolved/closed não entram aqui (não são achados pendentes). */
  findingOutcomes: AlarmFindingOutcome[];
}

/**
 * Aplica `planAlarmReconciliation` — faz o I/O (via `run`) e devolve o
 * próximo estado + outcome por achado pendente. Fail-soft (#5112 item 6):
 * uma falha de `ensure` deixa a entry de estado daquele achado como estava
 * (sem entry nenhuma se nunca existiu) — nunca avança como se tivesse sido
 * tratado. Falha de `comment`/`close` também não avança o streak daquele
 * achado (retry na próxima execução).
 */
export function applyAlarmReconciliation(
  pending: readonly AlarmFinding[],
  state: AlarmIssuesState,
  opts: ApplyAlarmReconciliationOptions,
): ApplyAlarmReconciliationResult {
  const run = opts.run ?? defaultAlarmGhRun;
  const now = opts.now ?? new Date();
  const allowlist = opts.allowlist ?? [];
  const nextState: AlarmIssuesState = { ...state };
  const findingOutcomes: AlarmFindingOutcome[] = [];

  const actions = planAlarmReconciliation(pending, state, opts.closeAfterRuns, allowlist);

  for (const action of actions) {
    if (action.kind === "ensure") {
      const key = alarmIssueStateKey(action.finding.check, action.finding.fingerprint);
      const cachedEntry = state[key];
      const result = ensureAlarmIssue(
        action.finding,
        cachedEntry
          ? { issueNumber: cachedEntry.issueNumber, url: cachedEntry.url, closedAt: cachedEntry.closedAt }
          : undefined,
        opts.cwd,
        run,
      );
      findingOutcomes.push({ check: action.finding.check, fingerprint: action.finding.fingerprint, ...result });

      if (result.action === "failed") {
        // Fail-soft: NÃO avança o estado (cursor não marca como tratado).
        continue;
      }
      nextState[key] = {
        issueNumber: result.issueNumber!,
        url: result.url!,
        missingStreak: 0,
        // Reativa o tracking (closedAt: null) mesmo se a entry anterior
        // estava fechada — o achado reapareceu, então voltou a ser
        // pendente do ponto de vista do tracking local. #5978: a issue no
        // GitHub também é reaberta nesse caso (`ensureAlarmIssue` dispara
        // `reopenAlarmIssue` quando `cachedEntry.closedAt` está setado) —
        // aqui só refletimos o resultado; `result.action` já veio
        // "reopened" (ou "failed", que nunca chega aqui, ver acima).
        closedAt: null,
        // #5553 — sempre estampa a família ATUAL do finding, mesmo em
        // reused/cache-hit: se o script chamador algum dia reclassificar o
        // achado, o `state.json` se auto-corrige no próximo `ensure`.
        family: action.finding.family,
      };
    } else if (action.kind === "comment_resolved") {
      const ok = commentAlarmIssueResolved(action.issueNumber, now, opts.cwd, run);
      if (ok) {
        const entry = nextState[action.key]!;
        nextState[action.key] = { ...entry, missingStreak: entry.missingStreak + 1 };
      }
    } else if (action.kind === "advance_streak") {
      // Sem I/O — só avança o contador local (#5172). Nada pra falhar aqui,
      // então sempre aplica (diferente de comment/close, que só avançam o
      // streak se o `gh` correspondente teve sucesso).
      const entry = nextState[action.key]!;
      nextState[action.key] = { ...entry, missingStreak: entry.missingStreak + 1 };
    } else if (action.kind === "close") {
      const ok = closeAlarmIssue(action.issueNumber, opts.closeAfterRuns, opts.cwd, run);
      if (ok) {
        const entry = nextState[action.key]!;
        nextState[action.key] = { ...entry, missingStreak: entry.missingStreak + 1, closedAt: now.toISOString() };
      }
    }
  }

  return { nextState, findingOutcomes };
}
