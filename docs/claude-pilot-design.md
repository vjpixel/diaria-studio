# Piloto: newsletter focada em Claude (Anthropic ecossistema) — Design (#60)

Versão: draft 2026-05-08 · Owner: Pixel · Status: pre-launch experiment design

## Hipótese

Existe demanda suficiente em audiência BR (e talvez global) por uma newsletter dedicada **exclusivamente ao ecossistema Claude / Anthropic** pra justificar um produto separado da Diar.ia (cobertura generalista de IA). Hipótese complementar: uma cobertura focada produz **engajamento qualitativamente diferente** (mais técnica, mais retentiva, mais convertível pra produto B2B Anthropic).

## Por que testar

Sinais favoráveis observados:
- Diar.ia tem ~30-40% das edições com algum destaque Anthropic (Claude updates, Agent SDK, MCP, Projects, parcerias)
- LinkedIn comments mais técnicos/longos vêm de leitores Anthropic-curious
- Comunidade BR de Claude Code (este próprio projeto Diar.ia é um caso) é pequena mas concentrada — pode formar nicho

Sinais contrários:
- Audiência global Anthropic já tem cobertura em inglês (Anthropic blog, Latent Space, Hacker News)
- Frequência de news Claude-only pode ser baixa demais pra newsletter diária
- Cannibalization da Diar.ia geral

## Design do experimento

### Fase 1 — Edição experimental única (1 sprint)

**Formato:**
- 1 edição especial **"Diar.ia Claude"** publicada como post regular no Beehiiv existente
- Mesmo template editorial, scope reduzido: 3 destaques + lançamentos/pesquisas/notícias **só do ecossistema Claude/Anthropic**
- Subject line claramente marcado: "[Edição especial] Diar.ia Claude — semana em revisão"
- Footer pergunta direta: "Quer mais edições assim? Responda este email com 1 frase."

**Quando publicar:**
- Sábado ou domingo (slot extra, não substitui regular)
- Janela com news quente Anthropic (após Claude release ou paper)

**Métricas pra coletar (1 semana pós-publicação):**
- Open rate vs edição regular do dia
- CTR em artigos (esperado mais alto se audiência mais técnica)
- Reply rate à pergunta de fim
- Unsubscribes (red flag se >2x baseline)
- Mentions no LinkedIn (compartilhamento orgânico)

### Fase 2 — Decisão de continuação

**Critérios pra ir pra Fase 3:**
- Open rate ≥ regular OR reply rate ≥ 5% (alto sinal de demanda)
- ≥30 replies positivos solicitando mais edições
- Nenhum spike de unsubscribe

**Critérios pra encerrar:**
- Open rate < 70% do regular
- Replies majoritariamente "deixa o normal, não quero mais"
- Spike de unsubscribe > 2%

### Fase 3 — Newsletter regular dedicada (3 meses pilot)

**Formato:**
- **Frequência semanal** (não diária — frequência de news Claude justifica)
- **Beehiiv publication separada** OU segmento dentro da Diar.ia (decidir Fase 2 baseado em crescimento)
- 5-7 destaques curados/semana
- Profundidade > frequência — tutorial / review / análise

**Métricas pra coletar (3 meses):**
- Crescimento orgânico (assinantes/mês)
- Conversion da audiência Diar.ia regular
- Engagement qualitativo (replies, comments LinkedIn)
- Sponsorship interest (pode atrair Anthropic / partners B2B)

### Fase 4 — Decisão de produto

Após 3 meses, 3 caminhos:
1. **Spin-off**: produto separado (vigil.ia.br/claude), branding distinto, monetização independente
2. **Sub-segment Diar.ia**: integrar como tag opcional pros assinantes interessados
3. **Encerrar**: cobertura volta a generalista, lições aplicadas no editorial regular

## Stack técnica

Pra Fase 1 (edição única), reutilizar 100% pipeline atual:
- `/diaria-edicao AAMMDD` com filter editorial Anthropic-only
- Manual: editor garante categorização durante Stage 1 gate

Pra Fase 3+ (newsletter regular), expandir:
- Beehiiv publication separada OU segmento — implementação ~3 dias dev
- Stack social separado (LinkedIn page Anthropic-focused?) — TBD
- Editorial guidelines distintos

## Riscos

- **Cannibalization**: assinantes da Diar.ia podem migrar pro pilot e diminuir audience principal. Mitigação: messaging "complementar, não substitui".
- **Burnout editorial**: 1 newsletter já é trabalho. 2 dobra. Mitigação: pipeline maduro + reuso do mesmo Stack.
- **Scope creep**: pilot vira produto antes de validar demanda. Mitigação: critérios Fase 2 explícitos, kill switch claro.
- **Anthropic relacional**: cobertura crítica (inevitável) pode esfriar relação se virar fonte de hype. Mitigação: voz editorial honesta, não-sycophantic.

## Próximos passos

1. **Editor decide quando rodar Fase 1** (depende de news quente Anthropic + bandwidth)
2. **Pre-publicação**: setup tracking adicional (Beehiiv Custom Field `pilot=claude` pra segmentar abridores)
3. **Post-publicação**: análise estruturada das métricas em 7 dias
4. **Decisão Go/No-Go**: sim Fase 3 se critérios atendidos, senão fechar #60

---

## Refs
- #60 (issue tracker)
- docs/lean-canvas-vigil-ia.md (contexto produto Vigil.ia)
