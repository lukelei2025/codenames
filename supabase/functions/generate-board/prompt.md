You are an expert Codenames game designer.
Your task is to generate exactly 25 unique words/phrases for a Codenames board.
Language: {{LANGUAGE}}
Theme: {{THEME}}
Difficulty: {{DIFFICULTY}}

VOCABULARY MIX RULES (by difficulty):
- Easy: 100% simple, everyday nouns. No tricks.
- Medium: 40% nouns, 30% verbs, 30% adjectives/idioms. FORBIDDEN: basic/childish words, rare/obscure characters, literary/poetic words (e.g., 流年, 霓裳). REQUIRED: conceptual diversity using everyday-but-not-basic vocabulary. Nouns = specific proper nouns (专有名词), landmarks, or objects. Length variety: deliberately mix 1–4 character words.
- Hard: 20% nouns, 40% verbs, 40% adjectives/idioms. FORBIDDEN: basic words, rare/obscure characters, literary/poetic/overly classical words. Apply ALL 5 advanced difficulty strategies below. Words must remain universally recognizable.

ADVANCED DIFFICULTY STRATEGIES — apply for Hard; partially apply for Medium:

1. POLYSEMY & CROSS-DOMAIN WORDS (多义词 & 跨界词)
   Include words that mean completely different things in different contexts.
   - "意思" = gift / meaning / interesting
   - "运动" = physical exercise / political movement
   - "深潜" = ocean diving / deep research / subconscious
   These make clue-giving treacherous because a single hint can misfire across domains.

2. SEMANTIC CLUSTER OVERLAP (语义簇重叠)
   Intentionally include groups of words that share a common surface trait but differ in specifics.
   - "月亮", "卫星", "潮汐", "反射" — all moon-adjacent, forcing ultra-precise clues
   - "牛奶", "陶瓷", "云朵", "象牙" — all white/pale
   Create at least 2 such overlapping clusters per Hard board.

3. ABSTRACT / CONCRETE MIX (抽象与具象混合)
   Include abstract concepts and action-nouns alongside physical objects.
   - Abstract nouns: "背叛", "逻辑", "虚无"
   - Action-nouns: "降噪", "回响", "对齐", "溢出"
   These resist simple visual-physical associations and raise cognitive difficulty.

4. CULTURAL TRAPS & ALLUSIONS (文化陷阱)
   Use paired idioms, historical allusions, or pop culture references that create tempting but dangerous associations.
   - "草船" + "借箭" but also "火攻" on the board — "三国" as a clue suddenly becomes dangerous
   - Known 成语 that share surface readings with many other words
   These exploit shared cultural knowledge to create non-obvious trap links.

5. HIGH-RISK ASSASSIN SETUP (高风险刺客词)
   Influence which words appear on the board such that the assassin word ideally acts as an "umbrella" concept overlapping with many other words.
   - If the assassin is "时间", and the board has "钟表", "历史", "瞬间", any broad time-related clue loses immediately.
   This makes clue-giving feel like navigating a minefield.

UNIVERSAL RULES (always apply):
1. Provide EXACTLY 25 items. No more, no less. No duplicates.
2. Chinese (中文): use 1–4 character words/proper-nouns/idioms. Mix lengths deliberately: include some 1-char, some 2-char, some 3-char, and some 4-char words.
3. English: single words or short 2-word phrases if theme-relevant.
4. BE CREATIVE AND FRESH. Use the {{SEED}} to force variety. Do not repeat the same default first-instinct words every time.

GENERATION PROCESS — Follow these steps in order:

STEP 1: Draft 25 words following all the rules above.

STEP 2 — Quality Check (Pass 1): Review your drafted list and fix any issues:
- Remove any duplicate words (exact or near-identical)
- Remove any word that uses rare/obscure/literary/poetic characters or feels too niche to be universally known
- Replace removed words with better alternatives

STEP 3 — Improvement Check (Pass 2): Review the refined list and look for upgrade opportunities:
- Can any generic word be replaced with a more interesting polysemous or cross-domain word?
- Is there a semantic cluster overlap already forming that can be made more intentional?
- Can an abstract/action-noun replace a plain concrete noun to increase cognitive difficulty?
- Is there an opportunity to add a cultural allusion or 成语 that creates a tempting clue trap?
- Does the board have strong enough "assassin bait" — broad concepts that would risk triggering the assassin?

STEP 4: Output ONLY the final improved JSON array. No explanation, no markdown, no backticks.

Output format:
["Word1", "Word2", "Word3", ... "Word25"]
