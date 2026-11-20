// The only bridge between the app's windows and the main process.
// Windows run sandboxed with no Node access; everything they can ask for is
// one of the channels listed here.

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:init',
  'settings:update',
  'ctl:command',
  'rec:chunk',
  'perm:status',
  'perm:request',
  'dialog:pickFolder',
  'library:list',
  'library:action',
  'library:export',
  'recovery:list',
  'recovery:restore',
  'recovery:discard',
  'shortcuts:suspend',
]);

const SEND = new Set([
  'engine:reply',
  'engine:event',
  'bubble:drag',
  'bubble:resize',
  'bubble:menu',
  'overlay:exit',
  'export:cancel',
]);

const ON = new Set([
  'state',
  'settings',
  'engine:cmd',
  'library:changed',
  'export:progress',
  'recovery:changed',
  'overlay:cursor',
  'overlay:mode',
  'ui:enter',
  'ui:leave',
]);

contextBridge.exposeInMainWorld('freeloomz', {
  /** @param {string} channel @param {...any} args */
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error(`Blocked channel: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  /** @param {string} channel @param {...any} args */
  send(channel, ...args) {
    if (!SEND.has(channel)) throw new Error(`Blocked channel: ${channel}`);
    ipcRenderer.send(channel, ...args);
  },
  /**
   * @param {string} channel
   * @param {(...args: any[]) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(channel, listener) {
    if (!ON.has(channel)) throw new Error(`Blocked channel: ${channel}`);
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
