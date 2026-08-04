<!--
nome: PARA ENCERRAR
categoria: Para Encerrar
Bloco de ENCERRAMENTO — parágrafo de apoio via Apoia.se + créditos de ferramentas.
Fonte única reaproveitada tanto no diário (seção `PARA ENCERRAR`, injetada por
`scripts/stitch-newsletter.ts` via `scripts/lib/shared/encerramento-snippet.ts`)
quanto no mensal (seção `PARA ENCERRAR`, escrita pelo `writer-monthly` a
partir deste arquivo — #3219).

#4413 (260801, decisão do editor): o convite social ("siga a diar.ia.br
no...") SAIU deste arquivo — virou bloco FIXO (constante `SOCIAL_INVITE` em
`scripts/lib/shared/encerramento-snippet.ts`), idêntico em diário e mensal,
não mais editável por edição. Este arquivo contém APENAS os 2 parágrafos que
continuam editáveis: apoio (Apoia.se) e créditos de ferramentas. No diário,
isto é o SLOT A (`platform.config.json` → `para_encerrar.slot_a`, painel
Caixas do Studio) — `buildParaEncerrar()` lê este arquivo primeiro; só cai de
volta num fallback hardcoded quando o slot A não tem override E este arquivo
está ausente/vazio. O mensal (`writer-monthly`) continua lendo este arquivo
diretamente.

Marcador `{{OPENING}}` no início do parágrafo de apoio é substituído conforme o formato (a frase de apoio em si — "Apoie a curadoria..." — é IDÊNTICA nos dois formatos; só a cláusula de abertura muda):

  - Diário:  "" (vazio — o parágrafo já abre direto em "Apoie a curadoria...")
  - Mensal:  "Essa edição mensal nasce da **diar.ia.br**, newsletter diária
             gratuita sobre IA. " (nota o espaço final antes de "Apoie")

O parágrafo de créditos (ferramentas) é IDÊNTICO nos dois formatos — sem parametrização.

O bloco "Acesse nossas curadorias" (pills Cursos/Livros/Equipamentos/Arquivo, #4411/#4536)
e o convite social (#4413) NÃO estão neste arquivo — os dois são blocos FIXOS
compartilhados via `scripts/lib/shared/encerramento-snippet.ts`
(`CURADORIA_PILLS`/`SOCIAL_INVITE`). No diário, `buildParaEncerrar()` injeta
os dois em código, sempre nesta ordem: slot A (este arquivo) > pills >
convite social. No mensal, o `writer-monthly` cita as duas constantes
literalmente no prompt (drift-guardado por
`test/encerramento-social-apoio-3219.test.ts` contra as constantes reais).
-->

{{OPENING}}Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria) para ganhar recompensas como **artigo especial do mês**, **sorteios** e **acesso antecipado a novos projetos**.

Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).
