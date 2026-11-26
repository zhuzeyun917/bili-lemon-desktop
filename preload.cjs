"use strict";

const {
  contextBridge,
  ipcRenderer
} = require("electron");

function call(method, value) {
  return ipcRenderer
    .invoke("desktop:call", { method, value })
    .then(result => {
      if (!result.ok) {
        throw new Error(result.error);
      }

      return result.data;
    });
}

contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    init: () => call("init"),

    login: () => call("login"),

    logout: () => call("logout"),

    folders: () => call("folders"),

    load: value => call("load", value),

    cancelLoad: () => call("cancelLoad"),

    save: value => call("save", value),

    theme: value => call("theme", value),

    start: value => call("start", value),

    pause: () => call("pause"),

    next: () => call("next"),

    stop: () => call("stop"),

    focus: () => call("focus"),

    onState: callback => {
      const listener = (_event, value) => {
        callback(value);
      };

      ipcRenderer.on("desktop:state", listener);

      return () => {
        ipcRenderer.removeListener(
          "desktop:state",
          listener
        );
      };
    },

    onNotice: callback => {
      const listener = (_event, value) => {
        callback(value);
      };

      ipcRenderer.on("desktop:notice", listener);

      return () => {
        ipcRenderer.removeListener(
          "desktop:notice",
          listener
        );
      };
    }
  })
);
