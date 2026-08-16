/**
 * scripts/lib/issue-exec-track.ts (#5462)
 *
 * Responde UMA pergunta sobre uma issue aberta: **qual sessão consegue
 * trabalhar isso?** — `overnight` | `develop` | `bloqueada` | `fora-de-rodada`.
 *
 * Até aqui essa regra só existia em prosa, espalhada pela Fase 0 de
 * `.claude/skills/diaria-overnight/SKILL.md` (passo 4, classificação) e pela
 * tabela de alvo de `.claude/skills/diaria-develop/SKILL.md` — julgamento do
 * coordenador, re-derivado a cada rodada, invisível pra qualquer superfície
 * fora da sessão. O painel de Triagem do Studio precisava do mesmo veredito
 * pra filtrar/rotular, e re-implementá-lo em regex própria daria uma segunda
 * fonte de verdade divergente. Este módulo é a fonte única.
 *
 * ## Por que ambiguidade NÃO entra aqui
 *
 * A tentação óbvia é classificar "issue ambígua" como `develop` — cat. C é
 * escopo exclusivo do develop (#2640). Mas o overnight tem **duas**
 * ambiguidades, não uma, e a linha entre elas é julgamento puro
 * (overnight/SKILL.md:69):
 *
 *   - trivial-mas-não-documentada ("formato A ou B de log", "opção técnica
 *     equivalente") → `precisa-resposta` → o editor destrava no **briefing**
 *     da Fase 0, antes de sair. É trabalho de overnight.
 *   - trade-off-real de produto/editorial ("design system vs documentar") →
 *     bounce imediato + comentário direcionando ao develop cat. C.
 *
 * Linha divisória literal da SKILL: "se a resposta depende de preferência
 * sobre experiência do usuário final → trade-off-real; se é escolha técnica
 * sem impacto diferencial em usuário → trivial". Isso **não existe no texto
 * da issue** — nenhuma regex separa os dois exemplos acima, porque a
 * diferença está no efeito sobre o leitor, não no vocabulário. O
 * `AMBIGUITY_RE` de `studio-ui/studio-issues.ts` (que este módulo substitui)
 * casava com os dois indiscriminadamente.
 *
 * Então ambiguidade não é sinal de entrada aqui. Uma issue ambígua nasce
 * `overnight` — o que é a verdade: o overnight ainda vai olhar pra ela. Ela
 * só vira `develop` depois que o overnight fizer o julgamento e gravá-lo na
 * label `trade-off-real`. Mesmo padrão de `issue-decisions.ts` (#5373): o
 * julgamento é feito UMA vez por quem tem contexto pra fazê-lo, gravado de
 * forma durável, e lido depois — nunca re-derivado por heurística.
 *
 * Corolário: quando o develop resolve a cat. C, ele "posta a decisão como
 * comentário durável na issue, remove a ambiguidade (→ elegível)"
 * (develop/SKILL.md:70). Remover a label `trade-off-real` faz parte disso —
 * é o que devolve a issue pro overnight. Sem essa remoção ela ficaria presa
 * em `develop` para sempre depois de já decidida.
 *
 * ## Máquina
 *
 * `windows` → `develop`, incondicional (decisão do editor, 16/08/2026). Não
 * há comparação com a máquina onde este código roda: a restrição é sobre
 * ONDE a issue pode ser trabalhada, não sobre onde a Triagem está aberta.
 * `server` → sem efeito (é a máquina onde o overnight já roda). A label
 * `local`, ambígua entre as duas, foi aposentada na mesma decisão — segue
 * existindo no GitHub pelas issues fechadas que a carregam, e é ignorada
 * aqui de propósito.
 *
 * `scripts/lib/exec-mode.ts` deliberadamente NÃO é consultado: ele responde
 * "esta sessão tem `data/`?", que é uma pergunta diferente — no servidor
 * Linux ele responde `local` inclusive para uma issue que exige a máquina
 * Windows.
 *
 * Puro: sem I/O, sem rede, sem `gh`. Recebe labels + corpo já buscados.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 4
 * @see .claude/skills/diaria-develop/SKILL.md § Fronteira com o overnight nas ambíguas
 * @see scripts/lib/issue-decisions.ts (mesmo padrão de julgamento gravado)
 */

/** Qual sessão consegue trabalhar a issue. Exclusivo — exatamente um valor
 * por issue, e a união dos quatro cobre o backlog aberto inteiro. */
export type ExecTrack = "overnight" | "develop" | "bloqueada" | "fora-de-rodada";

