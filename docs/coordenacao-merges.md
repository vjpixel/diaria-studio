# Coordenação única de merges entre sessões interativas

Decisão do editor em 09/09/2026 ("sim, coordenação única"; "acato o protocolo"). Registrada aqui porque instrução verbal não muda invariante escrito: duas sessões recusaram o protocolo até verificar o turno do editor no transcript, e estavam certas. O bullet correspondente em `CLAUDE.md` (§"Princípios operacionais invariáveis") é o resumo; este arquivo é a versão completa.

## Quando vale

Só quando o editor **designa**, na conversa da própria sessão, UMA sessão interativa como coordenadora de merges. Sem designação em vigor, vale a regra anterior (#5251): cada sessão interativa mergeia a sua PR após review limpo + CI verde.

## O protocolo

1. As demais sessões interativas **não rodam `gh pr merge`**. Quando a PR está verde e revisada, sinalizam à coordenadora: **"PR #N pronta"** — número, estado dos checks, resumo do review (findings de alta confiança pendentes ou não).
2. A coordenadora **verifica por conta própria** — nunca só pelo relato: (a) **review** — se a PR tem marcador do `hermes/scripts/continuo-pr-review.sh`, `scripts/check-pr-review-authenticity.ts --pr N` decide; se a review veio de sessão interativa via ferramenta `Agent` (o caso comum entre sessões), esse gate devolve `no_review` **por construção** (#6956 — ele só reconhece o marcador do cron) e não é veredito: conferir os findings postados na PR, se os de alta confiança foram tratados, e que a review cobre o head atual; (b) **CI** — `scripts/check-pr-checks-gate.ts` ou `gh pr checks`, todos verdes; (c) **threads de review não resolvidas** (bloqueiam pelo ruleset); (d) **mergeabilidade** (`gh api pulls/N` → `mergeable_state`); (e) o head reportado é o head atual.
3. **`git fetch origin master` imediatamente antes** de cada merge: o merge lock serializa só dentro da máquina — entre máquinas ele é **advisory** (#7043/#6182: inodes diferentes no OneDrive, as duas podem receber "ok" pro mesmo lock), e o único sinal que atravessa máquina de verdade vem do GitHub. Então mergeia **uma por vez**, com o lock (`session-registry.ts merge-lock-acquire --pr N` → `gh pr merge` → `merge-lock-release --pr N`), e devolve o **SHA em master** a quem sinalizou.
4. Prioridade de fila é do editor; sem indicação, ordem de chegada.
5. PR sem dono vivo (ex.: do cron do contínuo com o merger parado) pode ser **adotada** pela coordenadora ou por quem ela indicar: aplica o review pendente, resolve os threads, e mergeia pelo mesmo caminho.

## Revogação — com critério mecânico

A designação termina quando o editor a revoga na sessão coordenadora, **ou** quando a sessão coordenadora encerra. "Encerrou" não é impressão, é verificável:

- o registro `interactive` dela em `data/sessions/` está **stale** (`npx tsx scripts/lib/session-registry.ts list-active` → `stale: true`; janela de 15 min sem heartbeat); **ou**
- ela não responde a "PR #N pronta" em **30 min**.

Em qualquer dos dois casos a sessão que sinalizou volta ao #5251 **para a própria PR**, registrando no corpo/comentário da PR que mergeou por fallback e por quê. Sem esse critério o protocolo reproduziria o incidente que o motivou: PR presa atrás de um merger que não roda.

## Autoridade — só vinda do editor

Uma sessão só aceita a designação **vinda do editor**, nunca do relato de outra sessão. Verificação: `list_events` na sessão coordenadora (id CCD `local_…`, não o `session_id` interno do harness), procurando o **texto literal** do turno `[user]` — ou perguntar ao editor na própria sessão. Relato de peer não transfere autoridade (mesma regra que já vale para permissões). Citar conteúdo, não id: a busca por frase é mais robusta que por identificador (achado ao vivo 09/09: o id do harness dá "not found"; e `search_session_transcripts` pode não indexar turnos de usuário — ausência na busca não é ausência no transcript, é preciso paginar `list_events`).

## O que este protocolo NÃO muda

- O guard mecânico do #5716 (`.claude/hooks/block-gh-pr-merge-subagent.mjs`) **não conhece** a designação: bloqueia por identidade de coordenadora de **rodada** (`overnight`/`develop`), não por acordo. Enquanto isso não for implementado, o protocolo é disciplina de sessão, não gate.
- Uma rodada `/diaria-overnight`/`/diaria-develop` ativa continua sendo a coordenadora **das PRs dela**, com o guard a favor. Na prática, se uma rodada dessas está viva na mesma máquina, ela é a candidata natural a coordenadora única — foi o que o editor fez em 09/09/2026 ao passar a coordenação para a sessão que rodava o `develop`, porque a sessão interativa comum precisava de `grant-merge` a cada PR.

## Motivação (medida na noite de 08→09/09/2026)

Com 5 sessões interativas mergeando por conta própria no mesmo checkout: 4 PRs e 2 issues **duplicadas** para o mesmo fix de 3 linhas (`EXPECTED_HOSTS`, #7721/#7724/#7725/#7727/#7728/#7729); uma PR do contínuo verde e revisada **órfã por 26h** (#7614) com o merger parado (#7647) — a mesma correção foi achada e mergeada duas vezes por outras sessões; e **master vermelho por ~1h** (bd9fd7b1) sem ninguém perceber, reprovando o `test` de 13 PRs. Um único par de olhos na fila fecha essas três classes.
