export type CastEvent = [number, string, string];

export function createPlayback(events: readonly CastEvent[], output: {
    write(data: string, parsed: () => void): void;
    reset(): void;
    update(index: number, elapsed: number, playing: boolean): void;
}) {
    let index = 0;
    let playing = false;
    let speed = 1;
    let position = 0;
    let startedAt = 0;
    let writing = false;
    let resetPending = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const duration = events[events.length - 1]?.[0] ?? 0;
    const time = () => position + (playing ? (performance.now() - startedAt) * speed / 1000 : 0);
    const update = () => output.update(index, Math.min(time(), duration), playing);

    function schedule() {
        if (!playing || writing || disposed) return;
        if (index >= events.length) {
            playing = false;
            position = duration;
            update();
            return;
        }
        timer = setTimeout(tick, Math.max(0, (events[index][0] - time()) * 1000 / speed));
    }

    function resetOutput() {
        if (resetPending && !writing) {
            output.reset();
            resetPending = false;
        }
    }

    function tick() {
        timer = null;
        if (!playing || disposed) return;
        const due = time();
        const parts: string[] = [];
        let chars = 0;
        // Yield after bounded work, even when an entire recording is overdue.
        // ponytail: one oversized chunk passes intact; split it if large single events become common.
        while (index < events.length && events[index][0] <= due && parts.length < 256 && chars < 32768) {
            const data = events[index][2];
            parts.push(data);
            chars += data.length;
            index++;
        }
        update();
        if (!parts.length) { schedule(); return; }
        writing = true;
        output.write(parts.join(""), () => {
            writing = false;
            if (disposed) return;
            resetOutput();
            schedule();
        });
    }

    function pause() {
        position = time();
        playing = false;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        update();
    }

    return {
        play(rate: number) {
            if (disposed || !events.length) return;
            pause();
            if (index >= events.length && !writing) {
                index = 0;
                position = 0;
                resetPending = true;
            }
            speed = rate;
            startedAt = performance.now();
            playing = true;
            resetOutput();
            update();
            schedule();
        },
        pause,
        stop() {
            pause();
            index = 0;
            position = 0;
            resetPending = true;
            resetOutput();
            update();
        },
        dispose() { pause(); disposed = true; },
    };
}
