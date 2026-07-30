"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

type Beat = "sleep" | "wake" | "sit-forward" | "sit-reverse" | "doze";

interface MascotProps {
  /** increment to wake the cat (input focus, clicks elsewhere) */
  awakeSignal: number;
  /** increment to reset the cat straight back to sleeping (new chat) */
  resetSignal: number;
  /** while the model is generating, the cat stays awake — a status indicator */
  busy: boolean;
}

export default function Mascot({ awakeSignal, resetSignal, busy }: MascotProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const beatRef = useRef<Beat>("sleep");
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reverseRaf = useRef<number | null>(null);
  const pinRaf = useRef<number | null>(null);
  const offsetsRef = useRef<number[] | null>(null);
  const reducedMotion = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // WebM with alpha is the primary source; only the MP4 fallback needs the
  // multiply blend to hide its white background.
  const [mp4Fallback, setMp4Fallback] = useState(false);

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
        void v.play();
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
      void v.play();
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
    void v.play();
  }, []);

  // Beat state machine driven by timeupdate + per-frame contact pinning
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    reducedMotion.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // Multiply is needed only when the browser fell back to the MP4 source.
    const onLoadedData = () => {
      setMp4Fallback(v.currentSrc.endsWith(".mp4"));
    };
    v.addEventListener("loadeddata", onLoadedData);
    if (v.readyState >= 2 && v.currentSrc) onLoadedData();

    if (reducedMotion.current) {
      // No animation: hold a single sleeping frame (offset there is ~0).
      v.pause();
      v.currentTime = 1.0;
      return () => {
        v.removeEventListener("loadeddata", onLoadedData);
      };
    }

    // Per-frame vertical offsets (percent) keyed to the video clock keep
    // the cat's contact line pinned to the bar in every beat and in both
    // directions of the SIT ping-pong. No CSS transition could do this:
    // the video's motion is a step, not a curve.
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
      if (offsets) {
        const f = Math.max(
          0,
          Math.min(offsets.length - 1, Math.round(v.currentTime * OFFSETS_FPS)),
        );
        v.style.transform = `translateY(${offsets[f]}%)`;
      }
      pinRaf.current = requestAnimationFrame(pin);
    };
    pinRaf.current = requestAnimationFrame(pin);

    const startReverse = () => {
      // Browsers do not support negative playbackRate — step currentTime
      // backwards manually until the start of SIT, then play forward again.
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
          void v.play();
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
      void v.play();
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
    void v.play();

    return () => {
      v.removeEventListener("loadeddata", onLoadedData);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      stopReverse();
      if (pinRaf.current !== null) cancelAnimationFrame(pinRaf.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

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
    // exactly at the bar's top edge (the video overlaps the bar by
    // --mascot-w * 0.325).
    <div
      className={`mascot ${mp4Fallback ? "mp4-fallback" : ""} select-none`}
    >
      <video ref={videoRef} muted playsInline preload="auto">
        <source src="/mascot.webm" type="video/webm" />
        <source src="/mascot-multiply.mp4" type="video/mp4" />
      </video>
      <button
        type="button"
        onClick={wakeUp}
        aria-label="Wake the mascot"
        className="pointer-events-auto absolute inset-x-0 top-0 h-[calc(100%-var(--mascot-w)*0.325)] cursor-pointer focus:outline-none"
      />
    </div>
  );
}
