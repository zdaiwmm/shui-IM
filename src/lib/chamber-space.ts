import type { Vault } from './types';
import type { PersonalDeviceBinding } from './personal-device-binding';

/** Old staged bindings are retained as opaque local data. They do not enable
 * Chamber services after legacy-room migration has been retired. */
export function isChamberVault(vault: Vault | undefined): vault is Vault & { personalBinding: PersonalDeviceBinding } {
  return Boolean(vault?.personalBinding && !vault.personalMigration && !vault.migrationSource);
}
