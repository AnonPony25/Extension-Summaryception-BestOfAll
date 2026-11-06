import { describe, expect, it, vi } from 'vitest';

import {
    approveProposal,
    cleanEntryBody,
    createLorebookIngestor,
    parseLoreTags,
} from '../src/core/lorebook-ingest.js';
import { findProposal, listProposals, LORE_STATE_KEY } from '../src/core/lorebook-queue.js';
import { findEntryByName, resolveLoreTarget, revertProposal } from '../src/core/lorebook-writer.js';
import { notifyLayer0Committed } from '../src/core/layer0-observers.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import { clearChatData } from '../src/core/chat-data.js';
import { getSettings } from '../src/foundation/settings.js';
import { installSummaryContext, makeSummaryStore } from './test-helpers.js';

/** In-memory World Info host. */
function makeWorldInfoHost(initial = {}) {
    const books = structuredClone(initial);
    return {
        books,
        loadWorldInfo: vi.fn(async (name) => (books[name] ? structuredClone(books[name]) : null)),
        saveWorldInfo: vi.fn(async (name, data) => {
            books[name] = structuredClone(data);
        }),
        getWorldInfoNames: () => Object.keys(books),
        updateWorldInfoList: vi.fn(async () => {}),
        reloadWorldInfoEditor: vi.fn(),
    };
}

function installLoreContext({ books = {}, settings = {}, metadata = {} } = {}) {
    const host = makeWorldInfoHost(books);
    const ctx = installSummaryContext({
        metadata: { summaryception: makeSummaryStore(), ...metadata },
        settings: { lorebookEnabled: true, ...settings },
        characters: [{ name: 'Alice', avatar: 'alice.png', data: { extensions: {} } }],
        characterId: 0,
        name2: 'Alice',
        getCurrentChatId: () => 'chat-1',
        ...host,
    });
    return { ctx, host };
}

const EVENT = {
    passageText: 'Player1: Who are you?\nAlice: I am Kael Varn, captain of the Gray Wake.',
    snippetText: 'Kael Varn, captain of the Gray Wake, introduced himself.',
    sourceMessageIds: ['m0', 'm1'],
    sourceRange: [0, 1],
};

/** Scripted dispatch: scout answer first, then entry bodies in order. */
function scriptedDispatch(scout, bodies = []) {
    const queue = [...bodies];
    const calls = [];
    const dispatch = vi.fn(async (request) => {
        calls.push(request);
        if (request.metadata.kind === 'lorebook-scout') {
            return { status: 'completed', text: scout };
        }
        return { status: 'completed', text: queue.shift() ?? 'Body.' };
    });
    return { dispatch, calls };
}

describe('Lore tag parsing', () => {
    it('reads NEW/UPDATE tags with dash variants and keeps hyphenated names whole', () => {
        const tags = parseLoreTags(
            [
                'NEW: char: Kael Varn — captain of the Gray Wake',
                '- UPDATE: loc: Port Ashen - burned in the raid',
                '**NEW**: faction: Jean-Luc Guild – smugglers',
                'NEW: character: Mira: a healer',
                'noise line',
                'NEW: char: Kael Varn — duplicate',
            ].join('\n'),
        );
        expect(tags).toEqual([
            {
                kind: 'create',
                entityType: 'char',
                name: 'Kael Varn',
                detail: 'captain of the Gray Wake',
            },
            { kind: 'update', entityType: 'loc', name: 'Port Ashen', detail: 'burned in the raid' },
            { kind: 'create', entityType: 'faction', name: 'Jean-Luc Guild', detail: 'smugglers' },
            { kind: 'create', entityType: 'char', name: 'Mira', detail: 'a healer' },
        ]);
    });

    it('returns nothing for NONE', () => {
        expect(parseLoreTags('NONE')).toEqual([]);
    });

    it('strips fences and labels from entry bodies', () => {
        expect(cleanEntryBody('```\nProfile: Tall, scarred.\n```')).toBe('Tall, scarred.');
    });
});

