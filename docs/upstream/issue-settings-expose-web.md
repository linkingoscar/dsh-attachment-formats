# 上游 Issue 草案：第三方插件的 Web 设置页暴露（expose: "web"）

- **目标仓库**：`deepseek-ai/dsh`（上游 `linkingoscar/dsh-attachment-formats` 依赖此能力）
- **类型**：enhancement
- **关联**：Discussion #3114（已提出 patch：`SettingsRegisterOptions` 增加 `expose: "web"`）
- **状态**：草案，待以本人 GitHub 账号提交

## 背景（English）

Third-party plugins (e.g. dsh-attachment-formats) want to surface **provider
credentials** (OCR keys, doc-server endpoints) in the web settings UI. The host
already supports a `registerSettings` extension point, but `WEB_SETTINGS_NAMESPACES`
is a **hard-coded allowlist**:

https://github.com/deepseek-ai/dsh/blob/master/apps/web/src/routes/settings/+page.svelte#L1

So a correctly-registered third-party namespace is silently dropped from the web
panel — the plugin must instead hand-roll a custom `/api/.../settings` route +
its own UI, and later risk a freshness mismatch between host config and the
custom store.

## 提案（English）

Add an opt-in flag on `SettingsRegisterOptions`:

```ts
interface SettingsRegisterOptions {
  namespace: string;
  schema?: JSONSchema7;
  expose?: "web" | "host" | "both"; // 默认 "host" 保持现状
}
```

When `expose` includes `"web"`, the host web settings page renders the plugin's
schema-driven form automatically (no hard-coded namespace allowlist). This keeps
the existing security model (host-side schema validation, revision CAS) while
removing the per-plugin fork in the web bundle.

## 中文摘要

第三方插件（如本 attachment-formats）需要把 OCR/密钥/文档服务器等**供应商凭据**
暴露到 Web 设置页。宿主已有 `registerSettings` 扩展点，但 Web 端的
`WEB_SETTINGS_NAMESPACES` 是写死的白名单，导致第三方 namespace 被正确注册后
仍被 Web 面板静默丢弃——插件被迫自建 `/api/.../settings` 路由与 UI，并承担
宿主配置/自建 store 新鲜度不一致的风险。建议给 `SettingsRegisterOptions` 增加
`expose: "web" | "host" | "both"` 开关，由宿主按 schema 自动渲染表单，既保留
宿主侧 schema 校验 + revision CAS 的安全模型，又去掉 web 包里的插件白名单 fork。

## 影响面 / 风险（English）

- Web bundle no longer needs to enumerate third-party namespaces.
- Host-side schema validation + revision CAS already gate writes; exposing a
  namespace to the web does not weaken that.
- Backward compatible: existing `"host"` plugins unaffected.

## 验证方式（English）

1. Plugin registers `expose: "web"` with a JSON-schema.
2. Web settings page renders the form without any web-bundle change.
3. Saving goes through the same host-side validation + revision CAS path.

---

> 提交前自检：确认上游当前是否已合并 #3114 的 patch；若已合并则把本草案改为
> "verify + document the supported flag" 而非新提案。
