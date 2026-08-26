/**
 * scripts/lib/backlog-reconcile.ts (#6198)
 *
 * Lógica PURA (sem I/O) da reconciliação diária do backlog aberto — a task
 * que percorre todas as issues abertas e trata os padrões de drift
 * descritos na #6198 (1-4) e #6201 (5), todos detectáveis cruzando labels ×
 * marcador `aguardando-ate:` × estado, sem ler prosa:
 *
 *   1. Marcador `aguardando-ate:` futuro **+** label de deferimento
 *      (`not-this-week`/`next-month`/`on-hold`/`wontfix`) na mesma issue —
 *      fixtures reais #5734, #5239.
 *   2. `on-hold` + marcador com a mesma data — fixtures reais #4469, #4554,
 *      #4556.
 *   3. Label de bloqueio (`BLOCKED_LABELS` de `issue-exec-track.ts`) herdada
 *      de uma issue-mãe (referenciada via "Fatia de #N"/"Desdobrada d[ae]
 *      #N") para a issue-filha — fixture real #6187.
 *   4. Issue classificada `fora-de-rodada` que ainda carrega checkbox
 *      (`- [ ] `) aberto no corpo — fixture real #6047.
 *   5. (#6201 item 7) Label de `INHERITABLE_BLOCK_LABELS` presente em
 *      ALGUMAS filhas de uma mãe e ausente em OUTRAS — fixtures reais
 *      #6184-#6187 (filhas de #463). Complementa o padrão 3: aquele só
 *      enxerga "a filha herdou a label da mãe"; este enxerga a ASSIMETRIA
 *      entre filhas, que é o sintoma "contorno por omissão não deixa
 *      rastro" (a #6184 ficou sem a label por omissão, não por decisão).
 *
 * ─── Separação obrigatória: correção segura × alarme ───────────────────────
 *
 * Padrões 1 e 2 são **contradição pura entre dois sinais** (marcador com
 * data × label de deferimento) — mecanicamente resolvível sem julgamento:
 * o marcador é o sinal mais específico (uma data escrita por alguém vale
 * mais que um deferimento vago), então ele vence e a label conflitante sai.
 * Este módulo trata os dois como UM padrão (`markerDeferralConflict`) — a
 * mecânica de detecção e correção é idêntica; a única diferença entre "#1"
 * e "#2" no texto da issue é se a label conflitante é de `DEFERRED_LABELS`
 * ou `OUT_OF_ROUND_LABELS`, o que não muda a ação certa.
 *
 * **Restrição inegociável:** a correção só age quando o ÚNICO sinal
 * roteável em conflito é uma label de deferimento pura (`not-this-week`,
 * `next-month`, `on-hold`, `wontfix`). Se QUALQUER outra label roteável
 * (`windows`, `trade-off-real`, `external-blocker`, etc. — ver
 * `ROUTABLE_LABELS` de `issue-route.ts`) também estiver presente, a
 * reconciliação **nunca adivinha** qual delas deveria vencer — vira alarme
 * (`markerDeferralAmbiguous`), nunca correção automática. Isso garante que
 * a correção nunca remove um sinal que não seja, comprovadamente, uma
 * contradição pura entre marcador e deferimento — nunca "um sinal isolado
 * que ela ache errado" (a frase literal da restrição da #6198).
 *
 * Padrões 3, 4 e 5 exigem contexto que este módulo não tem acesso mecânico a
 * (o corpo da issue-filha precisa ser lido para saber se o escopo dela de
 * fato depende do bloqueio herdado; um checkbox aberto pode ter sido
 * resolvido em outra issue, só descobrível lendo aquela outra issue; qual
 * lado de uma assimetria entre filhas está certo exige ler o eixo de cada
 * uma) — por isso são **sempre alarme**, nunca correção.
 *
 * ─── Idempotência ────────────────────────────────────────────────────────
 *
 * Toda função aqui é pura e determinística: rodar a mesma detecção duas
 * vezes sobre o MESMO snapshot de input produz o MESMO achado. A
 * idempotência de ponta-a-ponta (rodar a reconciliação contra um backlog já
 * convergido = no-op) depende de quem aplica a correção reler o estado
 * pós-escrita — que é exatamente o que `routeIssue` (`scripts/route-issue.ts`)
 * já faz no passo 4 dele (re-busca + revalida via `classifyExecTrack`).
 * `scripts/backlog-reconcile.ts` (I/O) reusa `routeIssue` para aplicar a
 * correção, nunca `gh issue edit` direto — ver docstring de lá.
 *
 * @see scripts/lib/issue-exec-track.ts (classifyExecTrack, WAIT_UNTIL_RE, parseWaitUntil)
 * @see scripts/lib/issue-route.ts (ROUTABLE_LABELS — fonte única de labels roteáveis)
 * @see scripts/route-issue.ts (routeIssue — único caminho de escrita)
 * @see scripts/backlog-reconcile.ts (CLI — I/O, aplica as correções, monta o relatório)
 */
