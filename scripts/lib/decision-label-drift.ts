/**
 * scripts/lib/decision-label-drift.ts (#5589)
 *
 * Guard mecânico de AUDITORIA (não bloqueia nada, não aplica label sozinho —
 * é detecção; correção fica com quem lê o alerta), decidido na sessão
 * `/diaria-develop` 260817b: reduz o padrão observado em #5586 (#5237/#5239/
 * #5125 na rodada overnight 260817c/d), onde um comentário de sessão
 * (overnight/develop/continuo) registra em PROSA que uma issue foi
 * deferida/decidida ("aguardando pré-requisito", "trade-off-real", etc.) mas
 * a LABEL estrutural correspondente (`not-this-week`, `trade-off-real`, ...)
 * nunca é aplicada — deixando `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`)
 * desatualizado: a issue continua aparecendo como `overnight` (elegível) na
 * Triagem, quando na prática já foi resolvida/adiada por decisão registrada.
 *
 * ## O que este módulo NÃO é
 *
 * Não é NLP. É casamento de substring/regex contra um catálogo pequeno e
 * documentado de frases-gatilho observadas ao vivo (#5586) — precisão baixa
 * de propósito: falso positivo aqui custa um alerta ignorado; falso negativo
 * custa a mesma lacuna que este guard existe pra reduzir. Não tenta separar
 * "menciona o padrão em prosa comum" de "está de fato deferindo a issue" —
 * quem lê o achado faz esse julgamento. Não reimplementa
 * `parseDecisionMarkers`/`latestDecisionFor` (`issue-decisions.ts`) — aquele
 * módulo lê o marcador ESTRUTURADO (`<!-- decisao-editor: ... -->`); este
 * lê a PROSA ao redor dele, que é exatamente o que não tem estrutura
 * nenhuma pra `classifyExecTrack` consumir.
 *
 * ## Por que os HTML comments (marcadores) são removidos antes do match
 *
 * O payload dos marcadores de `issue-decisions.ts` é base64 — teoricamente
 * poderia, por acaso, conter uma sequência de caracteres que colide com um
 * padrão de gatilho. `stripHtmlComments` remove qualquer bloco `<!-- ... -->`
 * antes do match, então só a prosa legível por humano (que é o sinal real
 * que este módulo quer capturar) participa da detecção.
 *
 * ## Dedup
 *
 * Um comentário pode casar o mesmo padrão mais de uma vez (múltiplas frases
 * gatilho do mesmo grupo), e vários comentários da mesma issue podem casar o
 * mesmo padrão. `detectLabelDrift` reporta no máximo 1 achado por
 * `(issueNumber, patternId)` — o do comentário mais RECENTE que casou (bodies
 * são varridos na ordem recebida, que é cronológica ascendente via `gh`), pra
 * não inflar a mesma pendência N vezes.
 *
 * A checagem usa o snapshot ATUAL das labels da issue (`labels`, passado uma
 * única vez pro `detectLabelDrift`), não um histórico de labels por momento
 * do comentário — `labelSet` não muda durante o loop. Ou seja: se as labels
 * atuais já satisfazem o padrão, NENHUM achado é registrado pra ele,
 * independente de quantos ou quais comentários bateram (nem "o comentário
 * mais antigo tinha gerado achado, o mais recente corrigiu" é um mecanismo
 * real — a satisfação é constante por `(issue, patternId)`, avaliada contra
 * o mesmo snapshot em toda iteração).
 *
 * ## Duas fontes de prosa (#5955)
 *
 * Além dos comentários, `detectLabelDrift` varre opcionalmente prosa do
 * `plan.json` da rodada (`planTexts`), com o MESMO catálogo. O plano é a
 * evidência mais confiável das duas: `motivo` é exigido pela skill em toda
 * issue `pulada` — e presente em dezenas de planos reais —, enquanto comentar
 * é opcional. O `scope_note` que o CLI também repassa é campo ad-hoc (medido:
 * 1 ocorrência em 81 planos, sem menção em SKILL nenhuma), então a cobertura
 * desta fonte se apoia em `motivo`; `scope_note` é bônus quando aparece.
 *
 * Foi o que faltou no caso que motivou o grupo `execution-guard`: na rodada
 * 260823 a #5140 foi pega e devolvida duas vezes por causa do guard de
 * publicação, o `plan.json` registrava isso com precisão em `motivo`/
 * `scope_note` — e o veredito morria ali, num arquivo privado da rodada, sem
 * nunca virar label. `classifyExecTrack` seguia devolvendo `overnight`, então
 * a rodada seguinte pegaria de novo.
 *
 * Puro: sem I/O, sem rede, sem `gh` — recebe labels + bodies de comentário já
 * buscados. O CLI (`scripts/check-decision-label-drift.ts`) é o wrapper fino
 * que busca via `gh` e imprime.
 *
 * ## Roteamento explícito posterior vence (#6283)
 *
 * A entrada em produção de `scripts/route-issue.ts` (#6191/#6196) criou uma
 * 2ª fonte de comentário que casa os mesmos padrões de prosa — o corpo do
 * comentário de `routeIssue` é `Roteado para **{track}** — {reason}`, e
 * `reason` frequentemente CITA a mesma frase-gatilho do comentário antigo
 * que está sendo revogado ("Removendo trade-off-real", "aguardando
 * autorização do IP"). Sem tratamento, um veredito antigo já revogado por um
 * `route-issue` mais recente continuava produzindo achado pra sempre — e a
 * "correção" sugerida (`gh issue edit --add-label`) desfazia uma decisão do
 * editor tomada horas antes (medição ao vivo, rodada 260826c: 14 de 19
 * achados eram este falso positivo).
 *
 * `detectLabelDrift` ignora um match de comentário se `commentBodies[i]` OU
 * algum `commentBodies[j]` com `j > i` contém, na ABERTURA do corpo (espaço
 * em branco antes é tolerado — `parseRouteIssueMarkerAtStart`,
 * `issue-route.ts`), um marcador `<!-- route-issue: track=X -->` — não
 * importa qual track foi pedido: a existência de um roteamento explícito já
 * é, por si só, o veredito atual que supera a prosa antiga (ou a própria
 * prosa do comentário, ver "Inclusivo" abaixo). Um `route-issue` ANTERIOR ao
 * comentário candidato não protege — prosa nova depois de um roteamento
 * antigo é informação nova, não revogada por nada. Aplica-se só à fonte
 * `"comment"` — `planTexts` (fonte `"plan"`) não tem posição cronológica
 * conhecida em relação aos comentários do GitHub, então fica fora deste
 * tratamento.
 *
 * ### Inclusivo, não só posterior (#6301 finding 4)
 *
 * A versão original (revisão da #6283) só olhava `j > i` — um comentário
 * nunca era suprimido pelo marcador que ELE PRÓPRIO carrega. Como o
 * comentário do `routeIssue` costuma ser o mais recente da issue, nada vem
 * "depois" dele — e seu próprio `--reason` (que frequentemente repete a
 * frase-gatilho do veredito antigo que está revogando: ver exemplo de uso
 * `--reason "aguardando resposta da Beehiiv"` na docstring de
 * `scripts/route-issue.ts`) virava achado contra si mesmo. Especialmente
 * ruim em `agendada`, que por desenho nunca recebe uma label satisfatória
 * (usa o marcador `aguardando-ate:` no CORPO, não uma label) — o falso
 * positivo recorreria em praticamente todo roteamento `agendada` cujo
 * `reason` mencionasse espera. Corrigido incluindo `j === i`: um comentário
 * que ABRE com seu próprio marcador É o veredito corrente, não prosa a ser
 * julgada contra ele mesmo.
 *
 * Isto só é seguro por causa da exigência de posição estrutural do
 * parágrafo anterior (`parseRouteIssueMarkerAtStart`): sem ela, um
 * comentário que meramente CITASSE o marcador em prosa (não gravado por
 * `buildCommentBody`) se auto-suprimiria por engano — exigir abertura de
 * corpo garante que só o comentário genuíno de `routeIssue` se qualifica.
 *
 * ### Achados suprimidos ficam visíveis, não silenciosos (#6301 finding 1)
 *
 * `detectLabelDriftDetailed` — o que `detectLabelDrift` envolve por baixo,
 * mantendo o array simples pros callers existentes — devolve também
 * `suppressedByRoute`: os achados que TERIAM sido reportados se esta regra
 * não existisse. `check-decision-label-drift.ts` e
 * `check-decision-label-drift-gate.ts` imprimem essa contagem (stderr,
 * nomeando a issue) sempre que > 0. Sem isso, "nenhum drift" e "havia
 * drift, mas um `route-issue` posterior apagou" eram indistinguíveis pra
 * quem lê o output — a mesma doença que este módulo inteiro existe pra
 * combater (#5589/#5892/#5955).
 *
 * ### Precisão sobre "posterior" (#6301 finding 5)
 *
 * Isto NÃO é a mesma técnica de `issue-decisions.ts` — apesar de uma versão
 * anterior desta docstring ter dito isso. Aquele módulo compara
 * `decided_at`, um timestamp ISO 8601 embutido no próprio marcador:
 * recência ali é auto-contida no marcador, independente de posição em
 * array. O marcador `<!-- route-issue: track=X -->` NÃO carrega
 * timestamp — "posterior"/"em ou depois" aqui é 100% POSICIONAL, sob a
 * premissa (documentada em prosa, nunca expressa no tipo, nunca verificada
 * em runtime) de que `commentBodies` chega em ordem cronológica ascendente.
 * Antes do #6283 essa premissa sustentava só o dedup do `byPattern` (errar
 * a ordem trocava qual comentário aparecia no excerto, o achado continuava
 * aparecendo); desde o #6283 ela é PRECONDIÇÃO DE CORRETUDE da supressão —
 * fora de ordem, um achado válido pode ser suprimido em silêncio (ver
 * `DetectLabelDriftInput.commentBodies` abaixo). As duas chamadoras reais
 * (`check-decision-label-drift.ts` via `fetchCommentBodies`,
 * `check-decision-label-drift-gate.ts` via `gh issue view --json comments`)
 * preservam ordem hoje — isto é dívida de precisão a documentar, não bug
 * ativo; não redesenhado nesta unidade.
 *
 * @see scripts/lib/issue-decisions.ts (marcador estruturado que este módulo complementa — timestamp real, técnica DIFERENTE da posicional acima)
 * @see scripts/lib/issue-exec-track.ts (o classificador que fica desatualizado sem este guard)
 * @see scripts/lib/issue-route.ts (parseRouteIssueMarkerAtStart — marcador que este módulo consome)
 * @see scripts/check-decision-label-drift.ts (CLI)
 */

