import { getChatMetadata, getContext } from '../foundation/context.js';
import {
    getActiveCharacterInfo,
    getCharacterLorebookName,
    getChatLorebookName,
    getWorldInfoApi,
} from '../foundation/host-lore.js';
import { info, warn } from '../foundation/logger.js';
import { normalizeKeys } from './lorebook-queue.js';

/**
 * Lorebook writer: the one module that reads and writes SillyTavern World
 * Info for Lorebook Ingestion. Everything goes through the host facade's
 * loadWorldInfo/saveWorldInfo, never through relative imports of
 * world-info.js, so a host refactor needs one update here.
 */

/** Marker placed in entry comments so ingested entries are recognizable. */
export const LORE_COMMENT_PREFIX = '[SC]';

/** SillyTavern's newWorldInfoEntryTemplate (latest release), inlined. */
const ENTRY_TEMPLATE = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
});

/**
 * @typedef {object} LoreTarget
 * @property {string} name - Lorebook file name ('' when unresolved)
 * @property {boolean} exists
 * @property {boolean} canCreate
 * @property {string} reason - Why the target is what it is, for the UI
 */

/**
 * Resolve which lorebook ingestion writes to.
 * @param {Record<string, any>} settings
 * @returns {LoreTarget}
 */
export function resolveLoreTarget(settings) {
    const api = getWorldInfoApi();
    const names = new Set(api.names());
    const mode = String(settings.lorebookTargetMode || 'chat');
    const autoCreate = settings.lorebookAutoCreate !== false;

    if (mode === 'character') {
        const name = getCharacterLorebookName();
        if (name) {
            return {
                name,
                exists: names.has(name),
                canCreate: false,
                reason: 'Character primary lorebook',
            };
        }
        return {
            name: '',
            exists: false,
            canCreate: false,
            reason: 'The active card has no primary lorebook linked.',
        };
    }

    if (mode === 'named') {
        const name = String(settings.lorebookTargetName || '').trim();
        if (!name) {
            return { name: '', exists: false, canCreate: false, reason: 'No lorebook name set.' };
        }
        return { name, exists: names.has(name), canCreate: autoCreate, reason: 'Named lorebook' };
    }

    const bound = getChatLorebookName();
    if (bound) {
        return {
            name: bound,
            exists: names.has(bound),
            canCreate: autoCreate,
            reason: 'Chat lorebook',
        };
    }
    return {
        name: defaultChatBookName(settings),
        exists: false,
        canCreate: autoCreate,
        reason: 'New chat lorebook (bound to this chat)',
    };
}

/**
 * @param {Record<string, any>} settings
 * @returns {string}
 */
function defaultChatBookName(settings) {
    const custom = String(settings.lorebookTargetName || '').trim();
    if (custom) {
        return custom;
    }
    const active = getActiveCharacterInfo();
    const owner = active.groupName || active.character?.name || active.name2 || 'Chat';
    const chatId = String(getContext().getCurrentChatId?.() || '').slice(-12);
    return sanitizeBookName(`Summaryception - ${owner}${chatId ? ` - ${chatId}` : ''}`);
}

/**
 * @param {string} name
 * @returns {string}
 */
