"use client";

import { useCallback, useEffect, useRef } from "react";

/** Beat ranges in the mascot video (seconds). WAKE starts at the frame
 *  where the cat actually begins to move — frames 62-85 of the original
 *  beat are a motionless dead second, and skipping them is invisible
 *  (silhouette identical within 0.5%). */
const SLEEP: [number, number] = [0.0, 2.58]; // loop, idle state
const WAKE: [number, number] = [3.54, 4.29]; // play once — 0.75s
const SIT: [number, number] = [4.29, 13.04]; // ping-pong, awake state
const DOZE: [number, number] = [13.04, 14.38]; // play once, then SLEEP

const IDLE_MS = 15000;
const OFFSETS_FPS = 24;

/** Canvas keying (the one code path for every browser — iOS WebKit ignores
 *  VP9 alpha, so the opaque MP4 is decoded off-screen and its flat white
 *  background is keyed out per frame here instead). T is the distance from
 *  white that counts as opaque — the same threshold used to build
 *  mascot-offsets.json, so the keyed silhouette matches the measured
 *  landmarks exactly. Do not change it. */
const KEY_T = 45;
const CANVAS_FULL: [number, number] = [320, 243];
const CANVAS_SMALL: [number, number] = [256, 194]; // below 430px viewports

type Beat = "sleep" | "wake" | "sit-forward" | "sit-reverse" | "doze";

/** Autoplay only works while muted; if it is refused anyway, the paused
 *  video still decodes its first (sleeping) frame, which the seek/load
 *  listeners key onto the canvas as a still — a sleeping cat, not a blank
 *  box. */
function safePlay(v: HTMLVideoElement) {
  v.play().catch(() => {});
}

interface MascotProps {
  /** increment to wake the cat (input focus, clicks elsewhere) */
  awakeSignal: number;
  /** increment to reset the cat straight back to sleeping (new chat) */
  resetSignal: number;
  /** while the model is generating, the cat stays awake — a status indicator */
  busy: boolean;
  /** true while the on-screen keyboard covers the bar: fade out and pause */
  hidden?: boolean;
}

