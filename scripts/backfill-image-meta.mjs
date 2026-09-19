// 一次性回填脚本:为 photos / featured 的 .md 补上图片元信息。
//
// 为什么需要:
//   <img> 缺少宽高 → 加载时页面重排(CLS);缺少主色 → 加载前是一片灰方块。
//   bytes/uploadedAt 是后台「列表视图」要显示的 文件大小 / 上传时间。
//   本地已不保存原图(图片全部托管在 Cloudinary),这些只能从 Cloudinary Admin API 取。
//   colors:true 会额外返回主色列表,取占比最高的一色作为占位底色。
//
// 用法:node scripts/backfill-image-meta.mjs
//   - 幂等:该有的键都有了就跳过,可中断后重跑(第一阶段补 width 的、第二阶段补 bytes 的,
//     跑一次两步都做)
//   - 只改 frontmatter,不动正文
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v2 as cloudinary } from "cloudinary";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTIONS = ["photos", "featured"];
const DELAY_MS = 150; // 轻微限速,避免触发 Admin API 的频率限制

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadEnv() {
  const text = await readFile(path.join(root, ".env"), "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// frontmatter 与正文以 --- 分隔;在结尾的 --- 之前插入新键
function insertKeys(content, lines) {
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return null;
  const [, open, fm, close] = m;
  const rest = content.slice(m[0].length);
  return `${open}${fm}\n${lines.join("\n")}${close}${rest}`;
}

function field(content, key) {
  const m = content.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const env = await loadEnv();
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

// 同一张图可能同时出现在 photos 与 featured(如 DSC_1173),按 public_id 去重,少发请求
const cache = new Map();
async function lookup(publicId) {
  if (cache.has(publicId)) return cache.get(publicId);
  const r = await cloudinary.api.resource(publicId, { colors: true });
  const color = Array.isArray(r.colors) && r.colors[0] ? r.colors[0][0] : "";
  const meta = {
    width: r.width,
    height: r.height,
    color,
    bytes: r.bytes,
    // created_at 是 ISO 时间戳,只取日期部分且加引号 —— 不加引号会被 YAML
    // 解析成时间类型(不是字符串),schema 里的 z.string() 会直接让构建失败
    uploadedAt: typeof r.created_at === "string" ? r.created_at.slice(0, 10) : "",
  };
  cache.set(publicId, meta);
  return meta;
}

let done = 0;
let skipped = 0;
const failed = [];
const pending = [];

for (const collection of COLLECTIONS) {
  const dir = path.join(root, "src", "content", collection);
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    continue;
  }
  for (const file of files) {
    const full = path.join(dir, file);
    const content = await readFile(full, "utf8");
    // 缺什么补什么 —— 两批字段分开判断,这样只缺 bytes 的老数据也能补上
    const isPhotos = collection === "photos";
    const wantSize = !/^width:/m.test(content);
    const wantBytes = isPhotos && !/^bytes:/m.test(content);
    if (!wantSize && !wantBytes) {
      skipped++;
      continue;
    }
    const filename = field(content, "filename");
    if (!filename) {
      failed.push(`${collection}/${file}: frontmatter 缺 filename`);
      continue;
    }
    pending.push({
      collection,
      file,
      full,
      wantSize,
      wantBytes,
      publicId: `photos/${filename.replace(/\.[^.]+$/, "")}`,
    });
  }
}

console.log(`待处理 ${pending.length} 个,已跳过(字段齐全)${skipped} 个\n`);

for (const item of pending) {
  try {
    const meta = await lookup(item.publicId);
    const lines = [];
    if (item.wantSize) {
      if (!meta.width || !meta.height) {
        failed.push(`${item.collection}/${item.file}: Cloudinary 未返回尺寸`);
        continue;
      }
      lines.push(`width: ${meta.width}`, `height: ${meta.height}`);
      if (meta.color) lines.push(`color: "${meta.color}"`);
    }
    if (item.wantBytes) {
      if (typeof meta.bytes !== "number") {
        failed.push(`${item.collection}/${item.file}: Cloudinary 未返回文件大小`);
        continue;
      }
      lines.push(`bytes: ${meta.bytes}`);
      if (meta.uploadedAt) lines.push(`uploadedAt: "${meta.uploadedAt}"`);
    }
    const next = insertKeys(await readFile(item.full, "utf8"), lines);
    if (!next) {
      failed.push(`${item.collection}/${item.file}: frontmatter 格式无法解析`);
      continue;
    }
    await writeFile(item.full, next, "utf8");
    done++;
    process.stdout.write(`\r已回填 ${done}/${pending.length}  ${item.publicId}          `);
  } catch (err) {
    failed.push(`${item.collection}/${item.file}: ${err.message ?? err}`);
  }
  await sleep(DELAY_MS);
}

console.log(`\n\n完成:回填 ${done} 个,跳过 ${skipped} 个,失败 ${failed.length} 个`);
if (failed.length) {
  console.log("\n失败明细:");
  for (const f of failed) console.log("  - " + f);
}
