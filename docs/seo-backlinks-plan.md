# Plano de backlinks — SEO autoridade (#8068)

Registro de decisão/plano, não runbook de execução automática. Contexto:
`docs/seo-notes.md` Fato 1 já registrou que, com indexação em 88% (#index-status
2026-09-06) e 0 domínios externos linkando (`data/seo/bing-links-2026-09-01.json`
— arquivo vive em `data/`, gitignored; não existe neste worktree porque `data/`
não é sincronizada em worktrees novos, ver CLAUDE.md §2b), a parede que falta
não é on-page — é **autoridade** (backlinks). Este documento é o inventário de
alvos + priorização; a EXECUÇÃO (cadastro em cada diretório/lista) é ação
humana do editor, nunca desta sessão (ver "Regras obrigatórias" da issue:
nenhum cadastro real, formulário preenchido ou e-mail enviado a terceiro).

## Como ler a tabela

- **Tipo de submissão**: como o cadastro/menção acontece na prática.
- **Esforço**: `baixo` (formulário de 1 página, minutos), `médio` (cria conta +
  perfil, ou precisa de e-mail personalizado), `alto` (requer critério de
  aceite não-trivial, curadoria editorial de terceiro, ou networking prévio).
- **Quem executa**: `editor` (decisão de marca/onde a marca aparece — sempre
  humano) ou `script` (uma vez que o editor aprove o alvo, um script deste
  repo pode preparar o material — nunca executar o cadastro em si; ver seção
  "Mecanismo automatizável" no fim).

## Inventário de alvos (22)

### Diretórios de newsletters (curadoria humana, PT-BR)

| # | Nome | URL | Tipo de submissão | Esforço | Quem executa |
|---|---|---|---|---|---|
| 1 | Manual do Usuário — Diretório de Newsletters Brasileiras | https://manualdousuario.net/newsletters-brasileiras/ | Formulário no fim da página (planilha dinâmica, curadoria manual) | baixo | editor |
| 2 | Diretório de Newsletters (diretorio.email) | https://diretorio.email/ | Formulário/contato do site — diretório comunitário de newsletters BR | baixo | editor |
| 3 | BrazilJS — Newsletters brasileiras | https://www.braziljs.org/p/newsletters-brasileiras | Post/lista mantida pela comunidade BrazilJS (Substack) — sugestão via comentário ou contato do autor | médio | editor |
| 4 | Atalho (newsletter sobre newsletters) — "lugar para encontrar as melhores newsletters do Brasil" | https://atalho.substack.com/p/177-um-lugar-para-encontrar-as-melhores | Contato direto com o autor da newsletter pedindo menção/inclusão numa edição futura | médio | editor |
| 5 | Meco — diretório + Partner Program | https://meco.app/partner-program | Cadastro no Partner Program (cross-promoção entre newsletters, paga por lead) — inclusão no diretório de descoberta do app | baixo | editor |

### Diretórios/listas internacionais de newsletters (aceitam qualquer idioma/país)

| # | Nome | URL | Tipo de submissão | Esforço | Quem executa |
|---|---|---|---|---|---|
| 6 | Feedspot — Top AI Newsletters/Blogs | https://rss.feedspot.com/ai_rss_feeds/ (blogs: https://bloggers.feedspot.com/ai_blogs/) | "Submit Your Blog/Newsletter" — formulário, curadoria editorial da Feedspot decide inclusão | médio | editor |
| 7 | Newslettee — database 15k+ newsletters | https://www.producthunt.com/products/newslettee | Cadastro via site do produto (fora do Product Hunt) | baixo | editor |
| 8 | LetterHunt — database newsletters por categoria | https://www.producthunt.com/products/letterhunt | Cadastro via site do produto | baixo | editor |
| 9 | Newsletter Spy — database 20k+ Substacks | https://www.producthunt.com/products/newsletter-spy | Cadastro (foco Substack; diar.ia.br roda em Beehiiv — confirmar se aceitam antes) | baixo | editor |