/** Fora de qualquer rodada: o editor tirou de circulação, não é "ainda não". */
const OUT_OF_ROUND_LABELS = new Set(["on-hold", "wontfix"]);

/** Bloqueio que nenhuma sessão destrava sozinha — conta de terceiro,
 * credencial, allowlist, plataforma plan-gated, ou bloqueio de execução já
 * registrado (#5373). */
const BLOCKED_LABELS = new Set([
  "external-blocker",
  "kit-migration",
  "beehiiv",
  "bloqueio-execucao",
]);

/** Deferimento por tempo — trabalhável, só não agora. Vago (sem data
 * legível), diferente do marcador `aguardando-ate:` abaixo, que desarma
 * sozinho. */
const DEFERRED_LABELS = new Set(["not-this-week", "next-month"]);

/** Exige a máquina Windows do editor (Chrome logado, ComfyUI) — o overnight
 * roda no servidor Linux, então não alcança. */
const MACHINE_DEVELOP_LABELS = new Set(["windows"]);

/** Julgamento já gravado pelo overnight: trade-off-real de produto/editorial,
 * cat. C, escopo exclusivo do develop (#2640). */
const TRADE_OFF_LABEL = "trade-off-real";

/**
 * Marcador de espera com data legível, no mesmo espírito de
 * `issue-decisions.ts`: `<!-- aguardando-ate: 2026-09-01 -->`.
 *
 * Diferente das labels de deferimento vago, este **desarma sozinho** — passada
 * a data, a issue volta ao fluxo normal sem ninguém precisar remover label.
 * Data-só (sem hora) é intencional: a granularidade útil aqui é o dia, e
 * comparar em UTC evita que a issue reapareça/desapareça conforme o fuso de
 * quem abriu a Triagem.
 *
 * **O marcador precisa estar SOZINHO na própria linha** (`^...$` com flag `m`)
 * — não basta aparecer em qualquer lugar do corpo. Achado na verificação
 * contra o backlog real (#5462): a própria issue que introduziu este
 * mecanismo caiu em `bloqueada`, porque o corpo dela DOCUMENTA o marcador
 * citando-o em prosa/code-span como exemplo. Sem a âncora de linha, toda
 * issue que menciona o mecanismo se auto-bloqueia — falso positivo silencioso,
 * já que a issue some do filtro Overnight sem nenhum sinal de que foi um
 * exemplo citado que a tirou de lá.
 *
 * A âncora também alinha com a convenção de `issue-decisions.ts`, onde o
 * marcador é PREFIXO do comentário (linha própria, prosa legível depois).
 * Menção inline é sempre documentação; marcador de verdade é sempre linha
 * própria.
 */
const WAIT_UNTIL_RE = /^[ \t]*<!--\s*aguardando-ate:\s*(\d{4}-\d{2}-\d{2})\s*-->[ \t]*$/im;

export interface ExecTrackInput {
  /** Nomes de label da issue (já normalizados, sem o objeto do `gh`). */
  labels: string[];
  /** Corpo cru da issue — usado só pro marcador `aguardando-ate:`. */
  body?: string | null;
  /** Injetável pra teste; default `new Date()`. */
  now?: Date;
}

/**
 * Extrai a data do marcador `aguardando-ate:`, ou `null` se ausente/inválida.
 * Tolerante: marcador malformado é ignorado (nunca lança) — mesma postura de
 * `parseDecisionMarkers`, porque um marcador quebrado nunca deve prender uma
 * issue num estado que ninguém consegue diagnosticar pela UI.
 */
export function parseWaitUntil(body: string | null | undefined): Date | null {
  const m = WAIT_UNTIL_RE.exec(body ?? "");
  if (!m) return null;
  const ymd = m[1];
  const parsed = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // `Number.isNaN` sozinho NÃO basta: a regex aceita dia 01-31 em qualquer
  // mês, e o `Date` do V8 não rejeita dia inexistente — faz rollover mudo
  // (`2026-02-30` → 2026-03-02, `2026-04-31` → 2026-05-01). Sem esta
  // checagem, o editor escreve uma data pensando "até o fim de fevereiro" e o
  // sistema usa outra, 1-2 dias à frente, sem erro em lugar nenhum. Bater o
  // valor parseado de volta contra o texto pega exatamente esse caso.
  if (parsed.toISOString().slice(0, 10) !== ymd) return null;
  return parsed;
}

