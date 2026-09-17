# Effort do review automatizado (#4234)

Movido do `CLAUDE.md` na rodada de enxugamento do #8228 — a regra viva ficou
lá em 1-2 linhas; a trajetória de decisão e o mecanismo completo ficam aqui.

## Trajetória (`low` → `max`)

`max` por padrão desde 260728 (#4234); overnight resolve por limiar de diff
PRÓPRIO desde #6393 (260827). `.claude/hooks/pr-create-review.mjs` resolve o
effort de toda PR criada via `gh pr create`.

**Overnight** (branch `overnight/*` ou sessão overnight ativa) NÃO é mais
`low` incondicional — deixou de ser desde o #6393, que corrigiu uma
assimetria invertida em relação ao risco (o fluxo desassistido recebia
sempre o review mais fraco): resolve por tamanho de diff contra
`OVERNIGHT_EFFORT_DIFF_LINE_THRESHOLD` (1000 linhas, maior que o limiar
geral de propósito — overnight continua mais barato que develop no mesmo
tamanho de diff) — diff conhecido < 1000 → `low`; diff conhecido ≥ 1000 →
`max`; tamanho DESCONHECIDO (gh indisponível, JSON malformado) → `low`
(fail-direction barata preservada do comportamento pré-#6393, diferente do
caminho geral).

**Qualquer outro caso** (sem sinal de overnight) resolve por TAMANHO DE DIFF
desde #4813 (não mais direto pelo `DEFAULT_EFFORT`) — diff abaixo de
`EFFORT_DIFF_LINE_THRESHOLD` (500 linhas somando adições+remoções desde
#5420, 260816; era 300) → `low`; diff conhecido ≥ limiar → `max`; tamanho
DESCONHECIDO cai no `DEFAULT_EFFORT`, hoje `max`, como fallback. Estado
indeterminado (gh indisponível, PR sem número na URL) → `max` como
fail-safe, independente do default. A mesma regra vale pro review ad-hoc
mid-sessão sem PR aberta.

**Decisão provisória do editor** — reverter é trocar a constante
`DEFAULT_EFFORT` por `"low"` no hook (uma linha; um único teste trava o
valor). Se o custo por PR voltar a incomodar, é essa constante que se mexe
(histórico completo da trajetória `low`→`max`:
`docs/claude-md-historical-incidents.md#princ-4234-effort-trajetoria`).

## Mecanismo executável (#4234)

Todo review automatizado — hook por PR e Fases 1.5 do overnight/develop —
dispatcha o agente `pr-review-toolkit:code-reviewer` (nome **prefixado**
pelo plugin; sem o prefixo dá `Agent type not found`) via ferramenta
**Agent** com `model: sonnet` explícito (#2019), sempre passando no prompt o
range de diff **explícito** (o agente revisa `git diff` unstaged por
default) e a restrição **somente leitura** (sem edição de arquivo,
`checkout`, `stash`, `reset` ou commit — o checkout pode ser compartilhado
com outra sessão, incidentes 260703/260708).

**Só o hook por PR ramifica por effort** — `low` = 1 agente; `max` = fleet
paralelo com `silent-failure-hunter`, `pr-test-analyzer`, `comment-analyzer`
e `type-design-analyzer`. As Fases 1.5 (review consolidado do
overnight/develop) dispatcham **sempre 1 agente**, sem ramificação por
effort: são mais leves por design, porque rodam sobre o diff acumulado da
rodada e o review leve por PR já passou antes.

Se o dispatch resolver `Agent type ... not found` (plugin ausente — sessão
cloud, clone fresco), cair no `general-purpose` com rubrico inline
(correctness, simplification/efficiency, test-coverage, security):
degradar pra review pior é aceitável, pular o review em silêncio não.

O comando `/code-review` em si segue **user-only** desde 260724 (gate de
plataforma, #4034) — o assistente não consegue invocá-lo, o editor sim.
