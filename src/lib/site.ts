// 站点设置:src/content/site/site.md(后台「⚙ 全局设置」写入)覆盖 src/config.ts 的默认值。
//
// 每个页面构建时都会调用,所以结果缓存在模块作用域 —— 一次构建里集合内容不会变。
// 所有字段都可留空:留空 = 用 config.ts 里的默认值,所以这个文件不存在也不影响站点。
import { getCollection } from "astro:content";
import { CONTACTS, type ContactLink } from "../config";

const DEFAULTS = {
  title: "夏至未至",
  description: "用照片记录走过的路、看过的风景和日常的瞬间。",
  // 写死年份而不是取当前年:页脚是「建站年份」的语义,不该随浏览器时间漂移
  footerText: "© 2026 夏至未至",
  logo: "",
  icp: "",
};

export interface SiteSettings {
  title: string;
  description: string;
  footerText: string;
  /** 站标图片地址,空串则导航只显示站名文字 */
  logo: string;
  /** 备案号,空串则不渲染该行 */
  icp: string;
  /** 页脚联系方式,已按「href 为空的条目剔除」过滤 */
  contacts: ContactLink[];
}

let cache: SiteSettings | null = null;

/** 空串/null/纯空白都算「没填」,回落到默认值 */
function pick(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function defaultHref(label: string): string {
  return CONTACTS.find((c) => c.label === label)?.href ?? "";
}

export async function getSiteSettings(): Promise<SiteSettings> {
  if (cache) return cache;

  const [entry] = await getCollection("site");
  const d = entry?.data ?? {};

  const xhs = pick(d.socialXhs, defaultHref("小红书"));
  const instagram = pick(d.socialInstagram, defaultHref("Instagram"));
  // 邮箱在 config.ts 里是 mailto: 完整地址,而 site.md 里存的是裸邮箱(后台弹窗只让人填邮箱)
  const email = pick(d.contactEmail, defaultHref("邮箱").replace(/^mailto:/, ""));

  cache = {
    title: pick(d.title, DEFAULTS.title),
    description: pick(d.description, DEFAULTS.description),
    footerText: pick(d.footerText, DEFAULTS.footerText),
    logo: pick(d.logo, DEFAULTS.logo),
    icp: pick(d.icp, DEFAULTS.icp),
    // 空 href 的整条不渲染 —— 避免出现「点进去是 Instagram 官网首页」这种死链
    contacts: [
      { label: "小红书", href: xhs, external: true },
      { label: "Instagram", href: instagram, external: true },
      { label: "邮箱", href: email ? `mailto:${email}` : "" },
    ].filter((c) => c.href.trim()),
  };
  return cache;
}
