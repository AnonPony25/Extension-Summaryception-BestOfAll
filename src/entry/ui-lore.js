import { getChat, getContext } from '../foundation/context.js';
import { defaultSettings } from '../foundation/constants.js';
import { getSettings, saveSettings } from '../foundation/settings.js';
import { getChatStore, saveChatStore, isValidSnippet } from '../foundation/chat-store.js';
import { resolveScIdsToIndices } from '../foundation/message-identity.js';
import {
    DEFAULT_LOREBOOK_ENTRY_PROMPTS,
    LOREBOOK_ENTITY_LABELS,
} from '../foundation/lorebook-prompts.js';
import { refreshFull } from '../foundation/refresh.js';
import { syncGhosting } from '../core/ghosting.js';
import { buildPassageFromRangeWithStats } from '../core/chatutils.js';
import {
    adoptBankIntoActive,
    deleteParkedBank,
    exportBank,
    getActiveBankLabel,
    listBanks,
} from '../core/memory-banks.js';
import {
    clearResolvedProposals,
    countPendingProposals,
    editProposal,
    findProposal,
    listProposals,
    rejectProposal,
} from '../core/lorebook-queue.js';
import { approveProposal } from '../core/lorebook-ingest.js';
import { resolveLoreTarget, revertProposal } from '../core/lorebook-writer.js';
import { saveMetadata } from '../foundation/context.js';
import { bindDataSettingElements, syncDataSettingElements } from './ui-bind.js';
import { reconcileMemoryBank } from './events.js';

/**
 * Lore & Banks tab: Memory Banks list and actions, Lorebook Ingestion
 * settings, and the Lore Review Queue. Entry-layer only: every state change
 * goes through the core modules; this file renders and routes clicks.
 */

const SECTION_SELECTOR = '#sc_banks_section [data-sc-setting], #sc_lore_section [data-sc-setting]';

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../core/lorebook-ingest.js').createLorebookIngestor>} deps.ingestor
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} deps.queue
 * @param {import('../core/foreground-gate.js').ForegroundGate} deps.gate
 * @returns {{ render: () => void }}
 */
export function initLoreBanksUI({ ingestor, queue, gate }) {
    bindDataSettingElements(SECTION_SELECTOR, {
        eventName: 'change',
        afterSave: (_settings, _value, $source) => {
            const key = String($source?.attr?.('data-sc-setting') || '');
            if (key === 'memoryBanksEnabled') {
                void reconcileMemoryBank({ queue, gate }).then(render);
                return;
            }
            render();
        },
    });

    bindTypeCheckboxes();
    bindEntryPromptEditor();
    bindBankActions({ queue, gate });
    bindQueueActions({ ingestor });

    const ctx = getContext();
    const chatChanged = ctx.event_types?.CHAT_CHANGED ?? ctx.eventTypes?.CHAT_CHANGED;
    if (chatChanged) {
        ctx.eventSource?.on?.(chatChanged, () => setTimeout(render, 250));
    }

    render();
    return { render };
}

// ─── Rendering ───────────────────────────────────────────────────────────

