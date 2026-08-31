// 添加照片脚本:把图片放进 inbox/ 文件夹,自动上传 Cloudinary + 生成内容文件并构建
//
// 用法:
//   node scripts/add-photos.mjs                    # 交互式选择归属项目
//   node scripts/add-photos.mjs --project shan-yu-hu
//   node scripts/add-photos.mjs --no-build          # 跳过自动构建
//
// 流程:扫描 inbox/ → 跳过已有数据的 → 读 EXIF(相机/焦距/ISO/拍摄时间)
//       → 上传 Cloudinary(public_id = photos/<文件名>) → 生成 src/content/photos/<文件名>.md
//       → 删除本地原图(照片只存 Cloudinary) → npm run build
//
// 密钥从 .env 读取(CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET),
// .env 已 gitignore,绝不提交。
import { readdir, readFile, writeFile, rename, unlink, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import exifr from "exifr";
import { v2 as cloudinary } from "cloudinary";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inboxDir = path.join(root, "inbox");
const contentDir = path.join(root, "src", "content", "photos");
const projectsDir = path.join(root, "src", "content", "projects");

const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp"];
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const projectArg = opt("--project");
const noBuild = args.includes("--no-build");

// ---------- 小工具 ----------

// 解析 .env(不引第三方依赖;此文件 gitignore,不入库)
async function loadEnv() {
  const out = {};
  try {
    const text = await readFile(path.join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
  return out;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^"|"$/g, "");
  }
  return out;
}

function yamlStr(v) {
  const s = String(v);
  return /[:#]\s|^\s|\s$|^[\d.:-]+$/.test(s) ? `"${s}"` : s;
}

// Cloudinary 错误信息优先取 .message;部分网络错误只有 .error 或裸对象,逐级兜底
function errMessage(e) {
  return e?.message || e?.error?.message || (typeof e === "string" ? e : JSON.stringify(e));
}

async function readProjects() {
  const files = (await readdir(projectsDir)).filter((f) => f.endsWith(".md"));
  const projects = [];
  for (const f of files) {
    const md = await readFile(path.join(projectsDir, f), "utf8");
    const fm = parseFrontmatter(md);
    if (fm.id) projects.push({ id: fm.id, title: fm.title ?? "" });
  }
  return projects;
}

async function chooseProject(projects) {
  if (projectArg) {
    if (!projects.some((p) => p.id === projectArg)) {
      throw new Error(`项目不存在:${projectArg}(可选:${projects.map((p) => p.id).join(" / ")})`);
    }
    return projectArg;
  }
  console.log("归属项目:");
  projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.id} (${p.title})`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => {
    rl.question(`输入序号 [1]:`, (a) => res(a.trim()));
  });
  rl.close();
  const n = answer === "" ? 1 : Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > projects.length) {
    throw new Error("无效序号");
  }
  return projects[n - 1].id;
}

// Cloudinary API 上传上限 10MB;超限的图自动压缩到 1600px(JPEG q82)后以 buffer 上传
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function prepareUpload(src) {
  const size = (await stat(src)).size;
  if (size <= MAX_UPLOAD_BYTES) return { buffer: null, size };
  const buf = await sharp(src)
    .rotate() // 应用 EXIF 方向
    .resize(1920, null, { withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buffer: buf, size };
}

// uploader.upload() 只接受路径/URL,压缩后的 Buffer 走 upload_stream 上传
function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (err, result) => (err ? reject(err) : resolve(result)))
      .end(buffer);
  });
}

// ---------- 主流程 ----------

async function main() {
  const env = await loadEnv();
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error(
      ".env 缺少 Cloudinary 配置(CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET),请先填写",
    );
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });

  await mkdir(inboxDir, { recursive: true });

  const files = (await readdir(inboxDir))
    .filter((f) => IMG_EXT.includes(path.extname(f).toLowerCase()))
    .sort();

  if (files.length === 0) {
    console.log(`inbox/ 里没有图片。把新照片放进 ${path.relative(root, inboxDir)}/ 后重新运行。`);
    return;
  }

  // 跳过已有数据的
  const existing = new Set((await readdir(contentDir)).map((f) => path.basename(f, ".md")));
  const todo = files.filter((f) => !existing.has(path.basename(f, path.extname(f))));
  const skipped = files.length - todo.length;
  if (skipped) console.log(`跳过 ${skipped} 张(已有数据文件)`);

  if (todo.length === 0) return;

  const projects = await readProjects();
  if (projects.length === 0) throw new Error("没有找到任何项目,先在 src/content/projects/ 里建一个");
  const project = await chooseProject(projects);

  const today = new Date().toISOString().slice(0, 10);

  for (const f of todo) {
    const name = path.basename(f, path.extname(f));
    const src = path.join(inboxDir, f);

    // 读 EXIF(失败则降级为文件时间/今天)
    let date = today, camera = "", focal = "", iso = "";
    try {
      const t = await exifr.parse(src, { pick: ["Model", "DateTimeOriginal", "FocalLength", "ISO"] });
      if (t?.DateTimeOriginal instanceof Date) {
        const d = t.DateTimeOriginal;
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
      if (t?.Model) camera = String(t.Model).trim();
      if (typeof t?.FocalLength === "number") focal = `${Math.round(t.FocalLength)}mm`;
      if (typeof t?.ISO === "number") iso = t.ISO;
    } catch {
      console.warn(`  ⚠ ${f} 读取 EXIF 失败,使用文件时间作为日期`);
    }

    // 上传 Cloudinary(public_id = photos/<文件名>,overwrite=false 防覆盖已有)
    // 网络偶发超时会导致"服务端已落盘、客户端报错",先自动重试一次
    let upload;
    try {
      const { buffer, size } = await prepareUpload(src);
      if (buffer) {
        console.log(`  (原图 ${(size / 1024 / 1024).toFixed(1)}MB 超 10MB 上限,自动压缩到 ${(buffer.length / 1024).toFixed(0)}KB)`);
      }
      const doUpload = () =>
        buffer
          ? uploadBuffer(buffer, { public_id: `photos/${name}`, overwrite: false })
          : cloudinary.uploader.upload(src, { public_id: `photos/${name}`, overwrite: false });
      try {
        upload = await doUpload();
      } catch (err) {
        if (errMessage(err).includes("already exists")) throw err; // 交给外层统一处理
        console.warn(`  ⚠ ${f} 首次上传失败,2 秒后重试(${errMessage(err)})`);
        await new Promise((r) => setTimeout(r, 2000));
        upload = await doUpload();
      }
    } catch (e) {
      const info = errMessage(e);
      // overwrite:false 下云端已有同名资源 → 上次上传其实已成功,直接补数据文件
      if (info.includes("already exists")) {
        console.log(`  ℹ ${f} 云端已存在同名资源(上次上传可能超时但已落盘),跳过上传直接生成数据`);
        upload = {
          secure_url: `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/photos/${name}`,
        };
      } else {
        console.error(`✗ ${f} 上传 Cloudinary 失败:${info}`);
        process.exitCode = 1;
        continue;
      }
    }

    // 只写读到的 EXIF 字段(schema 里 iso 必须是数字,空值会构建失败)
    const exifLines = [];
    if (camera) exifLines.push(`  camera: ${yamlStr(camera)}`);
    if (focal) exifLines.push(`  focalLength: ${yamlStr(focal)}`);
    if (iso) exifLines.push(`  iso: ${iso}`);
    const frontmatter = [
      "---",
      `id: ${yamlStr(name)}`,
      `title: ""`, // 标题默认留空,命名由用户在 .md 里手动编辑
      `filename: ${yamlStr(f)}`,
      `date: "${date}"`,
      `project: ${yamlStr(project)}`,
      ...(exifLines.length ? ["exif:", ...exifLines] : []),
      "---",
      "",
    ].join("\n");

    await writeFile(path.join(contentDir, `${name}.md`), frontmatter, "utf8");
    await unlink(src); // 照片已上云,删除本地原图
    console.log(`✓ ${f} → ${project} (${date}${camera ? `, ${camera}` : ""}${focal ? `, ${focal}` : ""}${iso ? `, ISO ${iso}` : ""})`);
    console.log(`  已上传:${upload.secure_url}`);
  }

  console.log(`\n完成。注意:标题默认为空,想命名就编辑 src/content/photos/*.md 里的 title。`);

  if (!noBuild) {
    console.log("\n正在构建…");
    const { execSync } = await import("node:child_process");
    try {
      execSync("npm run build", { cwd: root, stdio: "inherit" });
    } catch {
      console.error("构建失败,请检查上方错误输出");
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error("出错:", e.message);
  process.exit(1);
});
