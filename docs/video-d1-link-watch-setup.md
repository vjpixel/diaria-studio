# Link do vídeo no D1 sem o editor — `Diaria-Video-D1-Link-Watch`

Issue: [#10941](https://github.com/vjpixel/diaria-studio/issues/10941) (item 1).

Até aqui, depois das 06:00 o editor conferia no YouTube Studio se o vídeo horizontal do dia tinha ficado público e rodava `link-video-d1.ts {AAMMDD} --save --assume-public`. A task faz essa conferência pela API e aplica o link sozinha.

## O que ela faz

Disparo único às 06:05 BRT; o script relê o estado a cada 5 min até 10:00 BRT e para no primeiro `published`.

1. Lê `_internal/05-youtube-published.json` da edição de hoje (gravado por `publish-youtube.ts --upload`). Sem registro com `videoId`, ou com o upload em estado incerto, não há o que vigiar: sai `sem-video`, exit 0. Vídeo subido à mão no Studio continua no caminho manual (`link-video-d1.ts`).
2. Relê `videos.list?part=status` e normaliza com `resolveYouTubeState` (#573). **Só leitura**: não muda o escopo do token e não chama `videos.update`, que dá 403 com o token de upload (decisão do editor no briefing 261023).
3. Com o vídeo `published`, grava `_internal/05-video-url.txt` **sem `--assume-public`**. A releitura é a prova de que o leitor abre o link.
4. Monta o plano de `planD1VideoLink` (o mesmo de `link-video-d1.ts`) e aplica:
   - **Facebook diar.ia.br**, pela Graph API com o token da página: post do D1 ainda agendado com folga → edita a mensagem (lê a atual, insere a linha do vídeo antes do 1º link, relê para confirmar); post já publicado → comenta a linha do vídeo.
   - **LinkedIn, X e Threads**: sem executor por script (o 1º comentário como organização no LinkedIn, a Buffer do X e a fila do Worker do Threads não têm caminho de script hoje). Ficam `manual`, com o texto pronto no log da task e no arquivo de estado.
5. Grava o resultado por destino em `_internal/05-video-link-apply.json`. Rodar de novo não repete destino já `applied`, então não comenta duas vezes.

Vídeo que não ficou público até 10:00 → aviso ao editor por `notifyEditor` (`acao`, uma issue por dia) e exit 0. Credenciais do YouTube ausentes, ou `05-video-url.txt` / estado de outro vídeo → exit 1, a unit sai `failed` e nada é alterado.

## Pré-requisitos no `300`

- `.env` com `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN` e `YOUTUBE_CHANNEL_ID` — os mesmos do `publish-youtube.ts --upload`. O token atual (escopo de upload) basta para ler o status.
- `FACEBOOK_PAGE_ID` e `FACEBOOK_PAGE_ACCESS_TOKEN` (ou `data/.fb-credentials.json`). Sem eles o Facebook fica `manual`. Comentar exige a permissão `pages_manage_engagement` no token da página; se faltar, o destino sai `failed` com o erro da Graph API e o editor comenta à mão.
- Junction `data/` montada (o `guard` da task aborta sem `data/editions`).

## Conferir antes de armar

```bash
npx tsx scripts/video-d1-link-watch.ts --edition AAMMDD --dry-run
```

Uma leitura só, sem gravar arquivo e sem chamar a Graph API. Mostra o estado relido e o plano por destino.

## Armar (ação do editor, não feita no PR da #10941)

A task entrou com `enabled: false`, o que também impede o `Diaria-Remediate-Never-Armed-Tasks` (#8153) de armá-la sozinho. Para armar, só no `300` (a junction `data/` é compartilhada; duas máquinas armadas gravariam o mesmo arquivo e comentariam duas vezes):

1. Tirar o `enabled: false` da entrada `Diaria-Video-D1-Link-Watch` em `scripts/lib/scheduled-tasks.ts` (PR normal).
2. Depois do merge, na checkout compartilhada do `300`:

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Video-D1-Link-Watch
systemctl --user daemon-reload
systemctl --user enable --now diaria-video-d1-link-watch.timer
systemctl --user list-timers diaria-video-d1-link-watch.timer
```

Log: `data/video-d1-link-watch/.watch.log`. Eventos também vão para `data/run-log.jsonl` (`agent: video-d1-link-watch`).

## Fora do escopo

Itens 2 a 8 da #10941 (Instagram Reels, vertical como primeiro post, vídeo relacionado do Short, Short no YouTube, perfil pessoal, entrada do vídeo, capa) e a parte que exige o escopo `youtube` no token (publicar ou trocar o título pela API).
