import type { Channel, ChannelContext, SendInput } from './types'

/** The M0 "channel": prints to the terminal. Also what every recipient becomes under --dry-run. */
export function createStdoutChannel(ctx: ChannelContext): Channel {
  const log = ctx.log ?? ((message: string) => console.log(message))
  return {
    name: 'stdout',
    missingEnv() {
      return []
    },
    async send({ title, body, recipient }: SendInput) {
      log(`\n${'='.repeat(72)}`)
      log(`to: ${recipient.id} (${recipient.channel}, ${recipient.format}) — ${title}`)
      log(`sections: ${recipient.sections.join(', ')}`)
      log('-'.repeat(72))
      log(body)
    },
  }
}
