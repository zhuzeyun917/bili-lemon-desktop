"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  powerMonitor,
  Menu
} = require("electron");

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Core = require("./core.cjs");
const { Engine } = require("./engine.cjs");

let controller = null;
let player = null;
let biliSession;
let engine;
let configFile;
let timer;

let config = {
  settings: {
    seconds: "60",
    gap: "10",
    total: "120",
    mode: "loop",
    muted: true,
    unlimited: false
  },
  items: [],
  yellowTheme: true,
  lastFolder: ""
};

let loadController = null;
let account = null;
let cssKey = null;

const agent = fs.readFileSync(
  path.join(__dirname, "agent.js"),
  "utf8"
);

const yellow = fs.readFileSync(
  path.join(__dirname, "ui", "yellow.css"),
  "utf8"
);

const controlURL = pathToFileURL(
  path.join(__dirname, "ui", "control.html")
).href;

function allowedURL(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (
        url.hostname === "bilibili.com" ||
        url.hostname.endsWith(".bilibili.com")
      )
    );
  } catch (_) {
    return false;
  }
}

function notice(text, error = false) {
  if (controller && !controller.isDestroyed()) {
    controller.webContents.send(
      "desktop:notice",
      { text, error }
    );
  }
}

function emit(state) {
  if (controller && !controller.isDestroyed()) {
    controller.webContents.send(
      "desktop:state",
      state
    );
  }
}

