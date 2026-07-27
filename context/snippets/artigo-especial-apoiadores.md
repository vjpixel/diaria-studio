<!--
nome: Artigo Especial (mensal, apoiadores R$10+)
Bloco de divulgação do Artigo Especial mensal — reuso pontual em slot 1/2/3
no lugar do default (`apoio-divulgacao.md` no slot 3, #3824), quando o editor
quer promover o Artigo Especial do mês em vez do CTA genérico de apoio.

Formato (multi-parágrafo, sem CTA pill — mesma família de
`indicacao-ferramenta.md`/`recomendacao-leitura.md`): (1) título curto "Artigo
Especial de {mês}"; (2) frase de anúncio com o TÍTULO do artigo em negrito
(dentro de aspas); (3) frase de contexto ligando o artigo a algo da edição
atual, quando fizer sentido; (4) parágrafo explicando o tier (R$10+/mês) e o
acesso a todos os artigos já publicados; (5) CTA `[Quero apoiar](url)`.

Frase-padrão do item (2) — corrigida no gate 260724, fixar esta redação
(não usar "Mandei um Artigo Especial pros apoiadores há pouco", que soa
datado e não escala pra reuso em edições futuras onde o artigo já foi
enviado há mais tempo):

  O Artigo Especial desse mês é: **"{título do artigo}"**. {1 frase de
  contexto/gancho}.

Placeholders a substituir a cada reuso: {título do artigo} (negrito, entre
aspas), {mês} (nome do mês corrente), {1 frase de contexto/gancho} (liga o
artigo a um destaque da edição atual quando o tema for o mesmo, ou descreve
brevemente do que trata quando não houver gancho na edição).

Sem `**...**` embrulhando o bloco inteiro — texto plano no nível do bloco
vira peso normal (#3373), mesmo padrão de `apoio-divulgacao.md`. Só o título
do artigo (item 2) leva negrito, inline.
-->

Artigo Especial de {mês}

O Artigo Especial desse mês é: **"{título do artigo}"**. {1 frase de contexto/gancho}.

Quem apoia a partir de R$10/mês recebe um Artigo Especial assim todo mês, com acesso a todos os que já saíram.

[Quero apoiar](https://apoia.se/diaria)
