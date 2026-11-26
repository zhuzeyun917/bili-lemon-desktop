"use strict";

const Core = require("./core.cjs");
const { randomUUID } = require("node:crypto");

class Engine {
  constructor(io, clock = () => Date.now()) {
    this.io = io;
    this.clock = clock;
    this.run = null;
    this.busy = false;
    this.stopping = false;
  }

  snapshot() {
    const r = this.run;

    if (!r) {
      return {
        active: false,
        status: this.label || "未开始"
      };
    }

    const time = r.paused
      ? r.pauseAt
      : this.clock();

    return {
      active: true,
      paused: r.paused,
      status: r.paused ? "已暂停" : r.status,
      phase: r.phase,
      title: r.queue[r.index].title,
      index: r.index,
      length: r.queue.length,
      round: r.round,
      played: r.played,
      total: r.total,
      unlimited: r.unlimited,
      remaining: r.unlimited
        ? null
        : Math.max(0, (r.deadline - time) / 1000),
      gapLeft: r.phase === "gap"
        ? Math.max(0, (r.gapEnd - time) / 1000)
        : null
    };
  }

  emit() {
    this.io.emit(this.snapshot());
  }

  async start(queue, settings) {
    if (this.run || this.stopping) {
      throw new Error("请先停止当前任务");
    }

    const limit = Core.number(
      settings.seconds,
      "默认秒数",
      0,
      86400
    );

    const gap = Core.number(
      settings.gap,
      "间隔秒数",
      0,
      86400
    );

    const unlimited = settings.unlimited === true;

    const total = unlimited
      ? null
      : Core.number(
          settings.total,
          "总分钟数",
          0.1,
          10080
        ) * 60;

    if (
      !Array.isArray(queue) ||
      !queue.length ||
      queue.length > 10000
    ) {
      throw new Error("请选择 1～10000 个视频");
    }

    queue = queue.map(item => {
      if (!/^BV[0-9A-Za-z]+$/.test(item.bvid)) {
        throw new Error("无效视频 ID");
      }

      return {
        bvid: item.bvid,
        title: String(item.title).slice(0, 500),
        limit: Core.itemLimit(item, limit)
      };
    });

    const r = {
      id: randomUUID(),
      queue,
      gap,
      total,
      unlimited,
      loop: settings.mode === "loop",
      muted: !!settings.muted,
      deadline: unlimited
        ? null
        : this.clock() + total * 1000,
      paused: false,
      index: 0,
      round: 1,
      played: 0,
      phase: "opening",
      status: "加载中"
    };

    this.run = r;

    try {
      await this.open(r, 0);
    } catch (error) {
      await this.stop("出错");
      throw error;
    }
  }

  async open(r, index) {
    if (this.run !== r) return;

    r.index = index;
    r.trackId = randomUUID();
    r.phase = "opening";
    r.status = "加载中";
    r.played = 0;
    r.opened = this.clock();
    r.progressAt = this.clock();
    r.prevPlayed = 0;
    r.gapEnd = 0;

    this.emit();

    await this.io.navigate(r.queue[index].bvid);

    if (this.run !== r) {
      try {
        await this.io.command({ type: "stop" });
      } catch (_) {}

      return;
    }

    r.phase = "loading";
    this.emit();
  }

  async stop(label = "已停止") {
    if (this.stopping) return;

    this.stopping = true;
    this.run = null;
    this.label = label;

    this.emit();

    try {
      await this.io.command({ type: "stop" });
    } catch (_) {
    } finally {
      this.stopping = false;
    }
  }

  async pause() {
    const r = this.run;
    if (!r) return;

    if (!r.paused) {
      r.paused = true;
      r.pauseAt = this.clock();
    } else {
      const duration = this.clock() - r.pauseAt;

      if (!r.unlimited) {
        r.deadline += duration;
      }

      r.opened += duration;
      r.progressAt += duration;

      if (r.gapEnd) {
        r.gapEnd += duration;
      }

      r.paused = false;
    }

    try {
      await this.io.command({
        type: "pulse",
        trackId: r.trackId,
        deadline: r.deadline,
        paused: r.paused || r.phase === "gap"
      });
    } catch (_) {}

    this.emit();
  }