import { parseWaitUntil } from "./issue-exec-track.ts";
import { ROUTABLE_LABELS } from "./issue-route.ts";

export interface BacklogIssueInput {
  number: number;
  title: string;
  url: string;
  /** `"OPEN"` | `"CLOSED"` — cru de `gh issue view`/`gh issue list`. */
  state: string;
  labels: string[];
  body: string;
}

// ─── Padrões 1+2 — marcador × label de deferimento ─────────────────────────

/** Labels que, coexistindo com um marcador `aguardando-ate:` válido, são
 * uma contradição pura resolvível sem julgamento — o marcador é o sinal
 * mais específico e vence. Subconjunto de `OUT_OF_ROUND_LABELS` (padrão #2:
 * `on-hold`) e `DEFERRED_LABELS` (padrão #1: `not-this-week`, `next-month`)
 * de `issue-exec-track.ts` — não importadas de lá porque não são exportadas
 * individualmente (só a união via `EXEC_TRACK_UI`); os literais são citados
 * na docstring de `classifyExecTrack` como o vocabulário estável desses Sets.
 *
 * **`wontfix` NÃO entra aqui** (self-review do #6198, decidido na revisão da
 * rodada overnight 260826). A simetria com `on-hold` é aparente: as três
 * labels desta lista dizem *"agora não"*, e um marcador de data futura
 * genuinamente as contradiz — a data é a informação mais nova e mais
 * específica. `wontfix` diz *"nunca"*, que é um veredito de outra ordem.
 * Num conflito entre `wontfix` e um marcador, o candidato a obsoleto é o
 * MARCADOR (deferimento antigo que o editor depois decidiu não fazer), não
 * o `wontfix` — então remover a label seria justamente ressuscitar trabalho
 * descartado de propósito, o oposto da restrição inegociável da #6198.
 *
 * `wontfix` continua sendo detectado: cai em `WONTFIX_LABEL` abaixo e vira
 * ALARME, nunca correção. */
export const DEFERRAL_CONFLICT_LABELS: readonly string[] = ["on-hold", "not-this-week", "next-month"];

/** `wontfix` + marcador de data é contradição real, mas NÃO auto-corrigível
 * — ver nota em `DEFERRAL_CONFLICT_LABELS`. Detectado como alarme pra que o
 * conflito não fique invisível. */
export const WONTFIX_LABEL = "wontfix";

export interface MarkerDeferralConflictFix {
  action: "fix";
  patternId: "marker-deferral-conflict";
  issue: number;
  title: string;
  url: string;
  /** Labels de deferimento presentes que serão removidas. */
  conflictingLabels: string[];
  /** `AAAA-MM-DD` do marcador. */
  markerDate: string;
  /** `agendada` quando o marcador ainda não passou (`routeIssue` sincroniza
   * o marcador, remove as labels conflitantes); `overnight` quando o
   * marcador já expirou (o marcador não pode mais produzir `agendada` — só
   * resta limpar as labels conflitantes e devolver a issue ao fluxo
   * normal). */
  routeTrack: "agendada" | "overnight";
}

