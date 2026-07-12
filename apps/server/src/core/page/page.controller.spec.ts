import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PageController } from './page.controller';

// Direct instantiation with stub deps. The Test.createTestingModule form failed
// to resolve PageService's injected tokens at compile(), and this smoke test only
// needs the controller to construct.
describe('PageController', () => {
  let controller: PageController;

  beforeEach(() => {
    controller = new PageController(
      {} as any, // pageService
      {} as any, // pageRepo
      {} as any, // pageHistoryService
      {} as any, // spaceAbility
      {} as any, // pageAccessService
      {} as any, // backlinkService
      {} as any, // labelService
      {} as any, // auditService
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // #395 — the work-time endpoint must be gated exactly like /history.
  describe('getPageWorkTime', () => {
    const user = { id: 'u1' } as any;

    function build(overrides: {
      page?: any;
      validate?: jest.Mock;
      compute?: jest.Mock;
    }) {
      const pageRepo = { findById: jest.fn().mockResolvedValue(overrides.page) };
      const pageAccessService = {
        validateCanView: overrides.validate ?? jest.fn().mockResolvedValue(undefined),
      };
      const pageHistoryService = {
        computeWorkTime:
          overrides.compute ?? jest.fn().mockResolvedValue({ workMs: 0 }),
      };
      const c = new PageController(
        {} as any,
        pageRepo as any,
        pageHistoryService as any,
        {} as any,
        pageAccessService as any,
        {} as any,
        {} as any,
        {} as any,
      );
      return { c, pageRepo, pageAccessService, pageHistoryService };
    }

    it('404s when the page does not exist', async () => {
      const { c } = build({ page: null });
      await expect(
        c.getPageWorkTime({ pageId: 'p1' } as any, user),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('enforces validateCanView before computing, then delegates with tz', async () => {
      const validate = jest.fn().mockResolvedValue(undefined);
      const compute = jest.fn().mockResolvedValue({ workMs: 42 });
      const { c } = build({ page: { id: 'pg' }, validate, compute });
      const out = await c.getPageWorkTime(
        { pageId: 'pg', tz: 'Europe/Moscow' } as any,
        user,
      );
      expect(validate).toHaveBeenCalledWith({ id: 'pg' }, user);
      expect(compute).toHaveBeenCalledWith('pg', 'Europe/Moscow');
      expect(out).toEqual({ workMs: 42 });
    });

    it('maps an unknown-timezone RangeError to a 400', async () => {
      const compute = jest.fn().mockRejectedValue(new RangeError('bad tz'));
      const { c } = build({ page: { id: 'pg' }, compute });
      await expect(
        c.getPageWorkTime({ pageId: 'pg', tz: 'X/Y' } as any, user),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not swallow a non-RangeError from the service', async () => {
      const compute = jest.fn().mockRejectedValue(new Error('db down'));
      const { c } = build({ page: { id: 'pg' }, compute });
      await expect(
        c.getPageWorkTime({ pageId: 'pg' } as any, user),
      ).rejects.toThrow('db down');
    });
  });
});
