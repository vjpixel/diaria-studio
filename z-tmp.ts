import { tokenizeForJaccard as t, jaccardSimilarity as j, thresholdForPair as th } from "./scripts/lib/title-similarity.ts";
const P = "OpenAI lança novo modelo de raciocínio para desenvolvedores";
for (const c of ["OpenAI lança novo modelo de raciocínio para empresas", "Modelo de raciocínio da OpenAI chega aos desenvolvedores agora", "Google apresenta ferramenta de agentes para empresas e desenvolvedores", "OpenAI lança novo modelo de raciocínio para desenvolvedores brasileiros"]) console.log(c, j(t(c), t(P)), th(c, P, 0.6, 0.55));
