/**
 * Lorebook Ingestion prompts (fact extraction ported from Romuromylus's fork).
 *
 * Romuromylus asked the Layer 0 summarizer to append NEW:/UPDATE: tags to its
 * snippet. Here the summarizer contract stays untouched (its <narrative>
 * envelope is validated and injected verbatim), and a separate Lore Scout
 * call reads the same Passage after the Snippet commits. The scout emits the
 * same tag grammar, so the parser and the entry writers carry over intact.
 *
 * Scout placeholders: {{player_name}}, {{story_txt}} (passage + new snippet),
 * {{context_str}} (index of entries already in the target lorebook).
 * Entry placeholders: {{player_name}}, {{entity_name}}, {{entity_type}},
 * {{gloss}}, {{source_passage}}, {{source_snippet}}, {{change_reason}},
 * {{existing_entry}}.
 */

export const DEFAULT_LOREBOOK_SYSTEM_PROMPT =
    'You are a precise lorebook archivist for an ongoing interactive story. You extract canonical, durable facts from story passages and write dense, specific World Info entries. You never invent details the source does not state or strongly imply. You output exactly the requested format with no preamble, commentary, or markdown wrappers.';

export const DEFAULT_LOREBOOK_SCOUT_PROMPT = `<player_name>{{player_name}}</player_name>
<existing_lorebook_entries>
{{context_str}}
</existing_lorebook_entries>
<story_passage>
{{story_txt}}
</story_passage>

Identify durable entities in <story_passage> that deserve a lorebook entry, and existing entries that the passage canonically changes.

Entity types:
- char: a named character other than {{player_name}} with a lasting role
- loc: a named place the story returns to or that carries meaning
- faction: a named group, house, guild, cult, nation, crew
- item: a named or unique object with narrative weight
- lore: a named rule of the world, custom, spell, technology, or historical event

Emit one tag per line, using exactly this grammar:
NEW: <type>: <Canonical Name> — <one-phrase gloss>
UPDATE: <type>: <Name exactly as listed in existing entries> — <what canonically changed>

Rules:
- NEW only for entities that are absent from <existing_lorebook_entries>. If an entity is listed there, use UPDATE, and only when the passage changes something durable (status, allegiance, injury, death, title, ownership, revealed secret).
- Skip passing mentions, unnamed extras, generic objects, moods, and one-scene details.
- Never tag {{player_name}}.
- Use the most complete proper name as Canonical Name. No articles, no quotes.
- At most {{max_tags}} tags, most important first.
- If nothing qualifies, output exactly: NONE`;

export const DEFAULT_LOREBOOK_ENTRY_PROMPTS = Object.freeze({
    char: `<player_name>{{player_name}}</player_name>
<character_name>{{entity_name}}</character_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_passage}}</source_passage>
<summary>{{source_snippet}}</summary>

Write a compact character profile for a story lorebook. It is injected when the character is mentioned, so establish identity without bloat.

Capture, in order, using only what the source states or strongly implies:
- Physical baseline: build, hair, distinctive features, scars, handedness
- Speech register and verbal tics: how they sound, recurring phrases, accent cues, formality
- Dialogue color (preserve any hex code verbatim)
- Role, faction, affiliation
- Baseline relationship to {{player_name}} and to other named characters
- Known skills, capabilities, defining traits
- Sworn oaths, debts, secrets they carry

Rules:
- Do NOT invent backstory or appearance absent from the source.
- Short declarative phrases. Aim for 60-120 words.
- Output the profile body ONLY.`,
    loc: `<player_name>{{player_name}}</player_name>
<location_name>{{entity_name}}</location_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_passage}}</source_passage>
<summary>{{source_snippet}}</summary>

Write a compact location profile for a story lorebook.

Capture, in order, using only what the source states or strongly implies:
- Type: city, tavern, forest, ruin, stronghold, ship, etc.
- Distinctive physical features: layout, landmarks, sensory anchors (sound, smell, light)
- Faction control, ownership, inhabitants
- Reputation or common knowledge
- Dangers, secrets, hidden aspects
- Narrative significance: what happened here and what it means to characters

Rules:
- Do NOT invent geography or history absent from the source.
- Short declarative phrases. Aim for 50-100 words.
- Output the profile body ONLY.`,
    faction: `<player_name>{{player_name}}</player_name>
<faction_name>{{entity_name}}</faction_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_passage}}</source_passage>
<summary>{{source_snippet}}</summary>

Write a compact faction profile for a story lorebook.

Capture, in order, using only what the source states or strongly implies:
- Type: guild, house, cult, military unit, criminal ring, nation, crew, etc.
- Leadership or notable members
- Goals, ideology, guiding principles
- Methods and reputation: public face versus private reality
- Allies and enemies, especially relative to {{player_name}}
- Distinguishing marks: sigil, colors, oaths, rituals
- Current activity or narrative role

Rules:
- Do NOT invent hierarchy or history absent from the source.
- Short declarative phrases. Aim for 50-100 words.
- Output the profile body ONLY.`,
    item: `<player_name>{{player_name}}</player_name>
<item_name>{{entity_name}}</item_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_passage}}</source_passage>
<summary>{{source_snippet}}</summary>

Write a compact item profile for a story lorebook.

Capture, in order, using only what the source states or strongly implies:
- Type: weapon, artifact, tool, document, vehicle, etc.
- Physical description: appearance, material, distinctive marks
- Powers, properties, effects
- Origin or provenance
- Current owner or wielder and how they got it
- Known curses, costs, restrictions
- Narrative significance or plot hooks

Rules:
- Do NOT invent powers or history absent from the source.
- Short declarative phrases. Aim for 40-90 words.
- Output the profile body ONLY.`,
    lore: `<player_name>{{player_name}}</player_name>
<lore_name>{{entity_name}}</lore_name>
<gloss>{{gloss}}</gloss>
<source_passage>{{source_passage}}</source_passage>
<summary>{{source_snippet}}</summary>

Write a compact world-lore entry for a story lorebook: a rule, custom, spell, technology, or historical event.

Capture, in order, using only what the source states or strongly implies:
- What it is, in one sentence
- How it works: rules, costs, limits, exceptions
- Who knows of it, controls it, or is bound by it
- Observable signs when it is in effect
- Narrative consequences established so far

Rules:
- Do NOT extrapolate mechanics absent from the source.
- Short declarative phrases. Aim for 40-100 words.
- Output the entry body ONLY.`,
    update: `<player_name>{{player_name}}</player_name>
<entity_name>{{entity_name}}</entity_name>
<entity_type>{{entity_type}}</entity_type>
<change_reason>{{change_reason}}</change_reason>
<source_passage>{{source_passage}}</source_passage>
<summary>{{source_snippet}}</summary>

<existing_entry>
{{existing_entry}}
</existing_entry>

The existing lorebook entry for {{entity_name}} is now outdated. The source records a canonical change: {{change_reason}}.

Produce a revised entry that:
- Preserves every load-bearing fact from <existing_entry> that the change does not contradict.
- Integrates the change cleanly: rewrite the affected sentences as if they were always true, never append "UPDATE:".
- Adds no detail absent from the source or the existing entry.
- Keeps the existing structure, length, and tone.

Output the revised entry body ONLY. No diff markers.`,
});

export const LOREBOOK_ENTITY_TYPES = Object.freeze(['char', 'loc', 'faction', 'item', 'lore']);

export const LOREBOOK_ENTITY_LABELS = Object.freeze({
    char: 'Character',
    loc: 'Location',
    faction: 'Faction',
    item: 'Item',
    lore: 'Lore',
});
