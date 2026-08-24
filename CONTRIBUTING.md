# Contributing to dsh-attachment-formats

Thanks for helping this `dsh-plugin` (DeepSeek Harness plugin, Cordis) stay discoverable!

## Quick start

```powershell
cd D:\植物大战僵尸\deepsekkharness\projects\dsh-attachment-formats
pnpm install
pnpm run smoke:all   # host / route / client / ocr / p0
pnpm run build:client
```

## Search-friendly PRs

- Title should contain a searchable phrase: `dsh pdf`, `dsh office`, `dsh ocr`, `dsh attachment`, `cordis`.
- Update `package.json:keywords` and README first paragraph if you add a format/provider — that's how `keywords:dsh-plugin` and `topic:dsh-plugin` find you.
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your fork for testing.

## Checks

```powershell
pnpm run lint
pnpm run typecheck
pnpm run verify:build   # ensures lib/client.js is fresh
```

## Where to get discovered

- This repo declares `dsh.bundle` (`cordis.patch.yml`) so registries can `manifest_verified` it.
- After merging, the plugin appears on [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), [dshplugin.world](https://dshplugin.world), [deepseekharness.io/plugins](https://deepseekharness.io/plugins), [dsh.pub](https://dsh.pub) via `topic:dsh-plugin`.

## Reporting bugs

Use the bug template; include `dsh --version`, file type/size, and `GET /api/attach-formats/doctor`.
