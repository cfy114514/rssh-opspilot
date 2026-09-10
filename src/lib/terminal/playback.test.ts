import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayback, type CastEvent } from "./playback.ts";

function clock() {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("setTimeout", (callback: () => void, delay: number) => {
        timers.set(++id, { at: now + Math.max(4, delay), callback });
        return id;
    });
    vi.stubGlobal("clearTimeout", (handle: number) => timers.delete(handle));
    return {
        now: () => now,
        next() {
            const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!entry) return false;
            timers.delete(entry[0]);
            now = entry[1].at;
            entry[1].callback();
            return true;
        },
        advance(ms: number) { now += ms; },
        pending: () => timers.size,
    };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("recording playback", () => {
    it("plays dense 8x output on its timeline despite clamped timers, without changing bytes", () => {
        const c = clock();
        const events: CastEvent[] = Array.from({ length: 2000 }, (_, i) => [(i + 1) / 1000, "o", `${i}\x1b[0m\r\n`]);
        const output: string[] = [];
        const update = vi.fn();
        const playback = createPlayback(events, {
            write: (data, parsed) => { output.push(data); parsed(); }, reset: () => {}, update,
        });
        playback.play(8);
        let wakeups = 0;
        while (c.next()) { if (++wakeups > 10000) throw new Error("playback stalled"); }
        expect(output.join("")).toBe(events.map((event) => event[2]).join(""));
        expect(c.now()).toBeLessThanOrEqual(254);
        expect(wakeups).toBeLessThan(70);
        expect(update).toHaveBeenLastCalledWith(2000, 2, false);
    });

    it("preserves partial gaps across pause/resume and speed changes", () => {
        const c = clock();
        const output: string[] = [];
        const playback = createPlayback([[1, "o", "first"], [2, "o", "second"]], {
            write: (data, parsed) => { output.push(data); parsed(); }, reset: () => {}, update: () => {},
        });
        playback.play(1);
        c.advance(400);
        playback.pause();
        expect(c.pending()).toBe(0);
        c.advance(5000);
        playback.play(1);
        c.advance(200);
        playback.play(2);
        c.next();
        expect(c.now()).toBe(5800);
        expect(output).toEqual(["first"]);
        c.next();
        expect(c.now()).toBe(6300);
        expect(output).toEqual(["first", "second"]);
    });

    it("yields bounded batches and waits for parsing; stop/restart/dispose cannot leak old output", () => {
        const c = clock();
        const events: CastEvent[] = Array.from({ length: 2000 }, () => [0, "o", "x".repeat(1024)]);
        let parsed = () => {};
        const screen: string[] = [];
        const writes: string[] = [];
        const playback = createPlayback(events, {
            write: (data, done) => { writes.push(data); parsed = () => { screen.push(data); done(); }; },
            reset: () => { screen.length = 0; }, update: () => {},
        });
        playback.play(1);
        c.next();
        expect(writes).toHaveLength(1);
        expect(writes[0].length).toBeLessThanOrEqual(64 * 1024);
        expect(c.pending()).toBe(0); // xterm owns the only batch in flight
        playback.stop();
        playback.play(1);
        parsed();
        expect(screen).toEqual([]); // reset follows the old parse callback
        while (c.next()) parsed();
        expect(screen.join("")).toBe("x".repeat(2000 * 1024));
        expect(writes.length).toBeGreaterThan(1);

        playback.play(1);
        c.next();
        playback.dispose();
        parsed();
        expect(c.pending()).toBe(0);
        const count = writes.length;
        playback.play(1);
        expect(writes).toHaveLength(count);
    });

    it("resumes a paused final parse without replaying it", () => {
        const c = clock();
        let parsed = () => {};
        const write = vi.fn((_data: string, done: () => void) => { parsed = done; });
        const reset = vi.fn();
        const update = vi.fn();
        const playback = createPlayback([[0, "o", "last"]], { write, reset, update });
        playback.play(1);
        c.next();
        playback.pause();
        playback.play(8);
        parsed();
        while (c.next()) parsed();
        expect(write).toHaveBeenCalledTimes(1);
        expect(reset).not.toHaveBeenCalled();
        expect(update).toHaveBeenLastCalledWith(1, 0, false);
    });

    it("yields even for thousands of due events with empty payloads", () => {
        const c = clock();
        const events: CastEvent[] = Array.from({ length: 2000 }, () => [0, "o", ""]);
        const update = vi.fn();
        const playback = createPlayback(events, {
            write: (_data, parsed) => parsed(), reset: () => {}, update,
        });
        playback.play(1);
        c.next();
        expect(update.mock.lastCall![0]).toBeLessThan(2000);
        expect(c.pending()).toBe(1);
        while (c.next()) {}
        expect(update).toHaveBeenLastCalledWith(2000, 0, false);
    });
});
