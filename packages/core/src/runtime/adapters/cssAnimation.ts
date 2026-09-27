/** A CSSAnimation from any realm: CSS transitions and script animations have no animationName. */
export const isCssAnimation = (animation: Animation): animation is CSSAnimation =>
  "animationName" in animation;

/**
 * The clip a CSS animation on `element` belongs to: the nearest `[data-start]` ancestor-or-self,
 * walking out of shadow trees to the outermost host first.
 */
export function cssClip(element: Element): Element {
  let owner = element;
  for (let root = owner.getRootNode(); root.nodeType === 11 && "host" in root; ) {
    owner = (root as ShadowRoot).host;
    root = owner.getRootNode();
  }
  return owner.closest("[data-start]") ?? owner;
}

export function clipStartSeconds(
  clip: Element,
  resolveStartSeconds?: (element: Element) => number,
): number {
  return resolveStartSeconds
    ? resolveStartSeconds(clip)
    : Number.parseFloat(clip.getAttribute("data-start") ?? "0") || 0;
}
