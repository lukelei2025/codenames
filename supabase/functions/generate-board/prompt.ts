// ============================================================
// CODENAMES WORD GENERATION PROMPT — Single Source of Truth
// Edit here, then redeploy: npx supabase functions deploy generate-board --no-verify-jwt
//
// Runtime variables:
//   {{LANGUAGE}}   → "中文" or "English"
//   {{THEME}}      → User theme or "General / Random"
//   {{DIFFICULTY}} → "简易" / "适中" / "困难"
//   {{SEED}}       → Random integer (1–1,000,000,000) for freshness
// ============================================================

// Map seed ranges to mandatory starting domains to force diversity
function getSeedDomain(seed: number): string {
   const domains = [
      '医学与人体 (anatomy, diseases, medical tools)',
      '航天与天文 (rockets, planets, cosmic phenomena)',
      '法律与犯罪 (legal terms, courtroom, crime types)',
      '建筑与工程 (structures, materials, construction)',
      '音乐与声学 (instruments, genres, acoustic terms)',
      '海洋与航海 (ships, tides, marine creatures)',
      '农业与植物 (crops, farming tools, botany)',
      '军事与战略 (weapons, formations, military ranks)',
      '时尚与纺织 (fabrics, fashion styles, textile techniques)',
      '烹饪与味觉 (flavors, cooking methods, kitchen tools)',
      '数学与几何 (shapes, theorems, mathematical operations)',
      '气象与灾害 (weather, natural disasters, climate)',
      '交通与物流 (vehicles, roads, shipping terms)',
      '体育与格斗 (martial arts, sports equipment, competition)',
      '化学与材料 (elements, reactions, compounds)',
      '心理与梦境 (emotions, cognitive biases, dream symbols)',
      '考古与化石 (artifacts, excavation, ancient cultures)',
      '摄影与光学 (cameras, light, visual techniques)',
      '棋牌与博弈 (game strategies, cards, probability)',
      '神话与传说 (mythical creatures, legends, deities)',
   ]
   return domains[seed % domains.length]
}

// Generate a list of "banned common words" based on seed to prevent repetition
function getBannedWords(seed: number): string {
   const bannedSets = [
      '苹果, 老虎, 天空, 太阳, 月亮, 火车, 钢琴, 巧克力, 足球, 机器人',
      '电脑, 星星, 海洋, 蝴蝶, 书本, 猫咪, 地球, 宇宙, 音乐, 玫瑰',
      '手机, 飞机, 钻石, 森林, 雪花, 沙漠, 暴风, 魔术, 城堡, 大象',
      '冰淇淋, 闹钟, 彩虹, 蜡烛, 镜子, 灯塔, 骆驼, 企鹅, 指南针, 望远镜',
      '小提琴, 降落伞, 水晶, 银行, 密码, 竹子, 橄榄, 珊瑚, 火山, 拼图',
      '铃铛, 烟花, 泡泡, 风筝, 棉花, 琥珀, 蘑菇, 灯笼, 丝绸, 弹弓',
      '锤子, 螺丝, 信封, 绷带, 棋盘, 口哨, 花瓶, 窗帘, 胶带, 药片',
      '扳手, 瓷砖, 墨水, 闪电, 松果, 贝壳, 种子, 气泡, 线索, 拐杖',
      '邮票, 梯子, 齿轮, 弓箭, 杠杆, 陷阱, 标尺, 砝码, 漏斗, 秤盘',
      '钥匙, 帐篷, 绳结, 铁锚, 鱼钩, 网兜, 草帽, 木桩, 石碑, 铜币',
   ]
   return bannedSets[seed % bannedSets.length]
}

