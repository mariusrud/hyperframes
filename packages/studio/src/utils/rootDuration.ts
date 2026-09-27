import { formatTimelineAttributeNumber } from "../player/components/timelineEditing";
import { parseCompositionSource } from "../player/lib/timelineElementHelpers";

// Consumed whole, as the parser reads them: comments (malformed and unclosed too), script and
// style text, and every other tag, so no scan restarts inside one and each stays linear.
const UNREAD = String.raw`<!--(?:-?>|[\s\S]*?--!?>|[\s\S]*$)|<(script|style)(?=[\s/>])[\s\S]*?(?:<\/\1(?=[\s/>])[^>]*>?|$)`;
const TAG_RE = new RegExp(String.raw`${UNREAD}|(?<tag><[a-z][^>]*>?)`, "gi");
// Tested on the matched tag, outside the scan, so a tag with no `>` is never rescanned. The
// separator before the attribute (whitespace, `/` or a closing quote, as the parser splits
// attributes) keeps a `<data-composition-id>` element from counting.
const isCompositionTag = (tag: string) =>
  tag.endsWith(">") && /[\s/"']data-composition-id(?=[\s=/>])/i.test(tag);
const isTemplateTag = (tag: string) => /^<template(?=[\s/>])/i.test(tag);

function findTag(
  source: string,
  accept: (tag: string) => boolean,
  from = 0,
): RegExpExecArray | null {
  TAG_RE.lastIndex = from;
  for (let match = TAG_RE.exec(source); match; match = TAG_RE.exec(source)) {
    const tag = match.groups?.tag;
    if (tag !== undefined && accept(tag)) return match;
  }
  return null;
}

/** The tag parseCompositionSource reads as the root: a registry scene's is inside its template. */
export function findRootOpenTag(source: string): RegExpExecArray | null {
  const first = findTag(source, isCompositionTag);
  if (!first || !/^<html(?=[\s/>])/i.test(first[0])) return first;
  const template = findTag(source, isTemplateTag);
  return (template && findTag(source, isCompositionTag, template.index)) ?? first;
}

/**
 * Matches a `data-duration="..."` attribute inside a single opening tag. Quote
 * style is captured (backreferenced), so both `"` and `'` round-trip, and the
 * `\s*` around `=` tolerates author whitespace.
 */
const DATA_DURATION_ATTR_RE = /(\bdata-duration\s*=\s*)(["'])[^"']*\2/i;

/**
 * Read the ROOT composition's raw `data-duration`.
 *
 * Parses the source with DOMParser and locates the root the same way the rest of
 * the timeline code does — the first `[data-composition-id]` element in document
 * order — then reads its `data-duration`. Because it works on the parsed tree,
 * attribute order and quote style are irrelevant, unlike the previous
 * order-dependent, double-quotes-only regex.
 *
 * Returns `null` when there is no root composition or the root has no
 * `data-duration` attribute at all. When the attribute is present but not a
 * number the parsed `NaN` is returned as-is, so callers reproduce the old
 * regex's "attribute matched but value unusable" behavior.
 *
 * Deterministic and render-safe: DOMParser is the only DOM global used.
 */
export function readRootCompositionDuration(source: string): number | null {
  return readDocumentRootDuration(parseCompositionSource(source));
}

export function readDocumentRootDuration(doc: ParentNode | null | undefined): number | null {
  const raw = doc?.querySelector("[data-composition-id]")?.getAttribute("data-duration");
  if (raw == null) return null;
  return Number.parseFloat(raw);
}

/**
 * Rewrite the ROOT composition's `data-duration` value, preserving the rest of
 * the document byte-for-byte.
 *
 * We deliberately do NOT re-serialize the parsed Document: a DOMParser round-trip
 * injects `<html>/<head>/<body>`, forces double quotes, self-closes void
 * elements, and drops the original indentation — it reformats unrelated markup.
 * Instead we locate the root opening tag and rewrite only its `data-duration`
 * value in place, keeping the author's quote style. The targeted splice is
 * attribute-order-, quote-, and whitespace-agnostic.
 *
 * No-op (returns `source` unchanged) when there is no root composition tag or the
 * root tag has no `data-duration` attribute to replace.
 */
export function patchRootCompositionDuration(source: string, newValue: string): string {
  const rootTag = findRootOpenTag(source);
  if (!rootTag) return source;
  const patchedTag = rootTag[0].replace(
    DATA_DURATION_ATTR_RE,
    (_full, prefix: string, quote: string) => `${prefix}${quote}${newValue}${quote}`,
  );
  if (patchedTag === rootTag[0]) return source;
  return (
    source.slice(0, rootTag.index) + patchedTag + source.slice(rootTag.index + rootTag[0].length)
  );
}

/**
 * Grow-only ratchet: extend the root composition's `data-duration` to `newEnd`
 * when `newEnd` is larger than the current root duration. No-op otherwise (and
 * when there is no root duration to compare against).
 */
export function extendRootDurationInSource(source: string, newEnd: number): string {
  const current = readRootCompositionDuration(source);
  if (current == null || !(newEnd > current)) return source;
  return patchRootCompositionDuration(source, formatTimelineAttributeNumber(newEnd));
}