describe('Lore call profiles', () => {
    it('route scout and entry calls with no compression contract', () => {
        installLoreContext({ settings: { lorebookMaxTagsPerScan: 3 } });
        const scout = resolveCallProfile(getSettings(), {
            kind: 'lorebook-scout',
            sourceRange: [0, 1],
        });
        expect(scout.policy.compression).toBe(false);
        expect(scout.policy.sizeGuard).toBeNull();
        expect(scout.policy.userPromptTemplate).toContain('At most 3 tags');
        expect(scout.policy.userPromptTemplate).not.toContain('{{max_tags}}');
        const entry = resolveCallProfile(getSettings(), {
            kind: 'lorebook-entry',
            loreEntityName: 'Kael',
        });
        expect(entry.policy.userPromptTemplate).toBe('{{story_txt}}');
        expect(entry.policy.label).toBe('lore entry Kael');
    });
});

describe('Lore target resolution', () => {
    it('chat mode proposes a new chat lorebook when none is bound', () => {
        installLoreContext();
        const target = resolveLoreTarget(getSettings());
        expect(target.exists).toBe(false);
        expect(target.canCreate).toBe(true);
        expect(target.name).toMatch(/^Summaryception - Alice/);
    });

    it('character mode uses the card primary lorebook and never creates one', () => {
        const { ctx } = installLoreContext({ settings: { lorebookTargetMode: 'character' } });
        expect(resolveLoreTarget(getSettings()).name).toBe('');
        ctx.characters[0].data.extensions.world = 'Alice Book';
        expect(resolveLoreTarget(getSettings())).toMatchObject({
            name: 'Alice Book',
            canCreate: false,
        });
    });
});

