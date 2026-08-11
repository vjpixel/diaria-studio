<!--
nome: Distribuição própria do "É IA?" — rascunhos de copy (#4550)
categoria: Divulgação/Produto
runtime: false

RASCUNHO — revisão e publicação são do editor, este arquivo não é consumido
automaticamente por nenhum script. Não é uma "caixa" de slot (por isso
`runtime: false`, mesmo mecanismo de `intro-campeoes-sorteio.md` —
`listBoxes` no painel Caixas do Studio esconde qualquer `.md` marcado assim).

Contexto (#4550, decisão do editor 260804): o "É IA?" tem o motor de
divulgação inteiro construído (card de compartilhamento assinado por HMAC
pós-voto #3517, imagem OG determinística em `/og/{token}`, página `/jogar`
com cadastro inline, ranking público, magic link) mas ~8 votos/edição e 2
cadastros em toda a vida do mecanismo — "ninguém chega na porta". A decisão
foi dar ao `/jogar` tratamento de produto, com distribuição própria em 3
superfícies (briefing overnight 260804): chamada no rodapé da edição,
post/story dedicado, e link em bio.

Divisão de trabalho (comentário do #4550, 260804): "Overnight prepara as
peças; a publicação fica com o editor. Nada vai pro ar sem ele." Este
arquivo cobre o rascunho de COPY das 3 superfícies — a instrumentação de UTM
(o que de fato torna a medição possível) está em
`scripts/lib/shared/utm-registry.ts` (`JOGAR_RODAPE_UTM`,
`JOGAR_POST_DEDICADO_UTM`, `buildJogarBioCampaign`) e
`scripts/lib/jogar-promo-urls.ts` (`buildJogarPostDedicadoUrl`,
`buildJogarBioUrl`) — usar esses helpers pra montar a URL final com UTM em
vez de copiar a URL abaixo, que é ilustrativa (sem UTM).

Sobre o card de compartilhamento (achado desta unidade, #4550): o card HMAC
existente (`/og/{token}`, `workers/poll/src/share.ts`) é gerado A PARTIR de
um voto real — o token carrega `{edition, correct}` assinado, então a imagem
sempre anuncia "Acertei!"/"Quase!"/"Já votou!" de UMA pessoa específica. Não
existe hoje um card GENÉRICO de convite ("venha jogar") independente de um
voto — é reaproveitável SE o editor votar (como leitor comum) e usar o
`/share/{token}` que a própria página de resultado oferece, mas isso produz
um card de resultado pessoal, não um convite neutro. Construir um card de
convite dedicado é decisão de produto/design (escolher visual, copy,
manter ou não a assinatura HMAC) — fora do escopo desta instrumentação, não
resolvido aqui.
-->

## 1. Post/story dedicado

Superfície: qualquer rede social (Instagram, LinkedIn, Facebook, Threads, X
— a escolha de onde/quando publicar é 100% editorial). Link: resolver com
`buildJogarPostDedicadoUrl()` de `scripts/lib/jogar-promo-urls.ts`.

Rascunho (post estático, sem depender do card de resultado — ver achado
acima):

> Você consegue diferenciar uma foto real de uma gerada por IA?
>
> O "É IA?" é o joguinho diário da diar.ia.br — um par de imagens, você vota
> em qual é gerada por IA, e entra num ranking público de quem mais acerta.
> Sem cadastro pra jogar.
>
> Joga aí: [link]

Variante pra story (mais curta, 1 frase + CTA de link/sticker):

> Photo real ou É IA? Testa seu olho no jogo da diar.ia.br. [link]

## 2. Link em bio

Superfície: campo de bio/site de UM perfil social (Instagram, X, Threads,
etc.) — hoje todos esses campos já apontam pra home (`diar.ia.br`, ver
`EXTERNAL_UTM_SURFACES` em `scripts/lib/shared/utm-registry.ts`, #4525).
Repontar um desses slots (ou criar um novo) pro jogo em vez da home é
decisão editorial explícita, fora do escopo desta instrumentação — este
rascunho é só o TEXTO, pronto pra quando o editor decidir a superfície.
Link: resolver com `buildJogarBioUrl(source)` (mesmo arquivo), passando o
nome da plataforma escolhida.

Rascunho (bio curta, poucos caracteres):

> Photo real ou IA? Jogue e vote 👉

(o texto do link em si costuma ser o rótulo do botão da plataforma —
"É IA?" ou "Jogar" funcionam como rótulo curto quando a plataforma permite
customizar.)

## 3. Chamada no rodapé da edição

Já implementada como pill (não é um rascunho de texto solto — o label é
fixo, "Jogar É IA?" desde o #4968 (era "É IA?"), dentro da lista
`CURADORIA_PILLS` em `scripts/lib/shared/encerramento-snippet.ts`, no grupo
"Da diar.ia.br:", separado do grupo "Curadorias:" que reúne Cursos/Livros/
Equipamentos). Alcance: ~548 leitores/dia (mesma base usada pra
medir as outras pills, #4553). Não precisa de rascunho de copy adicional —
citado aqui só pra fechar o inventário das 3 superfícies acordadas no
briefing overnight.