import type { ExecTrack } from "./issue-exec-track.ts";
import { parseRouteIssueMarkerAtStart } from "./issue-route.ts";

/** Um grupo de padrões de deferimento/decisão em prosa, e as labels
 * estruturais que QUALQUER UMA (relação any-of) satisfaz — presente
 * qualquer uma delas, o comentário está coerente com a label e não é
 * reportado como drift. */
export interface DriftPattern {
  /** Identificador estável — aparece no output do CLI e nos testes. */
  id: string;
  /** Explicação curta do que o padrão detecta, pro output do CLI. */
  description: string;
  /** Casamento é "qualquer regex do grupo bate" (OR), não todas. */
  textPatterns: RegExp[];
  /** Labels estruturais que resolvem o achado — basta uma presente. */
  expectedLabels: string[];
}

/**
 * Catálogo de padrões — extraído literalmente das frases-gatilho citadas na
 * decisão do editor (#5589) e dos dois casos reais do #5586 (#5239:
 * "não despachar agora, pré-requisito ainda não atendido"; #5125: trade-off
 * declarado desde a criação da issue). Vocabulário de `issue-exec-track.ts`
 * é a fonte das labels esperadas — mantém os dois módulos em sincronia
 * manual (nenhum import cruzado: este módulo é deliberadamente mais
 * permissivo/heurístico que aquele, que é a fonte de verdade sobre labels).
 */
