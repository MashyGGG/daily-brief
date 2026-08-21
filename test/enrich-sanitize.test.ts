import { describe, expect, it } from 'vitest'
import {
  parseModelJson,
  sanitizeResponse,
  sanitizeTakeaways,
  sanitizeText,
} from '../src/enrich/sanitize'

describe('sanitizeText — §6.2, the output goes into a public commit', () => {
  it('drops a bare link', () => {
    expect(sanitizeText('详见 https://evil.example/claim-your-prize 了解更多', 200)).toBe(
      '详见 了解更多',
    )
  })

  it('keeps a markdown link label and throws away the target', () => {
    expect(sanitizeText('[点这里领奖](https://evil.example/x) 是重点', 200)).toBe(
      '点这里领奖 是重点',
    )
  })

  it('drops an image link entirely rather than keeping its alt text as a link', () => {
    expect(sanitizeText('![logo](https://evil.example/a.png) 正文', 200)).toBe('logo 正文')
  })

  it('drops a www link with no scheme', () => {
    expect(sanitizeText('go to www.evil.example/now please', 200)).toBe('go to please')
  })

  it('drops a bare domain that carries a path', () => {
    expect(sanitizeText('see evil.example/pwn for details', 200)).toBe('see for details')
  })

  it('leaves a version ratio alone — it only looks like a path', () => {
    expect(sanitizeText('性能从 1.5/2.0 提升到 3.0', 200)).toBe('性能从 1.5/2.0 提升到 3.0')
  })

  it('leaves a company name that happens to be a domain', () => {
    expect(sanitizeText('由 github.com 团队发布', 200)).toBe('由 github.com 团队发布')
  })

  it('strips HTML tags', () => {
    expect(sanitizeText('<b>粗体</b><script>alert(1)</script> 正文', 200)).toBe(
      '粗体 alert(1) 正文',
    )
  })

  it('strips zero-width and bidi-override characters', () => {
    const sneaky = 'safe\u202Etxet\u202C\u200B text'
    const clean = sanitizeText(sneaky, 200)
    expect(clean).not.toMatch(/[\u200b-\u200f\u202a-\u202e]/)
    expect(clean).toBe('safetxet text')
  })

  it('strips control characters', () => {
    expect(sanitizeText('a\u0000b\u0007c', 200)).toBe('a b c')
  })

  it('drops the label a model prepends', () => {
    expect(sanitizeText('摘要：DeepSeek 发布了新模型', 200)).toBe('DeepSeek 发布了新模型')
    expect(sanitizeText('TL;DR: it shipped', 200)).toBe('it shipped')
  })

  it('enforces maxChars', () => {
    expect([...sanitizeText('x'.repeat(500), 60)].length).toBeLessThanOrEqual(60)
  })

  it('returns an empty string when nothing survives', () => {
    expect(sanitizeText('   <b> </b> https://a.example/b  ', 200)).toBe('')
  })
})

describe('sanitizeTakeaways', () => {
  it('cleans each entry, drops the bullet glyph and caps at three', () => {
    expect(sanitizeTakeaways(['- 第一条', '2. 第二条', '• 第三条', '第四条'], 100)).toEqual([
      '第一条',
      '第二条',
      '第三条',
    ])
  })

  it('ignores non-strings and empties instead of failing', () => {
    expect(sanitizeTakeaways([1, null, '', '真的一条'], 100)).toEqual(['真的一条'])
  })

  it('is not an array — no takeaways', () => {
    expect(sanitizeTakeaways('要点一', 100)).toEqual([])
  })

  it('drops a duplicate entry', () => {
    expect(sanitizeTakeaways(['同一条', '同一条'], 100)).toEqual(['同一条'])
  })
})

describe('parseModelJson', () => {
  it('reads plain JSON', () => {
    expect(parseModelJson('{"summary":"x"}')).toEqual({ summary: 'x' })
  })

  it('reads JSON wrapped in a code fence', () => {
    expect(parseModelJson('```json\n{"summary":"x"}\n```')).toEqual({ summary: 'x' })
  })

  it('digs JSON out of surrounding prose', () => {
    expect(parseModelJson('好的，结果如下：{"summary":"x"} 希望有帮助')).toEqual({ summary: 'x' })
  })

  it('refuses a JSON array — the contract is an object', () => {
    expect(parseModelJson('["a","b"]')).toBeNull()
  })

  it('gives up on prose', () => {
    expect(parseModelJson('抱歉，我无法完成这个请求。')).toBeNull()
  })
})

describe('sanitizeResponse — the whole-answer path', () => {
  it('cleans a well-formed answer', () => {
    const raw = '{"summary":"模型 X 发布","takeaways":["更快","更便宜"]}'
    expect(sanitizeResponse(raw, 180)).toEqual({
      summary: '模型 X 发布',
      takeaways: ['更快', '更便宜'],
    })
  })

  it('uses prose as the summary rather than throwing a usable answer away', () => {
    expect(sanitizeResponse('这条讲的是新版编译器。', 180)).toEqual({
      summary: '这条讲的是新版编译器。',
      takeaways: [],
    })
  })

  it('promotes the first takeaway when the summary field is empty', () => {
    const raw = '{"summary":"","takeaways":["实际要点","第二点"]}'
    expect(sanitizeResponse(raw, 180)).toEqual({ summary: '实际要点', takeaways: ['第二点'] })
  })

  it('returns null when there is nothing left to render', () => {
    expect(sanitizeResponse('{"summary":"","takeaways":[]}', 180)).toBeNull()
    expect(sanitizeResponse('   ', 180)).toBeNull()
  })

  it('strips a link the prompt asked the model not to produce', () => {
    const raw = '{"summary":"详情见 https://evil.example/x","takeaways":["[领奖](https://e.x/y)"]}'
    const clean = sanitizeResponse(raw, 180)!
    expect(clean.summary).not.toContain('http')
    expect(clean.takeaways[0]).toBe('领奖')
  })
})
