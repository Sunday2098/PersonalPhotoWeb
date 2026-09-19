// 内容 .md 的 frontmatter 读写工具(后台服务专用)
//
// 为什么手写而不引 js-yaml:这些文件全部由脚本生成,格式高度统一(顶层标量 +
// exif 缩进块 + tags 单行数组),手写解析足够且能保证「未提及的行原样保留」。
// 引入 YAML 库会重排键序、改动引号风格 —— 123 个数据文件全量翻新,diff 爆炸,
// 而任何一个字段丢失都是不可逆的数据事故。
//
// 编辑一律「外科手术式」:按行替换/插入/删除,绝不整块重建。

// 需要保持数字类型的键 —— schema 里是 z.number(),读成字符串会导致构建失败
const NUMERIC_KEYS = new Set(["iso", "width", "height", "order", "bytes"]);
const BOOL_KEYS = new Set(["featured", "showExif"]);

// 顶层键的插入锚点:新键写在哪个已有键之后(纯为可读性,YAML 不在乎键序)
//
// 锚点必须是「标量键」,绝不能选 exif 这种后面跟着缩进子块的键 ——
// 插在 `exif:` 那行之后会落到子块内部,写出
//   exif:
//   showExif: true     ← 顶格,把缩进块拦腰截断
//     camera: ...
// 这种 YAML 直接解析失败。project 是 schema 必填键、且紧挨在 exif 块之前,
// 既保证一定存在,又能把开关稳稳放在拍摄参数块的头顶上。
const FM_ANCHORS = {
  alt: "filename",
  location: "filename",
  tags: "filename",
  order: "color",
  bytes: "color",
  uploadedAt: "color",
  visibility: "location",
  showExif: "project",
};