/**
 * Capacidade FORTE (#5959 do review da PR #5958): a frase já é, por si só,
 * sobre execução ao vivo. Combina com qualquer impedimento, inclusive os
 * fracos (`exige`, `requer`, `precisa`) — "exige rodar envio real de campanha
 * Clarice" é o texto literal do bounce de 23/08 na #5140.
 */
const EXECUTION_CAPABILITY_STRONG =
  "(?:envio (?:real|ao vivo)|execu[çc][ãa]o ao vivo|campanha ao vivo)";

/**
 * Capacidade FRACA: substantivo genérico que só vira sinal com um
 * impedimento FORTE ao lado.
 *
 * A distinção existe porque "guard", "sessão supervisionada" e afins são
 * vocabulário corrente deste repo para coisas que nada têm a ver com bounce
 * de execução (guard de CI, guard de review de PR, gate de stage). Com
 * impedimento fraco, frases perfeitamente comuns viravam achado e travavam a
 * compilação do relatório:
 *
 *   "o guard de execução deste PR precisa de mais testes antes de mergear"
 *   "o guard de publicação do stage 5 exige revisão antes de mudar threshold"
 *
 * Exigir impedimento forte ("vedado pelo guard de publicação") separa os dois
 * casos sem perder o bounce real.
 */
const EXECUTION_CAPABILITY_WEAK =
  "(?:guard de (?:publica[çc][ãa]o|execu[çc][ãa]o)|sess[ãa]o supervisionada|sess[ãa]o com execu[çc][ãa]o autorizada|editor presente)";

/** Impedimento FORTE: afirma que algo está barrado, não que falta fazer. */
const EXECUTION_IMPEDIMENT_STRONG =
  "(?:vedad[oa]|proibid[oa]|pro[íi]be|barrad[oa]|barra|impede|impedid[oa]|bloqueia|bloquead[oa]|n[ãa]o (?:consigo|posso|pode|d[áa]))";

/**
 * Impedimento FRACO: exprime necessidade. Sozinho não distingue "estou
 * barrado" de "falta fazer", daí só valer com capacidade forte.
 *
 * Mantido no mínimo observado em bounce real. `depende de` chegou a entrar
 * aqui, e `disparo (real|ao vivo)` na capacidade forte, sem nenhum caso real
 * pedindo — só alargavam a superfície ("a campanha ao vivo depende de
 * aprovação do budget" virava achado). Saíram: neste grupo a política é
 * preferir falso negativo, então termo sem caso que o justifique não entra.
 */
const EXECUTION_IMPEDIMENT_WEAK = "(?:exige|requer|precisa)";

/**
 * Frases que já carregam capacidade e impedimento juntas, dispensando o
 * segundo fator.
 *
 * - `fora do escopo do overnight` / `fora do escopo autônomo` nomeiam a
 *   sessão que não consegue — só podem significar bounce. Restrito a essas
 *   duas formas: "fora do escopo da rodada/sessão" é deferimento comum de
 *   tempo, que é `deferred-vague`.
 * - `precisa do editor`: neste repo "o editor" é a pessoa, e a frase é a
 *   forma mais curta e mais provável de um bounce ("Precisa do editor."), que
 *   o critério de dois fatores perdia.
 *
 *   Duas exclusões, ambas pra separar a PESSOA da FERRAMENTA (achados de
 *   re-review): só artigo DEFINIDO (`do`, nunca `de`) — "precisa de um editor
 *   gráfico" e "precisa de editor gráfico" são software; e lookahead negativo
 *   pra `de` logo depois — "precisa do editor de vídeo/imagem/som" também é
 *   software, apesar do artigo definido. Sobra o uso que importa: "precisa do
 *   editor", "precisa do editor decidir isso", "precisa do editor para X".
 */
