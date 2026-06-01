# Humanizador

[![test](https://github.com/vjpixel/humanizador/actions/workflows/test.yml/badge.svg)](https://github.com/vjpixel/humanizador/actions/workflows/test.yml)

Uma skill para Claude Code e OpenCode que remove marcas de escrita gerada por IA em textos em português brasileiro, fazendo o conteúdo soar mais natural e humano.

## Instalação

### Claude Code

Clone direto no diretório de skills do Claude Code:

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/vjpixel/humanizador.git ~/.claude/skills/humanizador
```

Ou copie o arquivo manualmente se já tem o repositório clonado:

```bash
mkdir -p ~/.claude/skills/humanizador
cp SKILL.md ~/.claude/skills/humanizador/
```

### OpenCode

Clone direto no diretório de skills do OpenCode:

```bash
mkdir -p ~/.config/opencode/skills
git clone https://github.com/vjpixel/humanizador.git ~/.config/opencode/skills/humanizador
```

Ou copie o arquivo manualmente:

```bash
mkdir -p ~/.config/opencode/skills/humanizador
cp SKILL.md ~/.config/opencode/skills/humanizador/
```

> **Observação:** o OpenCode também lê `~/.claude/skills/` por compatibilidade. Então um único clone em `~/.claude/skills/humanizador/` já funciona nos dois.

## Uso

### Claude Code

```text
/humanizador

[cole o texto aqui]
```

### OpenCode

```text
/humanizador

[cole o texto aqui]
```

Ou peça para o modelo humanizar o texto diretamente:

```text
Humanize este texto: [seu texto]
```

### Calibração de voz

Para combinar com o seu estilo pessoal, forneça uma amostra da sua escrita:

```text
/humanizador

Aqui está uma amostra da minha escrita para calibrar a voz:
[cole 2–3 parágrafos de algo seu]

Agora humanize este texto:
[cole o texto da IA a ser humanizado]
```

A skill vai analisar o seu ritmo de frase, escolhas de palavra e tiques, e aplicar isso na reescrita em vez de produzir um output "limpo" e genérico.

## Visão geral

A skill é uma curadoria de padrões de escrita de IA em português brasileiro, inspirada no guia [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) (mantido pelo WikiProject AI Cleanup), que existe só em inglês.

A skill também faz uma auditoria final "o que ainda soa de IA aqui?" e produz uma segunda reescrita para pegar resquícios que sobraram no primeiro rascunho.

### Intuição central

> "LLMs usam algoritmos estatísticos para adivinhar o que vem a seguir. O resultado tende ao mais estatisticamente provável, que se aplica ao maior número de casos." — WikiProject AI Cleanup

## 27 padrões detectados (com exemplos Antes/Depois)

### Conteúdo / retórica

| # | Padrão | Antes | Depois |
|---|--------|-------|--------|
| 1 | **Inflação de importância** | "marcou um divisor de águas, representando um passo fundamental..." | "criou regras de proteção de dados aplicáveis a empresas brasileiras" |
| 2 | **Aberturas cenográficas** | "No mundo atual, vivemos em um cenário cada vez mais digital..." | Comece com o fato. |
| 3 | **Fechamentos genéricos** | "Em suma... Por fim, mas não menos importante..." | Feche com algo específico. |
| 4 | **Atribuições vagas** | "Especialistas afirmam que o setor vai crescer 40%" | "Relatório da ANEEL de março/2024 mostra crescimento de 38%" |
| 5 | **Desafios e perspectivas** | "Apesar dos desafios, o futuro se mostra promissor" | Diga quais desafios, com dados. |
| 6 | **Metáforas de jornada** | "Vamos juntos desbravar, mergulhar, embarcar nessa jornada" | Diga o que faz, sem metáfora. |

### Léxico

| # | Padrão | Antes | Depois |
|---|--------|-------|--------|
| 7 | **Palavras-tell de IA** | "crucial, fundamental, paradigma, ecossistema, holístico, essência" | Vocabulário comum do dia a dia |
| 8 | **Verbos pomposos** | "realizar, efetuar, proporcionar, viabilizar, desempenhar um papel" | "fazer, dar, ajudar" |
| 9 | **Fórmulas "É importante..."** | "É importante ressaltar que, Vale destacar que..." | Afirme direto. |
| 10 | **Impessoal inflado** | "Faz-se necessário, torna-se imprescindível, cumpre observar" | "Você precisa, a equipe precisa" |
| 11 | **Anglicismos desnecessários** | "insights, mindset, approach, deep dive, alavancar" | Equivalente natural em português |

### Gramática / sintaxe

| # | Padrão | Antes | Depois |
|---|--------|-------|--------|
| 12 | **Gerúndio em cascata** | "atendendo, proporcionando, garantindo, contribuindo, fortalecendo" | Corte a cadeia de gerúndios |
| 13 | **Negação paralela** | "Não se trata apenas de X, mas de Y" | Diga Y direto. |
| 14 | **Regra de três** | "inovação, eficiência e excelência" | Use o número natural de itens |
| 15 | **Variação elegante** | "protagonista... personagem principal... herói... figura central" | "protagonista" (repita quando for mais claro) |
| 16 | **Falsas amplitudes** | "desde X até Y, passando por Z" | Liste os tópicos diretamente |
| 17 | **Voz passiva / sujeito oculto** | "foram realizadas melhorias, foi possível observar" | Diga quem fez |
| 18 | **Evitação de "é/são/tem"** | "configura-se como, apresenta-se como, constitui-se em" | "é, fica, tem" |
| 19 | **Conectores repetitivos / ponto-e-vírgula forçado** | "Além disso, dessa forma, nesse sentido, portanto" em cada parágrafo; `;` onde um ponto bastaria | Reduza conectores; prefira ponto ou vírgula |

### Estilo

| # | Padrão | Antes | Depois |
|---|--------|-------|--------|
| 20 | **Travessão excessivo e mal usado** | "O projeto — iniciado em 2022 — trouxe resultados — positivos —" | Vírgulas, ponto ou dois-pontos |
| 21 | **Negrito mecânico** | "**machine learning**, **inteligência artificial**, **dados**" | Negrito raro, usado com critério |
| 22 | **Listas com rótulo inline** | "**Desempenho:** O sistema ficou mais rápido" | Converta em prosa |
| 23 | **Emojis decorativos** | "🚀 Lançamento, 💡 Insight, ✅ Próximos passos" | Remova os emojis |

### Comunicação

| # | Padrão | Antes | Depois |
|---|--------|-------|--------|
| 24 | **Bajulação** | "Ótima pergunta! Com certeza! Você está absolutamente certo!" | Responda direto. |
| 25 | **Artefatos de chatbot** | "Aqui está um resumo. Espero ter ajudado! Fico à disposição!" | Remova completamente. |
| 26 | **Hedge excessivo** | "É possível que talvez possa vir a..." | Corte os qualificadores. |

### Preservação técnica

| # | Padrão | Antes | Depois |
|---|--------|-------|--------|
| 27 | **Capitalização indevida de URLs e identificadores técnicos** | "Veja Github.Com/Vjpixel/Humanizador" | Preserve case e forma; reorganize a frase se cair no início. |

## Exemplo completo

**Antes (cheio de marcas de IA):**
> Ótima pergunta! Aqui está um texto sobre o tema. Espero ter ajudado!
>
> No mundo atual, vivemos em um cenário cada vez mais digital, onde a inteligência artificial configura-se como um marco transformador na educação brasileira, representando um divisor de águas na forma como ensinamos e aprendemos. Esse paradigma vem revolucionando a sala de aula, proporcionando experiências personalizadas, garantindo engajamento dos alunos e fortalecendo o ecossistema educacional como um todo.
>
> Não se trata apenas de tecnologia, mas de uma verdadeira jornada de transformação cultural. Especialistas afirmam que a IA vai democratizar o acesso ao conhecimento. Vamos juntos desbravar esse novo universo!
>
> - 🚀 **Personalização:** O aprendizado fica adaptado ao ritmo de cada aluno.
> - 💡 **Engajamento:** As aulas ficam mais dinâmicas e interativas.
> - ✅ **Inclusão:** Alunos com necessidades especiais são atendidos de forma mais efetiva.
>
> Em suma, a IA representa um marco. Por fim, mas não menos importante, vale refletir: estamos preparados?

**Depois (humanizado):**
> A IA já apareceu na sala de aula brasileira, mas não mudou muita coisa ainda. Em 2024 o MEC rodou um piloto em 50 escolas públicas de SP e PE com um assistente de estudo no ensino médio. Entre os alunos que usaram três vezes na semana, a evasão caiu 12% no segundo semestre.
>
> A Renata Mendes, professora de biologia no Recife, me contou uma coisa que eu não tinha previsto: a nota não subiu tanto, mas os alunos tímidos passaram a perguntar. "A máquina não julga", ela disse. Se isso aparece em prova padronizada, não sei.
>
> O resto é o de sempre. Os dados dos alunos ficam onde, com quem, por quanto tempo? A BNCC cita letramento digital sem entrar em IA. Sem base, a escola com dinheiro usa bem, a escola sem dinheiro usa de qualquer jeito — e a lacuna entre as duas aumenta.

## Referências

- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) — fonte original, em inglês
- [WikiProject AI Cleanup](https://en.wikipedia.org/wiki/Wikipedia:WikiProject_AI_Cleanup) — projeto que mantém o guia
- Fast Company Brasil — [Como saber se foi a IA que escreveu? Wikipedia faz a curadoria dos clichês](https://fastcompanybrasil.com/ia/como-saber-se-foi-a-ia-que-escreveu-wikipedia-faz-a-curadoria-dos-cliches/)
- DailyNerd — [O melhor guia para identificar a escrita de IA vem da Wikipedia](https://dailynerd.com.br/noticias/o-melhor-guia-para-identificar-a-escrita-de-ia-vem-da-wikipedia/299367/)

## Histórico de versões

- **1.4.1**: Auditoria meta-recursiva — aplica o próprio padrão #20 ao texto do prompt do `SKILL.md` e do histórico do `README.md`. Travessões em prose explicativa caem para vírgula, ponto ou dois-pontos; travessões dentro de exemplos Antes/Depois ficam intocados. Sem mudança de capacidade.
- **1.4.0**: Endurece o padrão #20 (travessão) com regras quantitativas: default conservador (na dúvida, sem travessão; vírgula é padrão), meta de no máximo 1 travessão a cada 3–4 parágrafos, e sub-item dedicado de contagem na auditoria do `## Processo`. Tendência esperada: humanizador passa a entregar texto com menos travessões.
- **1.3.0**: Adiciona padrão #27 (capitalização indevida de URLs e identificadores técnicos) numa nova categoria "Preservação técnica". Cobre URLs com e sem protocolo, caminhos de arquivo, e-mails, handles e literais de código. Total: 27 padrões.
- **1.2.0**: Refina o padrão #20 (travessão). Em vez de só "usa demais", separa uso legítimo (diálogo, aposto longo, meia-risca em intervalo numérico) de seis padrões viciosos específicos (substituir dois-pontos, aposto curto entre vírgulas, remate enfático, conector implícito, intervalo numérico, excesso geral) e adiciona uma diretriz operacional. Inclui referências a Bechara, Castilho, Folha e Estadão.
- **1.1.0**: Remove padrões exclusivos do inglês (hiperbolização genérica #12 e aspas curvas #25); adiciona ponto-e-vírgula forçado ao padrão de conectores; remove "empoderamento" da lista de anglicismos; adiciona nota no formato de saída sobre texto humanizado ser mais curto. Total: 26 padrões.
- **1.0.0**: Versão inicial em português brasileiro. Curadoria de 28 padrões específicos de IA em pt-BR. Baseado no [humanizer 2.5.1](https://github.com/blader/humanizer) de blader, adaptado para editores brasileiros. Padrões pt-BR compilados a partir de cobertura jornalística brasileira e portuguesa sobre o guia *Signs of AI Writing* da Wikipedia (que só existe em inglês).

## Contribuindo

Convenções de manutenção, versionamento, formas das seções de padrão e como rodar as checagens localmente estão em [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licença

MIT


