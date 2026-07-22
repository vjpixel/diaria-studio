<!--
Bloco canônico de DIVULGAÇÃO do programa de apoio (apoia.se/diaria). Fonte
única do box de divulgação (slot 1 D1/D2 OU slot 2 D2/D3, #2978) quando o
editor quer promover o apoio numa edição diária. Não é auto-inserido por
padrão (diferente do 📚 livros, #2527) — o editor cola este bloco na lacuna
desejada quando quiser rodar a divulgação.

Formato (título + 2 parágrafos + CTA — versão "missão", #3687/260720): o corpo
tem 4 parágrafos separados por linha em branco — (1) título curto, sem
marcador/emoji; (2) frase de missão ("me ajuda a manter isso de pé"), NÃO uma
lista de recompensas; (3) linha de preço/tier ("a partir de R$5", "cada nível
libera um tipo de recompensa"); (4) o CTA sozinho como `[texto](url)` — por ser
o ÚNICO conteúdo do parágrafo, `shouldForceCtaPill` detecta e vira botão pill
centralizado (ver newsletter-render-html.ts).

Decisão editorial (260720): o box tende para "estou ajudando" (missão), não
para "o que ganho" (transacional). Removida a lista enumerada de benefícios
porque (a) dava a impressão de que o apoiador ganha TODOS os itens, quando na
verdade dependem do nível de contribuição no apoia.se, e (b) patronato converte
por pertencimento, não por transação a R$5/mês. Substitui a versão anterior
(título + lista de 5 benefícios), aprovada em 260713.

Sem `**...**` embrulhando o BLOCO INTEIRO — texto plano no nível do bloco vira
peso normal (#3373). Multi-parágrafo, não passa pelo bold-wrap de bloco só-texto.

#3824 (260721): a issue pediu tornar permanente uma versão com lista de
bullets de recompensas (Artigo especial do mês / Panorama do Mês / Acesso
antecipado), aprovada manualmente no gate da edição 260722. Esse formato é o
que #3688 removeu deliberadamente 2 dias antes (decisão editorial 260720,
"lista flat era imprecisa... patronato converte por pertencimento, não por
transação") — reintroduzi-lo aqui reverteria essa decisão sem consulta ao
editor. Conteúdo deste arquivo NÃO foi alterado por #3824; o conflito entre
as duas versões (bullets vs. missão) segue pendente de decisão do editor, no
mesmo gate onde o slot default (item 2 de #3824) também será decidido.
-->

Apoie a diar.ia.br

A curadoria diária que você recebe é fruto de um trabalho constante: ler, filtrar, priorizar, editar. Se isso te ajuda, apoiar é uma forma de retribuir.

O apoio começa em R$5 por mês, e cada nível libera um tipo de recompensa.

[Quero apoiar](https://apoia.se/diaria)