const EXECUTION_SELF_SUFFICIENT =
  "(?:fora do escopo do overnight|fora do escopo aut[ôo]nomo|precisa do editor\\b(?!\\s+de\\s))";

/**
 * Nega o match quando uma palavra de negação aparece até 2 tokens antes do
 * impedimento. Cobre "não impede", "nada exige envio real", "não é vedado",
 * "nenhuma issue barrada".
 *
 * `sem` entra, com UMA exceção cirúrgica: `sem dúvida`. O idioma é ênfase,
 * não negação do que vem depois, e suprimia um bounce legítimo ("sem dúvida,
 * não consigo fazer envio ao vivo hoje"). Tirar `sem` inteiro da lista — a
 * primeira tentativa — consertava esse caso e reabria o oposto: "sem barrar o
 * envio real, a rodada segue amanhã" afirma que NADA está barrado e voltava a
 * casar (achado de re-review). O lookahead resolve os dois.
 *
 * Mitigação parcial e assumida — este módulo não faz análise sintática (ver
 * "O que este módulo NÃO é", no topo). Negação mais distante que 2 tokens
 * ainda escapa; alargar a janela começa a engolir negação de OUTRA oração e
 * vira falso negativo.
 */
const NEGATION_LOOKBEHIND =
  "(?<!\\b(?:n[ãa]o|nenhum[ao]?s?|nada|sem(?!\\s+d[úu]vida))\\s(?:\\S+\\s){0,2})";

/**
 * Guard de negação pra padrões de FRASE ÚNICA (#6258) — `deferred-vague`,
 * `trade-off-real` e `external-blocker` casam um substantivo/expressão isolada
 * ("bloqueio externo", "aguardando", "trade-off real"), sem a estrutura de
 * dois fatores capacidade×impedimento que os grupos `execution-guard`/
 * `on-hold` usam. Confirmado ao vivo na rodada 260826 (#6258): "Nenhum
 * bloqueio externo — overnight contínuo." e "Não há bloqueio externo aqui."
 * casavam `external-blocker` — o detector lia só a afirmação, não a negação
 * que vinha 0-1 palavra antes dela.
 *
 * Janela DELIBERADAMENTE mais curta que `NEGATION_LOOKBEHIND` (0-1 token,
 * não 0-2): a armadilha simétrica é "sem credencial, é bloqueio externo" —
 * um bloqueio REAL, apesar do `sem`, porque o `sem` nega "credencial" (a
 * causa), não "bloqueio externo" (a consequência afirmada logo depois do
 * "é"). Com janela 0-2, `sem credencial, é ` (2 tokens: "credencial," e "é")
 * cai dentro da distância e o guard engoliria esse achado verdadeiro — o
 * efeito perverso que a #6258 pede pra evitar (falso negativo custa mais
 * aqui: enterra issue trabalhável). Janela 0-1 cobre os dois casos reais
 * observados ("Nenhum bloqueio externo" = 0 tokens; "Não há bloqueio externo"
 * = 1 token, "há") sem alcançar o token extra ("é") que a armadilha precisa.
 * Mesma lista de negação de `NEGATION_LOOKBEHIND`, mais `inexistente` e
 * `zero` (vocabulário citado na issue, sem caso real ainda — inclusão
 * barata, mesmo padrão de completude do catálogo acima).
 */
const SIMPLE_NEGATION_LOOKBEHIND =
  "(?<!\\b(?:n[ãa]o|nenhum[ao]?s?|nada|inexistente|zero|sem(?!\\s+d[úu]vida))\\s(?:\\S+\\s){0,1})";

/** Distância máxima entre os dois fatores — aproxima "mesma frase" sem
 * atravessar ponto final nem quebra de linha. */
const TWO_FACTOR_WINDOW = "[^.\\n]{0,60}";

/** Um par capacidade×impedimento que basta pra caracterizar bounce. */
interface FactorPair {
  capability: string;
  impediment: string;
}

/**
 * Monta as regexes do grupo: cada par vira duas (uma por ordem dos fatores,
 * já que `textPatterns` é OR), mais uma por frase auto-suficiente.
 *
 * `selfSufficient` é PARÂMETRO, não constante capturada: o helper tem cara de
 * genérico, e um segundo grupo que o reusasse herdaria em silêncio as frases
 * específicas do overnight (achado de review).
 */
function buildFactorPatterns(pairs: readonly FactorPair[], selfSufficient?: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const { capability, impediment } of pairs) {
    const imped = `${NEGATION_LOOKBEHIND}${impediment}`;
    patterns.push(new RegExp(`${imped}${TWO_FACTOR_WINDOW}${capability}`, "i"));
    patterns.push(new RegExp(`${capability}${TWO_FACTOR_WINDOW}${imped}`, "i"));
  }
  if (selfSufficient) patterns.push(new RegExp(`${NEGATION_LOOKBEHIND}${selfSufficient}`, "i"));
  return patterns;
}

