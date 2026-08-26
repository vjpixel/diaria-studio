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
 * ambiguidades DE TRIAGEM (não uma), e a linha entre elas é julgamento puro
 * (overnight/SKILL.md:69):
 *
 *   - trivial-mas-não-documentada ("formato A ou B de log", "opção técnica
 *     equivalente") → `precisa-resposta` → o editor destrava no **briefing**
 *     da Fase 0, antes de sair. É trabalho de overnight.
 *   - trade-off-real de produto/editorial ("design system vs documentar") →
 *     bounce imediato + comentário direcionando ao develop cat. C.
 *
 * Existe um 3º desfecho, mas ele não é uma ambiguidade de TRIAGEM — é o que
 * sobra depois que a rodada já investigou e concluiu "sem próximo passo de
 * código prescrito" (#5968, label `sem-direcao-acionavel`, ver
 * `RESOLVED_BY_PROSE_LABELS` abaixo). As duas acima acontecem ANTES de
 * qualquer tentativa de resolver a issue; esta acontece DEPOIS — não é a
 * mesma família, só o mesmo sintoma superficial ("issue sem rota clara").
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
 * por issue, e a união dos seis cobre o backlog aberto inteiro.
 *
 * `epica` (#6201 item 8) é um valor à parte de `fora-de-rodada` desde
 * 26/08/2026 — antes, `epic-guarda-chuva` caía dentro de
 * `RESOLVED_BY_PROSE_LABELS` e virava `fora-de-rodada`, indistinguível de
 * "o editor tirou de circulação" (`on-hold`/`wontfix`). "É uma épica" é
 * afirmação sobre a NATUREZA da issue (nunca despachada direto, fecha
 * quando as filhas mergearem); "o editor tirou de circulação" é uma
 * decisão. As duas produziam o mesmo rótulo no painel — e pior, pra uma
 * épica que TAMBÉM carregava um bloqueio real (`kit-migration` etc.) só dava
 * pra obter a leitura "épica" removendo a label de bloqueio verdadeira (caso
 * real: #463 perdeu `kit-migration` pra classificar certo). Ver docstring de
 * `classifyExecTrackWithRule` pra precedência completa. */
export type ExecTrack = "overnight" | "develop" | "agendada" | "bloqueada" | "epica" | "fora-de-rodada";

/**
 * Identificador da regra que decidiu o `track`. Formato `category:detail`
 * (ver abaixo para os valores) — serve pra o painel distinuguir um `overnight`
 * **verificado** (sinal positivo explícito) de um `overnight` **por omissão**
 * (nenhuma label disse o contrário, ninguém olhou). #6200.
 *
 * - `state:closed`          — `state === "CLOSED"` (nunca candidata)
 * - `label:on-hold`         — `OUT_OF_ROUND_LABELS` (1ª checagem)
 * - `label:wontfix`         — idem
 * - `label:external-blocker` — `BLOCKED_LABELS` com bloqueio real (2ª checagem do passo 2)
 * - `label:kit-migration`   — idem
 * - `label:beehiiv`         — idem
 * - `label:bloqueio-execucao` — idem
 * - `marker:aguardando-ate` — marcador futuro → `agendada`
 * - `label:not-this-week`   — 2ª checagem `bloqueada` (deferimento vago)
 * - `label:next-month`      — idem
 * - `label:windows`         — → `develop`
 * - `label:trade-off-real`  — → `develop`
 * - `label:credencial-escopo` — `external-blocker` + `credencial-escopo` → `develop` (cat. A)
 * - `label:develop-track`  — bloqueio humano/dependência sem data → `develop` (#5948)
 * - `label:alarm-evento`    — → `overnight` (alarme de EVENTO PASSADO)
 * - `label:decisao-registrada` — 2ª checagem `fora-de-rodada`
 * - `label:alarm`           — idem
 * - `label:epic-guarda-chuva` — idem
 * - `label:sem-direcao-acionavel` — idem
 * - `default`               — nenhuma label/marcador/marker decidiu; issue nasce `overnight` por construção
 *
 * O prefixo `label:` / `marker:` / `state:` / `default` é parte do contrato:
 * o painel de Triagem filtra por categoria sem parsear o detalhe. Novas
 * categorias só entram com novos prefixos aqui — nunca literais novos sem
 * atualizar este tipo.
 */
export type ExecTrackMatch =
  | "state:closed"
  | "label:on-hold"
  | "label:wontfix"
  | "label:external-blocker"
  | "label:kit-migration"
  | "label:beehiiv"
  | "label:bloqueio-execucao"
  | "marker:aguardando-ate"
  | "label:not-this-week"
  | "label:next-month"
  | "label:windows"
  | "label:trade-off-real"
  | "label:credencial-escopo"
  | "label:develop-track"
  | "label:alarm-evento"
  | "label:decisao-registrada"
  | "label:alarm"
  | "label:epic-guarda-chuva"
  | "label:sem-direcao-acionavel"
  | "default";

/**
 * Catálogo COMPLETO dos valores que `classifyExecTrackWithRule` emite em
 * `matched`. Mora aqui — e não no teste — de propósito: `tsconfig.json` inclui
 * só `scripts/**\/*.ts`, então uma anotação de tipo escrita em `test/` NUNCA é
 * verificada por `npx tsc --noEmit` e vira guard decorativo.
 *
 * Sendo `readonly ExecTrackMatch[]`, remover um membro da união quebra o
 * literal correspondente aqui em tempo de compilação. É o que faltava quando
 * `"label:develop-track"` ficou fora da união apesar de o runtime emiti-lo e de
 * haver teste asserindo o valor: `ExecTrackResult.matched` é `string` (escape
 * hatch deliberado — o valor é montado como `label:${nome}`), então nada
 * confrontava união × runtime. `test/issue-exec-track.test.ts` fecha o outro
 * lado, conferindo que todo `matched` emitido está neste catálogo. #6200.
 */
export const EXEC_TRACK_MATCH_CATALOG: readonly ExecTrackMatch[] = [
  "state:closed",
  "label:on-hold",
  "label:wontfix",
  "label:external-blocker",
  "label:kit-migration",
  "label:beehiiv",
  "label:bloqueio-execucao",
  "marker:aguardando-ate",
  "label:not-this-week",
  "label:next-month",
  "label:windows",
  "label:trade-off-real",
  "label:credencial-escopo",
  "label:develop-track",
  "label:alarm-evento",
  "label:decisao-registrada",
  "label:alarm",
  "label:epic-guarda-chuva",
  "label:sem-direcao-acionavel",
  "default",
] as const;

/** Resultado estendido de `classifyExecTrack` (#6200) — inclui a regra que
 * decidiu, pra o painel distinguir `overnight` verificado de `overnight` por
 * omissão. `classifyExecTrack` (que preserva a assinatura antiga → `ExecTrack`)
 * delega pra cá e descarta `matched`; callers que precisam do detalhe chamam
 * `classifyExecTrackWithRule` diretamente. */
export interface ExecTrackResult {
  track: ExecTrack;
  /** Regra que decidiu — ver `ExecTrackMatch` pra lista de valores canônicos.
   * Tipo `string` (não `ExecTrackMatch`) porque o valor é dinâmico em runtime
   * (`label:${labelName}` onde `labelName` vem do `gh` e não do Set fixo do
   * TS). `ExecTrackMatch` existe como documentação/catálogo, e `matched`
   * sempre bate num dos valores listados lá — só não dá pra provar isso ao
   * compilador. #6200. */
  matched: string;
}

/** Fora de qualquer rodada: o editor tirou de circulação, não é "ainda não". */
const OUT_OF_ROUND_LABELS = new Set(["on-hold", "wontfix"]);

/**
 * #6201 item 8 — issue `[ÉPICA]` guarda-chuva: nunca implementada direto,
 * fecha só quando as issues-filhas mergearem (#5968). Checada logo depois
 * de `OUT_OF_ROUND_LABELS` e ANTES de `BLOCKED_LABELS`/`agendada`/deferimento
 * — "é uma épica" é afirmação sobre a NATUREZA da issue, então vence sobre
 * qualquer sinal de MOMENTO (bloqueio real, deferimento, data futura), com
 * uma exceção: `on-hold`/`wontfix` (o editor tirando de circulação
 * explicitamente) continua vencendo até `epica`, porque essa é uma decisão
 * mais forte que "é uma épica" — uma épica que o editor engavetou é
 * `fora-de-rodada`, não `epica`.
 *
 * Antes desta label ganhar precedência própria, uma épica com bloqueio real
 * coexistindo (#461: `epic-guarda-chuva` + `kit-migration` + `beehiiv`)
 * classificava `bloqueada` — para obter a leitura "é uma épica" (#463), foi
 * preciso REMOVER a label de bloqueio verdadeira, apagando informação real
 * pra conseguir a classificação certa. Ver `ExecTrack` pro racional
 * completo do valor `epica` como 6º track. */
const EPIC_LABEL = "epic-guarda-chuva";

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
const RESOLVED_BY_PROSE_LABELS = new Set([
  "decisao-registrada",
  "alarm",
  // #5968 — mesma família semântica: nenhuma tem código pendente pra ESTA
  // issue, mesmo sem ser "o editor tirou de circulação"
  // (`OUT_OF_ROUND_LABELS`) nem "decisão registrada"/"alarme" propriamente.
  // `sem-direcao-acionavel` = uma rodada overnight já concluiu
  // explicitamente "sem ação de código clara a tomar" — não é
  // `precisa-resposta` (não há pergunta útil pro briefing) nem
  // `trade-off-real` (não é decisão de produto/editorial); sem esta label a
  // issue reclassificaria `overnight` pra sempre e cada rodada futura
  // reconfirmaria o mesmo diagnóstico sem avançar (achado ao vivo #5968,
  // #5959: 2 rodadas em 23/08/2026 já reconfirmaram "sem ação" sem
  // progresso). Outra label que já classifica a issue (bloqueio, `windows`,
  // `trade-off-real`) sempre vence.
  //
  // `epic-guarda-chuva` SAIU deste Set em #6201 (item 8) — ganhou precedência
  // própria, mais alta, checada perto do topo de `classifyExecTrackWithRule`
  // (ver lá). Motivo: "é uma épica" é afirmação sobre a NATUREZA da issue,
  // não sobre um estado transitório como bloqueio/deferimento — antes,
  // ficar aqui fazia uma épica com bloqueio real (#461: `kit-migration` +
  // `beehiiv`) perder pra `bloqueada`, e a única forma de obter a leitura
  // "épica" era remover a label de bloqueio verdadeira (caso real: #463).
  "sem-direcao-acionavel",
]);

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
 * #5948 — bloqueio HUMANO/dependência sem data específica (o editor precisa
 * agir, mas não há `aguardando-ate:` porque não há data — ex: exportar algo
 * manualmente num painel, decidir e rodar um passo, revisar antes de seguir).
 * Regra do editor (23/08/2026): esse tipo de bloqueio nunca deveria ficar
 * classificado `overnight` (o cron nunca destrava sozinho) — rotea direto
 * pra `develop`, junto de `windows`/`trade-off-real`.
 *
 * Diferente de `BLOCKED_LABELS` (bloqueio que NENHUMA sessão destrava
 * sozinha — conta de terceiro, credencial, plataforma plan-gated): aqui o
 * bloqueio destrava com o editor presente numa sessão `/diaria-develop`, o
 * que é exatamente a definição de `develop`, não `bloqueada`.
 *
 * Diferente do marcador `aguardando-ate:` abaixo: essa label é pra quando
 * NÃO existe uma data específica — se a issue ganhar uma data depois, o
 * marcador é o mecanismo certo (rotea pra `agendada`, desarma sozinho); esta
 * label não desarma sozinha, precisa ser removida quando o bloqueio for
 * resolvido (mesmo padrão de `trade-off-real`, ver docstring do módulo).
 */
const DEVELOP_HUMAN_BLOCK_LABEL = "develop-track";

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
/** Exportado (#5724) pra `scripts/lib/wait-until-sync.ts` reusar a MESMA
 * definição ao inserir/atualizar/remover o marcador no corpo da issue via
 * `gh issue edit` — fonte única entre leitura (aqui) e escrita (lá), nunca
 * duas regexes que podem divergir. */
export const WAIT_UNTIL_RE = /^[ \t]*<!--\s*aguardando-ate:\s*(\d{4}-\d{2}-\d{2})\s*-->[ \t]*$/im;

export interface ExecTrackInput {
  /** Nomes de label da issue (já normalizados, sem o objeto do `gh`). */
  labels: string[];
  /** Corpo cru da issue — usado só pro marcador `aguardando-ate:`. */
  body?: string | null;
  /** Injetável pra teste; default `new Date()`. */
  now?: Date;
  /**
   * `state` cru de `gh issue list`/`gh issue view` — `"OPEN"` | `"CLOSED"`
   * (case-insensitive não garantido; comparação é exata contra `"CLOSED"`).
   * Ausente/omisso é tratado como "não sei" (não classifica CLOSED) — quem
   * já filtra por `--state open` antes de chamar este módulo pode omitir com
   * segurança (#5948: antes deste campo entrar na interface, um caller que
   * QUISESSE passar `state` não tinha como fazê-lo com segurança de tipo —
   * só um cast bypassava o TS, e é exatamente o motivo de
   * `scripts/studio-ui/studio-issues.ts` ter esquecido de propagá-lo).
   */
  state?: string | null;
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
 *   0. `fora-de-rodada` — (#5948) `state === "CLOSED"`. Issue fechada nunca
 *                         é candidata a nenhuma fila — checado ANTES de
 *                         qualquer label, porque nenhuma label sobrevive ao
 *                         fechamento. `state` é opcional em `ExecTrackInput`
 *                         (caller que já filtra por `--state open` pode
 *                         omitir); ausente/não-`"CLOSED"` não classifica
 *                         aqui, cai nas regras normais abaixo.
 *   1. `fora-de-rodada` — o editor tirou de circulação (`on-hold`/`wontfix`);
 *                         nada mais importa, nem "é uma épica" (passo 2).
 *   2. `epica`          — (#6201 item 8) `epic-guarda-chuva` — issue `[ÉPICA]`
 *                         nunca implementada direto, delegada às
 *                         issues-filhas. Checado ANTES de `bloqueada`/
 *                         `agendada`/deferimento de propósito: "é uma épica"
 *                         é afirmação sobre a NATUREZA da issue, então vence
 *                         sobre qualquer sinal de MOMENTO — uma épica com
 *                         bloqueio real coexistindo (`kit-migration`,
 *                         `beehiiv`, etc.) classifica `epica`, não
 *                         `bloqueada`, sem precisar remover a label de
 *                         bloqueio pra obter a leitura certa (caso real:
 *                         #461/#463).
 *   3. `bloqueada`      — bloqueio externo (nenhuma sessão destrava sozinha).
 *                         Exceção (#5694): `external-blocker` acompanhada de
 *                         `credencial-escopo` NÃO conta aqui — vira `develop`
 *                         no passo 6. Qualquer outra label de
 *                         `BLOCKED_LABELS` (`kit-migration`, `beehiiv`,
 *                         `bloqueio-execucao`) continua vencendo normalmente.
 *   4. `agendada`       — (#5682) marcador `aguardando-ate:` com data futura,
 *                         e nenhum bloqueio real acima já decidiu por ela.
 *                         Bloqueio real vence sobre data: a issue é
 *                         `bloqueada`, não `agendada`, se carregar as duas.
 *   5. `bloqueada`      — (2ª checagem) deferimento vago (`not-this-week`,
 *                         `next-month`) — checado DEPOIS de `agendada` de
 *                         propósito: quem escreveu uma data disse algo mais
 *                         específico que "not-this-week", então a data vence
 *                         sobre o deferimento vago quando as duas coexistem.
 *   6. `develop`        — precisa da máquina Windows, trade-off-real já
 *                         julgado pelo overnight, (#5694) `external-blocker`
 *                         + `credencial-escopo` (credencial já existe, só
 *                         falta escopo — cat. A do develop), ou (#5948)
 *                         `develop-track` (bloqueio humano/dependência SEM
 *                         data específica — se tivesse data, seria o
 *                         marcador `aguardando-ate:` do passo 4, não esta
 *                         label).
 *   7. `overnight`      — (#5553) alarme de EVENTO PASSADO (`alarm-evento`):
 *                         checado ANTES do passo 8 pra vencer a label `alarm`
 *                         companheira, que sozinha cairia em fora-de-rodada.
 *   8. `fora-de-rodada` — (2ª checagem, #5532) já resolvida em prosa
 *                         (`decisao-registrada`) ou alarme de ESTADO que se
 *                         auto-resolve (`alarm`, sem `alarm-evento`), ou
 *                         ambígua-sem-direção (`sem-direcao-acionavel` —
 *                         overnight já concluiu "sem ação de código clara",
 *                         3º desfecho distinto de
 *                         `precisa-resposta`/`trade-off-real`), e nenhuma
 *                         das labels acima já decidiu por ela — ver
 *                         docstring de `RESOLVED_BY_PROSE_LABELS` pro porquê
 *                         desta checagem vir depois de `bloqueada`/`develop`,
 *                         não junto da 1ª.
 *   9. `overnight`      — sobrou.
 *
 * `bloqueada` é retornada de dois pontos (passos 3 e 5) — preço de encaixar
 * `agendada` entre bloqueio-duro e deferimento-vago (#5682); os dois branches
 * seguem semanticamente distintos (bloqueio real vs. deferimento vago), só
 * compartilham o valor de saída.
 *
 * O default é `overnight` e não `develop` **apenas porque ambiguidade saiu do
 * classificador** (ver docstring do módulo). Todo bloqueio real tem label ou
 * marcador próprio; uma issue sem nenhum dos dois é, por construção, trabalho
 * que o overnight pega — inclusive a ambígua que ele ainda vai triar.
 */
export function classifyExecTrackWithRule(input: ExecTrackInput): ExecTrackResult {
  const { labels, body, now = new Date(), state } = input;
  if (state === "CLOSED") return { track: "fora-de-rodada", matched: "state:closed" };
  const has = (l: string) => labels.includes(l);

  const outOfRound = labels.find((l) => OUT_OF_ROUND_LABELS.has(l));
  if (outOfRound) return { track: "fora-de-rodada", matched: `label:${outOfRound}`  };

  // #6201 item 8 — "é uma épica" vence sobre qualquer bloqueio/deferimento
  // real. Checado logo após `OUT_OF_ROUND_LABELS` (que ainda vence — o
  // editor engavetando uma épica é mais forte que "é uma épica").
  if (has(EPIC_LABEL)) return { track: "epica", matched: `label:${EPIC_LABEL}` };

  // #5694 — `external-blocker` + `credencial-escopo` sai de `BLOCKED_LABELS`
  // (vira `develop` no passo 5 abaixo). Só essa combinação específica: outra
  // label de `BLOCKED_LABELS` presente na mesma issue continua bloqueando.
  const isCredentialScopeUnblock = has("external-blocker") && has(CREDENCIAL_ESCOPO_LABEL);

  const blockedLabel = labels.find(
    (l) => BLOCKED_LABELS.has(l) && !(l === "external-blocker" && isCredentialScopeUnblock),
  );
  if (blockedLabel) return { track: "bloqueada", matched: `label:${blockedLabel}`  };

  const waitUntil = parseWaitUntil(body);
  if (waitUntil && waitUntil.getTime() > now.getTime()) return { track: "agendada", matched: "marker:aguardando-ate" };

  const deferredLabel = labels.find((l) => DEFERRED_LABELS.has(l));
  if (deferredLabel) return { track: "bloqueada", matched: `label:${deferredLabel}`  };

  // Passo 5 — develop (máquina, trade-off, credencial-escopo, humano).
  const machineLabel = labels.find((l) => MACHINE_DEVELOP_LABELS.has(l));
  if (machineLabel) return { track: "develop", matched: `label:${machineLabel}`  };
  if (has(TRADE_OFF_LABEL)) return { track: "develop", matched: "label:trade-off-real" };
  if (isCredentialScopeUnblock) return { track: "develop", matched: "label:credencial-escopo" };
  if (has(DEVELOP_HUMAN_BLOCK_LABEL)) return { track: "develop", matched: "label:develop-track" };

  if (has(ALARM_EVENT_LABEL)) return { track: "overnight", matched: "label:alarm-evento" };

  const proseLabel = labels.find((l) => RESOLVED_BY_PROSE_LABELS.has(l));
  if (proseLabel) return { track: "fora-de-rodada", matched: `label:${proseLabel}`  };

  return { track: "overnight", matched: "default" };
}

/** Assinatura original preservada (#6200) — devolve só o `track`. Callers
 * antigos (`studio-issues.ts`, `state-changed-tracker.ts`, testes) continuam
 * funcionando sem mudança; quem precisa do detalhe da regra migra pra
 * `classifyExecTrackWithRule`. */
export function classifyExecTrack(input: ExecTrackInput): ExecTrack {
  return classifyExecTrackWithRule(input).track;
}

/** Rótulo curto pra UI (badge/dropdown). Separado do tipo pra manter o valor
 * serializado estável mesmo se o texto visível mudar.
 *
 * `Record<ExecTrack, string>` não é decoração: se um novo valor entrar no
 * union sem entrar aqui, o build quebra — foi exatamente essa garantia que
 * forçou `epica` (#6201) a entrar nas três tabelas desta seção junto com o
 * tipo. Essa garantia só vale, porém, se quem RENDERIZA consumir esta
 * tabela — ver `EXEC_TRACK_UI` abaixo. */
export const EXEC_TRACK_LABELS: Record<ExecTrack, string> = {
  overnight: "Overnight",
  develop: "Develop",
  agendada: "Agendada",
  bloqueada: "Bloqueada",
  epica: "Épica",
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
    "Develop — precisa do editor presente: exige a máquina Windows (label `windows`), é trade-off real de produto/editorial já julgado pelo overnight (label `trade-off-real`, cat. C), (#5694) é `external-blocker` com escopo de credencial já identificado (label `credencial-escopo` — credencial existente, só falta permission, cat. A), ou (#5948) é bloqueio humano/dependência sem data específica (label `develop-track` — se tivesse data, seria `aguardando-ate:` e viraria Agendada).",
  agendada:
    "Agendada — tem data específica pra ser resolvida, registrada no marcador `aguardando-ate: AAAA-MM-DD`. Não está bloqueada por nada: é trabalho fazível que volta sozinho ao fluxo normal na data, sem ninguém precisar remover label. Adiamento sem data (`not-this-week`, `next-month`, `on-hold`) não é Agendada.",
  bloqueada:
    "Bloqueada — nenhuma sessão destrava sozinha: conta de terceiro, credencial, plataforma plan-gated, ou deferimento vago sem data (`not-this-week`, `next-month`). Marcador `aguardando-ate:` com data futura é Agendada, não Bloqueada — a menos que um bloqueio real coexista. Exceção (#5694): `external-blocker` + `credencial-escopo` (credencial já existe, só falta escopo) não é Bloqueada — vira Develop.",
  epica:
    "Épica — issue `[ÉPICA]` guarda-chuva (label `epic-guarda-chuva`, #5968), nunca implementada direto: fecha só quando as issues-filhas mergearem. Vence sobre bloqueio/deferimento real (#6201) — uma épica com `kit-migration`/`beehiiv`/etc. coexistindo continua Épica, não Bloqueada, exceto se o editor já tirou a issue de circulação (`on-hold`/`wontfix`, que vence até Épica).",
  "fora-de-rodada":
    "Fora de rodada — quatro motivos distintos, nenhum com código pendente: o editor tirou de circulação (`on-hold`, `wontfix` — não é 'ainda não', é 'não'); já foi resolvida por registro de decisão em prosa (`decisao-registrada`, só quando nenhuma outra label já classificar a issue de outro jeito — uma decisão parcial numa issue que segue sendo trabalho real, ex: trade-off-real, não entra aqui); é alarme de ESTADO que se auto-resolve (`alarm` sem `alarm-evento`, comenta/fecha sozinho quando o achado para de reproduzir — #5553: alarme de EVENTO PASSADO, `alarm-evento`, vai pro Overnight em vez de aqui); ou é ambígua-sem-direção (`sem-direcao-acionavel` — o overnight já concluiu explicitamente 'sem ação de código clara a tomar', diferente de `precisa-resposta`/`trade-off-real`). EPIC guarda-chuva SAIU daqui em #6201 — ver Épica.",
};

/** Forma do badge por valor, na ordem de LEITURA da legenda: do que anda
 * sozinho hoje à noite até o que não anda de jeito nenhum — `agendada` entra
 * entre `develop` e `bloqueada` (#5682): anda sozinha *depois*, na data; não
 * anda de jeito nenhum é exclusividade de `bloqueada`. `epica` (#6201) entra
 * por último, antes de `fora-de-rodada` — não "anda" no sentido de uma
 * sessão pegá-la direto (é delegada às filhas), mas também não é "o editor
 * tirou de circulação", então fica adjacente aos dois sem se confundir com
 * nenhum. Não é o inverso estrito da ordem de precedência do classificador
 * (que checa `epica` logo no topo, antes de `bloqueada`) — de propósito: a
 * legenda responde "o que eu consigo tocar, e quando?", não "em que ordem o
 * código testa?".
 *
 * É isto que `GET /api/issues` serve em `meta.execTrack`, e que o front
 * renderiza. O front NÃO redeclara os valores: fazia isso antes e criava
 * exatamente a 2ª fonte de verdade que este módulo existe pra eliminar —
 * um valor novo quebraria o build no servidor e passaria silenciosamente no
 * cliente, caindo no fallback sem tradução nem tooltip (#5462, review). */
export const EXEC_TRACK_UI: Array<{ track: ExecTrack; label: string; explain: string }> = (
  ["overnight", "develop", "agendada", "bloqueada", "epica", "fora-de-rodada"] as const
).map((track) => ({ track, label: EXEC_TRACK_LABELS[track], explain: EXEC_TRACK_EXPLAIN[track] }));