### Comunidades técnicas BR (menção orgânica aceitável, não é diretório formal)

| # | Nome | URL | Tipo de submissão | Esforço | Quem executa |
|---|---|---|---|---|---|
| 10 | TabNews | https://www.tabnews.com.br/ | Post original ("pitch"/conteúdo de valor) mencionando a newsletter como fonte/contexto — nunca link solto sem conteúdo, a comunidade pune spam | médio | editor |
| 11 | AI HUB Brasil (Discord, ~59k membros) | https://discord.com/invite/tAdPHFAbud | Canal de auto-promoção (se existir) ou participação orgânica com menção ocasional | médio | editor |
| 12 | Comunidade de I.A 🇧🇷 (Telegram) | https://tgrupos.com/comunidade-de-ia/ | Grupo de negócios/empreendedorismo em IA — compartilhamento pontual, checar regras contra spam antes | médio | editor |
| 13 | r/brdev (Reddit) | https://reddit.com/r/brdev | Post ocasional linkando uma edição específica de valor (nunca a newsletter em si como autopromoção pura) — regras do subreddit sobre self-promo variam | médio | editor |
| 14 | r/artificial / r/MachineLearning (Reddit, EN) | https://reddit.com/r/artificial | Idem — audiência maior, mas concorrência de conteúdo em inglês | alto | editor |

### GitHub — listas curadas "awesome-*" (PR aberta, contribuição open-source legítima)

| # | Nome | URL | Tipo de submissão | Esforço | Quem executa |
|---|---|---|---|---|---|
| 15 | randalmaia/awesome-newsletters | https://github.com/randalmaia/awesome-newsletters | Pull Request adicionando 1 linha na seção PT-BR | baixo | script prepara a entrada; editor abre a PR |
| 16 | MachineLearningBR/recursos | https://github.com/MachineLearningBR/recursos | Pull Request adicionando o link na seção de newsletters/blogs | baixo | script prepara a entrada; editor abre a PR |
| 17 | wendelmarques/materiais-de-estudos-sobre-data-science-deep-machine-learning | https://github.com/wendelmarques/materiais-de-estudos-sobre-data-science-deep-machine-learning | Pull Request na seção de canais/newsletters do guia de estudos | baixo | script prepara a entrada; editor abre a PR |
| 18 | italojs/awesome-machine-learning-portugues | https://github.com/italojs/awesome-machine-learning-portugues | Pull Request — verificar se o escopo (plano de estudos) comporta newsletter de notícias antes de submeter | médio | script prepara a entrada; editor abre a PR |

### Listas editoriais / imprensa (menção, não autocadastro — depende de pitch)

| # | Nome | URL | Tipo de submissão | Esforço | Quem executa |
|---|---|---|---|---|---|
| 19 | Distrito — "7 newsletters de IA para se manter atualizado" | https://www.distrito.me/blog/conheca-7-newsletters-de-ia-para-se-manter-atualizado | E-mail de pitch pro time editorial do Distrito pedindo consideração numa atualização futura da lista | alto | editor |
| 20 | Manual do Usuário / AJOR — cobertura institucional do diretório | https://ajor.org.br/manual-do-usuario-reune-mais-de-200-newsletters-brasileiras-em-base-de-dados/ | Sem submissão direta — vale só como contexto de quem mantém o diretório #1 | informativo | — |

### Lançamento de produto (autoridade de domínio alta, ação pontual)

| # | Nome | URL | Tipo de submissão | Esforço | Quem executa |
|---|---|---|---|---|---|
| 21 | Product Hunt — launch da diar.ia.br como produto | https://www.producthunt.com/ | Cadastro de conta + submissão de "launch" (produto/newsletter) — processo de 1 dia, pede preparação de assets (tagline, screenshots) | alto | editor |
| 22 | Tech Launch (alternativa BR ao Product Hunt, comunidade TabNews) | citado em https://www.tabnews.com.br/devzito/pitch-tech-launch-compartilhe-seus-projetos-no-product-hunt-brasileiro | Cadastro de conta + submissão de projeto | médio | editor |

