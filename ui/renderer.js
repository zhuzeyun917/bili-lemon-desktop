"use strict";

const $ = id => document.getElementById(id);
const api = window.desktop;

let items = [];
let state = { active: false };
let loading = false;
let themeOn = true;
let settingsTimer;
let dirty = false;

const settingIds = [
  "seconds",
  "gap",
  "total",
  "mode",
  "muted",
  "unlimited"
];

function tell(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}

function fail(error) {
  tell(error.message || String(error), true);
}

function settings() {
  return Object.fromEntries(
    settingIds.map(id => [
      id,
      $(id).type === "checkbox"
        ? $(id).checked
        : $(id).value
    ])
  );
}

async function save() {
  clearTimeout(settingsTimer);

  await api.save({
    settings: settings(),
    items
  });

  dirty = false;
}

function scheduleSave() {
  dirty = true;
  clearTimeout(settingsTimer);

  settingsTimer = setTimeout(() => {
    save().catch(fail);
  }, 500);
}

function count() {
  const valid = items.filter(item => item.valid);
  const selected = valid.filter(
    item => item.selected
  ).length;

  $("count").textContent =
    `${selected} / ${valid.length} 个已选`;

  $("selectAll").checked =
    valid.length > 0 &&
    selected === valid.length;

  $("selectAll").indeterminate =
    selected > 0 &&
    selected < valid.length;
}

function render() {
  $("items").replaceChildren();

  const fragment = document.createDocumentFragment();

  if (!items.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 3;
    cell.className = "empty";
    cell.textContent =
      "请先在软件内登录 B 站并加载收藏夹。";

    row.append(cell);
    fragment.append(row);
  }

  items.forEach((item, index) => {
    const row = document.createElement("tr");
    const selectCell = document.createElement("td");
    const titleCell = document.createElement("td");
    const secondsCell = document.createElement("td");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.selected;
    checkbox.disabled =
      !item.valid || state.active || loading;

    checkbox.setAttribute(
      "aria-label",
      "选择 " + item.title
    );

    checkbox.addEventListener("change", () => {
      item.selected = checkbox.checked;
      count();
      scheduleSave();
    });

    selectCell.append(checkbox);

    const title = document.createElement("span");
    title.textContent = item.title;

    const details = document.createElement("small");

    const description = item.valid
      ? item.uploader + " · " + Core.format(item.duration)
      : "失效或不支持的条目";

    details.textContent =
      String(index + 1).padStart(2, "0") +
      " · " +
      description;

    titleCell.append(title, details);

    const seconds = document.createElement("input");
    seconds.type = "number";
    seconds.min = "0";
    seconds.max = "86400";
    seconds.step = "1";
    seconds.placeholder = "默认";
    seconds.value = item.seconds;

    seconds.disabled =
      !item.valid || state.active || loading;

    seconds.setAttribute(
      "aria-label",
      item.title + " 的播放秒数"
    );

    seconds.addEventListener("input", () => {
      item.seconds = seconds.value;
      scheduleSave();
    });

    secondsCell.append(seconds);
    row.append(selectCell, titleCell, secondsCell);
    fragment.append(row);
  });

  $("items").append(fragment);

  count();
  controls();
}

function controls() {
  const busy = !!state.active || loading;

  const disabledWhenBusy = [
    ...settingIds,
    "refresh",
    "load",
    "manualLoad",
    "manualFolder",
    "folder",
    "selectAll",
    "login",
    "logout",
    "musicPreset"
  ];

  for (const id of disabledWhenBusy) {
    $(id).disabled = busy;
  }

  $("total").disabled =
    busy || $("unlimited").checked;

  $("start").disabled = busy;
  $("pause").disabled = !state.active;
  $("stop").disabled = !state.active;

  $("next").disabled =
    !state.active ||
    state.paused ||
    state.phase === "opening";

  $("pause").textContent =
    state.paused ? "继续" : "暂停";

  document.querySelectorAll(
    "#items input"
  ).forEach(element => {
    const index =
      element.closest("tr").sectionRowIndex;

    element.disabled =
      busy || !items[index]?.valid;
  });

  $("cancelLoad").hidden = !loading;
}

function update(value) {
  const wasActive = state.active;
  state = value;

  controls();

  $("status").textContent =
    state.status || "未开始";

  if (state.active) {
    $("nowTitle").textContent = state.title;

    $("position").textContent =
      `第 ${state.index + 1} / ${state.length} 条` +
      ` · 第 ${state.round} 轮`;

    $("remaining").textContent =
      state.unlimited
        ? "不限时长"
        : Core.format(state.remaining);

    $("played").textContent =
      Core.format(Math.floor(state.played));

    $("gapLeft").textContent =
      state.gapLeft == null
        ? "—"
        : Core.format(state.gapLeft);

    $("progress").hidden = !!state.unlimited;

    $("progress").value = state.unlimited
      ? 0
      : 100 * (1 - state.remaining / state.total);
  } else if (wasActive) {
    tell(state.status || "已停止");
    $("gapLeft").textContent = "—";

    if (state.status === "总时长已到") {
      $("remaining").textContent = "00:00:00";
      $("progress").value = 100;
    }
  }
}

