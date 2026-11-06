import { MODULE_NAME } from '../foundation/constants.js';
import { getChatMetadata } from '../foundation/context.js';
import { isPlainObject } from '../foundation/objects.js';

/**
 * Lore Review Queue: per-chat proposals produced by Lorebook Ingestion,
 * stored beside (never inside) the Chat Store so bank swaps, snippet commits,
 * and the Mutation Epoch never see them.
 */

export const LORE_STATE_KEY = `${MODULE_NAME}_lorebook`;
const RESOLVED_HISTORY_LIMIT = 150;

/**
 * @typedef {object} LoreProposal
 * @property {string} id
 * @property {'create' | 'update'} kind
 * @property {string} entityType - char | loc | faction | item | lore
 * @property {string} name
 * @property {string} detail - Gloss (create) or change reason (update)
 * @property {string[]} keys - Trigger keys the entry will carry
 * @property {string} targetLorebook
 * @property {string[]} sourceMessageIds
 * @property {[number, number] | null} sourceRange
 * @property {string} sourceSnippetText
 * @property {string} proposedContent
 * @property {number | null} existingUid
 * @property {string | null} existingContentSnapshot - Entry content when the proposal was drafted
 * @property {'pending' | 'approved' | 'rejected' | 'reverted' | 'failed'} status
 * @property {string} dedupKey
 * @property {number} createdAt
 * @property {number} [resolvedAt]
 * @property {number | null} [committedUid] - Entry uid the approval wrote
 * @property {string | null} [contentBeforeCommit] - Entry content the approval replaced (update)
 * @property {string} [error]
 */

/**
 * @returns {{ queue: LoreProposal[], scans: number, lastScanAt: number }}
 */
export function getLoreState() {
    const metadata = getChatMetadata();
    if (!isPlainObject(metadata[LORE_STATE_KEY])) {
        metadata[LORE_STATE_KEY] = /** @type {any} */ ({ queue: [], scans: 0, lastScanAt: 0 });
    }
    const state = /** @type {any} */ (metadata[LORE_STATE_KEY]);
    if (!Array.isArray(state.queue)) {
        state.queue = [];
    }
    state.queue = state.queue.filter((item) => isPlainObject(item) && typeof item.id === 'string');
    state.scans = Number(state.scans) || 0;
    state.lastScanAt = Number(state.lastScanAt) || 0;
    return state;
}

/**
 * @param {string} kind
 * @param {string} entityType
 * @param {string} name
 * @returns {string}
 */
export function buildDedupKey(kind, entityType, name) {
    return `${kind}|${entityType}|${String(name).trim().toLowerCase()}`;
}

/**
 * @returns {string}
 */
function makeProposalId() {
    return `lb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {Omit<LoreProposal, 'id' | 'status' | 'createdAt'>} draft
 * @returns {LoreProposal}
 */
export function addProposal(draft) {
    const state = getLoreState();
    /** @type {LoreProposal} */
    const proposal = { ...draft, id: makeProposalId(), status: 'pending', createdAt: Date.now() };
    state.queue.push(proposal);
    pruneResolved(state);
    return proposal;
}

/**
 * @param {string} dedupKey
 * @returns {boolean}
 */
export function hasPendingProposal(dedupKey) {
    return getLoreState().queue.some(
        (item) => item.status === 'pending' && item.dedupKey === dedupKey,
    );
}

/**
 * @param {string} id
 * @returns {LoreProposal | undefined}
 */
export function findProposal(id) {
    return getLoreState().queue.find((item) => item.id === id);
}

/**
 * @param {'pending' | 'resolved' | 'all'} [filter]
 * @returns {LoreProposal[]}
 */
export function listProposals(filter = 'all') {
    const queue = getLoreState().queue;
    if (filter === 'pending') {
        return queue.filter((item) => item.status === 'pending');
    }
    if (filter === 'resolved') {
        return queue.filter((item) => item.status !== 'pending');
    }
    return [...queue];
}

/**
 * @returns {number}
 */
export function countPendingProposals() {
    return listProposals('pending').length;
}

/**
 * @param {string} id
 * @param {{ proposedContent?: string, keys?: string[], name?: string }} patch
 * @returns {LoreProposal | null}
 */
export function editProposal(id, patch) {
    const item = findProposal(id);
    if (!item || item.status !== 'pending') {
        return null;
    }
    if (typeof patch.proposedContent === 'string') {
        item.proposedContent = patch.proposedContent;
    }
    if (Array.isArray(patch.keys)) {
        item.keys = normalizeKeys(patch.keys);
    }
    if (typeof patch.name === 'string' && patch.name.trim()) {
        item.name = patch.name.trim();
    }
    return item;
}

/**
 * @param {string} id
 * @returns {LoreProposal | null}
 */
export function rejectProposal(id) {
    const item = findProposal(id);
    if (!item || item.status !== 'pending') {
        return null;
    }
    item.status = 'rejected';
    item.resolvedAt = Date.now();
    return item;
}

/**
 * Remove every resolved proposal; pending ones stay.
 * @returns {number} Removed count
 */
export function clearResolvedProposals() {
    const state = getLoreState();
    const before = state.queue.length;
    state.queue = state.queue.filter((item) => item.status === 'pending');
    return before - state.queue.length;
}

/**
 * Clear: drop the whole Lore Review Queue. Entries already written to a
 * lorebook stay; a lorebook belongs to the user, not to the chat.
 * @returns {void}
 */
export function clearLoreReviewQueue() {
    const metadata = getChatMetadata();
    if (metadata && Object.hasOwn(metadata, LORE_STATE_KEY)) {
        delete metadata[LORE_STATE_KEY];
    }
}

/**
 * @param {unknown[]} keys
 * @returns {string[]}
 */
export function normalizeKeys(keys) {
    const seen = new Set();
    const result = [];
    for (const raw of keys || []) {
        const key = String(raw ?? '').trim();
        if (!key || seen.has(key.toLowerCase())) {
            continue;
        }
        seen.add(key.toLowerCase());
        result.push(key);
    }
    return result;
}

/**
 * @param {{ queue: LoreProposal[] }} state
 * @returns {void}
 */
function pruneResolved(state) {
    const resolved = state.queue.filter((item) => item.status !== 'pending');
    if (resolved.length <= RESOLVED_HISTORY_LIMIT) {
        return;
    }
    const drop = new Set(
        resolved
            .sort((a, b) => (a.resolvedAt || a.createdAt) - (b.resolvedAt || b.createdAt))
            .slice(0, resolved.length - RESOLVED_HISTORY_LIMIT)
            .map((item) => item.id),
    );
    state.queue = state.queue.filter((item) => !drop.has(item.id));
}
