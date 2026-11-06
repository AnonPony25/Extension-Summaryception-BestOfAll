import { layerLabel, listNonEmptyLayers } from '../foundation/constants.js';
import { getChat, getSlashCommand, getSlashCommandParser } from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { getChatStore } from '../foundation/chat-store.js';
import { clearChatData } from '../core/chat-data.js';
import { buildInjection } from '../core/memory-injection.js';
import { getCurrentSummarizedBoundary } from '../core/snippet-provenance.js';
import { getActiveBankLabel, listBanks } from '../core/memory-banks.js';
import { countPendingProposals } from '../core/lorebook-queue.js';

/**
 * Registers the extension's slash commands with the host parser.
 * Skips registration when the host omits the parser.
 * @param {{ lore?: { scanLatest: () => Promise<import('../core/lorebook-ingest.js').LoreScanSummary | null> } }} [deps]
 * @returns {void}
 */
export function registerSlashCommands({ lore } = {}) {
    try {
        const SlashCommandParser = getSlashCommandParser();
        const SlashCommand = getSlashCommand();

        if (!SlashCommandParser?.addCommandObject || !SlashCommand) {
            warn('SlashCommandParser not available, skipping command registration.');
            return;
        }

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-status',
                callback: () => {
                    const store = getChatStore();
                    const boundary = getCurrentSummarizedBoundary(getChat(), store);
                    const lines = ['**Summaryception Status**'];
                    const bank = getActiveBankLabel();
                    lines.push(`Memory bank: ${bank.label}`);
                    lines.push(`Lore proposals pending: ${countPendingProposals()}`);
                    lines.push(
                        boundary < 0 ? 'No summaries.' : `Current summarized boundary: ${boundary}`,
                    );
                    const nonEmptyLayers = listNonEmptyLayers(store);
                    for (let k = nonEmptyLayers.length - 1; k >= 0; k--) {
                        const { index, layer } = nonEmptyLayers[k];
                        lines.push(`${layerLabel(index)}: ${layer.length} snippets`);
                    }
                    return lines.join('\n');
                },
                helpString: 'Show Summaryception layer status',
            }),
        );

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-clear',
                callback: async () => {
                    await clearChatData();
                    return 'Summaryception memory cleared and messages unghosted.';
                },
                helpString: 'Clear all Summaryception memory and unghost messages for this chat',
            }),
        );

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-preview',
                callback: () => {
                    return buildInjection(getChatStore().layers).text || '(No summaries yet)';
                },
                helpString: 'Preview the summary block that would be injected',
            }),
        );

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-banks',
                callback: () => {
                    const lines = ['**Summaryception Memory Banks**'];
                    for (const bank of listBanks()) {
                        lines.push(
                            `${bank.active ? '▶ ' : '  '}${bank.label} (${bank.kind}): ${bank.snippets} snippets · ${bank.key}`,
                        );
                    }
                    return lines.join('\n');
                },
                helpString: 'List the memory banks stored in this chat',
            }),
        );

        if (lore) {
            SlashCommandParser.addCommandObject(
                SlashCommand.fromProps({
                    name: 'sc-lore-scan',
                    callback: async () => {
                        const summary = await lore.scanLatest();
                        if (!summary) {
                            return 'No Layer 0 snippet to scan yet.';
                        }
                        return `Lore scan ${summary.status}: ${summary.tags} tag(s), ${summary.proposals} proposal(s), ${summary.written} written.`;
                    },
                    helpString: 'Run Lorebook Ingestion on the newest Layer 0 snippet now',
                }),
            );
        }
    } catch (e) {
        warn('Could not register slash commands:', e);
    }
}
