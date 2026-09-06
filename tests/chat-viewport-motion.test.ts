import { describe, expect, it } from 'vitest';
import {
  CHAT_KEYBOARD_MOVED_FALLBACK_MS,
  CHAT_KEYBOARD_TARGET_FALLBACK_MS,
  CHAT_VIEWPORT_SETTLE_MS,
  createChatViewportMotion,
} from '../src/lib/chat-viewport-motion';

function fixture() {
  let time = 0;
  const events: string[] = [];
  const sample = {
    height: 844,
    width: 390,
    top: 0,
    layoutHeight: 844,
    scrollY: 500,
    keyboardOpen: false,
    keyboardGeometry: 'closed' as 'closed' | 'intermediate' | 'open',
  };
  const motion = createChatViewportMotion({
    now: () => time,
    conceal: immediate => events.push(immediate ? 'positioning' : 'fading'),
    settled: () => events.push('measure'), reveal: () => events.push('reveal'),
  });
  const tick = (elapsed: number, values = {}) => {
    time += elapsed;
    Object.assign(sample, values);
    const space = Math.max(0, sample.layoutHeight - sample.height);
    sample.keyboardOpen = space > 120;
    sample.keyboardGeometry = space <= 120 ? 'closed'
      : space >= Math.max(180, sample.layoutHeight * 0.28) ? 'open' : 'intermediate';
    motion.sample({ ...sample });
  };
  return { motion, events, tick };
}

