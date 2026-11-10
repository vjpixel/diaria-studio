<!--
lembrete 1 de 3 do formulário, variante para quem tem rascunho (#12504)
assunto: "Viu meu pedido?"
preview_text: "Até doze perguntas, uns três minutos."
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.
(O marcador fica aqui DE PROPÓSITO: o envio só destrava quando a linha sai da
cópia em data/snippets, depois do merge.)

TEXTO da variante, decisão do editor de 09/11/2026 (comentário na #12504,
aprovado no artefato da #10605): igual ao formulario-lembrete-1.md, só o 1º
parágrafo depois de "Olá! Tudo bem?" muda. Vai para quem começou o formulário
e parou (tem rascunho no Worker, inclusive quem preencheu tudo e não clicou em
Enviar). O executor monta um lote próprio para esse grupo
(FORM_REMINDER_DRAFT_VARIANTS em scripts/lib/onboarding-followup.ts). Com este
texto pendente, ausente ou sem {{FORM_URL}}, quem tem rascunho recebe o texto
padrão: a variante nunca trava o lembrete. `--init-snippets` copia este
arquivo para data/snippets/formulario-lembrete-1-rascunho.md, sem sobrescrever
texto editado.
-->
<p>Olá! Tudo bem?</p>
<p>Você começou o formulário e parou no meio. O que você já marcou está salvo, então é só continuar de onde parou.</p>
<p>São até doze perguntas, e as obrigatórias são todas de marcar. É com elas que eu ajusto o que entra nas edições.</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{FORM_URL}}">Responder agora</a></p>
<p>Quando você enviar, os lembretes param.</p>
<p>Pixel</p>
