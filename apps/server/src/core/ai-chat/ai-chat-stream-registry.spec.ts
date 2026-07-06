import {
  AiChatStreamRegistryService,
  RUN_STREAM_MAX_BUFFER_BYTES,
  RUN_STREAM_RETAIN_FINISHED_MS,
  RunStreamCallbacks,
} from './ai-chat-stream-registry.service';

/**
 * Unit tests for the in-memory run-stream registry (#184 phase 1.5). The registry
 * is the whole of the resumable-transport contract: replay ordering, paused ->
 * live hand-off, overflow, retention, the anchor check (invariant 6), and the
 * mirror-the-done-path replace semantics (invariant 3). Every enumerated case in
 * the issue's task 1.5 has a test here.
 */

// A ReadableStream whose frames the test pushes explicitly, plus close/error.
function makePushStream(): {
  stream: ReadableStream<string>;
  push: (f: string) => void;
  close: () => void;
  error: (e?: unknown) => void;
} {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (f) => controller.enqueue(f),
    close: () => controller.close(),
    error: (e) => controller.error(e ?? new Error('read error')),
  };
}

// Let the fire-and-forget pump drain queued frames (reader.read() resolves on a
// macrotask boundary for an already-enqueued value).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function collector(): {
  cb: RunStreamCallbacks;
  frames: string[];
  ended: () => number;
} {
  const frames: string[] = [];
  let ends = 0;
  return {
    frames,
    ended: () => ends,
    cb: {
      onFrame: (f) => frames.push(f),
      onEnd: () => {
        ends += 1;
      },
    },
  };
}

