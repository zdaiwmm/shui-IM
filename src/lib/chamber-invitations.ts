import { authorizedFetch, responseError } from './api';
import type { PersonalDeviceBinding } from './personal-device-binding';
import type { PublicBundle } from './types';
export type ChamberInvitation = {
  v: 1; creatorBinding: PersonalDeviceBinding; joinerBinding: PersonalDeviceBinding | null;
  migration?: 'preparing';
  version: number; requestId: string | null; expiresAt: string | null;
  stage: 'available' | 'preparing' | 'code' | 'expired' | 'joined'; code?: string;
  candidate?: { bundle: PublicBundle; proof: string; binding: PersonalDeviceBinding };
};
export async function chamberInvitation(roomId: string, token: string, body?: unknown, signal?: AbortSignal): Promise<ChamberInvitation> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/chamber-invitation`, token, {
    method: body === undefined ? 'GET' : 'POST', signal, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}
