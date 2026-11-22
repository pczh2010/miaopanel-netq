#!/usr/bin/env node
/**
 * 生成插件发布所需的签名信息。
 *
 * 用法:
 *   node tools/sign.mjs <slug> <version> <zip路径> [私钥路径]
 *
 * 默认私钥路径来自环境变量 PLUGIN_KEY，否则用 ./keys/plugin.key。
 * 私钥永远不要提交进仓库，.gitignore 已排除 keys/ 与 *.key。
 *
 * 输出为可直接填入 manifest.json 的 JSON：
 *   artifact.sha256 / artifact.size / dev_sig
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [slug, version, zipPath, keyArg] = process.argv.slice(2);
if (!slug || !version || !zipPath) {
  console.error("用法: node tools/sign.mjs <slug> <version> <zip路径> [私钥路径]");
  process.exit(1);
}

const keyPath = keyArg || process.env.PLUGIN_KEY || path.resolve("keys/plugin.key");
if (!fs.existsSync(keyPath)) {
  console.error("找不到私钥: " + keyPath);
  console.error("请用 openssl genpkey -algorithm ed25519 -out keys/plugin.key 生成，或设置 PLUGIN_KEY");
  process.exit(1);
}

const priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
const data = fs.readFileSync(zipPath);
const sha = crypto.createHash("sha256").update(data).digest("hex");

// 签名对象: mp-plugin-v1\n<slug>\n<version>\n<sha256>\n
const payload = `mp-plugin-v1\n${slug}\n${version}\n${sha}\n`;
const sig = crypto.sign(null, Buffer.from(payload, "utf8"), priv);

// 顺带导出公钥，方便核对 /dev/keys 上的值
const pubDer = crypto.createPublicKey(priv).export({ type: "spki", format: "der" });
const pubB64 = Buffer.from(pubDer.subarray(pubDer.length - 32)).toString("base64");

console.log(JSON.stringify({
  slug,
  version,
  "artifact.sha256": sha,
  "artifact.size": data.length,
  "dev_sig": "ed25519:" + sig.toString("base64"),
  "author.pubkey": "ed25519:" + pubB64,
}, null, 2));
