import type { RuntimeDeterministicAdapter } from "../types";
import { swallow } from "../diagnostics";
import { clipStartSeconds, cssClip, isCssAnimation } from "./cssAnimation";

export function createWaapiAdapter(params?: {
  resolveStartSeconds?: (element: Element) => number;
  readPageAnimations?: () => Animation[];
}): RuntimeDeterministicAdapter {
  let didDiscover = false;
  let lastSeekTimeMs = 0;
  let animateHookInstalled = false;
  let hookedPrototype:
    | (Element & {
        animate?: Element["animate"];
        __hfOriginalAnimate?: Element["animate"];
      })
    | undefined;
  let originalAnimate: Element["animate"] | undefined;
  let installedAnimate: Element["animate"] | undefined;
  const animations = new Set<Animation>();
  type Baseline = { compositionTimeMs: number; animationTimeMs: number };
  type StartsWithClip = { clip: Element };
  let baselines = new WeakMap<Animation, Baseline | StartsWithClip>();
  let sawCssAnimation = false;
  // Clips boxless at the last pass, null in discover: new CSS animations in them came with the clip.
  let hiddenLastPass: Set<Element> | null = null;

  const snapshotAnimations = (
    read = params?.readPageAnimations ?? (() => document.getAnimations()),
  ) => {
    if (!document.getAnimations) return [];
    try {
      return read();
    } catch {
      return [];
    }
  };

  // No box means display:none on the clip or above; getComputedStyle would restyle each such clip.
  const readHiddenClips = () =>
    new Set(
      Array.from(document.querySelectorAll("[data-start]")).filter(
        (clip) => clip.checkVisibility?.() === false,
      ),
    );

  const cssAnimationClip = (animation: Animation): Element | null => {
    const target = isCssAnimation(animation)
      ? (animation.effect as KeyframeEffect | null)?.target
      : null;
    return target ? cssClip(target) : null;
  };

  const anchorOf = (baseline: Baseline | StartsWithClip): Baseline =>
    "clip" in baseline
      ? {
          compositionTimeMs: clipStartSeconds(baseline.clip, params?.resolveStartSeconds) * 1000,
          animationTimeMs: 0,
        }
      : baseline;

  const readAnimationTimeMs = (animation: Animation) => {
    const raw = Number(animation.currentTime);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  };

  const normalizeInitialAnimationTimeMs = (animationTimeMs: number, compositionTimeMs: number) => {
    if (compositionTimeMs <= 0) {
      return animationTimeMs;
    }

    if (animationTimeMs >= compositionTimeMs) {
      return Math.max(0, animationTimeMs - compositionTimeMs);
    }

    return animationTimeMs;
  };

  const ensureBaseline = (animation: Animation, compositionTimeMs: number) => {
    const existing = baselines.get(animation);
    if (existing) {
      return existing;
    }

    const clip = cssAnimationClip(animation);
    // A CSS animation's live currentTime is wall-clock time, never a timeline position.
    const baseline = clip
      ? hiddenLastPass === null || hiddenLastPass.has(clip)
        ? { clip }
        : { compositionTimeMs, animationTimeMs: 0 }
      : {
          compositionTimeMs,
          animationTimeMs: didDiscover
            ? normalizeInitialAnimationTimeMs(readAnimationTimeMs(animation), compositionTimeMs)
            : readAnimationTimeMs(animation),
        };
    baselines.set(animation, baseline);
    return baseline;
  };

  const trackAnimation = (animation: Animation, compositionTimeMs: number) => {
    if (!animations.has(animation)) {
      animations.add(animation);
      if (isCssAnimation(animation)) sawCssAnimation = true;
      const stopTracking = () => {
        animations.delete(animation);
      };
      try {
        animation.addEventListener("finish", stopTracking, { once: true });
        animation.addEventListener("cancel", stopTracking, { once: true });
      } catch (err) {
        swallow("runtime.adapters.waapi.site4", err);
      }
    }
    ensureBaseline(animation, compositionTimeMs);
  };

  const trackAnimations = (items: Animation[], compositionTimeMs: number) => {
    for (const animation of items) {
      trackAnimation(animation, compositionTimeMs);
    }
  };

  const installAnimateHook = () => {
    if (animateHookInstalled) return;
    if (typeof Element === "undefined") return;
    const proto = Element.prototype as Element & {
      animate?: Element["animate"];
      __hfOriginalAnimate?: Element["animate"];
    };
    if (typeof proto.animate !== "function" || proto.__hfOriginalAnimate) return;
    const original = proto.animate;
    try {
      Object.defineProperty(proto, "__hfOriginalAnimate", {
        value: original,
        configurable: true,
      });
      const wrappedAnimate = function (this: Element, ...args: Parameters<Element["animate"]>) {
        const animation = original.apply(this, args);
        trackAnimation(animation, lastSeekTimeMs);
        return animation;
      };
      proto.animate = wrappedAnimate;
      hookedPrototype = proto;
      originalAnimate = original;
      installedAnimate = wrappedAnimate;
      animateHookInstalled = true;
    } catch {
      // Best-effort only. Existing animations are still discovered via snapshot.
    }
  };

  // document.getAnimations() is surprisingly expensive in Chromium even when it returns [], and
  // renderSeek scans once per frame. After an empty discover, skip it until Element.animate (hooked
  // above) creates an animation, unless the page has CSS ones: a clip shown later brings new ones.
  const shouldScanOnSeek = () => !didDiscover || animations.size > 0 || sawCssAnimation;

  /**
   * End time (seconds, relative to composition start) for one animation.
   * `endSeconds` is set only when the timing is readable AND finite;
   * `unbounded` is true when a timing was read but its endTime is
   * Infinity/NaN (an infinite iteration count the caller can't auto-infer a
   * duration from) — distinct from "no timing available at all" (both
   * fields absent), which the caller should simply skip.
   */
  const inferAnimationEndSeconds = (
    animation: Animation,
  ): { endSeconds?: number; unbounded?: true } => {
    let timing: ComputedEffectTiming | null = null;
    try {
      timing = animation.effect?.getComputedTiming?.() ?? null;
    } catch (err) {
      swallow("runtime.adapters.waapi.site4", err);
    }
    if (!timing) return {};
    const endTimeMs = Number(timing.endTime);
    if (!Number.isFinite(endTimeMs)) return { unbounded: true };
    const clip = cssAnimationClip(animation);
    const baseline = baselines.get(animation) ?? (clip && { clip });
    const compositionStartSeconds = (baseline ? anchorOf(baseline).compositionTimeMs : 0) / 1000;
    return { endSeconds: compositionStartSeconds + endTimeMs / 1000 };
  };

  return {
    name: "waapi",
    discover: () => {
      didDiscover = true;
      installAnimateHook();
      hiddenLastPass = null;
      trackAnimations(snapshotAnimations(), lastSeekTimeMs);
      hiddenLastPass = readHiddenClips();
    },
    seek: (ctx) => {
      const timeMs = Math.max(0, (Number(ctx.time) || 0) * 1000);
      lastSeekTimeMs = timeMs;
      if (shouldScanOnSeek()) {
        trackAnimations(snapshotAnimations(ctx.pageAnimations), didDiscover ? timeMs : 0);
        // Read while the scan's style flush is fresh, before the writes below dirty it.
        if (didDiscover) hiddenLastPass = readHiddenClips();
      }
      for (const animation of animations) {
        const baseline = anchorOf(ensureBaseline(animation, didDiscover ? timeMs : 0));
        const localTimeMs =
          baseline.animationTimeMs + Math.max(0, timeMs - baseline.compositionTimeMs);
        try {
          animation.currentTime = localTimeMs;
        } catch (err) {
          // ignore animations that reject currentTime writes
          swallow("runtime.adapters.waapi.site1", err);
        }
        try {
          animation.pause();
        } catch (err) {
          // infinite unresolved animations can throw here until currentTime resolves
          swallow("runtime.adapters.waapi.site2", err);
        }
      }
    },
    pause: (ctx) => {
      if (!didDiscover) {
        trackAnimations(snapshotAnimations(ctx?.pageAnimations), lastSeekTimeMs);
      }
      for (const animation of animations) {
        try {
          animation.pause();
        } catch (err) {
          // ignore animation edge-cases
          swallow("runtime.adapters.waapi.site3", err);
        }
      }
    },
    revert: () => {
      animations.clear();
      baselines = new WeakMap();
      sawCssAnimation = false;
      hiddenLastPass = null;
      didDiscover = false;
      lastSeekTimeMs = 0;
      if (
        hookedPrototype &&
        originalAnimate &&
        installedAnimate &&
        hookedPrototype.animate === installedAnimate
      ) {
        try {
          hookedPrototype.animate = originalAnimate;
          if (hookedPrototype.__hfOriginalAnimate === originalAnimate) {
            delete hookedPrototype.__hfOriginalAnimate;
          }
        } catch (err) {
          swallow("runtime.adapters.waapi.site5", err);
        }
      }
      hookedPrototype = undefined;
      originalAnimate = undefined;
      installedAnimate = undefined;
      animateHookInstalled = false;
    },
    getInferredDurationSeconds: () => {
      let maxEndSeconds = 0;
      for (const animation of snapshotAnimations()) {
        const result = inferAnimationEndSeconds(animation);
        // Unbounded (Infinity/NaN endTime) animations are skipped here —
        // they never contribute to maxEndSeconds. A finite animation
        // elsewhere on the composition still supplies a valid duration
        // signal; only fall through to null when nothing finite was found.
        if (result.endSeconds != null) maxEndSeconds = Math.max(maxEndSeconds, result.endSeconds);
      }
      return maxEndSeconds > 0 ? maxEndSeconds : null;
    },
  };
}
