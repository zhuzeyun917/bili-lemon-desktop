"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Core = require("./core.cjs");
const { Engine } = require("./engine.cjs");

let passed = 0;

const read = name => fs.readFileSync(
  path.join(__dirname, name),
  "utf8"
);

function check(name, condition) {
  if (!condition) {
    throw new Error("FAIL: " + name);
  }

  passed++;
  console.log("PASS: " + name);
}

async function main() {
  const files = [
    "main.cjs",
    "preload.cjs",
    "engine.cjs",
    "core.cjs",
    "agent.js",
    "ui/core.js",
    "ui/renderer.js",
    "ui/control.html",
    "ui/control.css",
    "ui/yellow.css",
    "LICENSE"
  ];

  for (const name of files) {
    const text = read(name);

    check(
      "file exists: " + name,
      text.length > 0
    );

    if (/\.(cjs|js)$/.test(name)) {
      new Function(text);
    }
  }

  check(
    "format time",
    Core.format(3661) === "01:01:01"
  );

  check(
    "loop wraps",
    Core.nextIndex(1, 2, true) === 0
  );

  check(
    "once stops",
    Core.nextIndex(1, 2, false) === -1
  );

  check(
    "default duration",
    Core.itemLimit({ seconds: "" }, 60) === 60
  );

  check(
    "full duration",
    Core.itemLimit({ seconds: "0" }, 60) === 0
  );

  check(
    "folder URL",
    Core.folderId(
      "https://space.bilibili.com/1/favlist?fid=42"
    ) === "42"
  );

  let rejected = false;

  try {
    Core.folderId("https://example.com/?fid=42");
  } catch (_) {
    rejected = true;
  }

  check("reject foreign folder host", rejected);

  let now = 100000;
  let current = "";
  let state = {};

  const io = {
    navigate: async bvid => {
      current = bvid;

      state = {
        bvid,
        trackId: null,
        played: 0,
        ready: true,
        paused: false,
        reason: ""
      };
    },

    command: async message => {
      if (message.type === "init") {
        state.trackId = message.trackId;
      }

      return { ...state };
    },

    emit: () => {},
    notice: () => {}
  };

  const engine = new Engine(io, () => now);

  const queue = [
    {
      bvid: "BVone",
      title: "one",
      seconds: ""
    },
    {
      bvid: "BVtwo",
      title: "two",
      seconds: "90"
    }
  ];

  const settings = {
    seconds: 60,
    gap: 10,
    total: 2,
    mode: "loop",
    muted: true,
    unlimited: false
  };

  await engine.start(queue, settings);
  await engine.tick();

  check(
    "starts first item",
    current === "BVone"
  );

  check(
    "individual override",
    engine.run.queue[1].limit === 90
  );

  now += 10000;
  state.played = 10;

  await engine.tick();

  check(
    "remaining time",
    engine.snapshot().remaining === 110
  );

  await engine.pause();
  now += 50000;
  await engine.tick();

  check(
    "pause freezes timer",
    engine.snapshot().remaining === 110
  );

  await engine.pause();

  state.reason = "ended";
  await engine.tick();

  check(
    "enters interval",
    engine.run.phase === "gap"
  );

  now += 10000;
  await engine.tick();

  check(
    "plays next item",
    current === "BVtwo"
  );

  await engine.tick();

  state.reason = "ended";
  await engine.tick();

  now += 10000;
  await engine.tick();

  check(
    "automatically loops",
    current === "BVone" &&
    engine.run.round === 2
  );

  now = engine.run.deadline;
  await engine.tick();

  check(
    "total duration stops",
    !engine.run
  );

  await engine.start(
    [queue[0]],
    { ...settings, unlimited: true }
  );

  await engine.tick();

  now += 30 * 86400000;
  state.played = 100;

  await engine.tick();

  check(
    "unlimited stays active",
    !!engine.run
  );

  check(
    "unlimited deadline",
    engine.run.deadline === null
  );

  await engine.pause();
  now += 10000;
  await engine.pause();

  check(
    "unlimited resume",
    engine.run.deadline === null
  );

  for (let i = 0; i < 3; i++) {
    state.reason = "ended";

    await engine.tick();

    now += 10000;

    await engine.tick();
    await engine.tick();
  }

  check(
    "three automatic repeats",
    engine.run.round === 4
  );

  await engine.stop();

  check("manual stop", !engine.run);

  await engine.start(
    [queue[0]],
    { ...settings, mode: "once" }
  );

  await engine.tick();

  state.reason = "ended";
  await engine.tick();

  check("once completes", !engine.run);

  console.log(
    "\n" + passed + " checks passed."
  );

  console.log(
    "Logic checks only; real login and " +
    "desktop playback are not verified."
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
