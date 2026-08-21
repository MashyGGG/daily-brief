import type { BriefDigest, Item } from '../config/schema'

export interface BriefSection {
  id: string
  title: string
  items: Item[]
}

/** The rendered-ready shape: what one schedule produced on one day. */
export interface Brief {
  /** Local date (per config timezone), `YYYY-MM-DD`. */
  date: string
  scheduleId: string
  /** Suffix used on archive filenames when more than one schedule is enabled. */
  slot: string | null
  title: string
  timezone: string
  generatedAt: string
  lookbackHours: number
  sections: BriefSection[]
  /** §9 M3 — the whole-issue 导读, when the model wrote one. */
  digest?: BriefDigest
  warnings: string[]
}

export function totalItems(brief: Pick<Brief, 'sections'>): number {
  return brief.sections.reduce((sum, s) => sum + s.items.length, 0)
}

/** Sections with nothing in them are dropped before rendering — no empty headings. */
export function nonEmptySections(brief: Pick<Brief, 'sections'>): BriefSection[] {
  return brief.sections.filter((s) => s.items.length > 0)
}

/** Only the sections this recipient/schedule subscribes to. */
export function restrictSections(brief: Brief, sectionIds: string[]): Brief {
  if (sectionIds.includes('*')) return brief
  return { ...brief, sections: brief.sections.filter((s) => sectionIds.includes(s.id)) }
}

/** Local `YYYY-MM-DD` for a timezone, without pulling in a date library. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  return parts
}

/** Local `HH:MM` for a timezone. */
export function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
}

export function itemsOf(brief: Pick<Brief, 'sections'>): Item[] {
  return brief.sections.flatMap((s) => s.items)
}
