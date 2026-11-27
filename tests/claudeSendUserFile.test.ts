import { describe, expect, it } from 'vitest';
import { buildClaudeSendUserFileBlocks, parseClaudeJsonlLines } from '../src/main/adapters/claudeAdapter';

describe('Claude SendUserFile rendering', () => {
  it('maps SendUserFile video, image, and generic attachments to rich blocks', () => {
    const blocks = buildClaudeSendUserFileBlocks({
      files: ['/tmp/demo.mp4', '/tmp/frame.png', '/tmp/report.pdf'],
      caption: 'Superharness film v3',
    });
    expect(blocks).toEqual([
      { type: 'video', path: '/tmp/demo.mp4', name: 'demo.mp4', mimeType: 'video/mp4' },
      { type: 'image', path: '/tmp/frame.png', name: 'frame.png' },
      { type: 'notice', title: 'report.pdf', detail: 'Superharness film v3\n/tmp/report.pdf' },
    ]);

    const singleVideo = buildClaudeSendUserFileBlocks({
      files: ['/tmp/demo.mp4'],
      caption: 'Superharness film v3: 30s',
      display: 'render',
    });
    expect(singleVideo).toEqual([
      {
        type: 'video',
        path: '/tmp/demo.mp4',
        name: 'Superharness film v3: 30s',
        mimeType: 'video/mp4',
      },
    ]);
  });

  it('emits inline video blocks instead of collapsed tool_call for SendUserFile in JSONL', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-11-27T04:50:00.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'SendUserFile',
            input: {
              files: ['/tmp/superharness-v3.mp4'],
              caption: 'Superharness film v3',
              display: 'attach',
            },
          },
        ],
      },
    });
    const res = parseClaudeJsonlLines([line], 'claude:test', Date.now(), 50);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].blocks).toEqual([
      {
        type: 'video',
        path: '/tmp/superharness-v3.mp4',
        name: 'Superharness film v3',
        mimeType: 'video/mp4',
      },
    ]);
  });
});
