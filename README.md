# 夏至未至 · 个人摄影分享网站

基于 [Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com) 的个人摄影站,
按 `../01-个人摄影网站产品需求文档V1.1.md` 实现。

设计方向:融合 **Anna Venezia 的优雅极简**(大量留白、干净排版、柔和色调:
米白 `#FAFAF8` / 墨色 `#1A1A1A` / 雾灰 `#8A8A8A` / 陶土 `#C4A882`)
与 **Tom Hull 的项目叙事**(以"项目"组织作品,每个项目配拍摄手记文字)。

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
| `/` | 首页:项目照片墙 —— 每个项目精选 1 张(统一比例),每 3 天自动轮换,点击开该项目灯箱 |
| `/projects/` | 项目列表:封面 + 标题 + 一句话简介 + 时间/地点 |
| `/projects/[slug]/` | 项目详情:拍摄手记(Markdown 正文)+ 照片瀑布流,点击开灯箱 |
| `/about/` | 关于:自我介绍 + 常用器材清单 |

**灯箱浏览**(全站通用):←/→ 切换、ESC / 点击外部关闭、触屏左右滑动,
底部显示 标题 · 相机 · 焦距 · ISO(取真实 EXIF)。

**首页 3 天轮换**(纯前端,无需重新部署):按 3 天一个周期,用 (周期号 | 项目 id) 的
哈希对项目照片数取模选图 —— 同一周期内所有访客看到同一张,到周期切换后重新打开页面
即换一张。改 `src/pages/index.astro` 里的 `pickIndex` 时须同步改页面底部内联脚本。

## 一键添加照片(推荐)

把新照片丢进 `inbox/` 文件夹,运行脚本,其余自动完成:

```bash
node scripts/add-photos.mjs                     # 交互式选择归属项目
node scripts/add-photos.mjs --project shan-yu-hu  # 直接指定项目
node scripts/add-photos.mjs --no-build           # 跳过自动构建
```

脚本自动:读取 EXIF(相机 / 焦距 / ISO / 拍摄时间)→ 上传 Cloudinary →
生成 `src/content/photos/<文件名>.md` → 删除本地原图 → 重新构建。
超过 Cloudinary 上传上限(10MB)的图片会自动压缩到 1600px(JPEG q82)后上传。
标题默认留空,想命名就编辑生成的 `.md` 里的 `title`。

## 手动添加新照片 / 新项目

1. 把原图放进 `src/assets/photos/`。
2. 在 `src/content/photos/` 新建 `.md` 文件:

```markdown
---
id: 唯一标识(如 dsc-1234)
title: 照片标题
filename: dsc-1234.jpg
alt: 图片描述
date: "2026-08-28"
project: 所属项目 id
exif:
  camera: NIKON Z 5
  focalLength: 200mm
  iso: 640
---
```

3. 新项目则在 `src/content/projects/` 新建 `.md`,frontmatter 为
   `id / title / description / coverImage / date / location`,
   **手记写在 Markdown 正文**(支持段落、`**加粗**`、`> 引用` 等)。
4. 重新 `npm run build`。

> 注意:`date` 等 YAML 值要加引号(如 `"2026-04-19"`),否则会被解析成日期对象。
> 清空标题时写 `title: ""`(带引号);裸写 `title: ` 会被 YAML 解析成 null,虽然 schema 已容忍,但页面显示会不一致。

## 图片性能(PRD §5.1)

- Astro 构建时自动生成 **WebP** 多档尺寸(缩略图 800w、灯箱大图 1600w,按需加载)。
- 所有图片均带 `loading="lazy"` 懒加载。

## 目录结构

```
astro-site/
├── astro.config.mjs        # Tailwind Vite 插件
├── src/
│   ├── content.config.ts   # projects + photos 内容集合 schema(对应 PRD V1.1 接口)
│   ├── content/projects/   # 项目数据:frontmatter + 拍摄手记正文(Markdown)
│   ├── content/photos/     # 照片数据(Markdown,一处一个文件)
│   ├── assets/photos/      # 原图资源
│   ├── layouts/BaseLayout.astro   # 导航(首页/项目/关于)+ 页脚社交入口
│   ├── components/         # Lightbox(全屏灯箱)/ ProjectCard(项目卡片)
│   ├── lib/images.ts       # 文件名 → Astro 图片资源映射
│   ├── styles/global.css   # Tailwind 入口 + Anna Venezia 主题 token
│   └── pages/              # index / projects/ / projects/[slug] / about
└── public/                 # favicon 等静态资源
```

> 上层目录的 `photos/`、`index.html` 等是旧版纯静态站的遗留文件,与本项目无关。
