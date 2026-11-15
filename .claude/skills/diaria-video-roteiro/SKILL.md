---
name: diaria-video-roteiro
description: Escreve o roteiro de fala do vídeo "diar.ia.br comentada" do dia, antes da gravação — um vídeo horizontal e dois verticais que saem da mesma gravação, a partir do D1 da edição. Entrega um artefato (página) com título, texto da capa e falas numeradas por vídeo, e itera com o editor até ele gravar; depois da gravação, confere a transcrição ditada contra o roteiro e diz o que regravar. Roda depois do gate da Etapa 4 e antes da gravação; standalone, sem encadear. Uso — `/diaria-video-roteiro [AAMMDD]`.
model: claude-opus-5-5
effort: medium
---

# /diaria-video-roteiro AAMMDD

Escreve o roteiro que o editor lê para gravar o vídeo do dia. Nasceu do processo da edição 261112 (10/11/2026), feito à mão numa sessão: o roteiro saiu de uma primeira versão até a 22ª em conversa com o editor. Exemplo completo, com o layout da página: `data/editions/2611/261112/_internal/roteiro-d1.html` (em `data/`, fora do git; sem ele, o Passo 5 descreve o layout).

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

Se o editor já contou um caso pessoal ou uma opinião sobre o tema nesta conversa, usar. Se não, escrever o comentário como sugestão marcada e perguntar, na entrega da primeira versão, se ele tem um caso próprio. O relato dele é o que mais melhora o vídeo.

