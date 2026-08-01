<!--
nome: PARA ENCERRAR
categoria: Para Encerrar
Bloco canônico de ENCERRAMENTO — convite social (LinkedIn/Facebook/Instagram) + apoio via Apoia.se + créditos de ferramentas. Fonte única reaproveitada tanto no diário (seção `PARA ENCERRAR`, injetada por `scripts/stitch-newsletter.ts` via `scripts/lib/shared/
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

O parágrafo de créditos ("Nesta edição da...") ficou de fora deste arquivo
até o ciclo 2607-08 (só existia em `platform.config.json → para_encerrar.slot_a`,
usado pelo diário) — achado ao vivo no gate do editor: a mensal saía sem
créditos de ferramentas. Adicionado aqui como padrão pros dois formatos.

Marcador `{{OPENING}}` no início do parágrafo de apoio é substituído conforme o formato (a frase de apoio em si — "Quem quiser apoiar..." — é IDÊNTICA nos dois formatos; só a cláusula de abertura muda):

  - Diário:  "" (vazio — o parágrafo já abre direto em "Quem quiser apoiar...")
  - Mensal:  "Esta edição mensal nasce da **diar.ia.br**, newsletter diária
             gratuita sobre IA. " (nota o espaço final antes de "Quem quiser")

Os parágrafos de créditos (ferramentas) e de convite social são IDÊNTICOS nos dois formatos — sem parametrização.

O bloco "Acesse nossas curadorias" (pills Cursos de IA/Livros sobre IA) NÃO
está neste arquivo — no diário ele é injetado por código
(`FIXED_BLOCKS.para_encerrar_curadorias` em stitch-newsletter.ts, sempre
entre slot A e slot B); colar aqui duplicaria o bloco no diário. No mensal,
sem esse injetor, o `writer-monthly` precisa escrever a lista
`- [Cursos de IA](https://cursos.diar.ia.br)` / `- [Livros sobre IA](https://livros.diar.ia.br)`
direto no draft (ver context/templates/newsletter-monthly.md) — SEM label
manual "Acesse nossas curadorias:" antes da lista, porque o render
(monthly-render.ts) já gera esse label sozinho ao detectar uma lista de
links nessa posição; um label manual duplica (achado ao vivo, ciclo 2607-08).

Convite social atualizado pros 5 canais ativos (Threads/#3994 Twitter via
Buffer incluídos, ciclo 2607-08 — antes só citava LinkedIn/Facebook/Instagram).
-->

{{OPENING}}Apoie a curadoria contribuindo a partir de R$5/mês em [apoia.se/diaria](https://apoia.se/diaria) para ganhar recompensas como artigo especial do mês, sorteios e acesso antecipado a novos projetos.

Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, Gemini para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).

Agora que chegou ao final da edição, siga a **diar.ia.br** no [LinkedIn](https://www.linkedin.com/company/diar.ia.br/), no [Facebook](https://www.facebook.com/diar.ia.br), no [Instagram](https://www.instagram.com/diar.ia.br), no [Threads](https://www.threads.net/@diar.ia.br) ou no [X](https://x.com/diariabr). Todo dia publicamos por lá um resumo das 3 principais notícias.
