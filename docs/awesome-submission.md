# Awesome 收录提交清单（dsh 插件曝光）

本插件已满足所有 `dsh-plugin` 发现目录的 `manifest_verified` 条件：`package.json:dsh.bundle` + `cordis.patch.yml` 存在 + `topic:dsh-plugin`。

## 已就绪
- GitHub topics: 20/20（`cordis`/`deepseek`/`pdf-extraction`/`tesseract` 等已用 `gh repo edit` 补齐，`gh api repos/linkingoscar/dsh-attachment-formats --jq .topics` 可验）
- npm keywords: 27 个（`dsh-plugin`, `deepseek-harness`, `cordis`, `pdf-extraction` ... `package.json:76`）
- README 首屏已埋检索词：`DeepSeek Harness plugin (dsh-plugin)`, `dsh plugin add`, `pdf/office/ocr`，并新增 FAQ/Related（`README.md:232` / `README.zh.md:323`）

## 待你一键提交（各 2 分钟）

### 1. awesome-dsh-plugin
- 仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- 操作：Fork → 在 `plugins.json` 按字母序加一条（参考已有 `dsh-attachment` 条目），PR 标题含 `dsh-attachment-formats` 即可被 `topic:dsh-plugin` 检索

```json
{
  "name": "dsh-attachment-formats",
  "repo": "linkingoscar/dsh-attachment-formats",
  "description": "DeepSeek Harness Web plugin — PDF/Office/TIFF/epub to Markdown, long-doc index cards, scanned-PDF OCR (tesseract + 8 cloud inc. DeepSeek Vision)",
  "install": "dsh plugin --profile web add github:linkingoscar/dsh-attachment-formats"
}
```

### 2. npm 发布（开启 `keywords:dsh-plugin` 搜索）
```powershell
cd D:\植物大战僵尸\deepsekkharness\projects\dsh-attachment-formats
npm login
npm publish --access public --provenance
# 之后 `npm search keywords:dsh-plugin` 即可搜到
```

### 3. dsh 官方 Discussions 曝光（可选）
- 在 https://github.com/deepseek-ai/deepseek-harness/discussions 按 `dsh-plugin` 标签发一条 Show & tell，标题含 `dsh attachment pdf office ocr`，正文贴 `dsh plugin add` 一行 + README FAQ 链接

## 验证
```powershell
gh api repos/linkingoscar/dsh-attachment-formats --jq .topics
npm view dsh-attachment-formats keywords  # 发布后
curl -s https://api.github.com/search/repositories?q=topic:dsh-plugin+attachment | jq .items[0].full_name
```