/** Capacidade forte aceita qualquer impedimento; a fraca exige o forte. */
const EXECUTION_GUARD_PAIRS: readonly FactorPair[] = [
  {
    capability: EXECUTION_CAPABILITY_STRONG,
    impediment: `(?:${EXECUTION_IMPEDIMENT_STRONG}|${EXECUTION_IMPEDIMENT_WEAK})`,
  },
  { capability: EXECUTION_CAPABILITY_WEAK, impediment: EXECUTION_IMPEDIMENT_STRONG },
];

export const DRIFT_PATTERNS: readonly DriftPattern[] = [
  {
    id: "deferred-vague",
    description:
      "Comentário sugere adiar/aguardar (aguardando, não despachar, pré-requisito não atendido) sem label de deferimento (not-this-week/next-month) aplicada.",
    textPatterns: [
      // Lookahead negativo pro nome do marcador `aguardando-ate:` (#5955): um
      // comentário que só CITA o mecanismo ("o marcador `aguardando-ate:
      // 2026-08-23` venceu hoje") não está deferindo nada, mas casava aqui e
      // gerava achado apontando pra `not-this-week`/`next-month` — que roteiam
      // pra Bloqueada. Foi o único match produzido pelos comentários da rodada
      // 260823 na #5140, mascarando o drift real (guard de execução, grupo
      // `execution-guard` abaixo) com um achado de destino errado. Prosa
      // legítima ("aguardando pré-requisito", "aguardando até segunda") segue
      // casando: o lookahead barra só o hífen do nome do marcador.
      //
      // `aguardando` leva o guard de negação (#6258) — "sem aguardando" não é
      // português natural, mas "nada aguardando" ("nada está aguardando
      // decisão") é. As outras 4 frases já embutem `n[ãa]o`/negação como
      // parte do PRÓPRIO sinal de deferimento ("não despachar", "não
      // atendido", "ainda não é a hora") — aplicar o guard nelas negaria a
      // negação que É o sinal, então ficam de fora de propósito.
      new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}aguardando(?!-ate)`, "i"),
      /n[ãa]o despachar/i,
      /pr[ée]-requisito(s)? (ainda )?n[ãa]o atendido/i,
      /ainda n[ãa]o (é|eh) a hora/i,
      /adiar (pra|para|essa|esta) issue/i,
    ],
    expectedLabels: ["not-this-week", "next-month"],
  },
  {
    id: "trade-off-real",
    description:
      "Comentário identifica trade-off editorial/produto real sem a label trade-off-real aplicada.",
    textPatterns: [new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}trade-?off[\\s-]*real`, "i")],
    expectedLabels: ["trade-off-real"],
  },
  {
    id: "external-blocker",
    description:
      "Comentário indica bloqueio externo (conta de terceiro, credencial, acesso a painel) sem label de bloqueio correspondente.",
    // Guard de negação (#6258, achado ao vivo na rodada 260826): sem ele,
    // "Nenhum bloqueio externo — overnight contínuo." e "Não há bloqueio
    // externo aqui." casavam do mesmo jeito que "Tem bloqueio externo: falta
    // credencial do painel." — o detector lia a afirmação sem olhar a
    // negação logo antes. Ver `SIMPLE_NEGATION_LOOKBEHIND` acima pra janela
    // e o caso-armadilha ("sem credencial, é bloqueio externo", que É um
    // bloqueio real apesar do `sem`).
    textPatterns: [
      new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}bloqueio externo`, "i"),
      new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}falta acesso a (um |uma )?(painel|conta)`, "i"),
      new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}conta de terceiro`, "i"),
      new RegExp(
        `${SIMPLE_NEGATION_LOOKBEHIND}credencial (pendente|faltando|necess[áa]ria)`,
        "i",
      ),
    ],
    expectedLabels: ["external-blocker", "kit-migration", "beehiiv", "bloqueio-execucao"],
  },
  {
    id: "execution-guard",
    description:
      "Comentário indica que a EXECUÇÃO foi barrada por guard/capacidade da própria sessão (publicação, envio ao vivo) sem label estrutural que tire a issue do track `overnight`.",
    // Dois fatores obrigatórios na MESMA frase, em qualquer ordem: um termo de
    // CAPACIDADE (o que a sessão não consegue fazer) e um termo de
    // IMPEDIMENTO (o fato de estar barrada). Nenhum dos dois sozinho basta —
    // decisão de review (#5958), depois de medir que os padrões de fator
    // único geravam falso positivo em prosa factual e, pior, em
    // meta-discussão sobre os próprios guards, que é assunto recorrente de
    // issue neste repo ("o guard de publicação está funcionando normalmente"
    // casava; "revisamos o guard de execução do stage 5" casava).
    //
    // Este grupo alimenta um gate que BLOQUEIA a compilação do relatório da
    // rodada, então aqui a tolerância a falso positivo do topo do módulo NÃO
    // vale — ela é escrita pro CLI de auditoria, onde FP custa uma linha
    // ignorada. Preferir falso negativo é a escolha certa neste grupo: o CLI
    // permissivo continua reportando o que o gate deixar passar.
    textPatterns: buildFactorPatterns(EXECUTION_GUARD_PAIRS, EXECUTION_SELF_SUFFICIENT),
    expectedLabels: ["develop-track", "bloqueio-execucao"],
  },
  {
    id: "on-hold",
    description:
      "Comentário indica que o trabalho foi colocado em espera permanente ou não será feito, sem a label correspondente.",
    // `wontfix`/`on-hold` usam o mesmo `NEGATION_LOOKBEHIND` do grupo
    // `execution-guard` (#6116): sem o guard, "Não fechar como wontfix." —
    // uma negação explícita do rótulo, não uma recomendação — casava como
    // drift (#464/#463, achado ao vivo na sessão `/diaria-develop 260825`).
    // A frase "não vamos/iremos fazer" já É a própria negação-alvo (o
    // deferimento em si), então não leva o guard.
    textPatterns: [
      new RegExp(`${NEGATION_LOOKBEHIND}\\bon-hold\\b`, "i"),
      new RegExp(`${NEGATION_LOOKBEHIND}\\bwontfix\\b`, "i"),
      /n[ãa]o (vamos|iremos) fazer (isso|essa|esta)/i,
    ],
    expectedLabels: ["on-hold", "wontfix"],
  },
  {
    id: "escopo-residual",
    description:
      "Comentário indica que um PR REFS-not-Closes mergeou deixando escopo pendente ('escopo residual', 'REFS, NÃO CLOSES', 'pendente de decisão/tempo') sem label estrutural indicando o roteamento do que sobrou (#6437).",
    // #6437 — achado ao vivo (rodada 260827b): #6340/#6169/#6185/#6186/#6051
    // ficaram presas "Overnight sem sinal" pra sempre porque o comentário
    // dizia "escopo residual: PR #NNNN (mergeado) é REFS, NÃO CLOSES" sem
    // NENHUMA label estrutural indicando pra onde o residual deveria ir —
    // `route-issue.ts` nunca era chamado. Guard de negação (0-1 token, mesmo
    // padrão de `external-blocker`/`on-hold` acima): "não ficou escopo
    // residual" / "sem escopo residual" não deveria casar.
    textPatterns: [
      new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}escopo residual`, "i"),
      /REFS[\s#]*\d*,?\s*N[ÃA]O CLOSES/i,
      new RegExp(`${SIMPLE_NEGATION_LOOKBEHIND}pendente de decis[ãa]o(\\s*(\\/|e|ou)\\s*tempo)?`, "i"),
    ],
    expectedLabels: [
      "not-this-week",
      "next-month",
      "develop-track",
      "trade-off-real",
      "windows",
      "sem-direcao-acionavel",
    ],
  },
];

