/** Namespace-aware XML metadata and package-local URI handling; never fetch remote resources. */
import { posix } from "node:path";
import { DOMParser } from "@xmldom/xmldom";

export function parseArchiveXml(xml, name) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`${name}: XML DTD/entities are unsupported`);
  const fail = (message) => { throw new Error(`${name}: invalid XML: ${message}`); };
  const document = new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } })
    .parseFromString(xml, "application/xml");
  if (!document.documentElement) throw new Error(`${name}: missing XML root`);
  return document;
}

export function xmlElements(node, localName, namespace = "*") {
  return Array.from(node.getElementsByTagNameNS(namespace, localName));
}

export async function readArchiveXml(zip, name) {
  const entry = zip.file(name);
  if (entry === null) throw new Error(`document package missing ${name}`);
  return parseArchiveXml(await entry.async("string"), name);
}

/** Resolve a package URI against the containing part, rejecting network and traversal targets. */
export function archiveTarget(part, target) {
  if (!target || /^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) throw new Error(`invalid package target: ${target}`);
  let decoded;
  try { decoded = decodeURIComponent(target.split("#")[0]); }
  catch { throw new Error(`invalid package target encoding: ${target}`); }
  if (!decoded || /[\\\0?]/.test(decoded) || /^[a-z][a-z\d+.-]*:|^\/\//i.test(decoded)) {
    throw new Error(`invalid package target: ${target}`);
  }
  const name = posix.normalize(decoded.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(part), decoded));
  if (name === ".." || name.startsWith("../") || name === ".") throw new Error(`package target escapes archive: ${target}`);
  return name;
}
