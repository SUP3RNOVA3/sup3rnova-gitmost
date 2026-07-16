import { PageService } from './page.service';

// #654 — resolvePreferLiveContent maps the three readLiveIfLoaded outcomes to the
// content + (contentSource, fallbackReason) the /pages/info preferLive path
// returns. Direct instantiation with a stub collaborationGateway (the only dep
// this method touches); every other dep stays a bare stub.

const LIVE = { type: 'doc', content: [{ type: 'paragraph' }] };
const DB = { type: 'doc', content: [] };

function makeService(readLiveResult: any): PageService {
  const collaborationGateway = {
    readLiveIfLoaded: jest.fn().mockResolvedValue(readLiveResult),
  };
  return new PageService(
    {} as any, // pageRepo
    {} as any, // pagePermissionRepo
    {} as any, // attachmentRepo
    {} as any, // db
    {} as any, // storageService
    {} as any, // attachmentQueue
    {} as any, // aiQueue
    {} as any, // generalQueue
    {} as any, // eventEmitter
    collaborationGateway as any,
    {} as any, // watcherService
    {} as any, // transclusionService
  );
}

describe('PageService.resolvePreferLiveContent (#654)', () => {
  it('loaded -> live content, contentSource:"live", no fallbackReason', async () => {
    const service = makeService({ loaded: true, content: LIVE, hash: 'h' });
    const res = await service.resolvePreferLiveContent('uuid-1', DB);
    expect(res.content).toBe(LIVE); // the LIVE doc, NOT the DB row
    expect(res.contentSource).toBe('live');
    expect(res.fallbackReason).toBeUndefined();
  });

  it('not loaded -> DB row content, contentSource:"db", reason not_loaded', async () => {
    const service = makeService({ loaded: false });
    const res = await service.resolvePreferLiveContent('uuid-1', DB);
    expect(res.content).toBe(DB);
    expect(res.contentSource).toBe('db');
    expect(res.fallbackReason).toBe('not_loaded');
  });

  it('owner unreachable -> DB row content, contentSource:"db", reason owner_unreachable', async () => {
    const service = makeService({ loaded: false, unreachable: true });
    const res = await service.resolvePreferLiveContent('uuid-1', DB);
    expect(res.content).toBe(DB);
    expect(res.contentSource).toBe('db');
    expect(res.fallbackReason).toBe('owner_unreachable');
  });

  it('probes the collab doc by the resolved page.id (page.<uuid>)', async () => {
    const gwSpy = jest.fn().mockResolvedValue({ loaded: false });
    const service = makeService({ loaded: false });
    (service as any).collaborationGateway.readLiveIfLoaded = gwSpy;
    await service.resolvePreferLiveContent('the-uuid', DB);
    expect(gwSpy).toHaveBeenCalledWith('page.the-uuid');
  });
});
