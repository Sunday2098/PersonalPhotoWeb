// Cloudinary 图片 URL:照片全部托管在 Cloudinary,本地不再保存图片。
// 原 astro:assets 的多尺寸/WebP 优化由 Cloudinary 的转换参数等价替代:
//   f_auto —— 自动选择最优格式(浏览器支持则给 WebP/AVIF)
//   q_auto —— 自动压缩质量
//   c_limit —— 只缩不放(原图比目标窄时保持原尺寸,避免放大变糊)
//   w_     —— 按用途限定宽度(400/640/800 缩略图 / 1200 封面 / 1600 灯箱大图)
// Cloud Name 通过构建环境变量注入(Vercel 配置,本地 .env),非敏感信息。
const CLOUD_NAME = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME ?? "";

// srcset 档位。与 sizes 配合,由浏览器按视口与 DPR 自行挑选,避免所有设备都下同一张大图。
const SRCSET_WIDTHS = [400, 640, 800, 1024, 1280, 1600, 2000];

// public_id 统一不带扩展名(Cloudinary 自动加格式后缀,f_auto 忽略之)
export function cloudinaryUrl(filename: string, width: number): string {
  const id = filename.replace(/\.[^.]+$/, "");
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto,c_limit,w_${width}/photos/${id}`;
}

/**
 * 生成 srcset 字符串。
 * intrinsicWidth(原图宽度,来自 frontmatter 的 width)用于剔除超过原图的档位:
 * Cloudinary 配了 c_limit 不会放大,列出用不上的大档只会让浏览器选错、平白多下流量。
 */
export function cloudinarySrcset(filename: string, intrinsicWidth?: number): string {
  let widths = intrinsicWidth
    ? SRCSET_WIDTHS.filter((w) => w <= intrinsicWidth)
    : [...SRCSET_WIDTHS];
  // 原图比最小档还窄(如手机截图),直接用它自身的宽度作为唯一档位
  if (widths.length === 0 && intrinsicWidth) widths = [intrinsicWidth];
  return widths.map((w) => `${cloudinaryUrl(filename, w)} ${w}w`).join(", ");
}

// 缩略图入口(函数名/参数与旧实现一致,组件无需感知迁移)
export function resolveImage(filename: string): string {
  return cloudinaryUrl(filename, 800);
}
