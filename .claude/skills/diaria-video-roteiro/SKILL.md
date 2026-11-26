---
name: diaria-video-roteiro
description: Escreve o roteiro de fala do vídeo diário da diar.ia.br (série "notícias de IA") do dia, antes da gravação — um vídeo horizontal e dois verticais que saem da mesma gravação, a partir do D1 da edição. Entrega um artefato (página) com título, texto da capa e falas numeradas por vídeo, e itera com o editor até ele gravar; depois da gravação, confere a transcrição ditada contra o roteiro e diz o que regravar. Roda depois do gate da Etapa 4 e antes da gravação; standalone, sem encadear. Uso — `/diaria-video-roteiro [AAMMDD]`.
model: claude-opus-5-5
effort: medium
---

# /diaria-video-roteiro AAMMDD

Escreve o roteiro que o editor lê para gravar o vídeo do dia. Nasceu do processo da edição 261112 (10/11/2026), feito à mão numa sessão: o roteiro saiu de uma primeira versão até a 22ª em conversa com o editor. Desde o #13120 a página sai do `roteiro-falas.json` pelo `scripts/render-roteiro-video.ts`, no layout da 261116 (`data/editions/2611/261116/_internal/roteiro-d1.html`, em `data/`, fora do git; o JSON daquela edição é a fixture `test/fixtures/roteiro-video/roteiro-falas-261116.json`).

**Fora de escopo:** gravar, decupar, checar os fatos da fala gravada no bruto e montar (tudo do `/diaria-video-montagem`), publicar (`/diaria-publica`). Esta skill não altera `02-reviewed.md` nem `03-social.md`.

## Argumentos

- `AAMMDD` — opcional. Sem ele, assumir D+1, imprimir o banner `Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.` e seguir.

## Fluxo do dia

