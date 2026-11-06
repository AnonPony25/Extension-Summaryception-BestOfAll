import { MODULE_NAME } from '../foundation/constants.js';
import { getChatMetadata } from '../foundation/context.js';
import { getActiveCharacterInfo } from '../foundation/host-lore.js';
import { getChatStore, isValidSnippet } from '../foundation/chat-store.js';
import { isPlainObject, normalizeStringArray } from '../foundation/objects.js';
import { info } from '../foundation/logger.js';

/**
 * Per-Character Memory Banks (ported from dogoo9's fork, rebuilt on the
 * single chat-store seam).
 *
 * The live store stays at `chatMetadata[MODULE_NAME]`: every reader and
 * writer in the extension keeps calling getChatStore() and never learns banks
 * exist. Banks that are not active are parked in a sibling registry at
 * `chatMetadata[BANK_REGISTRY_KEY]`. A Bank Switch swaps the parked store into
 * the live slot and moves Ghosting ownership along with it, so the next
 * syncGhosting pass unhides what the old bank hid and hides what the new
 * bank covers, through the normal ownership rules.
 *
 * Bank keys:
 * - `chat`                      shared bank (feature off)
 * - `character:stable:<id>`     card exposes a persistent id
 * - `character:file:<avatar>`   card avatar filename (survives restarts)
 * - `character:session:<chid>`  last resort; promoted when a better key appears
 * - `group:<groupId>`           group chats share one bank per group
 */

export const BANK_REGISTRY_KEY = `${MODULE_NAME}_banks`;
export const SHARED_BANK_KEY = 'chat';
const REGISTRY_VERSION = 1;

/**
 * @typedef {object} BankIdentity
 * @property {string} key
 * @property {string} label - Human-readable owner name
 * @property {'shared' | 'character' | 'group'} kind
 * @property {string | null} stableId
 * @property {string | null} avatar
 * @property {string[]} formerKeys - Keys this bank was promoted or migrated from
 * @property {number} createdAt
 * @property {number} lastActiveAt
 * @property {string} [origin] - How the bank first came to exist
 */

/**
 * @typedef {object} BankRegistry
 * @property {number} version
 * @property {string} activeKey - Key of the store currently in the live slot
 * @property {Record<string, SummaryceptionStore>} banks - Parked (inactive) stores
 * @property {Record<string, BankIdentity>} identities - Identity record for every known bank, live one included
 */

/**
 * Resolve which bank the open chat should be using right now.
 * @param {{ memoryBanksEnabled?: boolean }} settings
 * @returns {BankIdentity}
 */
export function resolveActiveBankIdentity(settings) {
    const now = Date.now();
    const base = {
        stableId: null,
        avatar: null,
        formerKeys: [],
        createdAt: now,
        lastActiveAt: now,
    };
    if (!settings?.memoryBanksEnabled) {
        return { ...base, key: SHARED_BANK_KEY, label: 'Shared chat bank', kind: 'shared' };
    }
    const active = getActiveCharacterInfo();
    if (active.groupId) {
        return {
            ...base,
            key: `group:${encodeURIComponent(active.groupId)}`,
            label: active.groupName ? `Group: ${active.groupName}` : 'Group chat',
            kind: 'group',
        };
    }
    const character = active.character || {};
    const stableId = readStableCardId(character);
    const avatar = normalizeCardFilename(character.avatar || character.data?.avatar);
    const label = String(character.name || active.name2 || 'Unknown character');
    let key = 'character:unknown';
    if (stableId) {
        key = `character:stable:${encodeURIComponent(stableId)}`;
    } else if (avatar) {
        key = `character:file:${encodeURIComponent(avatar)}`;
    } else if (active.characterId !== null) {
        key = `character:session:${encodeURIComponent(String(active.characterId))}`;
    }
    return { ...base, key, label, kind: 'character', stableId, avatar };
}

/**
 * Conservative list of fields that identify a card across sessions; the
 * numeric chid is an array index and never qualifies.
 * @param {Record<string, any>} character
 * @returns {string | null}
 */
