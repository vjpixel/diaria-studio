# Template — Edição Mensal Diar.ia

Formato exato do digest mensal. Cada destaque é uma narrativa multi-artigo cobrindo um tema do mês (não um único artigo, como no diário).

```
ASSUNTO (3 OPÇÕES)
1. [opção 1 — máx. 70 chars, destaca o tema central do mês]
2. [opção 2 — outro ângulo do mês]
3. [opção 3 — terceira via]

PREVIEW
[1 linha — síntese do mês em até 100 chars]

INTRO
[2-3 frases contextualizando o mês: o que dominou a pauta, qual o tom geral.
Não cita os 3 destaques explicitamente — abre cena.]

---

DESTAQUE 1 | [TEMA]
[Título narrativo do tema — máx. 60 chars]

[Parágrafo 1 — abre o tema com o evento mais marcante do mês daquela área]

[Parágrafo 2 — desenvolve, conecta com outros artigos do tema (cita datas/edições quando relevante: "no dia 12, …")]

[Parágrafo 3 — atores, dados, números do mês]

[Parágrafo 4 — fecha com a leitura editorial]

O fio condutor:
[1 parágrafo — o que esse tema revelou sobre o mês de IA. Não é "Por que isso importa" do diário; é síntese do tema.]

Para aprofundar:
[Título original 1]
[URL]

[Título original 2]
[URL]

[... todos os artigos de suporte do destaque, em ordem cronológica]

---

DESTAQUE 2 | [TEMA]
[mesmo formato]

---

DESTAQUE 3 | [TEMA]
[mesmo formato]

---

OUTRAS NOTÍCIAS DO MÊS

[Os 10 destaques standalone com maior score que não couberam nos 3 temas — mesmo formato compacto do diário: título + URL.]

[Título do destaque]
[URL]

[Título do próximo destaque]
[URL]

[... 10 itens]

---

É IA? — DESTAQUE DO MÊS

[Recap de UM É IA? do mês — escolhido pelo writer ou apontado no gate humano.
Edição de origem, % de acerto do poll (se disponível via #107), breve análise
do que tornou aquela imagem boa/difícil. 1-2 parágrafos curtos.]

---

ENCERRAMENTO

[Chamada padrão pra interação: responder ao email, sugerir tema, indicar a
newsletter pra colega. Tom igual ao diário.]
```

## Regras de preenchimento

- **Tema dos destaques**: cobertura específica do mês — Brasil, empresa (Anthropic, OpenAI, Google, DeepSeek), área (regulação, agentes, open source, benchmarks). **Brasil é sempre um dos 3** (regra editorial do `analyst-monthly`).
- **Título narrativo**: descreve o arco do tema, não um artigo isolado. Exemplos: "Brasil acelera regulação de IA em abril", "Anthropic dobra aposta em agentes", "Open source ganha terreno em modelos de raciocínio".
- **Conexão entre artigos**: cada destaque tem N artigos de suporte (de edições diferentes do mês). O texto narra o tema como sequência — "no início do mês, X anunciou Y; duas semanas depois, Z respondeu com W".
- **Outras Notícias**: 10 destaques standalone que não couberam nos 3 temas, ordenados por score (do mais alto pro mais baixo).
- **É IA? recap**: uma única edição do mês — a mais marcante (maior engajamento no poll, ou mais difícil de identificar). Não é nova comparação.

## Diferenças vs template diário (`newsletter.md`)

- 3 opções de **subject line** auto-geradas (em vez de ficar no nível dos destaques).
- Sem "Por que isso importa:" → vira "O fio condutor:" (síntese do tema, não justificativa de pauta).
- Cada destaque tem bloco "Para aprofundar" listando os artigos de suporte (URLs).
- Outras Notícias é os 10 destaques standalone que não couberam nos temas (não notícias secundárias coletadas no Stage 1 da pipeline diária).
- Sem LANÇAMENTOS / PESQUISAS — toda categoria vira tema ou Outras Notícias.
- É IA? é recap de uma do mês, não comparação nova.

## Não fazer

- Não usar markdown (`**`, `#`, `-`, `_`, `>` etc.).
- Não incluir texto fora do template.
- Não adicionar emojis.
- Não mencionar "Diar.ia" dentro do corpo dos destaques.
- Não inventar conexões — só conectar artigos que de fato cobrem o mesmo tema.
- Não repetir destaques entre temas. Cada artigo de suporte aparece em no máximo um destaque (os que sobram vão pra Outras Notícias).
