// 内容集合的排序与可见性规则。
//
// 这里的规则必须和后台(scripts/admin-server.mjs 的 byOrderThenDate)逐字一致——
// 后台左侧列表的顺序就是线上顺序,两边不一致用户会以为排序没生效。

/** 没有 order 的老数据排在最后(而不是排最前),保证加 order 字段前后行为不变 */
const ORDER_NONE = Number.MAX_SAFE_INTEGER;

type Sortable = { data: { order?: number | null; date?: string | null } };

/**
 * 有 order 的按 order 升序;没有 order 的落回按 date 倒序。
 * 123 张存量照片/13 个项目都没有 order,走的就是纯 date 倒序 —— 与本次改动前完全一致。
 */
export function byOrderThenDate(a: Sortable, b: Sortable): number {
  const oa = typeof a.data.order === "number" ? a.data.order : ORDER_NONE;
  const ob = typeof b.data.order === "number" ? b.data.order : ORDER_NONE;
  if (oa !== ob) return oa - ob;
  return String(b.data.date ?? "").localeCompare(String(a.data.date ?? ""));
}

/** 缺省(老数据没这一行)视为公开 */
export function isPublic(visibility?: string | null): boolean {
  return !visibility || visibility === "public";
}