describe('AiChatStreamRegistryService', () => {
  const CHAT = 'chat-1';
  let registry: AiChatStreamRegistryService;

  beforeEach(() => {
    registry = new AiChatStreamRegistryService();
    jest.spyOn((registry as any).logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    registry.onModuleDestroy();
  });

  it('replays frames in arrival order (live attach)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    src.push('b');
    src.push('c');
    await flush();

    const c = collector();
    const att = await registry.attach(CHAT, false, undefined, c.cb);
    expect(att).not.toBeNull();
    expect(att!.replay).toEqual(['a', 'b', 'c']);
    expect(att!.finished).toBe(false);
  });

  it('late attach gets the full prefix as replay plus the live tail', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    src.push('b');
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, false, undefined, c.cb))!;
    expect(att.replay).toEqual(['a', 'b']);
    att.start();
    // Live tail arrives after start().
    src.push('c');
    src.push('d');
    await flush();
    expect(c.frames).toEqual(['c', 'd']);
  });

  it('a paused subscriber receives frames buffered during pause in order, then live (no loss/reorder)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    // Attach (paused). Frames that arrive BEFORE start() must queue, not drop.
    const att = (await registry.attach(CHAT, false, undefined, c.cb))!;
    expect(att.replay).toEqual(['a']);
    src.push('b'); // arrives while paused -> pending
    src.push('c');
    await flush();
    expect(c.frames).toEqual([]); // nothing delivered yet (paused)
    att.start(); // drains pending in order
    expect(c.frames).toEqual(['b', 'c']);
    src.push('d'); // now live
    await flush();
    expect(c.frames).toEqual(['b', 'c', 'd']);
  });

  it('a run that finishes while a subscriber is paused ends it on start()', async () => {
    registry.open(CHAT, 'run-1');
    const c = collector();
    const att = (await registry.attach(CHAT, false, undefined, c.cb))!;
    // Terminate the run while the subscriber is still paused.
    registry.abortEntry(CHAT, 'run-1');
    expect(c.ended()).toBe(0); // paused: not ended yet
    att.start();
    expect(c.ended()).toBe(1); // start() drains + ends
  });

  it('finished + expect=live returns a replay WITHOUT registering a subscriber', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    src.push('b');
    src.close();
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, true, undefined, c.cb))!;
    expect(att.finished).toBe(true);
    expect(att.replay).toEqual(['a', 'b']);
    // No subscriber registered: start()/unsubscribe are no-ops and the entry has
    // zero subscribers.
    const entry = (registry as any).entries.get(CHAT);
    expect(entry.subscribers.size).toBe(0);
    att.start();
    expect(c.frames).toEqual([]);
  });

  it('finished WITHOUT expect=live returns null', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    src.close();
    await flush();

    const c = collector();
    expect(await registry.attach(CHAT, false, undefined, c.cb)).toBeNull();
  });

  it('anchor mismatch with expect=live returns null (and null before bind sets assistantMessageId)', async () => {
    registry.open(CHAT, 'run-1');
    const c = collector();
    // Before bind: assistantMessageId is undefined -> mismatches any anchor.
    expect(
      await registry.attach(CHAT, true, 'assist-1', c.cb),
    ).toBeNull();

    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();
    // Wrong anchor -> null (cross-run replay forbidden, invariant 6).
    expect(await registry.attach(CHAT, true, 'other-id', c.cb)).toBeNull();
  });

  it('matching anchor with expect=live attaches', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    const att = await registry.attach(CHAT, true, 'assist-1', c.cb);
    expect(att).not.toBeNull();
    expect(att!.replay).toEqual(['a']);
  });

  it('overflow: attach returns null, but the LIVE subscriber keeps receiving (incl. the crossing frame)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);

    // A live (started) subscriber attached before the flood.
    const c = collector();
    const att = (await registry.attach(CHAT, false, undefined, c.cb))!;
    att.start();

    const oneMb = 'x'.repeat(1024 * 1024);
    // 5 x 1MB = 5MB > 4MB cap; the 5th frame is the one that crosses.
    for (let i = 0; i < 5; i++) src.push(oneMb + i);
    await flush();

    const entry = (registry as any).entries.get(CHAT);
    expect(entry.overflowed).toBe(true);
    expect(entry.bytes).toBeGreaterThan(RUN_STREAM_MAX_BUFFER_BYTES);
    // The live subscriber received ALL 5 frames, including the crossing one.
    expect(c.frames).toHaveLength(5);
    expect(c.frames[4]).toBe(oneMb + 4);

    // A NEW attach after overflow gets null (replay buffer is gone).
    const c2 = collector();
    expect(await registry.attach(CHAT, false, undefined, c2.cb)).toBeNull();
  });

  it('a paused subscriber whose pending buffer overflows is dropped and ends on start(); other subscribers keep receiving', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);

    // A: paused (start() deliberately delayed to simulate the phase-2 await seam).
    const a = collector();
    const attA = (await registry.attach(CHAT, false, undefined, a.cb))!;
    // B: live (started) — its delivery must be unaffected by A's overflow.
    const b = collector();
    const attB = (await registry.attach(CHAT, false, undefined, b.cb))!;
    attB.start();

    const oneMb = 'x'.repeat(1024 * 1024);
    // 9 x 1MB = 9MB > 8MB per-subscriber cap; A's pending overflows, B streams live.
    for (let i = 0; i < 9; i++) src.push(oneMb + i);
    await flush();

    const entry = (registry as any).entries.get(CHAT);
    // A was dropped from the subscriber set on overflow; B (started) remains.
    expect(entry.subscribers.size).toBe(1);
    expect(a.frames).toEqual([]); // paused + overflowed: nothing was delivered
    // B received every frame live (delivery unaffected by A's overflow).
    expect(b.frames).toHaveLength(9);

    // A's start() (arriving late) degrades to an immediate end, not a partial replay.
    attA.start();
    expect(a.frames).toEqual([]);
    expect(a.ended()).toBe(1);
  });

  it('open() over a LIVE entry ends started subscribers exactly once and a late done does not touch the new entry (invariant 3)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);
    src.push('a');
    await flush();

    const c = collector();
    const att = (await registry.attach(CHAT, false, undefined, c.cb))!;
    att.start(); // started subscriber on run-1

    // run-2 starts on the same chat while run-1's tee is still reading.
    registry.open(CHAT, 'run-2');
    expect(c.ended()).toBe(1); // exactly one onEnd from the replace

    const newEntry = (registry as any).entries.get(CHAT);
    expect(newEntry.runId).toBe('run-2');
    expect(newEntry.finished).toBe(false);

    // The old tee now completes: its late done must NOT double-end nor delete the
    // new entry.
    src.push('b');
    src.close();
    await flush();
    expect(c.ended()).toBe(1); // still exactly one
    const still = (registry as any).entries.get(CHAT);
    expect(still).toBe(newEntry);
    expect(still.runId).toBe('run-2');
  });

  it('bind with a foreign runId is a no-op (invariant 1)', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'WRONG-run', 'assist-x', src.stream);
    src.push('a');
    await flush();
    const entry = (registry as any).entries.get(CHAT);
    // Frames were NOT ingested (bind bailed), assistantMessageId untouched.
    expect(entry.frames).toEqual([]);
    expect(entry.assistantMessageId).toBeUndefined();
  });

  it('abortEntry with a foreign runId is a no-op (invariant 1)', async () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'WRONG-run');
    const entry = (registry as any).entries.get(CHAT);
    expect(entry.finished).toBe(false);
  });

  it('a throwing onFrame ejects only that subscriber; the ingest loop stays alive', async () => {
    registry.open(CHAT, 'run-1');
    const src = makePushStream();
    registry.bind(CHAT, 'run-1', 'assist-1', src.stream);

    const bad = collector();
    const badAtt = (await registry.attach(CHAT, false, undefined, {
      onFrame: () => {
        throw new Error('boom');
      },
      onEnd: bad.cb.onEnd,
    }))!;
    badAtt.start();

    const good = collector();
    const goodAtt = (await registry.attach(CHAT, false, undefined, good.cb))!;
    goodAtt.start();

    src.push('a'); // bad throws on this frame -> ejected
    src.push('b'); // good still receives both
    await flush();

    const entry = (registry as any).entries.get(CHAT);
    expect(entry.subscribers.size).toBe(1); // bad ejected, good remains
    expect(good.frames).toEqual(['a', 'b']);
  });
});