export interface MarkerDeferralConflictAlarm {
  action: "alarm";
  patternId: "marker-deferral-conflict-ambiguous";
  issue: number;
  title: string;
  url: string;
  conflictingLabels: string[];
  /** Outras labels roteáveis presentes além das de deferimento — motivo de
   * NÃO corrigir automaticamente (poderiam ser o sinal que devia vencer). */
  otherRoutableLabels: string[];
  markerDate: string;
}

/** `wontfix` + marcador `aguardando-ate:` — contradição real, mas NUNCA
 * auto-corrigível. Interface própria (em vez de alargar o `patternId` de
 * `MarkerDeferralConflictAlarm`) pra preservar o narrowing por discriminante
 * nos consumidores: o CLI ramifica em `patternId` e um union de 2 literais
 * num mesmo membro colapsaria os campos específicos de cada alarme.
 * Ver nota em `DEFERRAL_CONFLICT_LABELS`. */
export interface MarkerWontfixConflictAlarm {
  action: "alarm";
  patternId: "marker-wontfix-conflict";
  issue: number;
  title: string;
  url: string;
  /** Sempre `["wontfix"]` — mantido como lista pra uniformidade com os
   * demais alarmes, que reportam conjuntos. */
  conflictingLabels: string[];
  markerDate: string;
}

export type MarkerDeferralFinding =
  | MarkerDeferralConflictFix
  | MarkerDeferralConflictAlarm
  | MarkerWontfixConflictAlarm;

/**
 * Detecta o padrão 1/2 numa issue OPEN. `null` se não há marcador válido, ou
 * não há nenhuma label de `DEFERRAL_CONFLICT_LABELS` presente (nada a
 * reconciliar).
 *
 * Issue CLOSED nunca entra aqui — o caller filtra por `state === "OPEN"`
 * antes (mesmo padrão de `classifyExecTrack`, que também trata CLOSED à
 * parte, com precedência mais alta que qualquer label).
 */
export function detectMarkerDeferralConflict(issue: BacklogIssueInput, now: Date): MarkerDeferralFinding | null {
  if (issue.state === "CLOSED") return null;

  const markerDate = parseWaitUntil(issue.body);
  if (!markerDate) return null;

  const conflictingLabels = issue.labels.filter((l) => DEFERRAL_CONFLICT_LABELS.includes(l));

  // `wontfix` + marcador: contradição real, veredito forte demais pra ser
  // desfeito por heurística. Alarma e sai — nunca chega ao caminho de fix.
  // Ver nota em `DEFERRAL_CONFLICT_LABELS`.
  if (issue.labels.includes(WONTFIX_LABEL)) {
    return {
      action: "alarm",
      patternId: "marker-wontfix-conflict",
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      conflictingLabels: [WONTFIX_LABEL],
      markerDate: markerDate.toISOString().slice(0, 10),
    };
  }

  if (conflictingLabels.length === 0) return null;

  const otherRoutableLabels = issue.labels.filter(
    (l) => ROUTABLE_LABELS.includes(l) && !DEFERRAL_CONFLICT_LABELS.includes(l),
  );
  const markerDateStr = markerDate.toISOString().slice(0, 10);

  if (otherRoutableLabels.length > 0) {
    return {
      action: "alarm",
      patternId: "marker-deferral-conflict-ambiguous",
      issue: issue.number,
      title: issue.title,
      url: issue.url,
      conflictingLabels,
      otherRoutableLabels,
      markerDate: markerDateStr,
    };
  }

  const markerExpired = markerDate.getTime() <= now.getTime();
  return {
    action: "fix",
    patternId: "marker-deferral-conflict",
    issue: issue.number,
    title: issue.title,
    url: issue.url,
    conflictingLabels,
    markerDate: markerDateStr,
    routeTrack: markerExpired ? "overnight" : "agendada",
  };
}

// ─── Padrão 3 — label de bloqueio herdada de mãe pra filha (ALARME) ────────

/** Labels de bloqueio real que fazem sentido "herdar" indevidamente de uma
 * issue-mãe — mesmos literais de `BLOCKED_LABELS` em `issue-exec-track.ts`
 * (não exportado individualmente lá; ver nota em `DEFERRAL_CONFLICT_LABELS`
 * acima sobre por que os literais são citados aqui em vez de importados). */
