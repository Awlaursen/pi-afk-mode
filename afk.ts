import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// /afk toggles AFK mode. While on, every time the agent settles we nudge it to keep
// working. It only gets left alone after calling `afk_blocked` with a concrete list
// of human decisions it is waiting on. Any typed input from the human resets that.

const MAX_NUDGES = 25; // ponytail: hard cap per /afk on; runaway-cost guard, raise if real sessions hit it

const NUDGE = `The user is AFK. Continue productive work autonomously: finish open tasks, verify with tests/builds, review your own diff, tidy up, then pick up the next unblocked item.

Only when EVERY remaining item genuinely requires a human decision, call the \`afk_blocked\` tool listing each blocker and the exact decision needed. Do not stop or ask questions otherwise — no one is reading.`;

// pi-subagents (optional) writes <tmp>/async-subagent-runs/<id>/status.json for every async run;
// its own hasOutstandingWork() reads the same files. sessionId there is the session file path.
// Mirrors pi-subagents' resolveTempScopeId(): uid, then $USER-style names.
function tempScopeId(): string {
	if (process.getuid) return `uid-${process.getuid()}`;
	const user = process.env.USERNAME || process.env.USER || process.env.LOGNAME;
	return user ? `user-${user.replace(/[^A-Za-z0-9._-]/g, "_")}` : "shared";
}
export const ASYNC_RUNS_DIR = path.join(
	process.env.PI_SUBAGENTS_TEMP_ROOT?.trim() || path.join(os.tmpdir(), `pi-subagents-${tempScopeId()}`),
	"async-subagent-runs",
);

export function subagentsRunning(sessionId: string | undefined, dir = ASYNC_RUNS_DIR): boolean {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return false;
	}
	return entries.some((d) => {
		try {
			const s = JSON.parse(readFileSync(path.join(dir, d, "status.json"), "utf8"));
			return s.sessionId === sessionId && (s.state === "queued" || s.state === "running");
		} catch {
			return false;
		}
	});
}

export default function (pi: ExtensionAPI) {
	let on = false;
	let blocked = false;
	let nudges = 0;
	let lastStop: string | undefined;
	let lastCtx: ExtensionContext | undefined;

	const save = () => pi.appendEntry("afk", { on, blocked });
	const status = (ctx: ExtensionContext) => {
		let text: string | undefined;
		if (on) text = blocked ? "afk: blocked on you" : `afk ${nudges}/${MAX_NUDGES}`;
		ctx.ui.setStatus("afk", text);
	};
	const sessionId = (ctx: ExtensionContext) =>
		ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();

	// The one place a nudge is decided. `force` skips the stop-reason check (used by `/afk on`).
	const maybeNudge = (ctx: ExtensionContext, force = false) => {
		status(ctx);
		if (!on || blocked || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (!force && lastStop !== "stop") return; // aborted → human is at the keyboard; error → don't loop on failures
		if (subagentsRunning(sessionId(ctx))) return; // async children still working; their completion wakes the session
		if (nudges >= MAX_NUDGES) {
			ctx.ui.notify(`AFK: nudge cap (${MAX_NUDGES}) reached, toggle /afk to reset`, "warning");
			return;
		}
		nudges++;
		status(ctx);
		pi.sendMessage({ customType: "afk-nudge", content: NUDGE, display: true }, { triggerTurn: true });
	};

	pi.on("session_start", (_e, ctx) => {
		on = blocked = false; // /new or /resume: don't leak state from the previous session
		nudges = 0;
		lastStop = undefined;
		lastCtx = ctx;
		for (const e of ctx.sessionManager.getEntries()) {
			if (e.type === "custom" && e.customType === "afk") {
				const state = e.data as { on: boolean; blocked: boolean };
				on = state.on;
				blocked = state.blocked;
			}
		}
		status(ctx);
	});

	pi.registerCommand("afk", {
		description: "Toggle AFK mode: agent keeps working until all work is blocked on you (/afk [on|off])",
		getArgumentCompletions: (p) => {
			const items = ["on", "off"].filter((v) => v.startsWith(p)).map((v) => ({ value: v, label: v }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on") on = true;
			else if (arg === "off") on = false;
			else on = !on;
			blocked = false;
			nudges = 0;
			lastCtx = ctx;
			save();
			status(ctx);
			ctx.ui.notify(`AFK mode ${on ? "on" : "off"}`, "info");
			if (on) maybeNudge(ctx, true); // idle when switched on → start working now, don't wait for a prompt
		},
	});

	// Human typed something → they're back or just unblocked us. Nudging resumes after this turn.
	pi.on("input", (event) => {
		if (event.source !== "interactive" || !on) return;
		blocked = false;
		nudges = 0;
		save();
	});

	pi.on("agent_end", (event) => {
		const last = event.messages.findLast((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		lastStop = last?.stopReason;
	});

	pi.on("agent_settled", (_e, ctx) => {
		lastCtx = ctx;
		maybeNudge(ctx);
	});

	// A settle skipped because children were running: pi-subagents normally wakes the session with a
	// turn on completion, but if it is configured not to, re-check ourselves once results have landed.
	pi.events.on("subagent:async-complete", () => {
		if (lastCtx) setTimeout(() => lastCtx && maybeNudge(lastCtx), 1000);
	});

	pi.registerTool({
		name: "afk_blocked",
		label: "AFK blocked",
		description:
			"AFK mode only. Declare that ALL remaining work is blocked on human decisions. Call only after re-checking the todo list and confirming nothing else productive (tests, review, cleanup, next task) remains. Each entry names the blocked work and the exact decision the human must make.",
		parameters: Type.Object({
			blockers: Type.Array(
				Type.Object({
					work: Type.String({ description: "What is blocked" }),
					decision: Type.String({ description: "The human decision needed to unblock it" }),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_id, { blockers }, _signal, _update, ctx) {
			if (!on) return { content: [{ type: "text", text: "AFK mode is off; nothing to do." }], details: {} };
			if (blockers.length === 0) return { content: [{ type: "text", text: "Rejected: list at least one blocker." }], details: {} };
			blocked = true;
			save();
			status(ctx);
			const list = blockers.map((b) => `- ${b.work} → needs: ${b.decision}`).join("\n");
			return {
				content: [{ type: "text", text: `Acknowledged. AFK nudges paused until the user returns.\n${list}` }],
				details: { blockers },
			};
		},
	});
}
