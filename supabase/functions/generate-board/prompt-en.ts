// ============================================================
// CODENAMES WORD GENERATION PROMPT — ENGLISH MODE
// ============================================================

function getSeedDomainEn(seed: number): string {
  const domains = [
    'medicine and anatomy (organs, symptoms, medical tools)',
    'space and astronomy (planets, missions, celestial phenomena)',
    'law and crime (courtroom terms, legal concepts, offense types)',
    'architecture and engineering (structures, materials, construction terms)',
    'music and acoustics (instruments, genres, sound concepts)',
    'ocean and navigation (ships, marine life, navigation terms)',
    'agriculture and botany (crops, farming methods, plant science)',
    'military and strategy (tactics, ranks, doctrine, equipment)',
    'fashion and textiles (fabrics, styles, manufacturing methods)',
    'cooking and flavor (techniques, ingredients, kitchen tools)',
    'math and geometry (concepts, operations, geometric terms)',
    'weather and disasters (climate, storms, natural hazards)',
    'transport and logistics (vehicles, routes, supply chain terms)',
    'sports and competition (roles, actions, strategies, equipment)',
    'chemistry and materials (elements, compounds, reactions)',
    'psychology and cognition (biases, states, mental models)',
    'archaeology and ancient history (artifacts, civilizations, excavation)',
    'photography and optics (camera terms, light behavior, lens concepts)',
    'games and probability (cards, board games, decision terms)',
    'myth and folklore (figures, symbols, narrative motifs)',
  ]
  return domains[seed % domains.length]
}

function getBannedWordsEn(seed: number): string {
  const bannedSets = [
    'apple, tiger, sky, sun, moon, train, piano, chocolate, soccer, robot',
    'computer, star, ocean, butterfly, book, cat, earth, universe, music, rose',
    'phone, airplane, diamond, forest, snowflake, desert, storm, castle, elephant, magic',
    'rainbow, candle, mirror, lighthouse, camel, penguin, compass, telescope, clock, puzzle',
    'violin, parachute, crystal, bank, password, bamboo, coral, volcano, ladder, ink',
    'bell, fireworks, bubble, kite, cotton, mushroom, lantern, silk, slingshot, envelope',
    'hammer, screw, bandage, whistle, vase, curtain, tape, tablet, wrench, tile',
    'lightning, pinecone, shell, seed, cane, stamp, gear, bow, lever, trap',
    'ruler, weight, funnel, key, tent, knot, anchor, hook, net, strawhat',
    'stake, stele, coin, helmet, torch, wheel, bridge, bucket, needle, shovel',
  ]
  return bannedSets[seed % bannedSets.length]
}

function getHardModeCooldownWordsEn(seed: number, count = 8): string[] {
  const pool = [
    'entropy', 'threshold', 'game theory', 'paradox', 'singularity', 'black swan', 'grey rhino', 'path dependence',
    'cognitive dissonance', 'meme', 'framing effect', 'prisoner dilemma', 'anchor bias', 'opportunity cost',
    'hysteresis', 'feedback loop', 'phase shift', 'blind spot', 'asymmetry', 'tradeoff',
    'equilibrium', 'leverage', 'resonance', 'signal', 'noise', 'latency', 'drift', 'bias', 'variance', 'friction',
  ]

  const start = seed % pool.length
  const selected: string[] = []
  for (let i = 0; i < count; i++) {
    selected.push(pool[(start + i) % pool.length])
  }
  return selected
}

function getMediumModeCooldownWordsEn(seed: number, count = 8): string[] {
  const pool = [
    'algorithm', 'pixel', 'firewall', 'bubble', 'monopoly', 'radar', 'resonance', 'chip',
    'inflation', 'leverage', 'iteration', 'hedge', 'blind spot', 'feedback', 'signal', 'noise',
    'filter', 'overfit', 'tradeoff', 'bandwidth', 'gravity', 'eclipse', 'momentum', 'threshold',
    'protocol', 'benchmark', 'synergy', 'ecosystem', 'backlog', 'pipeline',
  ]

  const start = seed % pool.length
  const selected: string[] = []
  for (let i = 0; i < count; i++) {
    selected.push(pool[(start + i) % pool.length])
  }
  return selected
}

