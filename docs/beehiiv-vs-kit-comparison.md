# Beehiiv vs Kit vs Substack — Comparativo Fase 0

Pesquisa pública pra acelerar a Fase 0 da issue #84 (decisão de migração da Diar.ia). **Não substitui** validação prática (free trial Kit + envio experimental). Números coletados em abril/2026; reverificar antes de qualquer decisão de compra.

## Tabela resumo

| Critério | Beehiiv | Kit (ConvertKit) | Substack |
|---|---|---|---|
| **Plano free** | Launch — até 2.500 subs, sends ilimitados, core completo | Newsletter — até 10.000 subs, broadcasts ilimitados, formulários ilimitados | Free indefinido se publicação for grátis (sem fee) |
| **Próximo tier** | Scale — $49/mês ($43 anual) | Creator — $39/mês ($33 anual) pra 1.000 subs | Sem tier mensal — modelo é % revenue |
| **Tier top** | Max — $109/mês ($96 anual) | Pro — $79/mês ($66 anual) pra 1.000 subs | Mesmo modelo (sem tier) |
| **Modelo de receita** | Subscription mensal por subs | Subscription mensal por subs | **10% cut em paid subs** + Stripe (~13-16% efetivo) |
| **Preço escala** | Beehiiv preço varia por subs (3 tiers) | Creator $39-$199/mês conforme subs (1k-25k); Pro $79-$279/mês | Zero fixo, mas % corta receita conforme cresce |
| **Custom HTML block** | ⚠️ Apenas em planos pagos (Scale/Max) — HTML Snippet inline. Launch (free) NÃO tem. Limites: sem `<script>`, sem `<style>`, sem iframes em email. | ✅ Em todos os planos — "HTML Block" como content block. Permite CSS inline. | ❌ **Não tem** — editor é blocks-only, sem HTML raw em emails |
| **Templates customizáveis** | Visual editor + custom HTML em posts | Visual + HTML Template Editor (mutuamente exclusivos por template) | Editor block-based fixo. Customização via configuração de marca, sem custom layouts. |
| **API** | API REST completa em todos os planos. **Não expõe poll responses individuais.** | API completa em **todos** os planos (free incluso). Documentação aberta. | ❌ **Sem API pública oficial.** Existe API privada que dá pra usar via reverse-engineering com cookie auth — frágil, sem suporte. |
| **MCP connector (claude.ai)** | ✅ Disponível (`mcp__..._Beehiiv__*`) e em uso na pipeline | ❌ Não confirmado MCP oficial | ❌ Não tem; libs não-oficiais Python/TS via reverse-engineering |
| **Test email** | ✅ Nativo via dashboard + API | ✅ Nativo via dashboard | ✅ Nativo no editor |
| **Deliverability** | "Optimized Deliverability" core feature | Reputação histórica forte (10+ anos), Pro tem deliverability reporting | Generally bom, mas alguns relatos de spam folder em domínios específicos |
| **Polls/surveys** | Polls inline (Voting + Trivia), surveys, formulários nativos | Forms ilimitados em todos os planos, sequencias automáticas | Polls inline nativos, com dashboard. Sem export estruturado pelo API. |
| **Analytics** | Aggregate stats em todos os planos; advanced analytics no Scale | Padrão em todos; advanced reporting + insight dashboard no Pro | Open rate, CTR, growth básicos no dashboard; sem export robusto |
| **Segmentation/automations** | Segmentos por tag, automações | Segmentação avançada, sequências, A/B testing (Creator+) | ❌ Sem segmentação avançada, sem A/B, sem automations |
| **Branding remove** | Apenas Max ($109/mês) | Apenas Pro ($79/mês) | Sempre tem branding "powered by Substack" + recommendation widget |
| **Custom domain** | Incluso | Incluso | $50 one-time fee |
| **Discovery/network** | Limitado | Limitado | **Forte** — Substack Notes + recommendations cross-publication são canal de growth real |

## Implicações pro pipeline Diar.ia

### 1. Custom HTML (#74) — Kit livre; Beehiiv só nos planos pagos; Substack indisponível

**Correção** (vs versão anterior do doc): Beehiiv NÃO tem Custom HTML no plano Launch (free) — só em Scale ($49/mo) ou Max ($109/mo). Kit oferece em todos os planos. Substack não tem.