function render() {
    try {
        renderBanks();
        renderTarget();
        renderQueue();
        syncTypeCheckboxes();
        syncEntryPromptEditor();
        syncDataSettingElements(SECTION_SELECTOR);
    } catch (error) {
        console.warn('[Summaryception] Lore & Banks render failed', error);
    }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function renderBanks() {
    const active = getActiveBankLabel();
    $('#sc_bank_active_label').text(active.label);
    $('#sc_bank_active_key').text(active.key);
    const banks = listBanks();
    const rows = banks.map((bank) => {
        const when = bank.lastActiveAt ? new Date(bank.lastActiveAt).toLocaleString() : '';
        const actions = bank.active
            ? '<span class="sc-badge sc-badge-active">live</span>'
            : `<button class="menu_button sc-bank-action" data-action="copy" data-key="${escapeHtml(bank.key)}" title="Replace the live bank's snippets with a copy of this bank">Copy in</button>
               <button class="menu_button sc-bank-action" data-action="move" data-key="${escapeHtml(bank.key)}" title="Move this bank's snippets into the live bank and delete it">Move in</button>
               <button class="menu_button sc-bank-action" data-action="export" data-key="${escapeHtml(bank.key)}">Export</button>
               <button class="menu_button menu_button_danger sc-bank-action" data-action="delete" data-key="${escapeHtml(bank.key)}">Delete</button>`;
        return `<div class="sc-bank-row${bank.active ? ' sc-bank-row-active' : ''}">
            <div class="sc-bank-meta">
                <strong>${escapeHtml(bank.label)}</strong>
                <small class="sc-hint">${escapeHtml(bank.kind)} · ${bank.snippets} snippet(s) · ${bank.layers} layer(s)${when ? ` · ${escapeHtml(when)}` : ''}${bank.origin ? ` · ${escapeHtml(bank.origin)}` : ''}</small>
                ${bank.formerKeys.length ? `<small class="sc-hint">formerly: ${escapeHtml(bank.formerKeys.join(', '))}</small>` : ''}
            </div>
            <div class="sc-bank-actions">${actions}</div>
        </div>`;
    });
    $('#sc_bank_list').html(rows.join(''));
}

function renderTarget() {
    const settings = getSettings();
    let hint = '';
    try {
        const target = resolveLoreTarget(settings);
        hint = target.name
            ? `${target.reason}: "${target.name}"${target.exists ? '' : target.canCreate ? ' (will be created)' : ' (missing)'}`
            : target.reason;
    } catch (_e) {
        hint = 'Open a chat to resolve the target.';
    }
    $('#sc_lorebook_target_hint').text(hint);
}

function renderQueue() {
    const pending = listProposals('pending');
    const resolved = listProposals('resolved').sort(
        (a, b) => (b.resolvedAt || b.createdAt) - (a.resolvedAt || a.createdAt),
    );
    $('#sc_lore_pending_count').text(String(countPendingProposals()));
    $('#sc_lore_queue').html(
        pending.length
            ? pending.map(renderPendingCard).join('')
            : '<small class="sc-hint">No pending proposals. New ones appear after Layer 0 snippets commit.</small>',
    );
    $('#sc_lore_history').html(
        resolved.length
            ? resolved.slice(0, 60).map(renderHistoryRow).join('')
            : '<small class="sc-hint">Empty.</small>',
    );
}

/**
 * @param {import('../core/lorebook-queue.js').LoreProposal} item
 * @returns {string}
 */
function renderPendingCard(item) {
    const label = LOREBOOK_ENTITY_LABELS[item.entityType] || item.entityType;
    const range = Array.isArray(item.sourceRange)
        ? ` · turns ${item.sourceRange[0]}-${item.sourceRange[1]}`
        : '';
    return `<div class="sc-lore-card" data-id="${escapeHtml(item.id)}">
        <div class="sc-lore-card-head">
            <span class="sc-badge sc-badge-${item.kind}">${item.kind === 'update' ? 'UPDATE' : 'NEW'}</span>
            <span class="sc-badge">${escapeHtml(label)}</span>
            <input class="text_pole sc-lore-name" type="text" value="${escapeHtml(item.name)}" />
        </div>
        <small class="sc-hint">${escapeHtml(item.detail)} · ${escapeHtml(item.targetLorebook)}${range}</small>
        ${item.error ? `<small class="sc-hint sc-error">${escapeHtml(item.error)}</small>` : ''}
        <label class="sc-hint">Keys (comma separated)</label>
        <input class="text_pole sc-lore-keys" type="text" value="${escapeHtml((item.keys || []).join(', '))}" />
        <textarea class="text_pole sc-textarea sc-lore-content" rows="6">${escapeHtml(item.proposedContent)}</textarea>
        ${
            item.kind === 'update' && item.existingContentSnapshot
                ? `<details class="sc-details"><summary>Current entry</summary><pre class="sc-lore-pre">${escapeHtml(item.existingContentSnapshot)}</pre></details>`
                : ''
        }
        <div class="sc-button-row">
            <button class="menu_button sc-lore-action" data-action="approve"><i class="fa-solid fa-check"></i><span>Approve</span></button>
            <button class="menu_button sc-lore-action" data-action="save"><i class="fa-solid fa-floppy-disk"></i><span>Save Edits</span></button>
            <button class="menu_button sc-lore-action" data-action="reject"><i class="fa-solid fa-xmark"></i><span>Reject</span></button>
        </div>
    </div>`;
}

/**
 * @param {import('../core/lorebook-queue.js').LoreProposal} item
 * @returns {string}
 */
function renderHistoryRow(item) {
    const label = LOREBOOK_ENTITY_LABELS[item.entityType] || item.entityType;
    const revert =
        item.status === 'approved'
            ? `<button class="menu_button sc-lore-action" data-action="revert" title="Undo this write in the lorebook">Revert</button>`
            : '';
    return `<div class="sc-lore-history-row" data-id="${escapeHtml(item.id)}">
        <span class="sc-badge">${escapeHtml(item.status)}</span>
        <span>${escapeHtml(label)}: <strong>${escapeHtml(item.name)}</strong></span>
        <small class="sc-hint">${escapeHtml(item.targetLorebook)}</small>
        ${revert}
    </div>`;
}

// ─── Settings helpers ───────────────────────────────────────────────────

function bindTypeCheckboxes() {
    $(document).on('change', '#sc_lorebook_types input[type="checkbox"]', () => {
        const values = [];
        $('#sc_lorebook_types input[type="checkbox"]').each(function () {
            if ($(this).is(':checked')) {
                values.push(String($(this).val()));
            }
        });
        getSettings().lorebookTypes = values;
        saveSettings();
    });
}

function syncTypeCheckboxes() {
    const enabled = new Set(getSettings().lorebookTypes || []);
    $('#sc_lorebook_types input[type="checkbox"]').each(function () {
        $(this).prop('checked', enabled.has(String($(this).val())));
    });
}

function currentPromptType() {
    return String($('#sc_lorebook_entry_prompt_type').val() || 'char');
}

function bindEntryPromptEditor() {
    $(document).on('change', '#sc_lorebook_entry_prompt_type', syncEntryPromptEditor);
    $(document).on('change', '#sc_lorebook_entry_prompt', function () {
        const settings = getSettings();
        settings.lorebookEntryPrompts = {
            ...(settings.lorebookEntryPrompts || {}),
            [currentPromptType()]: String($(this).val() || ''),
        };
        saveSettings();
    });
    $(document).on('click', '#sc_lorebook_prompts_reset', () => {
        const settings = getSettings();
        settings.lorebookSystemPrompt = defaultSettings.lorebookSystemPrompt;
        settings.lorebookScoutPrompt = defaultSettings.lorebookScoutPrompt;
        settings.lorebookEntryPrompts = { ...DEFAULT_LOREBOOK_ENTRY_PROMPTS };
        saveSettings();
        render();
    });
}

function syncEntryPromptEditor() {
    const type = currentPromptType();
    const prompts = getSettings().lorebookEntryPrompts || {};
    $('#sc_lorebook_entry_prompt').val(prompts[type] || DEFAULT_LOREBOOK_ENTRY_PROMPTS[type] || '');
}

// ─── Banks ──────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {import('../core/summarizer-queue.js').SummarizerQueue} deps.queue
 * @param {import('../core/foreground-gate.js').ForegroundGate} deps.gate
 * @returns {void}
 */
function bindBankActions({ queue, gate }) {
    $(document).on('click', '#sc_bank_refresh', () => {
        void reconcileMemoryBank({ queue, gate }).then(render);
    });
    $(document).on('click', '.sc-bank-action', async function () {
        const action = String($(this).data('action'));
        const key = String($(this).data('key'));
        if (queue.isBusy?.()) {
            globalThis.toastr?.warning?.(
                'Wait for summarization to finish first.',
                'Summaryception',
            );
            return;
        }
        if (action === 'export') {
            const payload = exportBank(key);
            if (payload) {
                downloadJson(
                    payload,
                    `summaryception-bank-${key.replace(/[^a-z0-9]+/gi, '_')}.json`,
                );
            }
            return;
        }
        if (action === 'delete') {
            if (!globalThis.confirm?.(`Delete the parked bank "${key}"? This cannot be undone.`)) {
                return;
            }
            deleteParkedBank(key);
        } else if (action === 'copy' || action === 'move') {
            const verb = action === 'move' ? 'Move' : 'Copy';
            if (
                !globalThis.confirm?.(
                    `${verb} "${key}" into the live bank? The live bank's current snippets are replaced.`,
                )
            ) {
                return;
            }
            adoptBankIntoActive(key, { move: action === 'move' });
            await syncGhosting({ gate });
            refreshFull();
        }
        await saveChatStore();
        render();
    });
}

/**
 * @param {unknown} payload
 * @param {string} filename
 * @returns {void}
 */
function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Review queue ───────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../core/lorebook-ingest.js').createLorebookIngestor>} deps.ingestor
 * @returns {void}
 */
function bindQueueActions({ ingestor }) {
    $(document).on('click', '.sc-lore-action', async function () {
        const action = String($(this).data('action'));
        const $card = $(this).closest('[data-id]');
        const id = String($card.data('id'));
        if (action === 'approve' || action === 'save') {
            editProposal(id, readCardEdits($card));
        }
        if (action === 'approve') {
            const result = await approveProposal(id);
            notifyApproval(result, findProposal(id)?.name || '');
        } else if (action === 'reject') {
            rejectProposal(id);
        } else if (action === 'revert') {
            const proposal = findProposal(id);
            const result = proposal
                ? await revertProposal(getSettings(), proposal)
                : { ok: false, error: 'Missing.' };
            if (result.ok && proposal) {
                proposal.status = 'reverted';
                proposal.resolvedAt = Date.now();
            } else {
                globalThis.toastr?.warning?.(result.error || 'Revert failed.', 'Summaryception');
            }
        }
        await saveMetadata();
        render();
    });

    $(document).on('click', '#sc_lore_approve_all', async () => {
        const pending = listProposals('pending');
        let ok = 0;
        for (const item of pending) {
            const $card = $(`.sc-lore-card[data-id="${item.id}"]`);
            if ($card.length) {
                editProposal(item.id, readCardEdits($card));
            }
            const result = await approveProposal(item.id);
            ok += result.ok ? 1 : 0;
        }
        globalThis.toastr?.success?.(
            `Wrote ${ok} of ${pending.length} lore entr${pending.length === 1 ? 'y' : 'ies'}.`,
            'Summaryception',
        );
        render();
    });
    $(document).on('click', '#sc_lore_reject_all', async () => {
        for (const item of listProposals('pending')) {
            rejectProposal(item.id);
        }
        await saveMetadata();
        render();
    });
    $(document).on('click', '#sc_lore_clear_history', async () => {
        clearResolvedProposals();
        await saveMetadata();
        render();
    });
    $(document).on('click', '#sc_lore_scan_now', async () => {
        const event = await buildLatestSnippetEvent();
        if (!event) {
            globalThis.toastr?.info?.(
                'No Layer 0 snippet with resolvable source messages yet.',
                'Summaryception',
            );
            return;
        }
        globalThis.toastr?.info?.('Scanning the latest snippet for lore...', 'Summaryception', {
            timeOut: 2000,
        });
        const summary = await ingestor.scan(event, { manual: true });
        announceScan(summary);
        render();
    });
}

/**
 * @param {any} $card
 * @returns {{ proposedContent: string, keys: string[], name: string }}
 */
function readCardEdits($card) {
    return {
        proposedContent: String($card.find('.sc-lore-content').val() || ''),
        keys: String($card.find('.sc-lore-keys').val() || '')
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean),
        name: String($card.find('.sc-lore-name').val() || ''),
    };
}

