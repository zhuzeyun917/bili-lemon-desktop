"use strict";

const Core = (() => {
  function number(value, name, min, max) {
    if (String(value).trim() === "") {
      throw new Error(name + "不能为空");
    }

    const n = Number(value);

    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${name}应在 ${min}～${max} 之间`);
    }

    return n;
  }

  function format(seconds) {
    const n = Math.max(0, Math.ceil(Number(seconds) || 0));

    return [
      Math.floor(n / 3600),
      Math.floor(n / 60) % 60,
      n % 60
    ]
      .map(x => String(x).padStart(2, "0"))
      .join(":");
  }

  function nextIndex(index, length, loop) {
    if (index + 1 < length) {
      return index + 1;
    }

    return loop && length > 0 ? 0 : -1;
  }

  function folderId(value) {
    const text = String(value).trim();

    if (/^\d+$/.test(text)) {
      return text;
    }

    let url;

    try {
      url = new URL(text);
    } catch (_) {
      throw new Error("请输入收藏夹 ID 或完整收藏夹网址");
    }

    if (
      url.protocol !== "https:" ||
      !/(^|\.)bilibili\.com$/.test(url.hostname)
    ) {
      throw new Error("仅接受 HTTPS B 站收藏夹网址");
    }

    const id =
      url.searchParams.get("fid") ||
      url.pathname.match(/\/medialist\/detail\/(\d+)/)?.[1];

    if (!id || !/^\d+$/.test(id)) {
      throw new Error(
        "网址中没有收藏夹 fid，请从收藏夹页面复制网址"
      );
    }

    return id;
  }

  function itemLimit(item, fallback) {
    return item.seconds === "" || item.seconds == null
      ? fallback
      : number(item.seconds, "单条时长", 0, 86400);
  }

  return {
    number,
    format,
    nextIndex,
    folderId,
    itemLimit
  };
})();