function setTheme() {
  $("theme").textContent =
    "B 站黄色背景：" + (themeOn ? "开" : "关");

  $("theme").setAttribute(
    "aria-pressed",
    String(themeOn)
  );
}

function showConfiguredTime() {
  $("remaining").textContent =
    $("unlimited").checked
      ? "不限时长"
      : Core.format(
          (Number($("total").value) || 0) * 60
        );
}

async function refresh() {
  loading = true;
  controls();

  try {
    if (dirty) await save();

    tell("正在读取账号和收藏夹…");

    const data = await api.folders();

    $("account").textContent = data.account.name;

    $("folder").replaceChildren(
      new Option(
        data.folders.length
          ? "请选择收藏夹"
          : "没有读取到收藏夹，可粘贴链接",
        ""
      )
    );

    for (const folder of data.folders) {
      $("folder").add(
        new Option(
          `${folder.title}（${folder.count}）`,
          folder.id
        )
      );
    }

    if (data.folders.length) {
      $("folder").selectedIndex = 1;
    }

    tell(
      `已登录：${data.account.name}。` +
      `读取到 ${data.folders.length} 个收藏夹。`
    );
  } catch (error) {
    fail(error);
  } finally {
    loading = false;
    controls();
  }
}

async function load(value) {
  loading = true;
  controls();

  try {
    if (dirty) await save();

    const data = await api.load(value);

    items = data.items;
    $("account").textContent = data.account.name;

    render();

    const available = items.filter(
      item => item.valid
    ).length;

    tell(`加载完成：${available} 个可用视频。`);
  } catch (error) {
    fail(error);
  } finally {
    loading = false;
    controls();
  }
}

$("login").addEventListener("click", () => {
  api.login().then(() => {
    tell(
      "请在软件打开的 B 站窗口完成登录，" +
      "再回来读取收藏夹。"
    );
  }).catch(fail);
});

$("logout").addEventListener("click", () => {
  const confirmed = window.confirm(
    "退出软件内 B 站账号，并清除本地收藏清单？"
  );

  if (!confirmed) return;

  clearTimeout(settingsTimer);

  api.logout().then(() => {
    items = [];
    dirty = false;

    $("account").textContent = "已退出账号";

    $("folder").replaceChildren(
      new Option("请先读取收藏夹", "")
    );

    render();

    tell("已清除软件内登录会话和收藏清单。");
  }).catch(fail);
});

$("refresh").addEventListener("click", refresh);

$("load").addEventListener("click", () => {
  load($("folder").value);
});

$("manualLoad").addEventListener("click", () => {
  load($("manualFolder").value);
});

$("cancelLoad").addEventListener("click", () => {
  api.cancelLoad().catch(fail);
});

$("selectAll").addEventListener("change", () => {
  const selected = $("selectAll").checked;

  items.forEach(item => {
    if (item.valid) {
      item.selected = selected;
    }
  });

  render();
  scheduleSave();
});

settingIds.forEach(id => {
  $(id).addEventListener("change", () => {
    scheduleSave();
    controls();

    if (!state.active) {
      showConfiguredTime();
    }
  });
});

$("theme").addEventListener("click", async () => {
  const nextTheme = !themeOn;

  try {
    await api.theme(nextTheme);
    themeOn = nextTheme;
    setTheme();
  } catch (error) {
    fail(error);
  }
});

$("start").addEventListener("click", async () => {
  clearTimeout(settingsTimer);
  loading = true;
  controls();

  try {
    const result = await api.start({
      settings: settings(),
      items
    });

    update(result);
    dirty = false;

    tell(
      "已打开软件内的播放窗口。" +
      "若需要，请在视频画面上手动点击一次播放；" +
      "建议关闭 B 站自身连播。"
    );
  } catch (error) {
    fail(error);
  } finally {
    loading = false;
    controls();
  }
});

const transportButtons = [
  ["pause", "pause"],
  ["next", "next"],
  ["stop", "stop"]
];

for (const [id, method] of transportButtons) {
  $(id).addEventListener("click", () => {
    api[method]().then(update).catch(fail);
  });
}

$("focusPlayer").addEventListener("click", () => {
  api.focus().catch(fail);
});

$("musicPreset").addEventListener("click", () => {
  $("seconds").value = "0";
  $("gap").value = "0";
  $("mode").value = "loop";
  $("unlimited").checked = true;
  $("muted").checked = false;

  items.forEach(item => {
    item.seconds = "";
  });

  showConfiguredTime();
  render();
  scheduleSave();

  tell(
    "已设为听歌模式：每首播完、零间隔、" +
    "列表循环、不限总时长、有声播放。" +
    "已清除逐条时长覆盖；" +
    "如受自动播放限制，请在视频窗口点一次播放。"
  );
});

api.onState(update);

api.onNotice(message => {
  tell(message.text, message.error);
});

api.init().then(data => {
  items = data.config.items;

  for (const id of settingIds) {
    if ($(id).type === "checkbox") {
      $(id).checked = !!data.config.settings[id];
    } else {
      $(id).value = data.config.settings[id];
    }
  }

  themeOn = data.config.yellowTheme;

  setTheme();
  render();
  update(data.state);

  if (!data.state.active) {
    showConfiguredTime();
  }

  if (data.account) {
    $("account").textContent = data.account.name;
  }
}).catch(fail);