/**
 * @param {{ ok: boolean, error?: string, action?: string, conflict?: boolean, book?: string }} result
 * @param {string} name
 * @returns {void}
 */
function notifyApproval(result, name) {
    if (!result.ok) {
        globalThis.toastr?.error?.(result.error || 'Write failed.', 'Summaryception');
        return;
    }
    const verb = result.action === 'updated' ? 'Updated' : 'Created';
    globalThis.toastr?.success?.(`${verb} "${name}" in ${result.book}.`, 'Summaryception');
    if (result.conflict) {
        globalThis.toastr?.warning?.(
            `"${name}" changed after this proposal was drafted; your newer edits were overwritten. Use Revert to restore them.`,
            'Summaryception',
        );
    }
}

/**
 * @param {import('../core/lorebook-ingest.js').LoreScanSummary} summary
 * @returns {void}
 */
export function announceScan(summary) {
    if (!summary || summary.status === 'skipped') {
        return;
    }
    if (summary.status === 'no-target') {
        globalThis.toastr?.warning?.(`Lorebook: ${summary.reason}`, 'Summaryception');
        return;
    }
    if (summary.status === 'failed') {
        globalThis.toastr?.warning?.('Lore scan failed; see the console.', 'Summaryception');
        return;
    }
    if (summary.proposals > 0) {
        const message =
            summary.written > 0
                ? `Lorebook: wrote ${summary.written} entr${summary.written === 1 ? 'y' : 'ies'}.`
                : `Lorebook: ${summary.proposals} proposal(s) waiting for review.`;
        globalThis.toastr?.info?.(message, 'Summaryception', { timeOut: 3500 });
    }
    render();
}

/**
 * Rebuild the commit event for the newest Layer 0 snippet from its
 * provenance, for the manual Scan Latest action and /sc-lore-scan.
 * @returns {Promise<import('../core/layer0-observers.js').Layer0CommitEvent | null>}
 */
export async function buildLatestSnippetEvent() {
    const store = getChatStore();
    const layer0 = Array.isArray(store.layers?.[0]) ? store.layers[0].filter(isValidSnippet) : [];
    const snippet = layer0[layer0.length - 1];
    if (!snippet) {
        return null;
    }
    const chat = getChat();
    const indices = resolveScIdsToIndices(chat, snippet.sourceMessageIds);
    if (!indices.length) {
        return null;
    }
    const start = indices[0];
    const end = indices[indices.length - 1];
    const passage = await buildPassageFromRangeWithStats(chat, start, end);
    return {
        passageText: passage.text,
        snippetText: snippet.text,
        sourceMessageIds: [...snippet.sourceMessageIds],
        sourceRange: [start, end],
    };
}