/**
 * Label que satisfaz QUALQUER padrão, além das `expectedLabels` específicas
 * de cada grupo — `decisao-registrada` (vocabulário de `issue-exec-track.ts`,
 * `RESOLVED_BY_PROSE_LABELS`) já significa "decisão registrada em prosa que
 * fecha o assunto"; uma issue que já carrega essa label não precisa também
 * da label de deferimento mais específica pra este guard considerar
 * coerente. Reduz um falso-positivo real observado ao vivo: o próprio
 * comentário de decisão desta issue (#5589) CITA as frases-gatilho como
 * exemplo ("aguardando", "trade-off-real") sem estar de fato deferindo
 * nada — `decisao-registrada` sinaliza que o assunto já foi resolvido, então
 * a citação em prosa não é um sinal de drift real.
 */
const UNIVERSAL_SATISFYING_LABEL = "decisao-registrada";

/** Remove blocos `<!-- ... -->` (marcadores estruturados de `issue-decisions.ts`
 * e afins) antes do match — só a prosa legível por humano participa da
 * detecção. Non-greedy (`[\s\S]*?`) pra não engolir o comentário inteiro
 * quando houver mais de um bloco no mesmo body. */
export function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Um achado: um comentário recente da issue casa um padrão de deferimento/
 * decisão, mas nenhuma das labels estruturais esperadas está presente. */
export interface DriftFinding {
  issueNumber: number;
  patternId: string;
  description: string;
  expectedLabels: string[];
  actualLabels: string[];
  /** Trecho da prosa (marcadores já removidos) em torno do match, pra dar
   * contexto no output sem despejar o texto inteiro. */
  commentExcerpt: string;
  /**
   * De onde veio a prosa que casou (#5955): `"comment"` = comentário da issue
   * no GitHub; `"plan"` = campo `motivo`/`scope_note` do `plan.json` da
   * rodada. O segundo é o sinal mais confiável — é o veredito que o próprio
   * coordenador gravou de forma estruturada, e existe mesmo quando a sessão
   * não chegou a comentar na issue.
   */
  source: DriftSource;
}

/** Origem da prosa que casou um padrão. Ver `DriftFinding.source`. */
export type DriftSource = "comment" | "plan";

const EXCERPT_RADIUS = 60;

function buildExcerpt(prose: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - EXCERPT_RADIUS);
  const end = Math.min(prose.length, match.index + match[0].length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < prose.length ? "…" : "";
  return `${prefix}${prose.slice(start, end).trim().replace(/\s+/g, " ")}${suffix}`;
}

