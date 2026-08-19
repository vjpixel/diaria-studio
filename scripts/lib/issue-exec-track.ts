/**
 * scripts/lib/issue-exec-track.ts (#5462, #5682)
 *
 * Responde UMA pergunta sobre uma issue aberta: **qual sessão consegue
 * trabalhar isso?** — `overnight` | `develop` | `agendada` | `bloqueada` |
 * `fora-de-rodada`.
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
 * ## Agendada (#5682)
 *
 * `agendada` = a issue tem uma **data específica** recomendada para ser
 * resolvida — nada mais. Não é "adiada", não é "esperando", não é "o editor
 * não quer agora". O único sinal de entrada é o marcador `aguardando-ate:`
 * com data futura; deferimento vago (`not-this-week`, `next-month`,
 * `on-hold`) **não** é `agendada` — decisão explícita do editor, ver
 * `classifyExecTrack`. `agendada` fica entre `bloqueada` (bloqueio real
 * vence sobre data) e o resto do deferimento vago (data vence sobre
 * deferimento vago) — ver a docstring de `classifyExecTrack` pra precedência
 * completa.
 *
 * Puro: sem I/O, sem rede, sem `gh`. Recebe labels + corpo já buscados.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 4
 * @see .claude/skills/diaria-develop/SKILL.md § Fronteira com o overnight nas ambíguas
 * @see scripts/lib/issue-decisions.ts (mesmo padrão de julgamento gravado)
 */

/** Qual sessão consegue trabalhar a issue. Exclusivo — exatamente um valor
 * por issue, e a união dos cinco cobre o backlog aberto inteiro. */
export type ExecTrack = "overnight" | "develop" | "agendada" | "bloqueada" | "fora-de-rodada";

/** Fora de qualquer rodada: o editor tirou de circulação, não é "ainda não". */
const OUT_OF_ROUND_LABELS = new Set(["on-hold", "wontfix"]);

/**
 * Já resolvida sem código a escrever — motivo diferente de `OUT_OF_ROUND_LABELS`
 * acima (#5532): não é o editor tirando a issue de circulação, é a issue já
 * ter chegado ao fim por outro caminho. `decisao-registrada` = decisão
 * registrada em prosa que fecha o assunto (ex: `[DECISÃO] ...`); `alarm` =
 * gerada por script de alarme de família ESTADO (#5553 — ver
 * `ALARM_EVENT_LABEL` abaixo pra família EVENTO, que NÃO entra aqui),
 * documenta no próprio corpo que se comenta/fecha sozinha quando o achado
 * para de reproduzir.
 *
 * Checado DEPOIS de `bloqueada`/`develop` (não junto de `OUT_OF_ROUND_LABELS`
 * no topo da precedência) de propósito: `decisao-registrada` também aparece
 * em issues que só tiveram uma decisão PARCIAL registrada (ex: #4555, que
 * carrega `decisao-registrada` + `trade-off-real` — a decisão fechou o perfil
 * do parceiro, mas a prospecção em si continua sendo trabalho real de
 * develop). Se esta label tivesse a mesma precedência de `on-hold`/`wontfix`,
 * #4555 sairia como `fora-de-rodada` — errado, ainda há trabalho de verdade
 * pendente, só que não é código. Outra label que já classifica a issue
 * (bloqueio, `windows`, `trade-off-real`) sempre vence sobre esta. */
const RESOLVED_BY_PROSE_LABELS = new Set(["decisao-registrada", "alarm"]);

/**
 * #5553 — issue de alarme sobre um EVENTO PASSADO (achado ancorado a um ID
 * imutável — campanha, envio, post — que nunca "para de reproduzir" por
 * alguém ter consertado algo; só sai da janela de observação do alarme com o
 * tempo, ex: guardrail furado numa campanha específica já enviada, #5525).
 *
 * Ao contrário de `alarm` acima (família ESTADO — condição re-checável,
 * ex: arquivo faltando em disco), esta label NUNCA entra em
 * `RESOLVED_BY_PROSE_LABELS`: a premissa de "se auto-resolve" é falsa pra
 * evento — a issue precisa de revisão humana, não desaparecer sozinha.
 * Aplicada pelo emissor SEMPRE junto de `alarm` (ver
 * `scripts/lib/alarm-issues.ts` — `ensureAlarmIssue`), então sem uma checagem
 * própria ANTES de `RESOLVED_BY_PROSE_LABELS`, a label `alarm` companheira
 * bastaria pra cair em `fora-de-rodada` por engano — daí este valor ganhar um
 * ramo de precedência explícito em vez de só ficar de fora do Set acima. */
const ALARM_EVENT_LABEL = "alarm-evento";

/** Bloqueio que nenhuma sessão destrava sozinha — conta de terceiro,
 * credencial, allowlist, plataforma plan-gated, ou bloqueio de execução já
 * registrado (#5373). */