function saveConfig() {
  const temporary = configFile + ".tmp";

  fs.writeFileSync(
    temporary,
    JSON.stringify(config),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  fs.renameSync(temporary, configFile);
}

function sanitizeItems(list) {
  if (
    !Array.isArray(list) ||
    list.length > 10000
  ) {
    throw new Error("无效清单");
  }

  return list.map(item => ({
    bvid: String(item.bvid || "").slice(0, 24),
    title: String(
      item.title || "未命名"
    ).slice(0, 500),
    uploader: String(
      item.uploader || ""
    ).slice(0, 100),
    duration: Math.max(
      0,
      Number(item.duration) || 0
    ),
    valid:
      !!item.valid &&
      /^BV[0-9A-Za-z]+$/.test(item.bvid),
    selected: !!item.selected,
    seconds:
      item.seconds === "" ||
      item.seconds == null
        ? ""
        : String(item.seconds).slice(0, 16)
  }));
}

function sanitizeSettings(settings) {
  return {
    seconds: String(
      Core.number(
        settings.seconds,
        "默认秒数",
        0,
        86400
      )
    ),
    gap: String(
      Core.number(
        settings.gap,
        "间隔秒数",
        0,
        86400
      )
    ),
    total: String(
      settings.unlimited === true
        ? 120
        : Core.number(
            settings.total,
            "总时长（分钟）",
            0.1,
            10080
          )
    ),
    unlimited: settings.unlimited === true,
    mode:
      settings.mode === "loop"
        ? "loop"
        : "once",
    muted: !!settings.muted
  };
}

async function api(
  apiPath,
  params = {},
  signal
) {
  const url = new URL(
    apiPath,
    "https://api.bilibili.com"
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const abortController = new AbortController();
  const forwardAbort = () => abortController.abort();

  if (signal?.aborted) {
    throw new Error("已取消加载");
  }

  signal?.addEventListener(
    "abort",
    forwardAbort,
    { once: true }
  );

  const timeout = setTimeout(
    () => abortController.abort(),
    20000
  );

  try {
    const response = await biliSession.fetch(
      url.href,
      {
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: abortController.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `B 站接口 HTTP ${response.status}；` +
        "请在软件内 B 站窗口检查登录或验证状态"
      );
    }

    const result = await response.json();

    if (result.code !== 0) {
      throw new Error(
        `B 站接口 ${result.code}：` +
        `${result.message || "请求失败"}。` +
        "请到软件内官网完成登录/验证，不会绕过风控。"
      );
    }

    return result.data;
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(
        signal?.aborted
          ? "已取消加载"
          : "请求超时，请稍后重试"
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);

    signal?.removeEventListener(
      "abort",
      forwardAbort
    );
  }
}

async function getAccount(signal) {
  const me = await api(
    "/x/web-interface/nav",
    {},
    signal
  );

  if (!me?.isLogin || !me.mid) {
    throw new Error(
      "请先在软件的 B 站窗口登录" +
      "（不会共享外部浏览器账号）"
    );
  }

  account = {
    mid: me.mid,
    name: String(me.uname || me.mid)
  };

  return account;
}

async function folders() {
  const me = await getAccount();

  const data = await api(
    "/x/v3/fav/folder/created/list-all",
    { up_mid: me.mid }
  );

  return {
    account: me,
    folders: (data?.list || []).map(folder => ({
      id: String(folder.id),
      title: String(folder.title),
      count: Number(folder.media_count) || 0
    }))
  };
}

async function load(value) {
  if (engine.run || loadController) {
    throw new Error(
      "任务运行或清单加载中，请先停止或取消"
    );
  }

  const id = Core.folderId(value);
  const abortController = new AbortController();
  loadController = abortController;

  try {
    const me = await getAccount(
      abortController.signal
    );

    const all = [];

    const previous = new Map(
      config.items.map(item => [item.bvid, item])
    );

    let more = true;
    let page = 1;

    while (more) {
      notice(
        `正在读取第 ${page} 页，` +
        `已加载 ${all.length} 条…`
      );

      const data = await api(
        "/x/v3/fav/resource/list",
        {
          media_id: id,
          pn: page,
          ps: 20,
          order: "mtime",
          type: 0,
          tid: 0,
          platform: "web"
        },
        abortController.signal
      );

      if (
        page === 1 &&
        data?.info?.upper?.mid &&
        String(data.info.upper.mid) !== String(me.mid)
      ) {
        throw new Error(
          "请使用当前账号自己创建的收藏夹"
        );
      }

      const batch = Array.isArray(data?.medias)
        ? data.medias
        : [];

      for (const media of batch) {
        const old = previous.get(media.bvid);

        const valid =
          media.type === 2 &&
          /^BV[0-9A-Za-z]+$/.test(media.bvid || "") &&
          media.title !== "已失效视频" &&
          Number(media.attr) !== 9;

        all.push({
          bvid: String(media.bvid || ""),
          title: String(media.title || "未命名"),
          uploader: String(media.upper?.name || ""),
          duration: Number(media.duration) || 0,
          valid,
          selected:
            valid && (old ? old.selected : true),
          seconds: old?.seconds ?? ""
        });
      }

      more = !!data?.has_more && batch.length > 0;

      if (page >= 500) {
        if (more) {
          notice("收藏夹过大，仅加载前 10000 条。");
        }

        break;
      }

      page++;

      if (more) {
        await new Promise(resolve => {
          setTimeout(resolve, 350);
        });
      }

      if (abortController.signal.aborted) {
        throw new Error("已取消加载");
      }
    }

    if (abortController.signal.aborted) {
      throw new Error("已取消加载");
    }

    config.items = sanitizeItems(all);
    config.lastFolder = id;
    saveConfig();

    return {
      items: config.items,
      account: me
    };
  } finally {
    if (loadController === abortController) {
      loadController = null;
    }
  }
}

function createPlayer() {
  if (player && !player.isDestroyed()) {
    return player;
  }

  player = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "B 站 · Bili Lemon",
    backgroundColor: "#fff1a6",
    webPreferences: {
      session: biliSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      backgroundThrottling: false,
      autoplayPolicy: "user-gesture-required"
    }
  });

  const window = player;
  window.setMenuBarVisibility(false);

  const restrictNavigation = (event, url) => {
    if (!allowedURL(url)) {
      event.preventDefault();
    }
  };

  window.webContents.on(
    "will-navigate",
    restrictNavigation
  );

  window.webContents.on(
    "will-redirect",
    restrictNavigation
  );

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedURL(url) && !engine.run) {
      window.loadURL(url).catch(error => {
        notice(error.message, true);
      });
    } else {
      notice(
        "已阻止新窗口。播放中如需登录，请先停止；" +
        "非 B 站地址不会自动打开。"
      );
    }

    return { action: "deny" };
  });

  window.webContents.on(
    "will-attach-webview",
    event => event.preventDefault()
  );

  window.webContents.on(
    "did-finish-load",
    () => {
      cssKey = null;
      applyTheme().catch(() => {});
    }
  );

  window.webContents.on(
    "render-process-gone",
    () => {
      engine.stop(
        "播放窗口进程已退出"
      ).catch(() => {});
    }
  );

  window.webContents.on(
    "unresponsive",
    () => {
      notice(
        "播放窗口暂无响应，请等待或停止任务。",
        true
      );
    }
  );

  window.on("closed", () => {
    if (player === window) {
      player = null;
      cssKey = null;

      engine.stop(
        "播放窗口已关闭"
      ).catch(() => {});
    }
  });

  return window;
}

