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
