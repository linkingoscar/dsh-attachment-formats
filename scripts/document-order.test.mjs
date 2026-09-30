import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { pptxToText } from "../lib/convert/pptx.js";
import { convertPandocFormat } from "../lib/convert/pandoc.js";
import { archiveTarget } from "../lib/convert/archive-xml.js";

async function pptx(target = "slides/slide2.xml", external = false) {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" rel:id="second"/><p:sldId id="256" rel:id="first"/></p:sldIdLst></p:presentation>');
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="first" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${target}" ${external ? 'TargetMode="External"' : ""}/></Relationships>`);
  for (const [number, text] of [[1, "FIRST &amp; text"], [2, "SECOND"], [3, "ORPHAN"]]) {
    zip.file(`ppt/slides/slide${number}.xml`, `<p:sld xmlns:p="p" xmlns:a="a"><a:t>${text}</a:t></p:sld>`);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

test("PPTX follows presentation relationship order, excludes orphan slides and decodes text", async () => {
  const text = await pptxToText(await pptx());
  assert.equal(text, "[幻灯片 1]\nSECOND\n\n[幻灯片 2]\nFIRST & text");
});

test("PPTX resolves package-absolute part targets", async () => {
  assert.match(await pptxToText(await pptx("/ppt/slides/slide2.xml")), /^\[幻灯片 1\]\nSECOND/);
});

test("PPTX refuses missing or external slide targets rather than silently reordering", async () => {
  await assert.rejects(pptxToText(await pptx("slides/missing.xml")), /missing slide/);
  await assert.rejects(pptxToText(await pptx("https://example.com/slide.xml", true)), /invalid PPTX/);
});

test("ODT retains interleaved heading/paragraph order, namespaces, entities and heading depth", async () => {
  const zip = new JSZip();
  zip.file("content.xml", '<o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><o:body><o:text><t:h t:outline-level="1">One</t:h><t:p>Body &#65; &amp; &#x42;</t:p><t:h t:outline-level="2">Two</t:h><t:p>Last <t:span>paragraph</t:span></t:p></o:text></o:body></o:document-content>');
  assert.equal(await convertPandocFormat(await zip.generateAsync({ type: "nodebuffer" }), "odt", null), "# One\n\nBody A & B\n\n## Two\n\nLast paragraph");
});

async function epub(spine = '<itemref idref="z"/><itemref idref="a"/><itemref idref="aux" linear="no"/>') {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file("OPS/package.opf", `<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="a" href="Text/a.xhtml" media-type="application/xhtml+xml"/><item id="z" href="Text/z%20chapter.xhtml" media-type="application/xhtml+xml"/><item id="aux" href="aux.xhtml" media-type="application/xhtml+xml"/><item id="nav" properties="nav" href="nav.xhtml" media-type="application/xhtml+xml"/></manifest><spine>${spine}</spine></package>`);
  for (const [name, text] of [["Text/a.xhtml", "SECOND"], ["Text/z chapter.xhtml", "FIRST"], ["aux.xhtml", "AUXILIARY"], ["nav.xhtml", "NAVIGATION"], ["orphan.xhtml", "ORPHAN"]]) zip.file(`OPS/${name}`, `<html><body><p>${text}</p></body></html>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("EPUB follows OPF spine, resolves encoded relative paths, excludes auxiliary/unreferenced files", async () => {
  const text = await convertPandocFormat(await epub(), "epub", null);
  assert.ok(text.indexOf("FIRST") < text.indexOf("SECOND"));
  assert.doesNotMatch(text, /AUXILIARY|NAVIGATION|ORPHAN/);
});

test("EPUB reports broken spine references instead of emitting arbitrary sorted files", async () => {
  await assert.rejects(convertPandocFormat(await epub('<itemref idref="missing"/>'), "epub", null), /missing item/);
});

test("archive metadata cannot resolve outside the archive or to a network URL", () => {
  for (const target of ["../../outside.xml", "%2e%2e/%2e%2e/outside.xml", "https://example.com/x", "//example.com/x", "bad%xx.xml", "bad\\path.xml"]) {
    assert.throws(() => archiveTarget("OPS/package.opf", target), /invalid|escapes/);
  }
  assert.equal(archiveTarget("OPS/package.opf", "Text/chapter.xhtml#section"), "OPS/Text/chapter.xhtml");
});

test("archive XML rejects DTD/entity definitions", async () => {
  const zip = new JSZip();
  zip.file("content.xml", '<!DOCTYPE doc [<!ENTITY test SYSTEM "file:///etc/passwd">]><doc/>');
  await assert.rejects(convertPandocFormat(await zip.generateAsync({ type: "nodebuffer" }), "odt", null), /DTD\/entities/);
});


test("PDF text coverage reports only observed text, not visual completeness", async () => {
  const { pdfTextCoverage, coverageNotes } = await import("../lib/convert/pdf-coverage.js");
  const partial = pdfTextCoverage(3, [1, 1, 3]);
  assert.deepEqual(partial, {totalPages:3,textPageCount:2,missingTextPages:[2],status:"missing-text-pages"});
  assert.match(coverageNotes(partial)[0], /核对原文页面/);
  assert.equal(pdfTextCoverage(2, [1,2]).status, "text-on-all-pages");
  assert.equal(pdfTextCoverage(0, []), null);
  assert.equal(pdfTextCoverage(3, undefined), null);
});
