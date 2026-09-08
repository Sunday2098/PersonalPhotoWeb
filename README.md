# 夏至未至 · 个人摄影分享网站

基于 [Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com) 的个人摄影站,
按 `../03-个人摄影网站产品需求文档V1.2.md` 实现。

设计方向:纯白 / 纯黑双主题(导航栏可切换),陶土 `#C4A882` 点缀;
以"项目"组织作品(10 个专题),图片全部托管 [Cloudinary](https://cloudinary.com),
GitHub → Cloudflare Pages 自动部署。

## 快速开始

```bash
npm install
npm run dev        # 开发模式 http://localhost:4321
npm run build      # 静态构建,输出到 dist/
npm run preview    # 预览构建产物
```

## 页面

| 路由 | 说明 |
|------|------|
| `/` | 首页:全宽 Hero 轮播(点击左右淡入淡出)+ 12 张精选墙(原始比例、悬停光晕、点击放大) |
| `/projects/` | 项目列表:封面 + 标题 + 一句话简介 + 拍摄时间/地点 |
| `/projects/[slug]/` | 项目详情:照片瀑布流,点击开灯箱 |
| `/about/` | 关于:自我介绍 + 常用器材清单 |

**灯箱**(PRD V1.2 §4.4):深色背景;左上角 当前序号/总数;右上角 全屏 / 放大(1x↔2x)/ 关闭;
←/→ 切换(桌面端箭头在图片外两侧,移动端在底部控制条);ESC / 点击图片外关闭;触屏滑动;加载占位动画。

**暗色模式**:导航栏太阳/月亮按钮切换纯白 / 纯黑;首次默认浅色,选择后记忆到本地。

## 首页内容维护

- **Hero 轮播图**来自独立集合 `src/content/featured/`(单独路径便于维护):
  ```bash
  node scripts/add-photos.mjs --featured   # 把 inbox/ 里的图导入为 Hero 图
  ```
- **12 张精选墙**:在 `src/content/photos/*.md` 里加一行 `featured: true`,
  首页自动取带标记的最新 12 张(按拍摄日期),原始比例不裁切。

## 一键添加照片(推荐)

把新照片丢进 `inbox/` 文件夹,运行脚本,其余自动完成:

```bash
node scripts/add-photos.mjs                     # 交互式选择归属项目
node scripts/add-photos.mjs --project shan-yu-hu  # 直接指定项目
node scripts/add-photos.mjs --featured          # 导入为首页 Hero 轮播图
node scripts/add-photos.mjs --no-build          # 跳过自动构建
```

脚本自动:读取 EXIF(相机 / 焦距 / ISO / 拍摄时间)→ 上传 Cloudinary →
生成内容 .md → 删除本地原图 → 重新构建。
超过 Cloudinary 上传上限(10MB)的图片会自动压缩到 1920px(JPEG q82)后上传。
标题默认留空,想命名就编辑生成的 `.md` 里的 `title`。

## 后台管理(本地工具,不出现在网站上)

图形化整理照片归属、新建项目:

```bash
npm run admin   # 启动后浏览器打开 http://127.0.0.1:8787
```

- 把照片**拖拽**到左侧项目卡片即移动项目;或点选多张照片后点击目标项目
- "新建项目"按钮图形化建项目(标题必填,id 留空自动生成)
- 改动直接写入 `src/content/*.md`,完成后照常 `git push` 上线
- 服务只监听本机(127.0.0.1),不参与构建部署,摄影网站上完全看不到

## 手动添加照片 / 项目

1. 先把图片上传到 Cloudinary(public_id = `photos/<文件名>`,不带扩展名),
   再在 `src/content/photos/` 新建 `.md`:

```markdown
---
id: dsc-1234
title: ""              # 空标题必须带引号
filename: dsc-1234.jpg
date: "2025-03-14"     # 日期必须带引号
project: gu-jian-da-guan
featured: true         # 可选:首页精选墙标记
exif:
  camera: NIKON Z 5
  focalLength: 200mm
  iso: 640
---
```

2. 新项目则在 `src/content/projects/` 新建 `.md`,frontmatter 为
   `id / title / description / coverImage / date / location`。
3. 重新 `npm run build`。

> YAML 注意:`date` 等值要加引号;清空标题写 `title: ""`;裸写 `title: ` 会被解析成 null。

## 图片(Cloudinary CDN)

- 全部图片托管 Cloudinary,本地不存图;URL 统一由 `src/lib/images.ts` 生成:
  `f_auto,q_auto,w_{宽度}` —— 自动最优格式(WebP/AVIF)+ 按需压缩。
- 宽度档位:缩略图 800w / 首页精选 1200w / Hero 与灯箱大图 1600w。
- 图片均带 `loading="lazy"`(Hero 首图 `fetchpriority="high"` 优先加载)。

## 部署

`git push` 到 GitHub master 即触发 Cloudflare Pages 自动构建,无需其他操作。
Cloudflare Pages 环境变量需配置 `PUBLIC_CLOUDINARY_CLOUD_NAME`(本地则在 `.env`)。

## 注意事项

- ⚠️ **系统时钟要准**:Cloudinary 上传签名依赖本机时间,偏差超 1 小时报 `Stale request`,同步时间再跑。
- `.env`(Cloudinary 密钥)已 gitignore,绝不提交。
- 灯箱与主题切换的内联脚本必须写纯 JS(无 TS 注解)。
- 原图上传后即从本地删除,请自行做好原图备份。

## 目录结构

```
astro-site/
├── astro.config.mjs            # Tailwind Vite 插件
├── scripts/add-photos.mjs      # 一键导入流水线(含 --featured)
└── src/
    ├── content.config.ts       # projects + photos + featured 集合 schema
    ├── content/projects/       # 项目数据(10 个)
    ├── content/photos/         # 照片数据(100+ 张,featured: true 上首页精选墙)
    ├── content/featured/       # 首页 Hero 轮播图(独立路径)
    ├── layouts/BaseLayout.astro    # 导航(项目/关于)+ 主题切换 + 页脚
    ├── components/             # Lightbox(全屏灯箱)/ ProjectCard(项目卡片)
    ├── lib/images.ts           # Cloudinary URL 统一入口
    ├── styles/global.css       # Tailwind 入口 + 双主题 token + 光晕/灯箱样式
    └── pages/                  # index / projects/ / projects/[slug] / about
```

> 上层目录的 `photos/`、`css/`、`js/`、`index.html` 是旧版纯静态站遗留文件,与本项目无关。
