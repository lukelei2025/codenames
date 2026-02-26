export type Team = 'red' | 'blue'
export type CardColor = 'red' | 'blue' | 'neutral' | 'assassin'
export type Role = 'spymaster' | 'operative'

export interface Room {
    id: string
    created_at: string
    theme: string
    language: string
    current_turn: Team
    winner: Team | null
}

export interface Card {
    id: string
    room_id: string
    word: string
    color: CardColor
    is_revealed: boolean
    position: number
}

export interface TurnClickLog {
    id: string
    room_id: string
    turn_team: Team
    card_word: string
    card_color: CardColor
    is_correct: boolean
    created_at: string
}
