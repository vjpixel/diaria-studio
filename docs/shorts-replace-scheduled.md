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

1. **Plano** (só lê; grava o manifesto `_internal/video-publish-plan.vertical-replace.json`):

   ```sh
   npx tsx scripts/publish-shorts.ts AAMMDD --replace-scheduled --video PATH_DO_V2
   ```

   Alvos: post **agendado** no registro, com mais de 30 min até o horário, sem
   marca de envio aberta, em YouTube Shorts, Facebook, X ou TikTok, e com bytes
   diferentes do V2. Publicado, `send_unknown`, cancelado ou perto do horário
   fica fora (sai em `skipped`, com o motivo). `--only` restringe os destinos.
   `--from-drive ID` baixa o V2 em vez de `--video`.

2. **Aprovação**: o plano (com `plan_sha256`) vai ao editor; com o "pode
   publicar" explícito dele sobre ESTA troca:

   ```sh
   npx tsx scripts/video-publish-registry-status.ts AAMMDD --since ISO --record   # se o grant pedir
   npx tsx scripts/video-publish-authorize.ts grant AAMMDD --part vertical --replace-scheduled \
       --plan-sha256 HASH --confirmation "resposta do editor"
   ```

   O grant confere cada post antigo contra o registro local (mesmo ID,
   agendado, mesmo horário, folga de 30 min, sem envio em aberto). As outras
   barreiras do #12654 seguem: releitura gravada cobrindo os eventos, processo
   que consumiu a última autorização morto, mesma máquina. Sem
   `--replace-scheduled`, a recusa de reautorização continua igual, e o grant
   normal recusa o manifesto de troca.

3. **Execução**: o mesmo comando do plano com `--publish --confirm-publish AAMMDD`.
   Sob o lock `_internal/shorts-replace.lock` (enquanto ele vive, nenhum
   `--publish` da rodada principal sai, inclusive o `--update-scheduled`; não há
   flag que o contorne), a rodada:
   - consome a autorização de substituição de TODOS os alvos antes de qualquer
     exclusão (consumo recusado = nada apagado, exit 2; o V2 diferente do
     aprovado, outro post antigo ou outro horário recusam);
   - por destino de API, relê o registro e a plataforma e cancela o antigo:
     YouTube volta a **private sem agendamento** (nada apagado: o editor apaga
     no Studio, se quiser), Facebook recebe o `DELETE` do agendado (a Graph não
     desagenda), sempre com 30 min de folga;
   - grava o histórico `_internal/06-shorts-replaced.json` (o par destino/ID
     antigo deixa de contar no registro, inclusive em cópia de conflito do
     OneDrive) e limpa as marcas de envio;
   - sobe o V2 no horário preservado. Horário a 10 min ou menos recusa o envio
     (a troca nunca publica "na hora"). O vídeo vai a uma chave própria no R2
     (`shorts/AAMMDD-replace-{hash}.mp4`), sem trocar os bytes da chave do dia.

4. **X/TikTok (Buffer, pela skill)**: o publisher não apaga nada na Buffer. O
   `--publish` acima devolve, por destino, `pending_buffer_create: true`, o
   `buffer` do `create_post` (com `videoSha256`) e `replaces`. Só depois dele:
   `get_post` do post antigo (na fila, não enviado, `dueAt` igual ao horário,
   mais de 30 min), `delete_post`, `create_post` com `results[].buffer`, e

   ```sh
   npx tsx scripts/publish-shorts.ts AAMMDD --mark x=buffer:NOVO --replaces buffer:ANTIGO \
       --scheduled-at HORARIO_DO_ANTIGO --video-sha256 HASH
   ```

   O `--mark --replaces` recusa sem a rodada de troca que consumiu a
   autorização desse post, com outro ID antigo ou com outro horário. O preparo
   não é post criado: não relatar sucesso antes do `--mark`.

## Recuperação

- A troca não é atômica entre plataformas: a falha de um destino não desfaz os
  outros. Cada falha sai no JSON com a causa original.
- Cancelamento recusado (publicado, sem folga, leitura falhou): o post antigo
  fica como estava e o destino não recebe envio novo. A autorização foi
  consumida: nova troca pede novo plano e novo grant.
- Envio novo falhou depois do cancelamento: o erro diz isso. Conferir a conta
  (envio ambíguo fica `send_unknown` no registro). O destino fica sem registro;
  para publicar: dry-run normal, plano ao editor, grant e `--publish`. No
  YouTube, o V1 segue private no canal e pode ser reagendado no Studio.
- Nunca apagar o histórico `06-shorts-replaced.json` nem zerar o registro à mão.

## Limites

- Registros anteriores ao #12279 não têm `video_sha256`: o aviso de vídeo
  diferente no dry-run normal e o pulo "mesmos bytes" só valem para envios
  novos. O aviso compara bytes do arquivo local, não o nome `V{n}` no Drive.
- Instagram, Threads e LinkedIn não entram: não têm caminho de cancelar um
  post agendado por aqui.
