import type { ExtractConfig, Item } from '../config/schema'
import { extractArticle, type ExtractFetch } from '../enrich/extract'
import {
  dramaSection,
  isDramaBusiness,
  isDramaOfficial,
  isDramaRelease,
  staleDramaHeadline,
} from './classify'

export interface DramaEvidence {
  text: string
  kind: 'fulltext' | 'excerpt'
}

// Require an operation together with a concrete artefact, parameter or execution detail.
const OPERATION =
  /下载|安装|导入|加载|运行|设置|调整|生成|导出|部署|连接|执行|编写|绘制|剪辑|配音|合成|拆解|download|install|import|load|run|set|generate|export|deploy|connect|write|draft|edit|render/gi
const ARTEFACT =
  /剧本|镜头|字幕|音轨|时间线|参数|节点|工作流|参考图|提示词|分镜表|命令|脚本|素材|分辨率|帧率|采样|parameter|node|workflow|reference image|prompt|command|script|resolution|fps|checkpoint|GPU|storyboard|timeline/i
const MEASURED =
  /对比结果|测试条件|显存|耗时|延迟|measured|benchmark results|latency|VRAM|seconds per|test setup|\d+(?:\.\d+)?\s*(?:fps|ms|GB|秒)/i
const CHANGE =
  /新增|修复|支持|改进|接入|开源|版本|release|added|fixed|support|improv|version|changelog/i

export function assessDramaItem(item: Item, evidence: DramaEvidence, now: Date): Item | null {
  if (staleDramaHeadline(item, now)) return null
  const text = evidence.text
  const section = dramaSection(item)
  if (!section) return null
  const tutorial = section === 'drama-tutorials'
  const review = /对比|评测|comparison|tested|benchmark/i.test(item.title)
  if (tutorial && (!ARTEFACT.test(text) || [...text.matchAll(OPERATION)].length < 2)) return null
  if (
    section === 'drama-tools' &&
    !isDramaRelease(item) &&
    (review ? !MEASURED.test(text) : !CHANGE.test(text))
  )
    return null
  const difficulty = /API|部署|脚本|代码|GPU|显存|deploy|script|python/i.test(
    `${item.title} ${text}`,
  )
    ? '开发'
    : /一致性|口型|工作流|consistency|lip.sync|workflow/i.test(`${item.title} ${text}`)
      ? '进阶'
      : '入门'
  return {
    ...item,
    editorial: {
      kind: tutorial
        ? 'tutorial'
        : section === 'drama-tools'
          ? review
            ? 'review'
            : 'release'
          : 'news',
      evidence: evidence.kind,
      ...(tutorial ? { difficulty } : {}),
      reason: tutorial
        ? '包含具体操作与制作素材、参数或工作流线索。'
        : section === 'drama-tools'
          ? isDramaOfficial(item)
            ? '来自已配置的官方技术来源。'
            : '包含更新说明或测试依据。'
          : isDramaBusiness(item)
            ? '行业经营动态，作为背景参考。'
            : '与制作、作品案例或发布环节有关。',
      action: tutorial
        ? '打开原文，按步骤完成一个最小示例并保存结果。'
        : section === 'drama-tools'
          ? '核对版本、使用条件和授权，再判断是否用于当前练习。'
          : '阅读原文，记录对选题、制作或发布的一项影响。',
    },
  }
}

/** Bounded independently of LLM availability; extracted text is reused, never archived. */
export async function inspectDramaCandidates(
  items: Item[],
  options: {
    now: Date
    fetchImpl?: ExtractFetch
    config: ExtractConfig
    maxChars: number
    planOnly?: boolean
  },
): Promise<{
  items: Item[]
  evidence: Map<string, DramaEvidence>
  rejected: number
  fulltext: number
}> {
  const evidence = new Map<string, DramaEvidence>()
  const accepted = new Map<string, Item>()
  let next = 0
  let fulltext = 0
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (;;) {
        const item = items[next++]
        if (!item) return
        let input: DramaEvidence = { text: item.excerpt ?? '', kind: 'excerpt' }
        // Official release feeds already supply the change log. News needs no extra request.
        if (
          options.fetchImpl &&
          !options.planOnly &&
          item.section !== 'drama-news' &&
          !isDramaRelease(item) &&
          !isDramaBusiness(item)
        ) {
          try {
            const article = await extractArticle(item.url, {
              fetchImpl: options.fetchImpl,
              config: { ...options.config, timeoutMs: Math.min(options.config.timeoutMs, 6000) },
              maxChars: options.maxChars,
            })
            input = { text: article.text, kind: 'fulltext' }
            fulltext++
          } catch {
            /* RSS evidence remains visibly weaker; no invented steps. */
          }
        }
        evidence.set(item.id, input)
        const result = assessDramaItem(item, input, options.now)
        if (result) accepted.set(item.id, result)
      }
    }),
  )
  return {
    items: items.flatMap((i) => (accepted.has(i.id) ? [accepted.get(i.id)!] : [])),
    evidence,
    rejected: items.length - accepted.size,
    fulltext,
  }
}
