const fetch = require('node-fetch');

async function test() {
  const apiKey = '8fac929e85b94e3db0871f274fa69241.FLZ79Fqn7GHugvJa';
  
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'glm-4.7',
      stream: true,
      messages: [
        {
          role: 'user',
          content: "You are an expert Codenames game designer. Your task is to generate exactly 25 unique words/phrases for a Codenames board.\n\nLanguage: 中文\nTheme: Random\nDifficulty: 适中\n\n═══════════════════════════════════\nMANDATORY STARTING DOMAIN (Seed: 42)\n═══════════════════════════════════\nAt least 5 of your 25 words MUST come from this domain:\n→ Science\n\nThis is non-negotiable. Start by picking 5 words from this domain first, then fill the remaining slots from other domains.\n\n═══════════════════════════════════\nGENERATION PROCESS & CHECKING MECHANISM\n═══════════════════════════════════\nWARNING: You will be killed by a 50-second timeout if your reasoning is too long.\nYour entire thinking process MUST BE UNDER 100 WORDS. \nDo not explain your steps thoroughly. Just output a few bullet points confirming you did the checks, then STOP thinking and output the final array.\n\nSTEP 1 (Drafting): Draft initial words in your head.\nSTEP 2 (Quality Check): Remove duplicates or obscure characters.\nSTEP 3 (Improvement Check): Swap generic words for polysemous ones.\nSTEP 4 (Final Count): You MUST confirm EXACTLY 25 words before outputting.\n\n═══════════════════════════════════\nOUTPUT FORMAT & TIME LIMIT\n═══════════════════════════════════\nCRITICAL: Output exactly this marker: ===JSON_START=== on a new line, followed IMMEDIATELY by ONLY the raw JSON array.\nNo markdown code blocks, no explanation, no greeting. Just the marker and the array.\n\n===JSON_START===\n[\"Word1\", \"Word2\", \"Word3\", ... \"Word25\"]"
        }
      ]
    })
  });

  const reader = res.body;
  reader.on('data', chunk => {
    console.log("CHUNK:", chunk.toString());
  });
  reader.on('end', () => {
    console.log("STREAM ENDED");
  });
}

test();
