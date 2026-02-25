import "@supabase/functions-js/edge-runtime.d.ts"
import { buildPrompt } from './prompt.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { theme = '', language = '中文', difficulty = '适中' } = await req.json()

    const apiKey = Deno.env.get('GLM_API_KEY')
    if (!apiKey) throw new Error('GLM_API_KEY is not set')

    const seed = Math.floor(Math.random() * 1_000_000_000)
    const systemPrompt = buildPrompt(language, theme || 'General / Random', difficulty, seed)

    console.log(`Generating board: theme=${theme}, lang=${language}, diff=${difficulty}, seed=${seed}`)

    const isEasy = difficulty === '简易'

    // Model selection: GLM-4.7
    const model = 'glm-4.7'
    const glmApiUrl = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
    const runStartedAt = Date.now()

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const isRetryableStatus = (status: number) =>
      status === 408 || status === 429 || status >= 500

    const requestGLMWithRetry = async (
      payload: Record<string, unknown>,
      options: { label: string; retries: number; requireBody?: boolean },
    ): Promise<{ response: Response; attempts: number; retryCount: number; elapsedMs: number }> => {
      const retryDelaysMs = [1200, 2500, 4500]
      const requestStartedAt = Date.now()

      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          const res = await fetch(glmApiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
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
            `[${options.label}] GLM request failed: status=${res.status}, attempt=${attempt + 1}/${options.retries + 1}, retryable=${retryable}, body=${errorText.slice(0, 240)}`,
          )

          if (!retryable || attempt >= options.retries) {
            throw new Error(`[${options.label}] GLM request failed with status ${res.status}`)
          }
        } catch (err) {
          if (attempt >= options.retries) {
            throw err
          }
          console.error(
            `[${options.label}] GLM request exception on attempt ${attempt + 1}/${options.retries + 1}:`,
            err,
          )
        }

        const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]
        await sleep(delay)
      }

      throw new Error(`[${options.label}] GLM request exhausted retries`)
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

    const mainRequestPayload = {
      model,
      stream: true,
      messages: [
        {
          role: 'user',
          content: `${systemPrompt}\n\n[SEED:${seed}] Generate a COMPLETELY FRESH set of 25 words. Theme: "${theme || 'General / Random'}", Language: ${language}, Difficulty: ${difficulty}. Do not repeat or resemble any board you have previously generated. Let this Seed push you to explore an unexpected domain.`,
        },
      ],
      ...(isEasy
        ? { temperature: 1.0, max_tokens: 5000 }
        : { max_tokens: 8000 }),
    }

    const primaryReq = await requestGLMWithRetry(mainRequestPayload, {
      label: 'primary-stream',
      retries: 2,
      requireBody: true,
    })
    const apiRes = primaryReq.response
    primaryAttempts = primaryReq.attempts
    primaryRetryCount = primaryReq.retryCount
    primaryElapsedMs = primaryReq.elapsedMs

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

    const fillMissingWords = async (existingWords: string[], missingCount: number): Promise<string[]> => {
      if (missingCount <= 0) return []

      try {
        supplementCalls += 1
        const supplementPrompt = [
          'You are fixing an incomplete Codenames board output.',
          `Language: ${language}`,
          `Theme: ${theme || 'General / Random'}`,
          `Difficulty: ${difficulty}`,
          'Quality requirement: keep the same quality bar as the primary generation. Avoid generic/basic words.',
          'Avoid semantic near-duplicates of existing words and avoid trivial variants.',
          'For Chinese, prefer 2-4 character words; use 1-character words only when they are high-signal.',
          `Need exactly ${missingCount} additional UNIQUE words.`,
          `Already used words (must NOT appear again): ${JSON.stringify(existingWords)}`,
          `Return ONLY a JSON array with exactly ${missingCount} strings. No explanation, no markdown.`,
        ].join('\n')

        const supplementReq = await requestGLMWithRetry({
          model,
          stream: false,
          messages: [{ role: 'user', content: supplementPrompt }],
          temperature: isEasy ? 0.9 : 1.1,
          max_tokens: 1600,
        }, {
          label: 'supplement',
          retries: 2,
        })
        const supplementRes = supplementReq.response
        supplementAttemptsTotal += supplementReq.attempts
        supplementRetryCountTotal += supplementReq.retryCount
        supplementElapsedTotalMs += supplementReq.elapsedMs

        const supplementJson = await supplementRes.json()
        const supplementContent = supplementJson?.choices?.[0]?.message?.content ?? ''
        const existingSet = new Set(existingWords)
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

    const regenerateWholeBoard = async (): Promise<string[]> => {
      try {
        regenerationTriggered = true
        const regeneratePrompt = [
          'Regenerate the full Codenames board because the previous stream returned no valid words.',
          `Language: ${language}`,
          `Theme: ${theme || 'General / Random'}`,
          `Difficulty: ${difficulty}`,
          'Quality requirements:',
          '- Keep the same quality level for this difficulty.',
          '- Avoid generic/basic words.',
          '- Avoid duplicates and near-duplicates.',
          '- For Chinese, prefer 2-4 character words; 1-character words only when high-signal.',
          'Output requirements:',
          '- Return EXACTLY 25 UNIQUE words.',
          '- Return ONLY a raw JSON array, no explanation, no markdown.',
        ].join('\n')

        const regenReq = await requestGLMWithRetry({
          model,
          stream: false,
          messages: [{ role: 'user', content: regeneratePrompt }],
          temperature: isEasy ? 0.95 : 1.1,
          max_tokens: 3600,
        }, {
          label: 'full-regeneration',
          retries: 1,
        })
        const regenRes = regenReq.response
        regenerationAttempts += regenReq.attempts
        regenerationRetryCount += regenReq.retryCount
        regenerationElapsedMs += regenReq.elapsedMs

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
          let words = extractUniqueWords(contentText)
          const primaryWordCount = words.length
          let regeneratedWordCount = 0
          let supplementalWordCount = 0

          if (words.length === 0) {
            console.warn('Primary generation produced 0 words. Attempting full regeneration.')
            const regeneratedWords = await regenerateWholeBoard()
            regeneratedWordCount = regeneratedWords.length
            for (const w of regeneratedWords) {
              await send(`__WORD__${w}`)
            }
            words = regeneratedWords
          }

          if (words.length < 25) {
            const missingCount = 25 - words.length
            console.warn(`Primary generation produced ${words.length} words. Attempting to backfill ${missingCount} words.`)
            const supplementalWords = await fillMissingWords(words, missingCount)
            supplementalWordCount = supplementalWords.length
            for (const w of supplementalWords) {
              await send(`__WORD__${w}`)
            }
            words = [...words, ...supplementalWords]
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
                words: primaryWordCount,
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
                regenerated: regeneratedWordCount,
                supplemental: supplementalWordCount,
              },
              totalMs: Date.now() - runStartedAt,
            }))
            await send(`__ERROR__AI failed to generate 25 words. It generated ${words.length} unique words before stopping (primary=${primaryWordCount}, regenerated=${regeneratedWordCount}, supplemental=${supplementalWordCount}). Please retry.`)
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

          await send(`__CARDS__${JSON.stringify(cards)}`)
          await send('__DONE__')
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
              words: primaryWordCount,
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
