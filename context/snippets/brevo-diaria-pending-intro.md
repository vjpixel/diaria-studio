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
detecta e vira botão pill centralizado. Renderizado via
renderBoxDivulgacao(box, null, false) — bold=false, mesmo estilo do bloco
Clarice mensal (texto plano, sem `**...**` embrulhando o bloco).

*** RASCUNHO — NÃO ENVIADO À PRODUÇÃO. ***
A cópia abaixo é um placeholder honesto (não fabrica confirmação nem usa
linguagem de "parabéns por ser assinante"), mas o texto final e o link de CTA
precisam de aprovação explícita do editor antes do primeiro envio real —
`scripts/publish-daily-brevo.ts` recusa rodar sem `--i-reviewed-the-copy`
justamente por isso (ver comentário no próprio script). Ajustar a URL do CTA
pra apontar pro formulário/página de confirmação real da Beehiiv antes de
aprovar.
-->

Por que você está recebendo este e-mail

Você se inscreveu na diária da diar.ia.br, mas ainda não confirmou seu cadastro — por isso, hoje, você não recebe as edições pela Beehiiv. Enquanto isso, mandamos a edição por aqui, pra você não perder o conteúdo. Se preferir parar de receber por este canal, é só usar o link de descadastro no rodapé.

→ [Confirmar meu cadastro na diária](https://diar.ia.br/?utm_source=brevo_pending)
