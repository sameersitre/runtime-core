import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Fiber } from './fiberTreeWalker';
import {
  resolveEffectiveReactKey,
  __setWalkerFilterConfigForTesting,
  __resetWalkerFilterConfigForTesting,
} from './fiberTreeWalker';

// React fiber tag for FunctionComponent (from ReactWorkTags).
const FUNCTION_COMPONENT = 0;

// Minimal fiber factory — only populates the fields `resolveEffectiveReactKey`
// (and its dependencies `isUserComponent` / `getComponentName` /
// `isFrameworkComponent`) actually read.
function makeFiber(opts: {
  name: string;
  key?: string | null;
  parent?: Fiber | null;
}): Fiber {
  const fn = function () {} as unknown as { displayName?: string };
  fn.displayName = opts.name;
  return {
    tag: FUNCTION_COMPONENT,
    key: opts.key ?? null,
    type: fn,
    child: null,
    sibling: null,
    return: opts.parent ?? null,
    memoizedProps: null,
    pendingProps: null,
  } as Fiber;
}

describe('resolveEffectiveReactKey', () => {
  beforeEach(() => {
    __resetWalkerFilterConfigForTesting();
  });

  afterEach(() => {
    __resetWalkerFilterConfigForTesting();
  });

  it('returns the fiber key directly when present', () => {
    const fiber = makeFiber({ name: 'RowCard', key: 'abc-1' });
    expect(resolveEffectiveReactKey(fiber)).toBe('abc-1');
  });

  it('returns undefined when no key exists on fiber or any ancestor', () => {
    const grandparent = makeFiber({ name: 'App' });
    const parent = makeFiber({ name: 'Screen', parent: grandparent });
    const fiber = makeFiber({ name: 'RowCard', parent });
    expect(resolveEffectiveReactKey(fiber)).toBeUndefined();
  });

  it('inherits a key from a framework ancestor (FlatList → CellRenderer → RowCard)', () => {
    // CellRenderer is a framework wrapper; RN's FlatList `keyExtractor` drops
    // the key here rather than on the user's RowCard.
    __setWalkerFilterConfigForTesting({
      frameworkNames: new Set(['CellRenderer', 'VirtualizedList']),
    });
    const flatList = makeFiber({ name: 'VirtualizedList' });
    const cell = makeFiber({ name: 'CellRenderer', key: 'abc-1', parent: flatList });
    const rowCard = makeFiber({ name: 'RowCard', parent: cell });

    expect(resolveEffectiveReactKey(rowCard)).toBe('abc-1');
  });

  it("does not steal a sibling's key from a non-framework user ancestor", () => {
    // The emitted ancestor RowCard(key='other') owns its own key; a child
    // component further down must not inherit it.
    const parentCard = makeFiber({ name: 'RowCard', key: 'other' });
    const child = makeFiber({ name: 'Title', parent: parentCard });

    expect(resolveEffectiveReactKey(child)).toBeUndefined();
  });

  it('stops climbing after 6 hops', () => {
    __setWalkerFilterConfigForTesting({
      frameworkNames: new Set(['Wrapper']),
    });
    // 8 framework wrappers above, key only on the outermost — beyond the cap.
    let top: Fiber = makeFiber({ name: 'Wrapper', key: 'too-far' });
    for (let i = 0; i < 7; i++) {
      top = makeFiber({ name: 'Wrapper', parent: top });
    }
    const leaf = makeFiber({ name: 'RowCard', parent: top });
    expect(resolveEffectiveReactKey(leaf)).toBeUndefined();
  });
});
