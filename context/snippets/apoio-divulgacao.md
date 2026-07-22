<!--
Bloco canônico de DIVULGAÇÃO do programa de apoio (apoia.se/diaria).

**Slot 3 fixo (#3824, 260722, decisão permanente do editor):** este é o
default de `boxes_divulgacao.slot3` em `platform.config.json` — auto-injetado
pelo `stitchNewsletter` em TODO daily, na região pós-último-destaque (antes de
USE MELHOR/É IA?), mesmo tratamento que `recomendacao-leitura.md` (slot 1) e
`livros-divulgacao.md` (slot 2). Substituiu `indicacao-ferramenta.md` nesse
slot — o arquivo de indicação de ferramenta segue disponível pra reuso
pontual (trocar o config quando quiser rodar essa campanha em vez da de
apoio), mesmo padrão que `clarice-divulgacao.md` já usa.

Também pode ser colado manualmente no slot 1 (D1/D2) ou slot 2 (D2/D3) se o
editor quiser rodar a campanha numa lacuna diferente pontualmente — o parse
do lado do render é marcador-agnóstico e não depende de qual slot o injetou.

Formato (título + 2 parágrafos + lista de recompensas + CTA, #3824/260722):
o corpo tem (1) título curto, sem marcador/emoji; (2) frase de missão ("me
ajuda a manter isso de pé"); (3) linha de preço/tier introduzindo a lista
("a partir de R$5, e cada nível libera um tipo de recompensa:"); (4) lista
de bullets com as recompensas; (5) o CTA sozinho como `[texto](url)` — por
ser o ÚNICO conteúdo do parágrafo, `shouldForceCtaPill` detecta e vira botão
pill centralizado (ver newsletter-render-html.ts).

Decisão editorial (260722, reverte a decisão de 260720 registrada abaixo
por decisão PERMANENTE do editor — #3824): volta a lista de recompensas em
bullets. A decisão de 260720 (remover a lista, ir só de "missão") foi
revertida — ver #3824 para o histórico completo da ida e volta.

Sem `**...**` embrulhando o BLOCO INTEIRO — texto plano no nível do bloco vira
peso normal (#3373). Multi-parágrafo, não passa pelo bold-wrap de bloco só-texto.
-->

Apoie a diar.ia.br

A curadoria diária que você recebe é fruto de um trabalho constante: ler, filtrar, priorizar, editar. Se isso te ajuda, apoiar é uma forma de retribuir.

O apoio começa em R$5 por mês, e cada nível libera um tipo de recompensa:

- Artigo especial do mês
- Panorama do Mês
- Acesso antecipado a novos projetos

[Quero apoiar](https://apoia.se/diaria)