**Rascunho do editor (#13132).** O editor pode trazer um rascunho próprio (notícia e comentários), em texto ou imagem. Separar cada ponto em **fato a checar** ou **opinião dele** (a opinião entra como dele, sem checar). Para fato que não está na fonte do D1 nem no fact-check da edição, buscar na web (`WebSearch`/`WebFetch`; preferir a página oficial ou a fonte primária) e classificar:

- `confirmado`: uma fonte confiável sustenta;
- `fonte-terceira`: só site terceiro ou imprensa sustenta (dizer qual; serve, com a fonte nas notas);
- `contraditorio`: a fonte diz outra coisa: propor a versão corrigida em vez de só tirar o ponto (na 261116, o mapa Pro/Flash/Flash-Lite foi corrigido, não descartado);
- `sem-fonte`: nada achado: fica fora da fala, ou entra como opinião do editor se ele quiser.

Registrar no `roteiro-falas.json` (Passo 5): a lista em `fatosChecados`, a `fonte` de cada fala que usa um fato de fora do D1 em `fontes` (a montagem passa ao fact-check da fala gravada) e, em `excluidos`, cada ponto do rascunho que ficou de fora ou entrou só em parte, com o motivo (o editor pergunta por isso). Na entrega da primeira versão, dizer o que foi checado e o que ficou de fora.

## Passo 2 — Formato: uma gravação, três vídeos

O editor grava uma vez, na ordem do horizontal. Os verticais são cortes dessa gravação.

- **Horizontal (1920x1080, cerca de 3 min):** a notícia inteira. Blocos: Gancho, Abertura, Resumo, Comentário, card de CTA.
- **Vertical 1, a notícia (cerca de 60 s):** gancho, resumo curto com o número mais forte, o comentário pessoal e uma chamada falada para o vídeo completo. Sai primeiro.
- **Vertical 2, o guia (cerca de 75 s):** o que fazer, em passos. Tem que se sustentar sozinho. Sai uma semana depois do vertical 1.

Regras de estrutura:

- Cada fala do horizontal tem um número (`H1`, `H2`…). Os verticais listam as falas que reaproveitam, pelo número. Ao reordenar ou cortar falas, manter os números já dados e dizer isso nas notas.
- No máximo duas falas gravadas à parte: o gancho do vertical 2 e a chamada final do vertical 1.
- Toda fala usada num vertical precisa funcionar sem a anterior: repetir o sujeito ("o Claude Code", não "ele") e não depender de uma fala que ficou só no horizontal.
- Quando o vídeo entrega dicas, o gancho promete: "Fica até o final, que eu vou te dar três dicas pra…". No vertical 1 a promessa vira a chamada final para o vídeo completo no YouTube. É falada porque fora do YouTube Shorts o post não leva link para o horizontal (#12735).
- Abertura fixa, sempre a mesma: "Oi! Eu sou o Pixel, editor da diar.ia.br, e neste canal comento as principais notícias de IA com foco no que pode impactar sua vida."
- Cada vídeo tem título e texto da capa. O título é pensado para a busca e o clique no YouTube e pode ser diferente do título do D1 na newsletter; avisar quando for. O texto da capa segue a diretriz de `docs/youtube-capa-texto.md` (#12737): complementa o título, 2 a 6 palavras (5 no vertical), pergunta ou afirmação; ordenar os candidatos com `npx tsx scripts/suggest-capa-hooks.ts {AAMMDD} --candidates-file {arquivo}` e trazer os primeiros como opções. O script compara a capa com o título do D1 e com os títulos do vídeo (`--title`, ou os do `roteiro-falas.json` quando ele já existe): passar `--title` quando o vídeo trata de outro assunto que o D1 do `02-reviewed.md`.

Critérios de título, capa e gancho (#13116, decididos com o editor em 15/11/2026; detalhe em `docs/youtube-capa-texto.md`):

1. Título e gancho fazem a mesma promessa com palavras diferentes, nunca iguais. No horizontal a pessoa já leu o título antes do clique: o título traz o assunto e o nome, para a busca; o gancho traz a consequência para quem assiste. Nos verticais o título aparece escrito na tela e a fala sai como legenda queimada, então título igual ao gancho mostra a mesma frase duas vezes: o título diz o assunto, o gancho traz a tensão. No Instagram, a primeira linha da legenda do post (corte em cerca de 125 caracteres) também não copia o título.
2. A capa do horizontal aparece sempre com o título: traz a consequência e não repete o assunto.
3. A capa do vertical aparece sozinha na grade do perfil: precisa de sujeito reconhecível ("Sua Busca", "Google"), nunca uma pergunta sem sujeito ("Inventa cinco vezes menos?").
4. O gancho chega ao ponto em cerca de 3 s no vertical e em até 5 a 10 s no horizontal: o que importa para quem assiste vem na primeira frase. Estimar a duração a cerca de 150 palavras por minuto (3 s são umas 8 palavras).

Pergunta ou afirmação na capa: escolher pela clareza, não pelo formato (a diretriz não tem evidência para preferir uma ou outra). Título do horizontal: mirar cerca de 60 caracteres, com o nome do produto no começo.

## Passo 3 — Regras da fala

Vêm de decisões do editor. Não reabrir.

- Nunca citar o veículo que deu a notícia. A empresa ou o grupo que fez a pesquisa só entra pelo nome quando o nome ajuda a entender; senão, "uma empresa de segurança".
- Sem "Por que isso importa?" falado. O comentário já cumpre esse papel.
- O CTA é o card "Gostou?", não é falado. A única exceção é a chamada para o vídeo completo no fim do vertical 1 (#12735).
- Tom de conversa: "pra", "tinha", frases curtas. Imperativo no mesmo tom do começo ao fim ("escreve", "guarda", "confere"), nunca misturado com "escreva", "guarde".
- Um nome só para cada coisa. Se o resumo abriu com "senhas e chaves", não trocar por "credenciais" ou "segredos" depois.
- Termo técnico vem com a explicação na mesma fala ou na seguinte ("o GitHub é o site onde os programadores publicam código").
- Nome de arquivo ou comando ruim de falar vira descrição na fala ("o arquivo de configurações locais do Claude"), com o nome exato escrito na tela. Anotar isso no box "Na tela" da fala (campo `tela`, #13120).
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

A fonte é o JSON: escrever `data/editions/{AAMM}/{AAMMDD}/_internal/roteiro-falas.json` (abaixo) e gerar a página a partir dele (#13120), nunca escrever o HTML à mão:

```bash
npx tsx scripts/render-roteiro-video.ts {AAMMDD} [--versao v{N}]
```

Grava `_internal/roteiro-d1.html` e publica-se com a ferramenta Artifact, seguindo o que ela pede para uma página nova. Gravar o link do artefato num comentário HTML na primeira linha do arquivo (`<!-- artifact: URL -->`): o gerador mantém essa linha ao gerar de novo, e uma sessão retomada lê o link e republica no mesmo endereço, em vez de criar outro. O layout é o da 261116 (o da 261112 com a fala em grade):

- uma caixa no topo com a gravação: a duração calculada de cada vídeo (não digitada, #13130), quais falas cada vertical usa, na ordem dele, o que gravar à parte e os avisos de duração;
- botão "Copiar roteiro";
- uma seção por vídeo, com título, texto da capa, blocos e falas numeradas;
- o box **"Na tela"** ao lado de cada fala que tem texto, número, nome ou comparação para mostrar (o nome exato de um arquivo, índice ou modelo que a fala descreve sem citar; os números; a escada de modelos), do campo `tela`; no celular ele vai para baixo da fala;
- o corte parcial de um vertical riscado na fala daquele vídeo, com etiqueta ("Cortada neste vídeo", "Corte de reserva");
- etiquetas para "Gravar à parte" e para o campo `etiqueta` da fala ("Seu relato", "Sugestão");
- notas para a edição no fim: ordem própria de cada vertical, cortes, fontes por fala, fatos checados, pontos do rascunho que ficaram de fora e as `notas` livres (de quem é cada fala, ressalvas de fidelidade). O que vai na tela fica no box da fala, não nas notas.

Na resposta, dar o link e citar só o que mudou.

**O roteiro em JSON (#12751).** É o que a página, a montagem e a publicação leem (nenhum script lê o HTML):

```json
{
  "edicao": "AAMMDD",
  "veiculos": ["veículos da fonte do D1"],
  "porVideo": {
    "horizontal": { "titulo": "título do YouTube", "capa": "texto da capa" },
    "vertical1": { "titulo": "…", "capa": "…", "ordem": ["H1", "H4", "H10", "H10c", "V1-CTA"] },
    "vertical2": { "titulo": "…", "capa": "…" }
  },
  "falas": [
    { "id": "H1", "bloco": "gancho", "texto": "…", "videos": ["horizontal", "vertical1"], "gravarAParte": false },
    {
      "id": "H4", "bloco": "resumo", "texto": "… no app, na Busca e em outros serviços da empresa.", "videos": ["horizontal", "vertical1"],
      "tela": "App do Gemini · Busca do Google · API",
      "cortes": { "vertical1": " e em outros serviços da empresa" },
      "fontes": [{ "url": "https://…", "sustenta": "o que esta fonte sustenta na fala" }]
    },
    { "id": "H10f", "bloco": "comentario", "texto": "…", "videos": ["horizontal", "vertical1"], "cortes": { "vertical1": { "trecho": "segunda frase.", "reserva": true } } }
  ],
  "fatosChecados": [{ "fato": "…", "situacao": "confirmado|fonte-terceira|contraditorio|sem-fonte", "fonte": "…", "correcao": "…" }],
  "excluidos": [{ "ponto": "…", "motivo": "…", "parcial": false }],
  "notas": ["nota livre para a gravação ou a edição"]
}
```

Uma entrada por fala numerada, mais as gravadas à parte. `bloco` é o bloco da montagem em que a fala entra no horizontal (ou no vertical, quando ela só existe lá): `gancho`, `abertura`, `resumo`, `comentario`, `cta_vertical` (a chamada final do vertical 1); o resumo do horizontal vira o resumo curto nos verticais sozinho. `porVideo` traz o título e o texto da capa de cada vídeo, como na página. Campos opcionais:

- `porVideo.{vertical1,vertical2}.ordem` (#13128): a sequência das falas daquele corte, por id, quando ela não é a do horizontal (na 261116, a H10 antes da H10c só no vertical 1). Lista exatamente as falas marcadas para aquele vídeo. Sem o campo, o vertical segue a montagem: bloco a bloco, na ordem do horizontal dentro de cada bloco. A montagem monta por bloco, então a ordem declarada vale dentro de cada bloco (um aviso aponta a ordem que cruza blocos).
- `tela` (#13120): o texto do box "Na tela" da fala, curto (quebra de linha com `\n`). A montagem recebe na proposta de blocos para propor os textos de tela.
- `cortes` (#13129): o trecho exato que sai da fala só naquele vertical (`"vertical1": "trecho"`, ou uma lista). `{ "trecho": "…", "reserva": true }` é o corte de reserva: só entra se a duração estimada do vertical passar do alvo. O horizontal fica sempre com a fala inteira; corte que tiraria a fala toda é recusado (tirar o vertical de `videos`).
- `fontes` (#13132): por fala, a URL e o que ela sustenta, para cada fato que não está na fonte do D1. O fact-check da fala gravada na montagem lê essas fontes.
- `etiqueta`: etiqueta da fala na página ("Seu relato", "Sugestão").
- `fatosChecados`, `excluidos` (#13132) e `notas`: vão para as notas da página.

Validar com `npx tsx scripts/video-roteiro-blocos.ts {AAMMDD}` (exit 0 = o JSON serve). Ele imprime a duração estimada de cada vídeo (`[duração]`, palavras ÷ ~150 por minuto, o card de CTA à parte) e os `[aviso]`: fala sem bloco ou fora da ordem do vertical, ordem declarada que cruza blocos, corte de reserva aplicado, vertical acima do alvo com a sugestão de corte (cortes de reserva, frases do fim do comentário, falas longas), horizontal longe de ~3 min, gancho do vertical com mais de ~8 palavras antes do primeiro ponto e título que repete o gancho (#13116). Os alvos e o ritmo ficam em `platform.config.json` → `publishing.video.roteiro` (#13130). O validador recusa `ordem` com id faltando ou sobrando, trecho de corte que não está na fala e campo malformado.

## Passo 6 — Iterar com o editor

O editor dita ajustes por voz, um de cada vez. Para cada um:

1. Aplicar com `Edit` no `roteiro-falas.json` (fala, título, capa, quais vídeos usam a fala, ordem, cortes, `tela`), rodar `video-roteiro-blocos.ts` para validar e ver a duração, gerar a página de novo com `render-roteiro-video.ts {AAMMDD} --versao v{N}` e republicar no mesmo link. As cópias de cada fala nos três vídeos saem do JSON: não editar o HTML.
2. Responder com a fala nova entre aspas.
3. Se o ajuste criar um problema (um fato errado, uma fala que perdeu a referência), dizer e propor a saída, sem aplicar por conta própria o que muda o sentido.

Antes de uma mudança de estrutura (trocar a persona, mudar o número de vídeos), salvar uma cópia `roteiro-falas-v{N}.json` e `roteiro-d1-v{N}.html` na mesma pasta.

Termo que parece erro de ditado por voz: usar o termo certo e avisar.

## Passo 6a — Revisão por um segundo modelo, por vídeo (#13131)

Na 261116 cada rodada de crítica por um segundo modelo achou problemas reais que a primeira versão e o humanizador não pegaram: gancho fraco e longo, referência solta no corte ("isso", "o do meio"), contradição entre o gancho e o comentário, imprecisão de número, fala que afirma além da fonte, ordem do comentário que quebrava o raciocínio. O que funcionou foi pedir a crítica **por vídeo**, cada um como peça inteira.

**Quando:** duas vezes, sem o editor pedir: depois da primeira versão (antes de entregá-la) e no fim, junto do Passo 7. O humanizador (Passo 7, item 1) roda antes de cada revisão.

**Despacho:** um subagente `adhoc-opus-medium` com `model: "fable"` explícito (o segundo modelo; não herdar o desta sessão), somente leitura. Entrada, no prompt:

- a saída de `npx tsx scripts/video-roteiro-blocos.ts {AAMMDD}`: cada vídeo com as falas na ordem dele, os cortes aplicados, o texto de tela e a duração;
- a fonte do D1 (`_internal/fact-check-sources/d1.txt`) e as `fontes` por fala do JSON;
- as regras da fala (Passos 3 e 4 desta skill) e os critérios de título, capa e gancho (Passo 2).

Prompt-base: "Você revisa o roteiro falado de três vídeos que saem de uma gravação. Leia cada vídeo como peça inteira, sozinho, na ordem dele. Para cada vídeo, aponte só problemas concretos: gancho que não chega ao ponto na primeira frase; fala que depende de outra que ficou fora daquele vídeo ('isso', 'ele', 'o do meio'); contradição entre falas; número ou comparação imprecisa; afirmação além do que a fonte sustenta; ordem que quebra o raciocínio; regra da fala violada. Para cada problema, cite a fala pelo id, diga o problema em uma frase e proponha uma reescrita pontual. Não reescreva o roteiro inteiro, não edite arquivos."

Resposta: um bloco por vídeo (`## horizontal`, `## vertical 1`, `## vertical 2`), e em cada um uma lista de `id: problema. Reescrita: "…"`; vídeo sem problema diz "sem problema".

**Filtro do coordenador:** a resposta passa por esta sessão antes de chegar ao editor. Descartar o que contraria decisão já tomada na conversa (na 261116, a volta de uma frase que o editor tinha tirado), conferir contra a fonte o que o revisor diz ser fato e apontar onde a reescrita proposta reintroduz um vício do humanizador (o "E" no começo de frase). Ao editor vão só os achados que sobraram, com a reescrita, para ele decidir; nada é aplicado sem ele.

## Passo 7 — Humanizador e revisão final

Quando o editor pedir, ou quando o roteiro parar de mudar:

1. Passar a skill `humanizador` nas falas. Não mexer nas falas que são palavras do editor (o relato e a última fala do comentário, quando ele ditou), só apontar.
2. Revisão final, nesta lista:
   - alguma fala perdeu a referência depois de um corte ou de uma troca de ordem ("isso", "também", "a mesma decisão")?
   - o relato pessoal ainda combina com a frase que o apresenta?
   - algum fato aparece duas vezes?
   - cada vertical faz sentido sozinho e cumpre o que o gancho promete?
   - o vertical 2 chega nas dicas em até uns 30 s? Se passar disso, encurtar o que vem antes.
   - os critérios de título, capa e gancho do Passo 2 (#13116): título e gancho de cada vídeo dizem a mesma coisa com palavras diferentes? A capa do horizontal não repete o assunto do título? A capa de cada vertical tem sujeito reconhecível? A primeira frase do gancho chega ao ponto (umas 8 palavras no vertical, até 5 a 10 s no horizontal)? Os `[aviso]` do `video-roteiro-blocos.ts` apontam gancho longo no vertical e título que repete o gancho.
   - cada vertical cabe no alvo? A duração vem do `video-roteiro-blocos.ts` (e a página mostra a mesma, calculada do JSON); se um vertical passa, o aviso traz a sugestão de corte.
   - a caixa do topo e as notas descrevem a versão atual (página gerada de novo depois da última mudança no JSON)?
3. A revisão por um segundo modelo, por vídeo (Passo 6a), com o humanizador já aplicado.
4. Entregar as mudanças aplicadas e, separadas, as decisões que são do editor.

## Passo 8 — Conferir a gravação contra o roteiro (#12754)

Depois de gravar, o editor entrega na mesma sessão a transcrição da gravação, ditada pelo botão de gravar do Claude Code. O passo diz se o que foi gravado serve, ainda no set, antes da montagem.

**Premissa:** a transcrição é a do ditado, não a do áudio do vídeo. Ditada junto com a câmera, as duas coincidem; ditada depois, de memória, o passo confere um ensaio e não o bruto. Se o editor não disser como ditou, assumir que foi junto com a câmera e escrever isso na resposta.

1. Conferir que `_internal/roteiro-falas.json` (Passo 5) descreve a versão atual e gravar a transcrição em `_internal/gravacao-transcricao.txt` (tomada nova do mesmo dia: `gravacao-transcricao-2.txt`, e assim por diante).
2. Rodar `npx tsx scripts/video-roteiro-confere.ts --falas {…}/roteiro-falas.json --transcricao {…}/gravacao-transcricao.txt`. É a primeira passada, determinística: casa cada fala com o trecho mais parecido da transcrição por conteúdo (a ordem da gravação pode não ser a do roteiro), aponta número do roteiro que sumiu, veículo dito em voz alta e trechos que nenhuma fala explica. Todo veredito diferente de `ok` vem marcado para confirmar.
3. Confirmar lendo o trecho de cada fala e dar o veredito final:
   - **ok**: as palavras do roteiro; a diferença, se houver, é só de ditado, conectivo ou ordem miúda, e o texto da página não muda;
   - **diferente-mas-cabe**: reformulação, com outras palavras, que mantém o mesmo fato e o mesmo sentido; muda o texto da página, porque a montagem parte do que foi dito; citar a frase gravada;
   - **regravar**: mudou um fato, um número ou um nome; quebrou uma regra da fala (citou o veículo, CTA falado fora da exceção do vertical 1); ou deixou de funcionar sozinha num vertical que a reaproveita;
   - **faltou**: não aparece na transcrição.
4. Cuidados ao confirmar:
   - O ditado distorce nomes de produto, siglas e nomes de arquivo. Diferença que é claramente erro de transcrição não conta como desvio. Na dúvida entre erro de ditado e fala errada, perguntar ao editor em vez de mandar regravar.
   - Número ditado por extenso conta como o mesmo número; o script já aceita os simples e os compostos ("quinhentos", "dois mil", "dois mil e vinte e seis", "trinta e sete", "um e meio"). Número que o script deu como ausente e que está lá com outra grafia é `ok`.
   - Improviso bom (frase nova que melhora a fala, nos trechos sem fala correspondente) não é erro: apontar, conferir o fato contra a fonte se houver um, e atualizar a fala na página para a montagem partir do que foi dito (Passo 6, mesmo link). Fato que não está na fonte: sinalizar para checagem, sem reprovar sozinho.
   - Trecho repetido costuma ser outra tomada da mesma fala; não é improviso.
   - Uma palavra dita uma vez só serve a uma fala (#12781): se duas falas se parecem, a que perdeu as palavras para a vizinha sai `faltou`. Confirmar lendo a transcrição antes de mandar gravar.
   - A empresa que o roteiro cita de propósito e que também é o veículo (#12781) não conta como "citou o veículo" na fala que a traz; dita em outra fala ou fora das falas, segue apontada.
5. Responder com um veredito por fala, na ordem do roteiro, e no fim a lista curta do que gravar de novo: o id, o texto da fala e os vídeos afetados (horizontal, vertical 1, vertical 2). Se nada faltar nem precisar regravar, dizer que está pronto para o `/diaria-video-montagem {AAMMDD}`.

Este passo não substitui o fact-check da fala gravada nem a decupagem do `/diaria-video-montagem`, que trabalham sobre o bruto com tempo por palavra. Nova tomada depois de regravar: repetir o passo só com a transcrição nova.

## Fim

Dizer que o roteiro está pronto para gravar e que o próximo comando, depois da gravação, é `/diaria-video-montagem {AAMMDD}`. Não rodar. Se o editor quiser conferir a gravação antes, ele dita a transcrição nesta sessão (Passo 8).

Na mesma mensagem, repetir o título e o texto da capa de cada vídeo. O que segue daqui (#12751): a montagem lê o `roteiro-falas.json` para propor os blocos dos dois verticais (o vertical 2 como corte `guia`), na ordem e com os cortes parciais de cada um (#13128, #13129), e passa as `fontes` por fala ao fact-check da fala gravada (#13132), e o `/diaria-publica` usa o título do horizontal no YouTube (salvo `--title`) e os textos da capa. A publicação do vertical 2 uma semana depois vai para o banco de agendamentos (#12774): quem registra é a montagem, depois do Gate 2, quando o corte `guia` existe (registrar aqui, antes da gravação, alarmaria um vertical que talvez nem seja gravado).
