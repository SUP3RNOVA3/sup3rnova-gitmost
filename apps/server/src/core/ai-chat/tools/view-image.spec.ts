/**
 * Unit tests for the in-app `viewImage` vision tool (#588, Phase B of #585).
 *
 * Two layers are covered WITHOUT a live LLM/provider or a running Docmost:
 *   (1) `runViewImage` — the pure core: node resolution, attachment fetch, MIME
 *       classification (raster passthrough / SVG->PNG / reject), the per-run cache
 *       write keyed by toolCallId, and the small no-bytes past-tense note.
 *   (2) `forUser` registration gate — the tool is registered ONLY when the caller
 *       both enables the feature AND supplies the cache (fail-closed), and its
 *       execute wires straight into runViewImage.
 *
 * The SVG->PNG branch is exercised against a MOCKED rasterizer: the real
 * `@resvg/resvg-wasm` worker path is covered by rasterize.spec.ts (Phase A) and
 * is not runnable wherever the native wasm dep is absent, so here we assert only
 * the classification/wiring — that the SVG branch calls rasterizeSvgToPng, emits
 * mediaType 'image/png', and caches the returned PNG bytes.
 */

// Mock the #586 rasterizer module the service imports (SAME relative id, since
// both this spec and ai-chat-tools.service.ts live in tools/). Hoisted by jest.
jest.mock('../../../integrations/ai/rasterize', () => ({
  rasterizeSvgToPng: jest.fn(),
}));

import { rasterizeSvgToPng } from '../../../integrations/ai/rasterize';
import {
  runViewImage,
  VIEW_IMAGE_NOTE,
  VIEW_MAX_RASTER_BYTES,
  VIEW_MAX_LIVE_IMAGES,
  AiChatToolsService,
  type ViewImageCache,
  type ViewImageClient,
} from './ai-chat-tools.service';
import * as loader from './docmost-client.loader';
import type { DocmostClientLike } from './docmost-client.loader';
import { SHARED_TOOL_SPECS } from '../../../../../../packages/mcp/src/tool-specs';

const rasterizeMock = rasterizeSvgToPng as jest.MockedFunction<
  typeof rasterizeSvgToPng
>;

/** A minimal ViewImageClient double: getNode returns a canned node, and
 * fetchAttachmentBytes returns canned bytes+mime. Both are overridable per test. */
function makeClient(opts: {
  node?: unknown;
  bytes?: { buffer: Buffer; mime: string };
  onGetNode?: (a: unknown[]) => void;
  onFetch?: (src: string) => void;
}): ViewImageClient {
  return {
    getNode: (async (...args: unknown[]) => {
      opts.onGetNode?.(args);
      return opts.node;
    }) as ViewImageClient['getNode'],
    fetchAttachmentBytes: (async (src: string) => {
      opts.onFetch?.(src);
      if (!opts.bytes) throw new Error('no bytes stubbed');
      return opts.bytes;
    }) as ViewImageClient['fetchAttachmentBytes'],
  };
}

const imageNode = (src = '/api/files/att-1/pic.png') => ({
  type: 'image',
  node: { attrs: { src } },
});

