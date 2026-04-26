# Beehiiv vs Kit (ConvertKit) — Comparativo Fase 0

Pesquisa pública pra acelerar a Fase 0 da issue #84 (decisão de migração da Diar.ia). **Não substitui** validação prática (free trial Kit + envio experimental). Números coletados em abril/2026; reverificar antes de qualquer decisão de compra.

## Tabela resumo

| Critério | Beehiiv | Kit (ConvertKit) |
|---|---|---|
| **Plano free** | Launch — até 2.500 subs, sends ilimitados, core completo | Newsletter — até 10.000 subs, broadcasts ilimitados, formulários ilimitados |
| **Próximo tier** | Scale — $49/mês ($43 anual) | Creator — $39/mês ($33 anual) pra 1.000 subs |
| **Tier top** | Max — $109/mês ($96 anual) | Pro — $79/mês ($66 anual) pra 1.000 subs |
| **Preço escala** | Beehiiv preço varia por subs (3 tiers) | Creator $39-$199/mês conforme subs (1k-25k); Pro $79-$279/mês |
| **Custom HTML block** | ✅ Em todos os planos (incluindo free) — HTML Snippet inline. Limites: sem `<script>`, sem `<style>`, sem iframes em email. | ✅ Em todos os planos — "HTML Block" como content block. Permite CSS inline. |
| **Templates customizáveis** | Visual editor + custom HTML em posts | Dois modos: Visual Template Editor (sem código) **OU** HTML Template Editor (full HTML/CSS code). Mutuamente exclusivos por template. |
| **API** | API REST completa em todos os planos. Endpoints públicos: posts, subscriptions, publications, aggregate stats. **Não expõe poll responses individuais.** | API completa em **todos** os planos (free incluso). Documentação aberta. |
| **MCP connector (claude.ai)** | ✅ Disponível (`mcp__..._Beehiiv__*`) | ❌ Não confirmei MCP oficial. Precisaria HTTP direto via API key. |
| **Test email** | ✅ Nativo via dashboard + API | ✅ Nativo via dashboard |
| **Deliverability** | "Optimized Deliverability" core feature, em todos os planos | Reputação histórica forte (10+ anos no mercado), Pro tem deliverability reporting |
| **Surveys/forms** | Polls inline, surveys, formulários nativos | Forms ilimitados em todos os planos, sequencias automáticas |
| **Analytics** | Aggregate stats em todos os planos; advanced analytics no Scale | Padrão em todos; advanced reporting + insight dashboard no Pro |
| **Branding remove** | Apenas Max ($109/mês) | Apenas Pro ($79/mês) |

## Implicações pro pipeline Diar.ia

### 1. Custom HTML (#74) — paridade

Ambas plataformas têm custom HTML block em todos os planos. Não é mais um diferencial de pricing; nem precisa upgrade pra usar. **Resolve o trigger original da issue #84** (não há "upgrade caro pro custom HTML").

### 2. API + MCP

- **Beehiiv**: MCP integrado claude.ai já em uso (`refresh-dedup-runner` agent). Mudança de plataforma quebraria essa integração — substituir MCP calls por HTTP direto.
- **Kit**: API completa em todos os planos, mas sem MCP oficial confirmado. Pipeline atual usa Beehiiv MCP em pelo menos 2 lugares (refresh past-editions, audience update). Migrar pra Kit = ~50-100 linhas de código novo (HTTP + auth + retry).

### 3. Polls / surveys

Pipeline depende de Beehiiv polls pro É IA? (#107). **Achado relevante**: API Beehiiv não expõe poll responses individuais — só CSV export manual do dashboard. Se Kit tiver endpoint API pra poll responses, é vantagem real (#107 destrava). Não confirmei na pesquisa pública — Kit foca mais em forms/sequences que em polls inline tipo Beehiiv. **Ação sugerida na Fase 1**: testar criação de poll em Kit free trial e ver se respostas aparecem na API.

### 4. Preço comparado pra escala atual da Diar.ia

Sem o número exato de subs da Diar.ia hoje, range estimado:

- **< 1.000 subs**: Beehiiv free OU Kit free → ambos zero custo. Sem decisão.
- **1.000-2.500 subs**: Beehiiv free ainda OK. Kit precisa Creator ($39/mês). **Beehiiv ganha.**
- **2.500-5.000 subs**: Beehiiv Scale $49/mês. Kit Creator ~$50-79/mês. **Beehiiv levemente mais barato.**
- **5.000-10.000 subs**: Beehiiv Scale ~$79-99/mês. Kit Creator $79-119/mês. **Praticamente empate.**
- **> 10.000 subs**: Kit Creator $119+/mês. Beehiiv Max se quiser branding remove (~$109+/mês). **Beehiiv mais barato + Max já tem branding remove.**

### 5. Migração de dados

Ambos suportam CSV import/export de subscribers. Edições passadas (Beehiiv → Kit) seria perda de histórico web — Kit não importa posts de outras plataformas. Estratégia: manter Beehiiv como arquivo histórico read-only.

## Trade-offs principais

| Argumentos pra migrar pra Kit | Argumentos pra ficar no Beehiiv |
|---|---|
| Free tier 4× maior (10k vs 2.5k subs) | Custom HTML já em todos os planos — trigger original da #84 não existe mais |
| Brand "Kit" mais alinhado a creator economy | MCP connector já integrado e em uso na pipeline |
| Possível API pra poll responses (a confirmar) | Pipeline existente roda; migração é ~2-3 PRs grandes (#74, #84 da migration phase) |
| Pricing previsível (sem subscriber tier breakpoints surpresa) | Polls inline + surveys nativos; UX do É IA? está construída em cima |
| | Beehiiv preço estável e competitivo até ~5k subs |

## Recomendação resumida

**Não migre agora.** O trigger original da #84 (custom HTML como upgrade caro) **não existe mais** — Beehiiv tem custom HTML grátis em todos os planos. Os ganhos de migrar (free tier maior, possível API de polls) são incrementais; o custo (refactor de 50-100 linhas + perda de MCP + risco de regressão) é alto.

**Quando reconsiderar:**
- Se Diar.ia ultrapassar 10k subs com Beehiiv ficando caro vs alternativas.
- Se Beehiiv API quebrar / mudar contrato significativamente.
- Se feature crítica nova só aparecer no Kit (poll API, segmentation avançada, etc).
- Se a Diar.ia decidir spin-off (#60) e precisar de plataforma adicional — aí Kit free poderia hospedar o experimento sem custo.

## Fontes

- [Beehiiv Pricing 2026](https://www.beehiiv.com/pricing)
- [Beehiiv custom HTML feature](https://product.beehiiv.com/p/introducing-custom-html-blocks-richtext-welcome-emails-additional-headers-support-center)
- [Kit Pricing 2026](https://kit.com/pricing)
- [Kit custom HTML template](https://help.kit.com/en/articles/2810363-creating-a-custom-html-email-template)
- [Beehiiv polls CSV export](https://www.beehiiv.com/support/article/13063381953303-How-to-export-poll-data) (relevante pra #107)
