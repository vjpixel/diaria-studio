<!--
assunto: "Você está dentro. Aqui está o que muda a partir de agora"
preview_text: "5 minutos por dia, direto no seu inbox, sem enrolação."

Exportado da automação Beehiiv 'Onboarding — Boas-vindas'
(aut_48bcae89-e812-4711-a6ea-1f0729e7e6d8, #5808) via get_automation_email_content
(workspace staging, format editor_html) em 2026-08-23, #5908.

#12501: corpo reescrito no tom dos e-mails pessoais definido pelo editor na
#10605 ("Olá! Tudo bem?" num parágrafo próprio, registro do dia a dia, sem
explicar o mecanismo, assinatura "Pixel"). Assunto e preview mantidos.
Proposta versionada: entra em data/snippets/onboarding-1.md só depois da
aprovação do editor, com a versão anterior guardada em data/snippets/_arquivo/.
Ao copiar, trocar as duas ocorrências de {{EMAIL_CONTATO}} pelo endereço que o
item 2 da versão atual de data/snippets/onboarding-1.md já usa (o remetente
oi@ do domínio da newsletter). O endereço literal não fica no git porque o
guard de PII do gh pr create (#6753) barra e-mail fora de fixture; o executor
não substitui o placeholder sozinho.
-->
<p>Olá! Tudo bem?</p>
<p>Que bom ter você na <a target="_blank" rel="noopener noreferrer nofollow" class="link" href="https://diar.ia.br">diar.ia.br</a>. De segunda a sexta chega uma edição de 5 minutos com o que importa em IA: notícias, pesquisas, tendências e tutoriais, sempre escolhidos pelo que muda o seu trabalho aqui no Brasil.</p>
<p>Pra ela não se perder no meio dos outros e-mails, faz duas coisas rapidinhas?</p>
<ol>
<li><p>Se este e-mail caiu em Promoções ou em Spam, arrasta ele pra aba Principal (ou marca como “não é spam”).</p></li>
<li><p>Coloca <a target="_blank" rel="noopener noreferrer nofollow" class="link" href="mailto:{{EMAIL_CONTATO}}">{{EMAIL_CONTATO}}</a> nos seus contatos.</p></li>
</ol>
<p>Assim a próxima edição já cai direto onde você olha.</p>
<p>Até lá!</p>
<p>Pixel</p>