describe('runViewImage (#588 classification + cache + note)', () => {
  beforeEach(() => rasterizeMock.mockReset());

  it('PASSTHROUGH: a PNG raster is delivered as-is; mediaType preserved, bytes cached by toolCallId', async () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: imageNode('/api/files/att-1/pic.png'),
      bytes: { buffer, mime: 'image/png' },
    });

    const res = await runViewImage(
      client,
      { pageId: 'p1', node: 'n1' },
      'call-A',
      cache,
    );

    // Small, byte-free result with the ephemeral-tense note.
    expect(res).toEqual({
      ok: true,
      mediaType: 'image/png',
      width: undefined,
      height: undefined,
      source: 'n1',
      note: VIEW_IMAGE_NOTE,
    });
    // The rasterizer is NOT touched for a raster.
    expect(rasterizeMock).not.toHaveBeenCalled();
    // The image is stashed in the cache under the toolCallId with the ORIGINAL
    // mediaType and the base64 of the ORIGINAL bytes (no re-encode).
    expect(cache.get('call-A')).toEqual({
      data: buffer.toString('base64'),
      mediaType: 'image/png',
    });
  });

  it.each(['image/jpeg', 'image/webp', 'image/gif'])(
    'PASSTHROUGH: %s is passed through with its mediaType preserved',
    async (mime) => {
      const buffer = Buffer.from('abcdef');
      const cache: ViewImageCache = new Map();
      const client = makeClient({ node: imageNode(), bytes: { buffer, mime } });
      const res = await runViewImage(
        client,
        { pageId: 'p', node: 'n' },
        'c',
        cache,
      );
      expect(res.mediaType).toBe(mime);
      expect(cache.get('c')).toEqual({
        data: buffer.toString('base64'),
        mediaType: mime,
      });
    },
  );

  it('OVERSIZED raster throws and never writes the cache', async () => {
    const buffer = Buffer.alloc(VIEW_MAX_RASTER_BYTES + 1);
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: imageNode(),
      bytes: { buffer, mime: 'image/png' },
    });
    await expect(
      runViewImage(client, { pageId: 'p', node: 'n' }, 'c', cache),
    ).rejects.toThrow('image too large');
    expect(cache.size).toBe(0);
  });

  it('F1: refuses (model-visible) and does not write when the live-image cap is reached', async () => {
    // Pre-fill the cache to the count cap with cheap entries.
    const cache: ViewImageCache = new Map();
    for (let i = 0; i < VIEW_MAX_LIVE_IMAGES; i++) {
      cache.set('held-' + i, { data: 'AA==', mediaType: 'image/png' });
    }
    const client = makeClient({
      node: imageNode(),
      bytes: { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' },
    });
    await expect(
      runViewImage(client, { pageId: 'p', node: 'n' }, 'new', cache),
    ).rejects.toThrow(/too many images/i);
    // The refused call must not add its entry.
    expect(cache.size).toBe(VIEW_MAX_LIVE_IMAGES);
    expect(cache.has('new')).toBe(false);
  });

  it('SVG: rasterized to PNG via the #586 rasterizer; mediaType=image/png, width/height propagated, PNG cached', async () => {
    const svgBytes = Buffer.from('<svg/>', 'utf8');
    const png = Buffer.from([1, 2, 3, 4]);
    rasterizeMock.mockResolvedValue({ png, width: 640, height: 480 });
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: { type: 'image', node: { attrs: { src: '/api/files/a/x.svg' } } },
      bytes: { buffer: svgBytes, mime: 'image/svg+xml' },
    });

    const res = await runViewImage(
      client,
      { pageId: 'p', node: 'n' },
      'c-svg',
      cache,
    );

    // The rasterizer received the SVG source as a UTF-8 string.
    expect(rasterizeMock).toHaveBeenCalledWith('<svg/>');
    expect(res).toEqual({
      ok: true,
      mediaType: 'image/png',
      width: 640,
      height: 480,
      source: 'n',
      note: VIEW_IMAGE_NOTE,
    });
    // The cache holds the RASTERIZED png bytes, not the svg source.
    expect(cache.get('c-svg')).toEqual({
      data: png.toString('base64'),
      mediaType: 'image/png',
    });
  });

  it('DRAWIO node type is rasterized as SVG even if the file server labels it octet-stream', async () => {
    const png = Buffer.from([9, 9]);
    rasterizeMock.mockResolvedValue({ png, width: 10, height: 20 });
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: {
        type: 'drawio',
        node: { attrs: { src: '/api/files/d/x.drawio.svg' } },
      },
      bytes: { buffer: Buffer.from('<svg/>'), mime: 'application/octet-stream' },
    });
    const res = await runViewImage(
      client,
      { pageId: 'p', node: 'n' },
      'c',
      cache,
    );
    expect(rasterizeMock).toHaveBeenCalled();
    expect(res.mediaType).toBe('image/png');
    expect(cache.get('c')?.mediaType).toBe('image/png');
  });

  it('NON-IMAGE node throws "node is not an image" and never fetches bytes', async () => {
    let fetched = false;
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: { type: 'paragraph', node: { attrs: {} } },
      onFetch: () => {
        fetched = true;
      },
    });
    await expect(
      runViewImage(client, { pageId: 'p', node: 'n' }, 'c', cache),
    ).rejects.toThrow('node is not an image');
    expect(fetched).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('UNSUPPORTED mime (e.g. application/pdf) on an image node throws "unsupported type ..."', async () => {
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: imageNode(),
      bytes: { buffer: Buffer.from('%PDF'), mime: 'application/pdf' },
    });
    await expect(
      runViewImage(client, { pageId: 'p', node: 'n' }, 'c', cache),
    ).rejects.toThrow('unsupported type application/pdf');
    expect(cache.size).toBe(0);
  });

  it('requests the node in JSON format (attrs.src survives) and fetches that src', async () => {
    let getNodeArgs: unknown[] = [];
    let fetchedSrc = '';
    const cache: ViewImageCache = new Map();
    const client = makeClient({
      node: imageNode('/api/files/att-9/p.png'),
      bytes: { buffer: Buffer.from('x'), mime: 'image/png' },
      onGetNode: (a) => (getNodeArgs = a),
      onFetch: (s) => (fetchedSrc = s),
    });
    await runViewImage(client, { pageId: 'PID', node: 'NREF' }, 'c', cache);
    // getNode MUST be called with format 'json' (markdown drops attachmentId/src).
    expect(getNodeArgs).toEqual(['PID', 'NREF', 'json']);
    expect(fetchedSrc).toBe('/api/files/att-9/p.png');
  });
});

