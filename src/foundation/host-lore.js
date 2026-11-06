import { getChatMetadata, getContext } from './context.js';

/**
 * Card, group, and World Info reads for Memory Banks and Lorebook Ingestion.
 * Every call still goes through the getContext() facade; this module only
 * shapes what those features need from it.
 */

/**
 * The card the chat is attached to, plus the group id when one is active.
 * Group chats report no card: during group generation SillyTavern points
 * `characterId` at whichever member is speaking, so it is not a stable owner.
 * @returns {{ groupId: string | null, characterId: string | number | null, character: Record<string, any> | null, groupName: string, name2: string }}
 */
export function getActiveCharacterInfo() {
    const ctx = /** @type {any} */ (getContext());
    const groupId = ctx.groupId ?? null;
    const rawId = ctx.characterId;
    const characterId = rawId === undefined || rawId === null || rawId === '' ? null : rawId;
    const character =
        !groupId && characterId !== null ? (ctx.characters?.[characterId] ?? null) : null;
    const group =
        groupId && Array.isArray(ctx.groups)
            ? (ctx.groups.find((/** @type {any} */ g) => g?.id === groupId) ?? null)
            : null;
    return {
        groupId: groupId ? String(groupId) : null,
        characterId,
        character,
        groupName: group?.name ? String(group.name) : '',
        name2: String(ctx.name2 || ''),
    };
}

/**
 * World Info host API, defensive: older hosts may lack an entry.
 * @returns {{ load: (name: string) => Promise<any>, save: (name: string, data: any, immediately?: boolean) => Promise<void>, names: () => string[], refreshList: () => Promise<void>, reloadEditor: (name: string) => void }}
 */
export function getWorldInfoApi() {
    const ctx = /** @type {any} */ (getContext());
    return {
        load: async (name) =>
            typeof ctx.loadWorldInfo === 'function' ? await ctx.loadWorldInfo(name) : null,
        save: async (name, data, immediately = true) => {
            if (typeof ctx.saveWorldInfo !== 'function') {
                throw new Error('This SillyTavern build does not expose saveWorldInfo.');
            }
            await ctx.saveWorldInfo(name, data, immediately);
        },
        names: () => (typeof ctx.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : []),
        refreshList: async () => {
            if (typeof ctx.updateWorldInfoList === 'function') {
                await ctx.updateWorldInfoList();
            }
        },
        reloadEditor: (name) => {
            try {
                ctx.reloadWorldInfoEditor?.(name, false);
            } catch (_e) {
                // The editor refresh is cosmetic; the save already landed.
            }
        },
    };
}

/**
 * Lorebook bound to the open chat (Chat Lore), if any.
 * @returns {string}
 */
export function getChatLorebookName() {
    return String(getChatMetadata()?.world_info || '');
}

/**
 * Primary lorebook linked on the active card, if any.
 * @returns {string}
 */
export function getCharacterLorebookName() {
    const { character } = getActiveCharacterInfo();
    return String(character?.data?.extensions?.world || '');
}
