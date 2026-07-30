"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Beat ranges in mascot-multiply.mp4 (seconds). */
const SLEEP: [number, number] = [0.0, 2.58]; // loop, idle state
const WAKE: [number, number] = [2.58, 4.29]; // play once
const SIT: [number, number] = [4.29, 13.04]; // ping-pong, awake state
const DOZE: [number, number] = [13.04, 14.38]; // play once, then SLEEP

const IDLE_MS = 15000;
const DOZE_RATE = 0.45; // lying down takes ~3s

type Beat = "sleep" | "wake" | "sit-forward" | "sit-reverse" | "doze";

interface MascotProps {
  /** increment to wake the cat (input focus, clicks elsewhere) */
  awakeSignal: number;
  /** while the model is generating, the cat stays awake — a status indicator */
  busy: boolean;
}

export default function Mascot({ awakeSignal, busy }: MascotProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The sitting pose's baseline sits higher in the frame than the sleeping
  // pose's; the `awake` class shifts the video up to compensate (CSS in
  // globals.css). Set when WAKE starts, cleared when DOZE starts.
  const [awake, setAwake] = useState(false);
  const beatRef = useRef<Beat>("sleep");
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reverseRaf = useRef<number | null>(null);
  const reducedMotion = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
        setAwake(false);
        v.currentTime = DOZE[0];
        v.playbackRate = DOZE_RATE;
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
      setAwake(true);
      v.playbackRate = 1;
      v.currentTime = WAKE[0];
      void v.play();
    }
  }, [resetIdleTimer]);

  // Beat state machine driven by timeupdate
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    reducedMotion.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (reducedMotion.current) {
      // No animation: hold a single sleeping frame.
      v.pause();
      v.currentTime = 1.0;
      return;
    }

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
          if (t >= DOZE[1] - 0.05 || v.ended) {
            beatRef.current = "sleep";
            v.playbackRate = 1;
            v.currentTime = SLEEP[0];
            void v.play();
          }
          break;
      }
    };

    const onEnded = () => {
      if (beatRef.current === "doze" || beatRef.current === "sleep") {
        beatRef.current = "sleep";
        v.playbackRate = 1;
        v.currentTime = SLEEP[0];
        void v.play();
      }
    };

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    // Start asleep
    beatRef.current = "sleep";
    v.currentTime = SLEEP[0];
    void v.play();

    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      stopReverse();
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

  // While generating, keep the cat awake
  useEffect(() => {
    if (busy) wakeUp();
  }, [busy, wakeUp]);

  return (
    <button
      type="button"
      onClick={wakeUp}
      aria-label="Wake the mascot"
      // 216x164 source at 300px wide -> 228px tall. The sleeping cat's paws
      // sit 24.6% of frame height above the video's bottom edge; overlapping
      // the bar by 27% of the rendered height (61px) lands the paws ~5px
      // onto the bar's surface: top = -(228 - 61) = -167px, 40px in from
      // the bar's left edge. No z-index here: it would create a stacking
      // context that isolates the multiply blend and brings the white
      // video background back — paint order comes from DOM position after
      // the Composer.
      className={`mascot ${awake ? "awake" : ""} absolute -top-[167px] left-10 h-[228px] w-[300px] cursor-pointer select-none focus:outline-none`}
    >
      <video
        ref={videoRef}
        src="/mascot-multiply.mp4"
        muted
        playsInline
        preload="auto"
        className="h-full w-full"
      />
    </button>
  );
}
