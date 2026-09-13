# pi-afk-mode

A [Pi](https://pi.dev) extension for walking away. `/afk` keeps the agent working until every remaining item is genuinely blocked on a decision only you can make.

```bash
pi install npm:pi-afk-mode
```

## How it works

- `/afk` (or `/afk on|off`) toggles AFK mode. Switching it on while the agent is idle starts it working immediately.
- Every time the agent finishes a turn and settles, it gets a nudge: finish open tasks, verify with tests/builds, review the diff, tidy up, pick up the next unblocked item.
- The agent is only left alone after it calls the `afk_blocked` tool with a concrete list of `{ work, decision }` pairs. Nudging pauses; the status bar shows `afk: blocked on you`.
- Typing anything resets that: you're back, or you just answered. Nudging resumes after your turn.
- The mode is stored in the session, so `/resume` picks it up. `/new` starts clean.

## Guardrails

- **Nudge cap**: 25 nudges per `/afk on` (status bar shows `afk 7/25`). Toggle `/afk` to reset. Costs are bounded even if the agent never declares itself blocked.
- **Questions**: tools that ask the user something (`ask_user_question`, `question`, `questionnaire`, …) are blocked while AFK is on. The agent gets told to pick the sensible default and note the assumption, or to finish everything else and call `afk_blocked` if the decision is load-bearing. Without this, one question could stall an unattended session for hours.
- **Abort / error**: no nudge after an aborted turn (you pressed Escape, you're at the keyboard) or an errored turn (don't loop on failures).
- **Async subagents**: if [pi-subagents](https://www.npmjs.com/package/pi-subagents) has queued or running async children for this session, the agent is not nudged. Their completion wakes the session; the next settle nudges as usual. Detected by reading the same `status.json` files pi-subagents uses for its own outstanding-work check, so no dependency and no configuration. Without pi-subagents installed the check is a no-op.

## The nudge

> The user is AFK. Continue productive work autonomously: finish open tasks, verify with tests/builds, review your own diff, tidy up, then pick up the next unblocked item.
>
> Only when EVERY remaining item genuinely requires a human decision, call the `afk_blocked` tool listing each blocker and the exact decision needed. Do not stop or ask questions otherwise — no one is reading.

It is sent as a visible custom message (`customType: "afk-nudge"`), so it shows in the transcript and the model can see it is not you.

## Known limits

- A crashed subagent that leaves a stale `running` status behind suppresses nudges until pi-subagents reconciles it.
- If the model stops without calling `afk_blocked` and without making progress, you pay for up to 25 idle turns. Lower `MAX_NUDGES` in `afk.ts` if that bothers you.

## Development

```bash
npm install
npm run typecheck
npm test          # node --test, no framework
pi -e ./afk.ts    # try it in a session
```

MIT