async function applyTheme() {
  if (
    !player ||
    player.isDestroyed() ||
    !allowedURL(player.webContents.getURL())
  ) {
    return;
  }

  const contents = player.webContents;

  if (cssKey) {
    try {
      await contents.removeInsertedCSS(cssKey);
    } catch (_) {}

    cssKey = null;
  }

  if (config.yellowTheme) {
    cssKey = await contents.insertCSS(
      yellow +
      "\nhtml,body{background-color:#fff1a6!important}"
    );
  }

  const themeValue = JSON.stringify(
    config.yellowTheme ? "on" : "off"
  );

  await contents.executeJavaScriptInIsolatedWorld(
    1001,
    [{
      code:
        "if(document.documentElement)" +
        "document.documentElement.dataset.biliLemon=" +
        themeValue +
        ";"
    }]
  );
}

async function navigate(bvid) {
  const window = createPlayer();

  // 不等待网络加载，避免总时长计时被页面加载阻塞。
  window.loadURL(
    `https://www.bilibili.com/video/${bvid}/?p=1`
  ).catch(error => {
    notice(
      "视频页面加载失败：" + error.message,
      true
    );
  });

  window.show();

  if (
    engine.run?.index === 0 &&
    engine.run.round === 1
  ) {
    window.focus();
  }
}

async function command(message) {
  if (
    !player ||
    player.isDestroyed() ||
    !allowedURL(player.webContents.getURL())
  ) {
    throw new Error("播放窗口尚未就绪");
  }

  const contents = player.webContents;

  if (
    !/^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]+/.test(
      contents.getURL()
    )
  ) {
    throw new Error("当前页面不是普通视频页");
  }

  const code =
    agent +
    "\n;globalThis.__lemon.command(" +
    JSON.stringify(message) +
    ");";

  let timeout;

  try {
    return await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(
        1001,
        [{ code }]
      ),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("播放器响应超时"));
        }, 3000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function createController() {
  controller = new BrowserWindow({
    width: 1280,
    height: 940,
    minWidth: 900,
    minHeight: 650,
    title: "Bili Lemon · 收藏夹定时播放器",
    backgroundColor: "#fff1a6",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false
    }
  });

  const window = controller;
  window.setMenuBarVisibility(false);

  window.webContents.on(
    "will-navigate",
    event => event.preventDefault()
  );

  window.webContents.setWindowOpenHandler(() => ({
    action: "deny"
  }));

  window.webContents.on(
    "will-attach-webview",
    event => event.preventDefault()
  );

  window.webContents.on(
    "did-start-loading",
    () => {
      if (engine?.run) {
        engine.stop(
          "控制台重新加载，已停止"
        ).catch(() => {});
      }
    }
  );

  window.webContents.on(
    "render-process-gone",
    () => {
      engine.stop(
        "控制台进程已退出"
      ).catch(() => {});
    }
  );

  window.on("closed", () => {
    controller = null;
    loadController?.abort();

    engine.stop(
      "控制台已关闭"
    ).catch(() => {});

    if (player && !player.isDestroyed()) {
      player.destroy();
    }

    app.quit();
  });

  window.loadURL(controlURL).catch(error => {
    notice(error.message, true);
  });
}

