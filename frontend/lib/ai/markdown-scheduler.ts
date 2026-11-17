type MarkdownSchedulerOptions = {
    render: (text: string) => string;
    commit: (html: string) => void;
    requestFrame?: (callback: () => void) => number;
    cancelFrame?: (id: number) => void;
};

export function createMarkdownScheduler({
    render,
    commit,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
}: MarkdownSchedulerOptions) {
    let active = false;
    let destroyed = false;
    let pendingText = "";
    let renderedText: string | null = null;
    let frameId: number | null = null;

    function cancelPendingFrame() {
        if (frameId === null) return;
        cancelFrame(frameId);
        frameId = null;
    }

    function renderNow() {
        frameId = null;
        if (destroyed || !active || renderedText === pendingText) return;
        renderedText = pendingText;
        commit(pendingText ? render(pendingText) : "");
    }

    function flushNow() {
        cancelPendingFrame();
        renderNow();
    }

    return {
        update(text: string, nextActive: boolean, streaming: boolean) {
            if (destroyed) return;
            const wasActive = active;
            pendingText = text;
            active = nextActive;
            if (!active) {
                cancelPendingFrame();
                return;
            }
            if (!text || !streaming || !wasActive) {
                flushNow();
                return;
            }
            if (renderedText !== text && frameId === null) {
                frameId = requestFrame(renderNow);
            }
        },
        destroy() {
            destroyed = true;
            cancelPendingFrame();
        },
    };
}
