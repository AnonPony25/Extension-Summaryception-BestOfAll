import { getChat } from '../foundation/context.js';
import { getChatStore } from '../foundation/chat-store.js';
import { removeMessageIdentities } from '../foundation/message-identity.js';
import { refreshFull } from '../foundation/refresh.js';
import { commitSnippetMutation } from './snippet-commit.js';
import { persistChatState } from './persist-state.js';
import { removeMessageTokenCaches } from './token-count.js';
import { removeCheckpoints } from './continuity-checkpoint.js';
import { parkedBanksHoldSnippets } from './memory-banks.js';
import { clearLoreReviewQueue } from './lorebook-queue.js';

/**
 * Clear: remove every piece of Extension Chat Data from the chat and unhide its
 * messages, leaving the chat as if the extension had never run (ADR-0027). Each
 * shape is removed by the module that writes it, never by inspecting a key
 * name. The Chat Store is emptied in place through the Snippet Commit seam,
 * which also releases the Ghosting ownership and bumps the Mutation Epoch;
 * the chat file is then written once, by the one writer, and the visible state
 * and the injections re-render from the wiped chat.
 *
 * A step that fails leaves the wipe partial; the action is user-confirmed and
 * idempotent, so re-running it finishes the job.
 *
 * Memory Banks: Clear empties the live bank only. When a parked bank still
 * holds Snippets, message identities stay so that bank keeps its provenance;
 * the parked banks themselves are removed from the Banks panel, one by one.
 * @returns {Promise<void>}
 */
export async function clearChatData() {
    const store = getChatStore();
    await commitSnippetMutation(
        store,
        () => {
            store.layers.length = 0;
        },
        { ghost: 'clear' },
    );

    const chat = getChat();
    if (!parkedBanksHoldSnippets()) {
        removeMessageIdentities(chat);
    }
    clearLoreReviewQueue();
    removeMessageTokenCaches(chat);
    removeCheckpoints(chat);

    await persistChatState({ chatSave: 'immediate' });
    refreshFull();
}
