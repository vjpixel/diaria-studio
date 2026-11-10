<!--
convite anual do formulário, para quem respondeu há 12 meses ou mais (#12490)
assunto: "Muita coisa mudou desde a sua resposta?"
preview_text: "Faz um ano que você respondeu o formulário. Topa responder de novo?"
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.
(O marcador fica aqui DE PROPÓSITO: o texto já está aprovado, mas o envio só
destrava quando a linha sai da cópia em data/snippets.)

TEXTO aprovado pelo editor em 09/11/2026 (e-mail 6, reenvio anual), no tom dos
e-mails do formulário: abre com "Olá! Tudo bem?", sem "Pixel aqui".

Origem: overnight, #12490, decisão do editor de 09/11/2026: a cada 12
meses, quem já respondeu recebe o formulário de novo, com um e-mail dizendo
que a pessoa já respondeu, mas muita coisa pode ter mudado). Fonte
versionada: `onboarding-followup-run.ts --init-snippets` copia este arquivo
para data/snippets/formulario-anual.md (nunca sobrescreve um texto já
editado). O envio segue travado enquanto a linha do marcador acima existir.
O corpo precisa conter {{FORM_URL}} (o mesmo link assinado do formulário).
{{RESPONDEU_EM}} vira "{mês} de {ano}" da última resposta de quem está no
lote (o lote sai um mês de resposta por vez). O preview_text NÃO troca
placeholders: se o editor quiser o mês no preview, reescrever sem ele.
O formulário abre vazio (decisão do escopo da issue: não pré-preencher).
-->
<p>Olá! Tudo bem?</p>
<p>Em {{RESPONDEU_EM}} você respondeu o formulário sobre o seu trabalho e sobre como usa IA. Obrigado de novo por isso.</p>
<p>Em um ano muda muita coisa: as ferramentas, o jeito como você usa IA, o que você quer aprender. Responde de novo? Leva uns três minutos, e com as respostas deste ano eu vejo o que mudou e ajusto as edições.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder de novo</a></p>
<p>Quando você enviar, os lembretes param.</p>
<p>Obrigado,<br>Pixel</p>
