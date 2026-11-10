# Trocar a mídia de um vertical agendado (#12279)

`--replace-scheduled` é uma funcionalidade nova; não remove os fluxos existentes
de publicação nem `--update-scheduled`, que continua trocando apenas texto e capa.
Para V1 por V2 da edição:

```sh
npx tsx scripts/publish-shorts.ts AAMMDD --replace-scheduled --video PATH
npx tsx scripts/publish-shorts.ts AAMMDD --replace-scheduled --video PATH --publish --confirm-publish AAMMDD
```

O primeiro comando só lê e imprime o plano. O segundo exige a confirmação da
edição, relê o estado remoto, apaga os agendados do YouTube/Facebook, arquiva
cada ID removido, limpa suas marcas de envio e chama o publisher apenas para
esse destino, preservando seu horário. Use `--only` para restringir destinos.
Publicado, envio ambíguo, estado desconhecido e horário a 30 minutos ou menos
ficam fora. Corte avulso, timers, download e `--now` não combinam com a troca.

X e TikTok continuam sendo executados pela skill através da Buffer MCP:

1. Para cada item `action: buffer`, chamar `get_post` com o ID sem `buffer:`.
   Conferir que segue na fila, não enviado e com `dueAt` com mais de 30 minutos de folga. Estado
   desconhecido, falha de leitura ou envio já realizado: parar nesse destino.
2. Chamar `delete_post`. Só com exclusão confirmada, repetir o segundo comando
   com `--only x` e `--buffer-deleted x=buffer:ID` (ou `tiktok=buffer:ID`). A flag
   é o recibo explícito da exclusão verificada pela skill; não executa a MCP.
3. `results[].publication.results[].buffer` contém o preparo para `create_post`.
   Criar o novo agendamento na Buffer, conferir e registrar com
   `--mark x=buffer:NOVO_ID --scheduled-at ISO --video-sha256 SHA256` usando
   `videoSha256` do preparo. Mesmo procedimento para TikTok. Preparo não é post
   criado; não relatar sucesso até o novo registro.

Nenhum registro Buffer é liberado enquanto faltar a confirmação do passo 2.

O histórico `_internal/shorts-replacement-history.json` guarda a entrada antiga
por destino/ID e impede que um registro antigo ou uma cópia de conflito do
OneDrive faça o ID apagado voltar a contar como concluído. Outros destinos e
registros dos timers são preservados. Não apagar o histórico durante recuperação.
Se a API não confirmar a exclusão, o registro original fica: conferir a conta
antes de tentar novamente. Se o upload novo falhar depois da exclusão, o erro
indica como reexecutar apenas o destino; conferir antes qualquer `send_unknown`.
A troca não é atômica entre plataformas: falha de uma não desfaz as outras.

Novos uploads guardam `video_sha256`; os preparos da Buffer devolvem o hash para
`--mark`. Um dry-run normal avisa quando os bytes locais diferem dos registrados,
inclusive re-export no mesmo nome. Registros anteriores a esta mudança não têm
hash e não permitem comparação retroativa. A comparação é com o arquivo local:
ela não fixa a versão dos timers. Upload via `--from-drive` também guarda o
nome do export (validado contra o hash dos bytes). O dry-run do
`fetch-drive-video.ts --orientation vertical` consulta o Drive mesmo com destinos
concluídos quando há essa origem registrada e avisa se o export selecionado tem
V maior. Registros antigos sem nome não permitem a comparação de V. Conferir o
plano depois de baixar o V2 e antes de autorizar qualquer destino pendente.

A janela de exclusão exige mais de 30 minutos (20 minutos de folga sobre o
guard de 10 minutos do novo upload). A releitura remota aplica a mesma margem.
Isso reduz a falha entre exclusão e upload; não torna a troca atômica.

Se houver `publication_unparsed: true`, o filho terminou com exit 0, mas seu
resultado não pôde ser interpretado. Não repetir `--publish` automaticamente.
Para YouTube/Facebook, reler o registro e conferir a plataforma antes de agir.
Para X/TikTok, recuperar apenas o preparo R2: `publish-shorts.ts AAMMDD
--only x --video PATH --scheduled-at ISO --keep-video --require-scheduled
--publish --confirm-publish AAMMDD` (ou `--only tiktok`),
usando o horário do plano original. Nesses dois destinos, `--publish` só
prepara o R2: o post depende do `create_post` externo. Não usar
`--replace-scheduled`. Conferir que não há novo post Buffer antes de executar
os passos 3 e `--mark`; obter `videoSha256` e `videoUrl` do novo preparo,
nunca inventá-los.

`--require-scheduled` é flag interna do filho e do comando exato de recuperação
impresso na falha. Preservar essa flag e `--scheduled-at` ao recuperar;
um `--publish` comum pode publicar imediatamente depois do tombstone.