`/diaria-edicao` → `/diaria-video-roteiro` → (o editor grava) → `/diaria-video-montagem` → `/diaria-publica`. Sessão própria, sem encadear (#5578): ao terminar, sugerir o próximo passo sem rodá-lo.

## Passo 1 — Ler antes de escrever

1. O D1 em `data/editions/{AAMM}/{AAMMDD}/02-reviewed.md` (título, texto, "Por que isso importa", link da fonte) e a fonte do D1, que o fact-check já baixou em `_internal/fact-check-sources/d1.txt` (sem esse arquivo, abrir o link).
2. O resultado do fact-check da edição (`_internal/fact-check.json` e `_internal/fact-check-autofix.json`), se houver: as ressalvas de fidelidade valem para a fala.
3. O roteiro anterior mais recente no formato desta skill (`_internal/roteiro-d1.html` de uma edição anterior), para o formato. Para o tom e a abertura, o que foi de fato gravado nas duas últimas edições com vídeo: `_internal/video-montagem/roteiro.md` (em algumas edições, `roteiro-doc.md`). Se nenhum existir, seguir só este arquivo.
4. `context/audience-profile.md`, para os setores e áreas de trabalho de quem lê. O vídeo fala com quem usa IA no trabalho e não necessariamente programa, salvo pedido do editor.
5. **Referência sem contexto (#13435).** Todo nome próprio, lugar ou projeto que a fala cita diz de quem ou do que é ("quem é", "de quem é"). Se a fonte do D1 cita sem explicar, seguir o link da própria fonte antes de escrever. Na 261118, "E lá no Pecém, no Ceará, já tem obra andando" não dizia de quem era a obra (o data center da ByteDance): o `d1.txt` citava o Pecém sem contexto, e foi preciso abrir a matéria linkada. A mesma checagem vale no fact-check do roteiro (Passo 5b) e na revisão (Passo 5a).

Se o editor já contou um caso pessoal ou uma opinião sobre o tema nesta conversa, usar. Se não, escrever o comentário como sugestão marcada e perguntar, na entrega da primeira versão, se ele tem um caso próprio. O relato dele é o que mais melhora o vídeo.

**Rascunho do editor como entrada (#13132).** Quando o editor trouxer um rascunho próprio do roteiro (notícia e comentários, em texto ou imagem), ler `.claude/skills/diaria-video-roteiro/reference/rascunho-do-editor.md` antes de escrever: separar fato de opinião, classificar cada fato (confirmado, só em fonte terceira, contraditório, sem fonte), pôr `fontes` na fala que usa fato de fora do D1 e listar na entrega, e nas `notas`, o que ficou de fora do rascunho e o motivo.

## Passo 2 — Formato: uma gravação, três vídeos

O editor grava uma vez, na ordem do horizontal. Os verticais são cortes dessa gravação.

- **Horizontal (1920x1080, cerca de 3 min):** a notícia inteira. Blocos: Gancho, Abertura, Resumo, Comentário, card de CTA.
- **Vertical 1, a notícia (cerca de 60 s):** gancho, resumo curto com o número mais forte, o comentário pessoal e uma chamada falada para o vídeo completo. Sai primeiro.
- **Vertical 2, o guia (cerca de 60 s):** o que fazer, em passos. Tem que se sustentar sozinho. Sai uma semana depois do vertical 1. A prévia da montagem aceita até 75 s, mas o alvo do roteiro é 60 (#13130).

A duração de cada vídeo sai do `video-roteiro-blocos.ts` (Passo 5), estimada a 150 palavras por minuto mais 1,7 s da pausa da vinheta depois do título (a montagem a põe em todo vídeo, #13239), com o card de CTA à parte: nunca contar à mão. Vertical acima de 60 s ou horizontal longe de 3 min dão `[aviso]` com a sugestão de corte. Os alvos ficam em `publishing.video.roteiro` do `platform.config.json` (`alvo_s`, `palavras_por_minuto`, `horizontal_folga_s`, `cta_card_s`, `pausa_vinheta_s`).

Regras de estrutura:

- Cada fala do horizontal tem um número (`H1`, `H2`…). Os verticais listam as falas que reaproveitam, pelo número. Ao reordenar ou cortar falas, manter os números já dados e dizer isso nas notas.
- No máximo duas falas gravadas à parte: o gancho do vertical 2 e a chamada final do vertical 1.
- Toda fala usada num vertical precisa funcionar sem a anterior: repetir o sujeito ("o Claude Code", não "ele") e não depender de uma fala que ficou só no horizontal.
- Quando o vídeo entrega dicas, o gancho promete: "Fica até o final, que eu vou te dar três dicas pra…". No vertical 1 a promessa vira a chamada final para o vídeo completo no YouTube. É falada porque fora do YouTube Shorts o post não leva link para o horizontal (#12735).
- Abertura fixa, sempre a mesma: "Oi! Eu sou o Pixel, editor da diar.ia.br, e neste canal comento as principais notícias de IA com foco no que pode impactar sua vida."
- Cada vídeo tem título e texto da capa. O título é pensado para a busca e o clique no YouTube e pode ser diferente do título do D1 na newsletter; avisar quando for. **O título do vertical 1 é sempre o do horizontal** (#13116, decisão do editor de 15/11/2026): o vertical 1 chama para o "vídeo completo no YouTube", e com o mesmo título a pessoa reconhece o vídeo. Por isso o título do horizontal cabe em cerca de 40 caracteres (o corte do feed de Shorts), com o nome do produto no começo. As capas dos dois continuam diferentes; o vertical 2 tem título próprio. No JSON, `porVideo.vertical1.titulo` pode ficar ausente: herda o do horizontal. O texto da capa segue a diretriz de `docs/youtube-capa-texto.md` (#12737): complementa o título, 2 a 6 palavras (até 7 no vertical), pergunta ou afirmação; ordenar os candidatos com `npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --candidates-file {arquivo}` e trazer os primeiros como opções. O script compara a capa com o título do D1 e com os títulos do vídeo (`--title`, ou os do `roteiro-falas.json` quando ele já existe): passar `--title` quando o vídeo trata de outro assunto que o D1 do `02-reviewed.md`.

Critérios de título, capa e gancho (#13116, decididos com o editor em 15/11/2026; detalhe em `docs/youtube-capa-texto.md`):

1. Título e gancho fazem a mesma promessa com palavras diferentes, nunca iguais. No horizontal a pessoa já leu o título antes do clique: o título traz o assunto e o nome, para a busca; o gancho traz a consequência para quem assiste. Nos verticais o título aparece escrito na tela e a fala sai como legenda queimada, então título igual ao gancho mostra a mesma frase duas vezes: o título diz o assunto, o gancho traz a tensão. No Instagram, a primeira linha da legenda do post (corte em cerca de 125 caracteres) também não copia o título.
2. A capa do horizontal aparece sempre com o título: traz a consequência e não repete o assunto.
3. A capa do vertical aparece sozinha na grade do perfil: precisa de sujeito reconhecível ("Sua Busca", "Google"), nunca uma pergunta sem sujeito ("Inventa cinco vezes menos?").
4. O gancho chega ao ponto em cerca de 3 s no vertical e em até 5 a 10 s no horizontal: o que importa para quem assiste vem na primeira frase. Estimar a duração a cerca de 150 palavras por minuto (3 s são umas 8 palavras).

Pergunta ou afirmação na capa: escolher pela clareza, não pelo formato (a diretriz não tem evidência para preferir uma ou outra). Título do horizontal: com o nome do produto no começo, em cerca de 40 caracteres, porque é também o do vertical 1 (esse limite refina os cerca de 60 caracteres anotados antes). Os `[aviso]` do `video-roteiro-blocos.ts` apontam gancho longo no vertical, título igual ao gancho e capa de vertical sem sujeito.

**Pesquisa no YouTube antes de fechar os títulos (#13156), sempre, sem o editor pedir.** Os critérios acima não dizem o que o YouTube mostra para o assunto. Na 261117 o roteiro saiu com "Deepfake de médico vende cura falsa", que passava em todos eles; a pesquisa à mão mostrou que os vídeos com mais views tinham "Drauzio" no título, e o título virou "Drauzio falso: o golpe do remédio com IA". Antes de entregar a primeira versão (e de novo quando um título mudar de assunto):

```bash
npx tsx scripts/youtube-title-research.ts --edition-dir data/editions/{AAMM}/{AAMMDD}/ --title "{título candidato do horizontal}" --queries "{q1}|{q2}|{q3}"
```

- As até 3 queries saem do assunto do vídeo e do nome de quem aparece nele (a pessoa, a empresa, o produto), não só do título do D1. Sem `--queries`, o script as deriva do `--title`. Para o vertical 2, cujo título é próprio, uma query do guia (o "como" do assunto) cabe entre as 3.
- Janela padrão de 30 dias (`--days` muda). Grava em `_internal/youtube-title-research-roteiro.json`, sem tocar na pesquisa do D1 do Stage 2 nem exigir o `01-approved.json` (a edição pode ainda não existir). A saída traz `top_terms` e `top_videos`.
- Fail-soft: sem credencial, sem cota ou sem rede o arquivo sai com `status` `skipped`/`error` e o script sai 0. Dizer na entrega que a pesquisa não rodou, e o motivo, e seguir com os critérios acima.
- Na entrega, mostrar o topo da pesquisa (título, views, canal) e dizer quais termos entraram nos títulos dos três vídeos e por quê. A justificativa vai também em `notas` no JSON.
- A pesquisa mostra as palavras e a audiência de títulos parecidos; não prevê o clique no nosso. Ela informa os critérios acima, não os substitui: termo de topo que a fonte não sustenta fica fora do título (#4000, #9383), e o título continua diferente do gancho.

### Formato react (#13433)

Quando o editor pede para reagir a trechos de um vídeo anterior do canal, ou o `roteiro-falas.json` já tem `trechoInserido`, ler `.claude/skills/diaria-video-roteiro/reference/formato-react.md` antes de escrever ou revisar o roteiro: as 7 regras do formato (um item por vez, o trecho tirado do SRT do vídeo publicado, a reação sem repetir a previsão em pergunta, o "eu disse" só depois do trecho, o foco no D1, o placar na tela, os verticais sem os trechos), os `[aviso]` que as conferem e o campo `trechoInserido` em detalhe.

## Passo 3 — Regras da fala

Vêm de decisões do editor. Não reabrir.

- Nunca citar o veículo que deu a notícia. A empresa ou o grupo que fez a pesquisa só entra pelo nome quando o nome ajuda a entender; senão, "uma empresa de segurança".
- Sem "Por que isso importa?" falado. O comentário já cumpre esse papel.
- O CTA é o card "Gostou?", não é falado. A única exceção é a chamada para o vídeo completo no fim do vertical 1 (#12735).
- Tom de conversa desde a primeira versão (#13165): ler em voz alta antes de entregar. Usar "tá", "pra", "né", "a gente" onde caberia na fala, sem enfiar bordões em toda frase. Imperativo no mesmo tom do começo ao fim ("escreve", "guarda", "confere"), nunca misturado com "escreva", "guarde".
- Preferir verbo de fala ("conta", "viu", "disse") a verbo de relatório ("relatou", "acompanhou", "afirmou"), sem mudar o que a fonte sustenta. Na 261117: "Colegas dele relataram casos de cetoacidose" virou "Colegas dele contam casos de cetoacidose"; "Um endocrinologista acompanhou pacientes que largaram o remédio" virou "Um endocrinologista já viu paciente largar o remédio".
- Pelo menos uma pergunta ao público por bloco de comentário (o conjunto de falas do bloco, não cada id): "Denunciar adianta?", "Viu médico famoso vendendo produto milagroso? Desconfia.". Conferir também os comentários que sobraram em cada vertical depois dos cortes.
- Nada de oração relativa empilhada ("pacientes que receberam vídeos que…"). Dividir em frases curtas, com pausas; revisar trechos com mais de ~30 palavras sem pausa. Na 261117: "Se até um médico cai, não dá pra esperar que os nossos pais percebam sozinhos" virou "Se até um médico cai, imagina os nossos pais". Exemplo completo de tom: `test/fixtures/roteiro-video/roteiro-falas-261117.json`, ao lado da 261116. A conversa preserva a fidelidade do Passo 4.
- Um nome só para cada coisa. Se o resumo abriu com "senhas e chaves", não trocar por "credenciais" ou "segredos" depois.
- Termo técnico vem com a explicação na mesma fala ou na seguinte ("o GitHub é o site onde os programadores publicam código").
- Nome de arquivo ou comando ruim de falar vira descrição na fala ("o arquivo de configurações locais do Claude"), com o nome exato escrito na tela. Anotar no box "Na tela" da fala (campo `tela`, Passo 5), não nas notas.
- Número arredondado para o ouvido ("mais de 500", "quase 2.000"), sem mudar o sentido.
- Uma informação por frase. Fala com três dados vira duas falas.
- Não repetir o mesmo fato no resumo e no comentário.

## Passo 4 — Fidelidade

- A fala não afirma mais do que a fonte. Na dúvida sobre um vínculo (por exemplo, se todos os casos vieram do mesmo arquivo), usar a formulação que a fonte sustenta e dizer isso nas notas.
- Não nomear botão, opção ou tela de um produto sem ter conferido. Descrever a ação ("autoriza um comando e pede pra não perguntar de novo") em vez do rótulo.
- No relato do editor, não inventar detalhe. Escrever só o que ele contou e marcar a fala como dele.
- Dica prática que não vem da fonte é permitida, mas tem que estar certa e ser marcada nas notas como dica nossa. Conferir no próprio repositório quando a dica descreve o que a gente faz (por exemplo, se o `.env` está no `.gitignore`).
- Nas notas, separar: o que vem da fonte, o que é do editor, o que é sugestão.

## Passo 5 — Entregar como artefato

**A fonte é o JSON; as duas páginas são geradas dele (#13120, #13447).** Gravar o roteiro em `data/editions/{AAMM}/{AAMMDD}/_internal/roteiro-falas.json` (formato abaixo) e gerar as duas páginas com:

```bash
npx tsx scripts/render-roteiro-video.ts {AAMMDD} --sem-topicos
npx tsx scripts/render-roteiro-video.ts {AAMMDD} --topicos
```

A primeira é o roteiro completo, sem a coluna de tópicos (`_internal/roteiro-d1.html`); a segunda é a página só de tópicos para ler de relance na gravação (`_internal/topicos-gravacao.html`): um bloco por fala na ordem do horizontal, número pequeno e tópicos em fonte grande, a faixa de cada `trechoInserido` do react e as falas gravadas à parte no fim. Foi o par que o editor escolheu na 261118. As duas são artefatos separados, cada uma com o seu link. Sem `--sem-topicos` o roteiro sai com a coluna de tópicos à esquerda de cada fala; os dois flags não combinam numa chamada só.

O render valida o JSON (inválido = exit 2, nada gravado; capa fora da regra do gerador = exit 4, nada gravado, #13569: trocar a capa no JSON e gerar de novo, nunca publicar a página anterior no lugar), repete os `[aviso]` do `video-roteiro-blocos.ts` e grava `_internal/roteiro-d1.html` no layout da 261116: caixa "Gravação" no topo (duração calculada e falas de cada vídeo, o que gravar à parte, os itens de `gravacao`), botão "Copiar roteiro", uma seção por vídeo com título, texto da capa, blocos e falas numeradas, a coluna de tópicos à esquerda de cada fala (quando o roteiro tem `topicos` e a chamada não leva `--sem-topicos`), o box **"Na tela"** ao lado de cada fala do horizontal que tem `tela` (empilhado no celular; os verticais saem sem tela, #13180), os verticais na ordem de `ordem`, o corte parcial riscado e o de reserva sublinhado, e as "Notas para a edição" no fim (cortes, ordem diferente do horizontal, fontes de fora do D1 e os itens de `notas`). Nunca escrever nem editar o HTML à mão: a mesma fala aparece em cada vídeo que a usa, e só gerando do JSON as cópias não divergem. O texto de tela não lista mais nas notas: vai no box da fala.

Publicar cada página com a ferramenta Artifact, seguindo o que ela pede para uma página nova, e gerar cada uma de novo com o seu link (`--sem-topicos --artifact-url {URL do roteiro}` e `--topicos --artifact-url {URL dos tópicos}`): o link fica num comentário na primeira linha (`<!-- artifact: URL -->`), que as gerações seguintes preservam sozinhas. Uma sessão retomada lê esse link e republica no mesmo endereço, em vez de criar outro.

Na resposta, dar os dois links e citar só o que mudou.

**O roteiro em JSON (#12751).** É o que a montagem e a publicação leem, e a página sai dele (nenhum script lê o HTML):

```json
{
  "edicao": "AAMMDD",
  "veiculos": ["veículos da fonte do D1"],
  "porVideo": {
    "horizontal": { "titulo": "título do YouTube", "capa": "texto da capa" },
    "vertical1": { "capa": "…", "ordem": ["H1", "H6", "H4"], "pertenceAoHorizontal": true },
    "vertical2": { "titulo": "…", "capa": "…" }
  },
  "falas": [
    { "id": "H1", "bloco": "gancho", "texto": "…", "videos": ["horizontal", "vertical1"], "gravarAParte": false, "topicos": ["Previ três coisas", "Duas aconteceram"] },
    {
      "id": "H4", "bloco": "resumo", "texto": "… na Busca do Google e em outros serviços da empresa.", "videos": ["horizontal", "vertical1"],
      "tela": "App do Gemini · Busca do Google · AI Studio",
      "cortes": { "vertical1": "e em outros serviços da empresa" }
    },
    {
      "id": "H6", "bloco": "resumo", "texto": "…", "videos": ["horizontal", "vertical1"],
      "cortes": { "vertical1": ["trecho 1", { "trecho": "trecho 2", "reserva": true }] },
      "fontes": [{ "url": "https://…", "sustenta": "Hydrogen 51, Argon 50 no índice" }]
    }
  ],
  "gravacao": ["Antes de gravar: confira se …"],
  "notas": ["Repetição de propósito: …", "Do rascunho, ficou de fora: … (motivo)"]
}
```

Uma entrada por fala numerada, mais as gravadas à parte. `bloco` é o bloco da montagem em que a fala entra no horizontal (ou no vertical, quando ela só existe lá): `gancho`, `abertura`, `resumo`, `comentario`, `cta_vertical` (a chamada final do vertical 1); o resumo do horizontal vira o resumo curto nos verticais sozinho. `porVideo` traz o título e o texto da capa de cada vídeo (o vertical 1 sem título herda o do horizontal, #13116). Campos opcionais, todos retrocompatíveis:

- **`tela`** (por fala, #13120): o texto que vai escrito na tela durante a fala do horizontal, quando ela tiver um nome, número ou comparação que a fala não diz sozinha (o nome exato de um arquivo, índice ou modelo que a fala descreve sem citar; os números; a escada de modelos). Curto; `\n` quebra a linha. Sem seta (#9721; o validador recusa seta em qualquer texto que chega ao leitor). A página e o XML da montagem (#13140) leem o campo. Padrões do editor (#13180, revisão da 261116), para o box nascer assim:
  - **Só no horizontal.** Os verticais saem sem texto de tela: a página não mostra o box neles, e tela em fala que só está nos verticais gera `[aviso]`. **Exceção (#13333, decisão do editor de 17/11/2026):** fala que cita a tela ("o endereço está aqui na tela", "nesta tela") e também está num vertical leva o box nesse vertical, abaixo da legenda; a montagem (`telaMarkersFor`) aplica sozinha, pela `tela` da mesma fala. A página do roteiro ainda não mostra esse box no vertical.
  - **Só o que a fala não diz.** Sem box que repete a fala (seleção automática, data de lançamento, "Carbon planeja / Hydrogen executa", os exemplos de uma dica) nem comparação que outro box já cobre. Na dúvida, sem box.
  - **Um item por linha**, nunca separados por " · ". Nome e valor com dois-pontos: `Hydrogen: 51`.
  - **Título do box**, quando há, na primeira linha, inteira entre `**` (`**Artificial Analysis Intelligence Index**`): a página põe em negrito, na linha própria, e o XML recebe sem os `**`.
  - **Sem empresa entre parênteses** quando o nome do modelo basta ("Claude Sonnet 5.5", não "Claude Sonnet 5.5 (Anthropic)"), e sem rótulos como "(padrão)" ou "(dados do Google)".
  - **Um box pode cobrir duas falas vizinhas** do mesmo assunto (na 261116, H6 e H9c viraram um box só): a `tela` vai na primeira das duas.
  - **Nada que não valha para todo o público da fala** (na 261116 o "Sheets" saiu da lista porque não é para todos).

  Os `[aviso]` do `video-roteiro-blocos.ts` e do render apontam o que dá para conferir sem ler: tela num vertical, " · ", `**` fora de uma linha inteira, empresa entre parênteses, "(padrão)".
- **`topicos`** (por fala, pedido do editor em 17/11/2026): lista de bullets de até 4 palavras cada, com as ideias da fala na ordem em que ela as diz, para o editor gravar sem ler. Saem na página de tópicos (`--topicos`) e, no roteiro gerado sem `--sem-topicos`, numa coluna à esquerda da fala, em todos os vídeos que a usam; não vai para o XML nem para a legenda. Escrever para toda fala, inclusive as gravadas à parte, e atualizar junto quando a fala mudar. A coluna só aparece quando o roteiro tem tópicos, e o "Copiar roteiro" copia as falas sem eles. Tópico sem palavra, com mais de 4 palavras, com quebra de linha ou com seta invalida o JSON.
- **`trechoInserido`** (por fala, formato react, #13437): `{ "video", "inicio", "fim", "texto" }` quando um trecho de outro vídeo entra logo depois da fala, no horizontal. O formato, o que invalida o JSON e a migração do formato antigo (`scripts/migrar-trecho-inserido.ts`) estão em `.claude/skills/diaria-video-roteiro/reference/formato-react.md`, seção "Campo `trechoInserido`": ler antes de escrever o campo.
- **`cortes`** (por fala, #13129): `{ "vertical1": "trecho exato" }` tira o trecho só naquele vídeo (só nos verticais: o horizontal fica com a fala inteira, e o validador recusa `cortes.horizontal`); `{ "trecho": "…", "reserva": true }` marca o corte que só entra se o vídeo passar do alvo. Mais de um corte na mesma fala e vídeo (#13436): uma lista, misturando os dois formatos, `{ "vertical1": ["trecho 1", { "trecho": "trecho 2", "reserva": true }] }`. Cada trecho tem de estar no texto como palavras inteiras, aparecer uma vez só e não se sobrepor a outro trecho da lista, e o vídeo tem de usar a fala. Os cortes fixos saem juntos, localizados no texto original (a ordem da lista não muda o resultado); a reserva troca o pedaço da fala que já vai ao ar depois dos cortes fixos, e duas reservas no mesmo pedaço saem como uma troca só.
- **`fontes`** (por fala, #13132): `[{ "url", "sustenta" }]` para cada fato de fora da fonte do D1 (Passo 1).
- **`porVideo.{vertical1,vertical2}.ordem`** (#13128): a sequência daquele corte, por id, quando ela difere da ordem do horizontal. Tem de trazer exatamente as falas do vídeo. Dentro de um bloco a montagem segue essa ordem; entre blocos ela ordena pelo bloco (gancho, resumo, comentário…), e o `video-roteiro-blocos.ts` e o render avisam uma ordem que cruze blocos.
- **`porVideo.horizontal.trechoCompartilhar`** (#13164): `{ "inicio": "H11", "rotulo": "Pra mandar pros seus pais" }`, quando a fala promete um link para compartilhar só um trecho do horizontal. `inicio` precisa existir e pertencer ao horizontal; `rotulo` é texto em uma linha. O tempo só nasce na montagem, nunca estimar pelo roteiro. O campo é opcional e só vale no horizontal. **Quando o editor define um trecho para compartilhar** (na conversa, "o trecho dos pais vai do H11 até o fim"), gravar o campo no JSON na mesma hora, nunca só em `notas` (#13353): na 261117 o trecho ficou só numa nota, e o `publish-youtube.ts --share-start` ignorou o tempo em silêncio porque o campo não existia. A nota pode repetir o trecho para o editor, mas o campo é o que a publicação lê.
- **`porVideo.vertical1.pertenceAoHorizontal`** (#13280, decisão do editor no briefing do overnight 261116b): `true` quando o vertical 1 é recorte do horizontal da edição e chama para o vídeo completo (o caso normal, com a fala `cta_vertical`). É essa marcação que liga, na legenda do vertical, a chamada ao vídeo completo (#13709: "link no primeiro comentário" no Instagram, com o link por edição no 1º comentário; "link na resposta" no Threads; a chamada sem link no TikTok); sem ela, a publicação compara o título do vertical (o do D1) com o do horizontal publicado, e com o título do horizontal vindo do roteiro a linha não entra. `false` tira a linha de propósito. Só vale no vertical 1 (o vertical 2 sai como corte avulso, sem horizontal); o validador recusa o campo nos outros vídeos e valor que não seja `true`/`false`.
- **`porVideo.{v}.cta`**: o texto do card de CTA na página, quando não é o padrão ("Gostou? / Curta o vídeo / …").
- **`gravacao`** e **`notas`**: itens a mais da caixa "Gravação" e das "Notas para a edição" (o que conferir antes de gravar, repetição de propósito, de quem é cada fala, ressalvas de fidelidade, o que ficou de fora do rascunho do editor).

Validar com `npx tsx scripts/video-roteiro-blocos.ts {AAMMDD}` (exit 0 = o JSON serve; exit 2 lista o que está errado, inclusive `ordem` com fala faltando ou sobrando, corte com trecho que não está na fala ou que aparece duas vezes, fala de abertura num vertical e seta em qualquer texto; exit 4 = corrigir a capa antes de gravar; a proposta saiu: capa de vertical fora de 2 a 7 palavras ou capa do horizontal que não cabe em 2 linhas de até 4, a regra do `gen-youtube-thumb.ts`, #13401; o `render-roteiro-video.ts` mostra o mesmo `[erro]` e sai 4 sem gravar a página, #13569). Os `[aviso]` apontam fala sem bloco ou fora da ordem do vertical, gancho do vertical com mais de ~8 palavras antes do primeiro ponto, título que repete o gancho e capa de vertical sem sujeito (#13116), e vertical acima de 60 s ou horizontal fora da faixa de 3 min, com a sugestão de corte (#13130). A saída traz a duração estimada de cada vídeo: é ela que a página mostra.

## Passo 5a — Revisão por um segundo modelo, por vídeo (#13131)

Na 261116 o editor pediu várias vezes que um segundo modelo criticasse o roteiro, e cada rodada achou problema real que a primeira versão e o humanizador não pegaram: gancho fraco e longo, referência solta depois do corte ("o do meio", "isso"), contradição entre o gancho e o comentário ("ultrapassou" contra "empatou"), imprecisão ("um quinto ou menos" contra "mais de cinco vezes"), fala que afirma mais do que a fonte, ordem do comentário que quebrava o raciocínio. Funcionou melhor pedindo a crítica **por vídeo**, cada um como peça inteira. Roda duas vezes, sem o editor precisar pedir:

- **depois da primeira versão**, antes de entregá-la: revisão do conjunto;
- **no Passo 7**, depois do humanizador: revisão da coerência e da narrativa.

**Ordem:** passar o humanizador (Passo 7, item 1) **antes** de cada revisão, para o revisor não gastar a crítica no que o humanizador já resolve.

**Despacho:** um Agent `subagent_type: "revisor-roteiro-video"` (`.claude/agents/revisor-roteiro-video.md`: `claude-opus-5-5` + `effort: medium` no frontmatter, e só `Read`/`Grep`/`Glob`; na 261116 o revisor foi o Fable 5.2, que está fora do mix aprovado do repo, #9003: o que pega os problemas é a leitura sem o contexto da conversa, por vídeo), **somente leitura**: não edita arquivo, não publica, não roda o render. Agent dedicado porque o Agent tool não recebe `effort`, e um `general-purpose` herdaria o do turno (#9081). Recebe o caminho do `roteiro-falas.json` (as falas, os vídeos de cada uma, a `ordem` e os `cortes` de cada vertical), a fonte do D1 (`_internal/fact-check-sources/d1.txt`), as `fontes` declaradas e as regras dos Passos 2 a 4 desta skill. Prompt-base:

> Revise o roteiro de fala em `{caminho do roteiro-falas.json}` como três vídeos separados: o horizontal, o vertical 1 e o vertical 2. Monte cada vídeo com as falas que ele usa, na ordem dele (`porVideo.{vertical}.ordem` quando existir, senão a ordem das falas no JSON), já com os `cortes` daquele vídeo aplicados, e leia cada um como uma peça inteira, sem ter visto os outros. Para cada vídeo aponte: gancho fraco ou longo (no vertical, o ponto chega em ~3 s); fala que perdeu a referência no corte ("isso", "o do meio", "também"); contradição entre falas; número ou comparação impreciso; afirmação que vai além da fonte (`{d1.txt}` e as `fontes` do JSON); ordem que quebra o raciocínio; título e gancho iguais; fala com registro de texto escrito ou burocrático (verbos de relatório, oração relativa empilhada, frase longa sem pausa); bloco de comentário sem pergunta ao público; nome próprio, lugar ou projeto sem contexto (a fala não diz quem é ou de quem é). Leia cada vídeo mais duas vezes. **Narrativa:** o arco do vídeo, se o fecho entrega o que o gancho promete, a pergunta que o vídeo deixa sem resposta, o porquê que falta (por que aquilo aconteceu, por que pesa pra quem assiste) e, num react, se o vídeo diz o que foi previsto sem depender do trecho. **Encaixe:** as falas em sequência, inclusive através da abertura e dos trechos inseridos (`trechoInserido`), apontando a frase que não encaixa na anterior (sujeito que some depois da abertura, contraste sem conjunção, "eu disse" antes do trecho em que isso foi dito, fala que termina na ressalva e enterra a aposta que o fecho retoma). Respeite as regras em `.claude/skills/diaria-video-roteiro/SKILL.md`, Passos 2 a 4. Não reescreva o roteiro inteiro: proponha reescritas pontuais, por id de fala, mantendo o tom de conversa e a fidelidade à fonte; precisão não pede registro escrito. Responda em três blocos, `## Horizontal`, `## Vertical 1`, `## Vertical 2`, cada um com a lista `- {id}: {problema}; proposta: "{fala nova}"` (ou "sem problemas"), e no fim `## Entre vídeos`, para o que só aparece comparando os três.

**Filtro do coordenador, antes de mostrar ao editor.** A resposta nunca vai crua. O coordenador (esta sessão):

1. descarta o que contraria decisão já tomada nesta conversa ou registrada (na 261116, a volta de uma frase que o editor tinha tirado), e o que contraria as regras dos Passos 2 a 4;
2. confere cada reescrita contra o humanizador: aponta onde ela reintroduz um vício (o "E" no começo de frase, travessão, regra de três) e corrige antes de propor;
3. confere contra a fonte o que o revisor diz ser imprecisão, antes de aceitar;
4. entrega ao editor, por vídeo, o que sobrou: o problema, a fala atual e a proposta, separando o que foi aplicado (correção mecânica: referência solta, imprecisão confirmada na fonte) do que é decisão dele (mudança de sentido, de ordem ou de corte). Descartes saem numa linha só, com o motivo.

Aplicar no JSON e gerar a página de novo (Passo 6, item 1). Revisor indisponível (erro do Agent, modelo recusado): dizer isso na entrega e seguir sem a revisão, nunca travar o roteiro por ela.

Na 261118 a revisão por vídeo não bastou: uma leitura da narrativa e uma do encaixe, pedidas à parte pelo editor, acharam o vertical 1 que nunca dizia o que tinha sido previsto, um "eu disse" antes do trecho, nenhum vídeo dizendo por que o Brasil entrou na regra, um gancho que perguntava "pesa pra você?" sem resposta e sete frases que não encaixavam na anterior (#13435). Por isso as duas leituras estão no prompt-base acima, no mesmo despacho, e o revisor segue sem o contexto da conversa.

## Passo 5b — Fact-check do roteiro, antes da gravação (#13434)

Sempre, sem o editor pedir: depois da revisão do Passo 5a (nas duas vezes em que ela roda) e antes de entregar. O fact-check da fala gravada (`/diaria-video-montagem`, Passo 3a) continua, mas pega o problema tarde: corrigir aqui custa uma rodada; lá, custa regravar. Na 261118 o fact-check do roteiro achou 0 contradições e 17 afirmações além da fonte (36 sustentadas, 15 parciais, 2 sem suporte), tudo corrigido antes de gravar. Os tipos que apareceram e que a revisão por vídeo não pegou: **anunciado × em vigor** ("agora precisa", "a regra acabou de sair" sobre uma regra anunciada que só valia depois da publicação oficial); **generalização além da fonte** ("a regra não barra nenhum projeto"); **citação do próprio editor fora da letra** ("poucos governos e empresas" no lugar de "governos e empresas específicos"); **atribuição** ("a ByteDance tá construindo", quando quem constrói é a Omnia com a Casa dos Ventos); **nome, lugar ou projeto sem contexto** (Passo 1, item 5).

**Despacho:** um Agent `subagent_type: "fact-checker"` com `mode: "roteiro"` (seção "Modo roteiro" de `.claude/agents/fact-checker.md`), que recebe:

- `roteiro_path`: o `_internal/roteiro-falas.json` (o `texto` e o `tela` de cada fala, e o `trechoInserido`);
- `sources_dir`: `_internal/fact-check-sources/` da edição, com o `d1.txt` **atual**. Se o `02-reviewed.md` mudou depois do roteiro (o D1 trocou de fonte, como na 261118, em que o roteiro foi escrito sobre o D1 reservado e a edição saiu com outro), reler o D1 e conferir o roteiro antes; o `video-roteiro-blocos.ts` e o render dão `[aviso]` quando o `02-reviewed.md` é mais novo que o `roteiro-falas.json` ou que o `fact-check-roteiro.md`;
- as `fontes` de cada fala (estão no próprio JSON);
- num react (Passo 2), `srt_paths`: o SRT de cada vídeo citado em `trechoInserido.video` (`diaria-comentada-{AAMMDD}.srt` da edição daquele vídeo): é a fonte do que o editor disse antes;
- `out_path`: `_internal/fact-check-roteiro.md`, um veredito por afirmação.

**Depois:** corrigir no JSON tudo que saiu `PARTIAL`, `NOT_SUPPORTED` ou `DIVERGENT` (sem mudar o sentido por conta própria: mudança de sentido vai ao editor como decisão, Passo 6, item 3), gerar as duas páginas de novo (Passo 6, item 1) e listar as correções na entrega, por fala, com a frase antiga e a nova. Repetir o passo quando o D1 da edição mudar depois do roteiro e quando o editor mudar um fato numa fala (Passo 6). Fact-checker indisponível: dizer na entrega que o passo não rodou e seguir, como no Passo 5a.

## Passo 6 — Iterar com o editor

O editor dita ajustes por voz, um de cada vez. Para cada um:

1. Aplicar com `Edit` no `roteiro-falas.json` (fala, título, capa, quais vídeos usam a fala, `topicos`, `tela`, `cortes`, `ordem`, `notas`), gerar as duas páginas de novo (`render-roteiro-video.ts {AAMMDD} --sem-topicos` e `render-roteiro-video.ts {AAMMDD} --topicos`) e republicar cada uma no seu link, com um rótulo de versão. Regerar sempre as duas, mesmo quando o ajuste parece tocar só uma: a página de tópicos fica defasada em silêncio se a fala mudar e ela não for gerada de novo. A página sai do JSON, então todas as cópias da fala mudam juntas; conferir só os `[aviso]` e as notas livres (`notas`, `gravacao`), que não se atualizam sozinhas.
2. Responder com a fala nova entre aspas.
3. Se o ajuste criar um problema (um fato errado, uma fala que perdeu a referência), dizer e propor a saída, sem aplicar por conta própria o que muda o sentido.

Antes de uma mudança de estrutura (trocar a persona, mudar o número de vídeos), salvar uma cópia `roteiro-d1-v{N}.html` e `roteiro-falas-v{N}.json` na mesma pasta.

Termo que parece erro de ditado por voz: usar o termo certo e avisar.

## Passo 7 — Humanizador e revisão final

Quando o editor pedir, ou quando o roteiro parar de mudar:

1. Passar a skill `humanizador` nas falas. Não mexer nas falas que são palavras do editor (o relato e a última fala do comentário, quando ele ditou), só apontar.
2. Revisão da coerência e da narrativa por um segundo modelo, por vídeo (Passo 5a), com o filtro do coordenador, e de novo o fact-check do roteiro (Passo 5b), contra o D1 atual.
3. Revisão final, nesta lista:
   - alguma fala perdeu a referência depois de um corte ou de uma troca de ordem ("isso", "também", "a mesma decisão")?
   - o relato pessoal ainda combina com a frase que o apresenta?
   - algum fato aparece duas vezes?
   - cada vertical faz sentido sozinho e cumpre o que o gancho promete?
   - o vertical 2 chega nas dicas em até uns 30 s? Se passar disso, encurtar o que vem antes.
   - os critérios de título, capa e gancho do Passo 2 (#13116): título e gancho de cada vídeo dizem a mesma coisa com palavras diferentes? O título do vertical 1 é o do horizontal, e ele cabe em uns 40 caracteres? A capa do horizontal não repete o assunto do título? A capa de cada vertical tem sujeito reconhecível? A primeira frase do gancho chega ao ponto (umas 8 palavras no vertical, até 5 a 10 s no horizontal)? Os `[aviso]` do `video-roteiro-blocos.ts` apontam gancho longo no vertical, título que repete o gancho e capa de vertical sem sujeito.
   - a pesquisa do YouTube (Passo 2, #13156) rodou para os títulos atuais? Se algum título mudou de assunto depois dela, rodar de novo. As `notas` dizem quais termos da pesquisa entraram nos títulos e por quê, ou que ela não rodou e o motivo?
   - os verticais cabem em 60 s? A duração vem do `video-roteiro-blocos.ts`, já com os cortes; acima do alvo, usar primeiro os cortes de reserva declarados.
   - toda fala do horizontal com nome, número ou comparação que a fala não diz sozinha tem `tela`, e os boxes seguem os padrões do Passo 5 (#13180: nenhum que só repete a fala, um item por linha, título entre `**`)? Toda fala com fato de fora do D1 tem `fontes`?
   - as notas livres (`notas`, `gravacao`) descrevem a versão atual? O resto da caixa do topo e das notas sai do JSON.
   - num react (Passo 2, #13433): cada fala de vertical diz o que foi previsto sem o trecho? Nenhum "eu disse" vem antes do trecho em que isso foi dito? Os `trechoInserido` saíram do SRT, com o início antes da primeira palavra?
4. Entregar as mudanças aplicadas e, separadas, as decisões que são do editor.

## Passo 8 — Conferir a gravação contra o roteiro (#12754)

Depois de gravar, quando o editor entrega nesta sessão a transcrição da gravação (ditada pelo botão de gravar do Claude Code), ler `.claude/skills/diaria-video-roteiro/reference/conferir-gravacao.md` e seguir o passo inteiro: gravar a transcrição em `_internal/gravacao-transcricao.txt`, rodar `video-roteiro-confere.ts`, confirmar cada fala pelo critério de sentido (ok, diferente-mas-cabe, regravar só nos três casos, faltou) sem reescrever o `roteiro-falas.json` nem a página, e responder com um veredito por fala e a lista do que gravar de novo.

## Fim

Dizer que o roteiro está pronto para gravar e que o próximo comando, depois da gravação, é `/diaria-video-montagem {AAMMDD}`. Não rodar. Se o editor quiser conferir a gravação antes, ele dita a transcrição nesta sessão (Passo 8).

Na mesma mensagem, repetir o título e o texto da capa de cada vídeo. O que segue daqui (#12751): a montagem lê o `roteiro-falas.json` para propor os blocos dos dois verticais (o vertical 2 como corte `guia`), e o `/diaria-publica` usa o título do horizontal no YouTube (salvo `--title`) e os textos da capa. A publicação do vertical 2 uma semana depois vai para o banco de agendamentos (#12774): quem registra é a montagem, depois do Gate 2, quando o corte `guia` existe (registrar aqui, antes da gravação, alarmaria um vertical que talvez nem seja gravado).
