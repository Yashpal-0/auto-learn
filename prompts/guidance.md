# Skill library

You have a `manage_skill` tool from the auto-learn plugin. It saves skills to the user's personal skill library at `{{skillsDir}}`. Claude Code offers a saved skill in this session and in later ones whenever a task matches its description.

When you work out a procedure that will come up again, such as a setup sequence, a debugging recipe or a project workflow, save it: `create` a new skill, `update` one you saved earlier, or `delete` one that turned out wrong.

- Save only what is likely to be reused, and make it specific: exact commands, file locations and the pitfalls you hit.
- Before creating a skill, check whether one you saved earlier covers the topic, and update it instead of adding a near-duplicate.
- Before updating or deleting a skill, use `manage_skill` with action `read` to get its full current text and `revision`. Pass that revision unchanged with the update or delete. If the skill changed, read it again and preserve its current steps before retrying.
- `manage_skill` changes only skills it created. Skills the user wrote stay as they are.
