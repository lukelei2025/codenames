import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Card, Role, Room, Team } from '../types'
import { RotateCcw, X } from 'lucide-react'

export default function Game() {
    const { id } = useParams()
    const navigate = useNavigate()

    const [cards, setCards] = useState<Card[]>([])
    const [room, setRoom] = useState<Room | null>(null)
    const [role, setRole] = useState<Role>('operative')
    const [loading, setLoading] = useState(!!id) // Only load if we have an ID
    const [generating, setGenerating] = useState(false)
    const [generateTimer, setGenerateTimer] = useState(0)
    const [wordItems, setWordItems] = useState<{ word: string; status: 'draft' | 'rejected' | 'confirmed' }[]>([])
    const draftQueueRef = useRef<{ word: string; type: 'draft' | 'reject' }[]>([])
    const drainTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // Create Room State
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [theme, setTheme] = useState('')
    const [language, setLanguage] = useState('中文')
    const [difficulty, setDifficulty] = useState('适中')
    const [showGenerationFailModal, setShowGenerationFailModal] = useState(false)

    useEffect(() => {
        if (!id) {
            // Reset state if we navigate back to root
            setRoom(null)
            setCards([])
            return
        }

        const loadGame = async () => {
            try {
                const { data: roomData, error: roomError } = await supabase
                    .from('rooms')
                    .select('*')
                    .eq('id', id)
                    .single()

                if (roomError) throw roomError
                setRoom(roomData)

                const { data: cardsData, error: cardsError } = await supabase
                    .from('cards')
                    .select('*')
                    .eq('room_id', id)
                    .order('position', { ascending: true })

                if (cardsError) throw cardsError
                setCards(cardsData || [])
            } catch (err: any) {
                console.error(err)
                alert('Failed to load game room.')
                navigate('/')
            } finally {
                setLoading(false)
            }
        }

        loadGame()

        // Subscribe to realtime card updates
        const cardSubscription = supabase
            .channel(`card:${id}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'cards',
                filter: `room_id=eq.${id}`
            }, (payload) => {
                setCards(currentCards =>
                    currentCards.map(c =>
                        c.id === payload.new.id ? { ...c, is_revealed: payload.new.is_revealed } : c
                    )
                )
            })
            .subscribe()

        // Subscribe to realtime room updates (turns and winners)
        const roomSubscription = supabase
            .channel(`room:${id}`)
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'rooms',
                filter: `id=eq.${id}`
            }, (payload) => {
                setRoom(payload.new as Room)
            })
            .subscribe()

        return () => {
            supabase.removeChannel(cardSubscription)
            supabase.removeChannel(roomSubscription)
        }
    }, [id, navigate])

    // Clear draft queue when generation ends
    useEffect(() => {
        if (!generating) {
            draftQueueRef.current = []
            setWordItems([])
            if (drainTimerRef.current) clearInterval(drainTimerRef.current)
        }
    }, [generating])

    // Generate Timer logic
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | undefined
        if (generating) {
            setGenerateTimer(0)
            interval = setInterval(() => {
                setGenerateTimer(prev => prev + 1)
            }, 1000)
        }
        return () => {
            if (interval) clearInterval(interval)
        }
    }, [generating])

    const MAX_GENERATE_ATTEMPTS = 2
    const GENERATE_RETRY_DELAY_MS = 1200

    const getErrorMessage = (error: unknown) => {
        if (error instanceof Error) return error.message
        if (typeof error === 'string') return error
        try {
            return JSON.stringify(error)
        } catch {
            return String(error)
        }
    }

    const isRetryableGenerationError = (error: unknown) => {
        const message = getErrorMessage(error).toLowerCase()
        return (
            message.includes('missing_cards') ||
            message.includes('edge function error') ||
            message.includes('fetch failed') ||
            message.includes('failed to fetch') ||
            message.includes('terminated') ||
            message.includes('timeout') ||
            message.includes('stream') ||
            message.includes('worker_limit') ||
            message.includes('http_546')
        )
    }

    const handleCreateRoom = async () => {
        setShowCreateModal(false)
        setShowGenerationFailModal(false)
        setGenerating(true)
        setWordItems([])
        draftQueueRef.current = []

        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

        // Start a drain timer that releases queued draft/reject words smoothly
        if (drainTimerRef.current) clearInterval(drainTimerRef.current)
        drainTimerRef.current = setInterval(() => {
            const next = draftQueueRef.current.shift()
            if (!next) return
            if (next.type === 'draft') {
                setWordItems(prev => prev.some(w => w.word === next.word) ? prev : [...prev, { word: next.word, status: 'draft' as const }])
            } else if (next.type === 'reject') {
                setWordItems(prev => prev.map(w => w.word === next.word ? { ...w, status: 'rejected' as const } : w))
                setTimeout(() => setWordItems(prev => prev.filter(w => w.word !== next.word)), 600)
            }
        }, 300)
        try {
            for (let attempt = 1; attempt <= MAX_GENERATE_ATTEMPTS; attempt++) {
                let roomId: string | null = null
                try {
                    const { data: roomData, error: roomError } = await supabase
                        .from('rooms')
                        .insert([{ theme: theme || 'General', language }])
                        .select()
                        .single()

                    if (roomError) throw roomError
                    roomId = roomData.id

                    const res = await fetch(`${supabaseUrl}/functions/v1/generate-board`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${supabaseKey}`,
                        },
                        body: JSON.stringify({ theme, language, difficulty }),
                    })

                    if (!res.ok || !res.body) {
                        throw new Error(`Edge Function error: ${res.status}`)
                    }

                    const reader = res.body.getReader()
                    const decoder = new TextDecoder()
                    let cards: any[] = []
                    let lineBuffer = ''

                    outer: while (true) {
                        const { done, value } = await reader.read()
                        if (done) break

                        lineBuffer += decoder.decode(value, { stream: true })
                        const lines = lineBuffer.split('\n')
                        lineBuffer = lines.pop() ?? ''

                        for (const line of lines) {
                            const trimmed = line.trim()
                            if (!trimmed.startsWith('data:')) continue
                            const payload = trimmed.slice(5).trim()

                            if (payload === '__DONE__') break outer
                            if (payload === '__THINKING__') continue

                            if (payload.startsWith('__ERROR__')) throw new Error(payload.slice(9))

                            if (payload.startsWith('__CARDS__')) {
                                try { cards = JSON.parse(payload.slice(9)) } catch (e) { console.error('Cards parse error', e) }
                                continue
                            }

                            if (payload.startsWith('__DRAFT__')) {
                                const word = payload.slice(9)
                                if (word && !draftQueueRef.current.some(q => q.word === word)) {
                                    draftQueueRef.current.push({ word, type: 'draft' })
                                }
                            }

                            if (payload.startsWith('__REJECT__')) {
                                const word = payload.slice(10)
                                if (word) {
                                    draftQueueRef.current.push({ word, type: 'reject' })
                                }
                            }

                            if (payload.startsWith('__WORD__')) {
                                const word = payload.slice(8)
                                if (word) {
                                    setWordItems(prev => {
                                        const exists = prev.find(w => w.word === word)
                                        if (exists) return prev.map(w => w.word === word ? { ...w, status: 'confirmed' as const } : w)
                                        return [...prev, { word, status: 'confirmed' as const }]
                                    })
                                }
                            }
                        }
                    }

                    if (!cards.length) throw new Error('missing_cards')

                    // Flush remaining draft queue before showing final cards
                    if (drainTimerRef.current) { clearInterval(drainTimerRef.current); drainTimerRef.current = null }
                    while (draftQueueRef.current.length > 0) {
                        const next = draftQueueRef.current.shift()!
                        if (next.type === 'draft') {
                            setWordItems(prev => prev.some(w => w.word === next.word) ? prev : [...prev, { word: next.word, status: 'draft' as const }])
                        }
                    }

                    // Final: replace all with confirmed words from cards
                    const finalWords = cards.map((c: any) => c.word)
                    setWordItems([])
                    for (let i = 0; i < finalWords.length; i++) {
                        await new Promise(r => setTimeout(r, 60))
                        setWordItems(finalWords.slice(0, i + 1).map((w: string) => ({ word: w, status: 'confirmed' as const })))
                    }
                    await new Promise(r => setTimeout(r, 800))

                    const cardsToInsert = cards.map((c: any, index: number) => ({
                        room_id: roomId,
                        word: c.word,
                        color: c.color,
                        position: index,
                        is_revealed: false
                    }))
                    const { error: cardsError } = await supabase.from('cards').insert(cardsToInsert)
                    if (cardsError) throw cardsError

                    navigate(`/game/${roomId}`)
                    return
                } catch (err) {
                    console.error(`[create-room attempt ${attempt}]`, err)

                    if (roomId) {
                        await supabase.from('rooms').delete().eq('id', roomId)
                    }

                    const shouldRetry = attempt < MAX_GENERATE_ATTEMPTS && isRetryableGenerationError(err)
                    if (shouldRetry) {
                        draftQueueRef.current = []
                        setWordItems([])
                        await new Promise(r => setTimeout(r, GENERATE_RETRY_DELAY_MS))
                        continue
                    }
                    throw err
                }
            }
        } catch (err: any) {
            console.error(err)
            setShowGenerationFailModal(true)
        } finally {
            if (drainTimerRef.current) { clearInterval(drainTimerRef.current); drainTimerRef.current = null }
            setGenerating(false)
            setWordItems([])
        }
    }

    const handleRevealCard = async (card: Card) => {
        if (card.is_revealed || (room && room.winner)) return

        try {
            // Optimistic update
            setCards(currentCards =>
                currentCards.map(c => c.id === card.id ? { ...c, is_revealed: true } : c)
            )

            // Update card in DB
            const { error: cardError } = await supabase
                .from('cards')
                .update({ is_revealed: true })
                .eq('id', card.id)

            if (cardError) throw cardError

            if (!room) return

            // Game Logic evaluation
            const currentTurn = room.current_turn
            const opponentTurn = currentTurn === 'red' ? 'blue' : 'red'
            let newTurn = currentTurn
            let newWinner = room.winner

            // Win conditions
            if (card.color === 'assassin') {
                newWinner = opponentTurn // You hit the assassin, opponent wins immediately
            }

            // Check if current reveal causes a turn switch
            if (card.color === 'neutral' || card.color === opponentTurn) {
                newTurn = opponentTurn
            }

            // Only run the db update if game state changed (we don't wait for Realtime here to reduce delay of subsequent checks)
            if (newTurn !== currentTurn || newWinner !== room.winner) {
                await supabase
                    .from('rooms')
                    .update({ current_turn: newTurn, winner: newWinner })
                    .eq('id', room.id)
            }

        } catch (err) {
            console.error('Error revealing card:', err)
            setCards(currentCards =>
                currentCards.map(c => c.id === card.id ? { ...c, is_revealed: false } : c)
            )
        }
    }

    const handleEndTurn = async () => {
        if (!room || room.winner) return
        const nextTurn = room.current_turn === 'red' ? 'blue' : 'red'

        try {
            await supabase
                .from('rooms')
                .update({ current_turn: nextTurn })
                .eq('id', room.id)
        } catch (err) {
            console.error('Error ending turn:', err)
        }
    }

    // Add useEffect to perform check for all cards of one color revealed
    useEffect(() => {
        if (!room || room.winner || cards.length === 0) return

        const redTotal = cards.filter(c => c.color === 'red').length
        const blueTotal = cards.filter(c => c.color === 'blue').length
        const redRevealed = cards.filter(c => c.color === 'red' && c.is_revealed).length
        const blueRevealed = cards.filter(c => c.color === 'blue' && c.is_revealed).length

        let autoWinner: Team | null = null

        if (redTotal > 0 && redRevealed === redTotal) {
            autoWinner = 'red'
        } else if (blueTotal > 0 && blueRevealed === blueTotal) {
            autoWinner = 'blue'
        }

        if (autoWinner) {
            supabase
                .from('rooms')
                .update({ winner: autoWinner })
                .eq('id', room.id)
                .then(({ error }) => {
                    if (error) console.error("Failed to set winner:", error)
                })
        }
    }, [cards, room])

    if (loading) return <div className="loading-screen">Loading Game...</div>

    const redLeft = cards.filter(c => c.color === 'red' && !c.is_revealed).length
    const blueLeft = cards.filter(c => c.color === 'blue' && !c.is_revealed).length
    const neutralLeft = cards.filter(c => c.color === 'neutral' && !c.is_revealed).length
    const assassinLeft = cards.filter(c => c.color === 'assassin' && !c.is_revealed).length

    // Determine final board state: when somebody wins, full reveal.
    const isGameOver = !!room?.winner

    return (
        <div className="app-container">
            {/* Top Navigation / Controls */}
            <header className="header">
                <div className="header-left">
                    <h1 onClick={() => navigate('/')} className="logo-title">Cool Codenames</h1>
                </div>

                <div className="header-right">
                    <div className="game-controls">
                        <div className="role-segmented-control">
                            <div className={`role-slider ${role === 'spymaster' ? 'shift' : ''}`}></div>
                            <button
                                className={`role-seg-btn ${role === 'operative' ? 'active' : ''}`}
                                onClick={() => setRole('operative')}
                            >
                                队员视角
                            </button>
                            <button
                                className={`role-seg-btn ${role === 'spymaster' ? 'active' : ''}`}
                                onClick={() => setRole('spymaster')}
                            >
                                间谍头目视角
                            </button>
                        </div>
                        <button className="new-game-btn" onClick={() => setShowCreateModal(true)}>
                            <RotateCcw size={16} /> 新游戏
                        </button>
                    </div>
                </div>
            </header>

            {/* Main Content Area */}
            <main className="main-content">
                {!id ? (
                    <div className="empty-state">
                        <div className="welcome-hero">
                            <h2 className="slogan-main">智慧交锋，思维燃烧！</h2>
                            <p className="slogan-sub">Connect minds, ignite brilliance!</p>
                            <p className="hint" style={{ marginTop: '2rem', fontSize: '1.25rem' }}>支持与朋友联机，生成后分享网址即可同屏玩耍。</p>
                        </div>
                    </div>
                ) : (
                    <div className="board-wrapper">
                        {/* Score Header */}
                        <div className="score-header">
                            <div className="score-badge red-badge">红队: {redLeft}</div>
                            {/* Dynamic turn indicator */}
                            {!isGameOver && (
                                <div className={`turn-indicator ${room?.current_turn}-turn`}>
                                    当前回合: {room?.current_turn === 'red' ? '红队' : '蓝队'}
                                </div>
                            )}
                            <div className="score-badge blue-badge">蓝队: {blueLeft}</div>
                        </div>

                        {/* End Turn Control */}
                        {!isGameOver && role === 'operative' && (
                            <div className="turn-controls" style={{ display: 'flex', justifyContent: 'center', margin: '-10px 0 10px' }}>
                                <button className="end-turn-btn" onClick={handleEndTurn}>
                                    结束当前回合
                                </button>
                            </div>
                        )}

                        {isGameOver && (
                            <div className={`game-over-alert over-${room?.winner}`}>
                                🎉 游戏结束！获胜方：{room?.winner === 'red' ? '红队 (Red)' : '蓝队 (Blue)'}
                            </div>
                        )}

                        {/* Grid */}
                        <div className="board-grid">
                            {cards.map(card => {
                                let cardClass = 'card '
                                // Reveal card if it's explicitly revealed, or if game is over, or if view is spymaster
                                const shouldRevealColor = card.is_revealed || isGameOver || role === 'spymaster'

                                if (!card.is_revealed) {
                                    cardClass += 'card-hidden '
                                }

                                if (shouldRevealColor) {
                                    if (card.is_revealed) {
                                        cardClass += `revealed-${card.color} `
                                    } else {
                                        // It's not actually clicked, but we should show color (spymaster or game over)
                                        cardClass += `hint-${card.color} `
                                    }
                                }

                                return (
                                    <button
                                        key={card.id}
                                        className={cardClass}
                                        onClick={() => handleRevealCard(card)}
                                        disabled={card.is_revealed || role === 'spymaster' || isGameOver}
                                    >
                                        <span>{card.word}</span>
                                    </button>
                                )
                            })}
                        </div>

                        {/* Footer Legend */}
                        <div className="legend-footer">
                            <span className="legend-item"><span className="dot red"></span> 红队 ({redLeft})</span>
                            <span className="legend-item"><span className="dot blue"></span> 蓝队 ({blueLeft})</span>
                            <span className="legend-item"><span className="dot neutral"></span> 中立 ({neutralLeft})</span>
                            <span className="legend-item"><span className="dot assassin"></span> 刺客 ({assassinLeft})</span>
                        </div>
                    </div>
                )}
            </main>

            {/* Create Game Modal */}
            {showCreateModal && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <button className="close-btn" onClick={() => setShowCreateModal(false)}>
                            <X size={20} />
                        </button>
                        <h2>创建牌局</h2>

                        <div className="form-group">
                            <label>词库主题 (可选)</label>
                            <input
                                type="text"
                                placeholder="例如：电影、科技、动物..."
                                className="theme-input modal-input"
                                value={theme}
                                onChange={e => setTheme(e.target.value)}
                            />
                        </div>

                        <div className="form-group">
                            <label>难度</label>
                            <div className="toggle-group">
                                {[
                                    { value: '简易', label: '简易' },
                                    { value: '适中', label: '适中' },
                                    { value: '困难', label: '困难' },
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        className={`toggle-btn${difficulty === opt.value ? ' active' : ''}`}
                                        onClick={() => setDifficulty(opt.value)}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="form-group">
                            <label>语言</label>
                            <div className="toggle-group">
                                {[
                                    { value: '中文', label: '中文' },
                                    { value: 'English', label: 'EN' },
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        className={`toggle-btn${language === opt.value ? ' active' : ''}`}
                                        onClick={() => setLanguage(opt.value)}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <button
                            className="new-game-btn generate-btn"
                            onClick={handleCreateRoom}
                            disabled={generating}
                        >
                            <RotateCcw size={16} /> {generating ? '生成中...' : '生成词库并开始'}
                        </button>
                    </div>
                </div>
            )}

            {/* Generating Overlay */}
            {generating && (
                <div className="generating-fullscreen-overlay">
                    <div className="generating-content">
                        <div className="generating-spinner-container">
                            <div className="generating-spinner"></div>
                            <div className="generating-timer">{generateTimer}</div>
                        </div>
                        <div className="generating-text">
                            <h3 className="generating-title">使用 glm-4.7 模型创建中<br />预计需要 1-3 分钟</h3>
                            <p className="generating-subtitle">和朋友们聊聊天吧 ☕</p>
                        </div>
                        <div className="streamed-words-container">
                            <p className="streamed-count">
                                {wordItems.filter(w => w.status === 'confirmed').length > 0
                                    ? `${wordItems.filter(w => w.status === 'confirmed').length} / 25 词已确认`
                                    : wordItems.length > 0
                                        ? `${wordItems.filter(w => w.status !== 'rejected').length} 个候选词`
                                        : 'AI 正在思考中...'
                                }
                            </p>
                            {wordItems.length > 0 && (
                                <div className="streamed-words-grid">
                                    {wordItems.map((item) => (
                                        <span
                                            key={item.word}
                                            className={`streamed-word-tag word-${item.status}`}
                                        >
                                            {item.word}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Generate Failure Modal */}
            {showGenerationFailModal && (
                <div className="modal-overlay">
                    <div className="modal-content generation-fail-modal">
                        <button className="close-btn" onClick={() => setShowGenerationFailModal(false)}>
                            <X size={20} />
                        </button>
                        <h2>本轮生成未成功</h2>
                        <p className="generation-fail-text">
                            由于模型侧不稳定或服务器响应慢导致偶尔生成失败。不急，尝试重新生成即可！
                        </p>
                        <div className="generation-fail-actions">
                            <button
                                className="new-game-btn secondary-action-btn"
                                onClick={() => setShowGenerationFailModal(false)}
                            >
                                知道了
                            </button>
                            <button
                                className="new-game-btn"
                                onClick={() => {
                                    setShowGenerationFailModal(false)
                                    setShowCreateModal(true)
                                }}
                            >
                                再次生成
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
