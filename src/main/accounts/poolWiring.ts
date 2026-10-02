// index.ts wiring that differs for the local Claude account (plan 2.9.5): the shared-config status / relink only
// cover managed accounts (the local account's dir IS the shared source), and its model probe gets no
// CLAUDE_CONFIG_DIR (the CLI then reads the base Keychain service).
import type { Account, ChildEnvInject, SharedConfigStatus } from '../../shared/types';
import type { AccountPool, ConfigDirLinks } from '../contracts';
import { sharedConfigStatus } from './configDirLinks';
import { claudeConfigDirFor, isLocalDefault } from './localDefault';

export interface SharedConfigDeps {
  accountPool: Pick<AccountPool, 'list'>;
  links: Pick<ConfigDirLinks, 'linkSharedConfig'>;
  sourceDir: string;
  /** Defaults to configDirLinks.sharedConfigStatus. */
  status?: (accounts: readonly Account[], sourceDir: string) => Promise<SharedConfigStatus>;
  log?: (message: string, err?: unknown) => void;
}

export function createSharedConfig(deps: SharedConfigDeps): { status(): Promise<SharedConfigStatus>; relink(): Promise<SharedConfigStatus> } {
  const status = deps.status ?? sharedConfigStatus;
  const log = deps.log ?? ((message: string, err?: unknown) => console.error(message, err ?? ''));
  const managed = () => deps.accountPool.list().filter((a) => !isLocalDefault(a));
  return {
    status: () => status(managed(), deps.sourceDir),
    async relink() {
      for (const account of managed()) {
        await deps.links.linkSharedConfig(account.configDir).catch((err: unknown) => log(`[deltax] relink failed for ${account.alias}`, err));
      }
      return status(managed(), deps.sourceDir);
    },
  };
}

/** childEnv inject of the message-less model probe for `account`. */
export function probeEnvInject(account: Pick<Account, 'source' | 'configDir'>, clientApp: string): ChildEnvInject {
  const configDir = claudeConfigDirFor(account);
  return configDir !== undefined ? { configDir, clientApp } : { clientApp };
}
