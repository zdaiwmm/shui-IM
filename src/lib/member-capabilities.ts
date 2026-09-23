import type { RoomMember } from './types';

/**
 * A device that was authorized but has never opened a session has no capability
 * announcement and no last-seen time. It must not freeze messages for devices
 * that are already in the conversation. Once it connects, lastSeenAt or a
 * capability list makes it part of the gate again.
 */
export function capabilityGateMembers(members: readonly RoomMember[]): RoomMember[] {
  return members.filter(member => {
    if (member.status === 'pending' || member.status === 'revoked') return false;
    if ((!member.capabilities || member.capabilities.length === 0) && !member.lastSeenAt) return false;
    return true;
  });
}