function readStableCardId(character) {
    const candidate =
        character?.uuid ||
        character?.character_uuid ||
        character?.data?.uuid ||
        character?.data?.character_uuid ||
        character?.data?.extensions?.sillytavern?.id ||
        null;
    return candidate ? String(candidate) : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeCardFilename(value) {
    const text = String(value || '').trim();
    if (!text || text === 'none') {
        return null;
    }
    return text.split(/[\\/]/).pop() || null;
}

/**
 * Read (and repair in place) the bank registry. Never creates the registry:
 * a chat that has never seen banks keeps a single plain store.
 * @returns {BankRegistry | null}
 */
export function readBankRegistry() {
    const metadata = getChatMetadata();
    const raw = metadata?.[BANK_REGISTRY_KEY];
    if (!isPlainObject(raw)) {
        return null;
    }
    const registry = /** @type {BankRegistry} */ (/** @type {unknown} */ (raw));
    registry.version = REGISTRY_VERSION;
    registry.activeKey =
        typeof registry.activeKey === 'string' && registry.activeKey
            ? registry.activeKey
            : SHARED_BANK_KEY;
    if (!isPlainObject(registry.banks)) {
        registry.banks = {};
    }
    if (!isPlainObject(registry.identities)) {
        registry.identities = {};
    }
    for (const [key, store] of Object.entries(registry.banks)) {
        if (!isPlainObject(store) || key === registry.activeKey) {
            delete registry.banks[key];
        }
    }
    return registry;
}

/**
 * @returns {BankRegistry}
 */
function ensureBankRegistry() {
    const existing = readBankRegistry();
    if (existing) {
        return existing;
    }
    const metadata = getChatMetadata();
    metadata[BANK_REGISTRY_KEY] = /** @type {any} */ ({
        version: REGISTRY_VERSION,
        activeKey: SHARED_BANK_KEY,
        banks: {},
        identities: {},
    });
    return /** @type {BankRegistry} */ (readBankRegistry());
}

/**
 * @param {SummaryceptionStore | null | undefined} store
 * @returns {number}
 */
export function countStoreSnippets(store) {
    if (!store || !Array.isArray(store.layers)) {
        return 0;
    }
    return store.layers.reduce(
        (total, layer) => total + (Array.isArray(layer) ? layer.filter(isValidSnippet).length : 0),
        0,
    );
}

/**
 * @returns {SummaryceptionStore}
 */
function createEmptyStore() {
    return /** @type {SummaryceptionStore} */ ({
        layers: [],
        ghostedMessageIds: [],
        mutationEpoch: 0,
    });
}

/**
 * @typedef {object} BankReconcileResult
 * @property {'unchanged' | 'adopted' | 'switched' | 'deferred'} status
 * @property {string} activeKey
 * @property {string} [fromKey]
 * @property {string} [label]
 */

/**
 * Bring the live slot in line with the bank the chat should be using. Pure
 * metadata work: the caller persists and runs syncGhosting afterwards, which
 * is what actually unhides or hides messages for the new bank.
 * @param {{ memoryBanksEnabled?: boolean }} settings
 * @param {{ busy?: boolean }} [options] - A busy summarizer defers the switch; its in-flight commit belongs to the old bank.
 * @returns {BankReconcileResult}
 */
export function reconcileActiveBank(settings, { busy = false } = {}) {
    const existingRegistry = readBankRegistry();
    // Off means "stop switching", not "switch to an empty shared bank": the
    // bank that is live stays live, so toggling the feature never hides memory.
    if (!settings?.memoryBanksEnabled) {
        return { status: 'unchanged', activeKey: existingRegistry?.activeKey || SHARED_BANK_KEY };
    }
    const desired = resolveActiveBankIdentity(settings);

    // First contact: the chat holds one plain store. It becomes the desired
    // bank as-is, so upgrading from a single-bank build loses nothing.
    if (!existingRegistry) {
        if (desired.key === SHARED_BANK_KEY) {
            return { status: 'unchanged', activeKey: SHARED_BANK_KEY };
        }
        const live = getChatStore();
        // Nothing to own yet: stay registry-free so a no-op load writes nothing.
        // The first reconcile after the chat gains memory claims it.
        if (countStoreSnippets(live) === 0) {
            return { status: 'unchanged', activeKey: SHARED_BANK_KEY };
        }
        const registry = ensureBankRegistry();
        registry.activeKey = desired.key;
        registry.identities[desired.key] = {
            ...desired,
            origin: countStoreSnippets(live) > 0 ? 'migrated-from-shared' : 'new',
        };
        info(`Memory bank: adopted existing chat memory as ${desired.label} (${desired.key}).`);
        return { status: 'adopted', activeKey: desired.key, label: desired.label };
    }

    const registry = existingRegistry;
    const currentKey = registry.activeKey;
    if (currentKey === desired.key) {
        touchIdentity(registry, desired);
        return { status: 'unchanged', activeKey: currentKey };
    }

    // Promotion: a session-scoped bank whose card now resolves to a durable
    // key is the same card, not a new one. Rename instead of switching.
    if (isPromotion(registry, currentKey, desired)) {
        const previous = registry.identities[currentKey];
        delete registry.identities[currentKey];
        registry.identities[desired.key] = {
            ...desired,
            createdAt: previous?.createdAt ?? desired.createdAt,
            formerKeys: unique([...(previous?.formerKeys || []), currentKey]),
            origin: previous?.origin || 'promoted',
        };
        registry.activeKey = desired.key;
        info(`Memory bank: promoted ${currentKey} to ${desired.key}.`);
        return {
            status: 'adopted',
            activeKey: desired.key,
            fromKey: currentKey,
            label: desired.label,
        };
    }

    if (busy) {
        return { status: 'deferred', activeKey: currentKey };
    }

    const metadata = getChatMetadata();
    const outgoing = getChatStore();

    let incoming = registry.banks[desired.key] || null;
    let origin = 'new';
    if (!incoming) {
        incoming = createEmptyStore();
    } else {
        origin = registry.identities[desired.key]?.origin || 'parked';
    }

    // Ghosting ownership describes the chat's visible state, not a bank, so
    // it travels with the live slot. syncGhosting then releases ids the
    // incoming bank does not cover and hides the ones it does.
    incoming.ghostedMessageIds = unique([
        ...normalizeStringArray(outgoing.ghostedMessageIds),
        ...normalizeStringArray(incoming.ghostedMessageIds),
    ]);
    outgoing.ghostedMessageIds = [];
    // Any snapshot captured against either store is stale after a swap.
    const epoch =
        Math.max(Number(outgoing.mutationEpoch) || 0, Number(incoming.mutationEpoch) || 0) + 1;
    outgoing.mutationEpoch = epoch;
    incoming.mutationEpoch = epoch;

    registry.banks[currentKey] = outgoing;
    delete registry.banks[desired.key];
    metadata[MODULE_NAME] = incoming;
    registry.activeKey = desired.key;
    registry.identities[desired.key] = {
        ...(registry.identities[desired.key] || desired),
        label: desired.label,
        stableId: desired.stableId,
        avatar: desired.avatar,
        lastActiveAt: Date.now(),
        origin,
    };
    if (!registry.identities[currentKey]) {
        registry.identities[currentKey] = {
            ...desired,
            key: currentKey,
            label: currentKey === SHARED_BANK_KEY ? 'Shared chat bank' : currentKey,
            kind: currentKey === SHARED_BANK_KEY ? 'shared' : 'character',
        };
    }
    info(`Memory bank: switched ${currentKey} -> ${desired.key}.`);
    return {
        status: 'switched',
        activeKey: desired.key,
        fromKey: currentKey,
        label: desired.label,
    };
}

/**
 * @param {BankRegistry} registry
 * @param {string} currentKey
 * @param {BankIdentity} desired
 * @returns {boolean}
 */
function isPromotion(registry, currentKey, desired) {
    if (desired.kind !== 'character' || registry.banks[desired.key]) {
        return false;
    }
    if (currentKey === 'character:unknown' || currentKey.startsWith('character:session:')) {
        return true;
    }
    if (currentKey.startsWith('character:file:') && desired.key.startsWith('character:stable:')) {
        const previous = registry.identities[currentKey];
        return Boolean(desired.avatar) && previous?.avatar === desired.avatar;
    }
    return false;
}

/**
 * @param {BankRegistry} registry
 * @param {BankIdentity} desired
 * @returns {void}
 */
function touchIdentity(registry, desired) {
    const current = registry.identities[desired.key];
    registry.identities[desired.key] = current
        ? { ...current, label: desired.label || current.label, lastActiveAt: Date.now() }
        : desired;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

/**
 * @typedef {object} BankSummary
 * @property {string} key
 * @property {string} label
 * @property {string} kind
 * @property {boolean} active
 * @property {number} snippets
 * @property {number} layers
 * @property {number} lastActiveAt
 * @property {string[]} formerKeys
 * @property {string} origin
 */

/**
 * Every bank this chat knows about, live one first.
 * @returns {BankSummary[]}
 */
export function listBanks() {
    const registry = readBankRegistry();
    const live = getChatStore();
    const activeKey = registry?.activeKey || SHARED_BANK_KEY;
    const identities = registry?.identities || {};
    const summaries = [summarizeBank(activeKey, live, identities[activeKey], true)];
    for (const [key, store] of Object.entries(registry?.banks || {})) {
        summaries.push(summarizeBank(key, store, identities[key], false));
    }
    return summaries;
}

/**
 * @param {string} key
 * @param {SummaryceptionStore} store
 * @param {BankIdentity | undefined} identity
 * @param {boolean} active
 * @returns {BankSummary}
 */
function summarizeBank(key, store, identity, active) {
    return {
        key,
        label: identity?.label || (key === SHARED_BANK_KEY ? 'Shared chat bank' : key),
        kind:
            identity?.kind ||
            (key.startsWith('group:') ? 'group' : key === SHARED_BANK_KEY ? 'shared' : 'character'),
        active,
        snippets: countStoreSnippets(store),
        layers: Array.isArray(store?.layers)
            ? store.layers.filter((layer) => layer?.length).length
            : 0,
        lastActiveAt: Number(identity?.lastActiveAt) || 0,
        formerKeys: identity?.formerKeys || [],
        origin: identity?.origin || '',
    };
}

/**
 * Read a parked bank's store (or the live one) without switching.
 * @param {string} key
 * @returns {SummaryceptionStore | null}
 */
export function peekBankStore(key) {
    const registry = readBankRegistry();
    const activeKey = registry?.activeKey || SHARED_BANK_KEY;
    if (key === activeKey) {
        return getChatStore();
    }
    return registry?.banks?.[key] || null;
}

/**
 * Copy a parked bank's snippets into the live bank, replacing its layers.
 * Ghosting ownership of the live slot is kept; the caller runs syncGhosting.
 * @param {string} sourceKey
 * @param {{ move?: boolean }} [options]
 * @returns {boolean}
 */
export function adoptBankIntoActive(sourceKey, { move = false } = {}) {
    const registry = readBankRegistry();
    if (!registry || sourceKey === registry.activeKey) {
        return false;
    }
    const source = registry.banks[sourceKey];
    if (!source) {
        return false;
    }
    const live = getChatStore();
    live.layers = structuredClone(source.layers || []);
    live.mutationEpoch = (Number(live.mutationEpoch) || 0) + 1;
    const identity = registry.identities[registry.activeKey];
    if (identity) {
        identity.formerKeys = unique([...(identity.formerKeys || []), sourceKey]);
        identity.origin = move ? 'moved-from-bank' : 'copied-from-bank';
    }
    if (move) {
        delete registry.banks[sourceKey];
        delete registry.identities[sourceKey];
    }
    return true;
}

/**
 * Delete a parked bank. The live bank cannot be deleted here; Clear does that.
 * @param {string} key
 * @returns {boolean}
 */
export function deleteParkedBank(key) {
    const registry = readBankRegistry();
    if (!registry || key === registry.activeKey || !registry.banks[key]) {
        return false;
    }
    delete registry.banks[key];
    delete registry.identities[key];
    return true;
}

/**
 * Whether any parked bank still references message identities (sc_id). Clear
 * must keep identities then, or the parked banks lose their provenance.
 * @returns {boolean}
 */
export function parkedBanksHoldSnippets() {
    const registry = readBankRegistry();
    return Object.values(registry?.banks || {}).some((store) => countStoreSnippets(store) > 0);
}

/**
 * Active bank label for status lines and the {{summaryception_bank}} display.
 * @returns {{ key: string, label: string }}
 */
export function getActiveBankLabel() {
    const registry = readBankRegistry();
    const key = registry?.activeKey || SHARED_BANK_KEY;
    const label =
        registry?.identities?.[key]?.label || (key === SHARED_BANK_KEY ? 'Shared chat bank' : key);
    return { key, label };
}

/**
 * Serialize one bank for export.
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
export function exportBank(key) {
    const store = peekBankStore(key);
    if (!store) {
        return null;
    }
    const registry = readBankRegistry();
    return {
        format: 'summaryception-bank',
        version: REGISTRY_VERSION,
        key,
        identity: registry?.identities?.[key] || null,
        exportedAt: new Date().toISOString(),
        layers: structuredClone(store.layers || []),
    };
}
