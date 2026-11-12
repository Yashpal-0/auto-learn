Create, update or delete a skill in the user's personal skill library at `{{skillsDir}}`. Each skill is `<name>/SKILL.md`. Claude Code offers saved skills in this session and in later ones whenever a task matches their description.

Use it to keep procedures that will be needed again: setup sequences, debugging recipes, project workflows.

- `create` adds a skill. It fails if any skill already uses the name.
- `update` replaces the description and body of a skill this tool created.
- `delete` removes a skill this tool created.

The tool never changes a skill it did not create, and it refuses skills that contain credentials or tokens.