## Priorização — os 5 primeiros

Critério: menor esforço × maior probabilidade de aceite × relevância direta de
nicho (IA + BR) — não é ranqueado por autoridade estimada do domínio (nenhuma
medição de DR/DA foi feita nesta sessão).

1. **#1 Manual do Usuário — Diretório de Newsletters Brasileiras.** Diretório
   mais citado e mais antigo do nicho de newsletters BR; formulário simples;
   diar.ia.br já cumpre os 3 requisitos de aceite (mantida por brasileiro,
   escrita à mão — pipeline gera rascunho mas o editor revisa/aprova todo
   conteúdo no gate de Stage 4 —, e publica diariamente há muito mais de 5
   edições/3 meses).
2. **#2 Diretório de Newsletters (diretorio.email).** Mesmo perfil de esforço
   baixo, nicho adjacente (BR, general).
3. **#5 Meco Partner Program.** Duplo ganho — inclusão no diretório de
   descoberta do app E acesso a um canal de cross-promoção com outras
   newsletters (crescimento de assinantes, não só backlink).
4. **#15 randalmaia/awesome-newsletters (GitHub PR).** Backlink de um domínio
   de autoridade alta (github.com) e processo mecânico (PR de 1 linha) — maior
   retorno por esforço da lista inteira, mesmo com a burocracia extra de abrir
   a PR (ver mecanismo automatizável abaixo).
5. **#6 Feedspot — Top AI Newsletters/Blogs.** Domínio de autoridade alta,
   nicho certeiro (IA), mas com curadoria editorial de terceiro que pode
   recusar — por isso 5º e não mais acima, apesar do esforço de submissão ser
   baixo.

## Nota — cadastro em diretório de terceiro é ação HUMANA

Nenhum destes 22 itens deve ser executado por uma sessão automatizada
(overnight/develop/continuo). Este documento é o inventário e o plano de
priorização; o editor decide **quando** e **em qual ordem** cadastrar — é
decisão editorial de marca (onde e como a diar.ia.br aparece publicamente),
e alguns formulários pedem informação que só o editor tem (conta de e-mail
de contato, preferências de descrição/tagline). Sessões futuras podem
preparar material de apoio (texto de descrição padrão, entrada pronta pra PR
de GitHub — ver abaixo), nunca submeter.

## Mecanismo automatizável — geração de entrada para PR de GitHub

Os alvos #15-18 (listas `awesome-*` no GitHub) aceitam contribuição via Pull
Request — é o fluxo padrão de projeto open-source, sem risco de ToS (não é
scraping nem reverse-engineering; é a via de contribuição que o próprio
mantenedor do repositório disponibiliza publicamente). Esta sessão implementou
`scripts/gen-github-awesome-list-entry.ts`: gera, em Markdown, a linha de
entrada pronta para colar num desses READMEs (nome + URL + descrição curta),
sem tocar em nenhum repositório externo — a abertura da PR em si (fork,
push, `gh pr create` contra um repo de terceiro) continua ação do editor,
fora do escopo desta sessão. Uso:

```
npx tsx scripts/gen-github-awesome-list-entry.ts --target randalmaia
npx tsx scripts/gen-github-awesome-list-entry.ts --target machinelearningbr
npx tsx scripts/gen-github-awesome-list-entry.ts --list
```

`--list` imprime os alvos conhecidos (#15-18 acima) com a URL do repo, pra
facilitar abrir o fork manualmente. O texto gerado é só a LINHA de entrada —
o editor ainda decide onde inserir (a seção certa de cada README) e faz o
`git commit`/PR pelo próprio GitHub (fork via UI, ou `gh repo fork` na sua
sessão local).

no-regression-test: documento + gerador de texto estático, sem lógica de
negócio para reproduzir um bug — nada a regredir.