export interface DetectLabelDriftInput {
  issueNumber: number;
  /** Labels da issue já normalizadas (nomes, sem o objeto do `gh`). */
  labels: string[];
  /** Corpos de comentário, ordem cronológica ascendente (mais recente por
   * último) — é o formato que `fetchCommentBodies` (`issue-decisions.ts`)
   * devolve. Ordem ascendente sustenta o "último match vence" do dedup
   * (`byPattern`) — mas desde o #6283 (ver docstring do módulo, seção
   * "Precisão sobre posterior", #6301 finding 5) é também PRECONDIÇÃO DE
   * CORRETUDE da supressão por `route-issue`: como o marcador não carrega
   * timestamp, "posterior" é lido puramente da posição neste array. Um
   * array fora de ordem não só troca qual comentário aparece no excerto —
   * pode suprimir (ou deixar de suprimir) o achado errado, em silêncio. */
  commentBodies: readonly string[];
  /**
   * Textos do `plan.json` da rodada pra esta issue (#5955) — na prática
   * `motivo` e `scope_note`, os campos onde o coordenador grava POR QUE
   * pulou a issue. Varridos com o MESMO catálogo de padrões dos comentários.
   *
   * Existe porque a prosa do comentário é opcional e variável, enquanto
   * `motivo` é preenchido por regra da skill em toda issue `pulada`: no caso
   * que originou este campo (#5140, rodada 260823), o `plan.json` dizia
   * "Parte 1 segue bloqueada (execução ao vivo)" e o `scope_note` citava o
   * guard de publicação, mas nada disso virou label — o veredito morreu num
   * arquivo privado da rodada. Omitir é válido (chamador que não tem plano).
   */
  planTexts?: readonly string[];
  /**
   * Track ATUAL da issue segundo `classifyExecTrack` (#5955). Quando
   * informado e diferente de `overnight`, nenhum achado é reportado.
   *
   * É o filtro de PRECISÃO, e existe porque os dois consumidores têm
   * tolerâncias opostas a falso positivo: o CLI de auditoria
   * (`check-decision-label-drift.ts`) omite o campo e segue permissivo — FP
   * ali custa uma linha ignorada; o GATE
   * (`check-decision-label-drift-gate.ts`) informa, porque FP ali BLOQUEIA a
   * compilação do relatório da rodada.
   *
   * O critério é o propósito declarado deste módulo, no topo: o dano é a
   * issue "continuar aparecendo como `overnight` (elegível) na Triagem"
   * depois de já ter sido deferida/bloqueada em prosa. Se a issue já
   * classifica em qualquer outro track, a label que falta não muda o
   * roteamento — não há livelock a evitar, e cobrar a label específica só
   * trava a rodada. Medido ao vivo no plano da rodada 260823: #4549
   * (`on-hold` + `external-blocker` → `fora-de-rodada`) e #5917 (marcador
   * `aguardando-ate` → `agendada`) geravam achado `deferred-vague` pedindo
   * `not-this-week`, sendo que as duas já estavam fora da fila do overnight.
   *
   * Custo aceito: mis-roteamento ENTRE tracks não-overnight (ex: issue
   * `bloqueada` que deveria ser `develop`) deixa de bloquear o gate. É o
   * problema menor — a issue não está sendo pega e devolvida a cada rodada —
   * e o CLI de auditoria continua reportando.
   *
   * Import é só de TIPO — este módulo continua sem acoplamento de runtime com
   * `issue-exec-track.ts`, que segue sendo a fonte de verdade sobre labels
   * (ver "O que este módulo NÃO é", no topo).
   */
  currentTrack?: ExecTrack;
}

/** Um achado que TERIA sido reportado por `detectLabelDrift`, mas foi
 * suprimido por um `route-issue` em ou depois do comentário candidato
 * (#6301 finding 1 — ver "Achados suprimidos ficam visíveis" na docstring
 * do módulo). Não carrega `expectedLabels`/`actualLabels` porque o ponto
 * não é "aplique esta label" (a supressão já significa que ninguém deveria
 * aplicá-la) — é só tornar a supressão auditável. */
export interface SuppressedFinding {
  issueNumber: number;
  patternId: string;
  description: string;
  /** Mesmo formato de `DriftFinding.commentExcerpt`. */
  commentExcerpt: string;
}

/** Retorno completo de `detectLabelDriftDetailed` — achados reais +
 * achados suprimidos por `route-issue` posterior. */
export interface DetectLabelDriftResult {
  findings: DriftFinding[];
  suppressedByRoute: SuppressedFinding[];
}

/**
 * Varre os comentários em busca de padrões de deferimento/decisão em prosa
 * e reporta os que não têm a label estrutural esperada aplicada na issue —
 * junto com os achados que um `route-issue` posterior (ou o próprio
 * comentário, ver docstring do módulo) suprimiu (#6301 finding 1).
 * Determinístico, sem I/O. Nunca lança — comentário malformado (não-string)
 * é ignorado, mesma postura tolerante de `parseDecisionMarkers`.
 *
 * `detectLabelDrift` (abaixo) é um wrapper retrocompatível que devolve só
 * `.findings` — use esta função diretamente quando quiser visibilidade da
 * supressão (os dois CLIs deste módulo usam).
 */
