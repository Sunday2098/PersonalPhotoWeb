import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// 项目(Project)—— 作品集的核心组织单位(PRD V1.1 §7)
// 数据源:src/content/projects/*.md
// 注:站点定位为影像作品集,MD 正文不渲染;项目文字一律用 description(一句话简介)
const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/projects" }),
  schema: z.object({
    id: z.string(), // 唯一标识,用于 URL
    title: z.string(), // 项目标题
    // 一句话简介:显示在项目详情页标题下方(可留空,留空则不显示该行)
    // nullable 容忍 YAML 空值 null,防后台工具留空简介导致构建失败
    description: z.string().optional().nullable(),
    coverImage: z.string(), // 封面图文件名(Cloudinary photos/ 下)
    // 日期/地点非必填(可留空,页面不显示;nullable 容忍 YAML 空值 null)
    date: z.string().optional().nullable(), // 拍摄时间范围,如 "2026.04"
    location: z.string().optional().nullable(), // 拍摄地点
    // 可见性:public 公开 / private 私密 / draft 草稿 —— 非 public 的项目
    // 不参与构建(列表、详情页、首页精选墙都不出现)。缺省视为 public,
    // 老数据没有这一行,行为与之前一致。
    visibility: z.enum(["public", "private", "draft"]).optional().nullable(),
    // 后台拖拽排序:数字小的排前面。缺省(老数据)落回按 date 倒序。
    order: z.number().optional().nullable(),
  }),
});

// 照片(Photo)—— PRD V1.1 §7 接口
const photos = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/photos" }),
  schema: z.object({
    id: z.string(),
    title: z.string().optional().nullable(), // 照片标题(nullable 容忍 YAML 空值 null,防手改清空标题导致构建失败)
    filename: z.string(), // 图片文件名(Cloudinary photos/ 下)
    alt: z.string().optional().nullable(), // 图片描述(无障碍/SEO)
    // 拍摄地点与标签(后台编辑面板填写)。标签写成单行 flow 数组:
    //   tags: ["古建筑", "山西"]
    // 供项目页前端筛选,不参与构建期逻辑。
    location: z.string().optional().nullable(),
    tags: z.array(z.string()).optional().nullable(),
    // 图片元信息:由 scripts/backfill-image-meta.mjs 从 Cloudinary 回填
    //   width/height —— 供 <img> 预留空间(防加载重排)与 srcset 定档
    //   color        —— 主色,图片解码前作为瓦片底色(替代原来的灰方块)
    //   bytes/uploadedAt —— 后台列表视图展示用(老数据缺,显示「—」)
    width: z.number().optional(),
    height: z.number().optional(),
    color: z.string().optional(),
    bytes: z.number().optional().nullable(),
    uploadedAt: z.string().optional().nullable(),
    date: z.string(), // 拍摄日期 YYYY-MM-DD(首页排序用)
    project: z.string(), // 所属项目 id
    featured: z.boolean().optional(), // 首页精选墙标记(PRD V1.2:首页展示带此标记的最新 12 张)
    // 后台拖拽排序:数字小的排前面。缺省(老数据)落回按 date 倒序。
    order: z.number().optional().nullable(),
    // 灯箱里是否展示拍摄参数(相机 · 镜头 · 焦距 · 光圈 · 快门 · ISO)。
    // 缺省 = 不显示:老数据没有这一行,放大视图与之前完全一致;想给哪张展开就开哪张。
    // 拍照参数本身由 exif 承载,这个开关只管「要不要露出来」。
    showExif: z.boolean().optional(),
    exif: z
      .object({
        camera: z.string().optional(),
        lens: z.string().optional(), // 镜头型号(EXIF LensModel)
        focalLength: z.string().optional(),
        aperture: z.string().optional(), // 光圈,如 "f/1.8"
        shutter: z.string().optional(), // 快门,如 "1/125" / "1.3s"
        iso: z.number().optional(),
      })
      .optional(),
  }),
});

// 首页 Hero 轮播图(PRD V1.2):独立路径便于后期维护,不属于任何项目
// 数据源:src/content/featured/*.md,图片同样托管在 Cloudinary photos/ 下
const featured = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/featured" }),
  schema: z.object({
    id: z.string(),
    title: z.string().optional().nullable(),
    filename: z.string(),
    alt: z.string().optional(),
    // 同 photos:由 scripts/backfill-image-meta.mjs 回填,首屏预留空间用
    width: z.number().optional(),
    height: z.number().optional(),
    color: z.string().optional(),
    date: z.string().optional().nullable(), // 排序用,可留空
    // 后台拖拽排序:数字小的排前面(轮播从前往后播)。缺省落回按 date 倒序。
    order: z.number().optional().nullable(),
  }),
});

// 站点设置(后台「全局设置」写入):站点名、页脚、备案号、社交链接。
// 数据源:src/content/site/site.md。所有字段可留空 —— 留空时由
// src/lib/site.ts 回落到 src/config.ts 里的默认值,建好文件不填也不影响站点。
const site = defineCollection({
  loader: glob({ pattern: "site.md", base: "./src/content/site" }),
  schema: z.object({
    title: z.string().optional().nullable(), // 站点名(导航/页脚/浏览器标题)
    description: z.string().optional().nullable(), // 默认 meta description
    logo: z.string().optional().nullable(), // 站标图片 URL(留空则用站点名文字)
    footerText: z.string().optional().nullable(), // 页脚版权行
    icp: z.string().optional().nullable(), // 备案号(留空不渲染该行)
    socialXhs: z.string().optional().nullable(), // 小红书主页链接
    socialInstagram: z.string().optional().nullable(),
    contactEmail: z.string().optional().nullable(), // 邮箱(不带 mailto:)
  }),
});

export const collections = { projects, photos, featured, site };
