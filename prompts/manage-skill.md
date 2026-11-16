Read, create, update or delete a skill in the user's personal skill library at `{{skillsDir}}`. Each skill is `<name>/SKILL.md`. Claude Code offers saved skills in this session and in later ones whenever a task matches their description.

Use it to keep procedures that will be needed again: setup sequences, debugging recipes, project workflows.

- `create` adds a skill. It fails if any skill already uses the name.
- `read` returns JSON with the managed skill's complete `content` and its `revision`. A missing SKILL.md returns `content: null` and `revision: "missing"`.
- `update` replaces the description and body of a skill this tool created. Read it first, preserve its current steps, and pass its `revision` unchanged.
- `delete` removes a skill this tool created. Read it first and pass its `revision` unchanged.

An update or delete fails if another save or a user edit changed the skill since it was read. Read again before retrying; never discard the newer steps.

The tool never changes a skill it did not create, and it refuses skills that contain credentials or tokens.