export function detectLabelDriftDetailed(input: DetectLabelDriftInput): DetectLabelDriftResult {
  const { issueNumber, labels, commentBodies, planTexts = [], currentTrack } = input;
  // Issue já roteada pra fora da fila do overnight — a label que falta não
  // mudaria nada. Ver `currentTrack` em `DetectLabelDriftInput`.
  if (currentTrack !== undefined && currentTrack !== "overnight") {
    return { findings: [], suppressedByRoute: [] };
  }
  const labelSet = new Set(labels);
  // Uma entrada por (patternId) — sobrescrita a cada match mais recente,
  // já que `commentBodies` chega em ordem cronológica ascendente.
  const byPattern = new Map<string, DriftFinding>();
  const suppressedByPattern = new Map<string, SuppressedFinding>();

  // Roteamento explícito EM OU DEPOIS vence (#6283, #6301 finding 4 — ver
  // docstring do módulo): `hasRouteIssueAtOrAfter[i]` é true se
  // `commentBodies[i]` OU algum `commentBodies[j]`, j > i, contém — na
  // ABERTURA do corpo (`parseRouteIssueMarkerAtStart`, #6301 finding 2) — um
  // marcador `<!-- route-issue: track=X -->`. Inclusivo (`i` conta, não só
  // `j > i`) porque o próprio comentário do `routeIssue` é o candidato mais
  // provável a repetir a frase-gatilho que está revogando; sem a inclusão
  // ele nunca tinha nada "depois" de si mesmo e produzia achado contra a
  // própria prosa. Calculado de trás pra frente pra custar O(n) em vez de
  // O(n²).
  const hasRouteIssueAtOrAfter: boolean[] = new Array(commentBodies.length).fill(false);
  {
    let sawRouteAtOrAfter = false;
    for (let i = commentBodies.length - 1; i >= 0; i--) {
      const body = commentBodies[i];
      if (typeof body === "string" && parseRouteIssueMarkerAtStart(body) !== null) {
        sawRouteAtOrAfter = true;
      }
      hasRouteIssueAtOrAfter[i] = sawRouteAtOrAfter;
    }
  }

  // Comentários primeiro, textos do plano depois: o `set` por patternId faz o
  // ÚLTIMO match vencer, e entre as duas fontes o plano é a melhor evidência
  // (veredito estruturado do coordenador, não prosa livre). Dentro dos
  // comentários a ordem cronológica ascendente preserva "mais recente vence".
  const sources: Array<{ text: unknown; source: DriftSource; commentIndex?: number }> = [
    ...commentBodies.map((text, commentIndex) => ({ text, source: "comment" as const, commentIndex })),
    ...planTexts.map((text) => ({ text, source: "plan" as const })),
  ];

  for (const { text: raw, source, commentIndex } of sources) {
    if (typeof raw !== "string") continue;
    // Ver "Roteamento explícito posterior vence (#6283)" na docstring do
    // módulo — só se aplica a comentários (`planTexts` não tem posição
    // cronológica conhecida em relação aos comentários do GitHub). Não
    // pula o comentário inteiro: ele ainda é varrido pelos padrões, só pra
    // alimentar `suppressedByRoute` em vez de `byPattern` (#6301 finding 1)
    // — a supressão fica visível, não silenciosa.
    const isSuppressedByRoute =
      source === "comment" && commentIndex !== undefined && hasRouteIssueAtOrAfter[commentIndex];
    const prose = stripHtmlComments(raw);
    for (const pattern of DRIFT_PATTERNS) {
      let match: RegExpExecArray | null = null;
      for (const re of pattern.textPatterns) {
        const m = re.exec(prose);
        if (m) {
          match = m;
          break;
        }
      }
      if (!match) continue;
      const satisfied =
        labelSet.has(UNIVERSAL_SATISFYING_LABEL) ||
        pattern.expectedLabels.some((l) => labelSet.has(l));
      if (satisfied) {
        // Label já bate no snapshot atual — nenhum achado pra este padrão
        // (nem real, nem suprimido: já está resolvido de qualquer jeito),
        // independente de comentário anterior ter casado sem a label (ver
        // docstring do módulo, seção "Dedup": `labelSet` é fixo pro loop
        // inteiro, então `satisfied` nunca alterna de false pra true dentro
        // de uma mesma varredura; não há achado pendente pra remover aqui).
        continue;
      }
      if (isSuppressedByRoute) {
        suppressedByPattern.set(pattern.id, {
          issueNumber,
          patternId: pattern.id,
          description: pattern.description,
          commentExcerpt: buildExcerpt(prose, match),
        });
        continue;
      }
      byPattern.set(pattern.id, {
        issueNumber,
        patternId: pattern.id,
        description: pattern.description,
        expectedLabels: pattern.expectedLabels,
        actualLabels: labels,
        commentExcerpt: buildExcerpt(prose, match),
        source,
      });
    }
  }

  return {
    findings: Array.from(byPattern.values()),
    suppressedByRoute: Array.from(suppressedByPattern.values()),
  };
}

/**
 * Wrapper retrocompatível (#6301 finding 1) — devolve só os achados reais,
 * mesma assinatura de sempre (`DriftFinding[]`). Todo caller existente (e
 * todo teste existente) continua funcionando sem mudança. Use
 * `detectLabelDriftDetailed` diretamente pra também ver `suppressedByRoute`.
 */
export function detectLabelDrift(input: DetectLabelDriftInput): DriftFinding[] {
  return detectLabelDriftDetailed(input).findings;
}
