# Obsidian Notes

## Purpose
Use this skill to create, read, search, and organize markdown notes in the Obsidian vault.

## Capabilities
- **Read/Write**: read_note, write_note, delete_note, move_note, read_multiple_notes
- **Search**: search_notes for keyword search across all notes
- **Metadata**: get_frontmatter, update_frontmatter, get_notes_info
- **Organization**: manage_tags, list_directory

## Constraints
- Always confirm before deleting notes.
- Use descriptive filenames with kebab-case (e.g. `meeting-notes-2026-02-24.md`).
- Preserve existing YAML frontmatter when editing notes.

## Setup
- Set `OBSIDIAN_VAULT_PATH` to the absolute path of your vault directory.
- Enable: `npm run butler -- skills enable obsidian`