  async next() {
    if (
      !this.run ||
      this.run.paused ||
      this.busy
    ) {
      return;
    }

    this.busy = true;

    try {
      await this.advance(this.run);
    } finally {
      this.busy = false;
    }
  }

  async advance(r) {
    try {
      await this.io.command({
        type: "pulse",
        trackId: r.trackId,
        deadline: r.deadline,
        paused: true
      });
    } catch (_) {}

    if (this.run !== r) return;

    const index = Core.nextIndex(
      r.index,
      r.queue.length,
      r.loop
    );

    if (index < 0) {
      await this.stop("清单播放完成");
      return;
    }

    r.next = index;
    r.phase = "gap";
    r.status = "间隔等待";
    r.gapEnd = this.clock() + r.gap * 1000;

    this.emit();
  }

  async tick() {
    if (this.busy || !this.run) return;

    this.busy = true;
    const r = this.run;

    try {
      if (
        !r.paused &&
        !r.unlimited &&
        this.clock() >= r.deadline
      ) {
        await this.stop("总时长已到");
        return;
      }

      if (r.phase === "opening") return;

      if (r.phase === "gap") {
        try {
          await this.io.command({
            type: "pulse",
            trackId: r.trackId,
            deadline: r.deadline,
            paused: true
          });
        } catch (_) {}

        if (this.run !== r) return;

        if (
          !r.paused &&
          this.clock() >= r.gapEnd
        ) {
          if (r.next === 0) {
            r.round++;
          }

          await this.open(r, r.next);
        }

        return;
      }

      let state;

      try {
        state = await this.io.command({
          type: "peek"
        });

        if (this.run !== r) return;

        if (
          state.bvid !== r.queue[r.index].bvid
        ) {
          if (
            !r.paused &&
            this.clock() - r.opened > 15000
          ) {
            await this.stop(
              "播放页发生跳转或视频不可访问"
            );
          }

          return;
        }

        if (state.trackId !== r.trackId) {
          state = await this.io.command({
            type: "init",
            trackId: r.trackId,
            bvid: r.queue[r.index].bvid,
            limit: r.queue[r.index].limit,
            deadline: r.deadline,
            muted: r.muted,
            paused: r.paused
          });
        }

        if (this.run !== r) return;

        state = await this.io.command({
          type: "pulse",
          trackId: r.trackId,
          deadline: r.deadline,
          paused: r.paused
        });
      } catch (_) {
        if (
          this.run === r &&
          !r.paused &&
          this.clock() - r.opened > 45000
        ) {
          await this.stop(
            "45 秒内无法连接播放器，请确认视频与登录状态"
          );
        }

        return;
      }

      if (this.run !== r || !state) return;

      if (
        ["lease", "navigated", "total"].includes(
          state.reason
        )
      ) {
        await this.stop(
          state.reason === "total"
            ? "总时长已到"
            : "播放器连接中断或页面跳转，已安全停止"
        );

        return;
      }

      if (r.paused) return;

      r.played = Number(state.played) || 0;

      if (
        ["limit", "ended"].includes(state.reason)
      ) {
        await this.advance(r);
        return;
      }

      r.status = state.blocked
        ? "请在视频窗口点播放"
        : !state.ready
          ? "等待播放器"
          : state.paused
            ? "等待播放"
            : "播放中";

      if (state.ready) {
        r.phase = "playing";
      }

      if (r.played > r.prevPlayed + 0.05) {
        r.progressAt = this.clock();
        r.prevPlayed = r.played;
      }

      if (
        !state.ready &&
        this.clock() - r.opened > 60000
      ) {
        await this.stop(
          "未找到播放器，请检查视频访问权限"
        );
      } else if (
        state.ready &&
        !state.blocked &&
        this.clock() - r.progressAt > 120000
      ) {
        await this.stop(
          "视频 2 分钟无进展，已停止"
        );
      }
    } catch (error) {
      await this.stop("播放异常");
      this.io.notice(error.message, true);
    } finally {
      this.busy = false;
      this.emit();
    }
  }
}

module.exports = { Engine };

    
