# 决策记录：缓存迁 DSH_HOME + DeepSeek Vision auto 默认开

日期：2026-08-23 · 版本：v0.9.0 · 状态：已实施

## 决策 1：转换缓存默认落 `$DSH_HOME/storages/attachment-docs/<workspaceHash>/`

**背景**：v0.6-v0.8 把长文档 spill 写在 `cwd/.dsh-attachments/`。问题三连：
污染 `git status`、模型可能把 INDEX.md/manifest 当上下文误读、多 cwd 状态分裂。

**依据**：上游 `single-harness-home-resolver` 决策（2026-07-24）——所有持久数据
归 `$DSH_HOME` 单根（显式 config → `$DSH_HOME` → `~/.dsh`），明确放弃 XDG 拆分。
插件是 harness 生态公民，持久派生数据应遵循同一选址。

**取舍**：
- 模型可读性：home 模式下索引卡写绝对路径（`read` 工具原生支持），可读性不受损；
  需要相对路径语义的部署可在设置页 opt-in `workspace` 模式。
- 迁移：`ensureCacheMigrated(cwd)` 每 cwd 每进程一次，rename 优先、跨卷 cp+rm
  回退、同 id 跳过不覆盖，搬移后旧根仅剩 INDEX.md 时整目录清理。
- 工作区模式保留 `.gitignore` marker 注入（幂等）+ `/doctor` 自检。

## 决策 2：DeepSeek Vision 在 `auto` 下探测到 Key 即启用（默认开，可关）

**背景**：v0.8.0 Vision 仅显式选择才走，默认用户永远触达不到——好能力没有默认路径。

**依据**：dsh 渐进增强哲学（引擎链逐级回退）+ Key 已随宿主配置存在（零新增配置），
DeepSeek 自家模型按 token 计费成本极低。显式优于隐式的张力通过三重缓解：
1. 设置页 checkbox「auto 时启用 DeepSeek Vision」默认开、可一键关（`ocr.deepseekAuto`）；
2. 首次转录的 `ocrNote` 明示「按 token 计费」，卡片/说明可见；
3. 探测失败（无 Key）静默回退本地 tesseract，不产生任何噪音。

**凭据来源优先级**（`resolveDeepSeekKey`）：设置页显式 Key → 宿主 `ctx.credentials.resolve("DEEPSEEK_API_KEY")`
（官方 seam，覆盖 env/managed store/.env）→ `.credentials.yaml` 文件正则（服务缺失回退）
→ `DEEPSEEK_API_KEY`/`DSH_ATTACH_VLM_KEY` env。

**已知限制**：文件正则回退对 yaml 格式变化脆弱；smoke 以 `DSH_ATTACH_OCR=tesseract-js`
显式隔离真实凭据，route/p0 套件以临时 `DSH_HOME` 隔离。
