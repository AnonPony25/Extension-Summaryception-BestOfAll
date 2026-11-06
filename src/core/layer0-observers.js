import { warn } from '../foundation/logger.js';

/**
 * Layer 0 commit observers. Downstream features (Lorebook Ingestion) learn
 * about freshly committed Snippets here without the summarization pipeline
 * importing them. Observers run after the commit transaction settles, never
 * inside it, and their failures never reach the pipeline.
 *
 * @typedef {object} Layer0CommitEvent
 * @property {string} passageText
 * @property {string} snippetText
 * @property {string[]} sourceMessageIds
 * @property {[number, number]} sourceRange
 */

/** @type {Set<(events: Layer0CommitEvent[]) => void | Promise<void>>} */
const observers = new Set();

/**
 * @param {(events: Layer0CommitEvent[]) => void | Promise<void>} observer
 * @returns {() => void} Unsubscribe
 */
export function onLayer0Committed(observer) {
    observers.add(observer);
    return () => observers.delete(observer);
}

/**
 * @param {Layer0CommitEvent[]} events
 * @returns {void}
 */
export function notifyLayer0Committed(events) {
    if (!events.length) {
        return;
    }
    for (const observer of observers) {
        queueMicrotask(() => {
            Promise.resolve()
                .then(() => observer(events))
                .catch((error) => warn('Layer 0 commit observer failed.', error));
        });
    }
}
