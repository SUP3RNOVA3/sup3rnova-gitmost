import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { PageTreeBridgePublisher } from './page-tree-bridge.publisher';
import { COLLAB_TREE_UPDATE_CHANNEL } from '../constants';
import {
  PageEvent,
  TreeUpdateSnapshot,
} from '../../database/listeners/page.listener';

const treeUpdate: TreeUpdateSnapshot = {
  id: 'page-1',
  slugId: 'slug-1',
  spaceId: 'space-1',
  parentPageId: null,
  title: 'Renamed',
  icon: '🚀',
};

describe('PageTreeBridgePublisher', () => {
  let publisher: PageTreeBridgePublisher;
  let redis: { publish: jest.Mock };

  beforeEach(async () => {
    redis = { publish: jest.fn().mockResolvedValue(1) };
    const redisService = { getOrThrow: () => redis } as unknown as RedisService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageTreeBridgePublisher,
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    publisher = module.get<PageTreeBridgePublisher>(PageTreeBridgePublisher);
  });

  it('WITH a `treeUpdate`: publishes the JSON snapshot on the channel', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
      treeUpdate,
    };

    await publisher.onPageUpdated(event);

    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledWith(
      COLLAB_TREE_UPDATE_CHANNEL,
      JSON.stringify(treeUpdate),
    );
  });

  it('content-only save (NO `treeUpdate`): does NOT publish', async () => {
    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
    };

    await publisher.onPageUpdated(event);

    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('a publish rejection is caught (no throw)', async () => {
    redis.publish.mockRejectedValueOnce(new Error('redis down'));
    const errorSpy = jest
      .spyOn(publisher['logger'], 'error')
      .mockImplementation(() => undefined);

    const event: PageEvent = {
      pageIds: ['page-1'],
      workspaceId: 'ws-1',
      treeUpdate,
    };

    await expect(publisher.onPageUpdated(event)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
