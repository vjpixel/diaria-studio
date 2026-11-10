<!--
link dos resultados para quem respondeu depois do envio da edição especial (#12495)
assunto: "O que descobri com o formulário"
preview_text: "A edição especial com os resultados, só pra quem respondeu."
ONBOARDING-CORPO-PENDENTE — remover esta linha quando o editor aprovar o texto.
(O marcador fica aqui DE PROPÓSITO: o texto já está aprovado, mas o envio só
destrava quando a linha sai da cópia em data/snippets.)

TEXTO aprovado pelo editor em 09/11/2026 (e-mail 8, resultados), no tom dos
e-mails do formulário: abre com "Olá! Tudo bem?", sem "Pixel aqui".

Origem: overnight, #12495, decisão do editor de 09/11/2026: os resultados
saem como edição especial, um e-mail só para quem respondeu, com uma versão
web restrita — fora da busca, link entregue só a quem respondeu). Este
e-mail vai para quem responde DEPOIS do envio da edição especial, que assim
recebe o que os e-mails do formulário prometem. Só sai com
onboarding.followup.results_url e results_published_at preenchidos (e os
mesmos valores em RESULTS_URL/RESULTS_PUBLISHED_AT no wrangler.toml do
formulário). Copiado para data/snippets/formulario-resultados.md por
`--init-snippets`. O corpo precisa conter {{RESULTADOS_URL}} e não pode
conter {{FORM_URL}}. O nome "Artigo Especial" fica reservado ao produto dos
apoiadores: aqui é "edição especial".
-->
<p>Olá! Tudo bem?</p>
<p>Obrigado por responder o formulário. No convite eu prometi contar o que descobri numa edição especial só pra quem respondeu. Ela já saiu, e você pode ler aqui:</p>
<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="{{RESULTADOS_URL}}">Ler a edição especial</a></p>
<p>Obrigado,<br>Pixel</p>
