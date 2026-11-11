---
name: diaria-mandala-semana
description: Preenche o formulário semanal (Tally, janela de 24h) do Desafio Mandala Mão na Massa para o perfil @diar.ia.br — lê as datas do próprio formulário, monta os links de cada dia (1º post do dia no Instagram, em BRT), os extras, os novos seguidores e a planilha da semana, mostra tudo ao editor e preenche o Tally pelo Claude in Chrome, parando antes de enviar. Uso — `/diaria-mandala-semana <url-tally> [--semana N]`.
---

# /diaria-mandala-semana (#12347)

Formulário semanal do Desafio Mandala Mão na Massa. A estrutura é sempre a
mesma (13 perguntas); mudam a URL e as datas. Standalone: não encadeia nada.

**Argumento obrigatório:** a URL do Tally da semana (muda toda semana, nunca
fica no repo). Sem ela, pedir ao editor.

**Ordem fixa (decisão do editor, 06/11/2026):** coletar tudo, mostrar o
resumo, e só então preencher. Nunca responder pergunta do formulário para
descobrir datas: elas vêm do HTML.

## Regras do editor

- Perfil do desafio: @diar.ia.br. Rede: **Ambos** (Instagram e YouTube).
- Link de cada dia = **1º conteúdo publicado no dia no Instagram**, dia em BRT.
  Inclui os reels em collab do @vjpixel que aparecem no grid do @diar.ia.br.
- Extras = todos os demais posts do período, um link por linha.
- Novos seguidores = bruto (sem descontar quem deixou de seguir).
- Print da aba Insights do Instagram no período é obrigatório.
- E-mail e telefone do grupo ficam FORA do repo, em
  `~/.config/diaria/mandala-contato.json` (`{"email": "...", "telefone": "..."}`).
- A coleta usa só API oficial e dados locais. Nada de raspar o grid do
  Instagram, decodificar shortcode nem ler o Business Suite por automação
  (regra de ToS do `CLAUDE.md`; comentário de 06/11 na issue).

## Passo 1 — dados que só o editor tem

Fazer uma única bateria de `AskUserQuestion` (com opção sugerida em cada
pergunta), só com o que falta:

1. **Collabs do @vjpixel na semana.** A Graph API do @diar.ia.br não devolve
   reels em collab publicados pelo @vjpixel (medido em 11/11/2026). Perguntar
   se houve algum e, para cada um, o link e o horário de publicação (BRT).
   Opção sugerida: "não houve collab nesta semana".
2. **Print de Insights.** Pedir o(s) arquivo(s) do print da aba Insights
   (Resultados e Público → Tendências no período). Se o editor colar o
   caminho, usar; se preferir, ele salva em
   `data/desafio-mandala/semana{N}-prints/` e o script acha sozinho. Lembrar
   que o Business Suite mostra as datas no horário do Pacífico.
3. **Contato, só na 1ª vez:** se `~/.config/diaria/mandala-contato.json` não
   existir ou estiver incompleto, perguntar e-mail do Fluxer e telefone do
   grupo e gravar o arquivo com `Write` (fora do repo, nunca em `data/`).

Antes da bateria, dizer quantas perguntas são.

## Passo 2 — montar os dados

Rodar a partir do checkout principal (é onde estão `.env` e `data/`):

    npx tsx scripts/mandala-semana.ts --tally-url <url> --collab <link>@<AAAA-MM-DDTHH:MM> --print <arquivo>

`--collab` e `--print` repetem uma vez por item; omitir se não houver.
`--semana N` só se o título do formulário não trouxer "Semana N".

O script:

- baixa o HTML do Tally e lê as perguntas "Link do conteúdo do dia N (DD/MM)"
  e o "período de DD/MM até DD/MM";
- lista os posts do @diar.ia.br pela Graph API (`/media`) e escolhe o 1º de
  cada dia em BRT; os outros viram extras;
- soma os novos seguidores do Instagram (série bruta
  `data/metrics/instagram-follows-daily.jsonl`, #12348) e os inscritos do
  YouTube (`data/youtube-analytics/channel-daily.jsonl`);
- grava `data/desafio-mandala/semana{N}.csv` (planilha da semana: dia, hora
  BRT, conta, formato, link, onde entrou no formulário, início do texto) e
  `data/desafio-mandala/semana{N}.json` (plano, com `missing[]`).

Saídas:

- **exit 2**: o HTML não trouxe as perguntas (o Tally mudou o formato). Abrir o
  formulário no Chrome só para LER as perguntas (sem responder), passar as
  datas ao editor e parar.
- **exit 1**: erro de uso ou de rede; mostrar a mensagem e parar.
- **exit 0**: ler `semana{N}.json`. Cada item de `missing[]` é dito ao editor
  como falta, nunca preenchido com chute. Se `postsSource` for `local`, a
  Graph API falhou: a lista vem dos registros locais de publicação, sem os
  carrosséis agendados pelo Worker, então o 1º de cada dia pode estar errado.
  Dizer isso e pedir ao editor que confira ou que resolva o token antes de
  seguir.

## Passo 3 — resumo para o editor

Mostrar, num bloco só:

- semana e período;
- os 7 links por dia (dia N, data, hora BRT, conta, link);
- os extras (quantidade + lista);
- novos seguidores: Instagram (bruto ou, se a série falhou, saldo líquido,
  com o aviso) + YouTube = total que vai na pergunta 12;
- prints que vão no upload;
- caminho da planilha CSV;
- tudo o que está em `missing[]`.

Perguntar uma vez se pode preencher (opções: "preencher assim", "corrigir
antes"). Na correção, ajustar os argumentos e rodar o Passo 2 de novo.

## Passo 4 — preencher o Tally (Claude in Chrome)

Uso humano e de baixo volume, na sessão do editor, permitido pela regra de
ToS do `CLAUDE.md`. Se o MCP do Chrome não responder, halt banner (#738) e
parar.

1. `tabs_context_mcp`, abrir a URL numa aba do grupo MCP.
2. O Tally mostra uma pergunta por tela e o campo já vem com foco. **Ler o
   texto de cada pergunta e casar pelo conteúdo, nunca pela posição** (a
   numeração pode mudar):
   - "e-mail do FLUXER" → `contato.email`;
   - "telefone de contato no grupo" → `contato.telefone`;
   - "Para qual rede" → clicar no label "Ambos";
   - "Link do conteúdo do dia N (DD/MM)" → o `url` do dia N em `daily[]`
     (casar pelo N e pela data; se o dia estiver sem link, parar e perguntar);
   - "conteúdos extras" → `extras[]`, um por linha (no textarea, Shift+Enter
     entre linhas; Enter avança);
   - "seguidores ou inscritos novos" → `newFollowers.total`;
   - "print da aba de Insights" → upload dos arquivos de `prints[]` com o
     `file_upload` do Chrome. Se o upload for bloqueado, pedir ao editor que
     anexe à mão e esperar o "pronto".
3. Digitar e avançar com Enter em todas as perguntas **menos na última**: na
   tela final, nunca apertar Enter (na semana 2 o formulário saiu enviado antes
   do "sim").
4. Na tela com o botão "Enviar respostas": tirar um screenshot, mostrar ao
   editor o que foi preenchido e **parar**. Só clicar em "Enviar respostas"
   depois do "sim" explícito dele nesta conversa. Silêncio não é sim.
5. Depois de enviar, confirmar pela tela de agradecimento e dizer onde ficou a
   planilha.

Voltar uma tela no Tally preserva os uploads; usar isso para corrigir.
