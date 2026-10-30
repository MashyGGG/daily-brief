import type { RawItem } from '../config/schema'

export const DRAMA_SECTIONS = new Set(['drama-news', 'drama-tutorials', 'drama-tools'])

const PRODUCTION =
  /AI\s*(?:短剧|漫剧|漫画|动画|视频|電影|电影)|人工智能.{0,8}(?:短剧|漫剧|视频|动画)|动态漫|图生视频|文生视频|角色一致|分镜|口型同步|配音|\b(?:AI|generative)\s+(?:film\w*|video|animation)|motion comic|image.to.video|text.to.video|character consistency|lip.sync|storyboard|ComfyUI|Seedance|可灵|即梦|混元视频|万相|HunyuanVideo|LTX[- ]?(?:Video|2)|\bWan\s*\d|\b(?:Veo|Pika|Kling|Hailuo|Runway)\b|Firefly|MiniMax\s*H\d|CosyVoice|FLUX|Qwen.?Image/i
const INSTRUCTION =
  /教程|教学|指南|实战|实操|实测|如何|怎么|制作流程|分镜解析|\btutorial\b|\bhow (?:to|i|we)\b|\bguide\b|step.by.step|walkthrough/i
const WORKFLOW = /工作流|workflow|deep dive/i
const SPECULATION = /未来.{0,8}(?:怎么|如何)|何去何从|三国杀|争霸|护城河/i
const ANNOUNCEMENT =
  /发布|上线|更新|模型|工具|\brelease\b|\bmodel\b|\blaunch\w*\b|\bintroduc\w*\b|now available/i
const TOOL =
  /模型|工具|工作室|model|generator|editing|ComfyUI|Seedance|可灵|即梦|HunyuanVideo|LTX|Wan\s*\d|Veo|Pika|Firefly/i
const EXCLUDE = /躺赚|暴富|加盟代理|培训招生|guaranteed income/i
const RELEASES = new Set(['drama-comfyui', 'drama-ltx'])
const DIRECT = new Set(['drama-comfy-tutorials', 'drama-hf-tutorials'])

/** Editorial heuristics, before dedupe. The source name alone never makes an article a tutorial. */
export function dramaSection(item: RawItem): string | null {
  if (RELEASES.has(item.source)) return 'drama-tools'
  const text = `${item.title}\n${item.excerpt ?? ''}`
  if (EXCLUDE.test(text)) return null
  // Aggregator descriptions often repeat broad keywords; require a production subject in the headline.
  if (!PRODUCTION.test(DIRECT.has(item.source) ? text : item.title)) return null
  if (
    !SPECULATION.test(item.title) &&
    (INSTRUCTION.test(item.title) || (WORKFLOW.test(item.title) && !ANNOUNCEMENT.test(item.title)))
  ) {
    return 'drama-tutorials'
  }
  if (
    item.source.endsWith('-models') ||
    DIRECT.has(item.source) ||
    (ANNOUNCEMENT.test(item.title) && TOOL.test(item.title))
  ) {
    return 'drama-tools'
  }
  return 'drama-news'
}

/** Prefer original tutorials to aggregator copies, while keeping their actual source identity. */
export function dramaSourcePriority(item: RawItem): number {
  return (dramaSection(item) === 'drama-tutorials' ? 2 : 0) + (DIRECT.has(item.source) ? 1 : 0)
}
