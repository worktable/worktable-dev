// This source executes only inside QuickJS. The single native capability takes
// a bounded JSON string. No browser object, host function or promise crosses it.
export const TOOL_GUEST_SDK = String.raw`((send) => {
  'use strict';
  delete globalThis.__worktableSend;
  const encode = JSON.stringify;
  const decode = JSON.parse;
  let sequence = 0;
  const pending = new Map();
  const subscriptions = new Map();
  const actions = new Map();
  let environment = { theme: 'light', viewport: { width: 0, height: 0 } };
  function request(method, args) {
    if (pending.size >= 40) return Promise.reject(new Error('Too many pending requests.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try { send(encode({ type: 'request', id, method, args })); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function subscribe(collection, query, callback, detailed) {
    if (typeof query === 'function') { callback = query; query = {}; }
    if (typeof callback !== 'function') throw new TypeError('A subscription needs a callback.');
    if (subscriptions.size >= 40) throw new Error('Too many subscriptions.');
    const id = ++sequence;
    subscriptions.set(id, value => callback(detailed ? value : value.records));
    try { send(encode({ type: 'subscribe', id, collection, query: query || {} })); }
    catch (error) { subscriptions.delete(id); throw error; }
    return () => {
      if (subscriptions.delete(id)) send(encode({ type: 'unsubscribe', id }));
    };
  }
  const records = {
    query: (collection, query = {}) => request('records.query', [collection, query]).then(value => value.records),
    queryDetailed: (collection, query = {}) => request('records.query', [collection, query]),
    create: (collection, data, options) => request('records.create', [collection, data, options]),
    update: (collection, id, patch) => request('records.update', [collection, id, patch]),
    delete: (collection, id) => request('records.delete', [collection, id]),
    subscribe: (collection, query, callback) => subscribe(collection, query, callback, false),
    subscribeDetailed: (collection, query, callback) => subscribe(collection, query, callback, true),
  };
  const state = {
    get: key => request('state.get', [key]),
    set: (key, value) => request('state.set', [key, value]),
    update: async updater => {
      const current = await state.get();
      const next = await updater(current);
      return request('state.update', [next]);
    },
  };
  const ui = {
    render: view => request('ui.render', [view]),
    on: (action, handler) => {
      if (typeof action !== 'string' || typeof handler !== 'function') throw new TypeError('Invalid action.');
      actions.set(action, handler);
      return () => { if (actions.get(action) === handler) actions.delete(action); };
    },
    getTheme: () => environment.theme,
    getViewport: () => ({ ...environment.viewport }),
    notify: message => request('ui.notify', [String(message)]),
  };
  globalThis.worktable = Object.freeze({
    version: '3.0-isolated', records: Object.freeze(records), state: Object.freeze(state),
    ui: Object.freeze(ui),
    navigation: Object.freeze({ openDocument: path => request('navigation.openDocument', [path]) }),
  });
  return async message => {
    const value = decode(message);
    if (value.type === 'response') {
      const done = pending.get(value.id);
      if (!done) return;
      pending.delete(value.id);
      if (value.ok) done.resolve(value.value);
      else {
        const error = new Error(value.message || 'The request failed.');
        error.code = value.code;
        done.reject(error);
      }
    } else if (value.type === 'event') {
      const handler = actions.get(value.action);
      if (handler) await handler(value.value);
    } else if (value.type === 'subscription') {
      const callback = subscriptions.get(value.id);
      if (callback) await callback(value.value);
    } else if (value.type === 'environment') {
      environment = value.value;
      const handler = actions.get('environment');
      if (handler) await handler({ ...environment, viewport: { ...environment.viewport } });
    }
  };
})(globalThis.__worktableSend)`
