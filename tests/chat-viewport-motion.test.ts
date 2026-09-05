import { describe, expect, it } from 'vitest';
import { createChatViewportMotion } from '../src/lib/chat-viewport-motion';

function fixture() {
  let time = 0;
  const events: string[] = [];
  const sample = { height: 844, width: 390, top: 0, layoutHeight: 844, scrollY: 500 };
  const motion = createChatViewportMotion({
    now: () => time,
    conceal: immediate => events.push(immediate ? 'positioning' : 'fading'),
    settled: () => events.push('measure'), reveal: () => events.push('reveal'),
  });
  const tick = (elapsed: number, values = {}) => { time += elapsed; Object.assign(sample, values); motion.sample({ ...sample }); };
  return { motion, events, tick };
}

describe('chat viewport motion', () => {
  it('has no initial or programmatic-scroll delay and reveals only after measuring stable geometry', () => {
    const { motion, events, tick } = fixture();
    tick(0); tick(16, { scrollY: 700 }); tick(100);
    expect(events).toEqual([]);
    motion.keyboard();
    tick(16, { height: 620, top: 80 }); tick(16, { height: 420, top: 180 });
    tick(159);
    expect(events).toEqual(['positioning', 'positioning', 'positioning']);
    tick(1);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
    tick(500); expect(events.filter(event => event === 'reveal')).toHaveLength(1);
  });

  it('stays hidden while a finger is down and through continuing inertial scroll', () => {
    const { motion, events, tick } = fixture();
    tick(0); motion.touchStart(); motion.move(); tick(500);
    expect(events).not.toContain('reveal');
    motion.touchEnd(); tick(50, { scrollY: 520 }); tick(50, { scrollY: 560 }); tick(159);
    expect(events).not.toContain('reveal');
    tick(1); expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });

  it('does not fade on a normal stationary list tap', () => {
    const { motion, events, tick } = fixture();
    tick(0); motion.touchStart(); tick(500); motion.touchEnd(); tick(500);
    expect(events).toEqual([]);
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
    tick(16, { height: 600 }); tick(144);
    expect(events.slice(-2)).toEqual(['measure', 'reveal']);
  });
});