export const INHERITABLE_BLOCK_LABELS: readonly string[] = [
  "external-blocker",
  "kit-migration",
  "beehiiv",
  "bloqueio-execucao",
];

/** Extrai o número da issue-mãe de uma referência "Fatia de #N" ou
 * "Desdobrada d[ae] #N" no corpo — convenção observada nas issues reais de
 * decomposição deste repo (#6184-#6187 são "Fatia de #463"; #5734 é
 * "Desdobrada da #5500"). `null` se nenhuma referência reconhecida. Só a
 * PRIMEIRA referência conta — uma issue-filha nunca deveria declarar duas
 * mães. */
export function extractParentRef(body: string): number | null {
  const m = /\b(?:Fatia de|Desdobrada d[ae])\s+\**#(\d+)/i.exec(body);
  if (!m) return null;
  return Number(m[1]);
}

export interface ParentIssueRef {
  number: number;
  labels: string[];
}

export interface InheritedBlockLabelAlarm {
  action: "alarm";
  patternId: "inherited-block-label";
  issue: number;
  title: string;
  url: string;
  parentNumber: number;
  /** Label(s) de bloqueio compartilhadas entre mãe e filha. */
  sharedLabels: string[];
}

/**
 * Detecta o padrão 3 numa issue OPEN cujo corpo referencia uma mãe (via
 * `extractParentRef`). `parent` é opcional — quando ausente (a referência
 * não resolveu, ou o caller não buscou a mãe), devolve `null` em vez de
 * alarmar sobre algo que não pôde confirmar.
 *
 * Sempre ALARME, nunca correção — julgar se o escopo da filha de fato não
 * depende do bloqueio herdado exige ler o corpo da filha (achado ao vivo na
 * correção manual da #6187: "o próprio corpo registra 'escolha de
 * organização de arquivo local, sem efeito sobre leitor, envio ou dado
 * externo'" — leitura de prosa que este módulo, deliberadamente mecânico,
 * não faz).
 */
export function detectInheritedBlockLabel(
  issue: BacklogIssueInput,
  parent: ParentIssueRef | null,
): InheritedBlockLabelAlarm | null {
  if (issue.state === "CLOSED") return null;
  if (!parent) return null;

  const parentRef = extractParentRef(issue.body);
  if (parentRef === null || parentRef !== parent.number) return null;

  const sharedLabels = INHERITABLE_BLOCK_LABELS.filter(
    (l) => issue.labels.includes(l) && parent.labels.includes(l),
  );
  if (sharedLabels.length === 0) return null;

  return {
    action: "alarm",
    patternId: "inherited-block-label",
    issue: issue.number,
    title: issue.title,
    url: issue.url,
    parentNumber: parent.number,
    sharedLabels,
  };
}

// ─── Padrão 5 — label de bloqueio inconsistente entre filhas da mesma mãe (ALARME, #6201) ──

/** Referência mínima a uma issue, pra listar nos dois lados do achado sem
 * carregar o objeto `BacklogIssueInput` inteiro. */
export interface SiblingIssueRef {
  number: number;
  title: string;
  url: string;
}

export interface SiblingBlockLabelInconsistencyAlarm {
  action: "alarm";
  patternId: "sibling-block-label-inconsistency";
  parentNumber: number;
  /** Label de `INHERITABLE_BLOCK_LABELS` em disputa entre as filhas. */
  label: string;
  /** Filhas (referenciando a mesma mãe) que CARREGAM a label. */
  withLabel: SiblingIssueRef[];
  /** Filhas (referenciando a mesma mãe) que NÃO carregam a label. */
  withoutLabel: SiblingIssueRef[];
}