function sanitizeBookName(name) {
    return name
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

/**
 * Load the target book, creating (and binding, for chat mode) when allowed.
 * @param {Record<string, any>} settings
 * @param {{ create?: boolean }} [options]
 * @returns {Promise<{ name: string, data: { entries: Record<string, any> } } | null>}
 */
export async function loadLoreTarget(settings, { create = false } = {}) {
    const api = getWorldInfoApi();
    const target = resolveLoreTarget(settings);
    if (!target.name) {
        return null;
    }
    if (target.exists) {
        const data = await api.load(target.name);
        if (data && typeof data === 'object') {
            if (!data.entries || typeof data.entries !== 'object') {
                data.entries = {};
            }
            return { name: target.name, data };
        }
    }
    if (!create || !target.canCreate) {
        return null;
    }
    const data = { entries: {} };
    await api.save(target.name, data, true);
    await api.refreshList();
    if (String(settings.lorebookTargetMode || 'chat') === 'chat' && !getChatLorebookName()) {
        /** @type {Record<string, unknown>} */ (
            /** @type {unknown} */ (getChatMetadata())
        ).world_info = target.name;
        await getContext().saveMetadata?.();
    }
    info(`Lorebook: created "${target.name}".`);
    return { name: target.name, data };
}

/**
 * Compact index of the book for the Lore Scout: one line per entry.
 * @param {{ entries: Record<string, any> } | null} book
 * @param {number} [limit]
 * @returns {string}
 */
export function buildLoreIndex(book, limit = 200) {
    if (!book) {
        return '(none yet)';
    }
    const lines = [];
    for (const entry of Object.values(book.entries || {})) {
        if (!entry || entry.disable) {
            continue;
        }
        const name = entryDisplayName(entry);
        if (!name) {
            continue;
        }
        const type = readEntryType(entry);
        const preview = String(entry.content || '')
            .replace(/\s+/g, ' ')
            .slice(0, 90);
        lines.push(`- ${type ? `${type}: ` : ''}${name}${preview ? ` — ${preview}` : ''}`);
        if (lines.length >= limit) {
            break;
        }
    }
    return lines.length ? lines.join('\n') : '(none yet)';
}

/**
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function entryDisplayName(entry) {
    const comment = String(entry.comment || '')
        .replace(LORE_COMMENT_PREFIX, '')
        .trim()
        .replace(/^(char|loc|faction|item|lore):\s*/i, '')
        .trim();
    return comment || (Array.isArray(entry.key) && entry.key[0] ? String(entry.key[0]) : '');
}

/**
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function readEntryType(entry) {
    const match = String(entry.comment || '').match(/\b(char|loc|faction|item|lore):/i);
    return match ? match[1].toLowerCase() : '';
}

/**
 * Find the entry an entity already owns: comment name or any key, case-folded.
 * @param {{ entries: Record<string, any> } | null} book
 * @param {string} name
 * @returns {{ uid: number, entry: Record<string, any> } | null}
 */
export function findEntryByName(book, name) {
    const needle = String(name || '')
        .trim()
        .toLowerCase();
    if (!book || !needle) {
        return null;
    }
    for (const [uid, entry] of Object.entries(book.entries || {})) {
        if (!entry) {
            continue;
        }
        const keys = Array.isArray(entry.key)
            ? entry.key.map((key) => String(key).trim().toLowerCase())
            : [];
        if (entryDisplayName(entry).toLowerCase() === needle || keys.includes(needle)) {
            return { uid: Number(entry.uid ?? uid), entry };
        }
    }
    return null;
}

/**
 * @param {{ entries: Record<string, any> }} book
 * @returns {number}
 */
function nextFreeUid(book) {
    let max = -1;
    for (const [uid, entry] of Object.entries(book.entries || {})) {
        max = Math.max(max, Number(entry?.uid ?? uid) || 0);
    }
    return max + 1;
}

/**
 * @param {Record<string, any>} settings
 * @param {string} entityType
 * @param {string} name
 * @param {string[]} keys
 * @param {string} content
 * @param {number} uid
 * @returns {Record<string, any>}
 */
function buildNewEntry(settings, entityType, name, keys, content, uid) {
    const position = Number(settings.lorebookEntryPosition);
    return {
        ...structuredClone(ENTRY_TEMPLATE),
        uid,
        displayIndex: uid,
        key: normalizeKeys(keys.length ? keys : [name]),
        comment: `${LORE_COMMENT_PREFIX} ${entityType}: ${name}`,
        content,
        constant: Boolean(settings.lorebookEntryConstant),
        vectorized: Boolean(settings.lorebookEntryVectorized),
        selective: settings.lorebookEntrySelective !== false,
        order: Number.isFinite(Number(settings.lorebookEntryOrder))
            ? Number(settings.lorebookEntryOrder)
            : 100,
        depth: Number.isFinite(Number(settings.lorebookEntryDepth))
            ? Number(settings.lorebookEntryDepth)
            : 4,
        position: Number.isFinite(position) ? position : 0,
    };
}