// -------------------------------------------------------------------------
// forUser registration gate (#588 §3): the tool exists iff enabled + cache.
// -------------------------------------------------------------------------

const mockLoaded = (DocmostClient: loader.DocmostClientCtor) => ({
  DocmostClient,
  sharedToolSpecs: SHARED_TOOL_SPECS as unknown as Record<
    string,
    loader.SharedToolSpec
  >,
  searchShapes: (() => []) as unknown as loader.SearchShapesFn,
  getGuideSection: (() => ({
    section: 'index',
    content: '',
    sections: [],
  })) as unknown as loader.GetGuideSectionFn,
});

describe('AiChatToolsService.forUser viewImage gate (#588)', () => {
  let service: AiChatToolsService;
  const fakeClient = {
    getNode: jest.fn(async () => imageNode('/api/files/att-1/pic.png')),
    fetchAttachmentBytes: jest.fn(async () => ({
      buffer: Buffer.from('PNGDATA'),
      mime: 'image/png',
    })),
  };

  beforeEach(() => {
    rasterizeMock.mockReset();
    fakeClient.getNode.mockClear();
    fakeClient.fetchAttachmentBytes.mockClear();
    jest.spyOn(loader, 'loadDocmostMcp').mockResolvedValue(
      mockLoaded(function () {
        return fakeClient as unknown as DocmostClientLike;
      } as unknown as loader.DocmostClientCtor),
    );
    service = new AiChatToolsService(
      {
        generateAccessToken: jest.fn().mockResolvedValue('a'),
        generateCollabToken: jest.fn().mockResolvedValue('c'),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        asSink: () => ({ put: jest.fn(), has: jest.fn(), evict: jest.fn() }),
      } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const user = { id: 'u', email: 'u@e.com', workspaceId: 'ws' } as never;

  it('GATE OFF (default): viewImage is NOT registered', async () => {
    const tools = await service.forUser(user, 's', 'ws', 'chat', null);
    expect(tools.viewImage).toBeUndefined();
  });

  it('GATE OFF explicitly (flag false) even with a cache supplied: not registered', async () => {
    const tools = await service.forUser(
      user,
      's',
      'ws',
      'chat',
      null,
      false,
      new Map(),
    );
    expect(tools.viewImage).toBeUndefined();
  });

  it('GATE ON but NO cache: not registered (fail-closed)', async () => {
    const tools = await service.forUser(
      user,
      's',
      'ws',
      'chat',
      null,
      true,
      undefined,
    );
    expect(tools.viewImage).toBeUndefined();
  });

  it('GATE ON + cache: viewImage registered and its execute writes the cache by toolCallId', async () => {
    const cache: ViewImageCache = new Map();
    const tools = await service.forUser(
      user,
      's',
      'ws',
      'chat',
      null,
      true,
      cache,
    );
    expect(tools.viewImage).toBeDefined();

    const out = await (tools.viewImage.execute as any)(
      { pageId: 'p1', node: 'n1' },
      { toolCallId: 'tc-1' },
    );
    expect(out).toMatchObject({ ok: true, mediaType: 'image/png', note: VIEW_IMAGE_NOTE });
    expect(fakeClient.getNode).toHaveBeenCalledWith('p1', 'n1', 'json');
    expect(cache.get('tc-1')).toEqual({
      data: Buffer.from('PNGDATA').toString('base64'),
      mediaType: 'image/png',
    });
  });
});
