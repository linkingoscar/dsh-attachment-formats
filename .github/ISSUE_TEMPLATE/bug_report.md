---
name: Bug report
about: Report a problem with dsh-attachment-formats (dsh plugin, DeepSeek Harness)
title: "[bug] "
labels: bug
---

**Describe the bug**
A clear description. Include `dsh --version` (`dsh 0.1.1-rc.2` etc.) and browser.

**To reproduce**
1. File type & size (e.g. `PDF 12MB, scanned`)
2. Action: drag / paperclip / paste / `/attach`
3. Expected vs actual

**Logs**
- `Settings → 附件缓存 → doctor` output (or `GET /api/attach-formats/doctor`)
- Browser console errors, host logs `dsh web` stderr

**Env**
- dsh version:
- OS:
- OCR provider (`auto`/`baidu`/`tesseract` etc.):
- `DSH_ATTACH_ENGINE` / `DSH_ATTACH_OCR`:

**Search keywords**
`dsh attachment pdf ocr` `dsh plugin bug` — helps others find this issue.
