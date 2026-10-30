import type { RawItem } from '../config/schema'

export const DRAMA_SECTIONS = new Set(['drama-news', 'drama-tutorials', 'drama-tools'])

const PRODUCTION =
  /AI\s*(?:短剧|漫剧|漫画|动画|视频|電影|电影)|人工智能.{0,8}(?:短剧|漫剧|视频|动画)|动态漫|图生视频|文生视频|角色一致|分镜|口型同步|配音|\b(?:AI|generative)\s+(?:film\w*|video|animation)|motion comic|image.to.video|text.to.video|character consistency|lip.sync|storyboard|ComfyUI|Seedance|可灵|即梦|混元视频|万相|HunyuanVideo|LTX[- ]?(?:Video|2)|\bWan\s*\d|\b(?:Veo|Pika|Kling|Hailuo|Runway)\b|Firefly|MiniMax\s*H\d|CosyVoice|FLUX|Qwen.?Image/i
const INSTRUCTION =
  /教程|教学|指南|实战|实操|实测|如何|怎么|制作流程|分镜解析|\btutorial\b|\bhow (?:to|i|we)\b|\bguide\b|step.by.step|walkthrough/i
const WORKFLOW = /工作流|workflow|deep dive/i
const SPECULATION = /未来.{0,8}(?:怎么|如何)|何去何从|三国杀|争霸|护城河/i
const ANNOUNCEMENT =
  /发布|上线|更新|模型|工具|\brelease\b|\bmodel\b|\blaunch\w*\b|\bintroduc\w*\b|now available|first agent/i
const TOOL =
  /模型|工具|工作室|model|generator|editing|workflow|image.to.video|ComfyUI|Seedance|可灵|即梦|HunyuanVideo|LTX|Wan\s*\d|Veo|Pika|Firefly/i
const EXCLUDE = /躺赚|暴富|加盟代理|培训招生|guaranteed income/i
const HEADLINE_NOISE =
  /宝藏资源|全套教程|傻瓜式|扫码领取|私信领取|资料包|医生|就医|黄金救治|熬夜|沉迷|电子饲料|\bresource pack\b/i
const NEWS_VALUE =
  /制作|作品|案例|创作|发布|平台|版权|授权|标识|发行|出海|比赛|大赛|征集|政策|规范|成本|filmmaking|production|creat|publishing|copyright|licens|festival|distribution|policy/i
const BUSINESS =
  /财报|亏损|融资|营收|增收|销售费用|发财|净利|股价|主题前瞻|产业规模|商业|牌桌|护城河|争霸|三国杀|financial|revenue|funding|business model|market size/i
const COMPARISON = /对比|评测|基准|benchmark|comparison|tested/i
const CHANGE =
  /发布|上线|更新|新增|接入|支持|开源|\brelease\b|\blaunch\w*\b|introduc\w*|now available|adds?\b/i
const RELEASES = new Set(['drama-comfyui', 'drama-ltx'])
const DIRECT = new Set(['drama-comfy-tutorials', 'drama-hf-tutorials'])

/** Editorial heuristics, before dedupe. The source name alone never makes an article a tutorial. */
export function dramaSection(item: RawItem): string | null {
  const text = `${item.title}\n${item.excerpt ?? ''}`
  if (EXCLUDE.test(text) || HEADLINE_NOISE.test(item.title)) return null
  if (RELEASES.has(item.source)) return 'drama-tools'
  // Aggregator descriptions often repeat broad keywords; require a production subject in the headline.
  if (!PRODUCTION.test(DIRECT.has(item.source) ? text : item.title)) return null
  if (
    !SPECULATION.test(item.title) &&
    !BUSINESS.test(item.title) &&
    (INSTRUCTION.test(item.title) || (WORKFLOW.test(item.title) && !ANNOUNCEMENT.test(item.title)))
  ) {
    return 'drama-tutorials'
  }
  if (
    !BUSINESS.test(item.title) &&
    ((DIRECT.has(item.source) && ANNOUNCEMENT.test(item.title)) ||
      (CHANGE.test(item.title) && TOOL.test(item.title)) ||
      COMPARISON.test(item.title))
  ) {
    return 'drama-tools'
  }
  if (item.source.endsWith('-models') && !BUSINESS.test(item.title)) return null
  if (/\bbest\b|\btop[ -]\d|工具榜单|工具排行/i.test(item.title)) return null
  return BUSINESS.test(item.title) || NEWS_VALUE.test(item.title) ? 'drama-news' : null
}

/** Prefer original tutorials to aggregator copies, while keeping their actual source identity. */
export function dramaSourcePriority(item: RawItem): number {
  return (dramaSection(item) === 'drama-tutorials' ? 2 : 0) + (DIRECT.has(item.source) ? 1 : 0)
}

/** Business coverage is capped separately from production and publishing news. */
export function isDramaBusiness(item: RawItem): boolean {
  return BUSINESS.test(item.title) && !/版权|授权|标识|copyright|licens/i.test(item.title)
}

export function isDramaRelease(item: RawItem): boolean {
  return RELEASES.has(item.source)
}

export function isDramaOfficial(item: RawItem): boolean {
  return DIRECT.has(item.source) || RELEASES.has(item.source)
}

/** A current feed date does not make a dated headline a new development. */
export function staleDramaHeadline(item: RawItem, now: Date): boolean {
  if (RELEASES.has(item.source)) return false
  const years = [...item.title.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]))
  return years.some((year) => year < now.getUTCFullYear() - 1)
}
