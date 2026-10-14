// Prototype-only trajectories. Expression timing follows
// src/lib/chat-keyboard-layout.ts; ordinary panels follow standard 15.
export const EXPRESSION_MS=360;
export const PANEL_MS=240;
export function sampleTrajectory(from,to,velocity,elapsed,kind) {
  const duration=kind==='expression'?EXPRESSION_MS:PANEL_MS;
  if(elapsed>=duration)return {value:to,velocity:0};
  const seconds=Math.max(0,elapsed)/1000;
  if(kind==='expression') {
    const displacement=from-to,coefficient=velocity+25*displacement,decay=Math.exp(-25*seconds);
    return {value:to+(displacement+coefficient*seconds)*decay,velocity:(velocity-25*coefficient*seconds)*decay};
  }
  const t=Math.max(0,elapsed)/duration,t2=t*t,t3=t2*t,durationSeconds=duration/1000;
  return {
    value:(2*t3-3*t2+1)*from+(t3-2*t2+t)*durationSeconds*velocity+(-2*t3+3*t2)*to,
    velocity:((6*t2-6*t)*from+(3*t2-4*t+1)*durationSeconds*velocity+(-6*t2+6*t)*to)/durationSeconds,
  };
}
