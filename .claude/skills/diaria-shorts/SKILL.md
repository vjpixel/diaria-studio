---
name: diaria-shorts
description: Publica o vídeo CURTO (vertical) da edição — o recorte do "diar.ia.br comentada" — como YouTube Shorts e como Reels nas páginas do Facebook (diar.ia.br, VJ Pixel, MemeLab), no Instagram da diar.ia.br e no perfil pessoal do editor, para divulgar o canal @diariabr. Reels de página e Instagram saem pela Graph API (`scripts/publish-shorts.ts`); YouTube Shorts e perfil pessoal são passos guiados no Claude in Chrome, com o editor escolhendo o arquivo. Uso — `/diaria-shorts AAMMDD`.
---

# /diaria-shorts AAMMDD (#10769)

Vídeo curto de cada edição, decisão do editor de 21/10/2026: além do vídeo longo do YouTube (`/diaria-youtube`, #10659), o vertical sai **todo dia** como Shorts e como Reels. O objetivo é levar gente pro canal do YouTube. O 1º Short (edição 261021) foi publicado à mão e serviu de modelo: https://youtube.com/shorts/nhMUtgPPs4U.

Invocar a skill é o pedido de publicação: publicar nos destinos abaixo não precisa de confirmação extra.

**Data:** `AAMMDD` é obrigatório. Se não for passado, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`), nunca perguntar.

## Destinos (`platform.config.json` → `publishing.shorts`)

| Destino | Como | Observação |
|---|---|---|
| `youtube_shorts` | guiado (Chrome) | a API trava todo upload em `private` sem a auditoria do GCP (#10659) |
| `facebook:diaria`, `facebook:vjpixel`, `facebook:memelab` | API (`video_reels`) | agenda pras 06:00 BRT se ainda não passou; senão, na hora |
| `instagram` | API (Reels resumable) | o Instagram não agenda Reels por API: com horário futuro fica pendente até rodar de novo depois das 06:00 (ou `--now`) |
| `facebook_profile` | guiado (Chrome) | a Graph API não publica em perfil pessoal |

Jandig, Teatro vs Game e Criaturas Afetivas ficam **fora** da rotina — só quando o editor pedir para um tema específico.

Página sem token (`[aviso] facebook:{slug}: sem credencial`) não bloqueia as outras. Para gerar o token, o **editor** roda no terminal dele (o token nunca passa pelo chat):

```bash
npx tsx scripts/facebook-page-token-setup.ts --pages vjpixel,memelab
```

O script pede o User Access Token do Graph API Explorer (permissões `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`) e grava id + token de página no Doppler e no `.env`. Nunca pedir nem colar o token aqui.

## Passo 1 — O vídeo

Convenção: `data/editions/{AAMM}/{AAMMDD}/diaria-comentada-{AAMMDD}-short.mp4`.

Se não estiver lá, procurar no Drive pelo conector do Google Drive (`search_files`, `mimeType contains 'video/'`, `modifiedTime` recente, título com `Vertical`) e baixar pelo id:

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD} --from-drive {FILE_ID}
```

Mais de um candidato (V1, V2, V3…): usar a versão mais alta. Se a escolha não for óbvia, mostrar os nomes ao editor.

## Passo 2 — Plano

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD}
```

Dry-run: imprime título/descrição/comentário do Shorts, a legenda de cada Reels, o horário e o que será pulado (já publicado, sem credencial, pendente).

## Passo 3 — Reels por API

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD} --publish
```

Cada destino é gravado em `_internal/06-shorts-published.json` assim que sai. Re-rodar pula o que já foi feito, então pode rodar de novo depois das 06:00 só para o Instagram.

## Passo 4 — YouTube Shorts (Chrome)

Carregar as ferramentas do Claude in Chrome. Abrir `https://studio.youtube.com/channel/UCSsppeUnBy6q-4a5hsl5u0w/videos/upload?d=ud`.

1. **Chamar o editor** para clicar em "Selecionar arquivos" e escolher o vertical: o upload de arquivo é bloqueado no Chrome (e o `file_upload` tem limite de 10 MB).
2. Título e descrição do plano (`youtube.title`, `youtube.description`). Em "Mostrar mais": tags do vídeo longo, idioma Português (Brasil), categoria Ciência e tecnologia. Público: "Não é conteúdo para crianças".
3. Elementos do vídeo → **Vídeo relacionado**: o vídeo longo da mesma edição.
4. Visibilidade **Público**. **Esperar "Verificações concluídas"** antes de clicar em Publicar: publicar durante a verificação mostra o aviso "Ainda estamos verificando seu conteúdo" (risco de advertência ou visibilidade restrita).
5. Na página do vídeo, comentar `youtube.pinnedComment` e **fixar** (menu ⋮ → Fixar no topo).
6. Registrar: `npx tsx scripts/publish-shorts.ts {AAMMDD} --mark youtube_shorts={URL do Short}`.

## Passo 5 — Perfil pessoal (Chrome)

O Facebook do Chrome costuma estar na identidade da página diar.ia.br. Trocar para o perfil pessoal (menu do avatar → perfil do editor), criar Reel e **chamar o editor** para escolher o arquivo. Legenda: `caption` do item `facebook_profile`. Publicar e registrar com `--mark facebook_profile={URL}`. **Voltar o Chrome para a identidade da página diar.ia.br no fim.**

Atalho aceitável: compartilhar no perfil o Reels já publicado na página diar.ia.br, com a mesma legenda.

## Passo 6 — Relatar

Uma linha por destino: publicado/agendado (com URL), pendente (Instagram antes das 06:00), pulado (sem credencial, com o comando de setup). Normalizar o estado como manda o #573: "agendado" não é "publicado".

Teste de 2 semanas a partir de 261022 (#10769): no fim, comparar os visualizadores e as visitas ao canal por destino, e manter só os destinos que trouxerem gente.
