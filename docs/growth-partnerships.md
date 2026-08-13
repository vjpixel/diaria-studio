# Parcerias de audiência — critério e processo (#4555)

Metodologia reusável para prospectar parcerias de aquisição orgânica no
modelo Clarice (canal com melhor conversão medida em ago/2026, ver
`CLAUDE.md` §Princípios operacionais). **Este doc não lista candidatos nem
texto de abordagem** — nomes de empresa reais e rascunho de contato com
terceiro são conteúdo sensível (repo público, crawlers de IA liberados nas
nossas superfícies) e vivem em local privado, não git-tracked: comentário na
issue #4555 (mesma convenção do dossiê de prova do #4555, comentário
07/ago/2026) ou `data/parceria-clarice/` quando a sessão tiver acesso à
junction local. Este doc é o processo; a issue é o dado.

## Critério de seleção de parceiro

1. **Adjacência de tema, não sobreposição.** Audiência com interesse
   plausível em IA/produtividade, mas cujo produto principal NÃO é
   substituto direto da diar.ia.br (newsletter diária de notícias de IA).
   Recomendar um concorrente direto manda o leitor embora de vez — descarta
   qualquer newsletter cujo conteúdo seja majoritariamente notícia de IA.
2. **Evidência de lista de e-mail própria e ativa.** Comunidade só em
   Discord/Slack sem newsletter dedicada é sinal mais fraco (alcance maior,
   conversão em cadastro de e-mail mais difícil de prever) — não descarta,
   mas pesa menos que lista de e-mail confirmada com cadência recente.
3. **Cadência recente.** Última atividade/edição em semanas, não meses —
   uma lista com aparência de tamanho grande mas sem envio recente traz
   audiência que pode já ter se desengajado do próprio canal do parceiro.
4. **Presença na Beehiiv é bônus de facilidade, não requisito.** Uma
   publicação Beehiiv pode recomendar a diar.ia.br pela rede de
   recomendações inteiramente do lado dela, sem depender do nosso plano
   (bloqueado — ver #4560). Só *retribuir* pelo mesmo mecanismo é que
   depende de upgrade. Parceiro fora da Beehiiv ainda é candidato válido —
   a troca vira menção por menção em vez de recomendação bidirecional.
5. **Teto de aquisição de USD 0,50/assinante ATIVO segue valendo** mesmo
   quando a "moeda" não é dinheiro — se a parceria envolver qualquer custo
   direto (patrocínio, brinde), o mesmo teto se aplica.

## O que a diar.ia.br oferece em troca (moeda de troca, decisão do editor 260808)

**Box dedicado, formato do box do WhatsApp já em produção** — bloco próprio
entre destaques (hoje entre D1 e D2), com título + URL + botão preenchido.
Visível sem competir com a curadoria; não é menção solta no Radar nem
edição/seção co-assinada. Explicitar esse limite **antes** de abrir a
conversa, não depois.

**Escopo explícito do #4555 (260808):** prospecção só por **e-mail direto**
com o parceiro — não inclui pedir inclusão na rede de recomendações da
Beehiiv (bloqueada pelo plano, #4560, decisão de não puxar essa perna
enquanto os dois lados não destravarem).

## Cuidados

- **Não modelar toda nova parceria como cópia da Clarice.** A relação com a
  Clarice tem 3 objetivos (aquisição + produto pro parceiro + reconversão
  de ex-assinantes) — uma parceria nova pode ser só aquisição, o que muda o
  que se oferece em troca.
- **UTM próprio por parceiro desde o 1º envio** (`utm_source={parceiro}`,
  `medium=email`), registrado em `utm-registry.ts` — sem isso o cadastro
  cai em `direct` e a parceria fica sem prova de conversão.
- **Pedir link recíproco em página institucional na mesma conversa** —
  resolve o #4547 (autoridade de domínio) de quebra, sem custo adicional de
  relacionamento.
- **Números de audiência levantados por busca web são indicativos, não
  confirmados.** Confirmar tamanho de lista/engajamento real é o próprio
  passo de prospecção — não terceirizável para pesquisa automatizada.

## Divisão de trabalho (decisão do editor, #4555)

A abordagem a terceiro em nome do projeto é sempre do **editor** —
prospecção é relação, não se terceiriza para agente. O que uma sessão de
código pode preparar: dossiê de prova (números da parceria de referência),
proposta de troca, texto de abordagem rascunho (editável, não pronto para
enviar), e o critério de avaliação acima. Escolher os nomes, abordar e
negociar fica sempre com o editor.

## Onde está o material desta rodada

Critério de seleção + candidatos justificados + texto de abordagem rascunho
(autorizado pelo editor em 12/ago/2026 — "assistente monta, editor
dispara"): comentário na issue #4555. Nenhum contato foi enviado.