/**
 * Detecta o padrão 5 (#6201 item 7): entre as issues-filhas de uma MESMA
 * mãe (agrupadas por `extractParentRef` — mesmo mecanismo do padrão 3), uma
 * label de bloqueio real (`INHERITABLE_BLOCK_LABELS`) presente em ALGUMAS
 * mas AUSENTE em OUTRAS.
 *
 * Motivação (auditoria de 26/08, #6201): quando uma migração vira "mãe" e é
 * decomposta em filhas por EIXO (#6184-#6187, filhas de #463), o bloqueio
 * de cada eixo é genuinamente diferente — cliques por link (#6185) e stats
 * agregado (#6186) de fato dependiam de envio/clique real na época; cache
 * híbrido (#6187) e metadados (#6184) eram código local puro, sem bloqueio.
 * A label `kit-migration` foi aplicada por padrão a TODAS as filhas menos
 * uma (#6184, que ficou "por omissão" sem a label) — o padrão 3
 * (`detectInheritedBlockLabel`) só enxerga o caso onde a label da MÃE
 * também está na filha; ele não flagra a ASSIMETRIA entre filhas
 * (#6185/#6186/#6187 com a label, #6184 sem), que é justamente o sintoma
 * "contorno por omissão não deixa rastro" citado na issue.
 *
 * Mecânico, como os padrões 3/4: não julga QUAL lado está certo (a label
 * pode estar faltando na que não tem, ou sobrando na que tem — os dois são
 * plausíveis sem ler o corpo de cada filha para confirmar o eixo real),
 * só sinaliza a divergência pra revisão humana. Sempre ALARME.
 *
 * **Diferença deliberada dos padrões 3/4: este NUNCA converge a zero achados
 * pra uma mãe genuinamente decomposta por eixo com bloqueios reais
 * distintos.** Nos padrões 3/4, o estado corrigido é o estado SEM o achado
 * (label removida da filha / checkbox fechado). Aqui, o estado CORRETO de
 * uma decomposição por eixo é justamente a assimetria — algumas filhas
 * bloqueadas, outras não, e isso é voz ativa, não bug (é o próprio ponto do
 * item 7 da #6201: o bloqueio virou "por eixo", não "por migração"). Rodar
 * a reconciliação diária contra `#463` decomposta continuará emitindo este
 * alarme indefinidamente, mesmo depois de confirmado que a divisão está
 * correta — é sinal esperado, não regressão do gate de idempotência que os
 * padrões 1/2 garantem (ver docstring do módulo, seção Idempotência). Uma
 * forma de silenciar um caso já revisado (comentário-marcador, por exemplo)
 * é trabalho futuro fora do escopo do #6201, não implementado aqui.
 *
 * Unânime (todas com a label, ou todas sem) não é achado — divergência zero
 * não indica nada de errado. Só entra grupo com ≥2 filhas referenciando a
 * mesma mãe (não há "inconsistência" possível com 1 filha só).
 *
 * `issues` é o backlog OPEN inteiro (mesmo formato de `fetchOpenBacklog`) —
 * a função agrupa por mãe internamente; diferente dos padrões 1-4, que
 * operam issue-a-issue, este precisa ver o conjunto de uma vez.
 */
export function detectSiblingBlockLabelInconsistency(
  issues: readonly BacklogIssueInput[],
): SiblingBlockLabelInconsistencyAlarm[] {
  const byParent = new Map<number, BacklogIssueInput[]>();
  for (const issue of issues) {
    if (issue.state === "CLOSED") continue;
    const parentNumber = extractParentRef(issue.body);
    if (parentNumber === null) continue;
    const group = byParent.get(parentNumber) ?? [];
    group.push(issue);
    byParent.set(parentNumber, group);
  }

  const toRef = (i: BacklogIssueInput): SiblingIssueRef => ({ number: i.number, title: i.title, url: i.url });

  const findings: SiblingBlockLabelInconsistencyAlarm[] = [];
  for (const [parentNumber, siblings] of byParent) {
    if (siblings.length < 2) continue;
    for (const label of INHERITABLE_BLOCK_LABELS) {
      const withLabel = siblings.filter((s) => s.labels.includes(label));
      const withoutLabel = siblings.filter((s) => !s.labels.includes(label));
      if (withLabel.length === 0 || withoutLabel.length === 0) continue;
      findings.push({
        action: "alarm",
        patternId: "sibling-block-label-inconsistency",
        parentNumber,
        label,
        withLabel: withLabel.map(toRef),
        withoutLabel: withoutLabel.map(toRef),
      });
    }
  }

  findings.sort((a, b) => a.parentNumber - b.parentNumber || a.label.localeCompare(b.label));
  return findings;
}

