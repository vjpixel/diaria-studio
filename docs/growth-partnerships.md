# Parcerias de audiência — critério e processo (#4555)

Metodologia reusável para prospectar parcerias de aquisição orgânica no
modelo Clarice (canal com melhor conversão medida em ago/2026, ver
`CLAUDE.md` §Princípios operacionais). **Este doc não lista candidatos nem
texto de abordagem** — nomes de empresa reais e rascunho de contato com
terceiro são conteúdo sensível (repo público, crawlers de IA liberados nas
nossas superfícies).

**Onde cada coisa pode morar — a distinção importa e a versão anterior deste
parágrafo errava nela.** Este repositório é PÚBLICO, e uma issue dele também
é: comentário em issue **não** é local privado. O único local privado do
projeto é `data/` (junction pro OneDrive, `.gitignore` blanket, nada
versionado) — para este tema, `data/parceria-clarice/`, quando a sessão tiver
acesso à junction local.

- **Rascunho de abordagem, dossiê com dados de contato, termos em
  negociação** → só `data/parceria-clarice/`. Nunca em issue.
- **Estado, decisão e justificativa** ("aguardando resposta da X", "perfil
  decidido", "moeda em aberto") → issue #4555, como sempre foi. É informação
  que o editor já publica ali por escolha própria.

Este doc é o processo; a issue é o estado; `data/` é o material sensível.

**Escopo:** só o modelo de lista de e-mail (parceiro dispara pra base dele).
**Artigo assinado em veículo com link na bio do autor é outro canal** — outra
moeda de troca (o artigo), outro retorno (autoridade de domínio) e não
bloqueado pela decisão de moeda em aberto abaixo. Vive na **#5917**, com a
instrumentação de UTM em `docs/utm-superficies-externas.md`.

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
5. **Custo direto ranqueia, não reprova.** O teto de USD 0,50/assinante
   ATIVO que este item citava foi **revogado em 260814** (#5235/#5236) — não
   existe mais teto de aquisição por assinante. Se a parceria envolver custo
   direto (patrocínio, brinde), ele entra na comparação com os outros canais
   pelo piso de orçamento conhecido (`MONTHLY_BUDGET_FLOOR_BRL` em
   `scripts/lib/cac.ts`), medido em LEITOR (`docs/definicao-leitor.md`), não
   em assinante ativo. Não citar o teto antigo como se valesse.

## O que a diar.ia.br oferece em troca (moeda de troca) — EM ABERTO

**Estado atual: indefinido de propósito.** Duas decisões posteriores
substituíram a de 260808, e é a mais recente que vale:

- **260815** — slot editorial fica em aberto, a negociar caso a caso na
  conversa; não pré-comprometer formato.
- **260821** — não definir a moeda de troca agora; a #4555 segue **bloqueada
  de propósito**, não por falta de triagem. Registrado como decisão durável
  (padrão #5373) justamente para que nenhuma sessão autônoma re-pergunte.

Consequência para quem lê este runbook: **sem a moeda definida não dá pra
rascunhar o pitch** — o corpo da #4555 exige que ela esteja decidida ANTES de
abrir a conversa. Shortlist de candidatos sem oferta definida é lista sem uso.

*Referência histórica, NÃO o estado atual:* a decisão de 260808 era "box
dedicado, formato do box do WhatsApp já em produção" — bloco próprio entre
destaques, com título + URL + botão. Continua sendo o formato mais provável
quando o editor voltar ao tema, mas hoje não é compromisso assumido.

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
dispara"): comentário de 13/ago/2026 na issue #4555. Nenhum contato foi
enviado.

> **Nota de 22/ago/2026 — esse material está PÚBLICO.** Aquele comentário
> justifica a própria localização dizendo que fica na issue "por ser
> conteúdo sensível de repo público", o que inverte a lógica: a issue é tão
> pública quanto o `docs/`. O que está exposto: três empresas nomeadas como
> candidatas, juízos competitivos sobre outras quatro nomeadas
> (concorrência direta, inatividade) e o rascunho de e-mail de abordagem.
> Nada disso é segredo do projeto, mas fala de terceiros e é crawlável.
> **Decisão sobre o que fazer com o histórico é do editor** — sessão
> nenhuma deve editar ou apagar comentário dele por conta própria. Daqui
> pra frente, material novo desse tipo vai para `data/parceria-clarice/`,
> conforme a regra no topo deste documento.