async function route(method, value) {
  switch (method) {
    case "init":
      return {
        config,
        account,
        state: engine.snapshot()
      };

    case "login": {
      if (engine.run) {
        throw new Error(
          "请先停止播放，再打开登录页面"
        );
      }

      const window = createPlayer();

      await window.loadURL(
        "https://www.bilibili.com/"
      );

      window.show();
      window.focus();

      return true;
    }

    case "logout": {
      loadController?.abort();
      await engine.stop("已退出账号");

      if (player && !player.isDestroyed()) {
        player.destroy();
      }

      player = null;

      await biliSession.clearStorageData();
      await biliSession.clearCache();
      await biliSession.clearAuthCache();

      account = null;
      config.items = [];
      config.lastFolder = "";

      saveConfig();
      return true;
    }

    case "folders":
      return folders();

    case "load":
      return load(value);

    case "cancelLoad":
      loadController?.abort();
      return true;

    case "save": {
      if (engine.run || loadController) {
        throw new Error(
          "运行时不能修改设置"
        );
      }

      config.settings = sanitizeSettings(
        value.settings
      );

      config.items = sanitizeItems(value.items);
      saveConfig();

      return true;
    }

    case "theme":
      config.yellowTheme = !!value;
      saveConfig();
      await applyTheme();
      return true;

    case "start": {
      if (loadController) {
        throw new Error(
          "请先等待清单加载结束"
        );
      }

      const settings = sanitizeSettings(
        value.settings
      );

      const items = sanitizeItems(value.items);

      config.settings = settings;
      config.items = items;
      saveConfig();

      await engine.start(
        items.filter(item => item.valid && item.selected),
        settings
      );

      return engine.snapshot();
    }

    case "pause":
      await engine.pause();
      return engine.snapshot();

    case "next":
      await engine.next();
      return engine.snapshot();

    case "stop":
      await engine.stop();
      return engine.snapshot();

    case "focus":
      if (player && !player.isDestroyed()) {
        player.show();
        player.focus();
        return true;
      }

      throw new Error("尚未打开播放窗口");

    default:
      throw new Error("不支持的操作");
  }
}

const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (controller) {
      controller.restore();
      controller.show();
      controller.focus();
    }
  });

  app.whenReady().then(() => {
    configFile = path.join(
      app.getPath("userData"),
      "settings.json"
    );

    try {
      const loaded = JSON.parse(
        fs.readFileSync(configFile, "utf8")
      );

      config = {
        settings: sanitizeSettings(loaded.settings),
        items: sanitizeItems(loaded.items),
        yellowTheme: loaded.yellowTheme !== false,
        lastFolder: String(loaded.lastFolder || "")
      };
    } catch (_) {}

    biliSession = session.fromPartition(
      "persist:bili-lemon"
    );

    biliSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => {
        callback(false);
      }
    );

    biliSession.setPermissionCheckHandler(
      () => false
    );

    biliSession.on("will-download", event => {
      event.preventDefault();

      notice(
        "此工具不提供视频或文件下载。"
      );
    });

    engine = new Engine({
      navigate,
      command,
      emit,
      notice
    });

    ipcMain.handle(
      "desktop:call",
      async (event, payload) => {
        try {
          if (
            !controller ||
            event.sender !== controller.webContents ||
            event.senderFrame !==
              controller.webContents.mainFrame ||
            event.senderFrame.url !== controlURL
          ) {
            throw new Error("拒绝未授权调用");
          }

          if (
            !payload ||
            typeof payload.method !== "string"
          ) {
            throw new Error("无效参数");
          }

          const data = await route(
            payload.method,
            payload.value
          );

          return { ok: true, data };
        } catch (error) {
          return {
            ok: false,
            error: String(
              error.message || error
            ).slice(0, 1000)
          };
        }
      }
    );

    const menu = [
      ...(process.platform === "darwin"
        ? [{
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "quit" }
            ]
          }]
        : []),
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
        ]
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize" },
          { role: "close" }
        ]
      }
    ];

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(menu)
    );

    createController();

    timer = setInterval(() => {
      engine.tick();
    }, 500);

    powerMonitor.on("suspend", () => {
      engine.stop(
        "电脑进入睡眠，任务已停止"
      ).catch(() => {});
    });

    powerMonitor.on("lock-screen", () => {
      engine.stop(
        "系统锁屏，任务已停止"
      ).catch(() => {});
    });
  }).catch(error => {
    console.error(error.message);
    app.quit();
  });
}

app.on("before-quit", () => {
  clearInterval(timer);
  loadController?.abort();

  if (player && !player.isDestroyed()) {
    player.destroy();
  }
});

app.on("window-all-closed", () => app.quit());
