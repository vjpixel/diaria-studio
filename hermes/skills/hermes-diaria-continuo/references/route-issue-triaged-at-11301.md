# Re-roteamento após releitura (#11301/#11315)

Em TODA chamada de `route-issue.ts` para issue existente, passar
`--triaged-at "{triaged_at}"`. Depois de postar `decisao-editor` (ou outro
marcador próprio), reler corpo, labels e TODOS os comentários antes de rotear.
Capturar `triaged_at` em ISO no início dessa nova leitura, após a postagem; só
usá-lo quando a leitura terminar com sucesso e o veredito estiver confirmado.
Nunca reutilizar o início da sessão nem gerar o timestamp apenas na hora da
escrita. Se surgir marcador concorrente posterior, reler e reavaliar; não usar
`--override-newer` para destravar automaticamente. Isso também vale para
reclassificações posteriores na mesma sessão e chamadas sem identidade no
registry.

**`--session-id "$SESSION_ID"` também em TODA chamada (#13683).** O
`route-issue.ts` solta a claim da sessão que roteia quando o kind dela não
pertence ao track de destino (#13605), mas só a da própria sessão, e sem
`--session-id` não solta nada (#13671). O Hermes roda fora do Claude Code, então
o hook `inject-session-id` não acrescenta a flag: passar o mesmo `$SESSION_ID`
do tick (passo 3 de "Cada ciclo" no SKILL.md) usado no `claim-issue`. Sem ela, a claim
`continuo` fica na issue roteada para `develop`/`bloqueada` e a sessão develop
recebe `github-claim` até a claim expirar (24h). Forma completa:

    npx tsx scripts/route-issue.ts --issue N --track {track} --reason "{motivo}" \
      --triaged-at "{triaged_at}" --session-id "$SESSION_ID"
