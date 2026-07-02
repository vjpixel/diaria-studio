# Beehiiv → Kit: comparativo + spike técnico (arquivado)

> **Status: PAUSADA INDEFINIDAMENTE.** Decisão do editor (briefing 2026-06-13): a migração Beehiiv → Kit está pausada sem previsão. Todas as issues relacionadas (#463, #464, #466, #467, #471, #472, #473) foram marcadas `on-hold` e saem dos briefings overnight/develop até serem reativadas — remover o label `on-hold` quando a parceria/conta Kit avançar. O testbed que motivou o hold original (digest mensal Clarice em Kit, #471-473) não avançou; a Clarice migrou de fato para **Brevo** (ver `docs/clarice-unified-db.md` e memory `clarice-store-2647`), não Kit. As issues técnicas #463/#464/#466/#467 (Kit pra Diar.ia diária) seguem abertas mas bloqueadas — não trabalhar nelas sem reativação explícita do editor.
>
> Este doc consolida os 2 documentos originais (`beehiiv-vs-kit-comparison.md` — pesquisa pública de mercado — e `beehiiv-to-kit-migration-spike.md` — spike técnico de inventário/esforço), preservando análise e racional. Números/preços coletados em abril-maio/2026; reverificar antes de qualquer decisão de compra caso a migração seja retomada.

---

## Parte 1 — Comparativo de mercado (Beehiiv vs Kit vs Substack)

Pesquisa pública pra acelerar a Fase 0 da issue #84 (decisão de migração da Diar.ia). **Não substitui** validação prática (free trial Kit + envio experimental).

### Tabela resumo

| Critério | Beehiiv | Kit (ConvertKit) | Substack |
|---|---|---|---|
| **Plano free** | Launch — até 2.500 subs, sends ilimitados, core completo | Newsletter — até 10.000 subs, broadcasts ilimitados, formulários ilimitados | Free indefinido se publicação for grátis (sem fee) |
| **Próximo tier** | Scale — $49/mês ($43 anual) | Creator — $39/mês ($33 anual) pra 1.000 subs | Sem tier mensal — modelo é % revenue |
| **Tier top** | Max — $109/mês ($96 anual) | Pro — $79/mês ($66 anual) pra 1.000 subs | Mesmo modelo (sem tier) |
| **Modelo de receita** | Subscription mensal por subs | Subscription mensal por subs | **10% cut em paid subs** + Stripe (~13-16% efetivo) |
| **Preço escala** | Beehiiv preço varia por subs (3 tiers) | Creator $39-$199/mês conforme subs (1k-25k); Pro $79-$279/mês | Zero fixo, mas % corta receita conforme cresce |
| **Custom HTML block** | ⚠️ Apenas em planos pagos (Scale/Max) — HTML Snippet inline. Launch (free) NÃO tem. Limites: sem `<script>`, sem `<style>`, sem iframes em email. | ✅ Em todos os planos — "HTML Block" como content block. Permite CSS inline. | ❌ **Não tem** — editor é blocks-only, sem HTML raw em emails |
| **Templates customizáveis** | Visual editor + custom HTML em posts | Visual + HTML Template Editor (mutuamente exclusivos por template) | Editor block-based fixo. Customização via configuração de marca, sem custom layouts. |
| **API** | API REST completa em todos os planos. **Não expõe poll responses individuais.** | API completa em **todos** os planos (free incluso). Documentação aberta. | ❌ **Sem API pública oficial.** Existe API privada via reverse-engineering com cookie auth — frágil, sem suporte. |
| **MCP connector (claude.ai)** | ✅ Disponível (`mcp__..._Beehiiv__*`) e em uso na pipeline | ❌ Não confirmado MCP oficial | ❌ Não tem; libs não-oficiais Python/TS via reverse-engineering |
| **Test email** | ✅ Nativo via dashboard + API | ✅ Nativo via dashboard | ✅ Nativo no editor |
| **Deliverability** | "Optimized Deliverability" core feature | Reputação histórica forte (10+ anos), Pro tem deliverability reporting | Generally bom, mas alguns relatos de spam folder em domínios específicos |
| **Polls/surveys** | Polls inline (Voting + Trivia), surveys, formulários nativos | Forms ilimitados em todos os planos, sequencias automáticas | Polls inline nativos, com dashboard. Sem export estruturado pelo API. |
| **Analytics** | Aggregate stats em todos os planos; advanced analytics no Scale | Padrão em todos; advanced reporting + insight dashboard no Pro | Open rate, CTR, growth básicos no dashboard; sem export robusto |
| **Segmentation/automations** | Segmentos por tag, automações | Segmentação avançada, sequências, A/B testing (Creator+) | ❌ Sem segmentação avançada, sem A/B, sem automations |
| **Branding remove** | Apenas Max ($109/mês) | Apenas Pro ($79/mês) | Sempre tem branding "powered by Substack" + recommendation widget |
| **Custom domain** | Incluso | Incluso | $50 one-time fee |
| **Discovery/network** | Limitado | Limitado | **Forte** — Substack Notes + recommendations cross-publication são canal de growth real |

### Implicações pro pipeline Diar.ia

1. **Custom HTML (#74)** — Kit livre em todos os planos; Beehiiv só em Scale/Max; Substack indisponível. Pra Diar.ia (Max hoje), Custom HTML continua coberto.
2. **API + MCP** — Beehiiv tem REST API + MCP em uso (`scripts/refresh-dedup.ts` via REST direto, audience update via MCP). Kit tem API completa sem MCP oficial — migrar = ~50-100 linhas de HTTP/auth. Substack não tem API oficial — pipeline não funcionaria sem reverse-engineer + cookie auth, risco alto pra automação editorial.
3. **Modelo de receita** — Beehiiv/Kit: subscription mensal (Diar.ia paga zero hoje, Beehiiv Launch free). Substack: zero mensal mas 10% revenue cut se virar paid — ponto de virada ~$680/mês de receita paid vs Beehiiv Max.
4. **Polls / surveys (#107)** — Beehiiv tem polls inline (incl. Trivia) com aggregate stats via API. Kit foca em forms/sequences, menos natural pro caso de uso É IA?. Substack tem polls sem export API estruturado.
5. **Discovery network** — Substack tem vantagem real aqui (recommendation engine cross-publication), mas fortemente US-centric — utilidade incerta pra Diar.ia (foco editorial brasileiro).
6. **Migração de dados** — Beehiiv → Kit/Substack: subscribers via CSV, edições passadas perdidas. Beehiiv → Substack: import nativo de subscribers, mas Custom HTML não migra.

### Trade-offs principais

| Argumentos pra migrar pra **Kit** | Argumentos pra migrar pra **Substack** | Argumentos pra **ficar no Beehiiv** |
|---|---|---|
| Free tier 4× maior (10k vs 2.5k subs) | Modelo "free pra sempre" se publicação não é paid | Custom HTML disponível em Scale/Max (planos atuais) — pipeline intacta |
| API completa, possível MCP no futuro | Discovery network forte (US-centric) | MCP integrado e em uso |
| Pricing previsível por subs | Zero overhead de billing mensal | Pipeline existente roda; migração = 2-3 PRs grandes |
| Possível API pra poll responses (a confirmar) | Brand "Substack" tem reconhecimento creator-economy | Polls inline + Trivia (relevante pra #107) |

| Argumentos contra **Kit** | Argumentos contra **Substack** | Argumentos contra **ficar no Beehiiv** |
|---|---|---|
| Custo de migração + perda de MCP | **Sem API pública oficial** — pipeline quebraria | Custo se ultrapassar 10k subs |
| Pricing por subs encarece | Custom HTML inexistente — perda de feature | API não expõe poll responses individuais |
| Sem MCP oficial confirmado | 10% revenue cut se virar paid | |

### Beehiiv: o que cada plano dá pra Diar.ia

Diar.ia estava no **Max ($109/mo)** na época da pesquisa. Comparativo dos 3 tiers pelo que a pipeline usa:

| Feature usada na pipeline | Launch (free) | Scale ($49/mo) | Max ($109/mo) |
|---|---|---|---|
| Limite de subs | 2.500 | até 100k | até 100k |
| Custom HTML block (#74 fluxo) | ❌ | ✅ | ✅ |
| Polls (Voting + Trivia) — É IA? | ❌ | ✅ | ✅ |
| API REST + MCP | ✅ | ✅ | ✅ |
| **Branding remove** ("Powered by Beehiiv") | ❌ | ❌ | ✅ |
| Dynamic content | ❌ | ❌ | ✅ |

**Cenários**: Max → Launch (downgrade free) quebra a pipeline (perde Custom HTML + Polls + limite 2.5k subs). Max → Scale ($635/ano de economia) mantém a pipeline intacta, perdendo só branding remove + dynamic content + priority support. Manter Max vale se branding remove for valor editorial não-negociável.

### Recomendação da pesquisa (maio/2026, antes do hold)

**Não migrar imediatamente por trigger de custo** — o trigger original da #84 (custom HTML como upgrade caro) não existia mais no momento da pesquisa (Beehiiv tem custom HTML grátis em Scale). Substack não recomendado (falta de API oficial mata a automação editorial). Reconsiderar se: Diar.ia ultrapassar 10k subs, Beehiiv API quebrar/mudar contrato, ou feature crítica nova só aparecer em outra plataforma.

**Fontes**: [Beehiiv Pricing](https://www.beehiiv.com/pricing) · [Beehiiv custom HTML](https://product.beehiiv.com/p/introducing-custom-html-blocks-richtext-welcome-emails-additional-headers-support-center) · [Kit Pricing](https://kit.com/pricing) · [Kit custom HTML template](https://help.kit.com/en/articles/2810363-creating-a-custom-html-email-template) · [Substack pricing](https://support.substack.com/hc/en-us/articles/360037607131-How-much-does-Substack-cost) · [Substack Developer API](https://support.substack.com/hc/en-us/articles/45099095296916-Substack-Developer-API) · [Beehiiv polls CSV export](https://www.beehiiv.com/support/article/13063381953303-How-to-export-poll-data)

---

## Parte 2 — Spike técnico: inventário e esforço de migração (#461)

Sequência original decidida em 2026-05-08 (Pixel): "A migração da Diar.ia para o Kit só vai ocorrer depois de termos o Kit no mensal com a Clarice." Essa sequência **não se concretizou como planejado** — a Clarice adotou Brevo, não Kit, pro digest mensal (ver Status acima). O inventário técnico abaixo permanece válido como checklist caso a migração seja retomada no futuro.

### 1. Inventário Beehiiv (pontos de contato)

| Localização | O que faz | Beehiiv API endpoint |
|---|---|---|
| `scripts/refresh-dedup.ts` | Lista posts publicados pra dedup | `GET /publications/{pubId}/posts` + `GET /posts/{postId}` |
| `scripts/fetch-monthly-posts.ts` | Lista posts do mês pro digest mensal | mesmo |
| `scripts/refresh-past-editions.ts` | Lê HTML de cada post pra extrair links | `GET /posts/{postId}?expand=free_email_content` |
| `scripts/fetch-beehiiv-poll-stats.ts` | Lê respostas do poll É IA? | `GET /publications/{pubId}/posts/{postId}/polls/{pollId}/responses` |
| `scripts/collect-edition-signals.ts` | Stats de post (open rate, CTR) | `GET /posts/{postId}/stats` |

Chrome automation (sem API): `publish-newsletter` (navega composer, cola HTML, upload de imagens, test email — hoje via fluxo Worker-hosted, ver `context/publishers/beehiiv-playbook.md`), `upload-images-public.ts` (Drive como CDN). Audience/forms: `scripts/update-audience.ts` via `mcp__claude_ai_Beehiiv__list_survey_responses`.

Total: ~10 scripts/agents que tocam Beehiiv direta ou indiretamente.

### 2. Equivalentes em Kit

- **Posts/Broadcasts**: Kit tem `broadcasts` com API REST oficial — cria draft, envia test email e envia 100% via API (resolveria #275 integralmente, sem browser automation).
- **Subscribers**: API `/subscribers` similar. **Survey**: Kit não tem survey nativo — usar Form ou Tally embed. **Polls**: Kit sem poll module — pra É IA?, decisão (#465, já fechada) era substituir Poll Trivia por Tally embed.
- **Tags/segments**: Kit tem tags leves + segments (queries persistidas); non-blocking pra migração.
- **Domain**: ambos suportam custom domain; DNS cutover (#467) precisa ser orquestrado pra zero downtime.

### 3. Esforço estimado por componente (30-40h total)

| Componente | Esforço | Bloqueio |
|---|---|---|
| #463 mcp-kit + refresh-dedup migration | 4-6h | Kit API key |
| #464 publish-newsletter Kit API | 6-8h | Kit API key + template |
| #466 audience update via Kit forms | 3-4h | Kit subscribers list importada |
| #467 DNS cutover diar.ia.br | 1h editor + 24h DNS propagation | one-time, requer downtime mín |
| #471 multi-account suporte (Clarice) | 4-5h | #472 conta Kit Clarice criada |
| #473 publish-monthly via Kit | 4-6h | #471 |
| Tests + docs + cleanup | 6-8h | n/a |

### 4. Caminho de migração proposto (referência futura)

Fase 0 — Preparação (conta Kit, import subscribers CSV, custom domain, template, API key). Fase 1 — Code paralelo (PRs atrás de feature flag `platform.publishing.newsletter`, pipeline ainda publica em Beehiiv). Fase 2 — Edição paralela (1 edição nos dois, comparar open rate/render/deliverability). Fase 3 — Switchover (flag muda pra `kit`, DNS cutover, monitorar 48h). Fase 4 — Cleanup (remover Beehiiv Chrome automation, downgrade/cancelar conta Beehiiv).

**Critério de abort** (se retomado): open rate Kit < 80% Beehiiv, render quebra em >2 plataformas de email, subscribers segmentation impossível replicar.

### 5. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Kit broadcast HTML render diferente Beehiiv | Alta | Testar N edições em paralelo antes de switchover |
| Subscribers import perde campos custom | Média | Preservar Beehiiv até validação completa |
| DNS cutover causa downtime | Baixa | Schedule fora do horário de envio (madrugada BRT) |
| Poll Trivia → Tally introduz fricção UX | Média | Wireframe/mock antes de switch |
| Custos Kit > Beehiiv | Baixa-média | Cotizar plan tier conforme list size |

### Refs

- #84, #461 (issues de scoping — fechadas)
- #463, #464, #466, #467, #471, #472, #473 (sub-issues técnicas — abertas, `on-hold`)
- `docs/clarice-unified-db.md` (rota real adotada pra Clarice: Brevo, não Kit)
