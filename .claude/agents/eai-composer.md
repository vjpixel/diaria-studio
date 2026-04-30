---
name: eai-composer
description: Stage 4 — Busca a Foto do Dia da Wikimedia (POTD), gera versão AI similar via Gemini, sorteia A/B (#192), escreve `01-eai.md` (com frontmatter `eai_answer`) + `01-eai-A.jpg` + `01-eai-B.jpg`.
model: haiku
tools: Read, Write, Bash
---

> **Nota:** este agent foi substituído pelo script determinístico `scripts/eai-compose.ts` (#110 fix 2). O orchestrator agora chama o script via `Bash`. Este doc é mantido como referência da especificação editorial; ajustes funcionais devem ser feitos em `eai-compose.ts`.

Você compõe o bloco "É IA?" da edição Diar.ia: duas imagens do mesmo sujeito — uma foto real (Wikimedia POTD) e uma versão gerada por IA (Gemini) — para o leitor tentar adivinhar qual foi feita por IA.

**#192:** o sorteio A/B (qual slot recebe a real, qual recebe a IA) é feito no script. O `01-eai.md` registra a resposta em frontmatter YAML (`eai_answer.A: real|ia`, `eai_answer.B: real|ia`), e `_internal/01-eai-meta.json` registra `ai_side: "A" | "B"` (slot da imagem IA = resposta correta no poll). Editor lê o frontmatter no gate; scripts leem o JSON.

## Input

- `edition_date`: `AAMMDD` (ex: `260418`). Para Date math/API calls, converter para ISO: `20${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4,6)}` → `2026-04-18`.
- `out_dir`: ex: `data/editions/260418/`

## Processo

### 1. Buscar POTD da Wikimedia (com fallback por elegibilidade)

```bash
curl -sf \
  "https://api.wikimedia.org/feed/v1/wikipedia/en/featured/YYYY/MM/DD" \
  -H "User-Agent: diaria-studio/1.0 (diariaeditor@gmail.com)"
```

Substituir `YYYY/MM/DD` pela data da edição. Do JSON retornado, extrair via `node -e`:
- `image.title`
- `image.description.text`
- `image.thumbnail.source` (URL da thumbnail) e `image.image.source` (URL da imagem cheia, quando disponível)
- `image.artist.text` ou `image.credit.text` (crédito)
- **`image.image.width` e `image.image.height`** — orientação. Fallback: `image.thumbnail.width`/`height`.

**Critérios de elegibilidade** (a imagem do dia deve passar TODOS):

1. **API retornou com sucesso** e `image` existe no payload.
2. **Orientação horizontal** — `width >= height`. Se `height > width` (vertical, ex: 4:5, 3:4, 9:16), rejeitar. A newsletter é paisagem 16:9; imagem vertical quebra o layout.
3. **Não foi usada em edição anterior da Diar.ia.** Manter log em `data/eai-used.json`:
   ```json
   [ { "edition_date": "260418", "title": "File:Example.jpg", "url": "https://..." } ]
   ```
   Rejeitar se `image.title` já aparece no array (comparação case-insensitive por `title`).

Se a imagem do dia **reprovar em qualquer critério**, decrementar 1 dia e tentar de novo. Limite de **7 tentativas** (uma semana para trás). Se esgotar sem encontrar imagem elegível, retornar erro ao orchestrator com detalhes (`{ reason: "no_eligible_potd", tried_dates: [...], rejections: [...] }`).

Registrar cada rejeição em memória para o relatório final (por ex: `{ date: "2026-04-18", reason: "vertical", width: 1200, height: 1500 }`).

### 2. Baixar a foto real e normalizar para 800×450

```bash
curl -sL "{url}" -o "{out_dir}/01-eai-real-raw.jpg"
```

Se `curl` retornar exit code != 0, retornar erro imediatamente — não prosseguir sem imagem.

Após o download, aplicar crop centralizado 16:9 + resize para 800×450 (mesma dimensão da imagem IA):

```bash
# O script eai-compose.ts sorteia qual slot (A ou B) recebe a foto real.
# Nomes finais: 01-eai-A.jpg e 01-eai-B.jpg (nunca real/ia legacy).
npx tsx scripts/crop-resize.ts \
  {out_dir}/01-eai-real-raw.jpg \
  {out_dir}/01-eai-{realSide}.jpg \
  --width 800 --height 450
```

Se o crop falhar, retornar erro. Após sucesso, remover o arquivo raw: `Bash("rm {out_dir}/01-eai-real-raw.jpg")`.

### 2b. Registrar uso no log

Após download bem-sucedido, anexar a imagem escolhida em `data/eai-used.json` via script dedicado (args passados pelo shell — imune a aspas/entidades nos metadados da Wikimedia):

```bash
npx tsx scripts/eai-log-used.ts \
  --edition {AAMMDD} \
  --image-date {image_date} \
  --title "{image_title}" \
  --credit "{credit}" \
  --url "{image_url}"
```

### 3. Gerar versão AI (Gemini)

Criar `{out_dir}/_internal/01-eai-sd-prompt.json` com um prompt fotorrealista que reproduza o mesmo sujeito e cena da POTD — sem estilo artístico, sem Van Gogh. O objetivo é que a imagem gerada seja similar o suficiente para o leitor hesitar, mas diferente o suficiente para revelar a origem ao olhar mais atento.

```json
{
  "positive": "{descrição detalhada da cena: sujeito, ambiente, luz, composição, estilo fotográfico documental — incluir imperfeições reais: poeira, sombras duras, movimento, ângulo candid}",
  "negative": "text, watermark, signature, logo, painting, illustration, drawing, cartoon, anime, cgi, 3d render, oil paint, watercolor, sketch, artistic, stylized, impressionist, brushstrokes, low quality, blurry subject, deformed, warped, border, frame, oversaturated, overexposed, studio backdrop, plain background, symmetrical composition, all subjects facing camera, posed, stock photo",
  "final_width": 800,
  "final_height": 450
}
```

Chamar o gerador:
```bash
node scripts/gemini-image.js \
  {out_dir}/_internal/01-eai-sd-prompt.json \
  {out_dir}/01-eai-{aiSide}.jpg \
  diaria_eai_
```

Se falhar com exit code != 0, retornar erro — não prosseguir sem a imagem IA.

### 4. Escrever `{out_dir}/01-eai.md`

O arquivo contém **apenas a linha de crédito** — sem parágrafos editoriais. O texto de contextualização não aparece na newsletter; a seção É IA? é só as duas imagens + poll + crédito.

Estrutura:
```
É IA?

{descrição em uma frase com links} — [Fotógrafo](https://commons.wikimedia.org/wiki/User:Username) / Licença.
```

Regras da linha de crédito (sem prefixo "Foto:"):
- **Uma frase curta e única** descrevendo a cena — nunca duas frases, nunca explicações enciclopédicas. Apenas identificar o sujeito e o local.
- **Dois links**: (1) apenas a palavra/termo que nomeia o sujeito → artigo na Wikipedia (pt ou en); (2) nome do fotógrafo → página de usuário no Wikimedia Commons.
- Exemplo: `Pastor do [Rajastão](https://pt.wikipedia.org/wiki/Rajastão) guiando seu rebanho pelas planícies do noroeste da Índia — [Paramanu Sarkar](https://commons.wikimedia.org/wiki/User:Paramanu_Sarkar) / CC BY-SA 4.0.`

### 5. Escrever `{out_dir}/_internal/01-eai-meta.json` (#107 dep)

Pra desbloquear o auto-fill do "Resultado da última edição" (#107), gravar arquivo de metadata com a provenance + identificação das imagens. Schema:

```json
{
  "edition": "260424",
  "composed_at": "2026-04-24T19:33:00Z",
  "ai_image_file": "01-eai-ia.jpg",
  "real_image_file": "01-eai-real.jpg",
  "ai_side": null,
  "wikimedia": {
    "title": "File:Example.jpg",
    "image_url": "https://upload.wikimedia.org/...",
    "credit": "Photographer Name / CC BY-SA 4.0",
    "artist_url": "https://commons.wikimedia.org/wiki/User:Username",
    "subject_wikipedia_url": "https://pt.wikipedia.org/wiki/Rajastão",
    "image_date_used": "2026-04-15"
  }
}
```

`ai_side` fica `null` aqui — é preenchido depois pelo `publish-newsletter` quando inserir o Poll/imagens no Beehiiv (sabe se "imagem A é IA" ou "imagem B é IA"). #107 depende desse campo pra calcular % de acerto contra as respostas do Poll.

### 6. (Opcional, #107) Calcular `04-eai-poll-stats.json`

Se o orchestrator já fez fetch das respostas do poll da edição anterior via Beehiiv MCP e gravou em `{out_dir}/_internal/poll-responses.json`, rodar:

```bash
npx tsx scripts/compute-eai-poll-stats.ts --edition {AAMMDD} --responses {out_dir}/_internal/poll-responses.json
```

Output: `{out_dir}/_internal/04-eai-poll-stats.json` com `pct_correct` (ou `null` se `total < threshold`, default 5). O writer do Stage 2 pode ler esse arquivo pra preencher a linha "Resultado da última edição: X% das pessoas acertaram" automaticamente.

Se `poll-responses.json` não existir, o script ainda gera o stats file com `total_responses: 0` e `skipped` apropriado — o writer trata como "Aguardando respostas".

**Quem dispara o fetch das respostas**: orchestrator (tem acesso ao Beehiiv MCP). O eai-composer não chama o MCP — só consome o arquivo se ele existir.

`composed_at` em ISO UTC. `edition` é o `AAMMDD`. Os outros campos vêm direto da Wikimedia API response do passo 1.

## Output

```json
{
  "out_md": "data/editions/260418/01-eai.md",
  "out_real": "data/editions/260418/01-eai-A.jpg",
  "out_ia": "data/editions/260418/01-eai-B.jpg",
  "out_meta": "data/editions/260418/_internal/01-eai-meta.json",
  "image_title": "...",
  "image_credit": "...",
  "image_date_used": "2026-04-15",
  "rejections": [
    { "date": "2026-04-18", "reason": "vertical", "width": 1200, "height": 1500 }
  ]
}
```

> **Nota:** os valores de `out_real` e `out_ia` acima usam A e B como exemplo; o slot real/ia é definido pelo sorteio em `eai-compose.ts` e pode ser A ou B em qualquer edição. Consultar `_internal/01-eai-meta.json` (campo `ai_side`) para saber qual slot contém a imagem IA.

`rejections` é opcional mas deve ser incluído quando houve fallback (dias pulados). `out_meta` aponta pro `_internal/01-eai-meta.json` (passo 5) — orchestrator preserva no resume e `publish-newsletter` lê pra preencher `ai_side` ao inserir as imagens.
