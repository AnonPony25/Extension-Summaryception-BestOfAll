import { getContext, saveMetadata } from '../foundation/context.js';
import { getSettings } from '../foundation/settings.js';
import { info, warn, debug } from '../foundation/logger.js';
import {
    DEFAULT_LOREBOOK_ENTRY_PROMPTS,
    LOREBOOK_ENTITY_TYPES,
} from '../foundation/lorebook-prompts.js';
import { onLayer0Committed } from './layer0-observers.js';
import {
    addProposal,
    buildDedupKey,
    findProposal,
    getLoreState,
    hasPendingProposal,
} from './lorebook-queue.js';
import {
    buildLoreIndex,
    findEntryByName,
    loadLoreTarget,
    resolveLoreTarget,
    writeProposal,
} from './lorebook-writer.js';

/**
 * Lorebook Ingestion (automatic fact extraction, after Romuromylus).
 *
 * Flow per committed Layer 0 Snippet:
 *   1. Lore Scout call reads the Passage + the new Snippet + an index of the
 *      target lorebook and emits NEW:/UPDATE: tags (or NONE).
 *   2. Tags are filtered (enabled types, updates allowed, player excluded),
 *      deduplicated against pending proposals, and collision-corrected:
 *      NEW for a known entry becomes UPDATE, UPDATE for an unknown one NEW.
 *   3. One entry call per tag drafts the entry body from the raw Passage.
 *   4. Review mode stages a proposal; Auto mode writes it and records it as
 *      approved so it stays revertable.
 *
 * Runs strictly serially and fire-and-forget: the summarization pipeline
 * never awaits it. Every write re-checks that the chat did not change.
 */

/** Matches Romuromylus's tag grammar, tolerant of dash/colon variants. */
const TAG_REGEX =
    /^\s*(?:[-*•]\s*)?\**(NEW|UPDATE)\**\s*:\s*(char|character|loc|location|faction|item|lore)\s*:\s*(.+?)(?:\s*[—–]\s*|\s+-{1,2}\s+|\s*:\s+)(.+?)\s*$/i;

const TYPE_ALIASES = Object.freeze({ character: 'char', location: 'loc' });

/**
 * @typedef {object} LoreTag
 * @property {'create' | 'update'} kind
 * @property {string} entityType
 * @property {string} name
 * @property {string} detail
 */

/**
 * Parse scout output into tags. Lines that do not match are ignored.
 * @param {string} text
 * @returns {LoreTag[]}
 */
export function parseLoreTags(text) {
    /** @type {LoreTag[]} */
    const tags = [];
    const seen = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
        const match = line.match(TAG_REGEX);
        if (!match) {
            continue;
        }
        const kind = match[1].toUpperCase() === 'NEW' ? 'create' : 'update';
        const rawType = match[2].toLowerCase();
        const entityType = TYPE_ALIASES[rawType] || rawType;
        const name = cleanEntityName(match[3]);
        const detail = match[4].trim();
        if (!name) {
            continue;
        }
        const key = `${entityType}|${name.toLowerCase()}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        tags.push({ kind, entityType, name, detail });
    }
    return tags;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function cleanEntityName(raw) {
    return String(raw || '')
        .replace(/^[\s"'`*_[\]()]+|[\s"'`*_[\]()]+$/g, '')
        .trim()
        .slice(0, 80);
}

/**
 * Strip wrappers models add around a body despite instructions.
 * @param {string} text
 * @returns {string}
 */
export function cleanEntryBody(text) {
    let body = String(text || '').trim();
    body = body.replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    body = body.replace(/<\/?(entry|profile|output|revised_entry|narrative)>/gi, '');
    body = body.replace(/^(revised entry|entry|profile|output)\s*:\s*/i, '');
    return body.trim();
}

/**
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
function renderTemplate(template, values) {
    let out = String(template || '');
    for (const [key, value] of Object.entries(values)) {
        out = out.replaceAll(`{{${key}}}`, value);
    }
    return out;
}

/**
 * @param {Record<string, any>} settings
 * @param {string} type
 * @returns {string}
 */
function entryTemplateFor(settings, type) {
    const custom = settings.lorebookEntryPrompts?.[type];
    if (typeof custom === 'string' && custom.trim()) {
        return custom;
    }
    return DEFAULT_LOREBOOK_ENTRY_PROMPTS[type] || DEFAULT_LOREBOOK_ENTRY_PROMPTS.lore;
}