// ─── Padrão 4 — checkbox aberto em issue fora-de-rodada (ALARME) ───────────

/** Casa uma linha de checkbox markdown ABERTO (`- [ ] texto`), tolerando
 * indentação e `*`/`-` como marcador de lista. Não casa `- [x]`/`- [X]`
 * (já resolvido). */
const OPEN_CHECKBOX_RE = /^[ \t]*[-*][ \t]+\[[ \t]?\][ \t]+\S/gm;

/** Conta checkboxes abertos no corpo — exportado pra ser reusável/testável
 * isoladamente do resto do padrão 4. */
export function countOpenCheckboxes(body: string): number {
  const matches = body.match(OPEN_CHECKBOX_RE);
  return matches ? matches.length : 0;
}

export interface OpenChecklistInTerminalIssueAlarm {
  action: "alarm";
  patternId: "open-checklist-in-terminal-issue";
  issue: number;
  title: string;
  url: string;
  execTrack: string;
  openCheckboxCount: number;
}

/**
 * Detecta o padrão 4: uma issue já classificada `fora-de-rodada` pelo
 * `execTrack` do CALLER (`classifyExecTrack`, rodado sobre o estado
 * ATUAL — este módulo não reimplementa o classificador) que ainda carrega
 * ≥1 checkbox aberto no corpo. Nada revisita uma issue `fora-de-rodada`
 * (é exatamente por isso que o item fica invisível — fixture real #6047:
 * "Como a issue classifica Fora de rodada, nada a revisitava"), então um
 * checklist pendente ali é sinal de trabalho potencialmente já resolvido
 * em outra issue mas nunca marcado aqui.
 *
 * Issue CLOSED não entra — não há checklist "esquecido" numa issue já
 * fechada, o item morreu junto com o fechamento.
 *
 * Sempre ALARME: confirmar se o item foi de fato resolvido alhures exige
 * ler a(s) outra(s) issue(s) candidatas — julgamento fora do escopo
 * mecânico deste módulo.
 */
export function detectOpenChecklistInTerminalIssue(
  issue: BacklogIssueInput,
  execTrack: string,
): OpenChecklistInTerminalIssueAlarm | null {
  if (issue.state === "CLOSED") return null;
  if (execTrack !== "fora-de-rodada") return null;

  const openCheckboxCount = countOpenCheckboxes(issue.body);
  if (openCheckboxCount === 0) return null;

  return {
    action: "alarm",
    patternId: "open-checklist-in-terminal-issue",
    issue: issue.number,
    title: issue.title,
    url: issue.url,
    execTrack,
    openCheckboxCount,
  };
}

// ─── Relatório ───────────────────────────────────────────────────────────

export type ReconcileFinding =
  | MarkerDeferralFinding
  | MarkerWontfixConflictAlarm
  | InheritedBlockLabelAlarm
  | OpenChecklistInTerminalIssueAlarm
  | SiblingBlockLabelInconsistencyAlarm;

type ReconcileAlarm =
  | MarkerDeferralConflictAlarm
  | MarkerWontfixConflictAlarm
  | InheritedBlockLabelAlarm
  | OpenChecklistInTerminalIssueAlarm
  | SiblingBlockLabelInconsistencyAlarm;

/** Separa achados em "corrigidos"/"a corrigir" (padrão 1/2, `action ===
 * "fix"`) e "só alarmados" (o resto) — o relatório da task precisa das duas
 * listas SEPARADAS (#6198, "Pronto quando"), nunca uma tabela única
 * misturando os dois. */
export function splitFindingsByAction(findings: readonly ReconcileFinding[]): {
  fixes: MarkerDeferralConflictFix[];
  alarms: ReconcileAlarm[];
} {
  const fixes: MarkerDeferralConflictFix[] = [];
  const alarms: ReconcileAlarm[] = [];
  for (const f of findings) {
    if (f.action === "fix") fixes.push(f);
    else alarms.push(f);
  }
  return { fixes, alarms };
}
