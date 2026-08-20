# 归档上站：GitHub Pages 方案

把 `archive/` 里逐日累积的早报，编译成一个可以直接用浏览器翻阅的静态站点，
发布到 GitHub Pages。目标只有一个：**不用再去 GitHub 的文件浏览器里点 `.md`。**

---

## 1. 现状与约束

| 事实                                                        | 对方案的影响                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 每期归档同时落 `.md` 和 `.json`，`.json` 是结构化的权威记录 | 站点从 `.json` 生成，不去解析 markdown                                |
| 归档由 `github-actions[bot]` 用 `GITHUB_TOKEN` 推到默认分支 | **这种推送不会触发 `push` 事件的工作流**，必须另找触发器              |
| 仓库公开、免费额度                                          | Pages 可用；不需要自定义域名                                          |
| 项目零构建（`tsx` 直跑 TS）、依赖只有 4 个运行时包          | 不引入 Jekyll / Astro / VitePress，站点生成器自己写，复用现有渲染工具 |
| `archive/**` 已被 eslint / prettier 忽略                    | 生成产物同样不进版本库，只作为 Actions artifact 存在                  |
| `src/render/html.ts` 已有 `escapeHtml` / `safeHref`         | 转义逻辑复用，不重复实现                                              |

### 为什么不用 Jekyll

GitHub Pages 的默认构建会跑 Jekyll。要让它认得 `archive/2026/08/2026-08-20.md`，
得给每个归档文件加 front matter、写 `_config.yml`、再造一套 layout ——
等于把归档文件本身改造成 Jekyll 的输入。归档文件是**推送内容的存证**，
不该为了展示而被改写。所以走 **Actions 构建 + artifact 部署**：归档文件一个字节都不动。

### 为什么不用 `gh-pages` 分支

`peaceiris/actions-gh-pages` 那一类方案会往仓库里再推一个分支，
每天多一个提交、多一份 HTML 的历史。官方的 `upload-pages-artifact` + `deploy-pages`
直接把产物交给 Pages，**不产生任何提交**。仓库历史保持只有「归档」这一条线。

---

## 2. 方案

```
brief.config.yaml ─┐
                   ├─→ pnpm site:build ─→ site/ ─→ upload-pages-artifact ─→ Pages
archive/**/*.json ─┘
```

### 2.1 产物结构

```
site/
├── index.html              全部期数，按月分组，倒序；带即时搜索
├── latest.html             meta-refresh 跳最新一期（可以做书签）
├── feed.xml                RSS 2.0，最近 30 期，可以丢进阅读器订阅
├── 404.html
├── .nojekyll               保险，禁掉任何 Jekyll 处理
├── assets/style.css        唯一一份样式，跟随系统深浅色
└── 2026/08/2026-08-20.html 每期一页，目录结构与 archive/ 一致
```

页面之间**全部用相对链接**。因为项目页的实际地址是
`https://<user>.github.io/daily-brief/`，根绝对路径（`/index.html`）会 404；
相对链接同时让 `site/` 可以直接用 `file://` 打开来预览。

### 2.2 代码结构

| 文件                  | 职责                                                          | 可测 |
| --------------------- | ------------------------------------------------------------- | ---- |
| `src/site/collect.ts` | 扫 `archive/`，把 `.json` 读成 `SiteIssue[]`（注入 `FsLike`） | 是   |
| `src/site/render.ts`  | 纯函数：记录 → HTML / RSS 字符串，无 IO                       | 是   |
| `src/site/build.ts`   | CLI 入口：读配置、落盘、打印统计                              | —    |

沿用仓库既定分工：IO 在边缘、逻辑在纯函数、测试只测纯函数（依赖注入 `FsLike`）。

### 2.3 章节标题

归档 JSON 的 `items[].section` 存的是 **section id**，不存标题。
渲染时从 `brief.config.yaml` 取标题；配置里已经删掉的历史 section
**回退显示 id**，而不是丢弃条目 —— 老期数不能因为配置改了就残缺。

### 2.4 搜索

