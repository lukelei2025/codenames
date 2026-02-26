import "@supabase/functions-js/edge-runtime.d.ts"
import { buildPrompt } from './prompt.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type RecentBoardRecord = { words: string[]; ts: number }
const recentBoardsByBucket = new Map<string, RecentBoardRecord[]>()
const RECENT_HISTORY_LIMIT_PER_BUCKET = 20
const RECENT_LOOKBACK_BOARDS = 12
const HOT_WORD_MIN_COUNT = 2
const HOT_WORD_MAX_COUNT = 12
const MEDIUM_ANCHOR_CLUSTER = ['发酵', '潮汐', '偏见', '内卷', '熵增', '悖论', '杠杆', '防火墙', '算法', '像素']
const HARD_ANCHOR_CLUSTER = ['熵增', '路径依赖', '认知失调', '破窗效应', '范式转移', '灰犀牛', '黑天鹅', '模因']

const normalizeThemeBucket = (theme: string): string => {
  const raw = (theme || '').trim().toLowerCase()
  if (!raw || raw === 'general / random' || raw === 'general' || raw === 'random' || raw === '通用' || raw === '随机' || raw === '综合') {
    return '__generic__'
  }
  return raw
}

const makeHistoryBucketKey = (language: string, difficulty: string, theme: string): string =>
  `${language}::${difficulty}::${normalizeThemeBucket(theme)}`

const readRecentBoards = (bucketKey: string): string[][] =>
  (recentBoardsByBucket.get(bucketKey) ?? []).slice(-RECENT_LOOKBACK_BOARDS).map((r) => r.words)

const addBoardToRecentMemory = (bucketKey: string, words: string[]) => {
  const board = words.slice(0, 25)
  if (board.length < 25) return
  const list = recentBoardsByBucket.get(bucketKey) ?? []
  list.push({ words: board, ts: Date.now() })
  while (list.length > RECENT_HISTORY_LIMIT_PER_BUCKET) list.shift()
  recentBoardsByBucket.set(bucketKey, list)
}

const jaccard = (aWords: string[], bWords: string[]): number => {
  const a = new Set(aWords)
  const b = new Set(bWords)
  let overlap = 0
  for (const w of a) if (b.has(w)) overlap += 1
  const union = a.size + b.size - overlap
  return union === 0 ? 0 : overlap / union
}

