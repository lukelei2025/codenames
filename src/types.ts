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
