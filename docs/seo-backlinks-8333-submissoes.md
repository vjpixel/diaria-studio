# Backlinks #8333 — textos prontos e passo a passo do editor

Material de apoio à execução dos 5 primeiros alvos do plano (`docs/seo-backlinks-plan.md`, #8068)
e do pitch ao Distrito. **Nenhuma submissão foi feita por sessão automatizada** — tudo abaixo é
ação do editor (cadastro em terceiro = decisão de marca, e Meco exige conta de publisher).

## Estado em 20/09/2026

| Alvo | Estado | Próxima ação |
|---|---|---|
| randalmaia/awesome-newsletters | PR #7 aberta, 0 comentários/reviews, não mergeada (https://github.com/randalmaia/awesome-newsletters/pull/7) | aguardar; entrada: `* [diar.ia.br](https://diar.ia.br) - ***(pt-BR)*** Daily newsletter about artificial intelligence in Portuguese: curated news, launches and analysis, with a focus on Brazil.` |
| MachineLearningBR/recursos | PR #22 aberta, 0 comentários/reviews, não mergeada (https://github.com/MachineLearningBR/recursos/pull/22) | aguardar |
| Manual do Usuário / Lerama | pendente — exigia URL de feed RSS | **destravado**: `https://diar.ia.br/feed.xml` (esta PR; vale após deploy do Worker `workers/site`) |
| Feedspot | pendente | usar o feed (abaixo) |
| Meco | pendente | só o editor (conta de publisher) |
| diretorio.email | **domínio não resolve** (verificado 20/09: `nslookup` no 1.1.1.1 devolve NXDOMAIN; curl sem resposta, com e sem `www`) — tratar como morto; sem ação | reverificar só se aparecer link novo |
| Distrito | pendente — página sem e-mail editorial (só redes sociais) | pitch abaixo |

## Pré-requisito: feed no ar

`https://diar.ia.br/feed.xml` (RSS 2.0, 50 edições mais recentes, regenerado diariamente pelo
`regen-home`; anunciado por `<link rel="alternate">` na home e em `/archive`). **Só existe em
produção depois do deploy manual do Worker `workers/site`** (`wrangler deploy`, ação do editor).
Antes de submeter qualquer formulário: `curl -I https://diar.ia.br/feed.xml` deve dar 200 com
`content-type: application/rss+xml`. Opcional: validar em https://validator.w3.org/feed/.

## Texto padrão (reusar em todos os formulários)

- **Nome:** diar.ia.br
- **URL:** https://diar.ia.br
- **Feed RSS:** https://diar.ia.br/feed.xml
- **Descrição curta (≤160):** Newsletter diária de inteligência artificial em português: notícias, lançamentos e como usar melhor as IAs, em 5 minutos, grátis.
- **Descrição longa:** A diar.ia.br é uma newsletter brasileira, publicada todos os dias desde agosto de 2025 (mais de 270 edições), sobre inteligência artificial. Cada edição traz 3 destaques com contexto e "por que isso importa", lançamentos com link oficial, dicas para usar melhor as IAs e um radar de notícias, com foco no que muda para o leitor brasileiro. Leitura de cerca de 5 minutos, gratuita, com todo o acervo aberto no site.
- **Categoria:** Tecnologia / Inteligência Artificial (idioma: português do Brasil)
- **Frequência:** diária (segunda a sexta ou conforme calendário vigente — conferir antes de preencher)
- **Cadastro / inscrição:** https://diar.ia.br
- **Arquivo:** https://diar.ia.br/archive
- **Contato:** o e-mail que o editor preferir expor (não versionado aqui)

## 1. Manual do Usuário / Lerama

1. Abrir https://lerama.pcdomanual.com/suggest-feed (o diretório foi fundido ao Lerama).
2. Campo do feed: `https://diar.ia.br/feed.xml`. Nome e descrição: texto padrão acima.
3. Enviar. O plano registra que diar.ia.br cumpre os critérios de aceite (autoria humana revisada, publicação diária há mais de 3 meses).

## 2. Feedspot

1. https://rss.feedspot.com/ai_rss_feeds/ (ou https://bloggers.feedspot.com/ai_blogs/) → "Submit Your Blog/Newsletter".
2. URL do feed: `https://diar.ia.br/feed.xml`; descrição: curta/longa acima.
3. Alternativa se o botão falhar: e-mail ao contato da Feedspot (endereço no comentário de 20/09 da issue #8333, não versionado aqui) com o texto:

> Olá! Sou o editor da diar.ia.br, newsletter diária de IA em português (270+ edições desde agosto/2025). Gostaria de sugerir a inclusão na lista de Top AI Newsletters/Blogs. Feed: https://diar.ia.br/feed.xml — site: https://diar.ia.br. Obrigado!

## 3. Meco (só o editor)

1. Criar conta de publisher em https://meco.app/partner-program e concluir o cadastro do Partner Program.
2. Preencher perfil com o texto padrão. Duplo ganho: diretório de descoberta + cross-promoção com outras newsletters.

## 4. Pitch ao Distrito (alvo #19)

Página: https://www.distrito.me/blog/conheca-7-newsletters-de-ia-para-se-manter-atualizado
("Conheça 7 newsletters de IA para se manter atualizado"). Sem e-mail editorial publicado: usar
o canal que o editor achar melhor entre as redes sociais/DM da Distrito ou o formulário de
contato do site (https://www.distrito.me/), citando a página.

Argumentos de valor (verificados em 20/09):

- A lista tem 7 newsletters, todas em inglês ou de alcance pequeno para o leitor brasileiro
  (ex.: AI Factory News, IAí?, AI for Non-Techies, AI Drop, AI Breakfast, Mindstream,
  Superhuman AI) — **nenhuma é um diário brasileiro de IA com curadoria própria**; a diar.ia.br
  preenche essa lacuna para quem quer o dia a dia em português.
- Frequência: diária, com 270+ edições publicadas e acervo aberto e indexável.
- Formato compatível com o critério da própria página (edições de ~5 minutos, linguagem direta).
- Evidência de que o leitor de IA já chega até nós por listas assim: um assistente de IA
  recuperou exatamente esta página ao responder sobre newsletters de IA (auditoria GEO,
  #8333) — ser citada nela chega a quem pergunta a assistentes.

Texto sugerido (assunto: "Sugestão para a lista de newsletters de IA"):

> Olá, time do Distrito! Li o post "Conheça 7 newsletters de IA para se manter atualizado" e senti falta de uma newsletter diária de IA feita no Brasil. Edito a diar.ia.br: 270+ edições desde agosto de 2025, 3 destaques por dia com contexto, lançamentos com link oficial e dicas para usar melhor as IAs, em cerca de 5 minutos. Acervo completo em https://diar.ia.br/archive e feed em https://diar.ia.br/feed.xml. Se fizer sentido, adorariam considerar a diar.ia.br numa próxima atualização da lista. Posso enviar mais dados ou uma edição de exemplo. Obrigado!

## Como medir

Re-rodar `scripts/bing-pull.ts` (task mensal) e observar `total_distinct_domains` sair de 0;
acompanhar o painel `geral` em `data/geo-citations/history.jsonl` (base 9/134 = 6,7%).