/**
 * @returns {string}
 */
function currentChatId() {
    return String(getContext().getCurrentChatId?.() || '');
}

/**
 * @returns {string}
 */
function playerName() {
    return String(getContext().name1 || 'User');
}

/**
 * @param {object} deps
 * @param {(request: any) => Promise<{ status: string, text?: string }>} deps.dispatch
 * @param {import('./notify.js').NotifyAdapter} [deps.notify]
 * @param {(summary: LoreScanSummary) => void} [deps.onScanSettled] - UI hook
 * @param {() => boolean} [deps.isForegroundBusy] - True while the host generates; lore calls wait it out
 * @returns {{ scan: (event: import('./layer0-observers.js').Layer0CommitEvent, options?: { manual?: boolean }) => Promise<LoreScanSummary>, isBusy: () => boolean, dispose: () => void }}
 */
export function createLorebookIngestor({ dispatch, notify, onScanSettled, isForegroundBusy }) {
    let chain = Promise.resolve();
    let pending = 0;

    /**
     * Lore calls are background work: never race the user's own reply on a
     * shared connection. Waits at most two minutes, then proceeds.
     * @param {any} request
     * @returns {Promise<{ status: string, text?: string }>}
     */
    async function dispatchWhenIdle(request) {
        const deadline = Date.now() + 120_000;
        while (isForegroundBusy?.() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 750));
        }
        return await dispatch(request);
    }

    /**
     * @param {import('./layer0-observers.js').Layer0CommitEvent} event
     * @param {{ manual?: boolean }} [options]
     * @returns {Promise<LoreScanSummary>}
     */
    function scan(event, options = {}) {
        pending += 1;
        const job = chain.then(() => runScan(event, options));
        chain = job
            .then(
                () => undefined,
                () => undefined,
            )
            .finally(() => {
                pending -= 1;
            });
        return job;
    }

    /**
     * @param {import('./layer0-observers.js').Layer0CommitEvent} event
     * @param {{ manual?: boolean }} options
     * @returns {Promise<LoreScanSummary>}
     */
    async function runScan(event, { manual = false }) {
        const settings = getSettings();
        /** @type {LoreScanSummary} */
        const summary = { status: 'skipped', proposals: 0, written: 0, failures: 0, tags: 0 };
        if (!settings.lorebookEnabled && !manual) {
            return summary;
        }
        const chatId = currentChatId();
        if (!chatId) {
            return summary;
        }
        const target = resolveLoreTarget(settings);
        if (!target.name) {
            warn(`Lorebook: skipped scan, ${target.reason}`);
            return { ...summary, status: 'no-target', reason: target.reason };
        }

        const book = await loadLoreTarget(settings, { create: false });
        const index = buildLoreIndex(book?.data || null);
        const scoutResponse = await dispatchWhenIdle({
            storyTxt: `${event.passageText}\n\n<new_summary>\n${event.snippetText}\n</new_summary>`,
            contextStr: index,
            metadata: {
                kind: 'lorebook-scout',
                sourceTokensBefore: 0,
                sourceRange: event.sourceRange,
            },
            notify,
        });
        if (scoutResponse.status !== 'completed' || typeof scoutResponse.text !== 'string') {
            return {
                ...summary,
                status: scoutResponse.status === 'aborted' ? 'aborted' : 'failed',
            };
        }
        if (currentChatId() !== chatId) {
            return { ...summary, status: 'chat-changed' };
        }

        const enabledTypes = new Set(
            (Array.isArray(settings.lorebookTypes)
                ? settings.lorebookTypes
                : LOREBOOK_ENTITY_TYPES
            ).map(String),
        );
        const player = playerName().toLowerCase();
        const maxTags = Math.max(
            1,
            Math.min(12, Math.round(Number(settings.lorebookMaxTagsPerScan) || 4)),
        );
        const tags = parseLoreTags(scoutResponse.text)
            .filter((tag) => enabledTypes.has(tag.entityType))
            .filter((tag) => tag.name.toLowerCase() !== player)
            .slice(0, maxTags);
        summary.tags = tags.length;
        debug(`Lorebook: scout returned ${tags.length} tag(s).`);

        const state = getLoreState();
        state.scans += 1;
        state.lastScanAt = Date.now();

        for (const tag of tags) {
            const existing = findEntryByName(book?.data || null, tag.name);
            // Collision correction (Romuromylus): trust the book over the tag.
            const kind = existing ? 'update' : 'create';
            if (kind === 'update' && !settings.lorebookAllowUpdates) {
                continue;
            }
            const dedupKey = buildDedupKey(kind, tag.entityType, tag.name);
            if (hasPendingProposal(dedupKey)) {
                continue;
            }

            const prompt =
                kind === 'update'
                    ? renderTemplate(entryTemplateFor(settings, 'update'), {
                          player_name: playerName(),
                          entity_name: tag.name,
                          entity_type: tag.entityType,
                          change_reason: tag.detail,
                          source_passage: event.passageText,
                          source_snippet: event.snippetText,
                          existing_entry: String(existing?.entry?.content || ''),
                          gloss: tag.detail,
                      })
                    : renderTemplate(entryTemplateFor(settings, tag.entityType), {
                          player_name: playerName(),
                          entity_name: tag.name,
                          entity_type: tag.entityType,
                          gloss: tag.detail,
                          source_passage: event.passageText,
                          source_snippet: event.snippetText,
                          change_reason: '',
                          existing_entry: '',
                      });

            const response = await dispatchWhenIdle({
                storyTxt: prompt,
                contextStr: '',
                metadata: {
                    kind: 'lorebook-entry',
                    sourceTokensBefore: 0,
                    sourceRange: event.sourceRange,
                    loreEntityName: tag.name,
                },
                notify,
            });
            if (response.status === 'aborted') {
                summary.status = 'aborted';
                break;
            }
            const body = response.status === 'completed' ? cleanEntryBody(response.text || '') : '';
            if (!body) {
                summary.failures += 1;
                continue;
            }
            if (currentChatId() !== chatId) {
                return { ...summary, status: 'chat-changed' };
            }

            const proposal = addProposal({
                kind,
                entityType: tag.entityType,
                name: tag.name,
                detail: tag.detail,
                keys: existing ? [...(existing.entry.key || [])] : [tag.name],
                targetLorebook: target.name,
                sourceMessageIds: [...event.sourceMessageIds],
                sourceRange: event.sourceRange,
                sourceSnippetText: event.snippetText,
                proposedContent: body,
                existingUid: existing ? existing.uid : null,
                existingContentSnapshot: existing ? String(existing.entry.content || '') : null,
                dedupKey,
            });
            summary.proposals += 1;

            if (settings.lorebookReviewMode === 'auto') {
                const outcome = await approveProposal(proposal.id);
                if (outcome.ok) {
                    summary.written += 1;
                } else {
                    summary.failures += 1;
                }
            }
        }

        if (summary.status === 'skipped') {
            summary.status = 'completed';
        }
        await saveMetadata();
        info(
            `Lorebook: scan ${summary.status}, ${summary.tags} tag(s), ${summary.proposals} proposal(s), ${summary.written} written.`,
        );
        return summary;
    }

    const unsubscribe = onLayer0Committed(async (events) => {
        if (!getSettings().lorebookEnabled) {
            return;
        }
        for (const event of events) {
            const result = await scan(event);
            onScanSettled?.(result);
        }
    });

    return {
        scan,
        isBusy: () => pending > 0,
        dispose: unsubscribe,
    };
}

/**
 * @typedef {object} LoreScanSummary
 * @property {'skipped' | 'completed' | 'failed' | 'aborted' | 'chat-changed' | 'no-target'} status
 * @property {number} tags
 * @property {number} proposals
 * @property {number} written
 * @property {number} failures
 * @property {string} [reason]
 */

/**
 * Approve a pending proposal: write it into the lorebook and record what it
 * replaced, so it can be reverted.
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string, action?: string, conflict?: boolean, book?: string }>}
 */
export async function approveProposal(id) {
    const proposal = findProposal(id);
    if (!proposal || proposal.status !== 'pending') {
        return { ok: false, error: 'Proposal is not pending.' };
    }
    const settings = getSettings();
    const result = await writeProposal(settings, proposal);
    if (!result.ok) {
        proposal.error = result.error || 'Write failed.';
        await saveMetadata();
        return { ok: false, error: proposal.error };
    }
    proposal.status = 'approved';
    proposal.resolvedAt = Date.now();
    proposal.committedUid = result.uid;
    proposal.contentBeforeCommit = result.contentBefore;
    proposal.targetLorebook = result.book;
    delete proposal.error;
    await saveMetadata();
    return { ok: true, action: result.action, conflict: result.conflict, book: result.book };
}
