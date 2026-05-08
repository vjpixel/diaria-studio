# Spike: Beehiiv → Kit migration (#461)

Versão: draft 2026-05-08 · Owner: Pixel · Status: **on hold — aguardando Clarice mensal Kit testbed**

> **Decisão editorial 2026-05-08 (Pixel):** "A migração da Diar.ia para o Kit só vai ocorrer depois de termos o Kit no mensal com a Clarice." Sequência fixa: (1) Kit funciona no mensal Clarice (#471, #472, #473) → (2) coletar dados de 1-2 ciclos mensais → (3) **só então** avaliar migrar Diar.ia diária. Este spike fica como referência técnica pra esse momento futuro.

## Contexto

Meta original: migrar Diar.ia + digest mensal Clarice do **Beehiiv** para o **Kit (ConvertKit)**. Motivações: (a) preço Beehiiv Max tier vs Kit equivalente, (b) dificuldades automatizadas de publicação Beehiiv (#275, #312), (c) testbed Clarice precisa de conta separável que Kit suporta nativamente.

**Sequência atualizada após decisão 2026-05-08:**
1. **Setup Kit pro mensal Clarice** (#471 multi-account, #472 conta Kit Clarice, #473 publish-monthly via Kit) — em andamento
2. **Rodar 1-2 ciclos mensais Clarice** com Kit como fonte de verdade — coleta dados reais
3. **Avaliar resultado**: open rate Kit vs Beehiiv, deliverability, render, custo, esforço de manutenção
4. **Só então decidir** migração Diar.ia diária (#84, #461, #463, #464, #466, #467) com base em dados de produção, não estimativa

Este spike levanta **o que precisa mudar** sem implementar ainda. Resultado pretendido: checklist técnica clara + estimativa de esforço por componente, pra editor decidir Go/No-Go com data **quando o testbed Clarice tiver gerado dados suficientes**.

## 1. Inventário Beehiiv atual

Auditei o código pra mapear todos os pontos de contato com Beehiiv:

### MCP / API calls

| Localização | O que faz | Beehiiv API endpoint |
|---|---|---|
| `scripts/refresh-dedup.ts` | Lista posts publicados pra dedup | `GET /publications/{pubId}/posts` + `GET /posts/{postId}` |
| `scripts/fetch-monthly-posts.ts` | Lista posts do mês pro digest mensal | mesmo |
| `scripts/refresh-past-editions.ts` | Lê HTML de cada post pra extrair links | `GET /posts/{postId}?expand=free_email_content` |
| `scripts/fetch-beehiiv-poll-stats.ts` | Lê respostas do poll É IA? | `GET /publications/{pubId}/posts/{postId}/polls/{pollId}/responses` |
| `scripts/collect-edition-signals.ts` | Stats de post (open rate, CTR) | `GET /posts/{postId}/stats` |

### Chrome automation (sem API)

- **`publish-newsletter` agent**: navega Beehiiv composer, cola HTML em Custom HTML block, faz upload de imagens, dispara test email. Bloqueado por `#275` (4 ações manuais persistem).
- **`upload-images-public.ts`**: usa Drive como CDN porque Beehiiv não tem image API pública.

### Audience / forms

- `scripts/update-audience.ts`: lê survey responses via Beehiiv MCP — `mcp__claude_ai_Beehiiv__list_survey_responses`.
- Survey responses tracking (CTR + audience profile)

### Total de pontos de contato: ~10 scripts/agents que tocam Beehiiv direta ou indiretamente.

---

## 2. Equivalentes em Kit

### Posts / Broadcasts

Kit tem o conceito **Broadcast** (equivalente a post Beehiiv) com API REST oficial:

| Beehiiv | Kit equivalente | API |
|---|---|---|
| `posts` (publicados) | `broadcasts` (sent) | `GET /broadcasts` filter `status=sent` |
| `posts` (draft) | `broadcasts` (draft) | `POST /broadcasts` cria draft |
| Post body (HTML) | Broadcast `content` | `PUT /broadcasts/{id}` aceita HTML rico |
| Test email | Built-in `POST /broadcasts/{id}/preview` | API direta |
| Send email | `POST /broadcasts/{id}/send` | API direta |

**Avanço importante**: Kit suporta criação de broadcast + envio de test email **100% via API**, sem browser automation. Resolve `#275` integralmente.

### Subscribers / audience

| Beehiiv | Kit | Notas |
|---|---|---|
| Subscribers | Subscribers | API `/subscribers` similar |
| Custom fields | Custom fields | Idem |
| Survey | **NÃO equivalente direto** | Kit não tem survey nativo; usar Form ou Tally embed |
| Polls | **NÃO equivalente** | Kit sem poll module — pra É IA?, manter Worker próprio (já existente) ou Tally |

**Bloqueio**: Kit não substitui Beehiiv polls 1:1. Decisão (#465) já encaminhada: substituir Poll Trivia É IA? por **Tally embed via HTML block**.

### Tags / segments

Kit tem **tags** (lightweight) e **segments** (queries persistidas). Beehiiv tem segments mas pouco usado pelo pipeline atual. Migration não-blocking.

### Domain / branding

- Beehiiv: `diar.ia.br` aponta pra `diaria.beehiiv.com` via CNAME + custom domain.
- Kit: também suporta custom domain (`diar.ia.br/p/{slug}`). DNS cutover (#467) precisa ser orquestrado pra zero downtime.

---

## 3. Esforço por componente

Estimativa pra implementação (após #472 conta Kit criada + Pixel API key):

| Componente | Esforço | Bloqueio |
|---|---|---|
| #463 mcp-kit + refresh-dedup migration | 4-6h | Kit API key |
| #464 publish-newsletter Kit API | 6-8h | Kit API key + template |
| #466 audience update via Kit forms | 3-4h | Kit subscribers list importada |
| #465 Tally embed pra Poll Trivia | 2-3h | Tally account + API key |
| #467 DNS cutover diar.ia.br | 1h editor + 24h DNS propagation | one-time, requer downtime mín |
| #471 multi-account suporte (Clarice) | 4-5h | #472 conta Kit Clarice criada |
| #473 publish-monthly via Kit | 4-6h | #471 |
| Tests + docs + cleanup | 6-8h | n/a |
| **Total** | **30-40h** | |

3 semanas = ~30h disponíveis se editor trabalha 1h/dia em código (resto é editorial). Apertado mas viável.

## 4. Caminho de migração proposto

**Fase 0 — Preparação** (1-2 dias):
1. Editor cria conta Kit (free tier ou starter)
2. Importa subscribers do Beehiiv via CSV export (Beehiiv → Settings → Export)
3. Configura custom domain `diar.ia.br` no Kit (sem cutover DNS ainda)
4. Cria template Kit equivalente ao Default do Beehiiv
5. API key salva em `.env.local` como `KIT_API_KEY`

**Fase 1 — Code paralelo** (1 semana):
- Implementar PRs #463, #464, #466 — Kit branch desabilitado por feature flag em platform.config.json (`platform.publishing.newsletter = "beehiiv" | "kit"`)
- Pipeline ainda publica em Beehiiv (default)
- Tests: rodar `/diaria-test` com flag `kit`, validar que broadcast cria + send test email funciona

**Fase 2 — Edição paralela** (3-5 dias):
- 1 edição publicada nos dois (Beehiiv real + Kit teste)
- Comparar: open rate, render, deliverability
- Editor revisa cosmética / texto

**Fase 3 — Switchover** (1 dia):
- Flag platform.config.json muda pra `kit`
- DNS cutover diar.ia.br (#467) — momento de pico de tráfego mín
- Monitorar 48h pra regression

**Fase 4 — Cleanup** (1 semana):
- Remover Beehiiv Chrome automation (`publish-newsletter` ganha versão Kit-only)
- Beehiiv conta downgrade pra free / cancelada
- Docs + memory + invariants atualizadas

## 5. Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Kit broadcast HTML render diferente Beehiiv | Alta | Testar 5 edições em paralelo Fase 2 |
| Subscribers import perde campos custom | Média | Preservar Beehiiv até validação completa |
| DNS cutover causa downtime | Baixa | Schedule fora do horário de envio (madrugada BRT) |
| Kit API rate limits diferentes | Baixa | Test em volume real |
| Poll Trivia → Tally introduz fricção UX | Média | Wireframe/mock antes de switch |
| Custos Kit > Beehiiv | Baixa-média | Cotizar plan tier conforme list size |

## 6. Decisão recomendada

**Go com prazo flex**: começar Fase 0 imediatamente (#472 conta Kit) e Fase 1 (code paralelo) em paralelo. Manter deadline 2026-06-01 como meta mas aceitar slip pra 2026-06-15 se Fase 2 mostrar regression. Custo de adiar > custo de migrar com bug = re-prioritize stop & think.

**Critério de abort**: se Fase 2 mostrar:
- Open rate Kit < 80% Beehiiv
- Render quebra >2 plataformas (Gmail web, Apple Mail, Outlook)
- Subscribers segmentation impossível replicar

Volta pra Beehiiv, fecha as 8 issues como wontfix-for-now.

## 7. Próximos passos imediatos (atualizado 2026-05-08)

**Foco atual = mensal Clarice, não Diar.ia diária.**

1. Editor cria conta Kit Clarice (#472) — ~30min
2. Editor configura lista mensal + template Kit pra digest Clarice — ~30min
3. Editor gera API key Clarice + adiciona em `.env.local` como `KIT_CLARICE_API_KEY` — ~5min
4. Eu implemento #471 (suporte multi-conta no pipeline) — assim que API key disponível
5. Eu implemento #473 (publish-monthly via Kit) — após #471
6. Rodar 1-2 ciclos mensais com Kit como fonte de verdade
7. **Reavaliar**: dados Clarice → decisão Diar.ia (#461, #463, #464, #466, #467)

Issues #84, #461, #463, #464, #466, #467 ficam **on hold** até passo 7.

---

## Refs
- #461 (issue tracker — este spike)
- #84, #463, #464, #465, #466, #467, #471, #472, #473 (sub-issues técnicas)
- docs/lean-canvas-vigil-ia.md (Vigil.ia.br como guarda-chuva)
