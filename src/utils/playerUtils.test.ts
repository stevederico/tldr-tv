import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGuidePlayable,
  isGuideBuilding,
  guideBuildError,
  type Guide,
} from './playerUtils.ts';

/** @returns Minimal guide for tests */
function guide(partial: Partial<Guide>): Guide {
  return { slug: 'x', title: 'T', ...partial };
}

describe('isGuidePlayable', () => {
  it('is false without audio or duration', () => {
    assert.equal(isGuidePlayable(null), false);
    assert.equal(isGuidePlayable(guide({})), false);
    assert.equal(isGuidePlayable(guide({ audio: '/a.mp3' })), false);
    assert.equal(isGuidePlayable(guide({ duration: 10 })), false);
  });

  it('is true with audio and positive duration', () => {
    assert.equal(isGuidePlayable(guide({ audio: '/a.mp3', duration: 10 })), true);
  });
});

describe('isGuideBuilding', () => {
  it('is true while pipeline is running', () => {
    assert.equal(
      isGuideBuilding(guide({ jobs: { pipeline: { status: 'running' } } })),
      true
    );
  });

  it('is false when playable', () => {
    assert.equal(
      isGuideBuilding(guide({ audio: '/a.mp3', duration: 5, jobs: { pipeline: { status: 'done' } } })),
      false
    );
  });

  it('is false when pipeline failed', () => {
    assert.equal(
      isGuideBuilding(guide({ jobs: { pipeline: { status: 'failed', error: 'boom' } } })),
      false
    );
  });
});

describe('guideBuildError', () => {
  it('returns pipeline error when failed', () => {
    assert.equal(
      guideBuildError(guide({ jobs: { pipeline: { status: 'failed', error: 'stale' } } })),
      'stale'
    );
  });
});