const maxJaccardAgainstRecent = (words: string[], recentBoards: string[][]) => {
  let maxJaccard = 0
  let mostSimilar: string[] | null = null
  for (const board of recentBoards) {
    const score = jaccard(words, board)
    if (score > maxJaccard) {
      maxJaccard = score
      mostSimilar = board
    }
  }
  return { maxJaccard, mostSimilar }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { theme = '', language = '中文', difficulty = '适中', responseMode = 'stream' } = await req.json()

    const glmApiKey = Deno.env.get('GLM_API_KEY')
    if (!glmApiKey) throw new Error('GLM_API_KEY is not set')

    const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? ''
    const rawDeepseekApiUrl = (Deno.env.get('DEEPSEEK_API_URL') ?? '').trim()
    const deepseekApiUrl = rawDeepseekApiUrl
      ? (rawDeepseekApiUrl.replace(/\/+$/, '').endsWith('/chat/completions')
        ? rawDeepseekApiUrl.replace(/\/+$/, '')
        : `${rawDeepseekApiUrl.replace(/\/+$/, '')}/chat/completions`)
      : 'https://api.deepseek.com/chat/completions'
    const deepseekModel = Deno.env.get('DEEPSEEK_MODEL') ?? 'deepseek-chat'

    const seed = Math.floor(Math.random() * 1_000_000_000)
    const systemPrompt = buildPrompt(language, theme || 'General / Random', difficulty, seed)
    const historyBucketKey = makeHistoryBucketKey(language, difficulty, theme || 'General / Random')
    const recentBoards = readRecentBoards(historyBucketKey)
    const recentWordFreq = new Map<string, number>()
    for (const board of recentBoards) {
      for (const w of board) {
        recentWordFreq.set(w, (recentWordFreq.get(w) ?? 0) + 1)
      }
    }
    const recentHotWords = [...recentWordFreq.entries()]
      .filter(([, count]) => count >= HOT_WORD_MIN_COUNT)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, HOT_WORD_MAX_COUNT)
      .map(([word]) => word)

    console.log(`Generating board: theme=${theme}, lang=${language}, diff=${difficulty}, seed=${seed}`)

    const isEasy = difficulty === '简易'
    const isMedium = difficulty === '适中'
    const isHard = difficulty === '困难'
    const anchorCluster = isMedium ? MEDIUM_ANCHOR_CLUSTER : isHard ? HARD_ANCHOR_CLUSTER : []

    // Primary model: GLM-4.7; fallback model: DeepSeek (optional)
    const primaryModel = 'glm-4.7'
    const glmApiUrl = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
    const runStartedAt = Date.now()

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const isRetryableStatus = (status: number) =>
      status === 408 || status === 429 || status >= 500

    type ProviderName = 'glm' | 'deepseek'
    type ProviderConfig = { name: ProviderName; apiUrl: string; apiKey: string; model: string }
    type RequestError = Error & {
      status?: number
      retryable?: boolean
      kind?: 'http' | 'exception'
      bodySnippet?: string
    }
    type RequestResult = {
      response: Response
      attempts: number
      retryCount: number
      elapsedMs: number
      provider: ProviderName
      model: string
      usedFallback: boolean
    }

    const primaryProvider: ProviderConfig = {
      name: 'glm',
      apiUrl: glmApiUrl,
      apiKey: glmApiKey,
      model: primaryModel,
    }
    const fallbackProvider: ProviderConfig | null = deepseekApiKey
      ? {
        name: 'deepseek',
        apiUrl: deepseekApiUrl,
        apiKey: deepseekApiKey,
        model: deepseekModel,
      }
      : null

    const shouldTriggerFallback = (err: unknown): boolean => {
      const e = err as RequestError
      if (e?.status === 408 || e?.status === 429) return true
      if (typeof e?.status === 'number' && e.status >= 500) return true
      return e?.kind === 'exception'
    }

    const requestProviderWithRetry = async (
      payload: Record<string, unknown>,
      provider: ProviderConfig,
      options: { label: string; retries: number; requireBody?: boolean },
    ): Promise<{ response: Response; attempts: number; retryCount: number; elapsedMs: number }> => {
      const retryDelaysMs = [1200, 2500, 4500]
      const requestStartedAt = Date.now()
      const providerPayload = { ...payload, model: provider.model }

      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          const res = await fetch(provider.apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${provider.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(providerPayload),
          })

          if (res.ok && (!options.requireBody || res.body)) {
            return {
              response: res,
              attempts: attempt + 1,
              retryCount: attempt,
              elapsedMs: Date.now() - requestStartedAt,
            }
          }

          const errorText = await res.text().catch(() => '')
          const retryable = isRetryableStatus(res.status) || (res.ok && options.requireBody && !res.body)

          console.error(
            `[${options.label}] ${provider.name} request failed: status=${res.status}, attempt=${attempt + 1}/${options.retries + 1}, retryable=${retryable}, body=${errorText.slice(0, 240)}`,
          )

          if (!retryable || attempt >= options.retries) {
            const err = new Error(`[${options.label}] ${provider.name} request failed with status ${res.status}`) as RequestError
            err.status = res.status
            err.retryable = retryable
            err.kind = 'http'
            err.bodySnippet = errorText.slice(0, 240)
            throw err
          }
        } catch (err) {
          if (attempt >= options.retries) {
            const e = err as RequestError
            if (!e.kind) {
              e.kind = 'exception'
              e.retryable = true
            }
            throw e
          }
          console.error(
            `[${options.label}] ${provider.name} request exception on attempt ${attempt + 1}/${options.retries + 1}:`,
            err,
          )
        }

        const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]
        await sleep(delay)
      }

      throw new Error(`[${options.label}] ${provider.name} request exhausted retries`)
    }

    const requestWithModelFallback = async (
      payload: Record<string, unknown>,
      options: { label: string; retries: number; requireBody?: boolean },
    ): Promise<RequestResult> => {
      try {
        const primaryResult = await requestProviderWithRetry(payload, primaryProvider, options)
        return {
          ...primaryResult,
          provider: primaryProvider.name,
          model: primaryProvider.model,
          usedFallback: false,
        }
      } catch (primaryErr) {
        if (!fallbackProvider || !shouldTriggerFallback(primaryErr)) {
          throw primaryErr
        }
        const primaryError = primaryErr as RequestError
        console.warn(
          `[${options.label}] Primary model failed (status=${primaryError.status ?? 'n/a'}, kind=${primaryError.kind ?? 'unknown'}). Switching to deepseek fallback.`,
        )
        const fallbackResult = await requestProviderWithRetry(payload, fallbackProvider, options)
        return {
          ...fallbackResult,
          provider: fallbackProvider.name,
          model: fallbackProvider.model,
          usedFallback: true,
        }
      }
    }

    let primaryAttempts = 0
    let primaryRetryCount = 0
    let primaryElapsedMs = 0
    let supplementCalls = 0
    let supplementAttemptsTotal = 0
    let supplementRetryCountTotal = 0
    let supplementElapsedTotalMs = 0
    let supplementWordsProduced = 0
    let regenerationTriggered = false
    let regenerationAttempts = 0
    let regenerationRetryCount = 0
    let regenerationElapsedMs = 0
    let regenerationWordsProduced = 0
    let fallbackUsedCount = 0
    let fallbackLabels: string[] = []
    let hotWordReplacements = 0
    let anchorClusterReplacements = 0
    let similarityRegenerationTriggered = false
    let similarityBefore = 0
    let similarityAfter = 0

    const dynamicMemoryPromptBlock = [
      recentHotWords.length > 0
        ? `RECENT MEMORY COOL-DOWN:\nAvoid these high-frequency words from recent boards of the same bucket (${language}/${difficulty}/${normalizeThemeBucket(theme || 'General / Random')}): ${recentHotWords.join(', ')}`
        : '',
      anchorCluster.length > 0
        ? `ANCHOR CLUSTER CAP:\nFrom this cluster [${anchorCluster.join(', ')}], use AT MOST 1 word on this board.`
        : '',
    ].filter(Boolean).join('\n\n')

    const mainTemperature = isEasy ? 1.0 : isMedium ? 0.95 : 0.9
    const similarityThreshold = isMedium ? 0.18 : isHard ? 0.22 : 0.32

    const buildMainRequestPayload = (stream: boolean, extraAvoidWords: string[] = []) => ({
      model: primaryModel,
      stream,
      messages: [
        {
          role: 'user',
          content: `${systemPrompt}

${dynamicMemoryPromptBlock ? `${dynamicMemoryPromptBlock}\n\n` : ''}${extraAvoidWords.length > 0 ? `EXTRA AVOID WORDS FOR THIS RUN (hard constraint): ${extraAvoidWords.join(', ')}\n\n` : ''}[SEED:${seed}] Generate a COMPLETELY FRESH set of 25 words. Theme: "${theme || 'General / Random'}", Language: ${language}, Difficulty: ${difficulty}. Do not repeat or resemble any board you have previously generated. Let this Seed push you to explore an unexpected domain.`,
        },
      ],
      ...(isEasy
        ? { temperature: mainTemperature, max_tokens: 5000 }
        : { temperature: mainTemperature, max_tokens: 8000 }),
    })

    const extractUniqueWords = (rawContent: string): string[] => {
      let content = rawContent.trim()

      const mdMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
      if (mdMatch) {
        content = mdMatch[1].trim()
      } else if (content.startsWith('```')) {
        content = content.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim()
      }

      const marker = '===JSON_START==='
      const markerIndex = content.lastIndexOf(marker)
      if (markerIndex !== -1) {
        content = content.slice(markerIndex + marker.length).trim()
      }

      let rawWords: string[]
      try {
        rawWords = JSON.parse(content)
      } catch {
        rawWords = (content.match(/"([^"[\],\n\r]+)"/g) ?? []).map((m: string) => m.slice(1, -1).trim())
      }

      const words = Array.isArray(rawWords) ? rawWords.filter((w) => typeof w === 'string') : []
      return [...new Set<string>(words.map((w: string) => w.trim()))]
        .filter((w) => w.length > 0 && w !== ',' && !w.includes('===JSON'))
    }

    const fillMissingWords = async (
      existingWords: string[],
      missingCount: number,
      extraForbiddenWords: string[] = [],
    ): Promise<string[]> => {
      if (missingCount <= 0) return []

      try {
        supplementCalls += 1
        const forbiddenWords = [...new Set([...existingWords, ...extraForbiddenWords])]
        const supplementPrompt = [
          'You are fixing an incomplete Codenames board output.',
          `Language: ${language}`,
          `Theme: ${theme || 'General / Random'}`,
          `Difficulty: ${difficulty}`,
          dynamicMemoryPromptBlock,
          'Quality requirement: keep the same quality bar as the primary generation. Avoid generic/basic words.',
          'Avoid semantic near-duplicates of existing words and avoid trivial variants.',
          'For Chinese, prefer 2-4 character words; use 1-character words only when they are high-signal.',
          `Need exactly ${missingCount} additional UNIQUE words.`,
          `Already used or forbidden words (must NOT appear again): ${JSON.stringify(forbiddenWords)}`,
          `Return ONLY a JSON array with exactly ${missingCount} strings. No explanation, no markdown.`,
        ].filter(Boolean).join('\n')

        const supplementReq = await requestWithModelFallback({
          model: primaryModel,
          stream: false,
          messages: [{ role: 'user', content: supplementPrompt }],
          temperature: isEasy ? 0.9 : isMedium ? 0.96 : 0.9,
          max_tokens: 1600,
        }, {
          label: 'supplement',
          retries: 2,
        })
        const supplementRes = supplementReq.response
        supplementAttemptsTotal += supplementReq.attempts
        supplementRetryCountTotal += supplementReq.retryCount
        supplementElapsedTotalMs += supplementReq.elapsedMs
        if (supplementReq.usedFallback) {
          fallbackUsedCount += 1
          fallbackLabels.push('supplement')
        }

        const supplementJson = await supplementRes.json()
        const supplementContent = supplementJson?.choices?.[0]?.message?.content ?? ''
        const existingSet = new Set(forbiddenWords)
        const supplementalWords = extractUniqueWords(supplementContent)
          .filter((w) => !existingSet.has(w))
          .slice(0, missingCount)
        supplementWordsProduced += supplementalWords.length
        return supplementalWords
      } catch (err) {
        console.error('Supplement word generation failed:', err)
        return []
      }
    }

    const regenerateWholeBoard = async (
      extraForbiddenWords: string[] = [],
      regenerationLabel = 'full-regeneration',
    ): Promise<string[]> => {
      try {
        regenerationTriggered = true
        const regeneratePrompt = [
          'Regenerate the full Codenames board because the previous stream returned no valid words.',
          `Language: ${language}`,
          `Theme: ${theme || 'General / Random'}`,
          `Difficulty: ${difficulty}`,
          dynamicMemoryPromptBlock,
          extraForbiddenWords.length > 0
            ? `Extra forbidden words for this regeneration: ${extraForbiddenWords.join(', ')}`
            : '',
          'Quality requirements:',
          '- Keep the same quality level for this difficulty.',
          '- Avoid generic/basic words.',
          '- Avoid duplicates and near-duplicates.',
          '- For Chinese, prefer 2-4 character words; 1-character words only when high-signal.',
          'Output requirements:',
          '- Return EXACTLY 25 UNIQUE words.',
          '- Return ONLY a raw JSON array, no explanation, no markdown.',
        ].filter(Boolean).join('\n')

        const regenReq = await requestWithModelFallback({
          model: primaryModel,
          stream: false,
          messages: [{ role: 'user', content: regeneratePrompt }],
          temperature: isEasy ? 0.95 : isMedium ? 0.96 : 0.92,
          max_tokens: 3600,
        }, {
          label: regenerationLabel,
          retries: 1,
        })
        const regenRes = regenReq.response
        regenerationAttempts += regenReq.attempts
        regenerationRetryCount += regenReq.retryCount
        regenerationElapsedMs += regenReq.elapsedMs
        if (regenReq.usedFallback) {
          fallbackUsedCount += 1
          fallbackLabels.push(regenerationLabel)
        }

        const regenJson = await regenRes.json()
        const regenContent = regenJson?.choices?.[0]?.message?.content ?? ''
        const regeneratedWords = extractUniqueWords(regenContent).slice(0, 25)
        regenerationWordsProduced += regeneratedWords.length
        return regeneratedWords
      } catch (err) {
        console.error('Full board regeneration failed:', err)
        return []
      }
    }

    const topUpWordsTo25 = async (
      baseWords: string[],
      extraForbiddenWords: string[] = [],
    ): Promise<string[]> => {
      let words = [...new Set(baseWords)].slice(0, 25)
      if (words.length >= 25) return words
      const missingCount = 25 - words.length
      const supplementalWords = await fillMissingWords(words, missingCount, extraForbiddenWords)
      words = [...words, ...supplementalWords].slice(0, 25)
      return words
    }

    const enforceAnchorClusterCap = async (inputWords: string[]): Promise<string[]> => {
      if (anchorCluster.length === 0) return inputWords
      const clusterSet = new Set(anchorCluster)
      let clusterCount = 0
      const keptWords: string[] = []
      let removedCount = 0
      for (const word of inputWords) {
        if (clusterSet.has(word)) {
          clusterCount += 1
          if (clusterCount > 1) {
            removedCount += 1
            continue
          }
        }
        keptWords.push(word)
      }
      if (removedCount === 0) return inputWords
      anchorClusterReplacements += removedCount
      return topUpWordsTo25(keptWords, [...anchorCluster, ...recentHotWords])
    }

    const suppressRecentHotWords = async (inputWords: string[]): Promise<string[]> => {
      if (recentHotWords.length === 0) return inputWords
      const hotSet = new Set(recentHotWords)
      const maxReplace = isMedium ? 4 : isHard ? 5 : 2
      const keptWords: string[] = []
      let replaced = 0
      for (const word of inputWords) {
        if (hotSet.has(word) && replaced < maxReplace) {
          replaced += 1
          continue
        }
        keptWords.push(word)
      }
      if (replaced === 0) return inputWords
      hotWordReplacements += replaced
      return topUpWordsTo25(keptWords, [...recentHotWords, ...anchorCluster])
    }

    const completeBoardWords = async (primaryWords: string[], extraForbiddenWords: string[] = []) => {
      let words = [...primaryWords]
      const primaryWordCount = words.length
      let regeneratedWordCount = 0
      let supplementalWordCount = 0

      if (words.length === 0) {
        console.warn('Primary generation produced 0 words. Attempting full regeneration.')
        const regeneratedWords = await regenerateWholeBoard(extraForbiddenWords)
        regeneratedWordCount = regeneratedWords.length
        words = regeneratedWords
      }

      if (words.length < 25) {
        const missingCount = 25 - words.length
        console.warn(`Primary generation produced ${words.length} words. Attempting to backfill ${missingCount} words.`)
        const supplementalWords = await fillMissingWords(words, missingCount, extraForbiddenWords)
        supplementalWordCount = supplementalWords.length
        words = [...words, ...supplementalWords]
      }

      return {
        words,
        primaryWordCount,
        regeneratedWordCount,
        supplementalWordCount,
      }
    }

    const applyDiversityGuards = async (inputWords: string[]) => {
      let words = [...new Set(inputWords)].slice(0, 25)
      words = await suppressRecentHotWords(words)
      words = await enforceAnchorClusterCap(words)
      words = await topUpWordsTo25(words, [...recentHotWords, ...anchorCluster])

      const before = maxJaccardAgainstRecent(words, recentBoards).maxJaccard
      similarityBefore = before
      let after = before

      if (recentBoards.length > 0 && before > similarityThreshold) {
        similarityRegenerationTriggered = true
        const mostSimilar = maxJaccardAgainstRecent(words, recentBoards).mostSimilar ?? []
        const regenAvoidWords = [...new Set([...recentHotWords, ...anchorCluster, ...mostSimilar])].slice(0, 24)
        console.warn(`Similarity ${before.toFixed(3)} exceeds threshold ${similarityThreshold}. Triggering one regeneration.`)
        const regeneratedWords = await regenerateWholeBoard(regenAvoidWords, 'similarity-regeneration')
        const regenCompletion = await completeBoardWords(regeneratedWords, regenAvoidWords)
        words = [...new Set(regenCompletion.words)].slice(0, 25)
        words = await suppressRecentHotWords(words)
        words = await enforceAnchorClusterCap(words)
        words = await topUpWordsTo25(words, regenAvoidWords)
        after = maxJaccardAgainstRecent(words, recentBoards).maxJaccard
      }

      similarityAfter = after
      return words
    }

    const buildCardsFromWords = (allWords: string[]) => {
      const words = allWords.slice(0, 25)

      // Decouple assassin from length-based assignment to avoid repeated short-word assassin bias.
      const assassinWordIndex = Math.floor(Math.random() * words.length)
      const assassinWord = words[assassinWordIndex]
      const nonAssassinWords = words.filter((_, idx) => idx !== assassinWordIndex)
      const wordsByLength = [...nonAssassinWords].sort((a, b) => a.length - b.length)

      const colorQuotas = { red: 9, blue: 8, neutral: 7 }
      const teamOrder = ['red', 'blue', 'neutral'].sort(() => Math.random() - 0.5)
      const assignedCards: { word: string; color: string }[] = [{ word: assassinWord, color: 'assassin' }]
      let teamIndex = 0

      for (const word of wordsByLength) {
        let attempts = 0
        while (colorQuotas[teamOrder[teamIndex] as keyof typeof colorQuotas] === 0) {
          teamIndex = (teamIndex + 1) % 3
          attempts++
          if (attempts > 3) break
        }
        const chosenColor = teamOrder[teamIndex]
        assignedCards.push({ word, color: chosenColor })
        colorQuotas[chosenColor as keyof typeof colorQuotas]--
        teamIndex = (teamIndex + 1) % 3
      }

      for (let i = assignedCards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
          ;[assignedCards[i], assignedCards[j]] = [assignedCards[j], assignedCards[i]]
      }

      return assignedCards.map((c, index) => ({ ...c, position: index }))
    }

    if (responseMode === 'json') {
      try {
        const primaryReq = await requestWithModelFallback(buildMainRequestPayload(false), {
          label: 'primary-json',
          retries: 2,
        })
        primaryAttempts = primaryReq.attempts
        primaryRetryCount = primaryReq.retryCount
        primaryElapsedMs = primaryReq.elapsedMs
        if (primaryReq.usedFallback) {
          fallbackUsedCount += 1
          fallbackLabels.push('primary-json')
        }

        const primaryJson = await primaryReq.response.json()
        const primaryContent = primaryJson?.choices?.[0]?.message?.content ?? ''
        const completion = await completeBoardWords(extractUniqueWords(primaryContent), [...recentHotWords, ...anchorCluster])
        const finalWords = await applyDiversityGuards(completion.words)

        if (finalWords.length < 25) {
          console.log('[generate-board][telemetry]', JSON.stringify({
            difficulty,
            language,
            theme: theme || 'General / Random',
            seed,
            outcome: 'json_insufficient_words',
            primary: {
              attempts: primaryAttempts,
              retryCount: primaryRetryCount,
              elapsedMs: primaryElapsedMs,
              words: completion.primaryWordCount,
            },
            regeneration: {
              triggered: regenerationTriggered,
              attempts: regenerationAttempts,
              retryCount: regenerationRetryCount,
              elapsedMs: regenerationElapsedMs,
              words: regenerationWordsProduced,
            },
            supplement: {
              calls: supplementCalls,
              attemptsTotal: supplementAttemptsTotal,
              retryCountTotal: supplementRetryCountTotal,
              elapsedMsTotal: supplementElapsedTotalMs,
              words: supplementWordsProduced,
            },
            final: {
              words: finalWords.length,
              regenerated: completion.regeneratedWordCount,
              supplemental: completion.supplementalWordCount,
            },
            diversity: {
              recentBucketSize: recentBoards.length,
              recentHotWordsCount: recentHotWords.length,
              hotWordReplacements,
              anchorClusterReplacements,
              similarityThreshold,
              similarityBefore,
              similarityAfter,
              similarityRegenerationTriggered,
            },
            fallback: {
              enabled: Boolean(fallbackProvider),
              usedCount: fallbackUsedCount,
              labels: fallbackLabels,
            },
            totalMs: Date.now() - runStartedAt,
          }))
          return new Response(JSON.stringify({
            error: `AI failed to generate 25 words. It generated ${finalWords.length} unique words before stopping (primary=${completion.primaryWordCount}, regenerated=${completion.regeneratedWordCount}, supplemental=${completion.supplementalWordCount}). Please retry.`,
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 502,
          })
        }

        const cards = buildCardsFromWords(finalWords)
        const meta = {
          primaryProvider: primaryReq.provider,
          primaryModel: primaryReq.model,
          primaryUsedFallback: primaryReq.usedFallback,
          fallback: {
            enabled: Boolean(fallbackProvider),
            usedCount: fallbackUsedCount,
            labels: fallbackLabels,
          },
          diversity: {
            recentBucketSize: recentBoards.length,
            recentHotWordsCount: recentHotWords.length,
            hotWordReplacements,
            anchorClusterReplacements,
            similarityThreshold,
            similarityBefore,
            similarityAfter,
            similarityRegenerationTriggered,
          },
        }
        console.log('[generate-board][telemetry]', JSON.stringify({
          difficulty,
          language,
          theme: theme || 'General / Random',
          seed,
          outcome: 'json_success',
          primary: {
            attempts: primaryAttempts,
            retryCount: primaryRetryCount,
            elapsedMs: primaryElapsedMs,
            words: completion.primaryWordCount,
          },
          regeneration: {
            triggered: regenerationTriggered,
            attempts: regenerationAttempts,
            retryCount: regenerationRetryCount,
            elapsedMs: regenerationElapsedMs,
            words: regenerationWordsProduced,
          },
          supplement: {
            calls: supplementCalls,
            attemptsTotal: supplementAttemptsTotal,
            retryCountTotal: supplementRetryCountTotal,
            elapsedMsTotal: supplementElapsedTotalMs,
            words: supplementWordsProduced,
          },
          final: {
            words: finalWords.length,
          },
          diversity: meta.diversity,
          fallback: meta.fallback,
          totalMs: Date.now() - runStartedAt,
        }))

        addBoardToRecentMemory(historyBucketKey, finalWords)
        return new Response(JSON.stringify({ cards, meta }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
      } catch (err) {
        console.error('JSON mode generation failed:', err)
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return new Response(JSON.stringify({ error: msg }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 502,
        })
      }
    }

    // ──────────────────────────────────────────────────────────
    // STREAMING PIPELINE with live reasoning word extraction
    //
    // Protocol to client:
    //   data: __THINKING__         → heartbeat during reasoning (keep alive)
    //   data: __DRAFT__<word>      → tentative word found in reasoning_content
    //   data: __REJECT__<word>     → word was rejected during reasoning
    //   data: __WORD__<word>       → confirmed word from final content
    //   data: __CARDS__<json>      → final card array with team colors
    //   data: __DONE__             → stream complete
    //   data: __ERROR__<msg>       → error
    // ──────────────────────────────────────────────────────────
    const primaryReq = await requestWithModelFallback(buildMainRequestPayload(true), {
      label: 'primary-stream',
      retries: 2,
      requireBody: true,
    })
    const apiRes = primaryReq.response
    primaryAttempts = primaryReq.attempts
    primaryRetryCount = primaryReq.retryCount
    primaryElapsedMs = primaryReq.elapsedMs
    if (primaryReq.usedFallback) {
      fallbackUsedCount += 1
      fallbackLabels.push('primary-stream')
    }

    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const send = (msg: string) => writer.write(encoder.encode(`data: ${msg}\n\n`))

      ; (async () => {
        const reader = apiRes.body!.getReader()
        const decoder = new TextDecoder()
        const streamStartedAt = Date.now()
        let firstUpstreamDataMs: number | null = null
        let streamWordEvents = 0

        let reasoningText = ''       // Accumulated reasoning stream
        let contentText = ''         // Accumulated final JSON stream
        let isReasoningComplete = false // Flag to hard-switch parsing modes
        let sentWordCount = 0
        let upstreamLineBuffer = '' // Preserve partial SSE lines across chunks
        // Independent heartbeat to keep Supabase gateway alive during long DeepSeek TTFB
        const heartbeatTimer = setInterval(() => {
          send('__THINKING__').catch(() => { })
        }, 2000)

        // Track draft words extracted from reasoning
        const draftWords = new Set<string>()
        const rejectedWords = new Set<string>()
        let lastDraftExtractLen = 0  // last length of reasoningText when we extracted

        const processUpstreamDataLine = async (line: string) => {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) return
          if (firstUpstreamDataMs === null) {
            firstUpstreamDataMs = Date.now() - streamStartedAt
          }

          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') return

          try {
            const parsed = JSON.parse(payload)
            const delta = parsed.choices?.[0]?.delta

            // ── GLM-4 PARSING PHASE ──
            if (delta?.content) {
              isReasoningComplete = true
            }

            if (!isReasoningComplete && delta?.reasoning_content) {
              // ── REASONING PHASE ──
              reasoningText += delta.reasoning_content

              // Every ~40 new characters of reasoning, scan for quoted Chinese words
              if (reasoningText.length - lastDraftExtractLen > 40) {
                lastDraftExtractLen = reasoningText.length
                const newSection = reasoningText.slice(Math.max(0, lastDraftExtractLen - 300))

                // Match words inside Chinese/English quotes (1-4 Chinese chars)
                const quoteMatches = newSection.match(/["“「『]([一-\u9fff]{1,4})["”」』]/g) ?? []
                for (const m of quoteMatches) {
                  const word = m.slice(1, -1)
                  if (word && !draftWords.has(word) && !rejectedWords.has(word)) {
                    draftWords.add(word)
                    await send(`__DRAFT__${word}`)
                  }
                }

                // Detect rejection patterns: 去掉X, 删除X, 替换X, X太..., 不要X
                const rejectPatterns = [
                  /(?:去掉|删除|替换|移除|排除|不[要用])["“「『]?([一-\u9fff]{1,4})["”」』]?/g,
                  /["“「『]([一-\u9fff]{1,4})["”」』]?(?:太|不太|不够|过于|不适合|删|去)/g,
                ]
                for (const pattern of rejectPatterns) {
                  let match
                  while ((match = pattern.exec(newSection)) !== null) {
                    const rejected = match[1]
                    if (rejected && draftWords.has(rejected) && !rejectedWords.has(rejected)) {
                      rejectedWords.add(rejected)
                      await send(`__REJECT__${rejected}`)
                    }
                  }
                }
              }
            }

            // Ensure we only process final output when thinking is definitely over
            if (isReasoningComplete && delta?.content) {
              // ── OUTPUT PHASE: buffer final JSON ──
              contentText += delta.content

              // Safely extract whole strings. Avoid capturing mid-stream broken chunks containing commas/brackets
              const matches = contentText.match(/"([^"[\],\n\r]+)"/g) ?? []
              const words = matches.map((m: string) => m.slice(1, -1).trim())

              while (sentWordCount < words.length && sentWordCount < 25) {
                const word = words[sentWordCount]
                if (
                  word &&
                  word.length > 0 &&
                  !word.includes('JSON') &&
                  !word.includes(',') &&
                  !word.includes(']')
                ) {
                  streamWordEvents++
                  await send(`__WORD__${word}`)
                }
                sentWordCount++
              }
            }
          } catch {
            // Ignore malformed/incomplete JSON lines; buffering handles most splits.
          }
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            upstreamLineBuffer += decoder.decode(value, { stream: true })
            const lines = upstreamLineBuffer.split('\n')
            upstreamLineBuffer = lines.pop() ?? ''

            for (const line of lines) {
              await processUpstreamDataLine(line)
            }
          }

          // Handle a final line without trailing newline.
          if (upstreamLineBuffer.trim()) {
            await processUpstreamDataLine(upstreamLineBuffer)
          }

          // Parse the final content
          const rawPrimaryWords = extractUniqueWords(contentText)
          const completion = await completeBoardWords(rawPrimaryWords, [...recentHotWords, ...anchorCluster])
          let words = await applyDiversityGuards(completion.words)

          const seenInPrimary = new Set(rawPrimaryWords)
          for (const w of words) {
            if (!seenInPrimary.has(w)) {
              await send(`__WORD__${w}`)
            }
          }

          if (words.length < 25) {
            console.log('[generate-board][telemetry]', JSON.stringify({
              difficulty,
              language,
              theme: theme || 'General / Random',
              seed,
              outcome: 'insufficient_words',
              primary: {
                attempts: primaryAttempts,
                retryCount: primaryRetryCount,
                elapsedMs: primaryElapsedMs,
                words: completion.primaryWordCount,
              },
              stream: {
                firstDataMs: firstUpstreamDataMs,
                durationMs: Date.now() - streamStartedAt,
                wordEvents: streamWordEvents,
              },
              regeneration: {
                triggered: regenerationTriggered,
                attempts: regenerationAttempts,
                retryCount: regenerationRetryCount,
                elapsedMs: regenerationElapsedMs,
                words: regenerationWordsProduced,
              },
              supplement: {
                calls: supplementCalls,
                attemptsTotal: supplementAttemptsTotal,
                retryCountTotal: supplementRetryCountTotal,
                elapsedMsTotal: supplementElapsedTotalMs,
                words: supplementWordsProduced,
              },
              final: {
                words: words.length,
                regenerated: completion.regeneratedWordCount,
                supplemental: completion.supplementalWordCount,
              },
              diversity: {
                recentBucketSize: recentBoards.length,
                recentHotWordsCount: recentHotWords.length,
                hotWordReplacements,
                anchorClusterReplacements,
                similarityThreshold,
                similarityBefore,
                similarityAfter,
                similarityRegenerationTriggered,
              },
              fallback: {
                enabled: Boolean(fallbackProvider),
                usedCount: fallbackUsedCount,
                labels: fallbackLabels,
              },
              totalMs: Date.now() - runStartedAt,
            }))
            await send(`__ERROR__AI failed to generate 25 words. It generated ${words.length} unique words before stopping (primary=${completion.primaryWordCount}, regenerated=${completion.regeneratedWordCount}, supplemental=${completion.supplementalWordCount}). Please retry.`)
            return
          }

          words = words.slice(0, 25)

          // Decouple assassin from length-based assignment to avoid repeated short-word assassin bias.
          const assassinWordIndex = Math.floor(Math.random() * words.length)
          const assassinWord = words[assassinWordIndex]
          const nonAssassinWords = words.filter((_, idx) => idx !== assassinWordIndex)
          const wordsByLength = [...nonAssassinWords].sort((a, b) => a.length - b.length)

          const colorQuotas = { red: 9, blue: 8, neutral: 7 }
          const teamOrder = ['red', 'blue', 'neutral'].sort(() => Math.random() - 0.5)
          const assignedCards: { word: string; color: string }[] = [{ word: assassinWord, color: 'assassin' }]
          let teamIndex = 0

          for (const word of wordsByLength) {
            let attempts = 0
            while (colorQuotas[teamOrder[teamIndex] as keyof typeof colorQuotas] === 0) {
              teamIndex = (teamIndex + 1) % 3
              attempts++
              if (attempts > 3) break
            }
            const chosenColor = teamOrder[teamIndex]
            assignedCards.push({ word, color: chosenColor })
            colorQuotas[chosenColor as keyof typeof colorQuotas]--
            teamIndex = (teamIndex + 1) % 3
          }

          for (let i = assignedCards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
              ;[assignedCards[i], assignedCards[j]] = [assignedCards[j], assignedCards[i]]
          }

          const cards = assignedCards.map((c, index) => ({ ...c, position: index }))
          const meta = {
            primaryProvider: primaryReq.provider,
            primaryModel: primaryReq.model,
            primaryUsedFallback: primaryReq.usedFallback,
            fallback: {
              enabled: Boolean(fallbackProvider),
              usedCount: fallbackUsedCount,
              labels: fallbackLabels,
            },
            diversity: {
              recentBucketSize: recentBoards.length,
              recentHotWordsCount: recentHotWords.length,
              hotWordReplacements,
              anchorClusterReplacements,
              similarityThreshold,
              similarityBefore,
              similarityAfter,
              similarityRegenerationTriggered,
            },
          }

          await send(`__CARDS__${JSON.stringify(cards)}`)
          await send(`__META__${JSON.stringify(meta)}`)
          await send('__DONE__')
          addBoardToRecentMemory(historyBucketKey, words)
          console.log('[generate-board][telemetry]', JSON.stringify({
            difficulty,
            language,
            theme: theme || 'General / Random',
            seed,
            outcome: 'success',
            primary: {
              attempts: primaryAttempts,
              retryCount: primaryRetryCount,
              elapsedMs: primaryElapsedMs,
              words: completion.primaryWordCount,
            },
            stream: {
              firstDataMs: firstUpstreamDataMs,
              durationMs: Date.now() - streamStartedAt,
              wordEvents: streamWordEvents,
            },
            regeneration: {
              triggered: regenerationTriggered,
              attempts: regenerationAttempts,
              retryCount: regenerationRetryCount,
              elapsedMs: regenerationElapsedMs,
              words: regenerationWordsProduced,
            },
            supplement: {
              calls: supplementCalls,
              attemptsTotal: supplementAttemptsTotal,
              retryCountTotal: supplementRetryCountTotal,
              elapsedMsTotal: supplementElapsedTotalMs,
              words: supplementWordsProduced,
            },
            final: {
              words: words.length,
            },
            fallback: meta.fallback,
            diversity: meta.diversity,
            totalMs: Date.now() - runStartedAt,
          }))
        } catch (err) {
          console.error('Stream processing error:', err)
          console.log('[generate-board][telemetry]', JSON.stringify({
            difficulty,
            language,
            theme: theme || 'General / Random',
            seed,
            outcome: 'stream_processing_error',
            primary: {
              attempts: primaryAttempts,
              retryCount: primaryRetryCount,
              elapsedMs: primaryElapsedMs,
            },
            stream: {
              firstDataMs: firstUpstreamDataMs,
              durationMs: Date.now() - streamStartedAt,
              wordEvents: streamWordEvents,
            },
            regeneration: {
              triggered: regenerationTriggered,
              attempts: regenerationAttempts,
              retryCount: regenerationRetryCount,
              elapsedMs: regenerationElapsedMs,
              words: regenerationWordsProduced,
            },
            supplement: {
              calls: supplementCalls,
              attemptsTotal: supplementAttemptsTotal,
              retryCountTotal: supplementRetryCountTotal,
              elapsedMsTotal: supplementElapsedTotalMs,
              words: supplementWordsProduced,
            },
            fallback: {
              enabled: Boolean(fallbackProvider),
              usedCount: fallbackUsedCount,
              labels: fallbackLabels,
            },
            totalMs: Date.now() - runStartedAt,
          }))
          const msg = err instanceof Error ? err.message : 'Unknown error'
          await send(`__ERROR__${msg}`).catch(() => { })
        } finally {
          clearInterval(heartbeatTimer)
          await writer.close().catch(() => { })
        }
      })()

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })

  } catch (error) {
    console.error('Error generating board:', error)
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
