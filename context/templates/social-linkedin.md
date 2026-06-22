# Template — LinkedIn (Diar.ia)

Cada destaque gera **3 textos** (#595): main post + comment Diar.ia + comment Pixel pessoal.

## 1. Post principal (`## d{N}`)

### Regras

- Abrir com **hook forte**: pergunta provocativa ou dado impactante.
- 2–3 parágrafos curtos.
- Tom profissional, mas não corporativo engessado.
- **Sem URL no body** (#595) — LinkedIn deprioriza posts com link externo. URL vai no comment Diar.ia (T+3min).
- **Sem qualquer menção a Diar.ia ou diar.ia.br** no main post (decisão editorial 2026-05-08). Nem CTA, nem branding, nem URL textual. Main post é 100% editorial — branding e CTA vão exclusivamente no `### comment_diaria`.
- CTA final opcional: encorajar reply (ex: "Comente abaixo o que você acha"). NÃO mencionar Diar.ia.
- Incluir as **3 hashtags mais relevantes** ao tema (ex: `#InteligenciaArtificial #Mercado #Regulacao`).
- 1200–1500 caracteres é o sweet spot.

### Estrutura

```
[Hook — 1 frase impactante]

[Parágrafo 1 — desenvolve o fato]

[Parágrafo 2 — contextualiza ou dá o "por que importa"]

[Parágrafo 3 — opcional, detalhe adicional ou comparação]

[CTA opcional pra reply — ex: "Comente abaixo o que você acha"]

#Hashtag1 #Hashtag2 #Hashtag3
```

### Hashtags recomendadas por tema

- Modelos/lançamentos: `#InteligenciaArtificial #MachineLearning #Modelos`
- Mercado/economia: `#InteligenciaArtificial #Mercado #Negocios`
- Regulação: `#InteligenciaArtificial #Regulacao #Governo`
- Pesquisa: `#InteligenciaArtificial #Pesquisa #Ciencia`
- Geopolítica: `#InteligenciaArtificial #Geopolitica #China`
- Brasil: `#InteligenciaArtificial #Brasil #Tecnologia`

### Não fazer

- Não usar "Prezados", "Caros colegas", ou aberturas corporativas.
- Não usar mais de 3 hashtags.
- Não repetir o hook no parágrafo seguinte.
- Não incluir "🚀", "💡", "🔥" no hook.
- **Não incluir URL** no body do main post.
- **Não mencionar "Diar.ia" nem "diar.ia.br"** no main post — branding/CTA vão no comment_diaria (T+3min). Main fica 100% editorial.
- Não usar `#Tecnologia` sozinha (genérica) — substituir por específica (#367).

## 2. Comment Diar.ia (`### comment_diaria`)

Postado **3 min após** o main post pela própria conta Diar.ia. Driver de tráfego — link vai aqui, não no main.

### Regras

- 200–400 caracteres (incluindo URL formatada).
- Inclui **URL da edição completa Diar.ia** (não do artigo source) — leitor abre a newsletter inteira.
- Sem hashtags (já vão no main).
- Sem hook — comment é direto, não é continuação editorial.

### Estrutura

```
Edição completa com mais {outros_count} destaques de IA do dia em {edition_url}

Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria
```

**NÃO incluir CTA de assinatura por e-mail** (#2458) — "assine grátis", "receba por e-mail", "inscreva-se" e variações são vetados em posts do LinkedIn. O foco é seguir a página.

### Placeholder `{edition_url}` (#595)

Stage 2 (writer) gera o texto com o placeholder literal `{edition_url}`. Stage 5 (publish-linkedin) substitui pelo URL Beehiiv real da edição (ex: `https://diar.ia.br/p/modelos-se-replicam-sozinhos`) antes de enfileirar no Worker.

Em Stage 2, NÃO inventar URL — sempre `{edition_url}`. Lint detecta se placeholder vaza pra produção.

### Placeholder `{outros_count}` (#2319)

Stage 2 (writer) gera o texto com o placeholder literal `{outros_count}`. Stage 5 (publish-linkedin) substitui pelo total de itens não-destaque (`lancamento + radar + use_melhor + video`) lido do `01-approved-capped.json` FINAL da edição antes de enfileirar no Worker.

Motivação: resolver em Stage 2 causava staleness quando a edição era editada após o social ser gerado (ex: 260616 — "17" ficou no texto após edição reduç para 13 itens).

Em Stage 2, NÃO estimar nem substituir — sempre `{outros_count}` literal.

## 3. Comment Pixel pessoal (`### comment_pixel`)

Postado **8 min após** o main post pela conta pessoal `vjpixel`. Amplifica via 2ª conta — sinal forte pro algoritmo + 2ª notificação aos seguidores.

### Regras

- Voz: opinião editorial **direta**, **sem pergunta no fim** (Pixel falando como autor curador que viu algo interessante — não como Diar.ia).
- Adiciona ângulo concreto que o main post não cobre — observação prática, frame shift, conexão com debate atual.
- Pode citar implicação técnica / decisão / consequência pra quem lê.
- Tom: conversacional, mais pessoal que o main post.
- 300–600 caracteres.
- URL é opcional (geralmente não inclui — main post + comment Diar.ia já cobrem).
- Sem hashtags.
- Sem CTA pra newsletter por e-mail — não é o objetivo do LinkedIn (#2458).
- Sem link da página aqui (já vai no comment_diaria).

### Exemplo (estilo Pixel)

```
Pra quem implanta agente em produção, o frame mudou: a discussão central não é mais "esse modelo é seguro?" e sim "qual é o blast radius de um agente que se replica sozinho?"

Permissão de rede vira controle primário, não secundário. E a maioria dos setups que vi essa semana não trata assim.
```

### Não fazer

- Não fazer pergunta no fim ("vocês concordam?", "como vocês veem?") — voz editorial direta, não "linkedin influencer".
- Não repetir hook do main post.
- Não usar "concordo" / "isso é importante" — adiciona ângulo, não opinião sem substância.
- Não copiar tom do main (que é da Diar.ia) — Pixel fala como pessoa, não como veículo.
