"use strict";

(() => {
  if (globalThis.__lemon) return;

  let s = null;
  let v = null;
  let played = 0;
  let last = performance.now();
  let media = 0;
  let blocked = false;
  let attempting = false;
  let lastAttempt = 0;

  const seen = new WeakSet();

  const bvid = () =>
    location.pathname.match(
      /^\/video\/(BV[0-9A-Za-z]+)/
    )?.[1] || "";

  const findVideo = () =>
    document.querySelector(
      ".bpx-player-container video, #bilibili-player video, video"
    );

  function sample() {
    last = performance.now();
    media = v?.currentTime || 0;
  }

  function stop(reason) {
    if (!s) {
      s = {
        bvid: bvid(),
        paused: true,
        lease: Infinity,
        deadline: Infinity
      };
    }

    s.locked = true;
    s.reason = reason;
    v = v || findVideo();
    v?.pause();
  }

  function bind(video) {
    if (seen.has(video)) return;
    seen.add(video);

    video.addEventListener("play", () => {
      if (s && (s.locked || s.paused)) {
        video.pause();
      } else {
        blocked = false;
        sample();
      }
    });

    const events = [
      "waiting",
      "seeking",
      "seeked",
      "pause",
      "playing",
      "ratechange"
    ];

    for (const event of events) {
      video.addEventListener(event, () => {
        if (video === v) sample();
      });
    }

    video.addEventListener("ended", () => {
      if (video === v && s && !s.locked) {
        stop("ended");
      }
    });
  }

  async function play() {
    if (
      !s ||
      !v ||
      s.locked ||
      s.paused ||
      blocked ||
      attempting ||
      performance.now() - lastAttempt < 2000
    ) {
      return;
    }

    attempting = true;
    lastAttempt = performance.now();

    try {
      await v.play();
      blocked = false;
    } catch (error) {
      if (error.name === "NotAllowedError") {
        blocked = true;
      }
    } finally {
      attempting = false;
    }
  }

  function state() {
    return {
      bvid: bvid(),
      trackId: s?.trackId,
      played,
      ready: !!v,
      blocked,
      paused: v?.paused ?? true,
      reason: s?.reason || ""
    };
  }

  globalThis.__lemon = {
    command(message) {
      if (message.type === "init") {
        if (bvid() !== message.bvid) {
          return { error: "wrong_video" };
        }

        if (s?.trackId !== message.trackId) {
          s = {
            ...message,
            paused: !!message.paused,
            locked: false,
            reason: "",
            lease: Date.now() + 8000
          };

          played = 0;
          blocked = false;
          v = findVideo();

          if (v) {
            bind(v);
            v.muted = !!message.muted;

            try {
              v.currentTime = 0;
            } catch (_) {}

            if (s.paused) v.pause();
          }

          sample();
        }
      } else if (
        message.type === "pulse" &&
        s?.trackId === message.trackId
      ) {
        s.lease = Date.now() + 8000;
        s.deadline = message.deadline;

        const changed =
          s.paused !== !!message.paused;

        s.paused = !!message.paused;

        if (s.paused) v?.pause();
        if (changed) sample();
      } else if (message.type === "stop") {
        stop("stopped");
      }

      return state();
    }
  };

  setInterval(() => {
    const video = findVideo();

    if (video && video !== v) {
      v?.pause();
      v = video;
      bind(v);
      sample();

      if (s && !s.locked) {
        v.muted = !!s.muted;
      }
    }

    if (!s) return;

    const part =
      new URL(location.href).searchParams.get("p") || "1";

    if (bvid() !== s.bvid || part !== "1") {
      stop("navigated");
      return;
    }

    if (Date.now() > s.lease) {
      stop("lease");
      return;
    }

    if (
      !s.paused &&
      Number.isFinite(s.deadline) &&
      Date.now() >= s.deadline
    ) {
      stop("total");
      return;
    }

    if (!v) return;

    if (s.locked || s.paused) {
      if (!v.paused) v.pause();
      sample();
      return;
    }

    const time = performance.now();
    const elapsed = Math.max(0, (time - last) / 1000);
    const advanced = Math.max(
      0,
      v.currentTime - media
    );

    if (
      !v.paused &&
      !v.seeking &&
      v.readyState >= 3 &&
      advanced > 0
    ) {
      played += Math.min(
        elapsed,
        advanced / Math.max(0.1, v.playbackRate)
      );
    }

    last = time;
    media = v.currentTime;

    if (s.limit > 0 && played >= s.limit) {
      stop("limit");
    } else if (v.ended) {
      stop("ended");
    } else if (v.paused) {
      play();
    }
  }, 200);
})();
