const { EventEmitter } = require("events");

/**
 * In-process hub for version bumps. `cache.bump()` emits `("bump", { dep: newVersion })` after every
 * write; open `/api/events` streams forward the deps their user may see. Only dep names and version
 * numbers travel this way, never data.
 */
const hub = new EventEmitter();
hub.setMaxListeners(0); // one listener per open stream

module.exports = { hub };
