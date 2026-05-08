# Lean Canvas — Vigil.ia.br (#856)

Versão: draft 2026-05-08 · Owner: Pixel · Status: living document

Vigil.ia.br é a organização guarda-chuva da Diar.ia (newsletter diária de IA), do testbed Clarice/Kit (digest mensal de pesquisa em IA com Clarice Menezes), e potenciais futuros produtos editoriais focados em IA. O Lean Canvas abaixo aplica o framework Ash Maurya — 9 blocos pensados pra capturar a hipótese central do negócio em 1 página.

---

## 1. Problem

Os 3 problemas centrais que Vigil.ia.br endereça:

- **Sobrecarga informacional em IA**: o ritmo de lançamentos, papers e mudanças regulatórias passou do consumível pra um profissional médio. Newsletters genéricas (TLDR, Ben's Bites, etc) só agregam — não filtram editorialmente pra contexto BR.
- **Falta de cobertura editorial em português**: imprensa BR generalista (Folha, Valor, Estadão) cobre IA reativamente, com 24-48h de defasagem. Veículos especializados em inglês (TechCrunch, The Information) não traduzem nem contextualizam.
- **Desconfiança sobre IA na audiência educada**: leitor profissional/acadêmico/regulador quer entender o que tá real, o que é hype, o que afeta o trabalho dele — sem precisar virar especialista.

### Existing alternatives
- Newsletters de IA em inglês (TLDR AI, Ben's Bites, Import AI)
- Cobertura genérica de tech BR (Mobile Time, Convergência Digital)
- Podcasts longos (Lex Fridman, Latent Space) — alta qualidade, baixa frequência
- Twitter/X feed seguindo pesquisadores

---

## 2. Customer Segments

Early adopters (north star pra primeiros 1.000 assinantes):

- **Profissionais de tecnologia em transição pra IA**: dev/PM/founder que quer pivot mas não tem tempo de filtrar 50 fontes.
- **Acadêmicos e pesquisadores em ciências aplicadas**: precisa acompanhar IA como ferramenta sem virar área principal.
- **Reguladores e jurídico**: ANPD, advogados de tech, LGPD/AI Act tracking.
- **Founders/operadores pequenas empresas BR**: querem entender oportunidades pra adoção sem hype.

Mass market (escala futura): leitores de newsletters tech genéricas que querem profundidade BR específica.

---

## 3. Unique Value Proposition

**"Notícias de IA filtradas editorialmente, em português, todo dia. 5 minutos de leitura."**

Subtexto:
- Curadoria humana (não agregador algorítmico)
- Frame editorial: "por que isso importa" pra leitor BR profissional
- Frequência alta (diária) sem virar overload (5 min, 3 destaques)
- Qualidade de produção: imagens, layout, voz consistente

### High-level concept
"O Filter for AI" — leitor confia que se não saiu na Diar.ia, não precisava saber.

---

## 4. Solution

3 produtos no roadmap (em ordem de maturidade):

1. **Diar.ia (newsletter diária)** — em produção, ~12 destaques curados/dia, 3 com profundidade editorial. Stack: Beehiiv (migrando pra Kit), pipeline TS automatizado com Claude Code.

2. **Digest mensal Clarice** — em desenvolvimento (parceria), foco em pesquisa científica em IA. Diferente formato: long-form vs snippet, profundidade > frequência.

3. **Newsletter focada Claude/Anthropic** (#60) — piloto experimental, scope reduzido a um ecossistema. Teste se há audiência pra cobertura nicho.

Stack comum:
- Pipeline editorial Claude Code (4 stages: pesquisa → escrita → imagens → publicação)
- Drive sync (editor mobile)
- LinkedIn + Facebook social automation
- Worker Cloudflare pra agendamento

---

## 5. Channels

Em uso:
- **LinkedIn** (3 posts/dia da Diar.ia + comentário Pixel pessoal pós-#595)
- **Facebook** (3 posts/dia)
- **Email direto** (Beehiiv, ~migrating Kit)

Em consideração:
- **Instagram** (#49 — pendente decisão de método, Graph API vs Make)
- **Twitter/X** (template existe, sem publicação automatizada ainda)
- **Podcast curto** (5min/dia áudio do destaque principal — não validado)

Off-topic explorado:
- SEO orgânico (diar.ia.br/p/{slug} de cada edição) — ranking gradual
- Sharing entre comunidades (Reddit r/brdev, Discord servers de IA BR)

---

## 6. Revenue Streams

Status atual: zero revenue.

Hipóteses pra teste (em ordem de risco/retorno):

1. **Patrocínio editorial** (low risk, high effort): empresa BR de IA paga por destaque dedicado/mês. Risco editorial: comprometer voz independente. Mitigação: edição patrocinada claramente marcada.

2. **Assinatura premium** (medium risk, medium retorno): tier paid com (a) edição matinal antecipada, (b) acesso a histórico searchable, (c) mensagens diretas Pixel. Modelo Stratechery / Ben Thompson.

3. **Membership orga (Vigil.ia.br)** (low risk, escalável): Vigil.ia.br oferece 3+ produtos editoriais sob membership única (Diar.ia + Clarice digest + Claude pilot + futuros). Tipo Substack-bundle.

4. **Eventos paid** (medium risk, sazonal): meetups BR de IA com assinantes premium, workshops corporativos.

5. **Cursos/material derivado** (high effort): livro, cursos, frameworks proprietários publicados sob marca Vigil.ia.

---

## 7. Cost Structure

### Custos atuais (operacional)
- Claude API (orchestrator + subagents): ~$50-100/mês baseado em volume edição
- Beehiiv plano: $42/mês (Max tier por agora)
- Cloudflare Workers + KV: ~$0 (free tier)
- Wikimedia + sources externos: $0
- Domain diar.ia.br + vigil.ia.br: ~$30/ano
- Tempo Pixel: ~1-2h/dia editorial (pré-pipeline maduro era 4-6h/dia)

### Custos futuros previstos
- Kit migration: ~$30/mês (substituí Beehiiv, mas custo similar)
- Image generation (Gemini Flash): ~$5-10/mês
- Hosting custom domain redirects: $0 (Cloudflare)
- Analytics / segmentação avançada: $0-50/mês conforme tier
- Eventos / produção de conteúdo derivado: variável

Princípio invariável (CLAUDE.md): zero custo recorrente pra automação de scale. Preferência por free tier oficial > pay-per-call < $50/ano antes de assinatura fixa.

---

## 8. Key Metrics

Métricas atuais (output, não outcome):
- Open rate (Beehiiv): track diário
- CTR pra artigos: rastreamento via build-link-ctr.ts
- Crescimento de assinantes: track semanal
- Comentários LinkedIn: proxy de engajamento qualitativo
- Edições publicadas: 1/dia mantido com pipeline maduro

Métricas a começar a tracker (outcome):
- **D7 retention**: % assinantes que abrem 5+ edições nos primeiros 7 dias
- **Reply rate**: % edições com pelo menos 1 reply do leitor (concurso erro intencional já dirige isso)
- **NPS proxy**: % survey respondents que recomendariam
- **Conversion premium**: quando lançar tier paid

Métrica north star candidata: **D7 retention > 60%** (alguém que abriu 5/7 dias provavelmente vira assinante de longo prazo).

---

## 9. Unfair Advantage

Coisas difíceis de copiar:

1. **Pipeline TS + Claude Code maduro**: 6 meses de iteração, 600+ commits, 100+ scripts auditados. Concorrente teria que reconstruir, ou aceitar estar 1 ano atrás.
2. **Voz editorial Pixel**: tom específico (analítico sem ser denso, BR sem ser provinciano, técnico sem virar manual). Audiência se conecta com a voz, não com o conteúdo.
3. **Track record diário sem furo**: pipeline robusta + editor disciplinado = 100+ edições consecutivas. Confiabilidade vira ativo.
4. **Parceria Clarice**: acesso curatorial-acadêmico raro pra cobertura científica. Concorrente comercial não tem essa entrada.
5. **Comunidade BR engajada**: assinantes early adopters são profissionais que se tornarão evangelistas — efeito network local.

Coisas NÃO unfair (riscos):
- Nome de marca relativamente fraco (concorrentes podem ofuscar com SEO)
- Sem moats técnicos (qualquer um pode copiar pipeline TS open source)
- Dependência de plataformas externas (Beehiiv/Kit/Make)

---

## Próximos passos sugeridos

1. **Definir north star metric** (D7 retention?) e instrumentar dashboard.
2. **Decidir Beehiiv → Kit migration** (deadline 2026-06-01) ou postpone formal.
3. **Testar #60 Claude pilot** como experimento de scope/audience.
4. **Preparar pitch de patrocínio** (light) pra 2-3 empresas BR de IA.
5. **Setup vigil.ia.br homepage** apontando pra Diar.ia + Clarice digest.

---

## Refs
- #856 (issue tracker)
- CLAUDE.md (princípios operacionais)
- context/audience-profile.md (perfil de leitor real, gerado de survey + CTR)