describe('Lorebook ingestion', () => {
    it('stages review proposals and writes them on approval into a created, chat-bound book', async () => {
        const { ctx, host } = installLoreContext();
        const { dispatch, calls } = scriptedDispatch(
            'NEW: char: Kael Varn — captain of the Gray Wake',
            ['Tall, scarred captain. Speaks in clipped orders.'],
        );
        const ingestor = createLorebookIngestor({ dispatch });
        const summary = await ingestor.scan(EVENT);
        ingestor.dispose();

        expect(summary).toMatchObject({ status: 'completed', tags: 1, proposals: 1, written: 0 });
        expect(calls[0].contextStr).toBe('(none yet)');
        expect(calls[0].metadata.sourceTokensBefore).toBe(0);
        expect(calls[1].storyTxt).toContain('<character_name>Kael Varn</character_name>');
        expect(Object.keys(host.books)).toEqual([]);

        const [proposal] = listProposals('pending');
        const result = await approveProposal(proposal.id);
        expect(result).toMatchObject({ ok: true, action: 'created' });
        const bookName = ctx.chatMetadata.world_info;
        expect(bookName).toMatch(/^Summaryception - Alice/);
        const entry = Object.values(host.books[bookName].entries)[0];
        expect(entry).toMatchObject({
            key: ['Kael Varn'],
            comment: '[SC] char: Kael Varn',
            content: 'Tall, scarred captain. Speaks in clipped orders.',
            selective: true,
            position: 0,
            order: 100,
            depth: 4,
        });
        expect(findProposal(proposal.id).status).toBe('approved');
    });

    it('turns NEW into UPDATE when the book already has the entity, and reverts cleanly', async () => {
        const books = {
            Saga: {
                entries: {
                    0: {
                        uid: 0,
                        key: ['Kael Varn'],
                        comment: '[SC] char: Kael Varn',
                        content: 'Captain.',
                    },
                },
            },
        };
        const { host } = installLoreContext({
            books,
            settings: {
                lorebookTargetMode: 'named',
                lorebookTargetName: 'Saga',
                lorebookReviewMode: 'auto',
            },
        });
        const { dispatch, calls } = scriptedDispatch('NEW: char: Kael Varn — lost his left hand', [
            'Captain. Lost his left hand at Port Ashen.',
        ]);
        const ingestor = createLorebookIngestor({ dispatch });
        const summary = await ingestor.scan(EVENT);
        ingestor.dispose();

        expect(summary).toMatchObject({ proposals: 1, written: 1 });
        expect(calls[0].contextStr).toContain('char: Kael Varn — Captain.');
        expect(calls[1].storyTxt).toContain('<existing_entry>\nCaptain.\n</existing_entry>');
        expect(host.books.Saga.entries[0].content).toBe(
            'Captain. Lost his left hand at Port Ashen.',
        );

        const [approved] = listProposals('resolved');
        expect(approved).toMatchObject({
            kind: 'update',
            status: 'approved',
            contentBeforeCommit: 'Captain.',
        });
        expect(await revertProposal(getSettings(), approved)).toEqual({ ok: true });
        expect(host.books.Saga.entries[0].content).toBe('Captain.');
    });

    it('filters disabled types, the player, and updates when updates are off', async () => {
        installLoreContext({
            books: {
                Saga: {
                    entries: {
                        0: {
                            uid: 0,
                            key: ['Port Ashen'],
                            comment: 'loc: Port Ashen',
                            content: 'Port.',
                        },
                    },
                },
            },
            settings: {
                lorebookTargetMode: 'named',
                lorebookTargetName: 'Saga',
                lorebookTypes: ['char', 'loc'],
                lorebookAllowUpdates: false,
            },
        });
        const { dispatch } = scriptedDispatch(
            [
                'NEW: char: Player1 — the hero',
                'NEW: item: Gray Blade — a sword',
                'UPDATE: loc: Port Ashen — burned',
                'NEW: char: Mira — a healer',
            ].join('\n'),
        );
        const ingestor = createLorebookIngestor({ dispatch });
        const summary = await ingestor.scan(EVENT);
        ingestor.dispose();
        expect(summary.proposals).toBe(1);
        expect(listProposals('pending').map((item) => item.name)).toEqual(['Mira']);
    });

    it('does not duplicate a proposal that is already pending', async () => {
        installLoreContext();
        const { dispatch } = scriptedDispatch('NEW: char: Kael Varn — captain');
        const ingestor = createLorebookIngestor({ dispatch });
        await ingestor.scan(EVENT);
        await ingestor.scan(EVENT);
        ingestor.dispose();
        expect(listProposals('pending')).toHaveLength(1);
    });

    it('drops the scan when the chat changes mid-flight', async () => {
        const { ctx } = installLoreContext();
        const dispatch = vi.fn(async () => {
            ctx.getCurrentChatId = () => 'chat-2';
            return { status: 'completed', text: 'NEW: char: Kael Varn — captain' };
        });
        const ingestor = createLorebookIngestor({ dispatch });
        expect((await ingestor.scan(EVENT)).status).toBe('chat-changed');
        ingestor.dispose();
        expect(listProposals('all')).toHaveLength(0);
    });

    it('runs from a Layer 0 commit only when enabled', async () => {
        installLoreContext({ settings: { lorebookEnabled: false } });
        const { dispatch } = scriptedDispatch('NONE');
        const onScanSettled = vi.fn();
        const ingestor = createLorebookIngestor({ dispatch, onScanSettled });
        notifyLayer0Committed([EVENT]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(dispatch).not.toHaveBeenCalled();

        getSettings().lorebookEnabled = true;
        notifyLayer0Committed([EVENT]);
        await vi.waitFor(() => expect(onScanSettled).toHaveBeenCalledTimes(1));
        expect(onScanSettled.mock.calls[0][0]).toMatchObject({ status: 'completed', tags: 0 });
        ingestor.dispose();
    });

    it('Clear drops the review queue but leaves written lorebook entries alone', async () => {
        const { ctx, host } = installLoreContext({
            settings: {
                lorebookTargetMode: 'named',
                lorebookTargetName: 'Saga',
                lorebookReviewMode: 'auto',
            },
            books: { Saga: { entries: {} } },
        });
        const { dispatch } = scriptedDispatch('NEW: char: Kael Varn — captain');
        const ingestor = createLorebookIngestor({ dispatch });
        await ingestor.scan(EVENT);
        ingestor.dispose();
        expect(ctx.chatMetadata[LORE_STATE_KEY]).toBeDefined();
        await clearChatData();
        expect(ctx.chatMetadata[LORE_STATE_KEY]).toBeUndefined();
        expect(findEntryByName(host.books.Saga, 'Kael Varn')).not.toBeNull();
    });
});
