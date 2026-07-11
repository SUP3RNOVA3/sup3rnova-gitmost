import { DatabaseAuditService } from './database-audit.service';
import { AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';

/**
 * Observable-property coverage for the DB-backed audit trail (#496): every
 * assertion pins what actually reaches the `audit` table (or that nothing does),
 * driven through a chainable Kysely mock that captures the inserted rows.
 */
describe('DatabaseAuditService', () => {
  function makeService(clsContext: any) {
    const inserted: any[] = [];
    const updated: any[] = [];
    let failNextInsert = false;

    const db: any = {
      insertInto: jest.fn(() => ({
        values: jest.fn((rows: any) => ({
          execute: jest.fn(async () => {
            if (failNextInsert) {
              failNextInsert = false;
              throw new Error('boom');
            }
            inserted.push(rows);
          }),
        })),
      })),
      updateTable: jest.fn(() => ({
        set: jest.fn((patch: any) => ({
          where: jest.fn(() => ({
            execute: jest.fn(async () => {
              updated.push(patch);
            }),
          })),
        })),
      })),
    };

    const store: Record<string, any> = { [AUDIT_CONTEXT_KEY]: clsContext };
    const cls: any = {
      get: jest.fn((key: string) => store[key]),
      set: jest.fn((key: string, val: any) => {
        store[key] = val;
      }),
    };

    const service = new DatabaseAuditService(db, cls);
    return {
      service,
      inserted,
      updated,
      cls,
      store,
      failInsert: () => {
        failNextInsert = true;
      },
    };
  }

  const applyPayload = () => ({
    event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
    resourceType: AuditResource.COMMENT,
    resourceId: 'c-1',
    spaceId: 'space-1',
    metadata: { pageId: 'p-1', suggestedText: 'new', decidedBy: 'u-2' },
  });

  const ctx = (over?: any) => ({
    workspaceId: 'ws-1',
    actorId: 'u-2',
    actorType: 'user',
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
    ...over,
  });

  it('log() persists a row with the CLS context merged onto the payload', async () => {
    const { service, inserted } = makeService(ctx());
    service.log(applyPayload());
    // log() is fire-and-forget; flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      workspaceId: 'ws-1',
      actorId: 'u-2',
      actorType: 'user',
      event: AuditEvent.COMMENT_SUGGESTION_APPLIED,
      resourceType: AuditResource.COMMENT,
      resourceId: 'c-1',
      spaceId: 'space-1',
      ipAddress: '10.0.0.1',
      metadata: { pageId: 'p-1', suggestedText: 'new', decidedBy: 'u-2' },
    });
  });

  it('log() is a no-op when there is no workspace in scope', async () => {
    const { service, inserted } = makeService(ctx({ workspaceId: null }));
    service.log(applyPayload());
    await Promise.resolve();
    expect(inserted).toHaveLength(0);
  });

  it('log() drops EXCLUDED_AUDIT_EVENTS (e.g. comment.created)', async () => {
    const { service, inserted } = makeService(ctx());
    service.log({
      event: AuditEvent.COMMENT_CREATED,
      resourceType: AuditResource.COMMENT,
      resourceId: 'c-1',
      spaceId: 'space-1',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(inserted).toHaveLength(0);
  });

  it('a failed insert never throws to the caller (audit is a side-record)', async () => {
    const { service, failInsert } = makeService(ctx());
    failInsert();
    // Must not reject / throw.
    expect(() => service.log(applyPayload())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('logWithContext() persists with an explicit (non-request) context', async () => {
    const { service, inserted } = makeService(undefined);
    service.logWithContext(applyPayload(), ctx({ actorType: 'system' }) as any);
    await Promise.resolve();
    await Promise.resolve();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].actorType).toBe('system');
    expect(inserted[0].workspaceId).toBe('ws-1');
  });

  it('logBatchWithContext() inserts only non-excluded events', async () => {
    const { service, inserted } = makeService(undefined);
    service.logBatchWithContext(
      [
        applyPayload(),
        {
          event: AuditEvent.COMMENT_CREATED,
          resourceType: AuditResource.COMMENT,
          resourceId: 'c-2',
        },
      ],
      ctx() as any,
    );
    await Promise.resolve();
    await Promise.resolve();
    // Batch is a single insert call carrying only the applied event.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(1);
    expect(inserted[0][0].event).toBe(AuditEvent.COMMENT_SUGGESTION_APPLIED);
  });

  it('setActorId / setActorType mutate the ambient CLS context', () => {
    const { service, store } = makeService(ctx({ actorId: null }));
    service.setActorId('u-9');
    service.setActorType('api_key');
    expect(store[AUDIT_CONTEXT_KEY].actorId).toBe('u-9');
    expect(store[AUDIT_CONTEXT_KEY].actorType).toBe('api_key');
  });

  it('updateRetention() writes the workspace retention window', async () => {
    const { service, updated } = makeService(ctx());
    await service.updateRetention('ws-1', 30);
    expect(updated).toEqual([{ auditRetentionDays: 30 }]);
  });
});
