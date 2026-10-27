# Vertical do Shorts por Cloudflare Tunnel (`media.diar.ia.br`)

Issue #11265. Decisão do editor no briefing overnight 261027d: a URL pública do
vertical do dia sai pelo Cloudflare Tunnel do servidor `300`, não pelo R2.

## Por que existe uma URL pública

O Reel do Instagram com horário futuro vai para a fila do Worker
`diaria-linkedin-cron` (#10823), e no horário a Graph API baixa o vídeo de um
`video_url`. O X (Buffer) e o Threads pessoal também só aceitam vídeo por URL. O
vertical (~116 MB) não cabe no KV do Worker (limite de 25 MB por valor), então
precisa de um endereço público.

## Como funciona

1. `scripts/publish-shorts.ts --publish` (backend `tunnel` em
   `publishing.shorts.public_video`) copia o vertical para a pasta servida
   (`tunnel_dir`, padrão `~/diaria-media/shorts`; a env `SHORTS_MEDIA_DIR`
   sobrepõe). A cópia é atômica (temporário oculto + rename).
2. Na mesma cópia, apaga da pasta os verticais de edição já passada
   (AAMMDD menor que hoje em BRT). O de hoje e os futuros ficam, porque podem
   estar na fila esperando o horário.
3. Confere a URL pública com HEAD e compara o tamanho. Se falhar, o Reel não
   entra na fila (nunca enfileira URL que a Graph não vai baixar).
4. `scripts/shorts-media-server.ts` (unit `diaria-shorts-media.service`,
   `127.0.0.1:4175`) serve a pasta, atrás do 2º hostname do túnel
   `diaria-studio`.

No planejamento (dry-run e início do `--publish`), o script pede
`https://media.diar.ia.br/healthz`. Se não responder, ou se a pasta não existir
nesta máquina (qualquer máquina que não seja o `300`), Instagram agendado, X e
Threads caem no comportamento de sem URL pública: pendente até o horário ou
passo guiado, com aviso. Nada é enviado com uma URL que não existe.

Lógica: `scripts/lib/diaria/shorts-public-video.ts`. Testes:
`test/shorts-public-video-11265.test.ts`, `test/shorts-media-server-11265.test.ts`.

## Superfície exposta

| Regra | Como |
|---|---|
| Só leitura | GET e HEAD; qualquer outro método responde 405 |
| Só o vertical | só o caminho `/diaria-comentada-{AAMMDD}-short.mp4` (regex exata); o resto responde 404 |
| Sem listagem nem path traversal | não há rota de diretório; nome fora do padrão nem chega ao disco |
| Sem symlink | `lstat`: só arquivo regular |
| Só o túnel alcança | bind em `127.0.0.1` |
| Sem cache velho na borda | `Cache-Control: no-store`. Custo: cada download sai do `300` (Graph, Buffer e Threads baixam uma vez cada, cerca de 350 MB por dia) |
| Download em partes | `Range: bytes=` de intervalo único (206) |

O hostname de mídia **não** fica atrás do Cloudflare Access: quem baixa é a
Graph API, a Buffer e a Threads API, sem login. Se a Access Application do
Studio cobrir `*.diar.ia.br` (curinga), crie uma política Bypass para
`media.diar.ia.br`.

## Risco registrado

O `300`, o `diaria-shorts-media.service` e o `diaria-studio-tunnel.service`
precisam estar de pé **na hora do disparo** (06:30, 08:00 ou 12:00 BRT na
rotação do #10831), não só na hora do `--publish`. A conferência do script só
prova que estavam de pé quando ele rodou. O R2 não dependia de máquina nenhuma.
Se o túnel cair entre o `--publish` e o horário, o Reel agendado falha no
Worker. Hoje o alarme do túnel cobre só o Studio; não há alarme específico para
`media.diar.ia.br`.

Saída se o túnel estiver fora do ar no horário: `publish-shorts.ts --only
instagram --publish` depois do horário publica direto pelo upload resumível
da API, sem URL pública.

Para voltar ao R2: `publishing.shorts.public_video.backend = "r2"` e as 5
variáveis `R2_*`/`SHORTS_R2_*` (`scripts/lib/r2-object-upload.ts`).

## Passos manuais do editor (no `300` e na Cloudflare)

Nada disso roda sozinho: o PR só traz o código, a config e os scripts.

1. Servidor de mídia (no `300`, no checkout do projeto):

   ```
   ./scripts/studio/setup-shorts-media-service-linux.sh --dry-run
   ./scripts/studio/setup-shorts-media-service-linux.sh
   systemctl --user start diaria-shorts-media.service
   curl -s http://127.0.0.1:4175/healthz        # deve responder "ok"
   ```

2. 2º hostname do túnel (ingress + DNS), no mesmo túnel `diaria-studio`:

   ```
   ./scripts/studio/setup-remote-tunnel-linux.sh --hostname studio.diar.ia.br --media-hostname media.diar.ia.br --dry-run
   ./scripts/studio/setup-remote-tunnel-linux.sh --hostname studio.diar.ia.br --media-hostname media.diar.ia.br
   systemctl --user restart diaria-studio-tunnel.service
   ```

   Daqui em diante, **re-rodar esse script sempre com `--media-hostname`**:
   sem ele o `config.yml` é regravado sem a linha da mídia (o script avisa).

3. Cloudflare Access: confirmar que `media.diar.ia.br` não está coberto pela
   Access Application do Studio (ou criar Bypass, ver acima).

4. Conferir de fora:

   ```
   curl -sI https://media.diar.ia.br/healthz              # 200
   curl -sI https://media.diar.ia.br/qualquer-coisa       # 404
   ```

5. Primeiro Reel real: rodar `/diaria-publica-video AAMMDD --so vertical` e
   conferir no dia seguinte, depois do horário, que o Reel saiu pela fila do
   Worker. A Graph API pode exigir algo da resposta (content-type, range) que
   só um Reel real mostra.
