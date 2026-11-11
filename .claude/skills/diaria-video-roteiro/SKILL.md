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
- Cada vídeo tem título e texto da capa. O título é pensado para a busca e o clique no YouTube e pode ser diferente do título do D1 na newsletter; avisar quando for.

## Passo 3 — Regras da fala

Vêm de decisões do editor. Não reabrir.

- Nunca citar o veículo que deu a notícia. A empresa ou o grupo que fez a pesquisa só entra pelo nome quando o nome ajuda a entender; senão, "uma empresa de segurança".
- Sem "Por que isso importa?" falado. O comentário já cumpre esse papel.
- O CTA é o card "Gostou?", não é falado. A única exceção é a chamada para o vídeo completo no fim do vertical 1 (#12735).
- Tom de conversa: "pra", "tinha", frases curtas. Imperativo no mesmo tom do começo ao fim ("escreve", "guarda", "confere"), nunca misturado com "escreva", "guarde".
- Um nome só para cada coisa. Se o resumo abriu com "senhas e chaves", não trocar por "credenciais" ou "segredos" depois.
- Termo técnico vem com a explicação na mesma fala ou na seguinte ("o GitHub é o site onde os programadores publicam código").
- Nome de arquivo ou comando ruim de falar vira descrição na fala ("o arquivo de configurações locais do Claude"), com o nome exato escrito na tela. Anotar isso nas notas de gravação.
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

Gravar a página em `data/editions/{AAMM}/{AAMMDD}/_internal/roteiro-d1.html` e publicar com a ferramenta Artifact, seguindo o que ela pede para uma página nova. Gravar o link do artefato num comentário HTML na primeira linha do arquivo (`<!-- artifact: URL -->`): uma sessão retomada lê esse link e republica no mesmo endereço, em vez de criar outro. Partir do layout do exemplo da 261112 (ou do roteiro da edição anterior mais recente que tiver um):

- uma caixa no topo com o formato da versão;
- botão "Copiar roteiro";
- uma seção por vídeo, com título, texto da capa, blocos e falas numeradas;
- etiquetas para "Seu relato", "Gravar à parte" e sugestões;
- notas de gravação no fim: ordem de gravação, quais falas cada vertical usa, o que mostrar na tela, de quem é cada fala, ressalvas de fidelidade.

Na resposta, dar o link e citar só o que mudou.

## Passo 6 — Iterar com o editor

O editor dita ajustes por voz, um de cada vez. Para cada um:

1. Aplicar com `Edit` no arquivo e republicar no mesmo link, com um rótulo de versão. Na página, o texto de uma fala aparece de novo em cada vídeo que a usa: mudar todas as cópias (`replace_all` com um trecho que só exista nas falas) e conferir que as notas de gravação continuam certas.
2. Responder com a fala nova entre aspas.
3. Se o ajuste criar um problema (um fato errado, uma fala que perdeu a referência), dizer e propor a saída, sem aplicar por conta própria o que muda o sentido.

Antes de uma mudança de estrutura (trocar a persona, mudar o número de vídeos), salvar uma cópia `roteiro-d1-v{N}.html` na mesma pasta.

Termo que parece erro de ditado por voz: usar o termo certo e avisar.

## Passo 7 — Humanizador e revisão final

Quando o editor pedir, ou quando o roteiro parar de mudar:

1. Passar a skill `humanizador` nas falas. Não mexer nas falas que são palavras do editor (o relato e a última fala do comentário, quando ele ditou), só apontar.
2. Revisão final, nesta lista:
   - alguma fala perdeu a referência depois de um corte ou de uma troca de ordem ("isso", "também", "a mesma decisão")?
   - o relato pessoal ainda combina com a frase que o apresenta?
   - algum fato aparece duas vezes?
   - cada vertical faz sentido sozinho e cumpre o que o gancho promete?
   - o vertical 2 chega nas dicas em até uns 30 s? Se passar disso, encurtar o que vem antes.
   - as durações escritas na página batem com o texto?
   - a caixa do topo e as notas descrevem a versão atual?
3. Entregar as mudanças aplicadas e, separadas, as decisões que são do editor.

## Passo 8 — Conferir a gravação contra o roteiro (#12754)

Depois de gravar, o editor entrega na mesma sessão a transcrição da gravação, ditada pelo botão de gravar do Claude Code. O passo diz se o que foi gravado serve, ainda no set, antes da montagem.

**Premissa:** a transcrição é a do ditado, não a do áudio do vídeo. Ditada junto com a câmera, as duas coincidem; ditada depois, de memória, o passo confere um ensaio e não o bruto. Se o editor não disser como ditou, assumir que foi junto com a câmera e escrever isso na resposta.

1. Gravar as falas da versão atual em `_internal/roteiro-falas.json` (`{ "edicao", "veiculos": [veículos da fonte do D1], "falas": [{ "id": "H1", "texto", "videos": ["horizontal", "vertical1"], "gravarAParte": false }] }`), uma entrada por fala numerada mais as gravadas à parte, e a transcrição em `_internal/gravacao-transcricao.txt` (tomada nova do mesmo dia: `gravacao-transcricao-2.txt`, e assim por diante).
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
5. Responder com um veredito por fala, na ordem do roteiro, e no fim a lista curta do que gravar de novo: o id, o texto da fala e os vídeos afetados (horizontal, vertical 1, vertical 2). Se nada faltar nem precisar regravar, dizer que está pronto para o `/diaria-video-montagem {AAMMDD}`.

Este passo não substitui o fact-check da fala gravada nem a decupagem do `/diaria-video-montagem`, que trabalham sobre o bruto com tempo por palavra. Nova tomada depois de regravar: repetir o passo só com a transcrição nova.

## Fim

Dizer que o roteiro está pronto para gravar e que o próximo comando, depois da gravação, é `/diaria-video-montagem {AAMMDD}`. Não rodar. Se o editor quiser conferir a gravação antes, ele dita a transcrição nesta sessão (Passo 8).

Na mesma mensagem, repetir o título e o texto da capa de cada vídeo e avisar o que ainda é manual (#12751): a montagem e a publicação não leem este roteiro. O corte do vertical 2, o título do YouTube quando difere do D1 e a publicação do vertical 2 uma semana depois dependem do editor ou de pedido explícito nas sessões seguintes.
