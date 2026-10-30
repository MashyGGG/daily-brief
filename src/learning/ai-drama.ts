import type { Brief } from '../core/brief'
import type { BriefConfig } from '../config/schema'
import type { Item } from '../config/schema'

type Stage = NonNullable<BriefConfig['aiDrama']>['stage']

const LESSONS: Record<Stage, NonNullable<NonNullable<Brief['learningReminder']>['lesson']>[]> = {
  observe: [
    {
      title: '从短镜头拼成完整故事',
      url: 'https://help.runwayml.com/hc/en-us/articles/26871350018835-How-to-create-longer-videos-and-films',
      task: '拆解一条喜欢的 30–60 秒作品，记录开头、变化、结尾和每镜时长。',
      doneWhen: '有一张至少 6 镜头的拆解表。',
    },
    {
      title: '分镜先于精细画面',
      url: 'https://runway.com/resources/ai-storyboard',
      task: '写一个原创小故事，用粗图排出 6 个分镜。',
      doneWhen: '不依赖旁人解释也能顺序看懂故事。',
    },
  ],
  practice: [
    {
      title: '第一次可复现的图像生成',
      url: 'https://docs.comfy.org/get_started/first_generation',
      task: '理解参考图、模型和参数；保存一张角色图及生成记录。也可在现用云工具练习。',
      doneWhen: '能找到原始参考图、提示词及工具版本。',
    },
    {
      title: '从静帧到视频镜头',
      url: 'https://docs.comfy.org/tutorials/video/wan/wan2_2',
      task: '先阅读图生视频示例，用自己的角色图做一个 5–10 秒有限运动片段。',
      doneWhen: '导出可播放片段，写下一条失败原因或改进方向。',
    },
  ],
  pilot: [
    {
      title: '先做动态分镜',
      url: 'https://runway.com/resources/ai-storyboard',
      task: '用临时图、临时旁白做 30–60 秒粗剪，只检查叙事与节奏。',
      doneWhen: '找 2 人盲看并记录他们的复述。',
    },
    {
      title: '逐镜生成、统一剪辑',
      url: 'https://help.runwayml.com/hc/en-us/articles/26871350018835-How-to-create-longer-videos-and-films',
      task: '替换粗剪中的一个最终镜头，补齐配音、字幕与授权记录。',
      doneWhen: '手机上检查一次完整预览，无黑帧、截字或声音突变。',
    },
  ],
  publish: [
    {
      title: '核查平台最新发布要求',
      url: 'https://trust.douyin.com/',
      task: '在自己实际发布的平台核查当日 AI 声明、原创和素材要求，保存依据；该链接是抖音入口示例。',
      doneWhen: '发布清单逐项完成，核查日期已记录。',
    },
    {
      title: '发布后只改一个变量',
      url: 'https://github.com/MashyGGG/daily-brief/blob/main/docs/ai-drama/PLAYBOOK.md',
      task: '记录 24/72 小时反馈，从开头、节奏或叙事中只选一个问题修改。',
      doneWhen: '保存作品版本、反馈与下一轮假设。',
    },
  ],
  engineer: [
    {
      title: '复现官方视频工作流',
      url: 'https://docs.comfy.org/tutorials/video/wan/wan2_2',
      task: '先核对设备与官方要求，用首作的同一分镜复现工作流，不满足条件则先记录方案。',
      doneWhen: '保存工作流、模型标识、节点版本及实际耗时或阻塞项。',
    },
    {
      title: '比较云端与开源制作成本',
      url: 'https://github.com/Tencent-Hunyuan/HunyuanVideo',
      task: '阅读官方部署及许可证信息，用同一镜头比较可用率、费用与人工修正时间。',
      doneWhen: '完成一张有条件说明的对照表，再选一个稳定环节自动化。',
    },
  ],
}

const STAGE_KEYWORDS: Record<Stage, string[]> = {
  observe: ['入门', '新手', '案例', '分镜', 'beginner', 'storyboard'],
  practice: ['角色一致', '图生视频', '运镜', '参考图', 'image-to-video', 'character consistency'],
  pilot: ['剪辑', '旁白', '配音', '字幕', '叙事', 'editing', 'storytelling'],
  publish: ['发布', '平台', '版权', '标识', '发行', 'distribution', 'copyright'],
  engineer: ['工作流', '开源', '部署', '显存', '推理', 'workflow', 'inference', 'github'],
}

/** Boost stage relevance without removing other developments or source quotas. */
export function rankForLearning(items: Item[], stage: Stage): Item[] {
  return items.map((item) => {
    const text = `${item.title} ${item.excerpt ?? ''}`.toLowerCase()
    const matches = STAGE_KEYWORDS[stage].filter((word) => text.includes(word)).length
    return {
      ...item,
      rankScore: Math.round(item.rankScore * (1 + Math.min(matches, 3) * 0.15) * 1e6) / 1e6,
    }
  })
}

export const AI_DRAMA_STAGES = {
  observe: {
    title: '了解与选方向',
    task: '今天只精读 1 篇教程，拆解 1 个镜头，记录 1 个可验证的问题；本周完成 5–10 秒练习。',
  },
  practice: {
    title: '单镜头练习',
    task: '固定角色参考图，完成 3 个可剪辑的镜头；记录提示词、版本、失败原因和费用。',
  },
  pilot: {
    title: '完整样片',
    task: '按分镜完成 30–60 秒单角色单场景动态漫，补齐配音、字幕和结尾，并请人盲看复述故事。',
  },
  publish: {
    title: '发布与复盘',
    task: '核查素材授权与平台最新规则，主动声明 AI 生成；发布后记录 24/72 小时表现，每轮只改一个变量。',
  },
  engineer: {
    title: '技术复现与开发',
    task: '复现一个官方工作流；用同一分镜比较云端与开源路线，再自动化一个已稳定的制作环节。',
  },
} as const

export function aiDramaReminder(
  config: BriefConfig,
  repository: string | undefined,
  date?: string,
): NonNullable<Brief['learningReminder']> {
  const stage = config.aiDrama?.stage ?? 'observe'
  const repo =
    repository && /^[\w.-]+\/[\w.-]+$/.test(repository) ? repository : 'MashyGGG/daily-brief'
  const day = date ? Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000) : 0
  const lessons = LESSONS[stage]
  const lesson =
    lessons[Number.isFinite(day) ? ((day % lessons.length) + lessons.length) % lessons.length : 0]!
  return {
    stage: AI_DRAMA_STAGES[stage].title,
    steps: Object.entries(AI_DRAMA_STAGES).map(
      ([id, value], index) =>
        `${index + 1}. ${value.title}${id === stage ? '【当前】' : ''}：${value.task}`,
    ),
    guideUrl: `https://github.com/${repo}/blob/main/docs/ai-drama/PLAYBOOK.md`,
    lesson: {
      ...lesson,
      url: lesson.url.replace('github.com/MashyGGG/daily-brief/', `github.com/${repo}/`),
    },
  }
}
