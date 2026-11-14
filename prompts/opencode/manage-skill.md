Create, update or delete a skill in the user's OpenCode skill library at `{{skillsDir}}`. Each skill is `<name>/SKILL.md`. OpenCode offers saved skills whenever a task matches their descriptions, and refreshes the skill list after a successful change.

Use it for reusable setup sequences, debugging recipes and project workflows.

- `create` adds a skill, unless any discovered skill already uses the name.
- `update` replaces the description and body of a skill this plugin created.
- `delete` removes a skill this plugin created.

The tool never changes a skill it did not create, never replaces a symbolic link, and refuses skills that contain detected credentials or tokens.