/**
 * Retention + replace timer behavior. Fake timers, and entries are finalized via
 * the synchronous abortEntry() path so no stream pump / microtask juggling is
 * needed.
 */
describe('AiChatStreamRegistryService retention timers', () => {
  const CHAT = 'chat-r';
  let registry: AiChatStreamRegistryService;

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new AiChatStreamRegistryService();
    jest.spyOn((registry as any).logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    registry.onModuleDestroy();
    jest.useRealTimers();
  });

  it('a finished entry is removed after the retention window', () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'run-1'); // finalize -> retention armed
    expect((registry as any).entries.get(CHAT)).toBeDefined();
    jest.advanceTimersByTime(RUN_STREAM_RETAIN_FINISHED_MS + 1);
    expect((registry as any).entries.get(CHAT)).toBeUndefined();
  });

  it('retention deletes ONLY its own entry (invariant 2)', () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'run-1'); // arm retention for entry A
    // Simulate the race where the key was replaced without clearing A's timer.
    const sentinel = { marker: true };
    (registry as any).entries.set(CHAT, sentinel);
    jest.advanceTimersByTime(RUN_STREAM_RETAIN_FINISHED_MS + 1);
    // A's timer saw entries.get(CHAT) !== A, so it did NOT delete the successor.
    expect((registry as any).entries.get(CHAT)).toBe(sentinel);
  });

  it('open() over a retained entry clears its timer and the successor survives', () => {
    registry.open(CHAT, 'run-1');
    registry.abortEntry(CHAT, 'run-1'); // retained, timer armed
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    registry.open(CHAT, 'run-2'); // must clear run-1's retain timer
    expect(clearSpy).toHaveBeenCalled();
    jest.advanceTimersByTime(RUN_STREAM_RETAIN_FINISHED_MS + 1);
    const entry = (registry as any).entries.get(CHAT);
    expect(entry).toBeDefined();
    expect(entry.runId).toBe('run-2');
  });
});
