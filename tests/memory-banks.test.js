import { describe, expect, it } from 'vitest';

import {
    BANK_REGISTRY_KEY,
    adoptBankIntoActive,
    deleteParkedBank,
    listBanks,
    parkedBanksHoldSnippets,
    reconcileActiveBank,
    resolveActiveBankIdentity,
} from '../src/core/memory-banks.js';
import { getChatStore } from '../src/foundation/chat-store.js';
import { syncGhosting } from '../src/core/ghosting.js';
import {
    installSummaryContext,
    makeForegroundGate,
    makeMessage,
    makeSummaryStore,
} from './test-helpers.js';

const ON = { memoryBanksEnabled: true };

function snippet(ids, text = 'A thing happened.') {
    return { text, sourceMessageIds: ids, timestamp: 1 };
}

function cardContext({
    chid = 0,
    avatar = 'alice.png',
    name = 'Alice',
    store,
    chat = [],
    groupId,
    extra = {},
} = {}) {
    const characters = [];
    characters[chid] = { name, avatar, data: {} };
    return installSummaryContext({
        chat,
        metadata: { summaryception: store || makeSummaryStore() },
        characters,
        characterId: chid,
        groupId,
        name2: name,
        ...extra,
    });
}

describe('Memory Bank identity', () => {
    it('keys a solo card by avatar filename and a group by group id', () => {
        cardContext({ avatar: 'chars/alice.png' });
        expect(resolveActiveBankIdentity(ON).key).toBe('character:file:alice.png');

        cardContext({ groupId: 'g1', extra: { groups: [{ id: 'g1', name: 'Party' }] } });
        const group = resolveActiveBankIdentity(ON);
        expect(group.key).toBe('group:g1');
        expect(group.label).toBe('Group: Party');
    });

    it('prefers a stable card id over the avatar', () => {
        const ctx = cardContext();
        ctx.characters[0].data.extensions = { sillytavern: { id: 'uuid-1' } };
        expect(resolveActiveBankIdentity(ON).key).toBe('character:stable:uuid-1');
    });

    it('uses the shared bank when the feature is off', () => {
        cardContext();
        expect(resolveActiveBankIdentity({ memoryBanksEnabled: false }).key).toBe('chat');
    });
});

