<!--
lembrete 2 de 3 do formulário (#10605)
assunto: "Ainda queria te ouvir"
preview_text: "Três minutos pra me ajudar a decidir o que vem além da newsletter."
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.

TEXTO v3, aprovado pelo editor em 09/11/2026 (e-mail 4, lembrete 2).
O executor escolhe o texto pelo número do lembrete da pessoa (1º, 2º ou 3º,
FORM_REMINDER_STEPS em scripts/lib/onboarding-followup.ts). Quem recebeu o
convite do onboarding recebe em D+19, D+49 e D+79 da confirmação do
cadastro; quem recebeu o e-mail da base, 30 dias depois do envio anterior.
Por isso o texto não cita qual convite a pessoa recebeu. O destravamento é em
data/snippets, depois do merge (`--init-snippets` copia este arquivo para
data/snippets/formulario-lembrete-2.md, sem sobrescrever texto editado).
-->
<p>Olá! Tudo bem?</p>
<p>Estou usando as respostas do formulário pra decidir o que a diar.ia.br vai oferecer além da newsletter, e ainda falta a sua.</p>
<p>Leva uns três minutos, e as obrigatórias são todas de marcar.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder o formulário</a></p>
<p>Se não quiser responder, sem problema: a newsletter continua igual.</p>
<p>Pixel</p>
