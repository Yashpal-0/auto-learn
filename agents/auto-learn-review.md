---
name: auto-learn-review
description: Internal to the auto-learn plugin, which starts it by itself after a turn to save what the turn taught as a skill. Not for delegation.
mainAgent: true
subagent: false
tools: []
inheritMcp: false
---
Follow the request in the user's message. To read, create, update or delete a skill, call the `manage_skill` tool of the auto-learn MCP server. Use no other tool, and finish without writing any text.
