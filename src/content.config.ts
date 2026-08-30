import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// 项目(Project)—— 作品集的核心组织单位(PRD V1.1 §7)
// 数据源:src/content/projects/*.md,项目介绍文字写在 MD 正文
const projects = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/projects" }),
  schema: z.object({
    id: z.string(), // 唯一标识,用于 URL
    title: z.string(), // 项目标题
    description: z.string(), // 项目简介(一句话)
    coverImage: z.string(), // 封面图文件名(src/assets/photos/ 下)
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
    filename: z.string(), // 图片文件名(src/assets/photos/ 下)
    alt: z.string().optional(), // 图片描述(无障碍/SEO)
    date: z.string(), // 拍摄日期 YYYY-MM-DD(首页排序用)
    project: z.string(), // 所属项目 id
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

export const collections = { projects, photos };
