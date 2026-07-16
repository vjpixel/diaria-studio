<!--
Bloco canônico de DIVULGAÇÃO da diar.ia.br para a base da Clarice (cross-promo
na newsletter MENSAL). É a Clarice recomendando a diária aos leitores dela —
por isso o tom de endosso ("Recomendação da equipe da Clarice"). Criado 260716
a partir do box improvisado da edição 2606-07 ("Um recado rápido da equipe da
Clarice"), com copy revisada: endosso > recado; "grátis" visível no corpo E no
botão (maior removedor de fricção); benefício no lugar de ficha técnica
("leitura diária de 5 minutos", não "com 5 minutos de leitura"); CTA reforçado.

Formato (título + corpo + CTA): (1) linha de título, sem marcador nem link;
(2) 1 parágrafo de corpo; (3) o CTA sozinho como `→ [texto](url)` — por ser o
ÚNICO conteúdo do parágrafo, shouldForceCtaPill (newsletter-render-html.ts)
detecta e vira botão pill centralizado.

Link com utm_source=clarice (obrigatório — rastreia quantos assinantes da
diária vieram pela mensal; usar diaria.beehiiv.com DIRETO, pois diar.ia.br
dropa a query string no redirect, #2613). NÃO usar diar.ia.br como href.

Uso na mensal: o editor cola este bloco numa lacuna de divulgação entre
destaques, isolado por `---`. Não é auto-inserido pelo pipeline.
-->

Recomendação da equipe da Clarice

Quem escreve com a gente sabe que clareza importa. Por isso, fechamos parceria com a diar.ia.br: uma leitura diária de 5 minutos sobre o que está mudando na forma como escrevemos e trabalhamos com IA. Assine de graça para receber uma edição todos os dias.

→ [Assinar grátis](https://diaria.beehiiv.com/?utm_source=clarice)
