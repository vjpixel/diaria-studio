50 PRs mergeados no Diar.ia nas últimas 24h.

Eu não digitei a maior parte do código. O Claude Code digitou. Eu abri issues, revisei diffs, comentei o que estava errado, aprovei merge.

O que entrou na main:

— Publicação automática do digest mensal da Clarice via Brevo. A newsletter mensal agora tem distribuição própria, separada da diária.

— Botões de "É IA?" embutidos no email, com merge tag do Beehiiv. Leitor responde com 1 clique e vê o resultado agregado na hora.

— URLs inline em títulos no markdown editorial, com backward compat pra edições antigas.

— Fail-fast em qualquer disconnect de MCP. Antes a pipeline ficava travada esperando uma resposta que não vinha; agora aborta o stage em segundos e me chama pra reconectar.

— Detecção de falha de CI via Gmail no Stage 0. Se o último deploy quebrou, o orchestrator avisa antes da edição começar a rodar.

— 4 refactors movendo código duplicado pra scripts/lib (tipos compartilhados, logging, regex de relevância de IA, drive cache).

— Cobertura de teste em drive-sync e inbox-drain.

— Uns 12 fixes em bug de produção do Stage 1 ao 4 — race condition no published.json, tracker decode quebrado, eia_answer não propagando, idempotência do D1, scorer com URL opaca, fix mode re-renderizando HTML.

A parte que ainda me intriga: a maioria desses PRs nasceu de issues que eu nem abri. Subagentes de auditoria leem o repo, abrem issue com label de prioridade, e outros agentes pegam e atacam Tier A + Tier B autonomamente. Eu só entro pra revisar o que sai.

A pergunta que eu faço todo dia agora — o que como editor eu ainda preciso fazer que a máquina não consegue?

A resposta vai ficando mais curta toda semana.