Pra Diar.ia (que está no Max hoje): Custom HTML continua coberto. Mas se considerar downgrade pra Launch, perde o feature e precisa voltar pro fluxo block-by-block legacy (#74).

### 2. API + MCP

- **Beehiiv**: REST API + MCP em uso (`scripts/refresh-dedup.ts` via REST direto, audience update via MCP). Pipeline integrada.
- **Kit**: API completa, sem MCP oficial. Migrar = ~50-100 linhas de HTTP/auth.
- **Substack**: API não-oficial. Pipeline atual não funcionaria sem reverse-engineer + cookie auth — frágil, pode quebrar a qualquer release. **Risco alto pra automação editorial**.

### 3. Modelo de receita

- **Beehiiv/Kit**: subscription mensal. Diar.ia paga zero hoje (Beehiiv Launch free).
- **Substack**: zero mensal, mas se Diar.ia algum dia virar paid, 10% revenue cut + Stripe fees corta ~16% da receita. Vs Beehiiv Max ($109/mês) que mantém 100% da receita: ponto de virada é em ~$680/mês de receita paid (acima disso, Beehiiv fica mais barato).
- **Pra newsletter free** (caso atual da Diar.ia): Beehiiv e Substack são equivalentes em custo zero; Kit precisaria Creator se passar de 10k subs.

### 4. Polls / surveys (relevante pra #107)

- **Beehiiv**: tem polls inline (incluindo Trivia que estamos testando). API expõe aggregate stats — possivelmente Trivia stats também.
- **Kit**: focado em forms/sequences, não polls inline. Menos natural pro caso de uso É IA?.
- **Substack**: tem polls inline com dashboard, sem export API estruturado.

### 5. Discovery network

Substack tem vantagem real aqui — recommendation engine cross-publication impulsiona growth orgânico. Beehiiv e Kit têm "recommendations" como feature paga (SparkLoop integration etc.), menos integradas.

Pra Diar.ia atual (foco editorial brasileiro), o network do Substack é fortemente US-centric — utilidade incerta.

### 6. Migração de dados

- **Beehiiv → Kit/Substack**: subscribers via CSV. Edições passadas perdidas (ou exportadas como standalone).
- **Beehiiv → Substack**: import nativo de subscribers. Mas Custom HTML existente não migra (Substack não tem).

## Trade-offs principais

| Argumentos pra migrar pra **Kit** | Argumentos pra migrar pra **Substack** | Argumentos pra **ficar no Beehiiv** |
|---|---|---|
| Free tier 4× maior (10k vs 2.5k subs) | Modelo "free pra sempre" se publicação não é paid | Custom HTML disponível em Scale/Max (planos atuais da Diar.ia) — pipeline atual continua intacta |
| API completa, possível MCP no futuro | Discovery network forte (US-centric) | MCP integrado e em uso |
| Pricing previsível por subs | Zero overhead de billing mensal | Pipeline existente roda; migração = 2-3 PRs grandes |
| Possível API pra poll responses (a confirmar) | Brand "Substack" tem reconhecimento creator-economy | Polls inline + Trivia (relevante pra #107) |
| | | Pricing previsível, competitivo até ~5k subs |

| Argumentos contra **Kit** | Argumentos contra **Substack** | Argumentos contra **ficar no Beehiiv** |
|---|---|---|
| Custo de migração + perda de MCP | **Sem API pública oficial** — pipeline atual quebraria | Custo se ultrapassar 10k subs |
| Pricing por subs encarece | Custom HTML inexistente — perda de feature | API não expõe poll responses individuais |
| Sem MCP oficial confirmado | 10% revenue cut se virar paid | |
| | Limites em segmentation/automation | |

## Beehiiv: o que cada plano dá pra Diar.ia (decisão de tier)

Diar.ia hoje está no **Max ($109/mo)**. A migração entre planos é mais barata que migrar de plataforma. Comparativo dos 3 tiers Beehiiv pelo que a pipeline atual usa:

| Feature usada na pipeline | Launch (free) | Scale ($49/mo) | Max ($109/mo) |
|---|---|---|---|
| Limite de subs | 2.500 | até 100k | até 100k |
| Custom HTML block (#74 fluxo) | ❌ | ✅ | ✅ |
| Polls (Voting + Trivia) — É IA? | ❌ | ✅ | ✅ |
| API REST + MCP | ✅ | ✅ | ✅ |
| Test email | ✅ | ✅ | ✅ |
| Custom domain (`diar.ia.br`) | ✅ | ✅ | ✅ |
| Audience segmentation | ✅ | ✅ | ✅ |
| Unlimited sends | ✅ | ✅ | ✅ |
| Aggregate stats (analytics básico) | ✅ | ✅ | ✅ |
| Advanced analytics | ❌ | ✅ | ✅ |
| A/B testing | ❌ | ✅ | ✅ |
| Email automations | ❌ | ✅ | ✅ |
| Subscriber transfer | ❌ | ✅ | ✅ |
| Priority support | ❌ | ✅ | ✅ |
| **Branding remove** ("Powered by Beehiiv") | ❌ | ❌ | ✅ |
| Dynamic content | ❌ | ❌ | ✅ |
| Múltiplas publicações | 1 | até 3 | até 10 |
| White glove migration | ❌ | ❌ | ✅ |

### Cenários

- **Max → Launch (downgrade pro free)**: ❌ **Quebra a pipeline.** Perde Custom HTML (#74 quebra) + Polls (É IA? quebra) + limite de 2.5k subs. Não é viável dado o estado atual.
- **Max → Scale ($49/mo, $635/ano de economia)**: ✅ **Pipeline intacta.** Tudo que a pipeline usa continua funcionando. Você perde apenas: branding remove ("Powered by Beehiiv" volta no footer), dynamic content (não usado), ≤10 publicações (você tem 1), priority support, white glove migration assistance.
- **Manter Max ($109/mo)**: vale apenas se branding remove for valor editorial não-negociável OU se planeja spin-off (#60) que precise de mais publicações no mesmo workspace.

### Recomendação por cenário

- **Branding remove é importante editorialmente?** Mantenha Max.
- **Branding remove é aceitável trocar por $635/ano?** Migre pra Scale. Pipeline intacta, único custo visual é "Powered by Beehiiv" no footer da newsletter.
- **Pretende spin-off Diar.ia Claude (#60)?** Max é mais barato que abrir 2 contas Scale ($98/mo > $109/mo) — desde que decida ativar #60.

## Recomendação resumida

**Não migre agora.** O trigger original da #84 (custom HTML como upgrade caro) **não existe mais** — Beehiiv tem custom HTML grátis em todos os planos. Os ganhos de migrar (free tier maior do Kit, network do Substack) são incrementais; o custo (refactor de 50-100 linhas + perda de MCP + risco de regressão) é alto.

**Substack particularmente não recomendado** pra Diar.ia: a falta de API oficial mata a automação editorial existente. Faz sentido pra creator solo que escreve manual; não pra pipeline de orchestration como a nossa.

**Quando reconsiderar:**
- Se Diar.ia ultrapassar 10k subs com Beehiiv ficando caro vs alternativas.
- Se Beehiiv API quebrar / mudar contrato significativamente.
- Se feature crítica nova só aparecer em outra plataforma (ex: poll API, segmentation avançada).
- Se a Diar.ia decidir spin-off (#60) e precisar de plataforma adicional — aí Kit free poderia hospedar o experimento sem custo (ou Substack se foco for discovery US).

## Fontes

- [Beehiiv Pricing 2026](https://www.beehiiv.com/pricing)
- [Beehiiv custom HTML feature](https://product.beehiiv.com/p/introducing-custom-html-blocks-richtext-welcome-emails-additional-headers-support-center)
- [Kit Pricing 2026](https://kit.com/pricing)
- [Kit custom HTML template](https://help.kit.com/en/articles/2810363-creating-a-custom-html-email-template)
- [Substack pricing official](https://support.substack.com/hc/en-us/articles/360037607131-How-much-does-Substack-cost)
- [Substack Developer API (LinkedIn-only)](https://support.substack.com/hc/en-us/articles/45099095296916-Substack-Developer-API)
- [Beehiiv polls CSV export](https://www.beehiiv.com/support/article/13063381953303-How-to-export-poll-data) (relevante pra #107)