const BLOCKED_LABELS = new Set([
  "external-blocker",
  "kit-migration",
  "beehiiv",
  "bloqueio-execucao",
]);

/**
 * #5694 — subcaso de `external-blocker` mais barato de destravar: a
 * credencial JÁ EXISTE, só falta escopo/permission (achado real do #5641 —
 * token Cloudflare existente só precisava de 2 permissions novas no
 * dashboard, sem trocar o valor secreto). Isso é cat. A (credencial-runtime)
 * do `/diaria-develop` por definição — o editor destrava ao vivo em minutos,
 * diferente do resto de `BLOCKED_LABELS` (conta nova, allowlist GitHub,
 * decisão de produto), que exige mais que uma edição de escopo.
 *
 * Cancela o efeito terminal de `external-blocker` **especificamente**
 * (`isCredentialScopeUnblock` em `classifyExecTrack`) — não de qualquer
 * label de `BLOCKED_LABELS`. Uma issue com `kit-migration`/`beehiiv`/
 * `bloqueio-execucao` continua `bloqueada` mesmo carregando esta label: o
 * subcaso é específico de credencial, não um passe geral pra sair de
 * `bloqueada`. Aplicar esta label sem `external-blocker` não tem efeito —
 * nenhum branch a consulta sozinha.
 */
const CREDENCIAL_ESCOPO_LABEL = "credencial-escopo";