describe('chat viewport motion', () => {
  it('conceals a chat first mounted at intermediate keyboard geometry', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 1_236, width: 1_024, layoutHeight: 1_366 });
    expect(events).toEqual(['positioning']);
    expect(motion.concealed).toBe(true);
    expect(motion.moving).toBe(true);
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - 1);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('gates keyboard opening until the requested open endpoint is stable', () => {
    const { motion, events, tick } = fixture();
    tick(0); tick(16, { scrollY: 700 }); tick(100);
    expect(events).toEqual([]);
    motion.keyboard('open');
    tick(16, { height: 720, top: 40 });
    tick(CHAT_VIEWPORT_SETTLE_MS + 40);
    expect(events).toEqual(['positioning', 'positioning']);
    expect(motion.concealed).toBe(true);
    expect(motion.moving).toBe(true);
    tick(16, { height: 420, top: 180 });
    tick(CHAT_VIEWPORT_SETTLE_MS - 1);
    expect(events.at(-1)).toBe('positioning');
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    expect(motion.concealed).toBe(false);
    expect(motion.moving).toBe(false);
    tick(500); expect(events.filter(event => event === 'reveal')).toHaveLength(1);
  });

  it('keeps closing keyboard plateaus concealed until the closed endpoint settles', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 420, top: 180 });
    motion.keyboard('closed');
    tick(16, { height: 540, top: 100 });
    tick(CHAT_VIEWPORT_SETTLE_MS + 40);
    tick(16, { height: 680, top: 40 });
    tick(CHAT_VIEWPORT_SETTLE_MS + 40);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    expect(motion.moving).toBe(true);
    tick(16, { height: 800, top: 0 });
    tick(CHAT_VIEWPORT_SETTLE_MS - 1);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    expect(events.filter(event => event === 'reveal')).toHaveLength(1);
  });

  it('uses a bounded fallback when focus cannot produce the requested keyboard geometry', () => {
    const { motion, events, tick } = fixture();
    tick(0);
    motion.keyboard('open');
    tick(CHAT_KEYBOARD_TARGET_FALLBACK_MS - 1);
    expect(events).toEqual(['positioning']);
    expect(motion.concealed).toBe(true);
    tick(1);
    expect(events).toEqual(['positioning', 'measure', 'reveal']);
    expect(motion.concealed).toBe(false);
    expect(motion.moving).toBe(false);
  });

  it('infers resize before focus and does not reveal a production-threshold opening plateau', () => {
    const { motion, events, tick } = fixture();
    tick(0);
    motion.anticipateKeyboard('open');
    tick(16, { height: 720, top: 40 });
    expect(motion.keyboardMoving).toBe(true);
    tick(CHAT_VIEWPORT_SETTLE_MS + 80);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    motion.keyboard('open');
    tick(16, { height: 420, top: 180 });
    tick(CHAT_VIEWPORT_SETTLE_MS);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('infers closing direction when resize precedes blur', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 420, top: 180 });
    tick(16, { height: 540, top: 100 });
    expect(motion.keyboardMoving).toBe(true);
    tick(CHAT_VIEWPORT_SETTLE_MS + 80);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    motion.keyboard('closed');
    tick(16, { height: 844, top: 0 });
    tick(CHAT_VIEWPORT_SETTLE_MS);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('does not use the short no-geometry fallback after motion has begun', () => {
    const { motion, events, tick } = fixture();
    tick(0);
    motion.keyboard('open');
    tick(16, { height: 720, top: 40 });
    tick(CHAT_KEYBOARD_TARGET_FALLBACK_MS + CHAT_VIEWPORT_SETTLE_MS);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - CHAT_KEYBOARD_TARGET_FALLBACK_MS - CHAT_VIEWPORT_SETTLE_MS);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('bounds a targetless intermediate resize below the direction threshold', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 1_366, width: 1_024, layoutHeight: 1_366 });
    // 130px is inside the production intermediate band, but below the 136.6px
    // proportional direction threshold for this tall viewport.
    tick(16, { height: 1_236 });
    expect(motion.keyboardMoving).toBe(false);
    expect(motion.concealed).toBe(true);
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - 1);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    expect(motion.concealed).toBe(false);
    expect(motion.moving).toBe(false);
  });

  it('uses the whole motion as the hard bound despite sub-threshold intermediate jitter', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 1_366, width: 1_024, layoutHeight: 1_366 });
    tick(16, { height: 1_236 });
    tick(1_000, { height: 1_235 });
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    // Another changing frame reaches the global 1.6s bound. It may no longer
    // restart the fallback clock and leave a split keyboard hidden forever.
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - 1_000, { height: 1_236 });
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    expect(motion.concealed).toBe(false);
  });

  it('bounds a later manual scroll while split-keyboard geometry stays intermediate', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 1_366, width: 1_024, layoutHeight: 1_366 });
    tick(16, { height: 1_236 });
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    motion.move();
    tick(16, { scrollY: 520 });
    motion.touchEnd();
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - 17);
    expect(events.filter(event => event === 'reveal')).toHaveLength(1);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    expect(events.filter(event => event === 'reveal')).toHaveLength(2);
  });

  it('bounds same-DOM resume while split-keyboard geometry stays intermediate', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 1_236, width: 1_024, layoutHeight: 1_366 });
    motion.suspend();
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS * 2);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - 1);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    expect(motion.concealed).toBe(false);
    expect(motion.moving).toBe(false);
  });

  it('rebases a target armed during suspension on the first resumed geometry', () => {
    const { motion, events, tick } = fixture();
    tick(0);
    motion.suspend();
    motion.keyboard('open');
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS * 2, { height: 720, top: 40 });
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(CHAT_KEYBOARD_TARGET_FALLBACK_MS);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(CHAT_KEYBOARD_MOVED_FALLBACK_MS - CHAT_KEYBOARD_TARGET_FALLBACK_MS);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('stays hidden while a finger is down and through continuing inertial scroll', () => {
    const { motion, events, tick } = fixture();
    tick(0); motion.touchStart(); motion.move(); tick(500);
    expect(events).not.toContain('reveal');
    motion.touchEnd(); tick(50, { scrollY: 520 }); tick(50, { scrollY: 560 }); tick(CHAT_VIEWPORT_SETTLE_MS - 1);
    expect(events).not.toContain('reveal');
    tick(1); expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('does not fade on a normal stationary list tap', () => {
    const { motion, events, tick } = fixture();
    tick(0); motion.touchStart(); tick(500); motion.touchEnd(); tick(500);
    expect(events).toEqual([]);
  });

  it('does not conceal a settled open keyboard for composer-owned viewport drift', () => {
    const { motion, events, tick } = fixture();
    tick(0, { height: 420, top: 180 });
    tick(16, { height: 412, top: 188, composerResize: true });
    tick(16, { height: 420, top: 180, composerResize: true });
    expect(events).toEqual([]);
    expect(motion.concealed).toBe(false);
    expect(motion.moving).toBe(false);
  });

  it('does not classify an explicit return-to-latest animation as continued finger inertia', () => {
    const { motion, events, tick } = fixture();
    tick(0); motion.move(); tick(20, { scrollY: 400 });
    motion.automaticScroll(); tick(50, { scrollY: 450 }); tick(110, { scrollY: 500 });
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    tick(16, { scrollY: 550 });
    expect(events.filter(event => event === 'reveal')).toHaveLength(1);
  });

  it('drops a held gesture on suspension and resumes the same DOM at its newly measured position', () => {
    const { motion, events, tick } = fixture();
    tick(0); motion.touchStart(); motion.move(); motion.suspend();
    expect(events.at(-1)).toBe('positioning');
    // The owner stops sampling while away/locked; no internal timer exists.
    tick(CHAT_VIEWPORT_SETTLE_MS * 4, { height: 600 });
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(CHAT_VIEWPORT_SETTLE_MS - 1);
    expect(events.filter(event => event === 'reveal')).toHaveLength(0);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });
});
