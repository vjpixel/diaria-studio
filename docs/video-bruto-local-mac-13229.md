# Bruto local no Mac antes do Premiere (#13229)

O XML normal da montagem aponta o bruto para `/Users/Shared/diaria-studio-video/{AAMMDD}/`
(`publishing.video.premiere_root`, #12707), que é o Drive do Mac em modo streaming. Na 261116
o Premiere travou em "Preparing audio" e trocou quadros por preto lendo os ~20 GB do bruto pelo
Drive. No mesmo dia, um XML com o bruto apontando para uma pasta local (copiada à mão por um script
de sessão) abriu rápido. Decisão do editor de 25/11/2026: **copiar o bruto para uma pasta local
fora do Drive e abrir um XML "local"**. Forçar o cache do Drive foi descartado (o macOS 14.4 tirou
o `fileproviderctl materialize`, e o cache pode descartar o bruto no meio da edição).

## Configuração (uma vez)

Em `platform.config.json`, `publishing.video.premiere_bruto_root`: a pasta local do Mac, absoluta,
fora do Drive (ex.: `/Users/{usuário}/diaria-video-local`). O build e o script usam o mesmo
validador (`scripts/lib/diaria/premiere-bruto-root.ts`). Sem a chave, nada muda: o build grava só o
XML de sempre.

## O que o build grava

Com a chave **e** o `premiere_root` (o XML local é só para o Premiere do Mac), o
`/diaria-video-montagem build` grava ao lado de cada XML um `{nome}-local.xml` (ex.:
`Diaria comentada_Vertical_V3-local.xml`). Nele **só os vídeos do bruto** (`file-1`, `file-2`…)
apontam para `{premiere_bruto_root}/{AAMMDD}/{nome}`; áudio tratado, PNGs, card e vinheta continuam em
`/Users/Shared/diaria-studio-video`. O caminho de cada XML local sai no stdout do build, depois dos
XMLs normais. O `srt` regrava o `-local.xml` depois de pôr a legenda no XML: **importar o
`-local.xml` regravado pelo `srt`**, não o do build.

Quando não grava (sem a chave, sem `premiere_root`, XML leve #13219, nome de bruto repetido, ou falha
de escrita), o build apaga o `-local.xml` de um build anterior com aviso, para nunca sobrar um XML
local de outro plano. No modo API (o 300, out dir no cache) o upload só sobe e nunca apaga: o nome
entra no `retire` do `drive-uploads.json`, e o upload do mesmo comando move a cópia da pasta da
edição no Drive para `arquivo/` (falha fica marcada para o próximo upload). Um build que volta a
gravar o `-local.xml` desmarca o nome.

No script do Mac, se o XML local e o XML normal ao lado forem de versões diferentes (outro nome no
mesmo `file id`), a origem é a da pasta da edição pelo nome do XML local, e a divergência é impressa.

## No Mac, antes de abrir o XML

O script lê o `platform.config.json` do checkout **do Mac**: rodar `git pull` antes, ou passar
`--local-root` (e `--drive-root`). Num terminal no Mac, no checkout do repo (só Node; nenhuma
dependência do `npm`):

```
node scripts/video/prepara-bruto-mac.ts AAMMDD
```

(Node 22.18+ roda `.ts` direto; em Node mais velho, `npx tsx scripts/video/prepara-bruto-mac.ts AAMMDD`.)

O script, nesta ordem:

1. **Limpa** as cópias de edições anteriores a hoje em `{premiere_bruto_root}/`, arquivo por arquivo.
   Vídeo só sai com o original no Drive de mesmo nome e mesmo tamanho (o caminho do original fica na
   `.origem.json` da pasta). `.part` de cópia interrompida sai sem conferir tamanho, desde que o
   original exista; `.DS_Store` sai sempre. Original ausente, de outro tamanho ou com erro de leitura:
   a cópia fica, com o motivo impresso. Pasta só é removida quando fica vazia. A edição passada na
   linha de comando nunca é limpa. Nunca toca no Drive. `--dry-run` só afeta a limpeza (lista em vez
   de apagar; a cópia segue normal); `--no-clean` pula; `--clean-only` só limpa e sai 0.
2. **Copia**: vigia `/Users/Shared/diaria-studio-video/{AAMMDD}/` (e, com XML local, a origem de cada
   vídeo dele, mesmo de outra pasta, como `261116-17/`) e copia cada vídeo quando o tamanho fica
   estável (upload terminado), com progresso (arquivo, tamanho, velocidade, quanto falta). Pode ser
   rodado antes de o bruto terminar de subir do celular.
3. **Confere** o tamanho de cada cópia contra a origem e termina quando todos os vídeos dos
   `*-local.xml` da edição estão locais e conferidos.

Saída:
- **0**: tudo local e conferido (ou `--clean-only`).
- **3**: parou (`--once`, ou `--idle-min` minutos sem arquivo novo, default 30) com vídeo faltando,
  com XML local ou ainda sem ele, ou com erro de leitura (XML ilegível, `stat` com EIO).
- **2**: uso ou config inválido, pasta local dentro do Drive (também por symlink), ou XML local sem
  nenhum vídeo sob a pasta local (gerado com outro `premiere_bruto_root`).
- **1**: exceção não tratada.

Depois, importar o `…-local.xml` no Premiere. Se o bruto local faltar, o XML normal continua valendo.

Opções: `--drive-root`, `--local-root` (sobrepõem o config), `--config`, `--interval S`,
`--stable-polls N`, `--stable-age S`, `--once`.
