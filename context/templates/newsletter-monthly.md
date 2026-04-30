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

[Parágrafo 2 — desenvolve, conecta com outros artigos do tema]

[Parágrafo 3 — atores, dados, números do mês]

[Parágrafo 4 — fecha com a leitura editorial; se o limite de chars apertar, fundir P3+P4 em um parágrafo só]

O fio condutor:
[1 parágrafo — o que esse tema revelou sobre o mês de IA. Não é "Por que isso importa" do diário; é síntese do tema.]

---

DESTAQUE 2 | [TEMA]

[mesmo formato]

---

DESTAQUE 3 | [TEMA]

[mesmo formato]

---

OUTRAS NOTÍCIAS DO MÊS

[Título do destaque 1 https://url]
[1-2 frases de descrição — por que importa.]

[Título do destaque 2 https://url]
[1-2 frases de descrição — por que importa.]

[... 10 itens, mesmo formato da edição diária: título + URL na mesma linha, descrição abaixo]

---

É IA? — DESTAQUE DO MÊS

[Recap de UM É IA? do mês — preferir a edição cujo poll ficou mais próximo de 50% de acerto
(mais ambígua para os leitores). Se poll não disponível, escolher a mais visualmente difícil.
Inserir: edição de origem, % de acerto (se disponível), breve análise do que tornou aquela
imagem boa/difícil. 1-2 parágrafos curtos.]

---

ENCERRAMENTO

[Chamada padrão pra interação: responder ao e-mail, sugerir tema, indicar a
newsletter pra colega. Tom igual ao diário.]
```

## Limites de caracteres por destaque

Contados do primeiro parágrafo de prosa até o fim do "O fio condutor:", **excluindo** a linha de cabeçalho (`DESTAQUE N | [TEMA]`) e a linha de título:

- **D1**: máximo **1.500 chars**
- **D2** e **D3**: máximo **1.200 chars** cada

## Regras de preenchimento

- **Tema dos destaques**: cobertura específica do mês — Brasil, empresa (Anthropic, OpenAI, Google, DeepSeek), área (regulação, agentes, open source, benchmarks). **Brasil é sempre um dos 3** (regra editorial do `analyst-monthly`).
- **Título narrativo**: descreve o arco do tema, não um artigo isolado. Exemplos: "Brasil acelera regulação de IA em abril", "Anthropic dobra aposta em agentes", "Open source ganha terreno em modelos de raciocínio".
- **Conexão entre artigos**: cada destaque tem N artigos de suporte (de edições diferentes do mês). O texto narra o tema como sequência — use no máximo 2–3 referências temporais por destaque ("no início do mês", "meados de abril", "no final do mês"). Não abra cada frase com "Em X de [mês]". Agrupe eventos por tema, não por cronologia.
- **Sem bloco "Para aprofundar"**: não listar URLs ao final de cada destaque.
- **Outras Notícias**: 10 destaques standalone que não couberam nos 3 temas. Formato: `Título URL` (mesma linha) + descrição de 1–2 frases abaixo. Igual à edição diária.
- **É IA? recap**: preferir a edição com poll mais próximo de 50% de acerto (mais ambígua). Se poll não disponível (ver issue #419), escolher a mais visualmente difícil.

## Diferenças vs template diário (`newsletter.md`)

- 3 opções de **subject line** auto-geradas (em vez de ficar no nível dos destaques).
- Sem "Por que isso importa:" → vira "O fio condutor:" (síntese do tema, não justificativa de pauta).
- **Sem bloco "Para aprofundar"** (diferente de versões anteriores do template).
- Outras Notícias tem **descrição** após título+URL (igual ao diário, diferente de versões anteriores).
- Sem LANÇAMENTOS / PESQUISAS — toda categoria vira tema ou Outras Notícias.
- É IA? é recap de uma do mês, não comparação nova.
- Limites de caracteres por destaque (D1: 1.500, D2/D3: 1.200).

## Não fazer (no output gerado)

> Nota: as seções de instrução acima (fora do bloco de código) usam markdown (`**`, listas `-`) como formato de documento — isso não é output gerado. As regras abaixo se aplicam ao texto do draft em `out_path`.

- Não usar markdown (`**`, `#`, `-`, `_`, `>` etc.) no corpo da newsletter.
- Não incluir texto fora do template.
- Não adicionar emojis.
- Não mencionar "Diar.ia" dentro do corpo dos destaques.
- Não inventar conexões — só conectar artigos que de fato cobrem o mesmo tema.
- Não repetir destaques entre temas. Cada artigo de suporte aparece em no máximo um destaque (os que sobram vão pra Outras Notícias).
- Não listar "Para aprofundar" com URLs ao final dos destaques.