/**
 * Classifica a issue. Primeira regra que casa vence — a ordem codifica
 * precedência, não conveniência:
 *
 *   1. `fora-de-rodada` — o editor tirou de circulação; nada mais importa.
 *   2. `bloqueada`      — bloqueio externo, ou espera por data ainda vigente.
 *   3. `develop`        — precisa da máquina Windows, ou trade-off-real já
 *                         julgado pelo overnight.
 *   4. `overnight`      — sobrou.
 *
 * O default é `overnight` e não `develop` **apenas porque ambiguidade saiu do
 * classificador** (ver docstring do módulo). Todo bloqueio real tem label ou
 * marcador próprio; uma issue sem nenhum dos dois é, por construção, trabalho
 * que o overnight pega — inclusive a ambígua que ele ainda vai triar.
 */
export function classifyExecTrack(input: ExecTrackInput): ExecTrack {
  const { labels, body, now = new Date() } = input;
  const has = (l: string) => labels.includes(l);

  if (labels.some((l) => OUT_OF_ROUND_LABELS.has(l))) return "fora-de-rodada";

  if (labels.some((l) => BLOCKED_LABELS.has(l))) return "bloqueada";
  if (labels.some((l) => DEFERRED_LABELS.has(l))) return "bloqueada";
  const waitUntil = parseWaitUntil(body);
  if (waitUntil && waitUntil.getTime() > now.getTime()) return "bloqueada";

  if (labels.some((l) => MACHINE_DEVELOP_LABELS.has(l))) return "develop";
  if (has(TRADE_OFF_LABEL)) return "develop";

  return "overnight";
}

/** Rótulo curto pra UI (badge/dropdown). Separado do tipo pra manter o valor
 * serializado estável mesmo se o texto visível mudar.
 *
 * `Record<ExecTrack, string>` não é decoração: se um 5º valor entrar no union
 * sem entrar aqui, o build quebra. Essa garantia só vale, porém, se quem
 * RENDERIZA consumir esta tabela — ver `EXEC_TRACK_UI` abaixo. */
export const EXEC_TRACK_LABELS: Record<ExecTrack, string> = {
  overnight: "Overnight",
  develop: "Develop",
  bloqueada: "Bloqueada",
  "fora-de-rodada": "Fora de rodada",
};

/**
 * Explicação por valor, mostrada como tooltip no badge e como legenda visível
 * na Triagem.
 *
 * Mora aqui, junto das regras, e não no `triagem.js`, de propósito: é a
 * descrição do que o classificador FAZ. Separá-la do classificador deixa as
 * duas livres pra divergir — a regra muda, o texto que explica a regra fica,
 * e o editor lê uma explicação que não corresponde mais ao comportamento.
 */
export const EXEC_TRACK_EXPLAIN: Record<ExecTrack, string> = {
  overnight:
    "Overnight — nenhum bloqueio, nenhuma dependência de máquina. Inclui a issue ambígua ainda não triada: quem separa ambiguidade trivial (destravável no briefing) de trade-off real é o próprio overnight, na Fase 0.",
  develop:
    "Develop — precisa do editor presente: exige a máquina Windows (label `windows`), ou é trade-off real de produto/editorial já julgado pelo overnight (label `trade-off-real`, cat. C).",
  bloqueada:
    "Bloqueada — nenhuma sessão destrava sozinha: conta de terceiro, credencial, plataforma plan-gated, ou espera por data ainda vigente (marcador `aguardando-ate:`, que desarma sozinho na data).",
  "fora-de-rodada":
    "Fora de rodada — o editor tirou de circulação (`on-hold`, `wontfix`). Não é 'ainda não', é 'não'.",
};

/** Forma do badge por valor, na ordem de LEITURA da legenda: do que anda
 * sozinho hoje à noite até o que não anda de jeito nenhum. É o INVERSO da
 * ordem de precedência do classificador (que checa `fora-de-rodada` primeiro
 * e cai em `overnight` por último) — de propósito: a legenda responde "o que
 * eu consigo tocar?", não "em que ordem o código testa?".
 *
 * É isto que `GET /api/issues` serve em `meta.execTrack`, e que o front
 * renderiza. O front NÃO redeclara os 4 valores: fazia isso antes e criava
 * exatamente a 2ª fonte de verdade que este módulo existe pra eliminar —
 * um 5º valor quebraria o build no servidor e passaria silenciosamente no
 * cliente, caindo no fallback sem tradução nem tooltip (#5462, review). */
export const EXEC_TRACK_UI: Array<{ track: ExecTrack; label: string; explain: string }> = (
  ["overnight", "develop", "bloqueada", "fora-de-rodada"] as const
).map((track) => ({ track, label: EXEC_TRACK_LABELS[track], explain: EXEC_TRACK_EXPLAIN[track] }));
