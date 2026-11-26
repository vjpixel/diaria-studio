# Bruto local no Mac antes do Premiere (#13229)

O XML normal da montagem aponta o bruto para `/Users/Shared/diaria-studio-video/{AAMMDD}/`
(`publishing.video.premiere_root`, #12707), que é o Drive do Mac em modo streaming. Na 261116
o Premiere travou em "Preparing audio" e trocou quadros por preto lendo os ~20 GB do bruto pelo
Drive. Decisão do editor de 25/11/2026: **copiar o bruto para uma pasta local fora do Drive e
abrir um XML "local"**. Forçar o cache do Drive foi descartado (o macOS 14.4 tirou o
`fileproviderctl materialize`, e o cache pode descartar o bruto no meio da edição).

## Configuração (uma vez)

Em `platform.config.json`, `publishing.video.premiere_bruto_root`: a pasta local do Mac, absoluta,
fora do Drive (ex.: `/Users/{usuário}/diaria-video-local`). Sem a chave, nada muda: o build grava
só o XML de sempre.

## O que o build grava

Com a chave, o `/diaria-video-montagem build` (e o `srt`, que põe a legenda no XML) grava ao lado
de cada XML um `{nome}-local.xml` (ex.: `Diaria comentada_Vertical_V3-local.xml`). Nele **só os
vídeos do bruto** (`file-1`, `file-2`…) apontam para `{premiere_bruto_root}/{AAMMDD}/{nome}`; áudio
tratado, PNGs, card e vinheta continuam em `/Users/Shared/diaria-studio-video`. O caminho de cada
XML local sai no stdout do build, depois dos XMLs normais. XML leve (#13219) não referencia o bruto e
não ganha XML local.

## No Mac, antes de abrir o XML

Num terminal no Mac, num checkout do repo (só Node; nenhuma dependência do `npm`):

```
node scripts/video/prepara-bruto-mac.ts AAMMDD
```

(Node 22.18+ roda `.ts` direto; em Node mais velho, `npx tsx scripts/video/prepara-bruto-mac.ts AAMMDD`.)

O script:

1. **Limpa** as cópias de edições anteriores a hoje em `{premiere_bruto_root}/`, arquivo por arquivo,
   só depois de conferir que o original continua no Drive com o mesmo nome e tamanho. Cópia sem
   original conferido fica, com o motivo impresso. Nunca toca no Drive. `--dry-run` só lista;
   `--no-clean` pula; `--clean-only` só limpa.
2. **Vigia** `/Users/Shared/diaria-studio-video/{AAMMDD}/` e copia cada vídeo do bruto quando o
   tamanho fica estável (upload terminado), com progresso (arquivo, tamanho, velocidade, quanto
   falta) e conferência do tamanho. Pode ser rodado antes de o bruto terminar de subir do celular.
3. **Termina** quando todos os vídeos referenciados pelos `*-local.xml` da edição estão locais e
   conferidos (saída 0). Sem XML local ainda, termina depois de `--idle-min` minutos sem arquivo
   novo (default 30), ou com Ctrl+C. Saída 3 = parou com vídeo faltando.

Depois, importar o `…-local.xml` no Premiere. Se o bruto local faltar, o XML normal continua valendo.

Opções: `--drive-root`, `--local-root` (sobrepõem o config), `--interval S`, `--stable-polls N`,
`--stable-age S`, `--once`.

**Pendência:** validação no Mac do editor (cópia, XML local no Premiere e limpeza) ainda não feita;
o código foi testado só com funções puras no Neo.
