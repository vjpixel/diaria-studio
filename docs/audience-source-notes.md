# Audiência — fontes de cadastro conhecidas (registro de decisão)

Registro de **decisão editorial** sobre fontes de cadastro na Beehiiv que
poderiam, sem este documento, ser reinterpretadas como incidente/achado novo
por uma rodada futura (mesmo critério de `docs/seo-notes.md` — evita
reabrir uma investigação já concluída). Não é runbook de setup.

## Fonte 1 — SparkLoop Upscribe / Techzip Newsletter (`RH_SOURCE = sparkloop-upscribe`, #5095)

**Decisão do editor (12/ago/2026): parceiro é legítimo e conhecido — fica.**

### O que é

Burst de cadastros iniciado em 10/ago/2026 via integração SparkLoop Upscribe,
atribuídos ao parceiro `Techzip Newsletter` (`RH_PARTNER_NAME`). Identificável
pelos custom fields `RH_SOURCE = sparkloop-upscribe`, `RH_PARTNER =
partner_468f1346d513`, `RH_ISREF = YES`.

### O que já foi verificado, para não re-investigar do zero

- **A conta SparkLoop é do editor** — confirmado ao vivo (260812). Não é
  credencial de terceiro gravando cadastros na publicação sem autorização.
- **`Techzip Newsletter` é parceiro GRATUITO** (tier free do SparkLoop
  Upscribe) — sem cobrança por lead. O teto de aquisição de USD 0,50/
  assinante ativo (`CLAUDE.md` §Princípios operacionais) **não se aplica**
  aqui: não há custo por cadastro.
- **Perfil dos cadastros é anômalo** (majoritariamente e-mails corporativos
  US/anglófonos) para uma newsletter diária em pt-BR, mas a afirmação
  inicial de que "nunca vão abrir" foi **corrigida** — amostra de 4
  registros mostrou 1 com 66% de abertura e outro com 50%; os dois com 0%
  tinham recebido só 1-2 edições (cedo demais pra concluir inércia). O
  cohort não está comprovadamente inerte.
- **Risco remanescente, estreitado a UM vetor**: taxa de reclamação de spam
  (quem não lembra de ter se cadastrado tende a marcar spam em vez de
  descadastrar — limite do Gmail é 0,3%). Risco assimétrico mas de baixa
  urgência sem custo associado.

### Ação tomada

- **Nenhuma remoção de cadastro** — decisão explícita do editor (é ação
  outward-facing, não autorizada; "adiado, reabrir se/quando o volume
  justificar").
- **Double opt-in reativado na Beehiiv** (motivado por esta issue, mas
  rastreado separadamente em #5167 — inclui o trade-off no funil de tráfego
  frio SEO/GEO).
- **Segmento de exclusão implementado** (`scripts/sync-sparkloop-exclusion-segment-beehiiv.ts`,
  PR #5098) — filtra assinantes por `RH_SOURCE = sparkloop-upscribe`, pra que
  o cohort não contamine métricas de engajamento agregadas (CTR
  comportamental do `audience-profile`, circuit breakers, baseline de open
  rate). Dry-run por padrão; `--push` cria o segmento de verdade na Beehiiv
  — pendente de execução manual pelo editor (guard de publicação do
  overnight/develop não executa isso ao vivo).

### Quando reabrir

Se o volume crescer materialmente além do ritmo observado em ago/2026
(~2/hora), se a taxa de reclamação de spam medida via
`Diaria-Postmaster-Spam-Sync` subir de forma atribuível a este cohort, ou se
o editor decidir revisitar a manutenção dos ~18 cadastros já existentes.

Fonte completa: issue #5095 (todos os comentários, não só o corpo original —
a investigação evoluiu bastante entre a abertura e a decisão final).

## Quando adicionar entry aqui

Mesmo critério de `context/agents-known-issues.md`/`docs/seo-notes.md`: uma
fonte de tráfego/cadastro cuja origem, legitimidade ou decisão de manter/
remover já foi apurada e decidida, e que uma auditoria futura (overnight,
develop, ou o próprio editor lendo métricas frias) poderia "descobrir" de
novo e tratar como incidente inédito.
