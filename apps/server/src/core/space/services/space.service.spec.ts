import { SpaceService } from './space.service';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve the @InjectKysely()/@InjectQueue()/AUDIT_SERVICE tokens at compile();
// this smoke test only needs the service to construct.
describe('SpaceService', () => {
  let service: SpaceService;

  beforeEach(() => {
    service = new SpaceService(
      {} as any, // spaceRepo
      {} as any, // spaceMemberService
      {} as any, // shareRepo
      {} as any, // workspaceRepo
      {} as any, // licenseCheckService
      {} as any, // db
      {} as any, // attachmentQueue
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('updateSpace gitSyncEnabled', () => {
    const workspaceId = 'ws-1';
    const spaceId = 'space-1';

    // executeTx runs the callback immediately with a passthrough trx so the
    // repo calls happen inline; mirrors how the sibling sharing/comments flags
    // are persisted.
    const buildService = (settingsBefore: Record<string, any>) => {
      const spaceRepo = {
        findById: jest.fn().mockResolvedValue({
          id: spaceId,
          name: 'Space',
          slug: 'space',
          description: '',
          settings: settingsBefore,
        }),
        updateGitSyncSettings: jest.fn().mockResolvedValue({}),
        updateSharingSettings: jest.fn().mockResolvedValue({}),
        updateCommentSettings: jest.fn().mockResolvedValue({}),
        updateSpace: jest
          .fn()
          .mockResolvedValue({ id: spaceId, name: 'Space', slug: 'space' }),
        slugExists: jest.fn().mockResolvedValue(false),
      };
      const auditService = { log: jest.fn() };

      const svc = new SpaceService(
        spaceRepo as any,
        {} as any, // spaceMemberService
        {} as any, // shareRepo
        {} as any, // workspaceRepo
        {} as any, // licenseCheckService
        {} as any, // db
        {} as any, // attachmentQueue
        auditService as any,
      );

      // executeTx is invoked via the imported helper; patch it on the module.
      jest
        .spyOn(require('@docmost/db/utils'), 'executeTx')
        .mockImplementation(async (_db: any, cb: any) => cb({} as any));

      return { svc, spaceRepo, auditService };
    };

    it('persists gitSyncEnabled via updateGitSyncSettings(enabled)', async () => {
      const { svc, spaceRepo } = buildService({});

      await svc.updateSpace(
        { spaceId, gitSyncEnabled: true } as any,
        workspaceId,
      );

      expect(spaceRepo.updateGitSyncSettings).toHaveBeenCalledWith(
        spaceId,
        workspaceId,
        'enabled',
        true,
        expect.anything(),
      );
    });

    it('does not call updateGitSyncSettings when flag is undefined', async () => {
      const { svc, spaceRepo } = buildService({});

      await svc.updateSpace({ spaceId } as any, workspaceId);

      expect(spaceRepo.updateGitSyncSettings).not.toHaveBeenCalled();
    });
  });
});
