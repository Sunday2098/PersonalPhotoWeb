// Cloudinary 图片 URL:照片全部托管在 Cloudinary,本地不再保存图片。
// 原 astro:assets 的多尺寸/WebP 优化由 Cloudinary 的转换参数等价替代:
//   f_auto —— 自动选择最优格式(浏览器支持则给 WebP/AVIF)
//   q_auto —— 自动压缩质量
//   w_     —— 按用途限定宽度(800 缩略图 / 1200 封面 / 1600 灯箱大图)
// Cloud Name 通过构建环境变量注入(Vercel 配置,本地 .env),非敏感信息。
const CLOUD_NAME = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME ?? "";

export function cloudinaryUrl(filename: string, width: number): string {
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto,w_${width}/photos/${filename}`;
}

// 缩略图入口(函数名/参数与旧实现一致,组件无需感知迁移)
export function resolveImage(filename: string): string {
  return cloudinaryUrl(filename, 800);
}
