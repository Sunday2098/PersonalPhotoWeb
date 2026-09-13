// 站点级配置:改这里,不用翻模板。

export interface ContactLink {
  /** 页脚显示的名字 */
  label: string;
  /**
   * 完整链接。留空则该条目整条不渲染 —— 避免出现「点进去是 Instagram 官网首页」
   * 这种死链。邮箱写 mailto: 开头的完整地址。
   */
  href: string;
  /** 站外链接:新标签页打开并加 rel="noopener" */
  external?: boolean;
}

/**
 * 页脚联系方式。href 为空串的条目会被跳过;全部为空时页脚只留版权行,
 * 连外层的链接容器都不渲染(不留空洞)。
 *
 * 注:小红书主页链接里的 user_id(十六进制)与「小红书号」(纯数字)不是一回事,
 * 换号后要重新从地址栏复制,不能按小红书号拼。
 */
export const CONTACTS: ContactLink[] = [
  { label: "小红书", href: "https://www.xiaohongshu.com/user/profile/66888f91000000000f0341c6", external: true },
  { label: "邮箱", href: "mailto:2812225477@qq.com" },
];
