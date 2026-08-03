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
descadastro (parágrafo 4) inspirada no fechamento de
context/templates/newsletter-monthly.md:23 ("Você está recebendo esse e-mail
porque se cadastrou na Clarice... pode se [descadastrar aqui]({{
unsubscribe }})") — mesma merge tag `{{ unsubscribe }}` da Brevo, mesmo ESP.

*** APROVADA pelo editor em 260802. ***
`scripts/publish-daily-brevo.ts` continua exigindo a flag
`--i-reviewed-the-copy` pra rodar fora de `--dry-run` — isso é um lembrete
mecânico, não um gate de aprovação pendente (a aprovação em si já
aconteceu). Pendência real que sobrevive à aprovação: a URL do CTA abaixo
ainda aponta pro formulário de cadastro genérico — precisa virar o link
personalizado (`?email={{ contact.EMAIL }}`) quando a página de confirmação
do #4476 item 3 existir. Se o texto mudar de novo depois disso, reavaliar
se precisa de nova aprovação explícita.
-->

Por que você está recebendo este e-mail

Você se inscreveu na diária da diar.ia.br, mas seu cadastro nunca chegou a ser confirmado — por isso, hoje, você não recebe as edições pela Beehiiv. O processo mudou desde então: não tem mais confirmação por e-mail, então basta se inscrever de novo que já fica ativo na hora. Enquanto isso não acontece, mandamos a edição por aqui, pra você não perder o conteúdo.

→ [Fazer meu cadastro de novo](https://diar.ia.br/?utm_source=brevo_pending)

Você está recebendo esse e-mail porque se inscreveu na diária da diar.ia.br e o cadastro ficou pendente. Caso não queira mais receber, pode se [descadastrar aqui]({{ unsubscribe }}).
