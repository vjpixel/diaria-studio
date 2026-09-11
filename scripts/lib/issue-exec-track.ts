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
 * A tentação óbvia é classificar "issue ambígua" como `develop` — cat. C era
 * escopo exclusivo do develop (#2640). Mas o overnight tem **duas**
 * ambiguidades DE TRIAGEM (não uma), e a linha entre elas é julgamento puro
 * (overnight/SKILL.md, Fase 0 passo 4):
 *
 *   - trivial-mas-não-documentada ("formato A ou B de log", "opção técnica
 *     equivalente") → `precisa-resposta` → o editor destrava no **briefing**
 *     da Fase 0, antes de sair. É trabalho de overnight.
 *   - trade-off-real de produto/editorial ("design system vs documentar") →
 *     **desde #7493, também `precisa-resposta`**: vai ao MESMO briefing, em
 *     vez do bounce pro develop cat. C que valia até 05/09/2026. Ver a
 *     docstring de `TRADE_OFF_LABEL` pro racional da reversão.
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
 * `overnight` — o que é a verdade: o overnight ainda vai olhar pra ela. E,
 * desde #7493, ela **continua** `overnight` mesmo depois de julgada como
 * trade-off real: a label `trade-off-real` deixou de rotear pro develop e
 * virou o sinal POSITIVO de "já triada, entra na fila de perguntas do
 * briefing" (`matched: "label:trade-off-real"` com `track: "overnight"`, em
 * vez do `default` de quem ninguém olhou). Mesmo padrão de
 * `issue-decisions.ts` (#5373): o julgamento é feito UMA vez por quem tem
 * contexto pra fazê-lo, gravado de forma durável, e lido depois — nunca
 * re-derivado por heurística.
 *
 * Corolário: quem resolve a ambiguidade (o briefing do overnight, ou uma
 * sessão `/diaria-develop`/`/diaria-desbloqueia` que a pegue antes) posta a
 * decisão como comentário durável e **remove a label** — é o que fecha o
 * ciclo. Sem essa remoção a issue volta ao briefing seguinte com uma
 * pergunta já respondida, e o gate de `trade-off-label-gate.ts` (#5821)
 * existe exatamente pra pegar esse esquecimento. O que MUDOU no #7493 é
 * onde a pergunta é feita, não a disciplina de apagar o rótulo depois.
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
 * Única exceção: a whitelist AAARRR (`aarrr-whitelist.json`, relida quando
 * o mtime muda) quando o caller não injeta `aarrrWhitelist`.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md § Fase 0 passo 4
 * @see .claude/skills/diaria-develop/SKILL.md § Fronteira com o overnight nas ambíguas
 * @see scripts/lib/issue-decisions.ts (mesmo padrão de julgamento gravado)
 */

import { isBlockedByAarrrWhitelist, loadAarrrWhitelist } from "./aarrr-whitelist.ts";

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
 * - `label:dependencia-aberta` — idem (#7137 — marcador `depends-on:` com dependência ainda não fechada)
 * - `marker:aguardando-ate` — marcador futuro → `agendada`
 * - `label:not-this-week`   — 2ª checagem `bloqueada` (deferimento vago)
 * - `label:next-month`      — idem
 * - `label:windows`         — → `develop`
 * - `label:trade-off-real`  — → `overnight` (#7493 — era `develop` até 05/09/2026)
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
  | "label:dependencia-aberta"
  | "label:aarrr-fora-da-whitelist"
  | "marker:aguardando-ate"
  | "label:not-this-week"
  | "label:next-month"
  | "label:windows"
  | "label:trade-off-real"
  | "label:credencial-escopo"
  | "label:develop-track"
  | "label:alarm-evento"
  | "label:alarm-acao"
  | "label:decisao-registrada"
  | "label:alarm"
  | "label:epic-guarda-chuva"
  | "label:sem-direcao-acionavel"
  | "label:triada-overnight"
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
  "label:dependencia-aberta",
  "label:aarrr-fora-da-whitelist",
  "marker:aguardando-ate",
  "label:not-this-week",
  "label:next-month",
  "label:windows",
  "label:trade-off-real",
  "label:credencial-escopo",
  "label:develop-track",
  "label:alarm-evento",
  "label:alarm-acao",
  "label:decisao-registrada",
  "label:alarm",
  "label:epic-guarda-chuva",
  "label:sem-direcao-acionavel",
  "label:triada-overnight",
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
  /** Data já formatada (`DD/MM`/`DD/MM/AAAA`, ver `formatWaitUntilLabel`) do
   * marcador `aguardando-ate:` — só populado quando `matched ===
   * "marker:aguardando-ate"`; `undefined` em todo outro caso (#7868). Vive
   * aqui, e não só em `EXEC_TRACK_MATCH_REASON`, porque a data é dado da
   * ISSUE (varia por chamada), enquanto a entrada do Record é texto FIXO do
   * catálogo — a frase carrega o template `{date}`, este campo carrega o
   * valor que a preenche. */
  waitUntilLabel?: string;
}

/** Fora de qualquer rodada: o editor tirou de circulação, não é "ainda não". */
const OUT_OF_ROUND_LABELS = new Set(["on-hold", "wontfix"]);

/**
 * #7708 — o subconjunto de `fora-de-rodada` que é retirada DELIBERADA de
 * circulação pelo editor, e não "resolvida por outro mecanismo".
 *
 * `/diaria-desbloqueia` passou a varrer `fora-de-rodada` atrás de ações que
 * o editor pode executar na hora, mas estas duas ficam de fora por default:
 * `on-hold`/`wontfix` significam "não é 'ainda não', é 'não'", e perguntar
 * toda rodada sobre uma issue que o editor engavetou de propósito é a
 * fricção que "Perguntar é exceção" (#5321) existe pra eliminar. As demais
 * labels de `fora-de-rodada` (`alarm`, `decisao-registrada`,
 * `sem-direcao-acionavel`) não têm essa semântica — chegaram ali por um
 * mecanismo automático, não por um veredito de "não fazer".
 *
 * É exatamente `OUT_OF_ROUND_LABELS`, exportado sob um nome que diz o
 * CRITÉRIO (engavetada pelo editor) em vez da consequência (fora de rodada)
 * — os dois Sets seriam idênticos hoje, mas respondem a perguntas
 * diferentes, e uma label futura de `fora-de-rodada` automática entraria só
 * num deles.
 *
 * CÓPIA, não a mesma referência (achado do type-design-analyzer no review da
 * PR #7711): `ReadonlySet` é promessa de tipo, não de runtime. Atribuir o
 * mesmo objeto faria um `.add()` em `OUT_OF_ROUND_LABELS` — plausível, já que
 * a docstring acima convida a ampliar um conceito sem o outro — alterar
 * silenciosamente o comportamento de `--incluir-engavetadas` no
 * `desbloqueia-scan`. Uma linha fecha a classe de bug.
 */
export const ENGAVETADAS_LABELS: ReadonlySet<string> = new Set(OUT_OF_ROUND_LABELS);

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

/** #7945 — `bug` ignora o veto da whitelist AAARRR (ver `isBlockedByAarrrWhitelist`
 * no passo 2b): a whitelist prioriza ONDE investir esforço de crescimento
 * novo, não decide se uma regressão do que já existe é consertada. */
const BUG_LABEL = "bug";

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

/**
 * #6772 — 3ª família de alarme, distinta de `alarm` (ESTADO que normaliza
 * SOZINHO) e `alarm-evento` (EVENTO PASSADO, precisa de revisão humana mas
 * não tem remediador de código): alarme de família ESTADO cuja condição só
 * normaliza por AÇÃO — alguém (ou uma rodada) rodar um comando/script que
 * muda o estado observado (ex: armar o timer que falta, desarmar o timer
 * órfão). Sem esta label, `[alarm]` puro cai em `fora-de-rodada` (2ª
 * checagem, `RESOLVED_BY_PROSE_LABELS`) sob a premissa de que TODO alarme de
 * ESTADO se auto-resolve — premissa falsa pra este subconjunto: nenhuma
 * rodada o pega, e o auto-close nunca dispara porque nada muda o estado
 * sozinho (achado ao vivo #6772: `[diar.ia.br] task nunca armada: *`
 * #6652-6658/#6729 e `timer órfão sem task no registro` #6658/#6730 ficavam
 * presos indefinidamente).
 *
 * Roteia pra `overnight` (não `develop`) porque a remediação típica —
 * `setup-systemd-timers.ts`/`arm-systemd-timers.ts` no servidor — é
 * exatamente o tipo de ação mecânica que uma rodada desassistida no `300`
 * já executa sem precisar do editor presente; não é cat. A-E do develop.
 *
 * Aplicada pelo emissor JUNTO de `alarm` (`family: "estado"` sempre adiciona
 * `ALARM_LABEL`, ver `scripts/lib/alarm-issues.ts`) — mesmo padrão de
 * `alarm-evento`, checada ANTES de `RESOLVED_BY_PROSE_LABELS` pra vencer a
 * label `alarm` companheira. Hoje só emitida por
 * `toNeverArmedFinding`/`toOrphanTimerFinding` (`scripts/task-never-armed-alarm.ts`)
 * — a 2ª família apontada pelo #6772 (issues de "cópia de conflito do
 * OneDrive presente") é sintoma separado, fora do escopo desta label.
 */
const ALARM_ACTION_LABEL = "alarm-acao";

/**
 * #7137 — dependência declarada de OUTRA issue ainda não fechada
 * (`<!-- depends-on: #N -->` no corpo, ver `scripts/lib/issue-depends-on.ts`).
 * Diferente das demais labels de `BLOCKED_LABELS`: esta é gerida por SCRIPT
 * (`scripts/reconcile-issue-dependencies.ts`), não por ação manual do
 * editor — auto-desarma quando a dependência fecha, mesma família do
 * marcador `aguardando-ate:` (que desarma pela data). `classifyExecTrack`
 * continua puro: só aprende a label, nunca consulta o GitHub pra saber se a
 * dependência já fechou — quem consulta e aplica/remove é o reconciliador.
 *
 * Label DEDICADA, não reuso de `bloqueio-execucao` — decisão documentada em
 * `issue-depends-on.ts` (`bloqueio-execucao` é aplicada manualmente por
 * motivos variados, sem campo que diga qual; reusá-la deixaria o
 * reconciliador removendo um bloqueio que pode não ter nada a ver com a
 * dependência declarada).
 */
export const DEPENDS_ON_BLOCK_LABEL = "dependencia-aberta";

/** Bloqueio que nenhuma sessão destrava sozinha — conta de terceiro,
 * credencial, allowlist, plataforma plan-gated, bloqueio de execução já
 * registrado (#5373), ou dependência de outra issue ainda aberta (#7137). */
const BLOCKED_LABELS = new Set([
  "external-blocker",
  "kit-migration",
  "beehiiv",
  "bloqueio-execucao",
  DEPENDS_ON_BLOCK_LABEL,
]);

/** Export somente-leitura de `BLOCKED_LABELS` (#6754) — fonte única de "quais
 * labels significam bloqueio real" pra consumidores fora deste módulo
 * (`scripts/lib/block-staleness.ts`). Reexportar em vez de duplicar a lista
 * evita a classe de bug do #6754: o checker de bloqueio caducado só conhecia
 * `bloqueio-execucao`, então uma issue bloqueada por `kit-migration` (label
 * de bloqueio distinta, sem `bloqueio-execucao` presente) era relatada como
 * "bloqueio caducou" — falso positivo. */
export const BLOCKED_LABELS_SET: ReadonlySet<string> = BLOCKED_LABELS;

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

/**
 * Julgamento já gravado pelo overnight: a ambiguidade desta issue é
 * trade-off real de produto/editorial, não escolha técnica trivial.
 *
 * **Rotea pra `overnight`, não pra `develop` (#7493, decisão do editor
 * 05/09/2026 — reverte #2640/#5462).** Até aqui a label mandava a issue pro
 * develop cat. C, e o overnight a bounceava sem perguntar nada. Medido nas 20
 * rodadas de 260828→260905: **zero** issues classificadas `precisa-resposta`
 * em todas elas — como a aprovação de agrupamento e o opt-in de loop estendido
 * pegam carona na mesma `AskUserQuestion` das `precisa-resposta`, o briefing
 * inteiro parou de perguntar (a rodada 260905 gravou `batch_approval:
 * "default_proposed"`, o caminho de fallback). A ambiguidade não virava
 * pergunta, virava roteamento — e o roteamento custa uma sessão inteira com o
 * editor presente, contra 1 pergunta numa janela em que ele já está presente
 * por definição.
 *
 * A label continua existindo e sendo aplicada: virou o sinal POSITIVO de "já
 * triada como trade-off real, entra na fila de perguntas do briefing" — é o
 * que distingue um `overnight` verificado de um `overnight` por omissão
 * (`matched: "default"`, ninguém olhou). Ela é REMOVIDA quando a decisão é
 * registrada, por quem quer que a registre (briefing do overnight,
 * `/diaria-develop`, `/diaria-desbloqueia`) — ver `trade-off-label-gate.ts`.
 *
 * Precedência: perde pra bloqueio real, data futura, deferimento vago,
 * `windows` e `develop-track` (todos checados antes) — uma issue que também
 * exige a máquina do editor ou tem bloqueio humano continua `develop`. Vence
 * `RESOLVED_BY_PROSE_LABELS`, preservando o caso real #4555
 * (`decisao-registrada` + `trade-off-real`: a decisão fechou só parte da
 * issue, ainda há pergunta a fazer).
 */
const TRADE_OFF_LABEL = "trade-off-real";

/**
 * #7694 — "já triei esta issue: nada a desbloquear, é overnight mesmo".
 *
 * Existe por causa do badge `·sem sinal` do painel Triagem
 * (`dispatchBadge`, `scripts/studio-ui/public/triagem.js`), que marca toda
 * issue cuja classificação caiu no `matched: "default"` — nenhum sinal
 * positivo decidiu nada, **ninguém verificou**. Antes desta label não havia
 * como registrar o veredito oposto: uma issue conferida e confirmada como
 * overnight ficava indistinguível de uma que nunca foi lida, e era retriada
 * do zero a cada varredura (mesma classe de desperdício que
 * `issue-decisions.ts`/#5373 evita pra decisão do editor, aqui aplicada ao
 * ato de TRIAR).
 *
 * Não muda veredito nenhum — o track continua `overnight`, exatamente como
 * seria sem ela. O que muda é só `matched`, que passa de `"default"` pra
 * `"label:triada-overnight"`, e o badge deixa de dizer `·sem sinal`.
 *
 * Precedência: é a ÚLTIMA regra antes do `default`, de propósito. Toda outra
 * label (bloqueio, deferimento, máquina, trade-off, prosa) vence — a label
 * só confirma o caminho que a issue já ia tomar por omissão, nunca sobrepõe
 * um sinal real. Consequência: `triada-overnight` + `on-hold` continua
 * `fora-de-rodada`, `triada-overnight` + `windows` continua `develop`, etc.
 *
 * Diferente de `TRADE_OFF_LABEL` (#7493), que também mantém `overnight` mas
 * significa "triada E tem pergunta pro briefing": esta significa "triada e
 * NÃO tem pergunta". As duas juntas não fazem sentido; `trade-off-real`
 * vence por ser checada antes (o sinal mais informativo).
 */
export const TRIAGED_OVERNIGHT_LABEL = "triada-overnight";

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
  /** Etapas AAARRR liberadas. Injetável pra teste; default = `aarrr-whitelist.json`. */
  aarrrWhitelist?: ReadonlySet<string>;
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
 * Formata a data do marcador `aguardando-ate:` pro badge "Motivo" da Triagem
 * (#7868) — `DD/MM`, ou `DD/MM/AAAA` quando o ano da data difere do ano de
 * `now` (marcador cruza o ano — sem o ano, "05/01" perto da virada do ano
 * fica ambíguo entre "já passou" e "ainda vem"). Usa os componentes UTC
 * porque `parseWaitUntil` sempre constrói a data como `T00:00:00Z` — misturar
 * `getDate()`/`getUTCDate()` aqui reintroduziria o mesmo tipo de deslize de
 * fuso que motivou `TZ no Git Bash devolve UTC` em outro contexto.
 */
export function formatWaitUntilLabel(date: Date, now: Date = new Date()): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  return yyyy === now.getUTCFullYear() ? `${dd}/${mm}` : `${dd}/${mm}/${yyyy}`;
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
 *  2b. `bloqueada`      — a issue tem label `aarrr:*` e nenhuma das suas
 *                         etapas está em `aarrr-whitelist.json` (priorização
 *                         por funil, decisão do editor 10/09/2026). Vence
 *                         sobre develop/overnight: nenhuma sessão resolve
 *                         etapa não liberada. Issue sem `aarrr:*` passa reto.
 *                         Exceção (#7945): issue com label `bug` NUNCA cai
 *                         aqui — a whitelist prioriza esforço de crescimento
 *                         novo, não decide se uma regressão é consertada.
 *   3. `bloqueada`      — bloqueio externo (nenhuma sessão destrava sozinha).
 *                         Exceção (#5694): `external-blocker` acompanhada de
 *                         `credencial-escopo` NÃO conta aqui — vira `develop`
 *                         no passo 6. Qualquer outra label de
 *                         `BLOCKED_LABELS` (`kit-migration`, `beehiiv`,
 *                         `bloqueio-execucao`, `dependencia-aberta` — #7137,
 *                         dependência de outra issue ainda aberta) continua
 *                         vencendo normalmente.
 *   4. `agendada`       — (#5682) marcador `aguardando-ate:` com data futura,
 *                         e nenhum bloqueio real acima já decidiu por ela.
 *                         Bloqueio real vence sobre data: a issue é
 *                         `bloqueada`, não `agendada`, se carregar as duas.
 *   5. `bloqueada`      — (2ª checagem) deferimento vago (`not-this-week`,
 *                         `next-month`) — checado DEPOIS de `agendada` de
 *                         propósito: quem escreveu uma data disse algo mais
 *                         específico que "not-this-week", então a data vence
 *                         sobre o deferimento vago quando as duas coexistem.
 *   6. `develop`        — precisa da máquina Windows, (#5694)
 *                         `external-blocker` + `credencial-escopo`
 *                         (credencial já existe, só falta escopo — cat. A do
 *                         develop), ou (#5948) `develop-track` (bloqueio
 *                         humano/dependência SEM data específica — se tivesse
 *                         data, seria o marcador `aguardando-ate:` do passo
 *                         4, não esta label). **`trade-off-real` SAIU deste
 *                         passo no #7493** — desceu pro passo 7, ver lá.
 *   7. `overnight`      — (#7493) `trade-off-real` — ambiguidade já julgada
 *                         como trade-off real de produto/editorial, que volta
 *                         a ser pergunta do briefing da Fase 0 em vez de
 *                         bounce pro develop; checado depois do passo 6
 *                         (máquina/credencial/bloqueio humano vencem) e antes
 *                         do passo 8 (preserva #4555). Também (#5553) alarme
 *                         de EVENTO PASSADO (`alarm-evento`),
 *                         ou (#6772) alarme de ESTADO cuja condição só
 *                         normaliza por AÇÃO (`alarm-acao`): checado ANTES do
 *                         passo 8 pra vencer a label `alarm` companheira, que
 *                         sozinha cairia em fora-de-rodada.
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

  if (!has(BUG_LABEL) && isBlockedByAarrrWhitelist(labels, input.aarrrWhitelist ?? loadAarrrWhitelist())) {
    return { track: "bloqueada", matched: "label:aarrr-fora-da-whitelist" };
  }

  // #5694 — `external-blocker` + `credencial-escopo` sai de `BLOCKED_LABELS`
  // (vira `develop` no passo 5 abaixo). Só essa combinação específica: outra
  // label de `BLOCKED_LABELS` presente na mesma issue continua bloqueando.
  const isCredentialScopeUnblock = has("external-blocker") && has(CREDENCIAL_ESCOPO_LABEL);

  const blockedLabel = labels.find(
    (l) => BLOCKED_LABELS.has(l) && !(l === "external-blocker" && isCredentialScopeUnblock),
  );
  if (blockedLabel) return { track: "bloqueada", matched: `label:${blockedLabel}`  };

  const waitUntil = parseWaitUntil(body);
  if (waitUntil && waitUntil.getTime() > now.getTime()) {
    return { track: "agendada", matched: "marker:aguardando-ate", waitUntilLabel: formatWaitUntilLabel(waitUntil, now) };
  }

  const deferredLabel = labels.find((l) => DEFERRED_LABELS.has(l));
  if (deferredLabel) return { track: "bloqueada", matched: `label:${deferredLabel}`  };

  // Passo 5 — develop (máquina, credencial-escopo, humano). `trade-off` saiu
  // deste bloco no #7493 — ver o branch logo abaixo.
  const machineLabel = labels.find((l) => MACHINE_DEVELOP_LABELS.has(l));
  if (machineLabel) return { track: "develop", matched: `label:${machineLabel}`  };
  if (isCredentialScopeUnblock) return { track: "develop", matched: "label:credencial-escopo" };
  if (has(DEVELOP_HUMAN_BLOCK_LABEL)) return { track: "develop", matched: "label:develop-track" };

  // #7493 — trade-off real volta a ser pergunta de briefing do overnight (era
  // `develop` até 05/09/2026). Checado DEPOIS das 3 regras de develop acima
  // (máquina/credencial/bloqueio humano continuam vencendo: nenhuma pergunta
  // de briefing destrava um Chrome logado) e ANTES de
  // `RESOLVED_BY_PROSE_LABELS`, preservando o caso #4555.
  if (has(TRADE_OFF_LABEL)) return { track: "overnight", matched: "label:trade-off-real" };
  if (has(ALARM_EVENT_LABEL)) return { track: "overnight", matched: "label:alarm-evento" };
  if (has(ALARM_ACTION_LABEL)) return { track: "overnight", matched: "label:alarm-acao" };

  const proseLabel = labels.find((l) => RESOLVED_BY_PROSE_LABELS.has(l));
  if (proseLabel) return { track: "fora-de-rodada", matched: `label:${proseLabel}`  };

  // #7694 — última regra antes do default, de propósito: `triada-overnight`
  // só CONFIRMA o caminho que a issue já ia tomar por omissão (ver docstring
  // de `TRIAGED_OVERNIGHT_LABEL`). O track é o mesmo; o que muda é `matched`,
  // que deixa de ser `"default"` — e com isso o badge do painel deixa de
  // dizer `·sem sinal` pra uma issue que alguém de fato conferiu.
  if (has(TRIAGED_OVERNIGHT_LABEL)) return { track: "overnight", matched: "label:triada-overnight" };

  return { track: "overnight", matched: "default" };
}

/** Assinatura original preservada (#6200) — devolve só o `track`. Callers
 * antigos (`studio-issues.ts`, `state-changed-tracker.ts`, testes) continuam
 * funcionando sem mudança; quem precisa do detalhe da regra migra pra
 * `classifyExecTrackWithRule`. */
export function classifyExecTrack(input: ExecTrackInput): ExecTrack {
  return classifyExecTrackWithRule(input).track;
}

/**
 * Shape cru de um item de `gh issue list --json ...` — labels tanto como
 * array de string quanto array de `{ name }` (o `gh` devolve o 2º; testes e
 * fixtures às vezes já normalizam pro 1º), e QUALQUER outro campo que o
 * `--json` tenha incluído (title, url, updatedAt, ...) — ignorados aqui,
 * preservados no objeto de entrada pro caller que quiser.
 */
export interface GhIssueListRawItem {
  number?: unknown;
  labels?: Array<string | { name?: string } | null | undefined> | null;
  body?: unknown;
  state?: unknown;
  [key: string]: unknown;
}

/** Exportado (#7018) — `scripts/lib/issue-triage-fetch.ts` reusa exatamente
 * esta normalização em vez de duplicá-la. */
export function normalizeGhIssueListLabels(raw: GhIssueListRawItem["labels"]): string[] {
  return (raw ?? [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * #7018 — entrada FAIL-CLOSED pra classificar um item cru de `gh issue list`,
 * em vez de montar `ExecTrackInput` à mão (o caminho que permitiu o bug
 * original). `classifyExecTrack`/`classifyExecTrackWithRule` continuam
 * aceitando `body` ausente/`undefined` sem reclamar — mudar isso quebraria
 * todo caller de produção e teste que passa `body: ""` deliberadamente para
 * dizer "sem marcador" (ambíguo, à propósito, com "não sei se tem corpo").
 * A ambiguidade real só existe no ponto de ENTRADA de uma varredura de `gh
 * issue list`: ali, "a chave `body` não veio no objeto" é sempre um bug de
 * comando (`--json` sem `body` no campo) — nunca uma issue com corpo vazio
 * de propósito (`gh` sempre devolve `body: null`/`""`, nunca omite a
 * chave, quando o campo É pedido).
 *
 * Por isso a checagem é sobre a CHAVE (`"body" in raw`), não sobre o VALOR:
 * `{ body: null }` e `{ body: "" }` passam normalmente (corpo vazio de
 * verdade); só a ausência total da chave lança.
 *
 * Lança `Error` (fail-closed) em vez de degradar pro track mais permissivo
 * (`overnight`) — que é exatamente a regressão silenciosa do #7018: 4
 * issues `agendada` (marcador `aguardando-ate:` no corpo) foram dispatchadas
 * como `overnight` porque a varredura da rodada rodou sem `body`, sem
 * nenhum sinal de erro.
 */
export function classifyExecTrackFromListItem(
  raw: GhIssueListRawItem,
  opts?: { now?: Date },
): ExecTrack {
  if (!("body" in raw)) {
    throw new Error(
      `classifyExecTrackFromListItem: item${
        typeof raw.number === "number" ? ` #${raw.number}` : ""
      } sem a chave "body" — 'gh issue list --json ...' precisa incluir 'body' na lista de campos. ` +
        "Sem ela, o marcador 'aguardando-ate:' fica invisível e uma issue Agendada degrada silenciosamente " +
        "para Overnight, o track mais permissivo (#7018). Use scripts/lib/issue-triage-fetch.ts " +
        "(fetchOpenIssuesForTriage) em vez de montar o comando 'gh issue list' à mão.",
    );
  }
  return classifyExecTrack({
    labels: normalizeGhIssueListLabels(raw.labels),
    body: (raw.body ?? null) as string | null,
    state: (raw.state ?? null) as string | null,
    now: opts?.now,
  });
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
    "Overnight — nenhum bloqueio, nenhuma dependência de máquina. Inclui a issue ambígua ainda não triada (quem separa ambiguidade trivial de trade-off real é o próprio overnight, na Fase 0), o alarme sobre EVENTO PASSADO (label `alarm-evento`, #5553 — achado ancorado a um ID imutável que nunca se auto-resolve, precisa de revisão), e o alarme de ESTADO que só normaliza por AÇÃO (label `alarm-acao`, #6772 — ex: timer nunca armado/órfão, remediado rodando um script, não sozinho).",
  develop:
    "Develop — precisa do editor presente: exige a máquina Windows (label `windows`), é trade-off real de produto/editorial já julgado pelo overnight (label `trade-off-real`, cat. C), (#5694) é `external-blocker` com escopo de credencial já identificado (label `credencial-escopo` — credencial existente, só falta permission, cat. A), ou (#5948) é bloqueio humano/dependência sem data específica (label `develop-track` — se tivesse data, seria `aguardando-ate:` e viraria Agendada).",
  agendada:
    "Agendada — tem data específica pra ser resolvida, registrada no marcador `aguardando-ate: AAAA-MM-DD`. Não está bloqueada por nada: é trabalho fazível que volta sozinho ao fluxo normal na data, sem ninguém precisar remover label. Adiamento sem data (`not-this-week`, `next-month`, `on-hold`) não é Agendada.",
  bloqueada:
    "Bloqueada — nenhuma sessão destrava sozinha: etapa do funil (`aarrr:*`) fora de `aarrr-whitelist.json`, conta de terceiro, credencial, plataforma plan-gated, deferimento vago sem data (`not-this-week`, `next-month`), ou dependência de outra issue ainda aberta (label `dependencia-aberta`, #7137 — aplicada/removida por script a partir do marcador `depends-on: #N`, desarma sozinha quando a dependência fecha). Marcador `aguardando-ate:` com data futura é Agendada, não Bloqueada — a menos que um bloqueio real coexista. Exceção (#5694): `external-blocker` + `credencial-escopo` (credencial já existe, só falta escopo) não é Bloqueada — vira Develop.",
  epica:
    "Épica — issue `[ÉPICA]` guarda-chuva (label `epic-guarda-chuva`, #5968), nunca implementada direto: fecha só quando as issues-filhas mergearem. Vence sobre bloqueio/deferimento real (#6201) — uma épica com `kit-migration`/`beehiiv`/etc. coexistindo continua Épica, não Bloqueada, exceto se o editor já tirou a issue de circulação (`on-hold`/`wontfix`, que vence até Épica).",
  "fora-de-rodada":
    "Fora de rodada — quatro motivos distintos, nenhum com código pendente: o editor tirou de circulação (`on-hold`, `wontfix` — não é 'ainda não', é 'não'); já foi resolvida por registro de decisão em prosa (`decisao-registrada`, só quando nenhuma outra label já classificar a issue de outro jeito — uma decisão parcial numa issue que segue sendo trabalho real, ex: trade-off-real, não entra aqui); é alarme de ESTADO que se auto-resolve (`alarm` sem `alarm-evento`, comenta/fecha sozinho quando o achado para de reproduzir — #5553: alarme de EVENTO PASSADO, `alarm-evento`, vai pro Overnight em vez de aqui); ou é ambígua-sem-direção (`sem-direcao-acionavel` — o overnight já concluiu explicitamente 'sem ação de código clara a tomar', diferente de `precisa-resposta`/`trade-off-real`). EPIC guarda-chuva SAIU daqui em #6201 — ver Épica.",
};

/**
 * A issue neste track pode ser trabalhada por ALGUMA sessão hoje? (#7644)
 *
 * `overnight` = o 300 pega sozinho; `develop` = uma sessão com o editor
 * presente pega. Os outros quatro não têm sessão que os pegue no estado
 * atual — cada um por um motivo diferente, que é o que
 * `EXEC_TRACK_MATCH_REASON` abaixo nomeia.
 *
 * `agendada` conta como NÃO-acionável de propósito, apesar de ser "trabalho
 * fazível que volta sozinho na data": hoje ninguém a pega, e a coluna Motivo
 * responde "por que isto não anda AGORA". A data é justamente o motivo, e
 * aparece como tal.
 *
 * `Record<ExecTrack, boolean>` e não um `Set` de literais: um valor novo na
 * união quebra o build até alguém decidir de que lado ele cai — a mesma
 * garantia de `EXEC_TRACK_LABELS`/`EXEC_TRACK_EXPLAIN`. Um `Set` aceitaria o
 * valor novo em silêncio, tratando-o como acionável por omissão.
 */
export const EXEC_TRACK_ACTIONABLE: Record<ExecTrack, boolean> = {
  overnight: true,
  develop: true,
  agendada: false,
  bloqueada: false,
  epica: false,
  "fora-de-rodada": false,
};

/**
 * Motivo POR REGRA — a frase que responde "por que esta issue específica não
 * é acionável", em oposição a `EXEC_TRACK_EXPLAIN`, que descreve o track
 * inteiro (#7644).
 *
 * A distinção é o ponto: o `explain` de `bloqueada` enumera CINCO causas
 * possíveis, porque descreve a categoria. Quem olha a Triagem e vê o badge
 * `Bloqueada` não fica sabendo qual das cinco se aplica àquela linha — tem
 * que abrir a issue no GitHub e ler as labels. O veredito por regra já era
 * calculado (`ExecTrackResult.matched`) e já viajava até o cliente desde o
 * #6200; só não era traduzido pra lugar nenhum, servindo apenas pra pintar o
 * sufixo `·sem sinal`.
 *
 * Mora aqui pelo mesmo motivo que `EXEC_TRACK_EXPLAIN`: é a descrição do que
 * cada BRAÇO do classificador faz, e mantê-la ao lado do braço é o que evita
 * a regra mudar e o texto ficar. Sendo `Record<ExecTrackMatch, …>` exaustivo,
 * um valor novo na união não compila até ganhar rótulo — o mesmo guard que
 * `EXEC_TRACK_MATCH_CATALOG` exerce pelo lado do runtime.
 *
 * Inclui as regras de track ACIONÁVEL (`label:windows`, `default`, …), ainda
 * que a Triagem não as renderize hoje: a tabela descreve o classificador, não
 * a coluna. Deixar buracos aqui converteria o guard de compilação num
 * `Partial` decorativo, e a próxima regra acionável entraria sem que ninguém
 * escrevesse o que ela significa.
 *
 * `short` é o que cabe na célula (curto, minúsculo — não é título); `long` é
 * o tooltip, e diz o que DESTRAVA, não só o que trava: é a pergunta seguinte
 * de quem lê a coluna.
 */
export const EXEC_TRACK_MATCH_REASON: Record<ExecTrackMatch, { short: string; long: string }> = {
  "state:closed": {
    short: "issue fechada",
    long: "A issue está fechada — nunca é candidata a rodada nenhuma. Se apareceu na Triagem, o snapshot está defasado.",
  },
  "label:on-hold": {
    short: "tirada de circulação",
    long: "Label `on-hold`: o editor tirou a issue de circulação. Não é 'ainda não', é 'não' — destrava removendo a label.",
  },
  "label:wontfix": {
    short: "tirada de circulação",
    long: "Label `wontfix`: decidido que não será feito. Destrava só reabrindo a decisão com o editor.",
  },
  "label:external-blocker": {
    short: "conta/serviço de terceiro",
    long: "Label `external-blocker`: depende de ação numa conta ou serviço de terceiro que nenhuma sessão faz sozinha. Destrava o editor agindo na conta — e, se o que falta for só escopo de uma credencial que já existe, a label `credencial-escopo` reclassifica a issue como Develop (#5694).",
  },
  "label:kit-migration": {
    short: "migração Kit em curso",
    long: "Label `kit-migration`: bloqueada pela migração de canal para o Kit. Destrava quando a etapa correspondente da migração concluir.",
  },
  "label:beehiiv": {
    short: "plan-gate da Beehiiv",
    long: "Label `beehiiv`: depende de recurso da Beehiiv fora do plano contratado (o workspace é Launch/free). Não há fix neste repo — destrava com upgrade de plano ou trocando de caminho.",
  },
  "label:bloqueio-execucao": {
    short: "bloqueio de execução",
    long: "Label `bloqueio-execucao`: existe um impedimento concreto de execução registrado na issue. Destrava resolvendo o que a issue descreve — ler os comentários antes de reinvestigar.",
  },
  "label:dependencia-aberta": {
    short: "depende de issue aberta",
    long: "Label `dependencia-aberta` (#7137): a issue declara `depends-on: #N` e essa dependência ainda está aberta. Desarma SOZINHA quando a dependência fechar — quem remove a label é `scripts/reconcile-issue-dependencies.ts`, nunca a mão. O número da dependência está no corpo da issue.",
  },
  "label:aarrr-fora-da-whitelist": {
    short: "etapa do funil não liberada",
    long: "Labels `aarrr:*`: nenhuma das etapas do funil desta issue está em `aarrr-whitelist.json`. Destrava o editor adicionando a etapa à whitelist (ou removendo a label `aarrr:*`). Não se aplica a issues com label `bug` (#7945) — essas nunca caem aqui.",
  },
  "marker:aguardando-ate": {
    // `{date}` é interpolado pelo caller (`reasonCell` em triagem.js) com
    // `TriageIssue.execTrackWaitUntilLabel` (#7868) — sem essa interpolação,
    // o editor via só "agendado" sem saber para quando, e tinha que abrir a
    // issue pra descobrir. Fallback pro literal "{date}" nunca vaza pro
    // cliente: `reasonCell` sempre substitui, com valor conhecido ou um
    // texto genérico quando o servidor não populou o label por algum motivo.
    short: "agendado para {date}",
    long: "Marcador `aguardando-ate: AAAA-MM-DD` — agendado para {date}. Não está bloqueada por nada — é trabalho fazível que volta sozinho ao fluxo na data, sem ninguém remover label.",
  },
  "label:not-this-week": {
    short: "adiada, sem data",
    long: "Label `not-this-week`: deferimento vago, sem data específica. Como não há data, não vira Agendada — destrava removendo a label, ou trocando-a por um marcador `aguardando-ate: AAAA-MM-DD`.",
  },
  "label:next-month": {
    short: "adiada, sem data",
    long: "Label `next-month`: deferimento vago, sem data específica. Como não há data, não vira Agendada — destrava removendo a label, ou trocando-a por um marcador `aguardando-ate: AAAA-MM-DD`.",
  },
  "label:windows": {
    short: "exige máquina Windows",
    long: "Label `windows`: precisa do Chrome logado / ComfyUI / `data/` local. É Develop — acionável numa sessão na máquina do editor, nunca no 300.",
  },
  "label:trade-off-real": {
    short: "trade-off na fila do briefing",
    long: "Label `trade-off-real`: já triada como trade-off de produto/editorial. Desde o #7493 continua Overnight — entra na fila de perguntas do briefing da Fase 0, em vez do bounce pro Develop.",
  },
  "label:credencial-escopo": {
    short: "falta escopo de credencial",
    long: "Labels `external-blocker` + `credencial-escopo` (#5694): a credencial já existe, falta só a permissão/escopo. Por isso é Develop e não Bloqueada — acionável com o editor presente.",
  },
  "label:develop-track": {
    short: "precisa do editor presente",
    long: "Label `develop-track` (#5948): bloqueio humano ou dependência sem data específica. Acionável numa sessão com o editor — se tivesse data, seria `aguardando-ate:` e viraria Agendada.",
  },
  "label:alarm-evento": {
    short: "alarme de evento passado",
    long: "Label `alarm-evento` (#5553): alarme ancorado a um evento/ID imutável, que nunca se auto-resolve. Precisa de revisão — por isso é Overnight, e não Fora de rodada como o alarme de estado.",
  },
  "label:alarm-acao": {
    short: "alarme que exige ação",
    long: "Label `alarm-acao` (#6772): alarme de ESTADO que só normaliza por AÇÃO (ex: timer nunca armado ou órfão). Remediado rodando um script — por isso é Overnight.",
  },
  "label:decisao-registrada": {
    short: "resolvida por decisão em prosa",
    long: "Label `decisao-registrada`: a issue foi resolvida por registro de decisão, sem código pendente. Só classifica assim quando nenhuma outra label já classificou a issue de outro jeito.",
  },
  "label:alarm": {
    short: "alarme que se auto-resolve",
    long: "Label `alarm` (sem `alarm-evento`): alarme de ESTADO que comenta e fecha sozinho quando o achado para de reproduzir. Não há ação a tomar — se ainda está aberto, o achado ainda reproduz.",
  },
  "label:epic-guarda-chuva": {
    short: "épica — fecha com as filhas",
    long: "Label `epic-guarda-chuva` (#5968): issue `[ÉPICA]` guarda-chuva, nunca implementada direto. Fecha só quando as issues-filhas mergearem — o trabalho acionável está nelas, não aqui.",
  },
  "label:sem-direcao-acionavel": {
    short: "sem ação de código clara",
    long: "Label `sem-direcao-acionavel` (#5968): a rodada já investigou e concluiu explicitamente que não há próximo passo de código prescrito. Diferente de `precisa-resposta`/`trade-off-real`, que são ambiguidades ANTES de qualquer tentativa.",
  },
  "label:triada-overnight": {
    short: "triada — overnight confirmado",
    long: "Label `triada-overnight` (#7694): alguém já leu a issue e confirmou que não há nada a desbloquear — é Overnight mesmo. O veredito é idêntico ao que ela teria sem a label; o que muda é deixar de ser `·sem sinal`, pra a próxima varredura não retriar do zero. Destrava sozinha: o overnight pega normalmente.",
  },
  default: {
    short: "sem sinal — ninguém triou",
    long: "Nenhuma label ou marcador classificou esta issue: ela nasce Overnight por construção, o que é a verdade (o overnight ainda vai olhar pra ela). Acionável — o badge já sinaliza isso com o sufixo `·sem sinal`.",
  },
};

/**
 * Resolve o motivo (short/long) de UMA issue já com `{date}` interpolado —
 * server-side (#7884, regressão do #7868/PR #7878). O #7868 tinha deixado a
 * interpolação só no CLIENTE (`reasonCell` em `triagem.js`), servindo
 * `EXEC_TRACK_MATCH_REASON` cru em `execTrackReasonUi.reasons` — um cliente
 * mais VELHO que o servidor (aba aberta antes de um deploy, checkout de
 * `public/` defasado em relação ao processo) renderiza o placeholder `{date}`
 * literal em vez de resolvê-lo, porque a lógica de substituição não existia
 * na versão do JS que ele carregou.
 *
 * Mover a interpolação pra cá elimina essa classe de skew: o payload de
 * `/api/issues` já entrega o texto final por issue (`TriageIssue.execTrackReason`),
 * e QUALQUER cliente — novo ou velho — que apenas exiba esse campo mostra a
 * data certa. `execTrackReasonUi` (vocabulário estático, com o placeholder)
 * continua sendo servido, e o cliente novo mantém o `replaceAll` como rede de
 * segurança (cliente novo + servidor velho, que ainda não manda
 * `execTrackReason`, continua funcionando via fallback).
 *
 * `matched === null` (caller legado que não populou `ExecTrackMatch`) retorna
 * `null` — nada a resolver.
 */
export function resolveExecTrackReason(
  matched: ExecTrackMatch | null,
  waitUntilLabel?: string | null,
): { short: string; long: string } | null {
  if (matched === null) return null;
  const entry = EXEC_TRACK_MATCH_REASON[matched];
  if (!entry) return null;
  // Mesmo fallback genérico do cliente (#7868) — nunca deixa `{date}` cru
  // vazar caso `waitUntilLabel` não tenha sido populado por algum motivo
  // (não deveria acontecer pra `marker:aguardando-ate`, mas a substituição é
  // inócua pros demais `matched`, que não carregam `{date}` na frase).
  const dateText = waitUntilLabel || "data no corpo da issue";
  return {
    short: entry.short.replaceAll("{date}", dateText),
    long: entry.long.replaceAll("{date}", dateText),
  };
}

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
