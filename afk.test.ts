import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import afk, { subagentsRunning } from "./afk.ts";

// Minimal fake of the pi ExtensionAPI/ExtensionContext surface afk.ts touches.
function harness(opts: { running?: () => boolean } = {}) {
	const handlers: Record<string, Function[]> = {};
	const bus: Record<string, Function[]> = {};
	const sent: unknown[] = [];
	const entries: { type: string; customType: string; data: unknown }[] = [];
	let command: any;
	let tool: any;
	let idle = true;
	const pi = {
		on: (ev: string, h: Function) => (handlers[ev] ??= []).push(h),
		events: { on: (ev: string, h: Function) => (bus[ev] ??= []).push(h) },
		registerCommand: (_n: string, c: unknown) => (command = c),
		registerTool: (t: unknown) => (tool = t),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (m: unknown, o: unknown) => sent.push({ m, o }),
	};
	const ctx = {
		isIdle: () => idle,
		hasPendingMessages: () => false,
		ui: { setStatus() {}, notify() {} },
		sessionManager: { getEntries: () => entries, getSessionFile: () => "/s/me.jsonl", getSessionId: () => "id" },
	};
	afk(pi as any);
	const fire = (ev: string, e: unknown = {}) => handlers[ev]?.forEach((h) => h(e, ctx));
	const stop = (stopReason: string) => fire("agent_end", { messages: [{ role: "assistant", stopReason }] });
	return {
		sent, entries, ctx, fire, stop, bus,
		setIdle: (v: boolean) => (idle = v),
		cmd: (args = "") => command.handler(args, ctx),
		tool: (blockers: unknown[]) => tool.execute("1", { blockers }, undefined, undefined, ctx),
	};
}

test("off by default: settling does nothing", () => {
	const h = harness();
	h.fire("session_start");
	h.stop("stop");
	h.fire("agent_settled");
	assert.equal(h.sent.length, 0);
});

test("/afk on while idle nudges immediately, then on every clean stop", () => {
	const h = harness();
	h.fire("session_start");
	h.cmd("on");
	assert.equal(h.sent.length, 1);
	h.stop("stop");
	h.fire("agent_settled");
	assert.equal(h.sent.length, 2);
	assert.deepEqual((h.sent[1] as any).o, { triggerTurn: true });
});

test("no nudge after abort or error, nor while busy", () => {
	const h = harness();
	h.fire("session_start");
	h.cmd("on");
	for (const r of ["aborted", "error"]) {
		h.stop(r);
		h.fire("agent_settled");
	}
	h.setIdle(false);
	h.stop("stop");
	h.fire("agent_settled");
	assert.equal(h.sent.length, 1); // only the /afk on nudge
});

test("afk_blocked pauses nudges; interactive input resumes them", async () => {
	const h = harness();
	h.fire("session_start");
	h.cmd("on");
	await h.tool([{ work: "deploy", decision: "approve prod" }]);
	h.stop("stop");
	h.fire("agent_settled");
	assert.equal(h.sent.length, 1);
	h.fire("input", { source: "extension" });
	h.fire("agent_settled");
	assert.equal(h.sent.length, 1); // non-interactive input does not unblock
	h.fire("input", { source: "interactive" });
	h.fire("agent_settled");
	assert.equal(h.sent.length, 2);
});

test("state persists via session entries and resets on /new", () => {
	const h = harness();
	h.fire("session_start");
	h.cmd("on");
	h.entries.length = 0; // simulate /new: fresh session has no entries
	h.fire("session_start");
	h.stop("stop");
	h.fire("agent_settled");
	assert.equal(h.sent.length, 1); // only the original /afk on nudge
	h.entries.push({ type: "custom", customType: "afk", data: { on: true, blocked: false } });
	h.fire("session_start");
	h.stop("stop");
	h.fire("agent_settled");
	assert.equal(h.sent.length, 2);
});

test("nudge cap stops the loop", () => {
	const h = harness();
	h.fire("session_start");
	h.cmd("on");
	for (let i = 0; i < 40; i++) {
		h.stop("stop");
		h.fire("agent_settled");
	}
	assert.equal(h.sent.length, 25);
});

test("subagentsRunning reads pi-subagents status files for this session only", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "afk-test-"));
	const write = (id: string, s: object) => {
		mkdirSync(path.join(dir, id), { recursive: true });
		writeFileSync(path.join(dir, id, "status.json"), JSON.stringify(s));
	};
	try {
		assert.equal(subagentsRunning("/s/me.jsonl", dir), false);
		write("a", { sessionId: "/s/other.jsonl", state: "running" });
		assert.equal(subagentsRunning("/s/me.jsonl", dir), false);
		write("b", { sessionId: "/s/me.jsonl", state: "queued" });
		assert.equal(subagentsRunning("/s/me.jsonl", dir), true);
		write("b", { sessionId: "/s/me.jsonl", state: "complete" });
		assert.equal(subagentsRunning("/s/me.jsonl", dir), false);
		writeFileSync(path.join(dir, "a", "status.json"), "not json");
		assert.equal(subagentsRunning("/s/me.jsonl", dir), false);
		assert.equal(subagentsRunning("/s/me.jsonl", path.join(dir, "missing")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
