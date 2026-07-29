<!--
nome: PARA ENCERRAR
categoria: Para Encerrar
Bloco canônico de ENCERRAMENTO — convite social (LinkedIn/Facebook/Instagram) + apoio via Apoia.se. Fonte única reaproveitada tanto no diário (seção `PARA ENCERRAR`, injetada por `scripts/stitch-newsletter.ts` via `scripts/lib/shared/
encerramento-snippet.ts`) quanto no mensal (seção `PARA ENCERRAR`, escrita
pelo `writer-monthly` a partir deste arquivo — #3219).

#4274 (diário apenas): este arquivo virou o DEFAULT/fallback do diário, não
a fonte editada diretamente todo dia — o conteúdo (parágrafo de apoio +
bloco de ferramentas = slot A, convite social = slot B) agora é editável
pelo painel Caixas do Studio, persistido em `platform.config.json` →
`para_encerrar.slot_a`/`para_encerrar.slot_b`. `buildParaEncerrar()` (stitch-newsletter.ts)
lê o config primeiro; só cai de volta neste arquivo quando um slot não tem
override (config ausente, campo vazio, ou edição anterior ao #4274). O
mensal (`writer-monthly`) continua lendo este arquivo diretamente — não foi
tocado pelo #4274.

Marcador `{{OPENING}}` no início do parágrafo de apoio é substituído conforme o formato (a frase de apoio em si — "Quem quiser apoiar..." — é IDÊNTICA nos dois formatos; só a cláusula de abertura muda):

  - Diário:  "" (vazio — o parágrafo já abre direto em "Quem quiser apoiar...")
  - Mensal:  "Esta edição mensal nasce da **diar.ia.br**, newsletter diária
             gratuita sobre IA. " (nota o espaço final antes de "Quem quiser")

O parágrafo de convite social (LinkedIn/Facebook/Instagram) é IDÊNTICO nos
dois formatos — sem parametrização.
-->

{{OPENING}}Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria) para ganhar recompensas como artigo especial do mês, sorteios e acesso antecipado a novos projetos.

Agora que chegou ao final da edição, siga a **diar.ia.br** no [LinkedIn](https://www.linkedin.com/company/diar.ia.br/), no [Facebook](https://www.facebook.com/diar.ia.br) ou no [Instagram](https://www.instagram.com/diar.ia.br). Todo dia publicamos por lá um resumo das 3 principais notícias.
