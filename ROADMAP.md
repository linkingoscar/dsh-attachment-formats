# Attachment formats: focused roadmap

## Goal
Deliver attributable, correctly ordered document content, while clearly stating conversion gaps. A successful upload is not proof of a complete extraction.

## This small upgrade
- Preserve PPTX/EPUB reading order and ODT block order (completed correctness work)
- Report PDF text coverage by page; list textless pages as requiring source review, without assuming they are blank or proving that other pages are visually complete
- Keep that notice in direct text, index cards and cache hits; mark the document chip “待核对” when relevant
- Reuse the existing document cache, page previews and full-text/index-card paths; do not add another conversion engine

Acceptance: a mixed text/textless PDF reports the same missing page on first conversion and cache reuse, including when context budget changes it to an index card. A textless page is not silently described as fully extracted. Known affected conversion caches are invalidated by policy fingerprint.

## Next, only when requested
1. Retain richer per-page provenance and distinguish text extraction, OCR and original-page review
2. Build a small representative corpus with known reading order, tables, equations and mixed scanned/text pages; measure regressions before choosing an additional engine
3. Improve selective original-page review and retry only the affected pages

## Later / deliberately out of scope
No new OCR vendor, automatic uploads to external conversion services, broad UI redesign or promise of lossless layout/figure/equation conversion. Text on every page is not a completeness guarantee. Preserve explicit errors for unsupported content instead of inventing output.

Verification and limitations are recorded in README. Publication/version selection remains separate from local preparation.
