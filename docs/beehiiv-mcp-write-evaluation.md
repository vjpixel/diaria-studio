# Avaliação: MCP Write do Beehiiv — custo/benefício do upgrade de plano

**Gerado em:** 2026-06-20
**Relacionado a:** issue #2340
**Status:** estudo — decisão de upgrade pendente com o editor

---

## Contexto

Durante a publicação da edição 260617, o tool `mcp__claude_ai_Beehiiv__edit_post`
retornou:

> `Mcp Write is not available on your current plan. Upgrade your beehiiv subscription to access this feature.`

O plano atual da Diar.ia é o **Launch (gratuito)**. Todas as ferramentas de leitura
(`get_post`, `list_posts`, `get_post_stats`, etc.) funcionam normalmente. As de
escrita (`save_post`, `edit_post`, `edit_post_content`, `save_image`) estão
bloqueadas por plano.

---

## 1. Tiers do Beehiiv e o que libera o MCP Write

Fonte oficial: [beehiiv.com/pricing](https://www.beehiiv.com/pricing)
([confirmado por emailsoftwareinsights.com](https://www.emailsoftwareinsights.com/reviews/beehiiv/pricing/)
e [suporte oficial do MCP](https://www.beehiiv.com/support/article/39255979546263-getting-started-with-the-beehiiv-mcp))

| Plano | Mensalidade (mensal) | Mensalidade (anual) | Custo anual | Limite de assinantes | MCP Write |
|-------|----------------------|---------------------|-------------|----------------------|-----------|
| **Launch** | $0 | $0 | $0 | até 2.500 | Nao — apenas Read |
| **Scale** | $49/mes | $43/mes | ~$516/ano | ate 100.000 | **Sim** |
| **Max** | $109/mes | $96/mes | ~$1.152/ano | ate 100.000 | **Sim** |
| **Enterprise** | sob consulta | sob consulta | — | custom | Sim |

> Nota: os precos acima sao para a faixa de ate 1.000 assinantes (base minima do
> Scale/Max). Os precos sobem com o crescimento da lista — o piso de $43/mes anual
> e o menor custo possivel para MCP Write.

**Qual tier libera o MCP Write?**
O **Scale** ($43/mes anual, $49/mes mensal) e o tier minimo com acesso de escrita
ao MCP. Confirmado por:
- Pagina de pricing da Beehiiv: coluna Scale lista "beehiiv MCP (Write Access)"
- [Suporte oficial](https://www.beehiiv.com/support/article/39255979546263-getting-started-with-the-beehiiv-mcp):
  "Write actions — creating, editing, and managing content — require a paid beehiiv plan"
- [Anuncio do Write Access](https://product.beehiiv.com/p/write-access-is-here):
  "Write access is limited to users on our paid plans"

**O que o MCP Write inclui (tools relevantes para o Stage 5):**
- `save_post` — cria draft com `html_content` + `thumbnail_image_url` + settings
- `edit_post` — patch de `title`, `subtitle`, `subject`, SEO, `slug`,
  `thumbnail_image_url`, autores
- `edit_post_content` — edicao incremental por bloco com hash (ideal pro loop de fix)
- `save_image` — upload de URL para asset usavel como thumbnail
- `generate_image` — geracao de imagem via Beehiiv

**Item a confirmar com o suporte/dashboard:**
A mensagem de erro nao especifica se o tier minimo e Scale ou se existe alguma
restricao adicional dentro do Scale (ex.: a ferramenta `save_post` com `html_content`
pode ser testada com um post de rascunho antes do upgrade para confirmar que o
contrato de merge tags `{{email}}` e preservado). Recomendado: testar
`learn_post_authoring` (read — disponivel ja) para mapear o schema de nodes antes
de qualquer upgrade.

---

## 2. Custo recorrente vs plano atual

| Cenario | Custo anual | Observacao |
|---------|-------------|------------|
| Plano atual (Launch) | $0 | MCP Write indisponivel |
| Upgrade para Scale (anual) | **~$516/ano** | MCP Write habilitado |
| Upgrade para Scale (mensal) | ~$588/ano | Opcao mais cara, sem lock anual |
| Upgrade para Max (anual) | ~$1.152/ano | Superdimensionado; Max adiciona branding removal + priority support, nao necessario para MCP Write |

**Confronto com o principio "zero custo recorrente" do CLAUDE.md:**

O CLAUDE.md define o limiar em ~$50/ano como threshold para exigir justificativa
concreta. O Scale anual custa **~$516/ano — 10x acima do limiar**. Isso torna a
decisao editorial obrigatoria: nao basta a economia de tokens ser "boa" — precisa
ser concreta e mensuravel.

---

## 3. Economia e beneficios do MCP Write

### 3.1 Mapeamento por secao do `beehiiv-playbook.md`

| Secao do playbook | Hoje (Chrome) | Com MCP Write | Status |
|-------------------|---------------|---------------|--------|
| §3 Criar post via template | click real no template-library (4 steps, user-activation guard, propenso a template rogue) | `save_post(html_content, title, subtitle, thumbnail_image_url)` em 1 chamada | Eliminavel |
| §4a Setar Title/Subtitle | `buildSetFieldJs` + keystrokes reais + sleep 8s + verify API | `edit_post(title, subtitle)` — sem race de autosave | Eliminavel |
| §4a-bis Setar slug SEO | `fix-post-slug.ts` via Bash apos Schedule (workaround post-facto) | `edit_post(web_settings.slug)` antes de salvar | Eliminavel |
| §4b Cover image | DataTransfer via `buildCoverDataTransferJs` — 3 tentativas, fallback 2-step, CDP timeout risk (#2283) | `edit_post(thumbnail_image_url)` ou `save_post(thumbnail_image_url)` — resolve **#2283** e o bug de 260617 | Eliminavel |
| §5.1 Template HTML click | click real via `computer` com `resolveClickPoint` (frágil, user-activation guard) | Desnecessário — `save_post` cria o draft direto | Eliminavel |
| §5.2 Paste HTML via TipTap | fetch do Worker + `insertContent` via `javascript_tool` + debounce + verify + blur + flush (7 sub-passos) | `save_post(html_content)` ou `edit_post_content` block-ops | Eliminavel |
| §5.3 Verificacao pós-paste | varredura `doc.descendants` via `javascript_tool` | Verificacao via `get_post_content` (READ — ja disponivel) | Simplificavel |
| §6.5 Setar Subject line | navegação para configurações + find + keystrokes + tab + verify | `edit_post(email_settings.subject_line)` | Eliminavel |
| §6.6 Confirmar titulo via API | loop get_post + sleep 8s x 3 tentativas | Desnecessario — `edit_post` e sincrono (sem race de autosave) | Eliminavel |
| §7 Send test email | Chrome: find "Send test email" + click | Permanece no Chrome (guard de user-activation — Beehiiv bloqueia envio sem gesto humano real) | **Permanece** |
| §6/Schedule | Chrome: usuario clica manualmente | Permanece no Chrome (confirmado no playbook §6: todos os 5 mecanismos testados falharam) | **Permanece** |

**Resumo quantitativo:**
- Passos que seriam eliminados: ~9-10 de ~12 passos do modo `create`
- Passos que permanecem no Chrome: 2 (Send test email + Schedule) — ambos com guard de user-activation no Beehiiv, sem contorno viavel

### 3.2 Pontos de falha removidos

O Stage 5 newsletter hoje tem os seguintes pontos de falha documentados (issues abertas ou resolvidas com workaround):

| # | Problema | Causa | Com MCP Write |
|---|----------|-------|---------------|
| #1198 | Title autosave latency | Race entre UI/API no Beehiiv | Eliminado (`edit_post` e sincrono) |
| #1645 | Title persist guard | Autosave nao captura antes do test email | Eliminado |
| #2283 | CDP timeout no cover replace | DataTransfer async > 45s no renderer | Eliminado (`thumbnail_image_url`) |
| #1764 | Template click user-activation | React gatea criacao por gesto real | Eliminado (sem template click) |
| #2011 | Slug mangle apos Schedule | Beehiiv re-deriva slug no wizard | Eliminado (edit_post pre-Schedule) |
| #1766 | CDP timeout em verify | `getJSON()` serializa 30KB no evaluate | Eliminado (verify via `get_post_content` READ) |
| #2375 | Autosave nao captura apos insertContent | Debounce + navigate race | Eliminado (save_post e atomico) |
| Bug 260617 | Cover stale nao removida | Remove button so aparece em hover real | Eliminado (`thumbnail_image_url`) |

Total: **8 pontos de falha eliminados** de um Stage que hoje e o mais frágil do pipeline.

### 3.3 Estimativa de reducao de tokens

Comparativo por modo:

| Modo | Hoje (Chrome) | Com MCP Write | Reducao estimada |
|------|---------------|---------------|-----------------|
| `create` (modo normal) | ~5K tokens (Worker-hosted) + Chrome calls (visibilityState, cover DataTransfer, title keystrokes, subject, verify) | ~1-2K tokens (save_post + 2 Chrome calls: test email + Schedule) | ~60-70% |
| `create` (fallback chunked) | ~80K tokens | idem | >95% |
| `fix` (loop review) | navigate + paste parcial ou re-paste completo | `edit_post_content` block-hash patches | ~50-80% por iteracao |

Nota: os numeros de tokens sao estimativas de ordem de grandeza baseadas no
benchmark documentado no playbook (§5.2 Fase 2: "80K tokens vs 5K do Worker-hosted").
Sem medicao em producao do custo das Chrome calls adicionais (cover, title, subject)
— caracterizar como "significativo mas nao dominante" vs o custo do paste.

---

## 4. O que permanece no Chrome mesmo com MCP Write

Dois passos permanecem obrigatoriamente no Chrome:

**§7 Send test email:**
O Beehiiv bloqueia o envio de test email por user-activation (gesto humano real
detectado pelo browser). Todos os mecanismos de envio programatico testados
falham silenciosamente (popover de sucesso mas email nao chega). Isso e intencional
da Beehiiv (protecao contra blast acidental). Com MCP Write, o draft seria criado
via API, mas o envio do teste ainda exige click real no Chrome.

**Schedule:**
Idem — confirmado no playbook §6: "Por que o playbook para no draft": 5 mecanismos
testados, todos silenciosamente rejeitados. Schedule e sempre manual, independente
do MCP. Com MCP Write isso nao muda.

**Implication:** o Stage 5 passa de "~12 passos Chrome" para "1 chamada API + 2
passos Chrome", com eliminacao dos 8 pontos de falha listados acima. A sessao do
Chrome ainda precisa abrir, mas so para os 2 passos finais — muito menor footprint.

---

## 5. Recomendacao

**Cenario base:** a Diar.ia esta no plano Launch (gratuito). O upgrade minimo para
MCP Write e o **Scale anual a ~$516/ano**.

**Avaliacao custo/beneficio:**

A favor do upgrade:
- Elimina 8 pontos de falha recorrentes documentados em producao
- Stage 5 passa a ser quase 100% deterministico (2 Chrome calls vs ~12 hoje)
- Resolve o bug de 260617 (cover stale) estruturalmente, nao so com workaround
- Reduz custo de tokens do Stage 5 em ~60-70% (ja baixo com Worker-hosted, mas
  o Chrome overhead e real: timeouts, retries, CDPs)
- Simplifica drasticamente o `beehiiv-playbook.md` (~400 linhas de logic de Chrome
  -> ~50 linhas de API calls + 2 passos Chrome)

Contra o upgrade:
- $516/ano e 10x acima do limiar "zero custo recorrente" do CLAUDE.md
- O pipeline funciona hoje — o Stage 5 Chrome tem workarounds para todos os bugs
- O Scale inclui features que a Diar.ia nao precisa (monetizacao, ad network,
  automacoes de email) — nao e upgrade "por necessidade de feature editorial"
- Alternativa de custo zero: continuar com Chrome (bugs tem workarounds documentados)

**Condicao em que o upgrade valeria:**
Se a Diar.ia for migrar para o Scale por outra razao (ex.: crescimento de lista
alem de 2.500 assinantes — o Launch grata ate 2.500; a partir dai o upgrade para
Scale e obrigatorio de qualquer forma), o MCP Write viria "de graca" no novo plano
e a decisao seria automatica.

**Condicao em que o upgrade nao valeria:**
Se a lista ficar abaixo de 2.500 e o Stage 5 Chrome continuar estavel com os
workarounds atuais, $516/ano e custo alto so para ganho operacional.

**Recomendacao ao editor:**
- Se a lista Beehiiv estiver proximo de 2.500 assinantes (conferir no dashboard
  Beehiiv), o upgrade para Scale e inevitavel de qualquer forma — nesse cenario,
  implementar o MCP Write (issue #2340 tarefas 2-5) logo apos o upgrade.
- Se a lista ainda tiver folga (< ~2.000 assinantes), a decisao e puramente de
  custo: $516/ano para eliminar 8 bugs recorrentes e reduzir fragilidade do Stage 5.
  Fica a criterio do editor — o estudo de custo/beneficio nao e unidimensional o
  suficiente para uma recomendacao automatica.

---

## 6. Correcao de documentacao pendente (nao aplicar agora)

O `context/publishers/beehiiv-playbook.md` secao §4b, nota `#1705`, contem:

> "thumbnail e UI-only, nao ha via de API/MCP pra setar a capa"

Esta nota esta **desatualizada**. Os tools `edit_post` e `save_post` do MCP expoe
o campo `thumbnail_image_url`, confirmado pelo schema do MCP durante a publicacao
260617. A nota do #1705 foi escrita antes do lancamento do MCP Write.

**Acao necessaria QUANDO o plano permitir:** remover a nota desatualizada e
atualizar §4b para indicar que `thumbnail_image_url` e o metodo primario via MCP,
com DataTransfer (#1500) como fallback apenas para quem esta no Launch (gratuito).

O `beehiiv-playbook.md` ja foi parcialmente atualizado com uma nota em #2340 que
aponta para essa situacao:

> "o campo `thumbnail_image_url` existe no schema do MCP (`edit_post`/`save_post`),
> mas esta gated por plano pago do Beehiiv (plano atual = Launch/free)"

Esta nota e suficiente por enquanto. A correcao completa (reescrita do §4b para
MCP-first + Chrome como fallback) deve ser feita como primeira tarefa pos-upgrade.

---

## Fontes

- [beehiiv Pricing — pagina oficial](https://www.beehiiv.com/pricing)
- [Getting started with the beehiiv MCP — suporte oficial](https://www.beehiiv.com/support/article/39255979546263-getting-started-with-the-beehiiv-mcp)
- [Write Access is here — anuncio produto](https://product.beehiiv.com/p/write-access-is-here)
- [Beehiiv Pricing (2026) — emailtooltester.com](https://www.emailtooltester.com/en/reviews/beehiiv/pricing/)
- [Beehiiv Pricing: All Plans & True Costs Compared (2026) — emailsoftwareinsights.com](https://www.emailsoftwareinsights.com/reviews/beehiiv/pricing/)
- [beehiiv Pricing 2026 — thatmarketingbuddy.com](https://thatmarketingbuddy.com/pricing/beehiiv)