export function unquote(v) {
  const s = String(v ?? "").trim();
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// tags 写成单行 flow 数组:`tags: ["古建筑", "山西"]`
// (块式数组的缩进与「哪些行属于本项目」有歧义,flow 形式一行搞定)
export function parseTags(raw) {
  const m = String(raw ?? "").trim().match(/^\[(.*)\]$/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => unquote(s))
    .filter(Boolean);
}

function scalar(key, raw) {
  const v = unquote(raw);
  if (BOOL_KEYS.has(key)) {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  // 空串原样返回(项目简介留空、照片 date 清空都走这里)
  if (NUMERIC_KEYS.has(key) && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/**
 * 解析 frontmatter:顶层标量 + exif 缩进子块 + tags 单行数组。
 * 未识别的行(如未来新增字段)忽略,但写回时原样保留(diff 干净)。
 *
 * 先把 CRLF 归一成 LF:Windows 上 git(autocrlf)会把文件检出成 CRLF,
 * 而 /^---\n/ 这种行首匹配遇到 \r\n 会直接失配 —— 整个 frontmatter 被读成空对象,
 * 后台看到的是「标题全空、字段全丢」。读路径绝不能假设换行符。
 */
export function parseFrontmatter(md) {
  const m = String(md ?? "").replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  let block = null; // 当前缩进块所属的键(目前只有 exif)
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (/^\s/.test(line)) {
      if (block === "exif") out.exif[key] = scalar(key, raw);
      continue;
    }
    if (key === "exif" && raw.trim() === "") {
      block = "exif";
      out.exif = {};
      continue;
    }
    block = null;
    out[key] = key === "tags" ? parseTags(raw) : scalar(key, raw);
  }
  return out;
}

export function yamlStr(v) {
  const s = String(v ?? "");
  // 空串必须加引号,否则写成裸 `key: ` 会被 YAML 解析成 null(项目简介留空即此情况)
  if (s === "") return '""';
  // 含引号/反斜杠、首尾空白、纯数字样、或 YAML 特殊符号开头 —— 一律加引号
  // (过度加引号无害:读回来会去掉引号,宁可多引不可少引)
  if (
    /["\\]/.test(s) ||
    /[:#]\s|^\s|\s$/.test(s) ||
    /^[\d.:-]+$/.test(s) ||
    /^[>[\]{}&*!|%`?#,\-]/.test(s) ||
    s.includes("\n")
  ) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function fmLine(key, value) {
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  return `${key}: ${yamlStr(String(value))}`;
}

function tagsLine(arr) {
  const items = arr
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `tags: [${items.join(", ")}]`;
}

// 把 md 拆成 首行 / frontmatter 行 / 其余(含结尾 ---)。非标准结构返回 null。
// 同样先归一换行符:否则每行结尾会残留 \r,替换后的那一行与其它行换行风格不一致
function splitMd(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  if ((lines[0] ?? "").trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  return { first: lines[0], fm: lines.slice(1, end), rest: lines.slice(end) };
}

/**
 * 按 ops 改写 md 的 frontmatter,正文与未提及的键原样保留。
 * ops = {
 *   set:   { title: "飞檐一角", tags: ["古建筑"], order: 3, ... }  // tags 传 [] 等价于删除
 *   unset: ["location"],                                          // 删掉这些行
 *   exif:  { set: { camera: "NIKON Z 5", iso: 400 }, unset: ["lens"] }
 * }
 * 返回改写后的完整文本;结构异常(无 frontmatter)返回 null,由调用方报错。
 */
export function editFrontmatter(md, ops = {}) {
  const parts = splitMd(md);
  if (!parts) return null;
  const fm = [...parts.fm];
  const indexOfKey = (key) => fm.findIndex((l) => new RegExp(`^${key}:\\s*`).test(l));

  // exif 缩进子块的范围:[exif 行, 第一个非缩进非空行)
  const exifRange = () => {
    const i = indexOfKey("exif");
    if (i < 0) return null;
    let j = i + 1;
    while (j < fm.length && (/^\s+\S/.test(fm[j]) || !fm[j].trim())) j++;
    return [i, j];
  };

  // ① 顶层键
  for (const [key, value] of Object.entries(ops.set ?? {})) {
    const at = indexOfKey(key);
    // tags 传空数组 = 清空该字段(删行,而不是留一个 `tags: []`)
    if (key === "tags" && (!Array.isArray(value) || value.filter((s) => String(s).trim()).length === 0)) {
      if (at >= 0) fm.splice(at, 1);
      continue;
    }
    const line = key === "tags" ? tagsLine(value) : fmLine(key, value);
    if (at >= 0) {
      fm[at] = line;
      continue;
    }
    const ai = FM_ANCHORS[key] ? indexOfKey(FM_ANCHORS[key]) : -1;
    if (ai >= 0) fm.splice(ai + 1, 0, line);
    else fm.push(line);
  }
  for (const key of ops.unset ?? []) {
    const at = indexOfKey(key);
    if (at >= 0) fm.splice(at, 1);
  }

  // ② exif 子块:收集现有子键(保留原始写法与顺序)→ 改动 → 整体重写
  const exifSet = Object.entries(ops.exif?.set ?? {});
  const exifUnset = ops.exif?.unset ?? [];
  if (exifSet.length || exifUnset.length) {
    const range = exifRange();
    const map = new Map();
    if (range) {
      for (const l of fm.slice(range[0] + 1, range[1])) {
        const kv = l.trim().match(/^([\w-]+):\s*(.*)$/);
        if (kv) map.set(kv[1], kv[2]); // 保留原始序列化文本,避免无谓 diff
      }
    }
    for (const [k, v] of exifSet) {
      // 新值需自行序列化(空值 = 删除该子键)
      if (v === "" || v === null || v === undefined) map.delete(k);
      else map.set(k, typeof v === "number" ? String(v) : yamlStr(String(v)));
    }
    for (const k of exifUnset) map.delete(k);
    const kept = [...map.entries()];
    if (range) fm.splice(range[0], range[1] - range[0]);
    if (kept.length) {
      // 有 exif 块就写回原位置;没有则插在 project / id 行之后
      const at = range ? range[0] : Math.max(indexOfKey("project"), indexOfKey("id"), 0) + 1;
      fm.splice(at, 0, "exif:", ...kept.map(([k, v]) => `  ${k}: ${v}`));
    }
  }

  return [parts.first, ...fm, ...parts.rest].join("\n");
}
