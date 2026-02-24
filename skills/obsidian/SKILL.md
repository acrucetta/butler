# Obsidian Notes

## Purpose
Use this skill to create, read, search, and organize markdown notes in the Obsidian vault.

## Capabilities
- **Read/Write**: read-note, create-note, edit-note, delete-note, move-note
- **Search**: search-vault for keyword search across all notes
- **Organization**: add-tags, remove-tags, rename-tag, manage-tags
- **Structure**: create-directory, list-available-vaults

## Constraints
- Always confirm before deleting notes.
- Use descriptive filenames with kebab-case (e.g. `meeting-notes-2026-02-24.md`).
- Preserve existing YAML frontmatter when editing notes.

## Setup
- Set `OBSIDIAN_VAULT_PATH` to the absolute path of your vault directory.
- Enable: `npm run butler -- skills enable obsidian`