`index.html` 每一行带一个 `data-q` 属性，内容是该期的日期 + 全部条目标题，
输入框做纯前端子串过滤（无依赖、无网络请求）。

代价是索引页体积随期数线性增长：约 13 条/期 × 60 字符 ≈ 每年 300KB。
几年内无所谓。**真到了嫌重的那天**，把 `data-q` 拆成单独的 `search.json`
按需 fetch 即可，`renderIndexPage` 是纯函数，改起来是局部的。

---

## 3. 触发链路（这是最容易踩坑的部分）

```
cron 08:00 ─→ daily-brief ─→ bot 提交 archive/ ─→ [workflow_run] ─→ pages ─→ 部署
```

`pages.yml` 有三个触发器，各自补一个洞：

| 触发器                         | 覆盖的场景                   | 为什么单靠它不够                                       |
| ------------------------------ | ---------------------------- | ------------------------------------------------------ |
| `workflow_run: [daily-brief]`  | 每天的自动归档               | 只在 daily-brief 跑完时触发，改站点代码不会重建        |
| `push` on `main`（限定 paths） | 人手改站点代码 / 模板 / 配置 | **抓不到 bot 的归档提交**（`GITHUB_TOKEN` 推送不触发） |
| `workflow_dispatch`            | 手动重建                     | 需要人点                                               |

### 三个必须记住的细节

1. **`workflow_run` 的 `github.sha` 是触发方运行时的 SHA，不含那次归档提交。**
   直接 checkout 默认 ref 会拿到「归档提交之前」的树，站点上永远少最新一期。
   所以 checkout 必须显式 `ref: main`。

2. **不按 `conclusion` 过滤。**
   daily-brief 里 `commit archive` 是 `if: always()` —— 推送失败但内容已归档时，
   整个 run 是红的，但归档是有的。红了也要发布。

3. **`concurrency: group: pages, cancel-in-progress: false`。**
   Pages 的部署是串行资源，取消进行中的部署会留下半成品状态。

---

## 4. 一次性设置

1. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
   （不是 "Deploy from a branch"。选错了 `deploy-pages` 会报
   `Not Found` 或 `Resource not accessible`。）
2. 仓库必须是 **public**（免费额度下 Pages 只对公开仓库开放）。
3. 无需任何新 secret。`pages.yml` 用的是 OIDC（`id-token: write`），
   不碰 SMTP / WeCom 那一组。

站点地址：`https://<user>.github.io/daily-brief/`
首次部署完成后，Actions 那次 run 的 summary 里会直接给出 URL。

---

## 5. 权限

```yaml
permissions:
  contents: read # 只读仓库，站点工作流永远不写回
  pages: write # 创建部署
  id-token: write # OIDC，deploy-pages 用它换部署凭证
```

比 `daily-brief.yml` 的 `contents: write` 更弱。站点工作流**不可能**改动归档 ——
这是刻意的：展示层出 bug 不该有能力污染存证。

---

## 6. 本地预览

```bash
pnpm site:build              # 产物写到 site/
open site/index.html         # 相对链接，file:// 直接能翻
```

`site/` 进 `.gitignore`：它是纯派生物，任何时候都能从 `archive/` 重新生成，
进版本库只会制造 diff 噪音。

---

## 7. 注意事项

- **站点是派生物，不是数据源。** 归档 `.json` 才是。站点整个删掉重建没有任何损失。
- **归档为空时站点照样能建**，`index.html` 显示「暂无归档」而不是构建失败。
  第一次配 Pages 时不必等到有内容。
- **损坏的归档文件被跳过而不是让构建挂掉**（沿用 `parseArchiveRecord` 的容错），
  但会在构建日志里计数。一条都读不出来时才值得去查。
- **告警文本已经在写归档时脱敏过**（`redactDeep`），站点直接透出即可，
  不需要在展示层再做一次。
- **`.md` 归档仍然照常生成。** 站点没有取代它，只是多了一个入口 ——
  邮件、WeCom、`.md`、站点四条路读的是同一份 `.json`。
- **Pages 有部署配额**（软限制约每小时 10 次部署）。正常一天 1～2 次，
  只有在短时间内反复手动重建时才可能撞上。