export default function Mascot({
  awakeSignal,
  resetSignal,
  busy,
  hidden = false,
}: MascotProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const shiftRef = useRef<HTMLDivElement>(null);
  const beatRef = useRef<Beat>("sleep");
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reverseRaf = useRef<number | null>(null);
  const pinRaf = useRef<number | null>(null);
  const offsetsRef = useRef<number[] | null>(null);
  const reducedMotion = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const onscreenRef = useRef(true);
  // Set by the mount effect so the hidden-prop effect can re-apply the run
  // state without owning the loops.
  const applyRunStateRef = useRef<(() => void) | null>(null);

  const stopReverse = () => {
    if (reverseRaf.current !== null) cancelAnimationFrame(reverseRaf.current);
    reverseRaf.current = null;
  };

  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(function onIdle() {
      // Never doze off mid-generation — reschedule instead.
      if (busyRef.current) {
        idleTimer.current = setTimeout(onIdle, IDLE_MS);
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      if (beatRef.current === "sit-forward" || beatRef.current === "sit-reverse") {
        stopReverse();
        beatRef.current = "doze";
        v.currentTime = DOZE[0];
        safePlay(v);
      }
    }, IDLE_MS);
  }, []);

  const wakeUp = useCallback(() => {
    const v = videoRef.current;
    if (!v || reducedMotion.current) return;
    resetIdleTimer();
    if (beatRef.current === "sleep" || beatRef.current === "doze") {
      stopReverse();
      beatRef.current = "wake";
      v.currentTime = WAKE[0];
      safePlay(v);
    }
  }, [resetIdleTimer]);

  /** Straight back to the sleeping loop from the first frame (new chat). */
  const resetToSleep = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    stopReverse();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    beatRef.current = "sleep";
    if (reducedMotion.current) {
      v.pause();
      v.currentTime = 1.0;
      return;
    }
    v.currentTime = 0;
    safePlay(v);
  }, []);

  // Beat state machine driven by timeupdate + per-frame keying and pinning
  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;

    reducedMotion.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctxRef.current = ctx;
    if (!ctx) {
      // 2d contexts essentially never fail, but an empty box is the worst
      // outcome — degrade to showing the raw (opaque) video instead.
      v.style.position = "";
      v.style.width = "100%";
      v.style.height = "";
      v.style.opacity = "";
      c.style.display = "none";
      if (!reducedMotion.current) safePlay(v);
      return;
    }

    // Keying resolution: ~7.5M array writes/s at 320x243, dropped further
    // on small phones. The media query is live so rotation re-sizes it.
    const smallMq = window.matchMedia("(max-width: 430px)");
    const sizeCanvas = () => {
      const [w, h] = smallMq.matches ? CANVAS_SMALL : CANVAS_FULL;
      if (c.width !== w) {
        c.width = w;
        c.height = h;
        keyFrame();
      }
    };

    /** Draw the current video frame and key the flat white background out.
     *  Edge pixels are un-composited from the white they were blended with,
     *  which is what keeps the outline from looking chalky. */
    const keyFrame = () => {
      if (v.readyState < 2) return;
      const CW = c.width;
      const CH = c.height;
      ctx.drawImage(v, 0, 0, CW, CH);
      const img = ctx.getImageData(0, 0, CW, CH);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        const a = (255 - min) / KEY_T;
        if (a >= 1) {
          d[i + 3] = 255;
          continue;
        }
        if (a <= 0) {
          d[i + 3] = 0;
          continue;
        }
        d[i] = (d[i] - 255 * (1 - a)) / a;
        d[i + 1] = (d[i + 1] - 255 * (1 - a)) / a;
        d[i + 2] = (d[i + 2] - 255 * (1 - a)) / a;
        d[i + 3] = a * 255;
      }
      ctx.putImageData(img, 0, 0);
    };

    // Keying loop: once per decoded frame where requestVideoFrameCallback
    // exists, once per display refresh otherwise.
    const hasRvfc = "requestVideoFrameCallback" in v;
    let drawActive = false;
    let drawHandle: number | null = null;
    const scheduleDraw = () => {
      if (!drawActive) return;
      if (hasRvfc) {
        drawHandle = v.requestVideoFrameCallback(() => {
          keyFrame();
          scheduleDraw();
        });
      } else {
        drawHandle = requestAnimationFrame(() => {
          keyFrame();
          scheduleDraw();
        });
      }
    };
    const startDraw = () => {
      if (drawActive) return;
      drawActive = true;
      scheduleDraw();
    };
    const stopDraw = () => {
      drawActive = false;
      if (drawHandle !== null) {
        if (hasRvfc) {
          v.cancelVideoFrameCallback(drawHandle);
        } else {
          cancelAnimationFrame(drawHandle);
        }
        drawHandle = null;
      }
    };

    // Stills while the loop is not running: every seek (reduced-motion
    // frame, new-chat reset, the reversed SIT leg's currentTime stepping)
    // and the first decoded frame get keyed once. Cheap — one frame.
    const onSeeked = () => keyFrame();
    const onLoaded = () => keyFrame();
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadeddata", onLoaded);

    sizeCanvas();
    smallMq.addEventListener("change", sizeCanvas);

    if (reducedMotion.current) {
      // No animation: hold a single keyed sleeping frame (offset there ~0).
      v.pause();
      v.currentTime = 1.0; // onSeeked keys it onto the canvas
      return () => {
        v.removeEventListener("seeked", onSeeked);
        v.removeEventListener("loadeddata", onLoaded);
        smallMq.removeEventListener("change", sizeCanvas);
      };
    }

    // Per-frame vertical offsets (percent) keyed to the video clock keep
    // the cat's contact line pinned to the bar in every beat and in both
    // directions of the SIT ping-pong. No CSS transition could do this:
    // the video's motion is a step, not a curve. The offset goes on the
    // .mascot-shift wrapper — transforming the drawing surface itself
    // promotes it to its own compositing layer.
    void fetch("/mascot-offsets.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: number[] | null) => {
        if (Array.isArray(data) && data.length > 0) offsetsRef.current = data;
      })
      .catch(() => {
        /* without offsets the cat still animates, just unpinned */
      });

    const pin = () => {
      const offsets = offsetsRef.current;
      const shift = shiftRef.current;
      if (offsets && shift) {
        const f = Math.max(
          0,
          Math.min(offsets.length - 1, Math.round(v.currentTime * OFFSETS_FPS)),
        );
        shift.style.transform = `translateY(${offsets[f]}%)`;
      }
      pinRaf.current = requestAnimationFrame(pin);
    };
    const startPin = () => {
      if (pinRaf.current === null) pinRaf.current = requestAnimationFrame(pin);
    };
    const stopPin = () => {
      if (pinRaf.current !== null) cancelAnimationFrame(pinRaf.current);
      pinRaf.current = null;
    };

    // One gate for every pause condition: keyboard-hidden (6b), tab in the
    // background, element off-screen. Any of them stops the keying loop,
    // the pin loop and the video so nothing burns battery while invisible.
    const applyRunState = () => {
      const run =
        !hiddenRef.current && !document.hidden && onscreenRef.current;
      if (!run) {
        stopPin();
        stopDraw();
        stopReverse();
        v.pause();
      } else {
        startPin();
        startDraw();
        if (beatRef.current === "sit-reverse") beatRef.current = "sit-forward";
        safePlay(v);
      }
    };
    applyRunStateRef.current = applyRunState;

    const onVisibility = () => applyRunState();
    document.addEventListener("visibilitychange", onVisibility);

    const io = new IntersectionObserver((entries) => {
      onscreenRef.current = entries[0]?.isIntersecting ?? true;
      applyRunState();
    });
    io.observe(c);

    const startReverse = () => {
      // Browsers do not support negative playbackRate — step currentTime
      // backwards manually until the start of SIT, then play forward again.
      // Each step's seek fires onSeeked, which keys the frame.
      beatRef.current = "sit-reverse";
      v.pause();
      let last = performance.now();
      const step = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        const t = v.currentTime - dt;
        if (t <= SIT[0]) {
          v.currentTime = SIT[0];
          beatRef.current = "sit-forward";
          safePlay(v);
          return;
        }
        v.currentTime = t;
        reverseRaf.current = requestAnimationFrame(step);
      };
      reverseRaf.current = requestAnimationFrame(step);
    };

    const backToSleep = () => {
      beatRef.current = "sleep";
      v.currentTime = SLEEP[0];
      safePlay(v);
    };

    const onTime = () => {
      const t = v.currentTime;
      switch (beatRef.current) {
        case "sleep":
          if (t >= SLEEP[1] - 0.05) v.currentTime = SLEEP[0];
          break;
        case "wake":
          if (t >= WAKE[1]) {
            beatRef.current = "sit-forward";
          }
          break;
        case "sit-forward":
          if (t >= SIT[1] - 0.05) startReverse();
          break;
        case "doze":
          if (t >= DOZE[1] - 0.05 || v.ended) backToSleep();
          break;
      }
    };

    const onEnded = () => {
      if (beatRef.current === "doze" || beatRef.current === "sleep") {
        backToSleep();
      }
    };

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    // Start asleep
    beatRef.current = "sleep";
    v.currentTime = SLEEP[0];
    applyRunState();

    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadeddata", onLoaded);
      document.removeEventListener("visibilitychange", onVisibility);
      smallMq.removeEventListener("change", sizeCanvas);
      io.disconnect();
      stopReverse();
      stopPin();
      stopDraw();
      applyRunStateRef.current = null;
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // Keyboard open: fade handled by the .mascot-hidden class; the run-state
  // gate pauses the video and both loops so nothing animates while
  // invisible. On restore, a mid-reverse beat resumes forward — the
  // ping-pong picks the reverse leg up again on its own.
  useEffect(() => {
    if (reducedMotion.current) return;
    applyRunStateRef.current?.();
  }, [hidden]);

  // External wake triggers
  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    wakeUp();
  }, [awakeSignal, wakeUp]);

  // New chat: straight back to sleeping from the first frame
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    resetToSleep();
  }, [resetSignal, resetToSleep]);

  // While generating, keep the cat awake
  useEffect(() => {
    if (busy) wakeUp();
  }, [busy, wakeUp]);

  return (
    // Size and position come from the .mascot rules in globals.css, all
    // derived from --mascot-w. The wrapper is click-through so the bar's
    // controls stay usable under the paws; the wake hit-area below stops
    // exactly at the bar's top edge (the canvas overlaps the bar by
    // --mascot-w * 0.325).
    <div className={`mascot select-none ${hidden ? "mascot-hidden" : ""}`}>
      <div ref={shiftRef} className="mascot-shift">
        <canvas ref={canvasRef} aria-hidden="true" />
      </div>
      {/* Decode source only, never displayed: the keying loop above draws
          it to the canvas with the white background removed. This is the
          one mascot path for every browser — iOS WebKit cannot decode
          VP9 alpha, so no WebM and no alpha filter exist anywhere. */}
      <video
        ref={videoRef}
        src="/mascot-multiply.mp4"
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />
      <button
        type="button"
        onClick={wakeUp}
        aria-label="Wake the mascot"
        className="pointer-events-auto absolute inset-x-0 top-0 h-[calc(100%-var(--mascot-w)*0.325)] cursor-pointer focus:outline-none"
      />
    </div>
  );
}