/** Deferimento por tempo — trabalhável, só não agora. Vago (sem data
 * legível), diferente do marcador `aguardando-ate:` abaixo, que desarma
 * sozinho e classifica `agendada`, não `bloqueada` (#5682). Checado DEPOIS
 * do marcador de propósito: uma issue com data explícita disse algo mais
 * específico que "not-this-week" — a data vence sobre o deferimento vago. */
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
 * Mecanismo exclusivo de `agendada` (#5682) — não existe outro sinal de
 * entrada. Uma data futura aqui vence deferimento vago (`not-this-week`,
 * `next-month`), mas perde pra bloqueio real (`BLOCKED_LABELS`): issue
 * bloqueada por credencial/conta de terceiro continua `bloqueada` mesmo com
 * marcador, porque a data é irrelevante enquanto o bloqueio existir.
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
 *   2. `bloqueada`      — bloqueio externo (nenhuma sessão destrava sozinha).
 *                         Exceção (#5694): `external-blocker` acompanhada de
 *                         `credencial-escopo` NÃO conta aqui — vira `develop`
 *                         no passo 5. Qualquer outra label de
 *                         `BLOCKED_LABELS` (`kit-migration`, `beehiiv`,
 *                         `bloqueio-execucao`) continua vencendo normalmente.
 *   3. `agendada`       — (#5682) marcador `aguardando-ate:` com data futura,
 *                         e nenhum bloqueio real acima já decidiu por ela.
 *                         Bloqueio real vence sobre data: a issue é
 *                         `bloqueada`, não `agendada`, se carregar as duas.
 *   4. `bloqueada`      — (2ª checagem) deferimento vago (`not-this-week`,
 *                         `next-month`) — checado DEPOIS de `agendada` de
 *                         propósito: quem escreveu uma data disse algo mais
 *                         específico que "not-this-week", então a data vence
 *                         sobre o deferimento vago quando as duas coexistem.
 *   5. `develop`        — precisa da máquina Windows, trade-off-real já
 *                         julgado pelo overnight, ou (#5694) `external-blocker`
 *                         + `credencial-escopo` (credencial já existe, só
 *                         falta escopo — cat. A do develop).
 *   6. `overnight`      — (#5553) alarme de EVENTO PASSADO (`alarm-evento`):
 *                         checado ANTES do passo 7 pra vencer a label `alarm`
 *                         companheira, que sozinha cairia em fora-de-rodada.
 *   7. `fora-de-rodada` — (2ª checagem, #5532) já resolvida em prosa
 *                         (`decisao-registrada`) ou alarme de ESTADO que se
 *                         auto-resolve (`alarm`, sem `alarm-evento`), e
 *                         nenhuma das labels acima já decidiu por ela — ver
 *                         docstring de `RESOLVED_BY_PROSE_LABELS` pro porquê
 *                         desta checagem vir depois de `bloqueada`/`develop`,
 *                         não junto da 1ª.
 *   8. `overnight`      — sobrou.
 *
 * `bloqueada` é retornada de dois pontos (passos 2 e 4) — preço de encaixar
 * `agendada` entre bloqueio-duro e deferimento-vago (#5682); os dois branches
 * seguem semanticamente distintos (bloqueio real vs. deferimento vago), só
 * compartilham o valor de saída.
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

  // #5694 — `external-blocker` + `credencial-escopo` sai de `BLOCKED_LABELS`
  // (vira `develop` no passo 5 abaixo). Só essa combinação específica: outra
  // label de `BLOCKED_LABELS` presente na mesma issue continua bloqueando.
  const isCredentialScopeUnblock = has("external-blocker") && has(CREDENCIAL_ESCOPO_LABEL);

  if (
    labels.some(
      (l) => BLOCKED_LABELS.has(l) && !(l === "external-blocker" && isCredentialScopeUnblock),
    )
  )
    return "bloqueada";

  const waitUntil = parseWaitUntil(body);
  if (waitUntil && waitUntil.getTime() > now.getTime()) return "agendada";

  if (labels.some((l) => DEFERRED_LABELS.has(l))) return "bloqueada";

  if (labels.some((l) => MACHINE_DEVELOP_LABELS.has(l))) return "develop";
  if (has(TRADE_OFF_LABEL)) return "develop";
  if (isCredentialScopeUnblock) return "develop";

  if (has(ALARM_EVENT_LABEL)) return "overnight";

  if (labels.some((l) => RESOLVED_BY_PROSE_LABELS.has(l))) return "fora-de-rodada";

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
  agendada: "Agendada",
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
    "Overnight — nenhum bloqueio, nenhuma dependência de máquina. Inclui a issue ambígua ainda não triada (quem separa ambiguidade trivial de trade-off real é o próprio overnight, na Fase 0) e o alarme sobre EVENTO PASSADO (label `alarm-evento`, #5553 — achado ancorado a um ID imutável que nunca se auto-resolve, precisa de revisão).",
  develop:
    "Develop — precisa do editor presente: exige a máquina Windows (label `windows`), é trade-off real de produto/editorial já julgado pelo overnight (label `trade-off-real`, cat. C), ou (#5694) é `external-blocker` com escopo de credencial já identificado (label `credencial-escopo` — credencial existente, só falta permission, cat. A).",
  agendada:
    "Agendada — tem data específica pra ser resolvida, registrada no marcador `aguardando-ate: AAAA-MM-DD`. Não está bloqueada por nada: é trabalho fazível que volta sozinho ao fluxo normal na data, sem ninguém precisar remover label. Adiamento sem data (`not-this-week`, `next-month`, `on-hold`) não é Agendada.",
  bloqueada:
    "Bloqueada — nenhuma sessão destrava sozinha: conta de terceiro, credencial, plataforma plan-gated, ou deferimento vago sem data (`not-this-week`, `next-month`). Marcador `aguardando-ate:` com data futura é Agendada, não Bloqueada — a menos que um bloqueio real coexista. Exceção (#5694): `external-blocker` + `credencial-escopo` (credencial já existe, só falta escopo) não é Bloqueada — vira Develop.",
  "fora-de-rodada":
    "Fora de rodada — três motivos distintos, nenhum com código pendente: o editor tirou de circulação (`on-hold`, `wontfix` — não é 'ainda não', é 'não'); já foi resolvida por registro de decisão em prosa (`decisao-registrada`, só quando nenhuma outra label já classificar a issue de outro jeito — uma decisão parcial numa issue que segue sendo trabalho real, ex: trade-off-real, não entra aqui); ou é alarme de ESTADO que se auto-resolve (`alarm` sem `alarm-evento`, comenta/fecha sozinho quando o achado para de reproduzir — #5553: alarme de EVENTO PASSADO, `alarm-evento`, vai pro Overnight em vez de aqui).",
};

/** Forma do badge por valor, na ordem de LEITURA da legenda: do que anda
 * sozinho hoje à noite até o que não anda de jeito nenhum — `agendada` entra
 * entre `develop` e `bloqueada` (#5682): anda sozinha *depois*, na data; não
 * anda de jeito nenhum é exclusividade de `bloqueada`. Não é o inverso
 * estrito da ordem de precedência do classificador (que checa `bloqueada`
 * antes de `agendada`) — de propósito: a legenda responde "o que eu consigo
 * tocar, e quando?", não "em que ordem o código testa?".
 *
 * É isto que `GET /api/issues` serve em `meta.execTrack`, e que o front
 * renderiza. O front NÃO redeclara os 5 valores: fazia isso antes e criava
 * exatamente a 2ª fonte de verdade que este módulo existe pra eliminar —
 * um 6º valor quebraria o build no servidor e passaria silenciosamente no
 * cliente, caindo no fallback sem tradução nem tooltip (#5462, review). */
export const EXEC_TRACK_UI: Array<{ track: ExecTrack; label: string; explain: string }> = (
  ["overnight", "develop", "agendada", "bloqueada", "fora-de-rodada"] as const
).map((track) => ({ track, label: EXEC_TRACK_LABELS[track], explain: EXEC_TRACK_EXPLAIN[track] }));
