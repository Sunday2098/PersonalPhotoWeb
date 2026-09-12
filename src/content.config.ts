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
  }),
});

// 照片(Photo)—— PRD V1.1 §7 接口
const photos = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/photos" }),
  schema: z.object({
    id: z.string(),
    title: z.string().optional().nullable(), // 照片标题(nullable 容忍 YAML 空值 null,防手改清空标题导致构建失败)
    filename: z.string(), // 图片文件名(Cloudinary photos/ 下)
    alt: z.string().optional(), // 图片描述(无障碍/SEO)
    // 图片元信息:由 scripts/backfill-image-meta.mjs 从 Cloudinary 回填
    //   width/height —— 供 <img> 预留空间(防加载重排)与 srcset 定档
    //   color        —— 主色,图片解码前作为瓦片底色(替代原来的灰方块)
    width: z.number().optional(),
    height: z.number().optional(),
    color: z.string().optional(),
    date: z.string(), // 拍摄日期 YYYY-MM-DD(首页排序用)
    project: z.string(), // 所属项目 id
    featured: z.boolean().optional(), // 首页精选墙标记(PRD V1.2:首页展示带此标记的最新 12 张)
    exif: z
      .object({
        camera: z.string().optional(),
        focalLength: z.string().optional(),
        aperture: z.string().optional(),
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
  }),
});

export const collections = { projects, photos, featured };
