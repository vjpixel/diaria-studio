# Texto da campanha Apoia.se — exemplos, enquadramento e cumulatividade (#8498, Parte 2)

Ação do editor no painel do Apoia.se (não é código). Tempo estimado: ~5 min
(colar 4 trechos). O texto abaixo está pronto pra colar; as recompensas ficam
em **Recompensas** e o texto de abertura em **Sobre a campanha**.

## Estado real da campanha (lido em 20/09/2026 pela API pública `apoia.se/api/v1/users/diaria`)

- `status: "published"`, `slug: "diaria"`. A campanha existe e está publicada
  segundo a API (ver a ressalva de verificação no PR: o HTML de `apoia.se/diaria`
  é uma casca Angular idêntica pra QUALQUER slug — `curl` no HTML não prova que
  a campanha renderiza; só o navegador prova).
- **2.3 (cumulatividade) já está resolvida no texto atual:** Mantenedor e
  Patrono já dizem "Tudo dos planos anteriores, mais:". Não precisa mexer.
- **2.4 (Amigo/Patrono sem conteúdo) já está resolvida:** Amigo tem "Nome na
  página…"; Patrono tem 5 benefícios listados. Não precisa mexer.
- **Falta de fato:** 2.1 (exemplos colados nas recompensas) e 2.2 (enquadramento
  "diária sempre gratuita" abrindo a campanha). 2.5 é opcional.
- Divergência de nomenclatura a decidir (não bloqueia): a campanha chama o
  benefício do Mantenedor de **"Retrospectiva do Mês"** (o texto da issue usa
  "Panorama do Mês"); a página de nomes se chama "Quem torna a Diar.ia possível"
  na recompensa e "Apoiadores(as)" no texto de abertura. Usei "Retrospectiva do
  Mês" abaixo, que é o nome que já está na campanha e no site.

## 2.2 — Abertura da campanha (colar NO INÍCIO de "Sobre a campanha")

```
A edição diária da diar.ia.br é e sempre será gratuita. Quem quiser apoiar a curadoria financia o trabalho e ganha benefícios extras — nunca o contrário. Apoiar não é assinar: a newsletter diária nunca fica atrás de paywall, com ou sem apoio.
```

(Em seguida vem o parágrafo que já existe: "A diar.ia.br é uma newsletter gratuita sobre inteligência artificial…".)

## 2.1 — Exemplos públicos colados sob cada recompensa

Todos verificados com `curl` (User-Agent de navegador) em 20/09/2026, HTTP 200.
São só teasers públicos — nenhum link leva a conteúdo completo atrás de gate.

### Recompensa Apoiador (R$ 10) — acrescentar ao final da descrição

```
Veja um exemplo: "Engenharia de ilusão: jailbreak de IA não tem senha secreta" → https://especial.diar.ia.br/2026/engenharia-de-ilusao/
Outros artigos: https://especial.diar.ia.br/
```

Alternativa de exemplo (também 200): "O agente da OpenAI que atacou a Hugging Face sozinho" → https://especial.diar.ia.br/2026/o-agente/

### Recompensa Mantenedor (R$ 25) — acrescentar ao final da descrição

```
Veja um exemplo: Retrospectiva de agosto/2026 ("Agentes de IA viram os invasores") → https://retrospectiva.diar.ia.br/2608
```

(O teaser abre o resumo do mês e uma seção inteira antes do corte; o restante
é do gate do Mantenedor.)

## 2.5 (opcional) — Cadência e volume como prova

Colar depois do parágrafo de abertura, se o editor quiser:

```
Desde 27/08/2025, a diar.ia.br sai de segunda a sexta, todo dia às 6h, sem interrupção — mais de 270 edições publicadas no acervo público: https://diar.ia.br/archive
```

Conferir o número de edições antes de colar (270 é a medição de 18/09/2026 do
#8353; cresce ~5 por semana).

## 2.6 — Coordenar com o #7658 antes de reforçar a exclusividade

O gate web da Retrospectiva libera a partir de R$ 10 enquanto a campanha vende
como R$ 25+ (Mantenedor). Não reforce a exclusividade da Retrospectiva no texto
até o #7658 alinhar as duas pontas.

## Depois de colar

1. Abrir `https://apoia.se/diaria` numa janela anônima (deslogado) e confirmar
   que a campanha renderiza (é o que o `curl` não consegue provar).
2. Só então fazer o deploy manual do Worker `site` (é do editor): `/apoiar` deve
   responder 301 pro Apoia.se e o item "Apoiar" do menu passa por `/apoiar/ir`.
