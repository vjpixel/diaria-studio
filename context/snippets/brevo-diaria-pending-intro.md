<!--
nome: Intro segmento Pending (canal Brevo próprio do editor)
categoria: Divulgação/Compliance
#4266 — bloco OBRIGATÓRIO no topo de todo envio da diária via
scripts/publish-daily-brevo.ts. Decisão do editor (sessão /diaria-develop
260731, comentário 260730 na issue): o segmento recebido aqui é o Pending da
Beehiiv — pessoas que se inscreveram mas NUNCA confirmaram o double opt-in,
ou seja, NÃO são assinantes confirmadas. O enquadramento de consentimento
adotado (mesmo já usado com a parceria Clarice, ver
context/snippets/diaria-recomendacao-clarice.md) é: o recebimento do e-mail
É o opt-in para este grupo — mas isso só é honesto se o e-mail deixar claro,
logo no topo, POR QUE a pessoa está recebendo e como confirmar formalmente
se quiser continuar. Por isso este bloco:
  - NÃO presume que a pessoa já é assinante ativa da diária;
  - explica que ela se inscreveu mas não confirmou, e que este é um convite
    complementar enquanto isso;
  - oferece um caminho de confirmação formal na Beehiiv (link para a página
    de assinatura, não um link de unsubscribe).

Formato (mesma convenção de context/snippets/diaria-recomendacao-clarice.md):
(1) linha de título, sem marcador nem link; (2) 1 parágrafo de corpo; (3) CTA
sozinho como `→ [texto](url)` — shouldForceCtaPill (newsletter-render-html.ts)
detecta e vira botão pill centralizado; (4) parágrafo de disclosure de
descadastro, na linha logo após o CTA — renderiza como corpo normal ABAIXO do
botão (mesmo mecanismo do disclosure de comissão/afiliado, #2996
`afterCtaParas`), não como um 2º botão. Renderizado via
renderBoxDivulgacao(box, null, false) — bold=false, mesmo estilo do bloco
Clarice mensal (texto plano, sem `**...**` embrulhando o bloco).

Atualizado 260802: cadastro na Beehiiv não tem mais confirmação por e-mail
(mudança de fluxo do editor) — reescrito pra não presumir que existe um passo
de "confirmação" pendente no sentido antigo; o CTA agora aponta pro mesmo
formulário de cadastro, que hoje já ativa na hora ao ser resubmetido. Frase de
descadastro (parágrafo final) inspirada no fechamento de
context/templates/newsletter-monthly.md:23 ("Você está recebendo esse e-mail
porque se cadastrou na Clarice... pode se [descadastrar aqui]({{
unsubscribe }})") — mesma merge tag `{{ unsubscribe }}` da Brevo, mesmo ESP.

Atualizado 260803 (revisão do editor após ver o rascunho real na Brevo):
(1) removida a linha de título — não agrega, vai direto ao corpo; (2) removida
a menção a "Beehiiv" — irrelevante pro leitor, ele não sabe nem precisa saber
qual ESP está por trás; (3) removida a duplicação — a frase "você se inscreveu
na diária da diar.ia.br" aparecia 2x (1x no corpo, 1x depois do botão); agora
aparece só 1x, no corpo, antes do botão; (4) o parágrafo pós-CTA ficou só com
o disclosure de descadastro (sem repetir a narrativa de inscrição), pra que o
botão funcione como o fechamento natural do bloco, com só uma linha de
compliance abaixo dele — não dá pra remover essa linha inteiramente porque o
mecanismo de CTA pill (`afterCtaParas`) e o enquadramento de consentimento do
bloco (ver acima) dependem de um disclosure de opt-out explícito ali.

Atualizado 260803 (3ª rodada): corpo dividido em 3 parágrafos curtos (era 1
parágrafo corrido) + passada de humanizador (removeu 1 travessão usado como
conector lógico, `newsletter-final.md → "confirmado — por isso" → "confirmado.
Por isso,"`) + passada de Clarice via `mcp__clarice__correct_text` (6
sugestões, todas aplicadas: "chegou a ser"→"foi", "tem"→"há",
"de novo que já fica"→"novamente para que...fique", "mandamos"→"enviamos",
"pra"→"para que", "perder"→"perca" — nenhuma toca marca/identificador/merge
tag, todas de formalização pura).

*** Copy revisada APROVADA pelo editor em 260803 (substitui a aprovação
anterior — texto mudou, formato continua o mesmo: título ausente agora É a
forma esperada, não uma omissão). ***
`scripts/publish-daily-brevo.ts` continua exigindo a flag
`--i-reviewed-the-copy` pra rodar fora de `--dry-run` — isso é um lembrete
mecânico, não um gate de aprovação pendente.

Atualizado 260803 (4ª rodada): CTA trocado do formulário de cadastro
genérico (`https://diar.ia.br/?...`) pro link personalizado do
`workers/reativar` (#4476 item 3) — `?email={{ contact.EMAIL }}`, 1 clique,
sem redigitar o e-mail. Worker implantado e verificado ao vivo em 260803
(secrets configurados, `wrangler deploy`, checado com e-mail ausente/inválido
— nunca tocou a Beehiiv nesse teste). Justificativa pra não usar o formulário
genérico: `reactivate_existing:true` (o que o formulário aciona por baixo)
**não ativa** registros Pending legados — confirmado ao vivo no #4476/#4488
com 1 contato real, status ficou travado em `pending`. O worker faz
DELETE+CREATE, que ativa direto (`validating` → `active` em segundos).

Atualizado 260803 (5ª rodada, pedido do editor): reordenado + reescrito pra
resolver uma confusão real — a versão anterior abria dizendo "seu cadastro
nunca foi confirmado" antes de explicar que a pessoa JÁ está recebendo o
e-mail, o que lia como contradição pra quem tinha o e-mail aberto na tela.
Agora o 1º parágrafo valida a recepção ANTES de explicar o status pendente.
Trocado "cadastro"/"Fazer meu cadastro de novo" por "inscrição"/"Confirmar
minha inscrição" — "cadastro" soa como algo que não existe ainda; "inscrição"
reconhece que a pessoa já fez algo, só falta confirmar. Ficou mais preciso
tecnicamente também: com o link do worker (item acima), o clique realmente
CONFIRMA via API, não é mais um reenvio de formulário.
-->

Você está recebendo esta edição porque se inscreveu na diária da diar.ia.br, mas sua inscrição ainda não foi confirmada no nosso sistema oficial.

O processo de confirmação mudou: agora é só 1 clique, sem precisar digitar o e-mail de novo.

Enquanto isso não acontece, continuamos enviando a edição por aqui, para que você não perca o conteúdo.

→ [Confirmar minha inscrição](https://reativar.diaria.workers.dev/?email={{ contact.EMAIL }})

Se não quiser mais receber, pode se [descadastrar aqui]({{ unsubscribe }}).