describe('Memory Bank reconcile', () => {
    it('writes nothing for a chat with no memory yet', () => {
        const ctx = cardContext();
        expect(reconcileActiveBank(ON).status).toBe('unchanged');
        expect(ctx.chatMetadata[BANK_REGISTRY_KEY]).toBeUndefined();
    });

    it('adopts an existing single-bank store for the active card on first contact', () => {
        const store = makeSummaryStore({ layers: [[snippet(['m0'])]] });
        const ctx = cardContext({ store });
        const result = reconcileActiveBank(ON);
        expect(result.status).toBe('adopted');
        expect(ctx.chatMetadata[BANK_REGISTRY_KEY].activeKey).toBe('character:file:alice.png');
        expect(getChatStore()).toBe(store);
        expect(
            ctx.chatMetadata[BANK_REGISTRY_KEY].identities['character:file:alice.png'].origin,
        ).toBe('migrated-from-shared');
    });

    it('parks the outgoing bank and transfers ghosting ownership on a card switch', () => {
        const store = makeSummaryStore({ layers: [[snippet(['m0'])]], ghostedMessageIds: ['m0'] });
        const ctx = cardContext({ store });
        reconcileActiveBank(ON);

        // The chat now belongs to another card.
        ctx.characters[0] = { name: 'Bob', avatar: 'bob.png', data: {} };
        const result = reconcileActiveBank(ON);
        expect(result).toMatchObject({ status: 'switched', fromKey: 'character:file:alice.png' });

        const live = getChatStore();
        expect(live).not.toBe(store);
        expect(live.layers).toEqual([]);
        expect(live.ghostedMessageIds).toEqual(['m0']);
        expect(store.ghostedMessageIds).toEqual([]);
        expect(ctx.chatMetadata[BANK_REGISTRY_KEY].banks['character:file:alice.png']).toBe(store);
        expect(live.mutationEpoch).toBe(store.mutationEpoch);
        expect(live.mutationEpoch).toBeGreaterThan(0);

        // Switching back restores the parked bank.
        ctx.characters[0] = { name: 'Alice', avatar: 'alice.png', data: {} };
        reconcileActiveBank(ON);
        expect(getChatStore()).toBe(store);
        expect(store.ghostedMessageIds).toEqual(['m0']);
    });

    it('defers a switch while the summarizer is busy', () => {
        const ctx = cardContext({ store: makeSummaryStore({ layers: [[snippet(['m0'])]] }) });
        reconcileActiveBank(ON);
        ctx.characters[0] = { name: 'Bob', avatar: 'bob.png', data: {} };
        expect(reconcileActiveBank(ON, { busy: true }).status).toBe('deferred');
        expect(ctx.chatMetadata[BANK_REGISTRY_KEY].activeKey).toBe('character:file:alice.png');
    });

    it('promotes a session-scoped bank instead of switching when the card gains an avatar', () => {
        const ctx = cardContext({
            avatar: '',
            store: makeSummaryStore({ layers: [[snippet(['m0'])]] }),
        });
        reconcileActiveBank(ON);
        expect(ctx.chatMetadata[BANK_REGISTRY_KEY].activeKey).toBe('character:session:0');
        ctx.characters[0].avatar = 'alice.png';
        const result = reconcileActiveBank(ON);
        expect(result.status).toBe('adopted');
        const registry = ctx.chatMetadata[BANK_REGISTRY_KEY];
        expect(registry.activeKey).toBe('character:file:alice.png');
        expect(registry.identities['character:file:alice.png'].formerKeys).toContain(
            'character:session:0',
        );
    });

    it('freezes the live bank when the feature is turned off', () => {
        const ctx = cardContext({ store: makeSummaryStore({ layers: [[snippet(['m0'])]] }) });
        reconcileActiveBank(ON);
        ctx.characters[0] = { name: 'Bob', avatar: 'bob.png', data: {} };
        expect(reconcileActiveBank({ memoryBanksEnabled: false }).status).toBe('unchanged');
        expect(getChatStore().layers[0]).toHaveLength(1);
    });

    it('re-ghosts the chat for the incoming bank through syncGhosting', async () => {
        const chat = [
            makeMessage({ scId: 'm0', isUser: true }),
            makeMessage({ scId: 'm1' }),
            makeMessage({ scId: 'm2', isUser: true }),
            makeMessage({ scId: 'm3' }),
        ];
        const calls = [];
        const store = makeSummaryStore({ layers: [[snippet(['m0', 'm1'])]] });
        const ctx = cardContext({
            chat,
            store,
            extra: {
                executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
            },
        });
        const { gate } = makeForegroundGate();
        reconcileActiveBank(ON);
        await syncGhosting({ gate });
        expect(getChatStore().ghostedMessageIds.sort()).toEqual(['m0', 'm1']);

        ctx.characters[0] = { name: 'Bob', avatar: 'bob.png', data: {} };
        reconcileActiveBank(ON);
        calls.length = 0;
        await syncGhosting({ gate });
        expect(getChatStore().ghostedMessageIds).toEqual([]);
        expect(calls.some((command) => command.startsWith('/unhide'))).toBe(true);
    });
});

describe('Memory Bank actions', () => {
    function twoBanks() {
        const alice = makeSummaryStore({ layers: [[snippet(['m0'], 'Alice memory')]] });
        const ctx = cardContext({ store: alice });
        reconcileActiveBank(ON);
        ctx.characters[0] = { name: 'Bob', avatar: 'bob.png', data: {} };
        reconcileActiveBank(ON);
        return { ctx, alice };
    }

    it('lists the live bank first, then parked banks', () => {
        twoBanks();
        const banks = listBanks();
        expect(banks.map((bank) => [bank.key, bank.active, bank.snippets])).toEqual([
            ['character:file:bob.png', true, 0],
            ['character:file:alice.png', false, 1],
        ]);
        expect(parkedBanksHoldSnippets()).toBe(true);
    });

    it('copies or moves a parked bank into the live one', () => {
        const { ctx } = twoBanks();
        expect(adoptBankIntoActive('character:file:alice.png')).toBe(true);
        expect(getChatStore().layers[0][0].text).toBe('Alice memory');
        expect(ctx.chatMetadata[BANK_REGISTRY_KEY].banks['character:file:alice.png']).toBeDefined();

        expect(adoptBankIntoActive('character:file:alice.png', { move: true })).toBe(true);
        expect(
            ctx.chatMetadata[BANK_REGISTRY_KEY].banks['character:file:alice.png'],
        ).toBeUndefined();
    });

    it('deletes parked banks but never the live one', () => {
        twoBanks();
        expect(deleteParkedBank('character:file:bob.png')).toBe(false);
        expect(deleteParkedBank('character:file:alice.png')).toBe(true);
        expect(parkedBanksHoldSnippets()).toBe(false);
    });
});
