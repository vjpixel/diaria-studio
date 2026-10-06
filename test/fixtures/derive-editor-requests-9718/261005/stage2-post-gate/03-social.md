# Social

> **Texto único (#3991)** — o mesmo corpo + hashtags vai para LinkedIn, Facebook e Instagram. Cada publisher injeta sua própria linha de CTA/canal no momento do publish (`scripts/lib/social-cta-lines.ts`) — esta seção nunca contém CTA de canal. `post_pixel` é publicado manualmente no feed pessoal via Claude in Chrome (#1690).

## d1

A regra proíbe conteúdo sintético de candidatos, mas o feed não parece ter recebido o aviso. **Uma investigação contou 554 vídeos e imagens falsos postados durante a campanha de 2026.**

O número é sobre fiscalização. Proibir no papel é uma etapa. **Tirar do ar a tempo, antes que o vídeo circule por grupos e perfis, é outra bem mais difícil.**

Mas o número também tem outro lado. Deepfake identificado é deepfake que alguém monitorou, e esse rastreio existe justamente pra cobrar plataformas e autoridades. **O eleitor ainda tem a defesa mais barata: desconfiar de vídeo chocante e checar a origem antes de compartilhar.**

#InteligenciaArtificial #Deepfake #Eleicoes2026 #Desinformacao #FactChecking

## d2

A empresa que mais fala em segurança acaba de perder alguém que cuidava disso, e ele saiu fazendo barulho. **David Robinson deixou a OpenAI dizendo que a cultura da empresa está "quebrada".**

A crítica mira o setor inteiro. **Segundo ele, as companhias do setor não estão sendo nem perto de cuidadosas o suficiente com uma tecnologia que avança rápido.**

Robinson se junta a outros funcionários e ex-funcionários que pedem mais cautela à indústria. **Quando alguém sai assim, em público, entrega material concreto pra quem regula e pra quem cobra transparência.**

#InteligenciaArtificial #OpenAI #SegurancaDigital #EticaNaTecnologia #Regulacao

## d3

Nem todo problema pede um modelo gigante que escreve redação. **A Cloudflare lançou o Clef e o Clef-flash, modelos de código aberto feitos pra uma única tarefa: decidir rápido.**

Rodam no Workers AI, voltados pra classificação em alta velocidade e fluxos agênticos. **Na prática, é a peça que decide "vai pra cá ou pra lá" sem o custo de chamar um modelo grande a cada passo.**

Veio junto uma plataforma de ajuste fino por aprendizado por reforço — dá pra treinar esses modelos de decisão com os próprios dados, em vez de herdar um comportamento genérico que não conhece o seu negócio.

#InteligenciaArtificial #Cloudflare #CodigoAberto #Agentes #MachineLearning

## um

Gerar várias palavras de uma vez parece só ganho de velocidade, mas tem preço. **Uma pesquisa da Apple mostra onde a confiança dos modelos de difusão discreta começa a falhar.**

Esses modelos escrevem várias posições da sequência em cada passo, sorteando cada uma da sua própria distribuição. **E escolhem quais posições preencher usando essas mesmas distribuições.**

O problema aparece em pixels, fonemas ou palavras, onde um pedaço depende do outro. **Preencher tokens vizinhos em paralelo ignora essas dependências, e o resultado pode sair incoerente mesmo com o modelo "confiante".**

Pra quem testa geradores rápidos de texto ou imagem, o recado é direto. **Velocidade por passo não substitui checar a coerência do resultado final.**

#InteligenciaArtificial #Apple #MachineLearning #ModelosDeDifusao #Pesquisa

# Curto

## d1

554 deepfakes circularam na campanha eleitoral de 2026, mesmo com a proibição. A regra existe; a fiscalização ainda não acompanha.

Mais em {edition_url}

#Deepfakes #Eleições2026

## d2

Um líder de segurança da OpenAI saiu dizendo que a cultura da empresa está quebrada. David Robinson se junta a outros funcionários que cobram mais cuidado do setor.

Mais em {edition_url}

#OpenAI #SegurançaDigital

## d3

A Cloudflare abriu o código do Clef e do Clef-flash, modelos de decisão para classificação rápida e fluxos agênticos. Junto, uma plataforma de ajuste fino por reforço com seus próprios dados.

Mais em {edition_url}

#Cloudflare #OpenSource

## um

A Apple explica por que modelos de difusão tropeçam ao escrever vários tokens por passo: as palavras dependem umas das outras. Ajuda a entender onde a geração paralela falha.

Mais em {edition_url}

#Apple #ModelosDeDifusão
