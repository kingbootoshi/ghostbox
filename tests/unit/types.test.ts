import { describe, expect, test } from 'bun:test';

import type {
  GhostQueueState,
  GhostState,
  HistoryResponse,
} from '../../src/types';

describe('shared runtime shapes', () => {
  test('queue state shape can represent steering and follow-up work', () => {
    const queue: GhostQueueState = {
      steering: ['fix auth'],
      followUp: ['write docs', 'add screenshot'],
      pendingCount: 3,
    };

    expect(queue.pendingCount).toBe(queue.steering.length + queue.followUp.length);
  });

  test('ghost state shape carries the fields used by the API and orchestrator', () => {
    const ghost: GhostState = {
      containerId: 'container-1',
      portBase: 3100,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      imageVersion: 'gb-deadbeef',
      status: 'running',
      createdAt: '2026-03-25T00:00:00.000Z',
      systemPrompt: null,
      apiKeys: [],
    };

    expect(ghost.status).toBe('running');
    expect(ghost.apiKeys).toEqual([]);
  });

  test('history response shape supports image attachments and compaction details', () => {
    const history: HistoryResponse = {
      messages: [
        {
          role: 'user',
          text: '',
          attachmentCount: 1,
          images: [{ mediaType: 'image/png', data: 'abc123' }],
        },
      ],
      preCompactionMessages: [],
      compactions: [
        {
          timestamp: '2026-03-25T00:00:00.000Z',
          summary: 'Trimmed old context',
          tokensBefore: 120000,
        },
      ],
    };

    expect(history.messages[0]?.attachmentCount).toBe(1);
    expect(history.compactions[0]?.summary).toBe('Trimmed old context');
  });
});
