<!--
lembrete do convite anual, no máximo 1 (#12490)
assunto: "Ainda dá tempo de atualizar suas respostas"
preview_text: "Uns três minutos, e eu vejo o que mudou pra você."
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.
(O marcador fica aqui DE PROPÓSITO: o texto já está aprovado, mas o envio só
destrava quando a linha sai da cópia em data/snippets.)

TEXTO aprovado pelo editor em 09/11/2026 (e-mail 7, lembrete do anual), no tom dos
e-mails do formulário: abre com "Olá! Tudo bem?", sem "Pixel aqui".

Origem: overnight, #12490. Vai para quem recebeu o convite anual e não
respondeu, 30 dias depois dele (form_reminder_days), no máximo
form_annual_reminder_max vezes (1, escopo da issue "a ser confirmado" pelo
editor). Copiado para data/snippets/formulario-anual-lembrete.md por
`--init-snippets`. O corpo precisa conter {{FORM_URL}}; {{RESPONDEU_EM}} é
opcional e vira "{mês} de {ano}" da última resposta.
-->
<p>Olá! Tudo bem?</p>
<p>Mês passado te mandei o formulário de novo, pra saber o que mudou desde a sua resposta de {{RESPONDEU_EM}}, e a nova ainda não chegou.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder de novo</a></p>
<p>Esse é o último lembrete sobre isso. Se não quiser responder, sem problema: a newsletter continua igual.</p>
<p>Pixel</p>
