import { buildPromptZh } from './prompt-zh.ts'
import { buildPromptEn } from './prompt-en.ts'

const isEnglishLanguage = (language: string): boolean => {
  const normalized = (language || '').trim().toLowerCase()
  return normalized === 'english' || normalized === 'en' || normalized === '英文' || normalized === '英语'
}

export function buildPrompt(language: string, theme: string, difficulty: string, seed: number): string {
  if (isEnglishLanguage(language)) {
    return buildPromptEn(language, theme, difficulty, seed)
  }
  return buildPromptZh(language, theme, difficulty, seed)
}