function getHardModeCooldownWords(seed: number, count = 8): string[] {
   const pool = [
      '熵', '阈值', '博弈', '悖论', '薛定谔', '囚徒', '潜规则', '灰犀牛',
      '奇点', '图腾', '异化', '红利', '锚定', '阿喀琉斯', '二律背反', '庄家',
      '杠杆', '复盘', '回声', '特洛伊', '峰值', '盲点', '视差', '错觉',
      '背书', '透视', '镀金', '折叠', '显影', '逆熵',
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

export function buildPrompt(language: string, theme: string, difficulty: string, seed: number): string {
   const mandatoryDomain = getSeedDomain(seed)
   const bannedWords = getBannedWords(seed)
   const hasSpecificTheme = !isGenericTheme(theme)
   const hardCooldownWords = difficulty === '困难' && !hasSpecificTheme
      ? getHardModeCooldownWords(seed, 8)
      : []

   // Determine how many words must come from the mandatory domain
   const mandatoryCount = hasSpecificTheme
      ? (difficulty === '困难' ? 3 : difficulty === '适中' ? 2 : 1)
      : (difficulty === '困难' ? 5 : difficulty === '适中' ? 4 : 2)

   const themePriorityBlock = hasSpecificTheme
      ? `═══════════════════════════════════
THEME PRIORITY MODE (Theme is specified)
═══════════════════════════════════
- Theme consistency is a PRIMARY objective for this board.
- At least 70% of words should be clearly theme-relevant.
- The remaining words may be cross-domain for trap quality, but should still feel compatible with the theme.
- If a diversity rule conflicts with theme quality, prioritize theme quality.
`
      : ''

   const themedEntityMin = difficulty === '困难' ? 10 : difficulty === '适中' ? 8 : 5
   const themeEntityRuleBlock = hasSpecificTheme
      ? `═══════════════════════════════════
THEME-SPECIFIC ENTITY DENSITY RULE
═══════════════════════════════════
- Include at least ${themedEntityMin} theme-specific named entities/proper nouns in the 25 words.
- Allowed entity types: person names, work titles, company/organization names, brand/product names, location names, canonical technical terms.
- Example guidance:
  • Movie/Cinema themes: include character names, actor/director names, and film titles.
  • Technology themes: include company names, scientist names, product names, and technical concepts.
- Keep entities mainstream-recognizable; avoid niche-only references.
`
      : ''

   const domainRule = hasSpecificTheme
      ? `At least ${mandatoryCount} of your 25 words SHOULD draw from this seed domain:
→ ${mandatoryDomain}

This is a diversity enhancer, not a hard override. Never let it break theme consistency.`
      : `At least ${mandatoryCount} of your 25 words MUST come from this domain:
→ ${mandatoryDomain}

This is non-negotiable. Start by picking ${mandatoryCount} words from this domain first, then fill the remaining slots from other domains.`

   const hardCooldownBlock = hardCooldownWords.length > 0
      ? `═══════════════════════════════════
HARD MODE COOLDOWN WORDS (Seed-Rotated)
═══════════════════════════════════
For THIS run, do NOT use these over-repeated hard-mode words:
${hardCooldownWords.join(', ')}
`
      : ''

   return `You are an expert Codenames board designer.
Generate exactly 25 unique words/phrases for a Codenames board.

Language: ${language}
Theme: ${theme}
Difficulty: ${difficulty}

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

${hardCooldownBlock}

═══════════════════════════════════
ANTI-REPETITION RULES
═══════════════════════════════════
- Your first instinct for word choices is WRONG. Discard your first 20 candidate words mentally.
- For each word you pick, ask: "Would another AI also pick this?" If yes, REPLACE IT.
- Aim for words that make a player say "哦！这个词有意思" not "又是这个".
- Prefer distinct first characters for Chinese words. Soft cap: at most 2 first-character collisions across the board. If this hurts word quality, prioritize better words.

═══════════════════════════════════
VOCABULARY RULES BY DIFFICULTY
═══════════════════════════════════

### 简易 (Easy)
- 100% everyday nouns recognizable by children.
- No ambiguity, no double meanings, no tricks.

### 适中 (Medium)
Draw from AT LEAST 4 of these 8 domains and MIX them:
  • 专有名词: cities, brands, historical figures, inventions, scientific concepts
  • 技术科技: software/hardware terms, medical devices, chemistry, engineering
  • 体育竞技: sports actions, athlete roles, strategies, equipment
  • 美食文化: dishes, regional cuisines, cooking methods, ingredients
  • 社会心理: psychological states, sociological phenomena, social movements
  • 自然地理: geographic features, weather phenomena, ecosystems, flora/fauna
  • 经济金融: financial instruments, market mechanisms, economic phenomena
  • 精确动词: action verbs with double-reading potential across contexts

Word ratio: ~40% nouns, 30% verbs, 30% adj/idioms.
FORBIDDEN: basic/childish words.
Length variety: prioritize 2-char, 3-char, and 4-char words; include 1-char words only when semantically strong (0-3 items max).

### 困难 (Hard)
Draw from AT LEAST 5 of these 8 domains and MIX them:
  • 跨学科术语: terms borrowed across fields (e.g. a physics term also used in music)
  • 哲学认知: cognitive biases, epistemological concepts, philosophical schools
  • 行业黑话: jargon from tech/finance/law/military that entered colloquial use
  • 历史典故及神话: literary allusions, historical events, cultural symbols, mythology
  • 心理行为: psychological phenomena with everyday emotional resonance
  • 社会政治: social movements, political science concepts, ideological terms
  • 数学逻辑: mathematical concepts with rich everyday metaphorical meaning
  • 多义成语: 成语 or idioms with high semantic ambiguity

Word ratio: ~30% nouns, 30% verbs, 40% adj/idioms.
FORBIDDEN: basic everyday words; jargon only PhDs know.
Length variety: prioritize 2-char, 3-char, and 4-char words; allow 1-char words only when high-signal and strategically valuable (0-2 items max).

═══════════════════════════════════
HARD MODE STRATEGIES (ALL for 困难; partially for 适中)
═══════════════════════════════════
1. POLYSEMY: Include words with different meanings in different fields.
2. SEMANTIC TRAPS: Plant 3-4 words sharing a surface trait across different teams. Build ≥2 traps.
3. ABSTRACT/CONCRETE MIX: Blend abstract concepts with physical objects.
4. CULTURAL TRAPS: Use 成语/allusions that create tempting but dangerous clue connections.
5. ASSASSIN BAIT: One word so broad that many safe clues accidentally match it.

═══════════════════════════════════
CONSTRAINT PRIORITY (when rules conflict)
═══════════════════════════════════
1. Output EXACTLY 25 UNIQUE, high-quality words.
2. Output must be strictly parseable JSON after the marker.
3. Satisfy difficulty/style constraints as much as possible.
4. Heuristic distribution rules (first-character uniqueness, ratio, length mix) are secondary and may be relaxed to preserve word quality.

═══════════════════════════════════
GENERATION PROCESS & CHECKING MECHANISM
═══════════════════════════════════
Follow these steps in your reasoning.

STEP 1 (Drafting): Draft high-quality initial words in your head. Keep exploration concise.
STEP 2 (Quality Check): Remove duplicates or obscure characters.
STEP 3 (Improvement Check): Swap generic words for polysemous ones.
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
