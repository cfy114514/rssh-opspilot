import { describe, expect, it, vi } from "vitest";
import { createMarkdownScheduler } from "./markdown-scheduler.ts";

function setup() {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    const render = vi.fn((text: string) => `<p>${text}</p>`);
    const committed: string[] = [];
    const scheduler = createMarkdownScheduler({
        render,
        commit: (html) => committed.push(html),
        requestFrame: (callback) => {
            frames.push(callback);
            return frames.length;
        },
        cancelFrame: (id) => cancelled.push(id),
    });
    return { scheduler, frames, cancelled, render, committed };
}

describe("markdown render scheduler", () => {
    it("coalesces many streaming updates into one render per frame", () => {
        const { scheduler, frames, render, committed } = setup();
        scheduler.update("seed", true, true);
        render.mockClear();

        for (let i = 1; i <= 100; i++) {
            scheduler.update(`chunk ${i}`, true, true);
        }

        expect(render).not.toHaveBeenCalled();
        expect(frames).toHaveLength(1);
        frames[0]();
        expect(render).toHaveBeenCalledTimes(1);
        expect(render).toHaveBeenLastCalledWith("chunk 100");
        expect(committed.at(-1)).toBe("<p>chunk 100</p>");
    });

    it("does not parse while inactive and catches up with the latest text on activation", () => {
        const { scheduler, frames, render, committed } = setup();

        for (let i = 1; i <= 100; i++) {
            scheduler.update(`hidden ${i}`, false, true);
        }

        expect(render).not.toHaveBeenCalled();
        expect(frames).toHaveLength(0);
        scheduler.update("hidden 100", true, true);
        expect(render).toHaveBeenCalledTimes(1);
        expect(render).toHaveBeenLastCalledWith("hidden 100");
        expect(committed.at(-1)).toBe("<p>hidden 100</p>");
    });

    it("flushes the final text immediately and cancels a pending frame on destroy", () => {
        const first = setup();
        first.scheduler.update("seed", true, false);
        first.render.mockClear();
        first.scheduler.update("tail", true, true);
        first.scheduler.update("tail final", true, false);
        expect(first.cancelled).toEqual([1]);
        expect(first.render).toHaveBeenCalledTimes(1);
        expect(first.render).toHaveBeenLastCalledWith("tail final");
        expect(first.committed.at(-1)).toBe("<p>tail final</p>");
        first.frames[0]();
        expect(first.render).toHaveBeenCalledTimes(1);

        const second = setup();
        second.scheduler.update("seed", true, false);
        second.render.mockClear();
        second.scheduler.update("tail", true, true);
        second.scheduler.destroy();
        second.frames[0]();
        expect(second.render).not.toHaveBeenCalled();
        expect(second.cancelled).toEqual([1]);
    });
});
