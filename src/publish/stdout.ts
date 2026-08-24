import type { Publisher, PublisherContext } from './types'

/**
 * The `--dry-run` target: prints what would be posted and invents a stable id.
 *
 * The id is derived from the article rather than random so a dry run twice in a row
 * produces the same state, which is what makes `--dry-run --no-commit` a safe way to
 * look at the idempotency decision itself.
 */
export function createStdoutPublisher(ctx: PublisherContext): Publisher {
  const log = ctx.log ?? ((message: string) => console.log(message))
  return {
    name: 'stdout',
    missingEnv() {
      return []
    },
    async createDraft(article) {
      log(`\n${'='.repeat(72)}`)
      log(`${article.scheduleId} · ${article.publishDate} — ${article.title}`)
      log(`brief:     ${article.brief}`)
      log(`tags:      ${article.tags.join(', ') || '(none)'}`)
      log(`canonical: ${article.canonicalUrl || '(none)'}`)
      log(`hash:      ${article.contentHash}`)
      log('-'.repeat(72))
      log(article.markdown)
      return { postId: `dry-${article.contentHash}` }
    },
    async updateDraft(postId, article) {
      log(`[dry-run] would update ${postId} (${article.title})`)
    },
  }
}
