// Application bytes, excluding TLS/kernel buffers and object overhead.
export const SOCKET_LIMITS = Object.freeze({ outputPerSocket: 12 * 1024 ** 2, outputTotal: 32 * 1024 ** 2,
  inputPerSocket: 2 * 1024 ** 2, inputTotal: 8 * 1024 ** 2, inputFrames: 32, outputFrames: 256,
  inputFramesTotal: 2048, outputFramesTotal: 4096 });
/** @param {Partial<typeof SOCKET_LIMITS>} [overrides] */
export function createSocketBudget(overrides = {}) {
  const limits = { ...SOCKET_LIMITS, ...overrides };
  /** @type {WeakMap<import('ws').WebSocket, {input: number, output: number, inputFrames: number, outputFrames: number}>} */
  const states = new WeakMap();
  /** @type {WeakMap<import('ws').WebSocket, Set<() => void>>} */
  const pending = new WeakMap();
  let output = 0, input = 0;
  let inputFrames = 0, outputFrames = 0;
  /** @param {import('ws').WebSocket} socket */
  const state = socket => {
    if (!states.has(socket)) states.set(socket, { output: 0, input: 0, inputFrames: 0, outputFrames: 0 });
    return /** @type {{input: number, output: number, inputFrames: number, outputFrames: number}} */ (states.get(socket));
  };
  /** @param {import('ws').WebSocket} socket */
  function pendingFor(socket) {
    const existing = pending.get(socket);
    if (existing) return existing;
    /** @type {Set<() => void>} */
    const created = new Set(); pending.set(socket, created);
    socket.once('close', () => { for (const release of created) release(); created.clear(); });
    return created;
  }
  /** @param {import('ws').WebSocket} socket @param {number} bytes @param {'input'|'output'} direction */
  function reserve(socket, bytes, direction) {
    const entry = state(socket);
    const total = direction === 'output' ? output : input;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || socket.readyState !== 1
      || entry[direction] + bytes > limits[`${direction}PerSocket`]
      || total + bytes > limits[`${direction}Total`]
      || (direction === 'input' && (entry.inputFrames >= limits.inputFrames || inputFrames >= limits.inputFramesTotal))
      || (direction === 'output' && (entry.outputFrames >= limits.outputFrames || outputFrames >= limits.outputFramesTotal))
      || (direction === 'output' && socket.bufferedAmount + bytes > limits.outputPerSocket)) return null;
    entry[direction] += bytes;
    if (direction === 'input') { input += bytes; inputFrames++; entry.inputFrames++; }
    else { output += bytes; outputFrames++; entry.outputFrames++; }
    let released = false;
    return () => {
      if (released) return;
      released = true; entry[direction] -= bytes;
      if (direction === 'input') { input -= bytes; inputFrames--; entry.inputFrames--; }
      else { output -= bytes; outputFrames--; entry.outputFrames--; }
    };
  }
  return {
    snapshot: () => ({ input, output }),
    /** @param {import('ws').WebSocket} socket @param {number} bytes */
    reserveInput: (socket, bytes) => reserve(socket, bytes, 'input'),
    /** @param {import('ws').WebSocket} socket @param {unknown} value */
    send(socket, value) {
      if (socket.readyState !== 1) return false;
      const serialized = JSON.stringify(value);
      const release = reserve(socket, Buffer.byteLength(serialized), 'output');
      if (!release) { socket.close(4413, 'Transport capacity exceeded'); return false; }
      // close may precede the ws callback; release exactly once on either path.
      // A single close listener per socket avoids one listener per small frame.
      const cleanup = pendingFor(socket);
      cleanup.add(release);
      const done = () => { cleanup.delete(release); release(); };
      try { socket.send(serialized, error => { done(); if (error && socket.readyState === 1) socket.close(4413, 'Transport write failed'); }); }
      catch { done(); socket.close(4413, 'Transport write failed'); return false; }
      return true;
    },
  };
}
