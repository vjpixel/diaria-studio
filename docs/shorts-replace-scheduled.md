# Trocar o vídeo de um vertical já agendado (#12279)

Nenhuma plataforma troca a mídia de um post existente. Para pôr o V2 no lugar
do V1 já agendado, o post antigo sai e um novo sobe **no mesmo horário**. O
`--update-scheduled` continua sendo o caminho para trocar só texto e capa.

Desenho (decisão do editor de 15/11/2026, "exceção explícita no grant"): a
troca é a única exceção à recusa de nova autorização para destino já
registrado (`retryRefusal`, #12654). A operação de substituição fica DENTRO do
plano autorizado (por destino: ID do post antigo, hash dos bytes novos,
horário preservado) e a autorização é consumida antes da primeira exclusão.

## Passo a passo

1. **Plano** (só lê; grava o manifesto `_internal/video-publish-plan.vertical-replace.json`;
   manifesto não gravado = exit 1, o plano impresso não é aprovável):

   ```sh
   npx tsx scripts/publish-shorts.ts AAMMDD --replace-scheduled --video CAMINHO_PROPRIO_DO_V2
   ```

   O V2 vai num caminho próprio (`--video`). `--from-drive` é recusado com a
   troca: ele baixa para o arquivo canônico do vertical, que o Instagram, o
   Threads, o LinkedIn e os timers do 300 ainda usam. Alvos: post **agendado**
   no registro, com mais de 30 min até o horário, sem marca de envio aberta, em
   YouTube Shorts, Facebook, X ou TikTok, e com bytes diferentes do V2.
   Publicado, `send_unknown`, cancelado ou perto do horário fica fora (sai em
   `skipped`, com o motivo). `--only` restringe os destinos.

2. **Aprovação**: o plano (com `plan_sha256`) vai ao editor; com o "pode
   publicar" explícito dele sobre ESTA troca:

   ```sh
   npx tsx scripts/video-publish-registry-status.ts AAMMDD --since ISO --record   # se o grant pedir
   npx tsx scripts/video-publish-authorize.ts grant AAMMDD --part vertical --replace-scheduled \
       --plan-sha256 HASH --confirmation "resposta do editor"
   ```

   O grant confere cada post antigo contra o registro do vertical, lido sob o
   lock do registro de autorização (mesmo ID, agendado, mesmo horário, folga
   de 30 min, sem envio em aberto). As outras barreiras do #12654 seguem:
   releitura gravada cobrindo os eventos, processo que consumiu a última
   autorização morto, mesma máquina. Sem `--replace-scheduled`, a recusa de
   reautorização continua igual, e o grant normal recusa o manifesto de troca.

3. **Execução**: o mesmo comando do plano com `--publish --confirm-publish AAMMDD`.
   Sob o lock `_internal/shorts-replace.lock` (enquanto ele vive, nenhum
   `--publish` da rodada principal sai, inclusive o `--update-scheduled`; não há
   flag que o contorne; lock que não dá para ler conta como troca em curso; o
   de um processo morto vence por idade, 90 min, como o dos timers), a rodada:
   - consome a autorização de substituição de TODOS os alvos antes de qualquer
     exclusão (consumo recusado = nada apagado, exit 2; o V2 diferente do
     aprovado, outro post antigo ou outro horário recusam);
   - por destino de API: relê o registro, grava a marca "cancelando" (a marca
     de envio do destino: a releitura e o dry-run a acusam), relê a plataforma
     (o horário relido precisa ser o do plano) e cancela o antigo. YouTube volta
     a **private sem agendamento** (nada apagado: o editor apaga no Studio, se
     quiser); Facebook recebe o `DELETE` do agendado (a Graph não desagenda);
     sempre com 30 min de folga;
   - grava o histórico `_internal/06-shorts-replaced.json` (a entrada AGENDADA
     do par destino/ID antigo deixa de contar no registro, inclusive em cópia de
     conflito do Drive) e limpa as marcas;
   - sobe o V2 no horário preservado. Horário a 10 min ou menos recusa o envio,
     em qualquer destino (a troca nunca publica "na hora"). O vídeo vai a uma
     chave própria no R2 (`shorts/AAMMDD-replace-{12 primeiros caracteres do hash}.mp4`),
     sem trocar os bytes da chave do dia.

   Toda falha (cancelamento recusado, desfecho incerto, histórico não gravado,
   envio novo falho) entra em `results[]` com `ok: false` e a rodada sai com
   exit 1. Destino de API que ainda tem entrada no registro depois do
   cancelamento é falha explícita: o V2 não sobe e nada é relatado como "ok".

4. **X/TikTok (Buffer, pela skill)**: o publisher não apaga nada na Buffer. O
   `--publish` acima devolve, por destino, `pending_buffer_create: true`, o
   `buffer` do `create_post` (com `videoSha256`) e `replaces`. Só depois dele,
   nesta ordem:
   1. `get_post` do post antigo (na fila, não enviado, `dueAt` igual ao
      horário, mais de 30 min) e `delete_post`;
   2. logo em seguida, `npx tsx scripts/publish-shorts.ts AAMMDD --mark-replaced x=buffer:ANTIGO`
      (o registro deixa de apontar o post apagado; sem isso, um `create_post`
      que falhe deixaria o registro mentindo);
   3. `create_post` com `results[].buffer`;
   4. ```sh
      npx tsx scripts/publish-shorts.ts AAMMDD --mark x=buffer:NOVO --replaces buffer:ANTIGO \
          --scheduled-at HORARIO_DO_ANTIGO --video-sha256 HASH
      ```

   O `--mark-replaced` e o `--mark --replaces` recusam sem a rodada de troca que
   consumiu a autorização desse post. O `--mark --replaces` recusa também com
   outro horário, sem `--video-sha256` ou com hash diferente do V2 aprovado; ele
   grava o registro novo PRIMEIRO e o histórico depois. O preparo não é post
   criado: não relatar sucesso antes do `--mark`.

## Recuperação

- A troca não é atômica entre plataformas: a falha de um destino não desfaz os
  outros. Cada falha sai no JSON com a causa original.
- **Cancelamento recusado antes da escrita** (publicado, sem folga, outro
  horário, leitura falhou): o post antigo fica como estava, a marca sai, o
  destino não recebe envio novo. A autorização foi consumida: nova troca pede
  novo plano e novo grant.
- **Desfecho incerto** (o `videos.update`/`DELETE` saiu e a resposta não
  confirmou: timeout, 5xx): o post antigo PODE ter sido cancelado. A marca
  "cancelando" fica, nada é enviado. Conferir a conta: se o antigo segue
  agendado, apagar a marca à mão com o editor e refazer a troca; se saiu,
  registrar a troca à mão (histórico) antes de publicar.
- **Envio novo falhou depois do cancelamento**: o erro diz isso. Conferir a
  conta. Dois casos:
  - o destino ficou **sem registro**: publicar por um dry-run normal, plano ao
    editor, grant e `--publish`. O horário NÃO é o preservado: é o slot que o
    plano calcular (o editor confere no plano). No YouTube, a conferência do
    canal ignora o V1 trocado (IDs do histórico), então não precisa de
    `--force-youtube`; o V1 segue private e pode ser reagendado no Studio em
    vez de subir de novo;
  - o destino ficou **`send_unknown`** (o upload pode ter saído): ele conta
    como feito e não sai de novo. Conferir na conta; se não saiu, a releitura
    acusa estado incerto e o grant de retry aceita `--override-uncertain "{o que
    foi conferido}"` (#12654).
- **Buffer parcial**: `delete_post` ok e `create_post` falho: com o
  `--mark-replaced` do passo 2, o destino fica sem registro; recriar o post
  (`create_post` com o mesmo `buffer`) e rodar o `--mark --replaces` do passo 4.
  Sem o `--mark-replaced`, rodá-lo antes de qualquer outra coisa.
- Nunca apagar o histórico `06-shorts-replaced.json` nem zerar o registro à mão.

## Limites

- Registros anteriores ao #12279 não têm `video_sha256`. YouTube e Facebook
  passam a gravá-lo em todo envio; X e TikTok só quando o `--mark` recebe
  `--video-sha256` (o `videoSha256` do preparo, que a skill repassa). O aviso de
  vídeo diferente no dry-run normal e o pulo "mesmos bytes" valem só para essas
  entradas. O aviso compara bytes do arquivo local, não o nome `V{n}` no Drive.
- Instagram, Threads e LinkedIn não entram: não têm caminho de cancelar um
  post agendado por aqui.