/**
 * @typedef {object} LoreWriteResult
 * @property {boolean} ok
 * @property {number | null} uid
 * @property {string} book
 * @property {string | null} contentBefore
 * @property {'created' | 'updated'} [action]
 * @property {string} [error]
 * @property {boolean} [conflict] - The entry changed after the proposal was drafted
 */

/**
 * Write one approved proposal into the target lorebook. A create whose
 * entity appeared since drafting becomes an update; an update whose entry
 * vanished becomes a create, so approval never fails on a stale snapshot.
 * @param {Record<string, any>} settings
 * @param {import('./lorebook-queue.js').LoreProposal} proposal
 * @returns {Promise<LoreWriteResult>}
 */
export async function writeProposal(settings, proposal) {
    const api = getWorldInfoApi();
    const book = await loadLoreTarget(settings, { create: true });
    if (!book) {
        const target = resolveLoreTarget(settings);
        return {
            ok: false,
            uid: null,
            book: target.name,
            contentBefore: null,
            error: target.reason || 'No target lorebook.',
        };
    }

    const content = String(proposal.proposedContent || '').trim();
    if (!content) {
        return {
            ok: false,
            uid: null,
            book: book.name,
            contentBefore: null,
            error: 'Proposal content is empty.',
        };
    }

    const existing =
        (proposal.existingUid !== null &&
        proposal.existingUid !== undefined &&
        book.data.entries[proposal.existingUid]
            ? { uid: Number(proposal.existingUid), entry: book.data.entries[proposal.existingUid] }
            : null) || findEntryByName(book.data, proposal.name);

    let result;
    if (existing) {
        const contentBefore = String(existing.entry.content || '');
        const conflict =
            proposal.kind === 'update' &&
            proposal.existingContentSnapshot !== null &&
            proposal.existingContentSnapshot !== undefined &&
            proposal.existingContentSnapshot !== contentBefore;
        existing.entry.content = content;
        existing.entry.key = normalizeKeys([
            ...(existing.entry.key || []),
            ...(proposal.keys || []),
        ]);
        result = {
            ok: true,
            uid: existing.uid,
            book: book.name,
            contentBefore,
            action: 'updated',
            conflict,
        };
    } else {
        const uid = nextFreeUid(book.data);
        book.data.entries[uid] = buildNewEntry(
            settings,
            proposal.entityType,
            proposal.name,
            proposal.keys || [],
            content,
            uid,
        );
        result = { ok: true, uid, book: book.name, contentBefore: null, action: 'created' };
    }

    try {
        await api.save(book.name, book.data, true);
        api.reloadEditor(book.name);
    } catch (error) {
        warn('Lorebook: save failed.', error);
        return {
            ok: false,
            uid: null,
            book: book.name,
            contentBefore: null,
            error: String(error?.message || error),
        };
    }
    return /** @type {LoreWriteResult} */ (result);
}

/**
 * Undo an approval: restore the replaced content, or delete the created
 * entry. Refuses when the user edited the entry afterwards.
 * @param {Record<string, any>} settings
 * @param {import('./lorebook-queue.js').LoreProposal} proposal
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function revertProposal(settings, proposal) {
    if (
        proposal.status !== 'approved' ||
        proposal.committedUid === null ||
        proposal.committedUid === undefined
    ) {
        return { ok: false, error: 'Only approved proposals can be reverted.' };
    }
    const api = getWorldInfoApi();
    const bookName = proposal.targetLorebook;
    const data = bookName ? await api.load(bookName) : null;
    const entry = data?.entries?.[proposal.committedUid];
    if (!entry) {
        return { ok: false, error: 'The entry no longer exists.' };
    }
    if (String(entry.content || '').trim() !== String(proposal.proposedContent || '').trim()) {
        return { ok: false, error: 'The entry was edited after approval; revert it by hand.' };
    }
    if (proposal.contentBeforeCommit === null || proposal.contentBeforeCommit === undefined) {
        delete data.entries[proposal.committedUid];
    } else {
        entry.content = proposal.contentBeforeCommit;
    }
    await api.save(bookName, data, true);
    api.reloadEditor(bookName);
    return { ok: true };
}
