import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { PageTreeBridgeSubscriber } from './page-tree-bridge.subscriber';
import { WsTreeService } from '../ws-tree.service';
import { COLLAB_TREE_UPDATE_CHANNEL } from '../../collaboration/constants';
import { TreeUpdateSnapshot } from '../../database/listeners/page.listener';

const treeUpdate: TreeUpdateSnapshot = {
  id: 'page-1',
  slugId: 'slug-1',
  spaceId: 'space-1',
  parentPageId: null,
  title: 'Renamed',
  icon: '🚀',
};

describe('PageTreeBridgeSubscriber.onMessage', () => {
  let subscriber: PageTreeBridgeSubscriber;
  let wsTree: { broadcastPageUpdated: jest.Mock };

  beforeEach(async () => {
    wsTree = {
      broadcastPageUpdated: jest.fn().mockResolvedValue(undefined),
    };
    // onMessage is driven directly; no real redis connection is needed.
    const redisService = {
      getOrThrow: () => ({ duplicate: () => ({}) }),
    } as unknown as RedisService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageTreeBridgeSubscriber,
        { provide: RedisService, useValue: redisService },
        { provide: WsTreeService, useValue: wsTree },
      ],
    }).compile();

    subscriber = module.get<PageTreeBridgeSubscriber>(PageTreeBridgeSubscriber);
  });

  it('valid JSON on the channel: broadcasts the parsed snapshot', async () => {
    await subscriber.onMessage(
      COLLAB_TREE_UPDATE_CHANNEL,
      JSON.stringify(treeUpdate),
    );

    expect(wsTree.broadcastPageUpdated).toHaveBeenCalledTimes(1);
    expect(wsTree.broadcastPageUpdated).toHaveBeenCalledWith(treeUpdate);
  });

  it('malformed JSON: does NOT broadcast and does not throw', async () => {
    const warnSpy = jest
      .spyOn(subscriber['logger'], 'warn')
      .mockImplementation(() => undefined);

    await expect(
      subscriber.onMessage(COLLAB_TREE_UPDATE_CHANNEL, '{not json'),
    ).resolves.toBeUndefined();

    expect(wsTree.broadcastPageUpdated).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('message on a different channel: ignored', async () => {
    await subscriber.onMessage('some:other:channel', JSON.stringify(treeUpdate));

    expect(wsTree.broadcastPageUpdated).not.toHaveBeenCalled();
  });

  it('broadcast rejects: onMessage does not throw / produce unhandled rejection', async () => {
    wsTree.broadcastPageUpdated.mockRejectedValueOnce(new Error('db down'));
    const warnSpy = jest
      .spyOn(subscriber['logger'], 'warn')
      .mockImplementation(() => undefined);

    await expect(
      subscriber.onMessage(
        COLLAB_TREE_UPDATE_CHANNEL,
        JSON.stringify(treeUpdate),
      ),
    ).resolves.toBeUndefined();

    expect(wsTree.broadcastPageUpdated).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('onModuleInit when subscribe() rejects: resolves without throwing', async () => {
    const sub = {
      on: jest.fn(),
      subscribe: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const redisService = {
      getOrThrow: () => ({ duplicate: () => sub }),
    } as unknown as RedisService;
    const local = new PageTreeBridgeSubscriber(
      redisService,
      wsTree as unknown as WsTreeService,
    );
    const errorSpy = jest
      .spyOn(local['logger'], 'error')
      .mockImplementation(() => undefined);

    await expect(local.onModuleInit()).resolves.toBeUndefined();

    expect(sub.subscribe).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
