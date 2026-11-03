# TeamMarker

Marks work the team (the agents) drafted, before a person has checked it.

- Consumer provides: `span.ds-ai` (dot + "Drafted by the team" or "Team") in a card header, or a `div.ds-aiblock` around a draft with its actions.
- Neutral by design: `surface-subtle`, `line` and a slate dot. Once the lead checks it, show a copper `PersonChip` instead.
- Never say "AI" to clients; the team works under role names ("Pia, Purchasing").
