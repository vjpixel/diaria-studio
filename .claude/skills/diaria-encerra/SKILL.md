---
name: diaria-encerra
description: Encerra uma sessão interativa verificando achados sem issue e pendências da sessão. Use para “esquecemos alguma issue?” e “posso encerrar esta sessão?”.
---

# /diaria-encerra

Execute as duas etapas na ordem. Standalone: não encadeie outra skill ou stage.

## 1. Issues esquecidas

Releia a sessão inteira disponível (incluindo resumos de contexto e resultados de
tasks): bugs vistos de passagem, “depois a gente vê”, workarounds sem registro,
promessas não cumpridas e follow-ups de PRs mergeadas. Monte uma lista com a
evidência de cada achado. Se o histórico estiver incompleto, declare o limite;
não afirme que revisou trechos indisponíveis.

Deduplicate cada candidato no GitHub antes de criar: `gh issue list --state all
--search '<termos específicos>' --json number,title,state,url`, variando os termos
e lendo corpo/comentários relevantes dos resultados. Consulte abertas e fechadas
recentes; uma issue fechada só cobre o achado se sua resolução também o cobrir.
Se a consulta falhar, registre a checagem como inconclusiva e não crie duplicatas
às cegas. Crie as faltantes diretamente, sem perguntar, com tipo e exatamente uma
prioridade P0/P1/P2/P3, justificativa da prioridade e evidência no corpo.
Achado vira issue e para ali: não implemente o backlog encontrado.

Mostre número + título das criadas, as já cobertas, ou “nenhuma faltando” com o
que foi conferido. Prossiga para a segunda etapa mesmo se houver checagem inconclusiva.

## 2. Pode encerrar?

Obtenha o ID real desta sessão do runtime/beacon/registry, nunca de outra sessão
nem inventado. Rode no repositório:

```bash
npx tsx scripts/session-close-check.ts --session-id '<ID real>'
```

No elo Codex do contínuo, o script aceita `DIARIA_INJECTED_SESSION_ID` sem flag.
O script lê o registry e verifica claims locais/estrangeiras, worktrees atribuídos,
mudanças locais, commits à frente do upstream atualizado, PRs abertas das branches
e stashes desde o início. É somente leitura exceto pelo fetch de refs remotas.
Worktrees usados nesta sessão que não constem no registry devem ser conferidos
também: repita com `--worktree '<caminho>'` para cada um, inclusive o checkout
atual se foi usado. Não use `known_worktrees` como prova de autoria: é mapa global.
Erro, upstream ausente, identidade ausente ou resultado incompleto impedem atestar
encerramento; não trate falha do GitHub como “nenhuma PR”.

Confira explicitamente as `manualChecks`: tasks e agents disparados pela sessão
nas ferramentas do runtime (não pelo PID efêmero do registry), promessas feitas,
trabalho ainda em curso e follow-ups no transcript. Stashes desde o início são
candidatos: confirme autoria pelo histórico, preservando os de terceiros.

Resolva o que estiver ao alcance dentro da autorização existente: finalize e
verifique trabalho já pedido, commite só arquivos próprios, envie commits,
aguarde/finalize tasks próprias e recupere stashes próprios antes de removê-los.
Não descarte mudanças nem encerre processos de terceiros. PR aberta precisa de
review/CI conforme a política da sessão; respeite proibição de merge ou coordenação
externa, registrando o handoff como pendência em vez de mergear.
Libere claims desta sessão quando não houver mais implementação local pendente,
usando `session-registry.ts unclaim-issue --issue ... --kind ...` como comando
standalone, sem inventar `--session-id` (injeção do runtime). Inclua claims de
outros repos com a referência canônica. Não encerre o registro do tick delegado.

Repita a checagem após resolver as pendências. Responda **“pode encerrar”** só
quando as duas etapas forem conclusivas, `canClose=true` e as checagens manuais
estiverem livres. Caso contrário, **“ainda não”** com o que falta e quem está
responsável. Não peça confirmação pós-sucesso nem encadeie implementação de issues.

## Migração da memória após merge (#11524)

Depois de confirmar que a PR desta skill foi mergeada, substitua a entrada local
`feedback_frases-de-encerramento-de-sessao.md` por um ponteiro para esta skill e
ajuste a linha correspondente no `MEMORY.md` do projeto. Localize a memória real
da máquina, preserve outras entradas e não crie uma cópia versionada da memória.
Se não houver acesso à memória na máquina do editor, registre essa pendência no
handoff pós-merge; não declare a migração feita. Antes do merge, preserve a memória.
