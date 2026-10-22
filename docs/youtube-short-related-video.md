# Vídeo relacionado do Short: o que a YouTube Data API expõe (#10811)

Investigação de 22/10/2026, pedida pelo editor antes de decidir o caminho da tarefa das 06:30 que vincularia o vídeo horizontal da edição como "vídeo relacionado" do Short. Só fontes oficiais (developers.google.com, support.google.com).

## O que a API expõe

**Nada para o vídeo relacionado.** O resource `videos` da YouTube Data API v3 tem `snippet`, `status`, `contentDetails`, `statistics`, `paidProductPlacementDetails`, `player`, `topicDetails`, `recordingDetails`, `fileDetails`, `processingDetails`, `suggestions`, `liveStreamingDetails`, `brandPartner` e `localizations`. Nenhum deles tem um campo que aponte de um Short para outro vídeo. Também não há campo que marque um vídeo como Short.

- O que mais se aproxima é `brandPartner` (`channelId`/`channelHandle`), adicionado em 07/07/2026. Ele liga o vídeo a uma marca parceira, não a outro vídeo.
- O histórico de revisões da API não tem entrada sobre vídeo relacionado de Shorts nem sobre telas finais. A entrada mais recente lida é de 15/10/2026. O único item de "related videos" é a remoção do parâmetro `search.list relatedToVideoId`, descontinuado em 12/06/2023 e removido em 07/08/2023, que servia para buscar vídeos relacionados e não para vincular um.
- A Central de Ajuda descreve o recurso só no YouTube Studio: Conteúdo → o Short → "Vídeo relacionado" → Salvar. O recurso exige acesso a recursos avançados, o vídeo escolhido precisa ser **público ou não listado**, e o vínculo é feito depois do upload. A página não cita API.
- A API só **mede** o recurso. Nos relatórios do YouTube Analytics/Reporting, `insightTrafficSourceType = 32` ("Related video") conta as visualizações vindas do link de vídeo relacionado no player do Short.

## Conclusão

**Não dá por API oficial.** Não existe campo nem endpoint de escrita para o vídeo relacionado de um Short. Por isso esta PR não traz helper nem task agendada.

Achado lateral útil para a decisão: o seletor aceita vídeo **não listado**, não só público (o comportamento observado no Studio em 261022, que listou só públicos, pode ser restrição da UI do upload e não do recurso). Se isso valer também no seletor pós-upload, o vínculo poderia ser feito antes das 06:00, com o horizontal ainda agendado. Agendado é `private` e o Studio não o lista, então valeria testar à mão se publicar o horizontal como não listado e só depois torná-lo público atende à cadência.

## Opções que restam

1. **Claude in Chrome no YouTube Studio logado** (o caminho já previsto na issue, label `windows`): 1 ação editorial por dia na conta do editor, aceitável pela regra de ToS do `CLAUDE.md`. A API ajuda nas pontas: confirmar por `videos.list?part=status` (determinístico, #573, `resolveYouTubeState`) que o horizontal está `public` antes de abrir o Studio. Não há como reler o vínculo pela API, então a confirmação também precisa ser pela página do Studio.
2. **Manual, com lembrete:** manter o passo de 1 minuto no Studio e só automatizar o alerta (a API confirma que o horizontal ficou público; o lembrete sai antes do horário do Short).
3. **Medir antes de automatizar:** o tráfego `insightTrafficSourceType = 32` mostra quantas visualizações o link de fato gera. Se for pouco, a automação via Chrome pode não compensar.

A escolha entre 1, 2 e 3 é do editor (#10811).

## Fontes

- Resource `videos` (YouTube Data API v3): https://developers.google.com/youtube/v3/docs/videos
- Histórico de revisões da YouTube Data API: https://developers.google.com/youtube/v3/revision_history
- "Adicionar um vídeo relacionado aos seus Shorts" (Central de Ajuda do YouTube): https://support.google.com/youtube/answer/14075157
- Dimensões dos relatórios (traffic source `32`): https://developers.google.com/youtube/reporting/v1/reports/dimensions