function isGenericTheme(theme: string): boolean {
  const t = theme.trim().toLowerCase()
  return (
    t.length === 0 ||
    t === 'general / random' ||
    t === 'general' ||
    t === 'random' ||
    t === '通用' ||
    t === '随机' ||
    t === '综合'
  )
}

export function buildPromptEn(language: string, theme: string, difficulty: string, seed: number): string {
  const mandatoryDomain = getSeedDomainEn(seed)
  const bannedWords = getBannedWordsEn(seed)
  const hasSpecificTheme = !isGenericTheme(theme)
  const hardCooldownWords = difficulty === '困难' && !hasSpecificTheme
    ? getHardModeCooldownWordsEn(seed, 8)
    : []
  const mediumCooldownWords = difficulty === '适中' && !hasSpecificTheme
    ? getMediumModeCooldownWordsEn(seed, 8)
    : []

  const mandatoryCount = hasSpecificTheme
    ? (difficulty === '困难' ? 3 : difficulty === '适中' ? 2 : 1)
    : (difficulty === '困难' ? 5 : difficulty === '适中' ? 4 : 2)

  const themedEntityMin = difficulty === '困难' ? 10 : difficulty === '适中' ? 8 : 5

  const themePriorityBlock = hasSpecificTheme
    ? `═══════════════════════════════════
THEME PRIORITY MODE
═══════════════════════════════════
- Theme consistency is a PRIMARY objective for this board.
- At least 70% of words should be clearly theme-relevant.
- Remaining words may be cross-domain for trap quality, but should still fit the theme.
- If a diversity rule conflicts with theme quality, prioritize theme quality.
`
    : ''

  const themeEntityRuleBlock = hasSpecificTheme
    ? `═══════════════════════════════════
THEME-SPECIFIC ENTITY DENSITY RULE
═══════════════════════════════════
- Include at least ${themedEntityMin} theme-specific named entities/proper nouns in the 25 words.
- Allowed entity types: person names, work titles, company/organization names, brand/product names, location names, canonical technical terms.
- Example guidance:
  - Movie/Cinema themes: include character names, actor/director names, and film titles.
  - Technology themes: include company names, scientist names, product names, and technical concepts.
- Keep entities mainstream-recognizable; avoid niche-only references.
`
    : ''

  const domainRule = hasSpecificTheme
    ? `At least ${mandatoryCount} of your 25 words SHOULD draw from this seed domain:
-> ${mandatoryDomain}

This is a diversity enhancer, not a hard override. Never let it break theme consistency.`
    : `At least ${mandatoryCount} of your 25 words MUST come from this domain:
-> ${mandatoryDomain}

This is non-negotiable. Start by picking ${mandatoryCount} words from this domain first, then fill the remaining slots from other domains.`

  const hardCooldownBlock = hardCooldownWords.length > 0
    ? `═══════════════════════════════════
HARD MODE COOLDOWN WORDS (Seed-Rotated)
═══════════════════════════════════
For THIS run, avoid these over-repeated hard-mode anchors:
${hardCooldownWords.join(', ')}
`
    : ''

  const mediumCooldownBlock = mediumCooldownWords.length > 0
    ? `═══════════════════════════════════
MEDIUM MODE COOLDOWN WORDS (Seed-Rotated)
═══════════════════════════════════
For THIS run, avoid these over-repeated medium-mode anchors:
${mediumCooldownWords.join(', ')}
`
    : ''

  const mediumAnchorClusterRule = difficulty === '适中'
    ? `- MEDIUM anchor cluster cap: from [algorithm, pixel, firewall, bubble, monopoly, radar, resonance, chip, inflation, leverage], include AT MOST 1 term.`
    : ''

  const hardAnchorClusterRule = difficulty === '困难'
    ? `- HARD anchor cluster cap: from [entropy, path dependence, cognitive dissonance, broken window, paradigm shift, grey rhino, black swan, meme], include AT MOST 1 term.`
    : ''

  return `You are an expert Codenames board designer.
Generate exactly 25 unique words/phrases for a Codenames board.

Language: ${language}
Theme: ${theme}
Difficulty: ${difficulty}

═══════════════════════════════════
LANGUAGE HARD CONSTRAINT
═══════════════════════════════════
- Output language MUST be ENGLISH ONLY.
- Every item must use only English letters, numbers, spaces, hyphen(-), or apostrophe(').
- Do NOT output any Chinese characters.
- If any non-English token appears, replace it before final output.

${themePriorityBlock}
${themeEntityRuleBlock}

═══════════════════════════════════
MANDATORY STARTING DOMAIN (Seed: ${seed})
═══════════════════════════════════
${domainRule}

═══════════════════════════════════
BANNED WORDS — DO NOT USE THESE
═══════════════════════════════════
The following words are BANNED for this session. Do NOT output any of them:
${bannedWords}

${mediumCooldownBlock}
${hardCooldownBlock}

═══════════════════════════════════
ANTI-REPETITION RULES
═══════════════════════════════════
- Your first instinct for word choices is WRONG. Discard your first 20 candidate words mentally.
- For each word you pick, ask: "Would another AI also pick this?" If yes, REPLACE IT.
- Prefer semantic freshness over obvious defaults.
${mediumAnchorClusterRule}
${hardAnchorClusterRule}

═══════════════════════════════════
VOCABULARY RULES BY DIFFICULTY
═══════════════════════════════════

### 简易 (Easy)
- Use only everyday, concrete nouns recognizable by children.
- No ambiguity, no double meanings, no trick words.

### 适中 (Medium)
Draw from AT LEAST 4 of these 8 domains and MIX them:
  - Proper nouns: cities, brands, historical figures, inventions, scientific concepts
  - Tech/science: software/hardware terms, medical devices, chemistry, engineering
  - Sports: actions, athlete roles, strategies, equipment
  - Food/culture: dishes, cuisines, methods, ingredients
  - Social/psychology: states, phenomena, social behaviors
  - Nature/geography: landforms, weather, ecosystems, species
  - Economy/finance: instruments, mechanisms, market phenomena
  - Precise verbs: actions with potential multi-context interpretation

Word ratio target: ~40% nouns, 30% verbs, 30% adj/idiomatic terms.
FORBIDDEN: childish/basic words.
Length mix: mostly 1-2 words per item; avoid long phrases.

### 困难 (Hard)
Draw from AT LEAST 5 of these 8 domains and MIX them:
  - Cross-disciplinary terms used across different fields
  - Philosophy/cognition concepts and bias terms
  - Industry jargon that entered common conversation
  - Historical/myth/cultural allusion terms
  - Psychological behavior terms with real-life resonance
  - Socio-political science concepts
  - Math/logic terms with metaphorical usage
  - Polysemous idiomatic terms

Word ratio target: ~30% nouns, 30% verbs, 40% adj/idiomatic terms.
FORBIDDEN: basic words and ultra-obscure expert-only jargon.
Length mix: mostly compact terms; avoid long phrases.

═══════════════════════════════════
HARD MODE STRATEGIES (ALL for 困难; partial for 适中)
═══════════════════════════════════
1. POLYSEMY: include words with distinct meanings across contexts.
2. SEMANTIC TRAPS: create 3-4 tempting overlaps across different teams.
3. ABSTRACT/CONCRETE MIX: blend conceptual and physical terms.
4. CULTURAL TRAPS: use recognizable references that tempt wrong clues.
5. ASSASSIN BAIT: include one broad word that can accidentally attract many clues.

═══════════════════════════════════
CONSTRAINT PRIORITY (when rules conflict)
═══════════════════════════════════
1. Output EXACTLY 25 UNIQUE, high-quality words.
2. Output must be strictly parseable JSON after the marker.
3. Enforce English-only output.
4. Satisfy difficulty/style constraints as much as possible.

═══════════════════════════════════
GENERATION PROCESS & CHECKING MECHANISM
═══════════════════════════════════
Follow these steps in your reasoning.

STEP 1 (Drafting): Draft high-quality initial words in your head. Keep exploration concise.
STEP 2 (Quality Check): Remove duplicates, obvious, or low-signal words.
STEP 3 (Language Check): Remove any non-English or malformed tokens.
STEP 4 (Final Count): You MUST confirm EXACTLY 25 words before outputting.

═══════════════════════════════════
OUTPUT FORMAT & TIME LIMIT
═══════════════════════════════════
CRITICAL: Output exactly this marker: ===JSON_START=== on a new line, followed IMMEDIATELY by ONLY the raw JSON array.
No markdown code blocks, no explanation, no greeting. Just the marker and the array. After the closing ], stop output immediately.

===JSON_START===
["Word1", "Word2", "Word3", ... "Word25"]
`
}
